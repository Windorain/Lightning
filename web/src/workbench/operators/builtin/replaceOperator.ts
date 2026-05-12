import type { OperatorType } from '@/workbench/operators/operatorType'
import { OP_RESULT } from '@/workbench/operators/operatorType'
import type { V2PlainSceneDocument } from '@/render/data/sceneDocumentV2'
import { getReplaceBrush } from './brushState'
import { pickVoxel } from '@/workbench/context/sceneQueries'

export const ReplaceOperator: OperatorType = {
  id: 'OPERATOR_REPLACE',
  label: '替换',
  description: '点击方块替换为笔刷类型',
  flagUndo: true,

  poll(bctx) {
    return bctx.scene.scene.value !== null && getReplaceBrush() !== null
  },

  invoke(bctx, _props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.CANCELLED
    const brush = getReplaceBrush()
    if (!brush) return OP_RESULT.CANCELLED

    const picked = pickVoxel(bctx, event)
    if (!picked) return OP_RESULT.CANCELLED

    const doc = bctx.scene.scene.value as V2PlainSceneDocument | null
    if (!doc?.frames?.length) return OP_RESULT.CANCELLED
    const idx = bctx.selection.frameIndex.value ?? 0
    const frame = doc.frames[idx]
    if (!frame) return OP_RESULT.CANCELLED

    const block = frame.blocks.find(
      b => b.pos.x === picked.pos.x && b.pos.y === picked.pos.y && b.pos.z === picked.pos.z,
    )
    if (!block) return OP_RESULT.CANCELLED
    block.block_state_id = brush
    bctx.scene.markDirty()
    return OP_RESULT.FINISHED
  },
}
