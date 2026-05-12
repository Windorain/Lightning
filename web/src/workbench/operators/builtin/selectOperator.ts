import type { OperatorType } from '@/workbench/operators/operatorType'
import { OP_RESULT } from '@/workbench/operators/operatorType'
import { pickVoxel } from '@/workbench/context/sceneQueries'

interface SelectState {
  _selectStart?: { x: number; y: number }
  _boxSelecting?: boolean
}

export const SelectOperator: OperatorType = {
  id: 'OPERATOR_SELECT',
  label: '选择',
  description: '点击选择方块，拖拽框选',

  poll(bctx) {
    return bctx.scene.scene.value !== null
  },

  invoke(_bctx, props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.CANCELLED
    const state = props as SelectState
    state._selectStart = { x: event.clientX, y: event.clientY }
    state._boxSelecting = event.shiftKey
    return OP_RESULT.RUNNING_MODAL
  },

  modal(bctx, props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.PASS_THROUGH
    const state = props as SelectState

    if (event.type === 'pointermove') {
      return OP_RESULT.RUNNING_MODAL
    }

    if (event.type === 'pointerup') {
      const start = state._selectStart
      if (!start) return OP_RESULT.FINISHED

      const dx = event.clientX - start.x
      const dy = event.clientY - start.y
      const dist = Math.sqrt(dx * dx + dy * dy)

      if (dist < 3) {
        // Single click
        const picked = pickVoxel(bctx, event)
        if (picked) {
          if (event.ctrlKey || event.metaKey) {
            bctx.selection.add([picked])
          } else {
            bctx.selection.select(picked)
          }
        } else {
          if (!event.ctrlKey && !event.metaKey) {
            bctx.selection.clear()
          }
        }
      }
      state._selectStart = undefined
      state._boxSelecting = false
      return OP_RESULT.FINISHED
    }

    return OP_RESULT.PASS_THROUGH
  },

  renderOverlay(_bctx, _props, _overlayScene) {
    // Selection wireframe rendered by viewport using SelectionContext.items
  },
}
