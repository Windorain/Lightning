/**
 * M4-3 R3 · **拒绝的底栏可见写点**（算子/交互路径共用）。
 *
 * ## 为什么需要单独一个模块
 *
 * 拒绝可能发生在三类地方：属性写（面板/输入端口）、内容编辑算子（注解/工具提示）、
 * 拖拽移动。三者都要写同一句话（`domain/rejectionText`）到同一个槽
 * （`LogCenter.liveStatus`），若各写一遍，"某个入口忘了写"就无法机械发现。
 * 这里给出唯一实现，并用 `RejectionOperation` 表达"发生在哪种操作上"。
 *
 * ## 只写 `rejection` 渠道
 *
 * 纹理链同样写 `liveStatus`（`origin: 'texture'`）。本模块的写入带
 * `origin: 'rejection'`，于是"成功提交时只清自己那条"可以按渠道判定
 * （见 `LogCenter#clearRejectionStatus`）。
 */

import type { Context } from '@/runtime/context'
import type { DomainError } from '@/application/contracts'
import type { Lang } from '@/domain/i18n'
import { rejectionSentence, type RejectionOperation } from '@/domain/rejectionText'
import { LOG_LEVEL } from '@/logging/LogCenter'
import type { EditSettlement } from '@/domain/editSettlement'

/** 本实例语言（`domain/i18n` 的纯翻译只认显式输入）。 */
export function langOf(ctx: Context): Lang {
  return ctx.getShellSettings().lang.value
}

/** 把一条拒绝写成用户可读的底栏实时状态（**唯一的拒绝写入点**）。 */
export function announceRejection(
  ctx: Context,
  error: DomainError,
  op: RejectionOperation,
  subject?: string,
): void {
  ctx.log.setLiveStatus(
    rejectionSentence(error, langOf(ctx), op, subject),
    LOG_LEVEL.WARN,
    null,
    'rejection',
  )
}

/**
 * 结算分派 → 是否**回落 legacy**。
 *
 * 三个分支的语义见 `domain/editSettlement`：
 *  - `applied`/`unchanged` ⇒ `false`（内核已受理；回落会用旧数据覆盖内核结果）；
 *  - `rejected` ⇒ 先写成句原因，再 `false`（**不得**回落：拒绝不是"没装配"）；
 *  - `not-assembled` ⇒ `true`（双轨接缝的既有回退语义）。
 *
 * @returns `true` = 调用方应继续走既有 legacy 写路径
 */
export function fallbackToLegacyOn(
  ctx: Context,
  settlement: EditSettlement,
  op: RejectionOperation,
  subject?: string,
): boolean {
  if (settlement.kind === 'rejected') announceRejection(ctx, settlement.error, op, subject)
  return settlement.kind === 'not-assembled'
}
