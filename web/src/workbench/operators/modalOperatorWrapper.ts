/**
 * ModalOperatorWrapper — 适配器，将 OperatorType.modal() 桥接到 eventDispatcher 的 ModalOperation 接口。
 *
 * 当操作符的 invoke() 返回 RUNNING_MODAL 时，
 * OperatorRegistry.invoke() 创建此 wrapper 并推入 eventDispatcher 模态栈。
 * 后续每个事件通过 wrapper 转发到 operator.modal()。
 */
import type { ModalOperation, ModalKeymap } from '@/workbench/eventDispatcher'
import { eventDispatcher } from '@/workbench/eventDispatcher'
import type { BContext } from '@/workbench/context/bContext'
import type { OperatorType, OperatorProperties } from './operatorType'
import { OP_RESULT } from './operatorType'

export class ModalOperatorWrapper implements ModalOperation {
  id: string
  private op: OperatorType
  private bctx: BContext
  private props: OperatorProperties
  private undoSnapshot: unknown = null

  constructor(op: OperatorType, bctx: BContext, props: OperatorProperties) {
    this.op = op
    this.bctx = bctx
    this.props = props
    this.id = op.id
  }

  setUndoSnapshot(snapshot: unknown): void {
    this.undoSnapshot = snapshot
  }

  onEnter(_event: PointerEvent): ModalKeymap | null {
    return null
  }

  handleEvent(event: Event): { break: boolean } {
    const result = this.op.modal!(this.bctx, this.props, event)

    if (result === OP_RESULT.FINISHED) {
      if (this.op.flagUndo && this.undoSnapshot !== null) {
        const snapshotAfter = JSON.parse(JSON.stringify(this.bctx.scene.scene.value))
        this.bctx.editHistory.push({
          id: 'op_' + Math.random().toString(36).slice(2, 10),
          label: this.op.label,
          timestamp: Date.now(),
          execute: () => { this.bctx.scene.scene.value = snapshotAfter; this.bctx.scene.markDirty() },
          undo: () => { this.bctx.scene.scene.value = this.undoSnapshot as any; this.bctx.scene.markDirty() },
        })
        this.undoSnapshot = null
      }
      eventDispatcher.commitModal()
      return { break: true }
    }

    if (result === OP_RESULT.CANCELLED) {
      this.op.cancel?.(this.bctx, this.props)
      eventDispatcher.cancelModal()
      return { break: true }
    }

    if (result === OP_RESULT.RUNNING_MODAL) {
      return { break: true }
    }

    return { break: false }
  }

  onExit(cancelled: boolean): void {
    if (cancelled) {
      this.op.cancel?.(this.bctx, this.props)
    }
    this.undoSnapshot = null
  }
}
