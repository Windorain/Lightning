import type { OperatorType } from '@/workbench/operators/operatorType'
import { OP_RESULT } from '@/workbench/operators/operatorType'

export const FillOperator: OperatorType = {
  id: 'OPERATOR_FILL',
  label: '填充',
  description: '点击方块填充为当前笔刷类型',
  flagUndo: true,

  poll(bctx) {
    return bctx.scene.scene.value !== null && bctx.settings.fillBrush !== null
  },

  invoke(bctx, _props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.CANCELLED
    const brush = bctx.settings.fillBrush
    if (!brush) return OP_RESULT.CANCELLED

    const picked = bctx.queries.pickVoxel(event)
    if (!picked) return OP_RESULT.CANCELLED

    const frame = bctx.queries.getCurrentFrame()
    if (!frame) return OP_RESULT.CANCELLED

    const block = frame.blocks.find(
      b => b.pos.x === picked.pos.x && b.pos.y === picked.pos.y && b.pos.z === picked.pos.z,
    )
    if (block) {
      block.block_state_id = brush
    }
    bctx.scene.markDirty()
    return OP_RESULT.FINISHED
  },
}
