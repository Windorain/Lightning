/**
 * `presentation/outlineBudget` —— 描边 mask 通道的**上限口径与预算结算**。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | `pure/outlineLimits`（`OUTLINE_MASK_LIMIT` + `applyOutlineMaskBudget`） | `pure/outlineLimits.ts`（**本次删除**） | 同一口径与同一结算算法，**移入新层**；旧层消费者改为从本模块取（生产接线，不是并存） |
 *
 * ## 为什么"搬"而不是"在旧处保留 + 新层 import 它"
 *
 * `presentation/` 是新实现层，`pure/` 是它的**旧对应物**
 * （`LAYER_DESTINATIONS`：`domain.legacySources = ['pure', 'context']`）。
 * 新层 import 旧层正是「新门面包旧核心」要禁的方向。
 *
 * 实测：这条 import **不触发现有闸门**（`gate/no-private-cross-layer` 只看深度 ≤ 2，
 * `pure/outlineLimits.ts` 刚好深度 2；`kernel-legacy-isolation` 只枚举 `KERNEL_FILES`，
 * `presentation/` 不在其中）。但**闸门覆盖面的空隙不是"允许"** ——
 * 顺着空隙走正是"新旧长期并存"的起点（明文禁止）。
 *
 * 反向的"旧处保留转发、新层导出它"也不行：那是 `gate/no-barrel-smuggling`
 * 明令禁止的跨目录 barrel 转出口（实测判红：`src/pure → src/presentation` 未登记）。
 *
 * ⇒ 唯一正确的形态是**真搬家**：定义随新层走，旧层消费者改为依赖新层
 * （依赖方向 旧 → 新，即迁移的正确方向）。旧层那一侧**不留转发**
 * —— 留了就是并存，且会让"值有几个来源"重新变模糊。
 *
 * ## 语义**逐字节不变**（这是本模块的唯一验收口径）
 *
 * 常量值、预算分配顺序（选择/悬停 mask **优先**占额度、附加 mask 用余额）、
 * `total`/`shown`/`dropped` 三个读数的定义，全部与搬迁前逐字相同。
 * 它是一次**搬家**，不是"顺手改进"（纪律：视觉/口径变更须独立决定）。
 *
 * 判据就是**原判据本尊**（`__tests__/outlineBudget.test.ts`，随模块一起搬、
 * 除 import 路径与文件名外**一行未改**）—— 因此它同时构成"搬家后行为不变"的证据。
 *
 * ## 纯度
 *
 * 无 IO、无 DOM、无 three、无 Vue、不修改入参。
 */

/**
 * 描边 mask 通道上限（既有 ≤ 500 口径；部件通道之前即为此值）。
 *
 * ⚠️ **改这个值需要独立决定** —— 它同时决定
 * `selectionHighlightProvider` 的自保阈值、`drw` 的通道总预算、
 * 物品命中截断三处行为。
 */
export const OUTLINE_MASK_LIMIT = 500

/** mask 预算结算结果（`all` = 实际送进通道的列表）。 */
export interface OutlineMaskBudget<T> {
  /** 选择/悬停 mask ∪ 附加 mask，**已按上限截断**。 */
  all: T[]
  /** 请求总数（截断前）。 */
  total: number
  /** 实际数量（= `all.length`）。 */
  shown: number
  /** 被截断掉的数量（`total - shown`）；> 0 ⇒ 调用方**必须**给出可辨认提示。 */
  dropped: number
}

/**
 * 把「选择/悬停 mask」与「附加 mask（Embed 侧栏点选高亮）」并成一个**受上限约束**的列表。
 *
 * 顺序语义：选择/悬停 mask **优先**占用预算（它们是视口自身的交互反馈），
 * 附加 mask 用剩余额度；附加通道超限即截断。
 *
 * （原注释记录的由来：此前附加通道**无上限**，大命中集合会把描边通道压垮
 * 且用户毫无察觉 —— 故 `dropped` 必须被调用方读出来提示。）
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
