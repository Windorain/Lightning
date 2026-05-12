import type { OperatorType } from '@/workbench/operators/operatorType'
import { OP_RESULT } from '@/workbench/operators/operatorType'
import { pickVoxel } from '@/workbench/context/sceneQueries'

/**
 * MoveOperator — 对标 Blender 的 TRANSFORM_OT_translate。
 *
 * 移动仅通过拖拽 Gizmo 箭头（GizmoDragModal）完成。
 * 点击方块 → 选中并重定位 Gizmo；点击空白 → 清选并透传旋转。
 */
export const MoveOperator: OperatorType = {
  id: 'OPERATOR_MOVE',
  label: '移动',
  description: '拖拽 Gizmo 箭头移动选中方块',

  poll(bctx) {
    return bctx.scene.scene.value !== null
  },

  invoke(bctx, _props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.CANCELLED

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
    // 不进入模态 — GizmoDragModal 处理移动，其余透传给 OrbitControls 旋转
    return OP_RESULT.FINISHED
  },
}
