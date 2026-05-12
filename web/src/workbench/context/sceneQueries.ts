/**
 * Scene queries — 对标 Blender 的 BKE_scene_* / ED_view3d_* 查询函数。
 *
 * createProductionQueries(bctx) 返回 BContextQueries 实现。
 * 操作符通过 bctx.queries 隐式获取场景状态，不直接 import 此文件。
 */
import * as THREE from 'three'
import type { BContext, BContextQueries } from '@/workbench/context/bContext'
import type { BlockRef } from '@/workbench/selectionContext'
import type { V2PlainSceneDocument, V2WorldFrame } from '@/render/data/sceneDocumentV2'
import { pickVoxelFromPointer } from '@/render/interaction/voxelPick'

export function createProductionQueries(bctx: BContext): BContextQueries {
  return {
    pickVoxel(event: PointerEvent): BlockRef | null {
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
    },

    getCurrentFrame(): V2WorldFrame | null {
      const doc = bctx.scene.scene.value as V2PlainSceneDocument | null
      if (!doc?.frames?.length) return null
      const idx = bctx.selection.frameIndex.value ?? 0
      return doc.frames[idx] ?? null
    },

    getFrameBlocks(): BlockRef[] {
      const frame = this.getCurrentFrame()
      if (!frame) return []
      return (frame.blocks ?? []).map(b => ({
        pos: { ...b.pos },
        block_state_id: b.block_state_id,
      }))
    },

    projectBlock(pos: { x: number; y: number; z: number }): { x: number; y: number } | null {
      const { camera, domElement } = bctx
      if (!camera || !domElement) return null
      const worldPos = new THREE.Vector3(pos.x, pos.y, pos.z)
      worldPos.project(camera)
      const rect = domElement.getBoundingClientRect()
      return {
        x: ((worldPos.x + 1) / 2) * rect.width + rect.left,
        y: ((-worldPos.y + 1) / 2) * rect.height + rect.top,
      }
    },

    getGizmoAnchor(_axis: 'x' | 'y' | 'z'): { x: number; y: number } | null {
      return null
    },

    axisAdd(
      origin: { x: number; y: number; z: number },
      axis: 'x' | 'y' | 'z',
      delta: number,
    ): { x: number; y: number; z: number } {
      return {
        x: origin.x + (axis === 'x' ? delta : 0),
        y: origin.y + (axis === 'y' ? delta : 0),
        z: origin.z + (axis === 'z' ? delta : 0),
      }
    },

    roundVec(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
      return { x: Math.round(v.x), y: Math.round(v.y), z: Math.round(v.z) }
    },
  }
}

/** @deprecated 通过 bctx.queries.pickVoxel(event) 调用 */
export function pickVoxel(bctx: BContext, event: PointerEvent): BlockRef | null {
  return bctx.queries.pickVoxel(event)
}

/** @deprecated 通过 bctx.queries.getFrameBlocks() 调用 */
export function getFrameBlocks(bctx: BContext): BlockRef[] {
  return bctx.queries.getFrameBlocks()
}
