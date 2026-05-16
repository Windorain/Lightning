/**
 * OperatorRegistry — 对标 Blender 的 WM_operatortype_append / WM_operator_name_call。
 *
 * 全局操作符注册表。管理所有操作符实例，提供 exec/invoke 便捷方法。
 */
import type { BContext } from '@/workbench/context/bContext'
import type { OperatorType, OperatorProperties, OpResult } from './operatorType'
import { OP_RESULT } from './operatorType'
import { eventDispatcher } from '@/workbench/eventDispatcher'
import { ModalOperatorWrapper } from './modalOperatorWrapper'
import { logCenter } from '@/workbench/logging/LogCenter'
import type { StateDigest } from '@/workbench/logging/LogCenter'

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

    const snap = logCenter.snapshot(bctx)
    const resolvedProps: OperatorProperties = props ?? {}
    if (op.exec) {
      if (op.flagUndo) {
        const before = bctx.scene.scene.value?.clone() ?? null
        await op.exec(bctx, resolvedProps)
        const after = bctx.scene.scene.value?.clone() ?? null
        bctx.editHistory.push({
          id: 'op_' + Math.random().toString(36).slice(2, 10),
          label: op.label,
          timestamp: Date.now(),
          execute: () => { bctx.scene.scene.value = after; bctx.scene.markDirty() },
          undo: () => { bctx.scene.scene.value = before; bctx.scene.markDirty() },
        })
      } else {
        await op.exec(bctx, resolvedProps)
      }
      logOperatorResult(bctx, id, op.label, 'FINISHED', snap)
    }
  }

  /** 交互式调用操作符。返回操作状态。 */
  invoke(
    bctx: BContext,
    id: string,
    props?: OperatorProperties,
    event?: PointerEvent | KeyboardEvent,
  ): OpResult {
    const op = this.operators.get(id)
    if (!op) { logCenter.warn('Operator', `invoke: op not found ${id}`, { opId: id }); return OP_RESULT.CANCELLED }
    if (op.poll && !op.poll(bctx)) {
      logCenter.info('Operator', `invoke: poll failed ${op.label}`, { opId: id, result: 'CANCELLED', reason: 'poll' })
      return OP_RESULT.CANCELLED
    }

    const snap = logCenter.snapshot(bctx)

    const resolvedProps: OperatorProperties = props ?? {}

    if (op.invoke) {
      // Take before-snapshot for flagUndo operators
      const snapshot = op.flagUndo
        ? bctx.scene.scene.value?.clone() ?? null
        : null

      const result = op.invoke(bctx, resolvedProps, event)

      if (result === OP_RESULT.RUNNING_MODAL) {
        const wrapper = new ModalOperatorWrapper(op, bctx, resolvedProps)
        if (snapshot !== null) {
          wrapper.setUndoSnapshot(snapshot)
        }
        if (event instanceof PointerEvent) {
          eventDispatcher.pushModal(wrapper, event)
        }
        logOperatorResult(bctx, id, op.label, 'RUNNING_MODAL', snap)
      } else if (result === OP_RESULT.FINISHED) {
        if (snapshot !== null) {
          const snapshotAfter = bctx.scene.scene.value?.clone() ?? null
          bctx.editHistory.push({
            id: 'op_' + Math.random().toString(36).slice(2, 10),
            label: op.label,
            timestamp: Date.now(),
            execute: () => { bctx.scene.scene.value = snapshotAfter; bctx.scene.markDirty() },
            undo: () => { bctx.scene.scene.value = snapshot; bctx.scene.markDirty() },
          })
        }
        logOperatorResult(bctx, id, op.label, 'FINISHED', snap)
      }
      return result
    }

    if (op.exec) {
      void invokeExecFallback(bctx, op, resolvedProps)
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
  if (op.flagUndo) {
    const snapshot = bctx.scene.scene.value?.clone() ?? null
    await op.exec!(bctx, props)
    const snapshotAfter = bctx.scene.scene.value?.clone() ?? null
    bctx.editHistory.push({
      id: 'op_' + Math.random().toString(36).slice(2, 10),
      label: op.label,
      timestamp: Date.now(),
      execute: () => { bctx.scene.scene.value = snapshotAfter; bctx.scene.markDirty() },
      undo: () => { bctx.scene.scene.value = snapshot; bctx.scene.markDirty() },
    })
  } else {
    await op.exec!(bctx, props)
  }
  return OP_RESULT.FINISHED
}

export const globalOperators = new OperatorRegistry()
