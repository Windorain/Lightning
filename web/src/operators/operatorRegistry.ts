/**
 * OperatorRegistry — 对标 Blender 的 WM_operatortype_append / WM_operator_name_call。
 *
 * 全局操作符注册表。管理所有操作符实例，提供 exec/invoke 便捷方法。
 */
import type { Context } from '@/runtime/context'
import type { OperatorType, OperatorProperties, OpResult } from './operatorType'
import { OP_RESULT } from './operatorType'
import { pushDocUndo } from './pushDocUndo'

import { ModalOperatorWrapper } from './modalOperatorWrapper'
import type { StateDigest } from '@/logging/LogCenter'
import { refuseOperator, refuseUnavailableOperator } from './capabilityRefusal'
import { operatorAvailability } from './availability'
import { reportCommandApplied, reportCommandReceived } from '@/runtime/commandDiagnostics'

function logOperatorResult(
  ctx: Context, opId: string, label: string, result: string,
  snapBefore?: StateDigest,
) {
  const detail: Record<string, unknown> = { opId, result }
  if (snapBefore) {
    const d = ctx.log.diff(snapBefore, ctx)
    if (d.blocksAdded.length || d.blocksRemoved.length || d.blocksMoved.length || d.selectionChanged) {
      detail.changes = d
    }
  }
  ctx.log.operator('Operator', `${label} → ${result}`, detail)
}

export class OperatorRegistry {
  private operators = new Map<string, OperatorType>()

  register(op: OperatorType): void {
    this.operators.set(op.id, op)
  }

  find(id: string): OperatorType | undefined {
    return this.operators.get(id)
  }

  all(): OperatorType[] {
    return [...this.operators.values()]
  }

  /** 无交互执行操作符。如果 flagUndo 为 true，自动包裹 undo。 */
  async exec(ctx: Context, id: string, props?: OperatorProperties): Promise<void> {
    const op = this.operators.get(id)
    if (!op) { ctx.log.warn('Operator', `exec: op not found ${id}`, { opId: id }); return }
      // 命令的"被接收/已执行"是契约要求的第一个事实。这里是**唯一**写点
    // （菜单、快捷键、脚本、`ctx.getOperators().exec` 全部经过它）；拒绝由
    // `capabilityRefusal`/`settleFieldWrite` 发 `command.rejected`，不在这里重复。
    reportCommandReceived(ctx.wm.diagnostics, id)
    // ── 唯一的可用性结算（`operators/availability`）：能力（装配事实）优先于 poll
    //    （上下文事实）—— 前者不随文档状态变化，必须先结算成拒绝。
      //    ⚠️ 这是执行前的**最终防线**：UI 的灰显只是呈现，不是权威。
    if (!settleAvailability(ctx, op, 'exec')) return

      // 存在性判定走内核读面（已建立的不变量）。
    // 原写法 `const doc = …; doc ? snapshot : undefined` 只用"有没有文档"这一位事实
      // ⇒ 换成读面后残留归零。⚠️ 下方 `:57`/`:59` 的 `.clone()` 是受控双轨
      // （legacy 快照在撤销路径存续）—— 这里**不动**。
    const snap = ctx.hasLoadedDocument() ? ctx.log.snapshot(ctx) : undefined
    const resolvedProps: OperatorProperties = props ?? {}
    if (op.exec) {
      if (op.flagUndo && ctx.hasLoadedDocument()) {
          // 撤销快照 = **不透明令牌**。
        // `null` = 当时没有文档 ⇒ 表达"撤销到无文档"（内核历史结构性表达不了的那一态）。
        const before = ctx.documentSnapshot()
        await op.exec(ctx, resolvedProps)
        const after = ctx.documentSnapshot()
        pushDocUndo(ctx, before, after, op.label)
      } else {
        await op.exec(ctx, resolvedProps)
      }
      logOperatorResult(ctx, id, op.label, 'FINISHED', snap)
      reportCommandApplied(ctx.wm.diagnostics, id)
    }
  }

  /** 交互式调用操作符。返回操作状态。regionId 指定目标区域的模态栈。 */
  invoke(
    ctx: Context,
    id: string,
    props?: OperatorProperties,
    event?: PointerEvent | KeyboardEvent,
    regionId?: string,
  ): OpResult {
    const op = this.operators.get(id)
    if (!op) { ctx.log.warn('Operator', `invoke: op not found ${id}`, { opId: id }); return OP_RESULT.CANCELLED }
    // 与 `exec` 走同一个结算函数（同一句话、同一条拒绝链）—— Ctrl+S 之类的直接入口
    // 因此与菜单项拿到的原因**逐字相同**。
    if (!settleAvailability(ctx, op, 'invoke')) return OP_RESULT.CANCELLED

      // 同 `:52`（存在性走内核读面）。
    const snap = ctx.hasLoadedDocument() ? ctx.log.snapshot(ctx) : undefined

    const resolvedProps: OperatorProperties = props ?? {}
    if (regionId) resolvedProps._regionId = regionId

    if (op.invoke) {
      const snapshot = op.flagUndo && ctx.hasLoadedDocument()
        ? ctx.documentSnapshot()
        : null

      const result = op.invoke(ctx, resolvedProps, event)

      if (result === OP_RESULT.RUNNING_MODAL) {
        const targetRegion = regionId ?? ctx.wm.events.getCurrentRegionId() ?? 'r-viewport'
        const wrapper = new ModalOperatorWrapper(op, ctx, resolvedProps, targetRegion)
        if (snapshot !== null) {
          wrapper.setUndoSnapshot(snapshot)
        }
        if (event) ctx.wm.events.pushModal(targetRegion, wrapper, event)
        logOperatorResult(ctx, id, op.label, 'RUNNING_MODAL', snap)
      } else if (result === OP_RESULT.FINISHED) {
        if (snapshot !== null) {
          const snapshotAfter = ctx.documentSnapshot()
          pushDocUndo(ctx, snapshot, snapshotAfter, op.label)
        }
        logOperatorResult(ctx, id, op.label, 'FINISHED', snap)
      }
      return result
    }

    if (op.exec) {
      invokeExecFallback(ctx, op, resolvedProps).catch(err => {
        ctx.log.error('Operator', `invoke exec fallback failed: ${op.label}`, { opId: op.id, error: String(err) })
      })
      return OP_RESULT.FINISHED
    }

    return OP_RESULT.CANCELLED
  }
}

/**
 * 在**执行前**结算可用性（能力 → poll），返回 `true` 表示"可以继续执行"。
 *
 * ## 三种不可用的处置（一张表，两条入口共用）
 *
 * | `source` | 用户看到 | 判据读到 |
 * |---|---|---|
 * | `capability` | 底栏成句原因（本外壳不具备该能力） | `UnsupportedOperation` + `capability`（既有形态） |
 * | `poll-declared` | 底栏成句原因（算子声明的那句，**与菜单 title 同源**） | `UnsupportedOperation` + `reason` |
 * | `poll-generic` | 无（与改动前逐字一致：只记 info） | 同一条 info 日志 |
 *
 * ## 为什么 `poll-generic` 不弹拒绝
 *
 * `poll` 为假的历史语义包含"现在没什么可做"（撤销栈空、没有选中目标）：那**不是失败**，
 * 每次按键都弹一条拒绝会把底栏变成噪声源，也与 `unchanged` 的既有语义冲突。
 * "要不要可见"由算子自己经 `pollReason` 声明 —— 见 `operatorType#pollReason`。
 */
function settleAvailability(
  ctx: Context,
  op: OperatorType,
  entry: 'exec' | 'invoke',
): boolean {
  const availability = operatorAvailability(ctx, op)
  if (availability.enabled) return true
  if (availability.source === 'capability') {
    refuseOperator(ctx, op, availability.capability ?? '')
    return false
  }
  if (availability.source === 'poll-declared') {
    refuseUnavailableOperator(ctx, op, availability.error)
    return false
  }
  ctx.log.info('Operator', `${entry}: poll failed ${op.label}`, {
    opId: op.id,
    result: 'CANCELLED',
    reason: 'poll',
  })
  return false
}

async function invokeExecFallback(
  ctx: Context,
  op: OperatorType,
  props: OperatorProperties,
): Promise<OpResult> {
  if (op.flagUndo && ctx.hasLoadedDocument()) {
    const snapshot = ctx.documentSnapshot()
    await op.exec!(ctx, props)
    const snapshotAfter = ctx.documentSnapshot()
    pushDocUndo(ctx, snapshot, snapshotAfter, op.label)
  } else {
    await op.exec!(ctx, props)
  }
  return OP_RESULT.FINISHED
}

export function createOperatorRegistry(): OperatorRegistry {
  return new OperatorRegistry()
}

/**
 * Wrap an OperatorRegistry into the shape expected by Context.operators.
 * When `sanitize` is true, `find`/`all` return only the public face (id, label)
 * instead of the full OperatorType — used by the embed shell.
 */
export function wrapOperatorRegistry(
  registry: OperatorRegistry,
  getCtx: () => Context,
  sanitize?: boolean,
) {
  return {
    exec: (id: string, props?: Record<string, unknown>) => registry.exec(getCtx(), id, props),
    invoke: (id: string, props?: Record<string, unknown>, event?: Event, regionId?: string) =>
      registry.invoke(getCtx(), id, props, event as PointerEvent | KeyboardEvent, regionId),
    find: sanitize
      ? (id: string) => { const o = registry.find(id); return o ? { id: o.id, label: o.label } : undefined }
      : (id: string) => registry.find(id),
    all: sanitize
      ? () => registry.all().filter(o => !o.internal).map(o => ({ id: o.id, label: o.label }))
      : () => registry.all().filter(o => !o.internal),
    register: (op: OperatorType) => registry.register(op),
  }
}
