/**
 * Scene queries — 对标 Blender 的 BKE_scene_* / ED_view3d_* 查询函数。
 *
 * createProductionQueries(bctx) 返回 BContextQueries 实现。
 * 操作符通过 bctx.queries 隐式获取场景状态，不直接 import 此文件。
 */
import type { BContext, BContextQueries, MaterialQueryItem } from '@/workbench/context/bContext'
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
      const doc = bctx.doc.value
      const rf = doc?.frame(bctx.selection.frameIndex.value ?? 0)
      const h = rf?.grid?.height ?? 0
      const worldY = h > 0 ? h - 1 - result.row : result.row

      return {
        pos: { x: result.column, y: worldY, z: result.zSlice },
        block_state_id: result.blockId,
      }
    },

    getCurrentFrame(): Frame | null {
      const doc = bctx.doc.value
      if (!doc) return null
      const idx = bctx.selection.frameIndex.value ?? 0
      const rf = doc.frame(idx)
      if (!rf) return null
      return rf.toRaw() as Frame | null
    },

    getFrameBlocks(): BlockRef[] {
      const doc = bctx.doc.value
      if (!doc) return []
      const rf = doc.frame(bctx.selection.frameIndex.value ?? 0)
      if (!rf?.grid) return []
      return rf.grid.blocks().map(({ pos, block }) => ({
        pos: { x: pos.x, y: pos.y, z: pos.z },
        block_state_id: `minecraft:${block.name}:${block.meta}`,
      }))
    },

    getDocument(): Record<string, any> | null {
      return bctx.doc.value?.serialize() ?? null
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
      const doc = bctx.doc.value
      if (!doc) return null
      const rf = doc.frame(bctx.selection.frameIndex.value ?? 0)
      if (!rf?.grid) return null
      return rf.grid.centerWorld(pos)
    },

    getMaterialUsageCounts(): Record<string, number> {
      const counts: Record<string, number> = {}
      const doc = bctx.doc.value
      if (!doc) return counts
      const rf = doc.frame(bctx.selection.frameIndex.value ?? 0)
      if (!rf?.grid) return counts
      rf.grid.forEach((_pos, block) => {
        if (block.paletteIndex !== undefined) {
          const key = String(block.paletteIndex)
          counts[key] = (counts[key] ?? 0) + 1
        }
      })
      return counts
    },

    listMaterials(): MaterialQueryItem[] {
      const doc = bctx.doc.value
      if (!doc) return []
      const palette = doc.materialPalette as any[] | undefined
      if (!palette?.length) return []
      const blobs = doc.textureBlobs as Record<string, unknown> | undefined

      function getBlob(index: number): string | null {
        if (!blobs) return null
        const key = String(index)
        const b = blobs[key]
        if (typeof b !== 'string') return null
        const t = b.trim()
        if (t.startsWith('data:')) return t
        return `data:image/png;base64,${t}`
      }

      return palette.map((entry: any, i: number) => {
        const idx = entry.textureBlobIndex
        const dataUrl = (typeof idx === 'number' && Number.isFinite(idx))
          ? getBlob(Math.floor(idx))
          : null
        return {
          materialId: String(i),
          kind: entry.kind ?? 'static16',
          blend: entry.blend,
          locator: entry.locator,
          emissive: entry.emissive,
          animation: entry.animation,
          textureDataUrl: dataUrl,
          atlas: entry.atlas,
          linear: entry.linear,
          useMipmaps: entry.useMipmaps,
        }
      })
    },
  }
}
