/**
 * Scene queries — 对标 Blender 的 BKE_scene_* / ED_view3d_* 查询函数。
 *
 * createProductionQueries(bctx) 返回 BContextQueries 实现。
 * 操作符通过 bctx.queries 隐式获取场景状态，不直接 import 此文件。
 */
import type { BContext, BContextQueries } from '@/workbench/context/bContext'
import type { BlockRef } from '@/workbench/selectionContext'
import type { Frame } from '@/render/schema/types'
import { scenePickFromPointer } from '@/render/interaction/scenePick'

export function createProductionQueries(bctx: BContext): BContextQueries {
  return {
    pickVoxel(event: PointerEvent): BlockRef | null {
      const vp = bctx.viewport
      const camera = vp.camera.value
      const contentGroup = vp.contentGroup.value
      const domElement = vp.domElement.value
      const definition = vp.definition.value
      if (!camera || !contentGroup || !domElement || !definition) return null
      const result = scenePickFromPointer({
        clientX: event.clientX,
        clientY: event.clientY,
        domElement,
        camera,
        contentGroup,
        overlayGroup: vp.overlayGroup.value ?? undefined,
        def: definition,
        layerPreview: vp.layerPreview.value ?? 'all',
      })
      if (!result || result.kind !== 'block') return null

      // 从 RuntimeDocument Grid 获取 height 以转换 cellGrid row → world Y
      const doc = bctx.scene.scene.value
      const rf = doc?.frame(bctx.selection.frameIndex.value ?? 0)
      const h = rf?.grid?.height ?? 0
      const worldY = h > 0 ? h - 1 - result.row : result.row

      return {
        pos: { x: result.column, y: worldY, z: result.zSlice },
        block_state_id: result.blockId,
      }
    },

    getCurrentFrame(): Frame | null {
      const doc = bctx.scene.scene.value
      if (!doc) return null
      const idx = bctx.selection.frameIndex.value ?? 0
      const rf = doc.frame(idx)
      if (!rf) return null
      return rf.toRaw() as Frame | null
    },

    getFrameBlocks(): BlockRef[] {
      const doc = bctx.scene.scene.value
      if (!doc) return []
      const rf = doc.frame(bctx.selection.frameIndex.value ?? 0)
      if (!rf?.grid) return []
      return rf.grid.blocks().map(({ pos, block }) => ({
        pos: { x: pos.x, y: pos.y, z: pos.z },
        block_state_id: `minecraft:${block.name}:${block.meta}`,
      }))
    },

    getDocument(): Record<string, any> | null {
      return bctx.scene.scene.value?.serialize() ?? null
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

    gridCenterWorld(pos: { x: number; y: number; z: number }): { x: number; y: number; z: number } | null {
      const doc = bctx.scene.scene.value
      if (!doc) return null
      const rf = doc.frame(bctx.selection.frameIndex.value ?? 0)
      if (!rf?.grid) return null
      return rf.grid.centerWorld(pos)
    },
  }
}
