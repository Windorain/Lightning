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
  exec(bctx: BContext, id: string, props?: OperatorProperties): void {
    const op = this.operators.get(id)
    if (!op) { logCenter.warn('OperatorRegistry', `exec: 未找到 ${id}`); return }
    if (op.poll && !op.poll(bctx)) { logCenter.debug('OperatorRegistry', `exec: poll 未通过 ${id}`); return }

    logCenter.operator('OperatorRegistry', `${op.label}`, { opId: id, action: 'exec' })

    const resolvedProps: OperatorProperties = props ?? {}
    if (op.exec) {
      if (op.flagUndo) {
        // snapshot before + auto push undo after exec
        const snapshot = JSON.parse(JSON.stringify(bctx.scene.scene.value))
        op.exec(bctx, resolvedProps)
        const snapshotAfter = JSON.parse(JSON.stringify(bctx.scene.scene.value))
        bctx.editHistory.push({
          id: 'op_' + Math.random().toString(36).slice(2, 10),
          label: op.label,
          timestamp: Date.now(),
          execute: () => {
            bctx.scene.scene.value = snapshotAfter
            bctx.scene.markDirty()
          },
          undo: () => {
            bctx.scene.scene.value = snapshot
            bctx.scene.markDirty()
          },
        })
      } else {
        op.exec(bctx, resolvedProps)
      }
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
    if (!op) { logCenter.warn('OperatorRegistry', `invoke: 未找到 ${id}`); return OP_RESULT.CANCELLED }
    if (op.poll && !op.poll(bctx)) { logCenter.debug('OperatorRegistry', `invoke: poll 未通过 ${id}`); return OP_RESULT.CANCELLED }

    logCenter.operator('OperatorRegistry', `${op.label}`, { opId: id, action: 'invoke' })

    const resolvedProps: OperatorProperties = props ?? {}

    if (op.invoke) {
      const result = op.invoke(bctx, resolvedProps, event)
      if (result === OP_RESULT.RUNNING_MODAL) {
        const wrapper = new ModalOperatorWrapper(op, bctx, resolvedProps)
        if (event instanceof PointerEvent) {
          eventDispatcher.pushModal(wrapper, event)
        }
      } else if (result === OP_RESULT.FINISHED && op.flagUndo && op.exec) {
        // invoke 返回 FINISHED 但无 modal → 作为一次性操作 undo
        const snapshot = JSON.parse(JSON.stringify(bctx.scene.scene.value))
        op.exec(bctx, resolvedProps)
        const snapshotAfter = JSON.parse(JSON.stringify(bctx.scene.scene.value))
        bctx.editHistory.push({
          id: 'op_' + Math.random().toString(36).slice(2, 10),
          label: op.label,
          timestamp: Date.now(),
          execute: () => { bctx.scene.scene.value = snapshotAfter; bctx.scene.markDirty() },
          undo: () => { bctx.scene.scene.value = snapshot; bctx.scene.markDirty() },
        })
      }
      return result
    }

    if (op.exec) {
      return invokeExecFallback(bctx, op, resolvedProps)
    }

    return OP_RESULT.CANCELLED
  }
}

function invokeExecFallback(
  bctx: BContext,
  op: OperatorType,
  props: OperatorProperties,
): OpResult {
  if (op.flagUndo) {
    const snapshot = JSON.parse(JSON.stringify(bctx.scene.scene.value))
    op.exec!(bctx, props)
    const snapshotAfter = JSON.parse(JSON.stringify(bctx.scene.scene.value))
    bctx.editHistory.push({
      id: 'op_' + Math.random().toString(36).slice(2, 10),
      label: op.label,
      timestamp: Date.now(),
      execute: () => { bctx.scene.scene.value = snapshotAfter; bctx.scene.markDirty() },
      undo: () => { bctx.scene.scene.value = snapshot; bctx.scene.markDirty() },
    })
  } else {
    op.exec!(bctx, props)
  }
  return OP_RESULT.FINISHED
}

export const globalOperators = new OperatorRegistry()
