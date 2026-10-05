/**
 * pure/outlineLimits.ts — 描边 mask 通道的**上限口径与预算结算**（B-5 收口）。
 *
 * 由来：`SelectionHighlightProvider` 自 B-1 之前即有「选择集 > 500 ⇒ 不出 mask」的保护
 * （`drw.ts` 的选择/悬停分支同口径）。B-5（#38）要求：物品点选高亮的**命中总数与既有 ≤ 500
 * 口径对齐**，且超出时**截断 + 可辨认提示，不得静默失效**；同时把 `extraMaskMeshes`
 * 这条**无上限**通道一并收口到同一口径。
 *
 * 之所以独立成模块：该值同时被 `render/mesh/selectionHighlightProvider.ts`（provider 自保）、
 * `runtime/drw.ts`（通道总预算）、`pure/itemOutlinePlan.ts`（物品命中截断）使用，
 * 三处必须同值——散落的字面量正是"口径漂移"的来源。
 *
 * No side effects: no Vue refs, no DOM, no I/O, no mutation of arguments.
 */

/** 描边 mask 通道上限（既有 ≤ 500 口径；B-1 之前即为此值） */
export const OUTLINE_MASK_LIMIT = 500

/** mask 预算结算结果（`all` = 实际送进通道的列表） */
export interface OutlineMaskBudget<T> {
  /** 选择/悬停 mask ∪ 附加 mask，**已按上限截断** */
  all: T[]
  /** 请求总数（截断前） */
  total: number
  /** 实际数量（= `all.length`） */
  shown: number
  /** 被截断掉的数量（`total - shown`）；> 0 ⇒ 调用方必须给出可辨认提示 */
  dropped: number
}

/**
 * 把「选择/悬停 mask」与「附加 mask（Embed 侧栏点选高亮）」并成一个**受上限约束**的列表。
 *
 * 顺序语义：选择/悬停 mask 优先占用预算（它们是视口自身的交互反馈），附加 mask 用剩余额度；
 * 附加通道超限即截断——B-5 之前它无上限（大命中集合把描边通道压垮且用户毫无察觉）。
 */
export function applyOutlineMaskBudget<T>(
  masks: readonly T[],
  extra: readonly T[],
  limit: number = OUTLINE_MASK_LIMIT,
): OutlineMaskBudget<T> {
  const budget = Math.max(0, limit - masks.length)
  const extraShown = extra.length > budget ? extra.slice(0, budget) : extra
  const all = extraShown.length > 0 ? [...masks, ...extraShown] : [...masks]
  const total = masks.length + extra.length
  return { all, total, shown: all.length, dropped: total - all.length }
}
