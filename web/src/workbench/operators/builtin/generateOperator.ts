import type { OperatorType } from '@/workbench/operators/operatorType'
import { OP_RESULT } from '@/workbench/operators/operatorType'
import { pickVoxel } from '@/workbench/context/sceneQueries'
import type { V2PlainSceneDocument, V2BlockInstance } from '@/render/data/sceneDocumentV2'
import { getReplaceBrush } from './brushState'

export const GenerateOperator: OperatorType = {
  id: 'OPERATOR_GENERATE',
  label: '生成',
  description: '在点击位置放置方块',
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

    const newBlock: V2BlockInstance = {
      pos: { x: picked.pos.x, y: picked.pos.y, z: picked.pos.z },
      block_state_id: brush,
    }
    frame.blocks.push(newBlock)
    bctx.scene.markDirty()
    return OP_RESULT.FINISHED
  },
}
