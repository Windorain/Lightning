/**
 * OperatorRegistry — 对标 Blender 的 WM_operatortype_append / WM_operator_name_call。
 *
 * 全局操作符注册表。管理所有操作符实例，提供 exec/invoke 便捷方法。
 */
import type { BContext } from '@/context/bContext'
import type { OperatorType, OperatorProperties, OpResult } from './operatorType'
import { OP_RESULT } from './operatorType'
import { pushDocUndo } from './pushDocUndo'

import { ModalOperatorWrapper } from './modalOperatorWrapper'
import { logCenter } from '@/logging/LogCenter'
import type { StateDigest } from '@/logging/LogCenter'

function logOperatorResult(
  bctx: BContext, opId: string, label: string, result: string,
  snapBefore?: StateDigest,
) {
  const detail: Record<string, unknown> = { opId, result }
  if (snapBefore) {
    const d = logCenter.diff(snapBefore, bctx)
    if (d.blocksAdded.length || d.blocksRemoved.length || d.blocksMoved.length || d.selectionChanged) {
      detail.changes = d
    }
  }
  logCenter.operator('Operator', `${label} → ${result}`, detail)
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
  async exec(bctx: BContext, id: string, props?: OperatorProperties): Promise<void> {
    const op = this.operators.get(id)
    if (!op) { logCenter.warn('Operator', `exec: op not found ${id}`, { opId: id }); return }
    if (op.poll && !op.poll(bctx)) {
      logCenter.info('Operator', `exec: poll failed ${op.label}`, { opId: id, result: 'CANCELLED', reason: 'poll' })
      return
    }

    const doc = bctx.doc.value
    const snap = doc ? logCenter.snapshot(bctx) : undefined
    const resolvedProps: OperatorProperties = props ?? {}
    if (op.exec) {
      if (op.flagUndo && bctx.doc) {
        const before = bctx.doc.value?.clone() ?? null
        await op.exec(bctx, resolvedProps)
        const after = bctx.doc.value?.clone() ?? null
        pushDocUndo(bctx, before, after, op.label)
      } else {
        await op.exec(bctx, resolvedProps)
      }
      logOperatorResult(bctx, id, op.label, 'FINISHED', snap)
    }
  }

  /** 交互式调用操作符。返回操作状态。regionId 指定目标区域的模态栈。 */
  invoke(
    bctx: BContext,
    id: string,
    props?: OperatorProperties,
    event?: PointerEvent | KeyboardEvent,
    regionId?: string,
  ): OpResult {
    const op = this.operators.get(id)
    if (!op) { logCenter.warn('Operator', `invoke: op not found ${id}`, { opId: id }); return OP_RESULT.CANCELLED }
    if (op.poll && !op.poll(bctx)) {
      logCenter.info('Operator', `invoke: poll failed ${op.label}`, { opId: id, result: 'CANCELLED', reason: 'poll' })
      return OP_RESULT.CANCELLED
    }

    // embed bctx has no queries; use duck-check to avoid getter-throw
    const doc = bctx.doc.value
    const snap = doc ? logCenter.snapshot(bctx) : undefined

    const resolvedProps: OperatorProperties = props ?? {}
    if (regionId) resolvedProps._regionId = regionId

    if (op.invoke) {
      const snapshot = op.flagUndo && bctx.doc
        ? bctx.doc.value?.clone() ?? null
        : null

      const result = op.invoke(bctx, resolvedProps, event)

      if (result === OP_RESULT.RUNNING_MODAL) {
        const targetRegion = regionId ?? bctx.eventDispatcher.getCurrentRegionId() ?? 'r-viewport'
        const wrapper = new ModalOperatorWrapper(op, bctx, resolvedProps, targetRegion)
        if (snapshot !== null) {
          wrapper.setUndoSnapshot(snapshot)
        }
        if (event) bctx.eventDispatcher.pushModal(targetRegion, wrapper, event)
        logOperatorResult(bctx, id, op.label, 'RUNNING_MODAL', snap)
      } else if (result === OP_RESULT.FINISHED) {
        if (snapshot !== null) {
          const snapshotAfter = bctx.doc.value?.clone() ?? null
          pushDocUndo(bctx, snapshot, snapshotAfter, op.label)
        }
        logOperatorResult(bctx, id, op.label, 'FINISHED', snap)
      }
      return result
    }

    if (op.exec) {
      invokeExecFallback(bctx, op, resolvedProps).catch(err => {
        logCenter.error('Operator', `invoke exec fallback failed: ${op.label}`, { opId: op.id, error: String(err) })
      })
      return OP_RESULT.FINISHED
    }

    return OP_RESULT.CANCELLED
  }
}

async function invokeExecFallback(
  bctx: BContext,
  op: OperatorType,
  props: OperatorProperties,
): Promise<OpResult> {
  if (op.flagUndo && bctx.doc) {
    const snapshot = bctx.doc.value?.clone() ?? null
    await op.exec!(bctx, props)
    const snapshotAfter = bctx.doc.value?.clone() ?? null
    pushDocUndo(bctx, snapshot, snapshotAfter, op.label)
  } else {
    await op.exec!(bctx, props)
  }
  return OP_RESULT.FINISHED
}

export function createOperatorRegistry(): OperatorRegistry {
  return new OperatorRegistry()
}

export const globalOperators = createOperatorRegistry()

/**
 * Wrap an OperatorRegistry into the shape expected by BContext.operators.
 * When `sanitize` is true, `find`/`all` return only the public face (id, label)
 * instead of the full OperatorType — used by the embed shell.
 */
export function wrapOperatorRegistry(
  registry: OperatorRegistry,
  getCtx: () => BContext,
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
