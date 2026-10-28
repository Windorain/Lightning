/**
 * **算子的能力门拒绝** —— 能力缺席时唯一的一句话，写在一个地方。
 *
 * ## 它替代了什么
 *
 * 旧写法散在各算子里：有的在 `exec` 里直接 `return`（点了没反应），有的在 `poll` 里返回
 * `false`（菜单项悄悄消失）—— 两者都靠一句宿主身份判断分叉。
 * 前者是"点了没反应"（静默成功），后者是"菜单项不见了"（静默消失）—— 契约
 * 「不可编辑不能表现为静默成功」、§10.10「隐藏按钮不能代替业务权限」两句都禁止这两个形态。
 *
 * 现在声明式地写在 `OperatorType.requires` 上，由注册表统一结算：
 *
 * | 情形 | 用户看到 | 判据读到的 |
 * |---|---|---|
 * | 能力具备 | 算子照常执行 | 正常日志条目 |
 * | 能力缺席 | 底栏成句原因「操作被拒：本外壳不具备该能力（X）」 | `UnsupportedOperation` + `capability` + `opId` |
 *
 * ## 为什么复用 `domain/errors` + `runtime/rejectionNotice`
 *
 * 拒绝的**唯一写入点**是 `rejectionNotice.announceRejection`（已建立的单点），
 * 底栏读的还是同一个 `origin='rejection'` 渠道。算子门因此不是第二套拒绝机制，
 * 而是同一条拒绝链的又一个**来源**（错误码仍是冻结八码里的 `UnsupportedOperation`）。
 */
import type { Context } from '@/runtime/context'
import type { OperatorType } from './operatorType'
import type { DomainError } from '@/domain/errors'
import { unsupportedOperation } from '@/domain/errors'
import { announceRejection } from '@/runtime/rejectionNotice'

/**
 * 构造"能力缺席"的结构化错误值。
 *
 * `reason: 'capability-unavailable'` 而不是 `capability-missing`：后者是**属性写**那条
 * 路径的成句（"本外壳缺少写能力"），用于工具/手势/外观等非写能力会说错话。
 */
export function capabilityUnavailableError(op: Pick<OperatorType, 'id'>, capability: string): DomainError {
  return unsupportedOperation({ reason: 'capability-unavailable', capability, operator: op.id })
}

/**
 * 构造 "**poll 不可用**" 的结构化错误值。
 *
 * 码固定 `UnsupportedOperation`（八码冻结，`params.reason` 承担精确性）；
 * `reason` 由算子经 `OperatorType.pollReason` 声明，缺省 `operator-unavailable`。
 *
 * ⚠️ 与 `capabilityUnavailableError` 放在同一个文件，是为了让"拒绝值从哪来"只有**一处**
 * （以及同一条已登记的 `operators/ → domain/errors` 边界边）—— 见 `operators/availability`
 * 文件头"不新增冻结错误码"一节。
 */
export function operatorUnavailableError(
  op: Pick<OperatorType, 'id'>,
  reason: import('./availability').OperatorPollReason,
): DomainError {
  return unsupportedOperation({ reason, operator: op.id })
}

/**
 * 记录一次**结构化拒绝**并写成句原因（调用方随后 `return`/`CANCELLED`）。
 *
 * 日志条目带 `opId`/`code`/`capability` 三个机器可读字段 —— 判据读它，
 * 人读 `message`。两者不互相代替。
 */
/**
 * 记录一次 **poll 拒绝**并写成句原因（调用方随后 `return`/`CANCELLED`）。
 *
 * ## 为什么它与能力门共用本文件（而不是各写一句）
 *
 * `poll` 为 false 与"缺能力"是两种事实，但**用户看到的是同一件事**："这次调用没有发生，
 * 原因是什么"。两条路径若各写一遍底栏，句子必然漂移（本工程已三次实测"两份实现必然漂移"）。
 * ⇒ 两者都收敛到 `announceRejection`（拒绝的**唯一**写入点），只是错误值不同：
 *
 * | 事实 | 错误值 | 成句条目 |
 * |---|---|---|
 * | 装配缺能力 | `UnsupportedOperation:capability-unavailable` | 既有 |
 * | 上下文不适用且**声明了**原因 | `UnsupportedOperation:<pollReason>` | 本条新增原因条目 |
 *
 * 八码**未新增**：poll 拒绝用 `UnsupportedOperation`，精确性由 `params.reason` 承担。
 *
 * ## 只在算子**声明了** `pollReason` 时调用
 *
 * 未声明原因的 `poll` 拒绝（撤销栈空、没选中目标…）**不该**在底栏弹拒绝 ——
 * 那是"现在没什么可做"，不是失败。该分叉由 `operators/availability` 的 `source`
 * （`'poll-declared'` / `'poll-generic'`）表达，注册表据此决定要不要调本函数。
 */
export function refuseUnavailableOperator(
  ctx: Context,
  op: Pick<OperatorType, 'id' | 'label'>,
  error: DomainError,
): DomainError {
  ctx.log.warn('Operator', `refused: ${op.label}`, {
    opId: op.id,
    code: error.code,
    reason: error.params.reason,
    result: 'CANCELLED',
  })
  announceRejection(ctx, error, 'generic', op.label)
  return error
}

export function refuseOperator(ctx: Context, op: Pick<OperatorType, 'id' | 'label'>, capability: string): DomainError {
  const error = capabilityUnavailableError(op, capability)
  ctx.log.warn('Operator', `refused: ${op.label}`, {
    opId: op.id,
    code: error.code,
    capability,
    result: 'CANCELLED',
  })
  announceRejection(ctx, error, 'generic', op.label)
  return error
}
