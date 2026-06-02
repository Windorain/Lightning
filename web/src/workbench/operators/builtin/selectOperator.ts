import type { OperatorType } from '@/workbench/operators/operatorType'
import { OP_RESULT } from '@/workbench/operators/operatorType'
import { applyPickSelectionWithCycle, type PickHandlerV2 } from '@/workbench/selection'

/**
 * SelectOperator — 对标 Blender 的 VIEW3D_OT_select。
 *
 * invoke 即时选择：pointerdown 时 pick all → 轮换/选择 → FINISHED。
 * 不进入模态，事件继续冒泡（无 OrbitControls 干扰）。
 * 框选由 B 键（keymap → OPERATOR_SELECT + box-select action）单独触发。
 */
export const SelectOperator: OperatorType = {
  id: 'OPERATOR_SELECT',
  label: '选择',
  description: '点击选择方块/注解，重复点击轮换',

  poll(bctx) {
    return bctx.doc.value !== null
  },

  invoke(bctx, _props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.CANCELLED

    const handler: PickHandlerV2 = {
      pickAll: (e) => bctx.queries!.pickAll(e),
      selection: {
        selectEntity: (entity) => bctx.selection.selectEntity(entity),
        add: (voxels) => bctx.selection.add(voxels),
        remove: (voxels) => bctx.selection.remove(voxels),
        clear: () => bctx.selection.clear(),
      },
      cycleState: bctx.selection.cycleState,
      setCycleState: (s) => bctx.selection.setCycleState(s),
      resetCycle: () => bctx.selection.resetCycle(),
    }

    applyPickSelectionWithCycle(handler, event)
    return OP_RESULT.FINISHED
  },

  renderOverlay(_bctx, _props, _overlayGroup) {
    // Selection highlight rendered by SelectionHighlightProvider
  },
}

/**
 * SelectAllOperator — 全选/取消全选。
 *
 * exec: 获取当前帧所有非空方块，通过 selection.invert 实现 toggle：
 * 如果所有方块都已选中则取消全选，否则全选。
 * flagUndo: false（全选不视为可撤销的编辑操作）。
 * 支持 keymap 绑定 'OPERATOR_SELECT_ALL'（A 键）。
 */
export const SelectAllOperator: OperatorType = {
  id: 'OPERATOR_SELECT_ALL',
  label: '全选',
  description: '切换选择当前帧所有方块',
  flagUndo: false,

  poll(bctx) {
    return bctx.doc.value !== null && bctx.selection !== undefined
  },

  exec(bctx, _props) {
    const blocks = bctx.queries!.getFrameBlocks()
    if (blocks.length === 0) return
    bctx.selection.invert(blocks)
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
    const blocks = bctx.queries!.getFrameBlocks()
    bctx.selection.selectByType(blockStateId, blocks)
  },
}
