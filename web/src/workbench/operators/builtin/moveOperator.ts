import type { OperatorType } from '@/workbench/operators/operatorType'
import { OP_RESULT } from '@/workbench/operators/operatorType'
import type { V2PlainSceneDocument } from '@/render/data/sceneDocumentV2'

interface MoveState {
  _moveStart?: { x: number; y: number } | null
  _moveDelta?: { x: number; y: number; z: number } | null
  _moveInitialPositions?: Array<{ x: number; y: number; z: number }> | null
}

function findBlock(blocks: Array<{ pos: { x: number; y: number; z: number }; block_state_id: string }>, pos: { x: number; y: number; z: number }) {
  return blocks.find(b => b.pos.x === pos.x && b.pos.y === pos.y && b.pos.z === pos.z)
}

export const MoveOperator: OperatorType = {
  id: 'OPERATOR_MOVE',
  label: '移动',
  description: '拖拽移动选中方块',
  flagUndo: true,

  poll(bctx) {
    return bctx.scene.scene.value !== null && bctx.selection.items.value.size > 0
  },

  invoke(bctx, props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.CANCELLED
    const state = props as MoveState
    state._moveStart = { x: event.clientX, y: event.clientY }
    state._moveInitialPositions = [...bctx.selection.items.value].map(b => ({ ...b.pos }))
    return OP_RESULT.RUNNING_MODAL
  },

  modal(bctx, props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.PASS_THROUGH
    const state = props as MoveState

    if (event.type === 'pointermove') {
      if (!state._moveStart) return OP_RESULT.RUNNING_MODAL
      const dx = Math.round((event.clientX - state._moveStart.x) / 20)
      const dy = Math.round((event.clientY - state._moveStart.y) / 20)
      state._moveDelta = { x: dx, y: 0, z: -dy }
      return OP_RESULT.RUNNING_MODAL
    }

    if (event.type === 'pointerup') {
      if (!state._moveDelta || !state._moveInitialPositions) return OP_RESULT.FINISHED
      const { x, y, z } = state._moveDelta
      if (x === 0 && y === 0 && z === 0) return OP_RESULT.FINISHED

      const doc = bctx.scene.scene.value as V2PlainSceneDocument | null
      if (!doc?.frames?.length) return OP_RESULT.FINISHED
      const idx = bctx.selection.frameIndex.value ?? 0
      const frame = doc.frames[idx]
      if (!frame) return OP_RESULT.FINISHED

      for (const initPos of state._moveInitialPositions) {
        const block = findBlock(frame.blocks as any[], initPos)
        if (block) {
          block.pos.x = initPos.x + x
          block.pos.y = initPos.y + y
          block.pos.z = initPos.z + z
        }
      }
      bctx.scene.markDirty()

      state._moveStart = null
      state._moveDelta = null
      state._moveInitialPositions = null
      return OP_RESULT.FINISHED
    }

    return OP_RESULT.PASS_THROUGH
  },
}
