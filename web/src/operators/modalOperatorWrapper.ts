/**
 * ModalOperatorWrapper — 适配器，将 OperatorType.modal() 桥接到 eventDispatcher 的 ModalOperation 接口。
 *
 * 当操作符的 invoke() 返回 RUNNING_MODAL 时，
 * OperatorRegistry.invoke() 创建此 wrapper 并推入目标 region 的模态栈。
 * 后续每个事件通过 wrapper 转发到 operator.modal()。
 */
import type { ModalOperation, ModalKeymap } from '@/events/dispatcher'

import type { Context } from '@/runtime/context'
import type { OperatorType, OperatorProperties } from './operatorType'
import { OP_RESULT } from './operatorType'
import { pushDocUndo } from './pushDocUndo'
import { replaceDoc } from '@/context/replaceDoc'
import type { RuntimeDocument } from '@/context/runtimeDocument'

export class ModalOperatorWrapper implements ModalOperation {
  id: string
  private op: OperatorType
  private ctx: Context
  private props: OperatorProperties
  private undoSnapshot: RuntimeDocument | null = null
  private regionId: string

  constructor(op: OperatorType, ctx: Context, props: OperatorProperties, regionId: string) {
    this.op = op
    this.ctx = ctx
    this.props = props
    this.id = op.id
    this.regionId = regionId
  }

  setUndoSnapshot(snapshot: RuntimeDocument | null): void {
    this.undoSnapshot = snapshot
  }

  onEnter(_event: Event): ModalKeymap | null {
    return null
  }

  handleEvent(event: Event): { break: boolean } {
    const result = this.op.modal!(this.ctx, this.props, event)

    if (result === OP_RESULT.FINISHED) {
      if (this.op.flagUndo && this.undoSnapshot !== null) {
        const snap = this.undoSnapshot
        const snapshotAfter = this.ctx.doc.value?.clone() ?? null
        pushDocUndo(this.ctx, snap, snapshotAfter, this.op.label)
        this.undoSnapshot = null
      }
      this.ctx.eventDispatcher.commitModal(this.regionId)
      return { break: true }
    }

    if (result === OP_RESULT.CANCELLED) {
      if (this.undoSnapshot !== null) {
        replaceDoc(this.ctx, this.undoSnapshot)
        this.undoSnapshot = null
      }
      this.op.cancel?.(this.ctx, this.props)
      this.ctx.eventDispatcher.cancelModal(this.regionId)
      return { break: true }
    }

    if (result === OP_RESULT.RUNNING_MODAL) {
      return { break: true }
    }

    return { break: false }
  }

  onExit(cancelled: boolean): void {
    if (cancelled) {
      this.op.cancel?.(this.ctx, this.props)
    }
    this.undoSnapshot = null
  }
}
