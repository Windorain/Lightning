/**
 * Scene queries — 对标 Blender 的 BKE_scene_* / ED_view3d_* 查询函数。
 *
 * createProductionQueries(bctx) 返回 BContextQueries 实现。
 * 操作符通过 bctx.queries 隐式获取场景状态，不直接 import 此文件。
 */
import * as THREE from 'three'
import type { BContext, BContextQueries } from '@/workbench/context/bContext'
import type { BlockRef } from '@/workbench/selectionContext'
import type { V2PlainSceneDocument } from '@/render/data/sceneDocumentV2'
import type { Frame } from '@/render/schema/types'
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

    getCurrentFrame(): Frame | null {
      const doc = bctx.scene.scene.value as V2PlainSceneDocument | null
      if (!doc?.frames?.length) return null
      const idx = bctx.selection.frameIndex.value ?? 0
      return doc.frames[idx] ?? null
    },

    getFrameBlocks(): BlockRef[] {
      const frame = this.getCurrentFrame()
      if (!frame?.structure || !('cellGrid' in frame.structure)) return []
      const st = frame.structure as { cellGrid: number[][][]; blockPalette: Array<{ registryId: string; meta: number }> }
      const blocks: BlockRef[] = []
      for (let z = 0; z < st.cellGrid.length; z++) {
        const slice = st.cellGrid[z]
        if (!slice) continue
        for (let row = 0; row < slice.length; row++) {
          const cols = slice[row]
          if (!cols) continue
          for (let col = 0; col < cols.length; col++) {
            const idx = cols[col]
            const entry = st.blockPalette[idx]
            if (!entry || entry.registryId === 'air' || entry.registryId === 'minecraft:air') continue
            blocks.push({
              pos: { x: col, y: row, z },
              block_state_id: `${entry.registryId}:${entry.meta}`,
            })
          }
        }
      }
      return blocks
    },

    getDocument(): Record<string, any> | null {
      return bctx.scene.scene.value as Record<string, any> | null
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

    getAnnotationBoxes() {
      const doc = bctx.scene.scene.value as Record<string, any> | null
      return (doc?.annotations as any[]) ?? []
    },

    getAnnotationBox(id: string) {
      const doc = bctx.scene.scene.value as Record<string, any> | null
      return (doc?.annotations as any[])?.find((a: any) => a.id === id) ?? null
    },

    pickSurface(event: PointerEvent) {
      const { camera, contentGroup, domElement, definition, layerPreview } = bctx
      if (!camera || !contentGroup || !domElement || !definition) return null
      const result = pickVoxelFromPointer({
        clientX: event.clientX, clientY: event.clientY,
        domElement, camera, contentGroup, def: definition,
        layerPreview: layerPreview ?? undefined as any,
      })
      if (!result) return null
      const cx = result.column + 0.5, cy = result.row + 0.5, cz = result.zSlice + 0.5
      const dx = result.column + 0.5 - cx, dy = result.row + 0.5 - cy, dz = result.zSlice + 0.5 - cz
      const absDx = Math.abs(dx), absDy = Math.abs(dy), absDz = Math.abs(dz)
      let nx = 0, ny = 0, nz = 0
      if (absDx >= absDy && absDx >= absDz) nx = dx > 0 ? 1 : -1
      else if (absDy >= absDx && absDy >= absDz) ny = dy > 0 ? 1 : -1
      else nz = dz > 0 ? 1 : -1
      return {
        pos: { x: result.column + nx, y: result.row + ny, z: result.zSlice + nz },
        normal: { x: nx, y: ny, z: nz },
      }
    },

    pickGround(event: PointerEvent) {
      const { camera, domElement } = bctx
      if (!camera || !domElement) return null
      const rect = domElement.getBoundingClientRect()
      const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      )
      const raycaster = new THREE.Raycaster()
      raycaster.setFromCamera(mouse, camera)
      const dir = raycaster.ray.direction
      const origin = raycaster.ray.origin
      if (Math.abs(dir.y) < 0.0001) return null
      const t = -origin.y / dir.y
      if (t <= 0) return null
      return {
        x: Math.round(origin.x + dir.x * t),
        y: 0,
        z: Math.round(origin.z + dir.z * t),
      }
    },

    pickWorldPoint(event: PointerEvent) {
      const surface = this.pickSurface(event)
      if (surface) return surface.pos
      const { camera, domElement } = bctx
      if (!camera || !domElement) return null
      const rect = domElement.getBoundingClientRect()
      const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      )
      const raycaster = new THREE.Raycaster()
      raycaster.setFromCamera(mouse, camera)
      const dir = raycaster.ray.direction
      const origin = raycaster.ray.origin
      if (Math.abs(dir.y) < 0.0001) return null
      const t = -origin.y / dir.y
      if (t <= 0) return null
      return {
        x: origin.x + dir.x * t,
        y: 0,
        z: origin.z + dir.z * t,
      }
    },
  }
}

