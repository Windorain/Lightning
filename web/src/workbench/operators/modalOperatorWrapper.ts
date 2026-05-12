/**
 * ModalOperatorWrapper — 适配器，将 OperatorType.modal() 桥接到 eventDispatcher 的 ModalOperation 接口。
 *
 * 当操作符的 invoke() 返回 RUNNING_MODAL 时，
 * OperatorRegistry.invoke() 创建此 wrapper 并推入 eventDispatcher 模态栈。
 * 后续每个事件通过 wrapper 转发到 operator.modal()。
 */
import type { ModalOperation, ModalKeymap } from '@/workbench/eventDispatcher'
import type { OperatorType, OperatorProperties, OpResult } from './operatorType'
import type { BContext } from '@/workbench/context/bContext'
import { OP_RESULT } from './operatorType'
import { eventDispatcher } from '@/workbench/eventDispatcher'

export class ModalOperatorWrapper implements ModalOperation {
  id: string
  private op: OperatorType
  private bctx: BContext
  private props: OperatorProperties

  constructor(op: OperatorType, bctx: BContext, props: OperatorProperties) {
    this.id = op.id
    this.op = op
    this.bctx = bctx
    this.props = props
  }

  onEnter(_event: PointerEvent): ModalKeymap | null {
    // 操作符的模态键盘映射由 operatorType 的 properties 描述
    return null
  }

  handleEvent(event: Event): { break: boolean } {
    if (!this.op.modal) return { break: false }

    const result: OpResult = this.op.modal(this.bctx, this.props, event)

    switch (result) {
      case OP_RESULT.FINISHED: {
        // 模态完成：提交操作
        if (this.op.flagUndo) {
          // 快照已在 invoke 时保存，此处直接 commit
        }
        eventDispatcher.commitModal()
        return { break: true }
      }
      case OP_RESULT.CANCELLED: {
        // 模态取消
        this.op.cancel?.(this.bctx, this.props)
        eventDispatcher.cancelModal()
        return { break: true }
      }
      case OP_RESULT.RUNNING_MODAL: {
        return { break: true }
      }
      case OP_RESULT.PASS_THROUGH: {
        return { break: false }
      }
      default:
        return { break: true }
    }
  }

  onExit(cancelled: boolean): void {
    if (cancelled) {
      this.op.cancel?.(this.bctx, this.props)
    }
  }
}
