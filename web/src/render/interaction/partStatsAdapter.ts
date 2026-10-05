/**
 * partStatsAdapter.ts — 统计引擎适配层（B-3：纯物品清单）：StructureDefinition → 引擎输入。
 *
 * 契约：http://127.0.0.1:3300/Lightning/lightning/wiki/%E9%83%A8%E4%BB%B6%E6%95%B0%E6%8D%AE%E5%A5%91%E7%BA%A6
 *   （§2 文件表达 cellPartsGrid/partLists、§2.2 物品索引表、§9 已废弃）。
 * 引擎本体在 `@/pure/partStats`（纯函数、零框架依赖），本文件允许依赖 render/ 侧类型。
 *
 * ── 职责（决策 C 收窄后）──
 *  只做两件事：① `cellPartsGrid` + `partLists` → 部件实例平铺列表（含分层预览过滤）；
 *  ② 一行式封装（def + 分层 → 物品行清单）。
 *  原先的"文档默认层 statsTemplate / 文档覆盖层 statsOverride / JSON 校验与序列化"（三级配置
 *  通道）**已整套移除**（契约 §9 已废弃）：旧文档携带 `statsTemplate` / `statsOverride`
 *  在解析链上仍随文档根 `_extra` 兜底 round-trip（不丢字段、不报错），但**不再有任何消费方**。
 *
 * 宿主计数（旧口径）不经过本文件：`blockStats.countBlocksById` 仍原样服务
 * `BlockStatsSidebar` 的旧文件宿主清单路径（硬约束：无部件旧文件 = 今天行为）。
 */

import {
  buildItemStats,
  type ItemStatsInput,
  type ItemStatsResult,
} from '@/pure/partStats'
import { PARTS_GRID_NONE, type PartRecord } from '@/pure/partTypes'
import { structureRowToWorldY } from '@/pure/vec'
import type { StructureDefinition } from '../schema/types'
import type { LayerPreviewMode } from '../data/layerPreview'

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
// 引擎入口
// ---------------------------------------------------------------------------

/** 构造引擎输入（部件 = 同层过滤后的平铺列表） */
export function buildItemStatsInput(
  def: StructureDefinition,
  layerPreview: LayerPreviewMode = 'all',
): ItemStatsInput {
  return { parts: collectPartsForStats(def, layerPreview) }
}

/** 一行式：def + 分层 → 物品行清单 */
export function buildItemStatsForDefinition(
  def: StructureDefinition,
  layerPreview: LayerPreviewMode = 'all',
): ItemStatsResult {
  return buildItemStats(buildItemStatsInput(def, layerPreview))
}
