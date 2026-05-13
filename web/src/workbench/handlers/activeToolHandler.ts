/**
 * Active tool handler — 对标 Blender 的 OPERATOR handler。
 *
 * 将 pointer 事件转发给当前活跃操作符：
 * - pointerdown → operator.invoke() → 若返回 RUNNING_MODAL，进入模态循环
 * - 模态期间 → operator.modal() 处理 pointermove/pointerup
 *
 * MMB/RMB 透传给 OrbitControls。
 */
import type { TypedEventHandler } from '@/workbench/events/eventTypes'
import { HANDLER_TYPE } from '@/workbench/events/eventTypes'
import type { BContext } from '@/workbench/context/bContext'
import { OP_RESULT } from '@/workbench/operators/operatorType'
export function createActiveToolHandler(
  getBctx: () => BContext | null,
): TypedEventHandler {
  /** Track which operator is currently in modal */
  let modalActive = false

  return {
    type: HANDLER_TYPE.OPERATOR,
    handle(event: Event): { break: boolean } {
      const bctx = getBctx()
      if (!bctx) return { break: false }

      const pe = event as PointerEvent

      // Scroll wheel: zoom
      if (event.type === 'wheel') {
        const bctxNow = getBctx()
        if (bctxNow && bctxNow.camera) {
          bctxNow.operators.invoke('OPERATOR_VIEW_ZOOM', undefined, event as any)
        }
        return { break: false }
      }

      // MMB: viewport navigation operators
      if (pe.button === 1) {
        if (event.type === 'pointerdown') {
          if (pe.ctrlKey || pe.metaKey) {
            bctx.operators.invoke('OPERATOR_VIEW_ZOOM', undefined, pe)
          } else if (pe.shiftKey) {
            bctx.operators.invoke('OPERATOR_VIEW_PAN', undefined, pe)
          } else {
            bctx.operators.invoke('OPERATOR_VIEW_ROTATE', undefined, pe)
          }
          return { break: false }
        }
        return { break: false }
      }

      // RMB pass through
      if (pe.button !== 0) return { break: false }

      const activeId = bctx.toolRegistry.activeTool.value?.id
      if (!activeId) return { break: false }

      const operator = bctx.operators.find(activeId)
      if (!operator) return { break: false }

      if (event.type === 'pointerdown') {
        const result = bctx.operators.invoke(activeId, undefined, pe)
        if (result === OP_RESULT.RUNNING_MODAL) {
          modalActive = true
          return { break: true }
        }
        if (result === OP_RESULT.FINISHED || result === OP_RESULT.CANCELLED) {
          return { break: false }
        }
      }

      // During modal, events go through ModalOperatorWrapper on the stack
      if (modalActive && (event.type === 'pointermove' || event.type === 'pointerup')) {
        // Modal is handled by the event dispatcher's modal stack, not here
        if (event.type === 'pointerup') {
          modalActive = false
        }
        return { break: false }
      }

      return { break: false }
    },
  }
}
