/**
 * ModalOperatorWrapper — 适配器，将 OperatorType.modal() 桥接到 eventDispatcher 的 ModalOperation 接口。
 *
 * 当操作符的 invoke() 返回 RUNNING_MODAL 时，
 * OperatorRegistry.invoke() 创建此 wrapper 并推入目标 region 的模态栈。
 * 后续每个事件通过 wrapper 转发到 operator.modal()。
 */
import type { ModalOperation, ModalKeymap } from '@/workbench/eventDispatcher'

import type { BContext } from '@/workbench/context/bContext'
import type { OperatorType, OperatorProperties } from './operatorType'
import { OP_RESULT } from './operatorType'
import type { RuntimeDocument } from '@/workbench/context/runtimeDocument'

export class ModalOperatorWrapper implements ModalOperation {
  id: string
  private op: OperatorType
  private bctx: BContext
  private props: OperatorProperties
  private undoSnapshot: RuntimeDocument | null = null
  private regionId: string

  constructor(op: OperatorType, bctx: BContext, props: OperatorProperties, regionId: string) {
    this.op = op
    this.bctx = bctx
    this.props = props
    this.id = op.id
    this.regionId = regionId
  }

  setUndoSnapshot(snapshot: RuntimeDocument | null): void {
    this.undoSnapshot = snapshot
  }

  onEnter(_event: PointerEvent): ModalKeymap | null {
    return null
  }

  handleEvent(event: Event): { break: boolean } {
    const result = this.op.modal!(this.bctx, this.props, event)

    if (result === OP_RESULT.FINISHED) {
      if (this.op.flagUndo && this.undoSnapshot !== null) {
        const snap = this.undoSnapshot
        const snapshotAfter = this.bctx.doc.value?.clone() ?? null
        this.bctx.editHistory.push({
          id: 'op_' + Math.random().toString(36).slice(2, 10),
          label: this.op.label,
          timestamp: Date.now(),
          execute: () => { this.bctx.doc.value = snapshotAfter; this.bctx.markStructureDirty() },
          undo: () => { this.bctx.doc.value = snap; this.bctx.markStructureDirty() },
        })
        this.undoSnapshot = null
      }
      this.bctx.eventDispatcher.commitModal(this.regionId)
      return { break: true }
    }

    if (result === OP_RESULT.CANCELLED) {
      this.op.cancel?.(this.bctx, this.props)
      this.bctx.eventDispatcher.cancelModal(this.regionId)
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
