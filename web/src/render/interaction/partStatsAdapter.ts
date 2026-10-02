/**
 * P2.3 统计引擎适配层：StructureDefinition / 文档根字段 → pure/partStats 引擎输入。
 *
 * 旧口径不删除（硬约束）：宿主计数直接复用 `blockStats.countBlocksById`，本文件只做桥接。
 * 引擎本体在 `@/pure/partStats`（纯函数、零框架依赖），本文件允许依赖 render/ 侧类型。
 */

import {
  buildStatsView,
  type PartStatsInput,
  type ResolvedStatsConfig,
  type StatsConfigLayer,
  type StatsRules,
  type StatsRuleGroup,
  type StatsViewResult,
} from '@/pure/partStats'
import { PARTS_GRID_NONE, type PartRecord } from '@/pure/partTypes'
import { structureRowToWorldY } from '@/pure/vec'
import type { StructureDefinition } from '../schema/types'
import type { LayerPreviewMode } from '../data/layerPreview'
import type { V2StatsTemplate } from '../data/sceneDocumentV2'
import { countBlocksById } from './blockStats'

// ---------------------------------------------------------------------------
// 部件收集（含分层预览过滤，与 countBlocksById 的 effectiveVoxelState 语义一致）
// ---------------------------------------------------------------------------

/**
 * 平铺收集结构内全部部件实例（跨格展开；一格多物 = 多条 PartRecord）。
 * 无 cellPartsGrid/partLists（旧文件）⇒ 空数组 ⇒ 引擎走"无部件退化"语义。
 * 分层预览：仅收当前 Y 层的格（row → worldY 换算与 `effectiveVoxelState` 一致）。
 */
export function collectPartsForStats(
  def: StructureDefinition,
  layerPreview: LayerPreviewMode = 'all',
): PartRecord[] {
  const grid = def.cellPartsGrid
  const lists = def.partLists
  if (!Array.isArray(grid) || !Array.isArray(lists) || lists.length === 0) return []
  const sizeRow = def.cellGrid[0]?.length ?? 0
  const out: PartRecord[] = []
  for (let z = 0; z < grid.length; z++) {
    const slice = grid[z]
    if (!Array.isArray(slice)) continue
    for (let row = 0; row < slice.length; row++) {
      if (layerPreview !== 'all' && structureRowToWorldY(row, sizeRow) !== layerPreview.worldY) continue
      const cols = slice[row]
      if (!Array.isArray(cols)) continue
      for (let col = 0; col < cols.length; col++) {
        const idx = cols[col]!
        if (typeof idx !== 'number' || idx <= PARTS_GRID_NONE || idx >= lists.length) continue
        const list = lists[idx]
        if (Array.isArray(list)) out.push(...(list as PartRecord[]))
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 引擎入口（def 直给：宿主计数复用旧函数 countBlocksById）
// ---------------------------------------------------------------------------

/** 构造引擎输入（宿主计数 = 旧 `countBlocksById` 结果原样；部件 = 同层过滤后的平铺列表） */
export function buildPartStatsInput(
  def: StructureDefinition,
  layerPreview: LayerPreviewMode = 'all',
): PartStatsInput {
  return {
    hostCounts: countBlocksById(def, layerPreview),
    parts: collectPartsForStats(def, layerPreview),
  }
}

/** 一行式：def + 分层 + 解析后配置 → 三视图清单行 */
export function buildStatsViewForDefinition(
  def: StructureDefinition,
  layerPreview: LayerPreviewMode,
  config: ResolvedStatsConfig,
): StatsViewResult {
  return buildStatsView(buildPartStatsInput(def, layerPreview), config)
}

// ---------------------------------------------------------------------------
// 文档默认：statsTemplate（V2StatsTemplate）→ StatsConfigLayer
// ---------------------------------------------------------------------------

/**
 * 文档默认层解析。命名以 camelCase（showOthers / partTypeKey）为落盘权威，
 * snake_case（show_others / part_type_key）仅作旧数据读取回退（调度者拍板，契约 §10.2）。
 * - mode 'auto' ⇒ 部件物品清单视图（契约 §9 默认）；
 * - mode 'custom' ⇒ 自定义分组视图，groups 条目键（partTypeKey ?? block_state_id）→ 规则 match。
 */
export function statsConfigFromV2Template(tpl: V2StatsTemplate | null | undefined): StatsConfigLayer | null {
  if (!tpl || typeof tpl !== 'object') return null
  const raw = tpl as V2StatsTemplate & { show_others?: boolean }
  const showOthers = raw.showOthers ?? raw.show_others
  if (tpl.mode === 'custom') {
    const groups: StatsRuleGroup[] = []
    for (const g of tpl.groups ?? []) {
      const match: string[] = []
      for (const e of g.entries ?? []) {
        const k = (e as { partTypeKey?: string; part_type_key?: string }).partTypeKey
          ?? (e as { part_type_key?: string }).part_type_key
          ?? e.block_state_id
        if (typeof k === 'string' && k.length > 0) match.push(k)
      }
      groups.push({ title: g.label, match })
    }
    const rules: StatsRules = { groups }
    if (showOthers !== undefined) rules.showOthers = showOthers
    return { view: 'custom', rules }
  }
  // 'auto'（或缺省）：部件物品清单视图
  return { view: 'parts' }
}

// ---------------------------------------------------------------------------
// 文档覆盖（statsOverride 根字段）与查看者本地配置的 JSON 校验/序列化
// ---------------------------------------------------------------------------

const VIEW_IDS = new Set(['parts', 'hosts', 'custom'])
const SORT_IDS = new Set(['count-desc', 'count-asc', 'key', 'label'])
const GRANULARITY_IDS = new Set(['full', 'damage', 'registry'])

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v.filter((s): s is string => typeof s === 'string')
  return out.length > 0 ? out : undefined
}

/**
 * 宽松校验 JSON → StatsConfigLayer（文档覆盖 statsOverride / localStorage 共用）。
 * 无法识别的键/类型静默丢弃（配置不是契约强字段，容错优先）；整体非对象 ⇒ null。
 */
export function parseStatsConfigLayer(raw: unknown): StatsConfigLayer | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const layer: StatsConfigLayer = {}
  if (typeof obj.view === 'string' && VIEW_IDS.has(obj.view)) {
    layer.view = obj.view as StatsConfigLayer['view']
  }
  const rawRules = obj.rules
  if (rawRules && typeof rawRules === 'object' && !Array.isArray(rawRules)) {
    const r = rawRules as Record<string, unknown>
    const rules: StatsRules = {}
    const ignore = asStringArray(r.ignore)
    if (ignore) rules.ignore = ignore
    if (r.scale && typeof r.scale === 'object' && !Array.isArray(r.scale)) {
      const scale: Record<string, number> = {}
      for (const [k, v] of Object.entries(r.scale as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) scale[k] = v
      }
      if (Object.keys(scale).length > 0) rules.scale = scale
    }
    if (r.aliases && typeof r.aliases === 'object' && !Array.isArray(r.aliases)) {
      const aliases: Record<string, string> = {}
      for (const [k, v] of Object.entries(r.aliases as Record<string, unknown>)) {
        if (typeof v === 'string') aliases[k] = v
      }
      if (Object.keys(aliases).length > 0) rules.aliases = aliases
    }
    if (typeof r.keyGranularity === 'string' && GRANULARITY_IDS.has(r.keyGranularity)) {
      rules.keyGranularity = r.keyGranularity as StatsRules['keyGranularity']
    }
    if (typeof r.showHostRows === 'boolean') rules.showHostRows = r.showHostRows
    if (typeof r.sortBy === 'string' && SORT_IDS.has(r.sortBy)) {
      rules.sortBy = r.sortBy as StatsRules['sortBy']
    }
    if (Array.isArray(r.groups)) {
      const groups: StatsRuleGroup[] = []
      for (const g of r.groups) {
        if (!g || typeof g !== 'object') continue
        const go = g as Record<string, unknown>
        if (typeof go.title !== 'string') continue
        groups.push({ title: go.title, match: asStringArray(go.match) ?? [] })
      }
      if (groups.length > 0) rules.groups = groups
    }
    if (typeof r.showOthers === 'boolean') rules.showOthers = r.showOthers
    if (typeof r.othersTitle === 'string') rules.othersTitle = r.othersTitle
    if (typeof r.hostGroupTitle === 'string') rules.hostGroupTitle = r.hostGroupTitle
    if (Object.keys(rules).length > 0) layer.rules = rules
  }
  if (layer.view === undefined && layer.rules === undefined) return null
  return layer
}

/** StatsConfigLayer → 可落盘 JSON（文档覆盖写回 statsOverride / localStorage 共用；剥离 undefined） */
export function serializeStatsConfigLayer(layer: StatsConfigLayer): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (layer.view !== undefined) out.view = layer.view
  if (layer.rules) {
    const rules: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(layer.rules)) {
      if (v !== undefined) rules[k] = v
    }
    if (Object.keys(rules).length > 0) out.rules = rules
  }
  return out
}

/**
 * 从文档根对象读取"文档覆盖"层（`statsOverride`，camelCase；随 `_extra` 兜底 round-trip）。
 * 文档默认层（statsTemplate）走 `statsConfigFromV2Template`。
 */
export function statsOverrideFromDocumentRoot(root: Record<string, unknown> | null | undefined): StatsConfigLayer | null {
  if (!root) return null
  return parseStatsConfigLayer(root.statsOverride)
}
