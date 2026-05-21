import type { OperatorType } from '@/workbench/operators/operatorType'
import { OP_RESULT } from '@/workbench/operators/operatorType'
import { applyPickSelection } from '@/workbench/selectionContext'

/**
 * SelectOperator — 对标 Blender 的 VIEW3D_OT_select。
 *
 * invoke 即时选择：pointerdown 时 pick voxel → select/clear → FINISHED。
 * 不进入模态，事件继续冒泡（无 OrbitControls 干扰）。
 * 框选由 B 键（keymap → OPERATOR_SELECT + box-select action）单独触发。
 */
export const SelectOperator: OperatorType = {
  id: 'OPERATOR_SELECT',
  label: '选择',
  description: '点击选择方块',

  poll(bctx) {
    return bctx.doc.value !== null
  },

  invoke(bctx, _props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.CANCELLED

    applyPickSelection({ pickVoxel: (e) => bctx.queries.pickVoxel(e), selection: bctx.selection }, event)
    return OP_RESULT.FINISHED
  },

  renderOverlay(_bctx, _props, _overlayGroup) {
    // Selection wireframe rendered by viewport using SelectionContext.items
  },
}

export const SelectByTypeOperator: OperatorType = {
  id: 'OPERATOR_SELECT_BY_TYPE',
  label: '按类型选择',
  description: '选中当前帧所有相同类型的方块',

  poll(bctx) {
    return bctx.doc.value !== null
  },

  exec(bctx, props) {
    const blockStateId = (props?.blockStateId as string) ?? ''
    if (!blockStateId) return
    const blocks = bctx.queries.getFrameBlocks()
    bctx.selection.selectByType(blockStateId, blocks)
  },
}
