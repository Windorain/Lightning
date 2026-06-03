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
    if (op.poll && !op.poll(ctx)) {
      ctx.log.info('Operator', `exec: poll failed ${op.label}`, { opId: id, result: 'CANCELLED', reason: 'poll' })
      return
    }

    const doc = ctx.getDoc().value
    const snap = doc ? ctx.log.snapshot(ctx) : undefined
    const resolvedProps: OperatorProperties = props ?? {}
    if (op.exec) {
      if (op.flagUndo && ctx.getDoc().value !== null) {
        const before = ctx.getDoc().value?.clone() ?? null
        await op.exec(ctx, resolvedProps)
        const after = ctx.getDoc().value?.clone() ?? null
        pushDocUndo(ctx, before, after, op.label, op.undoReplaceDocOptions)
      } else {
        await op.exec(ctx, resolvedProps)
      }
      logOperatorResult(ctx, id, op.label, 'FINISHED', snap)
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
    if (op.poll && !op.poll(ctx)) {
      ctx.log.info('Operator', `invoke: poll failed ${op.label}`, { opId: id, result: 'CANCELLED', reason: 'poll' })
      return OP_RESULT.CANCELLED
    }

    const doc = ctx.getDoc().value
    const snap = doc ? ctx.log.snapshot(ctx) : undefined

    const resolvedProps: OperatorProperties = props ?? {}
    if (regionId) resolvedProps._regionId = regionId

    if (op.invoke) {
      const snapshot = op.flagUndo && ctx.getDoc().value !== null
        ? ctx.getDoc().value?.clone() ?? null
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
          const snapshotAfter = ctx.getDoc().value?.clone() ?? null
          pushDocUndo(ctx, snapshot, snapshotAfter, op.label, op.undoReplaceDocOptions)
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

async function invokeExecFallback(
  ctx: Context,
  op: OperatorType,
  props: OperatorProperties,
): Promise<OpResult> {
  if (op.flagUndo && ctx.getDoc().value !== null) {
    const snapshot = ctx.getDoc().value?.clone() ?? null
    await op.exec!(ctx, props)
    const snapshotAfter = ctx.getDoc().value?.clone() ?? null
    pushDocUndo(ctx, snapshot, snapshotAfter, op.label, op.undoReplaceDocOptions)
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
      ? () => registry.all().map(o => ({ id: o.id, label: o.label }))
      : () => registry.all(),
    register: (op: OperatorType) => registry.register(op),
  }
}
