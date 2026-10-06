/**
 * pure/itemOutlinePlan.ts — 物品点选 → 视口高亮 mask 的**命中计划**（B-5 / Gitea #38）。
 *
 * 数据流（单一数据源 = B-2 落盘的 `itemIndex`，本模块不另建第二条生成路径）：
 *
 * ```
 *   选中物品键集合 ──buildItemHitIndex──▶ 每条 { display, tooltip, source, unresolved, hits[] }
 *        └─ planItemOutlineHits ─▶ 命中并集（权威度序 part → host → family）+ 截断 + 统计
 *             └─ itemHitBlockRefs ─▶ BlockRef[]（part 命中带 partLocalId / host 命中整格）
 *                  └─ SelectionHighlightProvider.build ─▶ mask meshes（与 hover 同一通道）
 * ```
 *
 * ── 判据（#38 完成定义 / #7 §4 粒度定案）─────────────────────────────
 * 1. **并集**：高亮 = 所有选中物品归属的并集；同一 `(source, frame, grid, localId)` 只算一处
 *    （跨选中项重复命中去重）；
 * 2. **部件级优先、整格兜底**：`source === 'part'` 的命中携带 `localId` ⇒ 走 B-1 部件通道
 *    （`BlockRef.partLocalId`）；`host` / 无 `localId` 的命中不带 ⇒ 走整格兜底；
 * 3. **无对应**：选中项在索引里没有归属（无条目 / `attribution` 为空）⇒ 计入
 *    `unresolvedCount`，不产生任何命中（"可选中、不高亮"，提示语义见调用方）；
 * 4. **≤ 500 口径 + 截断**：命中总数超过 `OUTLINE_MASK_LIMIT` 时**截断**（保留前 N 条，
 *    顺序稳定 = 选中键字典序 × 索引内权威度序）并置 `truncated`——调用方据此给出可辨认提示，
 *    **不得静默失效**（B-5 之前 `extraMaskMeshes` 通道无上限，本模块与 `drw.ts` 同口径收口）；
 * 5. **帧过滤**：`ItemAttributionHit.frame` 是归属所在帧；只把**当前帧**的命中计入
 *    `totalHits`/参与 mask（其它帧的格在当前视图里没有对应位置）。选中项"有归属但都不在
 *    当前帧"计入 `offFrameCount`——它与"没有对应方块"是两件事，分别可辨认。
 *
 * No side effects: no Vue refs, no DOM, no I/O, no mutation of arguments.
 */

import type { ItemAttributionHit, ItemHitIndex } from '@/pure/itemIndex'
import { structureRowToWorldY } from '@/pure/vec'
import { OUTLINE_MASK_LIMIT } from '@/pure/outlineLimits'
import type { BlockRef, StructureDefinition } from '@/render/schema/types'

export { OUTLINE_MASK_LIMIT }

/** 命中计划（UI 提示与 mask 生成共用的唯一读数） */
export interface ItemOutlinePlan {
  /** 选中项数（= 选择集大小） */
  selectedCount: number
  /** 选中项中"**没有对应方块**"的项数（无索引条目 / `attribution` 为空） */
  unresolvedCount: number
  /** 选中项中"有归属、但归属都不在当前帧"的项数（与 `unresolvedCount` 不同义） */
  offFrameCount: number
  /** 当前帧命中总数（**截断前**） */
  totalHits: number
  /** 实际参与高亮的命中数（≤ `OUTLINE_MASK_LIMIT`） */
  shownHits: number
  /** 是否发生截断（`totalHits > shownHits`） */
  truncated: boolean
  /** 实际参与高亮的命中（已截断、已去重、稳定顺序） */
  hits: ItemAttributionHit[]
}

/** 空计划（无选中 / 无索引时的确定读数，避免调用方各自造零值） */
export const EMPTY_ITEM_OUTLINE_PLAN: ItemOutlinePlan = {
  selectedCount: 0,
  unresolvedCount: 0,
  offFrameCount: 0,
  totalHits: 0,
  shownHits: 0,
  truncated: false,
  hits: [],
}

/** 命中去重身份（与 `pure/itemIndex.ts#normalizeHits` 同一口径） */
function hitKey(hit: ItemAttributionHit): string {
  return `${hit.source}|${hit.frame}|${hit.grid[0]},${hit.grid[1]},${hit.grid[2]}|${hit.localId ?? ''}`
}

/**
 * 选中键集合 + 反查索引 → 命中计划。
 *
 * @param index    反查索引（`buildItemHitIndex` 产物；键不在表内 ⇒ 该选中项计"无对应"）
 * @param selected 选中物品键集合
 * @param options  `frame` = 当前帧的**帧键**（`RuntimeFrame.index`，见 `context/queries.ts`
 *                 `currentFrameKey`）；`max` = 截断上限（缺省 `OUTLINE_MASK_LIMIT`）
 */
export function planItemOutlineHits(
  index: ItemHitIndex | null | undefined,
  selected: Iterable<string>,
  options: { frame: number; max?: number },
): ItemOutlinePlan {
  const max = options.max ?? OUTLINE_MASK_LIMIT
  // 稳定顺序：选中键字典序（Set 迭代序依赖点击顺序，截断结果会随之漂移）
  const keys = [...selected].sort()
  if (keys.length === 0) return EMPTY_ITEM_OUTLINE_PLAN

  const frame = options.frame
  const all: ItemAttributionHit[] = []
  const seen = new Set<string>()
  let unresolvedCount = 0
  let offFrameCount = 0

  for (const key of keys) {
    const entry = index?.get(key) ?? null
    const hits = entry?.hits ?? []
    if (hits.length === 0) {
      // 无条目 / 显式 no attribution：可选中、不高亮（#38「无对应规则」）
      unresolvedCount++
      continue
    }
    const inFrame = hits.filter(h => h.frame === frame)
    if (inFrame.length === 0) {
      offFrameCount++
      continue
    }
    for (const h of inFrame) {
      const id = hitKey(h)
      if (seen.has(id)) continue
      seen.add(id)
      all.push(h)
    }
  }

  const truncated = all.length > max
  const hits = truncated ? all.slice(0, max) : all
  return {
    selectedCount: keys.length,
    unresolvedCount,
    offFrameCount,
    totalHits: all.length,
    shownHits: hits.length,
    truncated,
    hits,
  }
}

/**
 * 归属命中 → 格引用（`BlockRef`）。**这是本模块唯一做下标换算的地方**：
 *
 * - `hit.grid = [zSlice, row, column]`（与 `cellGrid`/`cellPartsGrid` 同下标，row 0 = 顶部）；
 * - `BlockRef.pos = { x: column, y: sizeRow - 1 - row, z: zSlice }`（Grid 为 Y-up，见 `pure/vec`）；
 * - 目标格在 `cellGrid` 里**没有方块**（越界 / 空 / 调色板下标无效）⇒ `null`：
 *   归属数据指向了不存在的格，**不画幻影 mask**（调用方按"命中条目存在但不可渲染"处理）；
 * - `source === 'part'` 且带 `localId` ⇒ `partLocalId` 带上（B-1 部件通道）；
 *   其余（host / 无 localId）⇒ 不带（整格兜底，B-1 之前语义）。
 */
export function itemHitToBlockRef(
  def: StructureDefinition,
  hit: ItemAttributionHit,
): BlockRef | null {
  const [zi, ri, ci] = hit.grid
  const sizeRow = def.cellGrid[0]?.length ?? 0
  const slice = def.cellGrid[zi]
  const row = slice?.[ri]
  if (!row) return null
  const paletteIndex = row[ci]
  if (paletteIndex === undefined || paletteIndex < 0) return null
  const entry = def.blockPalette[paletteIndex]
  if (!entry) return null

  const ref: BlockRef = {
    pos: { x: ci, y: structureRowToWorldY(ri, sizeRow), z: zi },
    block_state_id: entry.registryId,
  }
  if (hit.source === 'part' && hit.localId !== undefined) ref.partLocalId = hit.localId
  return ref
}

/** 命中计划 → 可渲染的格引用列表（不可渲染的命中被丢弃，见 `itemHitToBlockRef`） */
export function itemHitBlockRefs(
  def: StructureDefinition,
  hits: readonly ItemAttributionHit[],
): BlockRef[] {
  const out: BlockRef[] = []
  for (const h of hits) {
    const ref = itemHitToBlockRef(def, h)
    if (ref) out.push(ref)
  }
  return out
}
