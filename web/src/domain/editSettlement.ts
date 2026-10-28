/**
 * **「未装配 / 被拒 / 已应用」三分派的唯一判据**（纯函数）。
 *
 * ## 它替代了什么（最恶劣形态）
 *
 * 五处生产调用点用布尔形态 `if (ctx.submitContentEdit(cmd)) … else 回落 legacy`：
 * `submitContentEdit` 把内核的 `applied`/`unchanged`/`rejected` 与
 * **未装配**（`null`）压成同一个 `false`。于是"内核**拒绝**了这次编辑"
 * 与"内核**没装上**"在代码里同形 ⇒ 拒绝被当成未装配，静默走旧路径抹掉
 * （`moveTranslate`/`annotationOperators`/`metaEditOperators`）。
 *
 * 本模块把结算翻成三分派，**分派规则只有这一份**：
 *
 * | 结算 | 分派 | 调用方该做什么 |
 * |---|---|---|
 * | `applied` | `applied` | 沿用现状（内核已写 + 投影回写已完成） |
 * | `unchanged` | `unchanged` | **不回落**，也**不**报成拒绝（无业务变化 ≠ 失败） |
 * | `rejected` | `rejected` | 写可见的成句原因，**不得回落 legacy** |
 * | `null`（无会话/未装配） | `not-assembled` | 既有回落语义（双轨接缝的合法分支） |
 *
 * `unchanged` 单列的理由（同族）：把"值没变"当拒绝会在界面上报一条
 * 根本不存在的失败；把它当"未装配"会回落旧路径重复写一遍。
 */

import type { CommandOutcome, DomainError } from '@/application/contracts'

/** 一次内容编辑的分派结论（三分派 + 一个"无变化"事实）。 */
export type EditSettlement =
  | Readonly<{ kind: 'applied' }>
  | Readonly<{ kind: 'unchanged' }>
  | Readonly<{ kind: 'rejected'; error: DomainError }>
  | Readonly<{ kind: 'not-assembled' }>

/** 结算 → 分派（**唯一**实现；`null` = 未装配）。 */
export function settlementOf(outcome: CommandOutcome | null): EditSettlement {
  if (outcome === null) return { kind: 'not-assembled' }
  switch (outcome.status) {
    case 'applied':
      return { kind: 'applied' }
    case 'unchanged':
      return { kind: 'unchanged' }
    case 'rejected':
      return { kind: 'rejected', error: outcome.error }
  }
}

/** 内核是否**受理**了这次编辑（`applied` 或 `unchanged`）—— 两种都意味着"不得回落 legacy"。 */
export function kernelAccepted(settlement: EditSettlement): boolean {
  return settlement.kind === 'applied' || settlement.kind === 'unchanged'
}
