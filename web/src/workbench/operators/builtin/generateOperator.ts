import type { OperatorType } from '@/workbench/operators/operatorType'
import { OP_RESULT } from '@/workbench/operators/operatorType'
import type { V2BlockInstance } from '@/render/data/sceneDocumentV2'

export const GenerateOperator: OperatorType = {
  id: 'OPERATOR_GENERATE',
  label: '生成',
  description: '在点击位置放置方块',
  flagUndo: true,

  poll(bctx) {
    return bctx.scene.scene.value !== null && bctx.settings.replaceBrush !== null
  },

  invoke(bctx, _props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.CANCELLED
    const brush = bctx.settings.replaceBrush
    if (!brush) return OP_RESULT.CANCELLED

    const picked = bctx.queries.pickVoxel(event)
    if (!picked) return OP_RESULT.CANCELLED

    const frame = bctx.queries.getCurrentFrame()
    if (!frame) return OP_RESULT.CANCELLED

    const newBlock: V2BlockInstance = {
      pos: { x: picked.pos.x, y: picked.pos.y, z: picked.pos.z },
      block_state_id: brush,
    }
    frame.blocks.push(newBlock)
    bctx.scene.markDirty()
    return OP_RESULT.FINISHED
  },
}
