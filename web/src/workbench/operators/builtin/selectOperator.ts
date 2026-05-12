import type { OperatorType } from '@/workbench/operators/operatorType'
import { OP_RESULT } from '@/workbench/operators/operatorType'

/**
 * SelectOperator — 对标 Blender 的 VIEW3D_OT_select。
 *
 * invoke 即时选择：pointerdown 时 pick voxel → select/clear → FINISHED。
 * 不进入模态，事件可穿透到 OrbitControls 旋转视图。
 * 框选由 B 键（keymap → OPERATOR_SELECT + box-select action）单独触发。
 */
export const SelectOperator: OperatorType = {
  id: 'OPERATOR_SELECT',
  label: '选择',
  description: '点击选择方块',

  poll(bctx) {
    return bctx.scene.scene.value !== null
  },

  invoke(bctx, _props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.CANCELLED

    const picked = bctx.queries.pickVoxel(event)
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
    return OP_RESULT.FINISHED
  },

  renderOverlay(_bctx, _props, _overlayScene) {
    // Selection wireframe rendered by viewport using SelectionContext.items
  },
}
