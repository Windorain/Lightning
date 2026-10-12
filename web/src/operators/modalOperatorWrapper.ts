/**
 * ModalOperatorWrapper — 适配器，将 OperatorType.modal() 桥接到 wm.events 的 ModalOperation 接口。
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
import type { DocumentSnapshot } from '@/runtime/documentSnapshot'

export class ModalOperatorWrapper implements ModalOperation {
  id: string
  private op: OperatorType
  private ctx: Context
  private props: OperatorProperties
  /**
   * 模态进入时的撤销快照（#301 P10f D3：**不透明令牌**，不是旧文档句柄）。
   *
   * 见 `runtime/documentSnapshot` 与 R-WK-09 裁决 3："撤销到无文档"的能力存续，
   * 但不得再把可读的旧文档交出去。
   */
  private undoSnapshot: DocumentSnapshot | null = null
  private regionId: string

  constructor(op: OperatorType, ctx: Context, props: OperatorProperties, regionId: string) {
    this.op = op
    this.ctx = ctx
    this.props = props
    this.id = op.id
    this.regionId = regionId
  }

  setUndoSnapshot(snapshot: DocumentSnapshot | null): void {
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
        // #301 P10f D3（R8）：撤销快照走**不透明令牌**（R-WK-09 裁决 3 的受控双轨）。
        const snapshotAfter = this.ctx.documentSnapshot()
        pushDocUndo(this.ctx, snap, snapshotAfter, this.op.label)
        this.undoSnapshot = null
      }
      this.ctx.wm.events.commitModal(this.regionId)
      return { break: true }
    }

    if (result === OP_RESULT.CANCELLED) {
      if (this.undoSnapshot !== null) {
        // #301 A′：经唯一写入口（取消 ⇒ 回放到进入模态前的快照，非 null ⇒ 已装载）。
        // #301 D3：快照是**不透明令牌** ⇒ 只能经 `restoreDocumentSnapshot` 交回。
        this.ctx.restoreDocumentSnapshot(this.undoSnapshot)
        this.undoSnapshot = null
      }
      this.op.cancel?.(this.ctx, this.props)
      this.ctx.wm.events.cancelModal(this.regionId)
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
