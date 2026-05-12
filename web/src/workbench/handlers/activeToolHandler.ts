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
import { globalOperators } from '@/workbench/operators/operatorRegistry'
import { OP_RESULT } from '@/workbench/operators/operatorType'
import { eventDispatcher } from '@/workbench/eventDispatcher'
import { ModalOperatorWrapper } from '@/workbench/operators/modalOperatorWrapper'

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

      // MMB/RMB pass through to OrbitControls
      if ((event as PointerEvent).button !== 0) return { break: false }

      const activeId = bctx.toolRegistry.activeTool.value?.id
      if (!activeId) return { break: false }

      const operator = globalOperators.find(activeId)
      if (!operator) return { break: false }

      const pe = event as PointerEvent

      if (event.type === 'pointerdown') {
        // Start interaction via invoke
        if (operator.invoke) {
          const props = operator.initModalState?.() ?? {} as Record<string, unknown>
          const result = operator.invoke(bctx, props, pe)
          if (result === OP_RESULT.RUNNING_MODAL) {
            // Push modal wrapper onto event dispatcher stack with same props
            const wrapper = new ModalOperatorWrapper(operator, bctx, props)
            eventDispatcher.pushModal(wrapper, pe)
            modalActive = true
            return { break: true }
          }
          // FINISHED / CANCELLED: operation completed, let event pass through to OrbitControls
          if (result === OP_RESULT.FINISHED || result === OP_RESULT.CANCELLED) {
            return { break: false }
          }
        }
        // exec-only operator: invoke → direct exec with undo wrapping
        if (operator.exec) {
          globalOperators.exec(bctx, activeId)
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
