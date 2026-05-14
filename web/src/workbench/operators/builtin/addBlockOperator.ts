import type { OperatorType } from '@/workbench/operators/operatorType'
import { OP_RESULT } from '@/workbench/operators/operatorType'

export const AddBlockOperator: OperatorType = {
  id: 'OPERATOR_ADD_BLOCK',
  label: '添加方块',
  description: '在面上放置方块，或在空地上放置方块',
  flagUndo: true,

  poll(bctx) {
    return bctx.scene.scene.value !== null && bctx.settings.replaceBrush !== null
  },

  invoke(bctx, _props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.CANCELLED
    const brush = bctx.settings.replaceBrush
    if (!brush) return OP_RESULT.CANCELLED

    // Try face-adjacent placement first
    const surface = bctx.queries.pickSurface(event)
    if (surface) {
      const frame = bctx.queries.getCurrentFrame()
      if (!frame) return OP_RESULT.CANCELLED

      const newBlock = {
        pos: { x: surface.pos.x, y: surface.pos.y, z: surface.pos.z },
        block_state_id: brush,
      }
      ;(frame as any).blocks.push(newBlock)
      bctx.scene.markDirty()
      return OP_RESULT.FINISHED
    }

    // Fallback: ground plane placement
    const ground = bctx.queries.pickGround(event)
    if (ground) {
      const frame = bctx.queries.getCurrentFrame()
      if (!frame) return OP_RESULT.CANCELLED

      const newBlock = {
        pos: { x: ground.x, y: ground.y, z: ground.z },
        block_state_id: brush,
      }
      ;(frame as any).blocks.push(newBlock)
      bctx.scene.markDirty()
      return OP_RESULT.FINISHED
    }

    return OP_RESULT.CANCELLED
  },
}
