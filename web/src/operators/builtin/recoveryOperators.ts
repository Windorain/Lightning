/**
 * 恢复副本的**生产采纳/放弃入口**。
 *
 * 形态从简（暂定默认）：底栏提示 + 两个命令/按钮，不造新面板。
 * 两个算子都**只**调用装配层注入的会话端口（`Context#getRecoverySession`），
 * 自身不含任何政策 —— 采纳/放弃的判定与落地全在 `composition/recoverySession`。
 *
 * `poll` 只问"本实例有没有恢复副本会话"（装配事实），**不**问"此刻有没有候选"：
 * 候选是存储事实，可能在菜单构建与执行之间变化；执行时由会话重新扫描并如实返回
 * `none`。把候选检查塞进 poll 会让"刚刷新、扫描尚未落地"的窗口里命令无声灰掉。
 */

import type { OperatorType } from '@/operators/operatorType'
import type { Context } from '@/runtime/context'

function sessionOf(ctx: Context) {
  return ctx.getRecoverySession()
}

/** 用户显式采纳恢复副本（不推进正式保存基线）。 */
export const RecoveryAdoptOperator: OperatorType = {
  id: 'OPERATOR_RECOVERY_ADOPT',
  label: '采纳恢复副本',
  description: '把检测到的恢复副本内容恢复为当前文档（仍为未保存状态，不推进正式保存基线）',

  poll(ctx) {
    return sessionOf(ctx) !== null
  },

  exec(ctx) {
    const session = sessionOf(ctx)
    if (session === null) return
    const outcome = session.adopt()
    if (outcome.status === 'none') {
      ctx.log.info('恢复副本', '没有可采纳的恢复副本（存储里没有通过校验的候选）')
    }
  },
}

/** 用户显式放弃恢复副本（删除存储里的副本；不改当前内容）。 */
export const RecoveryDiscardOperator: OperatorType = {
  id: 'OPERATOR_RECOVERY_DISCARD',
  label: '放弃恢复副本',
  description: '删除检测到的恢复副本（损坏副本也可由此显式放弃）；当前有效内容不受影响',

  poll(ctx) {
    return sessionOf(ctx) !== null
  },

  exec(ctx) {
    const session = sessionOf(ctx)
    if (session === null) return
    const outcome = session.discard()
    if (outcome.status === 'none') {
      ctx.log.info('恢复副本', '没有可放弃的恢复副本')
    }
  },
}
