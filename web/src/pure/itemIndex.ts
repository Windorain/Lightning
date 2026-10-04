/**
 * pure/itemIndex.ts — 物品索引表（契约 §2.2 `itemIndex`）的纯类型、宽容解析与反查索引。
 *
 * 契约：Gitea Wiki《部件数据契约》§2.2（字段命名/序列化/归属表达由 B-2 实现拍板后回填）。
 * 相关 Issue：B-2（#35 落盘与反查）、#5 §8 缺口③（左栏悬停说明）、#7 §3/§6（点选高亮归属）。
 *
 * ── 数据形状（落盘权威，camelCase）────────────────────────────────────
 *
 * ```jsonc
 * "itemIndex": {
 *   "minecraft:torch:0": {                    // 键 = 物品身份键 registry:damage[#nbt]
 *     "display": "Torch",                     //  显示名（缺省兜底 = 键本身）
 *     "tooltip": ["Torch", "..."],            //  说明行（空 ⇒ 至少 display 一行）
 *     "source": "part",                       //  归属最终来源：part | host | family | none
 *     "attribution": [                        //  归属定位（空数组 + source=none = 显式"无对应"）
 *       { "source": "part", "frame": 0, "grid": [zi, ri, ci], "localId": "generic:0" },
 *       { "source": "host", "frame": 0, "grid": [zi, ri, ci] }
 *     ]
 *   }
 * }
 * ```
 *
 * ── 本模块的纪律（硬约束推论）────────────────────────────────────────
 *
 * 1. **单一数据源**：反查索引只从 `itemIndex` 生成，**不**从 `partLists`/`cellGrid` 二次推导——
 *    归属的键与命中单元在导出侧生成完毕（B-5 消费本索引，不另建第二条生成路径）；
 * 2. **`source` 是派生标记**：权威信息是 `attribution`（首条 = 权威度最高者）；解析时
 *    `source` 一律由 `attribution` 重算，文件里的同名字段不参与判定（两者在导出侧同源生成）；
 * 3. **显式"无对应"**：`attribution: []` + `source: 'none'` 是**有数据的状态**（键存在），与
 *    "键不在表里"（该物品无索引条目，旧文件/超范围物品）语义不同，`unresolved` 标出前者；
 * 4. **说明行兜底**：`tooltip` 为空 ⇒ 至少 `display` 一行；`display` 缺省 ⇒ 物品身份键本身。
 *    "任何情况有话说"（#5 硬约束）；
 * 5. **权威度顺序**：part > host > family（契约 §2.2 层级表），`hits` 按此稳定排序；
 *    同一 `(source, frame, grid, localId)` 去重（跨帧重复出现不重复计入）。
 *
 * No side effects: no Vue refs, no DOM, no I/O, no mutation of arguments.
 */

// ---------------------------------------------------------------------------
// 字段名常量与类型
// ---------------------------------------------------------------------------

/** 文档根级字段名（与 `partIconTextures`/`statsTemplate` 同级，非 structure 级）。 */
export const ITEM_INDEX_FIELD = 'itemIndex'

/** `blockPalette` 条目上的宿主级物品身份字段名（契约 §2.2 层②）。 */
export const HOST_ITEM_FIELD = 'hostItem'

/** 归属来源标记（契约 §2.2）：部件级 / 宿主级 / 族特有 / 显式无对应。 */
export type ItemAttributionSource = 'part' | 'host' | 'family' | 'none'

/** 可出现在归属条目里的来源（`none` 不是条目，是"无条目"的汇总状态）。 */
export type ItemHitSource = Exclude<ItemAttributionSource, 'none'>

/** 归属命中单元：部件（格 + localId）或格（宿主级/族特有定位到格）。 */
export interface ItemAttributionHit {
  source: ItemHitSource
  /** 帧下标（单文件文档 = 0；World 帧 = `frames[i].index`），跨帧不重复的定位依据 */
  frame: number
  /** 格下标 `[zSlice, row, column]`，与 `cellGrid`/`cellPartsGrid` 同下标 */
  grid: [number, number, number]
  /** `source === 'part'` 时 = `PartRecord.localId`（格内部件定位）；其余来源省略 */
  localId?: string
}

/** 一个物品身份键的索引条目（解析后形态：字段必定齐全，说明行非空）。 */
export interface ItemIndexEntry {
  /** 显示名（缺省兜底 = 键本身；空值语义"至少 display 一行"） */
  display: string
  /** 说明行（至少一行；与 `PartRecord.tooltip` 同源生成、各自保留） */
  tooltip: string[]
  /** 归属最终来源：`attribution` 首条的来源；空数组 ⇒ `'none'`（显式"无对应"） */
  source: ItemAttributionSource
  /** 归属定位；空数组 = 显式"无对应"（键存在、状态明确，不猜） */
  attribution: ItemAttributionHit[]
}

/** 物品索引表（文档根级，跨帧共享、按键去重） */
export type ItemIndex = Record<string, ItemIndexEntry>

/** 宿主级物品身份（`blockPalette[].hostItem`，契约 §2.2 层②落盘形状） */
export interface HostItemIdentity {
  registry: string
  damage: number
}

/** 承载 `itemIndex` 的对象（渲染定义根 / 文档根；字段缺省 = 无索引） */
export interface ItemIndexCarrier {
  itemIndex?: unknown
}

/** 来源权威度顺序（契约 §2.2 层级表：① 部件级 ② 宿主级 ③ 族特有） */
const SOURCE_ORDER: readonly ItemHitSource[] = ['part', 'host', 'family']

const HIT_SOURCES = new Set<string>(SOURCE_ORDER)

/** 归属来源的权威度序号（越小越权威）；未知来源退到末尾（宽容解析不抛） */
function sourceRank(source: string): number {
  const idx = SOURCE_ORDER.indexOf(source as ItemHitSource)
  return idx >= 0 ? idx : SOURCE_ORDER.length
}

// ---------------------------------------------------------------------------
// 键工具
// ---------------------------------------------------------------------------

/**
 * 宿主级物品身份键 `registry:damage`（与 `pure/partStats.partItemKey` 同形，宿主身份无 NBT 判别键）。
 * 消费 `blockPalette[].hostItem` 时使用；**不参与本模块反查索引的生成**（单一数据源纪律）。
 */
export function hostItemKey(hostItem: HostItemIdentity | null | undefined): string | null {
  if (!hostItem || typeof hostItem.registry !== 'string' || hostItem.registry.length === 0) return null
  const damage = typeof hostItem.damage === 'number' && Number.isFinite(hostItem.damage) ? hostItem.damage : 0
  return `${hostItem.registry}:${damage}`
}

// ---------------------------------------------------------------------------
// 宽容解析（旧文件 / 越界值 / 半截数据都不抛）
// ---------------------------------------------------------------------------

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((s): s is string => typeof s === 'string')
}

/** 单条归属：形状不合（来源未知/帧非数/格下标不是三元数字）⇒ null（丢弃，不猜） */
function parseHit(raw: unknown): ItemAttributionHit | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const h = raw as Record<string, unknown>
  const source = typeof h.source === 'string' ? h.source : ''
  if (!HIT_SOURCES.has(source)) return null
  const frame = typeof h.frame === 'number' && Number.isFinite(h.frame) ? h.frame : 0
  const grid = h.grid
  if (!Array.isArray(grid) || grid.length !== 3) return null
  if (!grid.every(g => typeof g === 'number' && Number.isFinite(g))) return null
  const hit: ItemAttributionHit = {
    source: source as ItemHitSource,
    frame,
    grid: [grid[0] as number, grid[1] as number, grid[2] as number],
  }
  if (typeof h.localId === 'string' && h.localId.length > 0) hit.localId = h.localId
  return hit
}

/** 归属条目稳定排序（权威度顺序优先，同来源保文件序）+ `(source,frame,grid,localId)` 去重 */
function normalizeHits(hits: readonly ItemAttributionHit[]): ItemAttributionHit[] {
  const seen = new Set<string>()
  const out: ItemAttributionHit[] = []
  for (const h of hits) {
    const id = `${h.source}|${h.frame}|${h.grid[0]},${h.grid[1]},${h.grid[2]}|${h.localId ?? ''}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(h)
  }
  return out
    .map((h, i) => ({ h, i }))
    .sort((a, b) => sourceRank(a.h.source) - sourceRank(b.h.source) || a.i - b.i)
    .map(x => x.h)
}

/**
 * 宽容解析 `itemIndex` 字段：非对象 ⇒ `{}`；单条目形状不合 ⇒ 丢弃该条；`tooltip` 空 ⇒ 至少
 * `display` 一行；`display` 缺省 ⇒ 键本身；`source` 由 `attribution` 重算（见文件头纪律 2）。
 */
export function parseItemIndex(raw: unknown): ItemIndex {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: ItemIndex = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.length === 0) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const e = value as Record<string, unknown>
    const display = typeof e.display === 'string' && e.display.length > 0 ? e.display : key
    const rawHits = Array.isArray(e.attribution) ? e.attribution : []
    const hits = normalizeHits(
      rawHits.map(parseHit).filter((h): h is ItemAttributionHit => h !== null),
    )
    let tooltip = asStringArray(e.tooltip)
    if (tooltip.length === 0) tooltip = [display]
    out[key] = {
      display,
      tooltip,
      source: hits.length > 0 ? hits[0]!.source : 'none',
      attribution: hits,
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 反查索引（一次性建立）：物品键 → 命中单元（部件 / 格）
// ---------------------------------------------------------------------------

/** 反查索引的一条：条目（说明行）+ 命中单元 */
export interface ItemHitIndexEntry {
  key: string
  display: string
  tooltip: string[]
  source: ItemAttributionSource
  /** 显式"无对应"（`attribution` 为空；键存在，状态明确） */
  unresolved: boolean
  /** 命中单元（权威度顺序 part → host → family，同来源保文件序） */
  hits: ItemAttributionHit[]
}

/** 反查索引（一次性建立；键 = 物品身份键） */
export type ItemHitIndex = ReadonlyMap<string, ItemHitIndexEntry>

/**
 * 由**已解析**的索引建反查表（纯函数；键集 = 表内键集，不做任何补充推导）。
 *
 * 命中原样经 `normalizeHits` 再过一遍（权威度排序 + 去重，幂等）—— `source` 同样由归属重算，
 * 故手工构造的 `ItemIndex` 也与落盘解析结果同口径（"两种入口同源"由本函数保证）。
 *
 * @param extraKeys 需要保证在表里的键（如左栏行键）；缺失者以显式无对应条目补齐
 *                  （`display` = 键、`tooltip` = [键]、`source` = `'none'`）——左栏行与索引表
 *                  键集不一致时，"没有条目"与"显式无对应"仍可区分（`unresolved` 为 true，
 *                  条目由调用方显式要求补入）。缺省不补。
 */
export function buildItemHitIndexFromIndex(
  index: ItemIndex,
  extraKeys: readonly string[] = [],
): ItemHitIndex {
  const out = new Map<string, ItemHitIndexEntry>()
  const put = (key: string, entry: ItemIndexEntry): void => {
    const hits = normalizeHits(entry.attribution)
    out.set(key, {
      key,
      display: entry.display,
      tooltip: entry.tooltip.length > 0 ? entry.tooltip : [entry.display],
      source: hits.length > 0 ? hits[0]!.source : 'none',
      unresolved: hits.length === 0,
      hits,
    })
  }
  for (const [key, entry] of Object.entries(index)) put(key, entry)
  for (const key of extraKeys) {
    if (out.has(key)) continue
    put(key, { display: key, tooltip: [key], source: 'none', attribution: [] })
  }
  return out
}

/**
 * 从渲染定义根 / 文档根一次性建立反查索引（`itemIndex` 缺省 ⇒ 空表；旧文件零差异）。
 * B-4（左栏悬停说明）与 B-5（点选高亮归属）共用本入口。
 */
export function buildItemHitIndex(
  source: ItemIndexCarrier | null | undefined,
  extraKeys: readonly string[] = [],
): ItemHitIndex {
  return buildItemHitIndexFromIndex(parseItemIndex(source?.itemIndex), extraKeys)
}

/** 单键查询（无条目 ⇒ null；条目命中为空 ⇒ `unresolved: true` 的条目） */
export function resolveItemHit(
  index: ItemHitIndex,
  key: string,
): ItemHitIndexEntry | null {
  return index.get(key) ?? null
}
