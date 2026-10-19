/**
 * **算子的能力门拒绝**（M7-5）—— 能力缺席时唯一的一句话，写在一个地方。
 *
 * ## 它替代了什么
 *
 * 旧写法散在各算子里：有的在 `exec` 里直接 `return`（点了没反应），有的在 `poll` 里返回
 * `false`（菜单项悄悄消失）—— 两者都靠一句宿主身份判断分叉。
 * 前者是"点了没反应"（静默成功），后者是"菜单项不见了"（静默消失）——SPEC §10.7
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
 * 拒绝的**唯一写入点**是 `rejectionNotice.announceRejection`（M4-3 R3 建立的单点），
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
 * 记录一次**结构化拒绝**并写成句原因（调用方随后 `return`/`CANCELLED`）。
 *
 * 日志条目带 `opId`/`code`/`capability` 三个机器可读字段 —— 判据读它，
 * 人读 `message`。两者不互相代替。
 */
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
