/**
 * Scene queries — 对标 Blender 的 BKE_scene_* / ED_view3d_* 查询函数。
 *
 * 从 bContext 中提取纯函数：pickVoxel, getFrameBlocks。
 * 操作符通过 bContext 隐式获取场景状态，调用这些查询函数。
 */
import type { BContext } from '@/workbench/context/bContext'
import type { BlockRef } from '@/workbench/selectionContext'
import type { V2PlainSceneDocument } from '@/render/data/sceneDocumentV2'
import { pickVoxelFromPointer } from '@/render/interaction/voxelPick'

export function pickVoxel(bctx: BContext, event: PointerEvent): BlockRef | null {
  const { camera, contentGroup, domElement, definition, layerPreview } = bctx
  if (!camera || !contentGroup || !domElement || !definition) return null

  const result = pickVoxelFromPointer({
    clientX: event.clientX,
    clientY: event.clientY,
    domElement,
    camera,
    contentGroup,
    def: definition,
    layerPreview: layerPreview ?? undefined as any,
  })
  if (!result) return null
  return {
    pos: { x: result.column, y: result.row, z: result.zSlice },
    block_state_id: result.blockId,
  }
}

export function getFrameBlocks(bctx: BContext): BlockRef[] {
  const doc = bctx.scene.scene.value as V2PlainSceneDocument | null
  if (!doc?.frames?.length) return []
  const frame = doc.frames[bctx.selection.frameIndex.value ?? 0]
  return (frame.blocks ?? []).map(b => ({
    pos: { ...b.pos },
    block_state_id: b.block_state_id,
  }))
}
