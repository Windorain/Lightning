/**
 * 呈现**内容信号** —— `structEpoch` 的直接替代物。
 *
 * ## 与被退役机制的**唯一**差别，及为什么这个差别是本质的
 *
 * 旧机制：`Main.bumpEpoch()` 把 `structEpoch` 加一，DRW `watch(structEpochRef)` 后
 * 无条件 `rebuildAll()`。调用方表达的是"**我认为该重建了**"。
 *
 * 本机制：`republish()` **重新读取内容**并算出身份；只有当身份**真的变了**才通知。
 * 调用方表达的是"**数据可能变了，请你自己看**"——判断权在数据，不在调用方。
 *
 * 三个可直接观察的后果（每条都有对应断言）：
 *
 * | 场景 | 旧机制 | 本机制 |
 * |---|---|---|
 * | 移动方块（几何真变了） | 全量重建 | 身份变 ⇒ 按 plan 重建几何（**不**重解码资源） |
 * | 改注解文字（几何没变） | 全量重建 | 注解身份变、结构身份不变 ⇒ **几何重建数 0**（判据） |
 * | 转机位（内容没变） | 若调用方 bump ⇒ 全量重建 | 内容身份不动 ⇒ 无动作（判据） |
 * | 撤销回原内容 | 计数器只增 ⇒ 全量重建 | 身份**回到**原值 ⇒ 可判定"无需重建"（契约 §1.4） |
 *
 * ## 为什么它不是"版本补丁"
 *
 * 明确禁止「调用方手动刷新、版本补丁」。"补丁"的定义是**绕开内容直接指定
 * 结果**（`bumpStructEpoch: false` 就是典型：调用方替渲染层回答"这次不用重建"）。
 * `republish()` 不具备这个能力 —— 它没有"设成什么值"的参数，只有"请重算"。任何调用方
 * **无法**通过它制造一次虚假的"没变"或"变了"。
 */

import { ref, shallowRef, type Ref } from 'vue'
import {
  diffContentIdentity,
  planContentRebuild,
  rebuildPlanIsNoop,
  type ContentChange,
  type ContentIdentity,
  type RebuildPlan,
} from './contentIdentity'

/** 一次内容变更的完整记录（诊断面：谁在什么时候让什么变了）。 */
export interface ContentRevision {
  readonly identity: ContentIdentity
  readonly change: ContentChange
  readonly plan: RebuildPlan
  /** 这是第几次**实际生效**的变更（同内容重复 republish 不计数）。 */
  readonly revision: number
  /** 触发来源的标签（仅供诊断；**不影响**判定）。 */
  readonly source: string
}

export interface ContentSignal {
  /** 当前内容身份（响应式；下游可 `watch`）。 */
  readonly identity: ShallowRefRef<ContentIdentity | null>
  /** 最近一次变更（无变更时为 `null`）。 */
  readonly lastRevision: Ref<ContentRevision | null>
  /** 实际生效的变更次数。 */
  readonly revisionCount: Ref<number>
  /**
   * **重新读取内容**并（仅在变化时）发布。
   *
   * 返回本次的 `ContentRevision`；内容未变时返回 `null`（并**不**推进 `revisionCount`）。
   * `source` 只是诊断标签，不能改变判定。
   */
  republish(source: string): ContentRevision | null
  /** 内容身份快照（非响应式读取）。 */
  current(): ContentIdentity | null
}

/** `shallowRef` 的只读别名（避免调用方写入；写入只能经 `republish`）。 */
type ShallowRefRef<T> = Readonly<ShallowRefLike<T>>
interface ShallowRefLike<T> {
  value: T
}

/**
 * 建一个内容信号。
 *
 * `read` 必须是**纯读**：它由适配层提供（从文档/网格/注解/资源机械派生摘要），
 * 本模块不依赖任何 legacy 类型（规则 3：presentation 只消费求值契约与渲染参数）。
 */
export function createContentSignal(read: () => ContentIdentity): ContentSignal {
  const identity = shallowRef<ContentIdentity | null>(null)
  const lastRevision = ref<ContentRevision | null>(null)
  const revisionCount = ref(0)

  function republish(source: string): ContentRevision | null {
    const next = read()
    const prev = identity.value
    const change = diffContentIdentity(prev, next)
    const plan = planContentRebuild(change)

    // 内容没变 ⇒ **不**产生任何"变更"事实（旧机制的 bumpEpoch 在这里必然自增）
    const unchanged =
      prev !== null &&
      !change.documentChanged &&
      !change.structureChanged &&
      !change.annotationsChanged
    if (unchanged && rebuildPlanIsNoop(plan)) {
      identity.value = next
      return null
    }

    revisionCount.value += 1
    const revision: ContentRevision = { identity: next, change, plan, revision: revisionCount.value, source }
    identity.value = next
    lastRevision.value = revision
    return revision
  }

  return {
    identity,
    lastRevision,
    revisionCount,
    republish,
    current: () => identity.value,
  }
}

/**
 * 断言一个 `RebuildPlan` **没有**要求重建几何 —— 适配层断言糖。
 *
 * 放在这里而不是适配层：「呈现层不得因注解变化重建几何」是**呈现层**保证，
 * 适配层只是它的消费者。
 */
export function planRebuildsGeometry(plan: RebuildPlan): boolean {
  return plan.rebuildGeometry
}
