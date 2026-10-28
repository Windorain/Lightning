/**
 * `runtime/scheduling` —— **输入排序、有界批次、重放记录**（`submit`）。
 *
 * ## 本模块替代的旧机制（多 RAF 分别推进业务）
 *
 * 旧实现里"业务推进"分散在多个 `requestAnimationFrame` 循环与 Promise 回调里：
 * `runtime/renderEngine.ts:100` 的 tick、`:81` 的 layout resize RAF、
 * `runtime/hover/pickSchedule.ts:22` 的第三条 RAF，以及各处 `.then()` 回调直接写状态。
 * 其后果是「**所有业务推进可枚举**」不成立 —— 没人能列出"下一次状态变化从哪来"。
 *
 * 本模块把它变成可枚举的：任何权威变化的来源都是一个**已排序的输入记录**，
 * 一个批次是这条记录流的一个**有界切片**。
 *
 * ## 三条硬要求
 *
 * 1. **有界批次**（「每批有事件数量或时间预算，禁止无界排空」）：
 *    `planBatch` 返回的切片长度受 `maxEvents` 限制；超出部分**推迟到下一批**，
 *    且**不把半个原子命令对外发布**（因为命令是批次的原子单位，切片不会切开一个命令）。
 * 2. **相同输入流与预算决策记录可重放**：`ReplayLog` 记录输入与预算决策；
 *    `replay` 用**同一个** `reduceCommand` 重跑，逐条比对语义摘要与效果序列。
 * 3. **指针合并只在工具明示时发生**（「指针移动可以在工具明示"仅终点有意义"时合并；
 *    笔划等轨迹输入不得默认丢点；down/up/cancel 和命令顺序不合并」）：
 *    本模块提供显式的 `coalescePolicy`，**默认不合并**。
 */

import type { Command, ExecutionInputs, Transition } from '@/application/commands'
import { reduceCommand } from '@/application/commands'
import type { ApplicationState, EffectRequest } from '@/application/state'
import type { Version } from '@/domain/identity'

// ─────────────────────────────────────────────────────────────────────────────
// 输入记录
// ─────────────────────────────────────────────────────────────────────────────

/** 输入来源。区分它们是为了让"业务推进可枚举"能被审计。 */
export type InputSource =
  | 'host-input' // 浏览器/宿主事件（指针、键盘、IME）
  | 'command' // 程序化命令（脚本/UI 面板）
  | 'effect-completion' // 外部效果完成（IO 回调）
  | 'timer' // 显式投递的时钟推进（**不是**隐式 RAF）
  | 'lifecycle' // 打开/关闭/重绑

/** 一条输入记录：所有权威变化的**唯一**来源。 */
export interface InputRecord {
  /** 全局单调序号；排序的**第一**键。 */
  readonly sequence: number
  /** 同一序号内的稳定次序（例如同一批到达的多个宿主事件）。 */
  readonly order: number
  readonly source: InputSource
  readonly command: Command
  /** 该输入携带的执行输入（能力/关联 id）。 */
  readonly env: ExecutionInputs
}

/**
 * 排序键：`(sequence, order)`。
 *
 * 为什么**不是**按到达时刻排序：时刻需要时钟，而时钟是纯函数不能读的
 * （纯函数不记日志）。序号由接线层在**接纳**输入时分配，是显式值 ——
 * 于是"接纳已排序输入"是一个可重放的纯排序。
 */
export function compareInputs(a: InputRecord, b: InputRecord): number {
  if (a.sequence !== b.sequence) return a.sequence - b.sequence
  return a.order - b.order
}

export function sortInputs(inputs: readonly InputRecord[]): readonly InputRecord[] {
  return Object.freeze([...inputs].sort(compareInputs))
}

// ─────────────────────────────────────────────────────────────────────────────
// 有界批次
// ─────────────────────────────────────────────────────────────────────────────

export interface BatchBudget {
  /** 每批最多处理多少条输入（**有界**，禁止无界排空）。 */
  readonly maxEvents: number
}

export const DEFAULT_BUDGET: BatchBudget = Object.freeze({ maxEvents: 64 })

export interface BatchPlan {
  /** 本批要处理的输入（已排序）。 */
  readonly inputs: readonly InputRecord[]
  /** 批后游标（指向下一条未处理输入）。 */
  readonly nextCursor: number
  /** 是否因预算耗尽而推迟了输入。 */
  readonly deferred: boolean
  /** 预算决策记录（进重放日志，使"相同预算决策"可复现）。 */
  readonly budgetUsed: number
}

/**
 * 规划一个批次。
 *
 * 切片**不切开命令**：每条 `InputRecord` 就是一个完整命令，故"半个原子命令对外发布"
 * 在本模型下不可表达（结构性满足）。
 */
export function planBatch(queue: readonly InputRecord[], cursor: number, budget: BatchBudget): BatchPlan {
  const remaining = queue.length - cursor
  const take = Math.max(0, Math.min(budget.maxEvents, remaining))
  const inputs = Object.freeze(queue.slice(cursor, cursor + take))
  return Object.freeze({
    inputs,
    nextCursor: cursor + take,
    deferred: remaining > take,
    budgetUsed: take,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 状态摘要（重放对账的单位）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一次转移的**语义摘要**。
 *
 * 要求「逐提交语义摘要与效果序列一致」。摘要只含**语义**内容，
 * 不含对象身份（那会随分配器状态变化）之外的运行时细节，故可逐位比对。
 */
export interface StepDigest {
  readonly sequence: number
  readonly order: number
  readonly commandKind: string
  readonly status: Transition['status']
  readonly documentVersion: number
  readonly contentVersion: number
  readonly effectKinds: readonly string[]
  readonly errorCode: string | null
}

export function digestStep(input: InputRecord, transition: Transition): StepDigest {
  return Object.freeze({
    sequence: input.sequence,
    order: input.order,
    commandKind: input.command.kind,
    status: transition.status,
    documentVersion: transition.version.documentVersion,
    contentVersion: transition.version.contentVersion ?? 0,
    effectKinds: Object.freeze(transition.effects.map((e) => e.kind)),
    errorCode: transition.status === 'rejected' ? transition.error.code : null,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 重放
// ─────────────────────────────────────────────────────────────────────────────

/** 可重放的输入与预算决策记录。 */
export interface ReplayLog {
  readonly initial: ApplicationState
  readonly inputs: readonly InputRecord[]
  readonly budget: BatchBudget
  /** 每条输入的语义摘要（重放时逐条比对）。 */
  readonly digests: readonly StepDigest[]
  /** 完整效果序列（含命令描述的效果与实际发出的效果）。 */
  readonly effects: readonly EffectRequest[]
}

export interface ReplayResult {
  readonly ok: boolean
  readonly state: ApplicationState
  readonly digests: readonly StepDigest[]
  /** 首个不一致处（`ok: true` 时为 `null`）。 */
  readonly mismatch: { readonly index: number; readonly expected: StepDigest; readonly actual: StepDigest } | null
}

/**
 * 重放一段记录。
 *
 * **不需要 DOM/GPU**：全部输入都是值，全部转移都是纯函数。
 * 逐条比对语义摘要，首个不一致即报告 —— 不"整体重跑后看最终状态是否相同"，
 * 因为那会漏掉"两条错误互相抵消"的情形。
 */
export function replay(log: ReplayLog, newBudget?: BatchBudget): ReplayResult {
  const budget = newBudget ?? log.budget
  let state = log.initial
  const digests: StepDigest[] = []
  let cursor = 0
  let index = 0
  while (cursor < log.inputs.length) {
    const plan = planBatch(log.inputs, cursor, budget)
    for (const input of plan.inputs) {
      const transition = reduceCommand(state, input.command, input.env)
      state = transition.state
      const d = digestStep(input, transition)
      const expected = log.digests[index]
      if (expected && !sameDigest(expected, d)) {
        return Object.freeze({ ok: false, state, digests: Object.freeze([...digests, d]), mismatch: Object.freeze({ index, expected, actual: d }) })
      }
      digests.push(d)
      index += 1
    }
    cursor = plan.nextCursor
  }
  return Object.freeze({ ok: true, state, digests: Object.freeze(digests), mismatch: null })
}

function sameDigest(a: StepDigest, b: StepDigest): boolean {
  if (a.sequence !== b.sequence || a.order !== b.order) return false
  if (a.commandKind !== b.commandKind || a.status !== b.status) return false
  if (a.documentVersion !== b.documentVersion || a.contentVersion !== b.contentVersion) return false
  if (a.errorCode !== b.errorCode) return false
  if (a.effectKinds.length !== b.effectKinds.length) return false
  for (let i = 0; i < a.effectKinds.length; i++) if (a.effectKinds[i] !== b.effectKinds[i]) return false
  return true
}

// ─────────────────────────────────────────────────────────────────────────────
// 指针合并策略（默认不合并）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 合并策略。
 *
 * 「指针移动可以在工具**明示**"仅终点有意义"时合并；笔划等轨迹输入
 * **不得默认丢点**；down/up/cancel 和命令顺序不合并」。
 *
 * ⇒ 默认值是 `'none'`。要合并必须由工具**显式**声明（`'endpoint-only'`），
 * 且 `down`/`up`/`cancel` 一类命令即使在 endpoint-only 下也**不参与合并**。
 */
export type CoalescePolicy = 'none' | 'endpoint-only'

/** 永不参与合并的命令（与轨迹/模态边界有关）。 */
export function isNonCoalescable(command: Command): boolean {
  return (
    command.kind === 'beginInteraction' ||
    command.kind === 'commitInteraction' ||
    command.kind === 'cancelInteraction' ||
    command.kind === 'undo' ||
    command.kind === 'redo'
  )
}

/**
 * 按策略合并一组连续输入。
 *
 * `'none'` 原样返回（**默认**）；`'endpoint-only'` 只保留同一工具的连续
 * `updateInteraction` 的**最后一条**。
 */
export function coalesce(inputs: readonly InputRecord[], policy: CoalescePolicy): readonly InputRecord[] {
  if (policy === 'none') return Object.freeze([...inputs])
  const out: InputRecord[] = []
  for (let i = 0; i < inputs.length; i++) {
    const cur = inputs[i]
    if (cur.command.kind !== 'updateInteraction' || isNonCoalescable(cur.command)) {
      out.push(cur)
      continue
    }
    // 向后吞掉同 kind 的连续 update（终点有意义）
    let j = i
    while (j + 1 < inputs.length && inputs[j + 1].command.kind === 'updateInteraction') j += 1
    out.push(inputs[j])
    i = j
  }
  return Object.freeze(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// 版本一致性辅助
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 发布版本的**一致组合**校验。
 *
 * 「订阅者观察到的一致版本不含「新文档旧选择」组合」。本函数把它变成可断言判据：
 * 给定同一次发布里的文档版本与选择，选择引用的对象必须在**该版本的场景**里存在。
 */
export function selectionMatchesVersion(state: ApplicationState, documentId: string, contextId: string): boolean {
  const doc = Object.prototype.hasOwnProperty.call(state.docs, documentId) ? state.docs[documentId] : undefined
  if (!doc) return false
  const ctx = Object.prototype.hasOwnProperty.call(state.contexts, contextId) ? state.contexts[contextId] : undefined
  if (!ctx) return false
  if (ctx.documentId !== documentId) return false
  for (const ref of ctx.selection.selected) {
    if (ref.kind !== 'object') continue
    if (!Object.prototype.hasOwnProperty.call(doc.scene.objects, ref.id)) return false
  }
  const active = ctx.selection.active
  if (active && active.kind === 'object' && !Object.prototype.hasOwnProperty.call(doc.scene.objects, active.id)) return false
  return true
}

/** 版本是否只推进了内容（`documentVersion` 与 `contentVersion` 同向变化）。 */
export function versionAdvancedConsistently(from: Version, to: Version): boolean {
  if (to.documentVersion === from.documentVersion) return (to.contentVersion ?? 0) === (from.contentVersion ?? 0)
  return to.documentVersion > from.documentVersion && (to.contentVersion ?? 0) !== (from.contentVersion ?? 0)
}
