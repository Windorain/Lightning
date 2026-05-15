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
import { ARROW_LENGTH, CONE_LENGTH } from '@/workbench/tools/gizmos'

export function createProductionQueries(bctx: BContext): BContextQueries {
  return {
    pickVoxel(event: PointerEvent): BlockRef | null {
      const vp = bctx.viewport
      const camera = vp.camera.value
      const contentGroup = vp.contentGroup.value
      const domElement = vp.domElement.value
      const definition = vp.definition.value
      if (!camera || !contentGroup || !domElement || !definition) return null
      const result = pickVoxelFromPointer({
        clientX: event.clientX,
        clientY: event.clientY,
        domElement,
        camera,
        contentGroup,
        def: definition,
        layerPreview: vp.layerPreview.value ?? 'all',
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

    moveBlockInCellGrid(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): boolean {
      const frame = this.getCurrentFrame()
      if (!frame?.structure) return false
      const st = frame.structure as { cellGrid: number[][][] }
      const grid = st.cellGrid
      // validate source
      if (from.z < 0 || from.z >= grid.length) return false
      const fromSlice = grid[from.z]
      if (!fromSlice || from.y < 0 || from.y >= fromSlice.length) return false
      const fromRow = fromSlice[from.y]
      if (!fromRow || from.x < 0 || from.x >= fromRow.length) return false
      if (fromRow[from.x] === 0) return false // source must be non-air

      // auto-expand grid for positive out-of-bounds targets
      if (to.z < 0 || to.y < 0 || to.x < 0) return false
      const curMaxX = grid[0]?.[0]?.length ?? 0
      const curMaxY = grid[0]?.length ?? 0
      const curMaxZ = grid.length
      const newZ = Math.max(curMaxZ, to.z + 1)
      const newY = Math.max(curMaxY, to.y + 1)
      const newX = Math.max(curMaxX, to.x + 1)

      if (newZ > curMaxZ) {
        const emptySlice = Array.from({ length: newY }, () => new Array(newX).fill(0))
        while (grid.length < newZ) grid.push(emptySlice.map(r => [...r]))
      }
      if (newY > curMaxY) {
        for (const slice of grid) {
          while (slice.length < newY) slice.push(new Array(newX).fill(0))
        }
      }
      if (newX > curMaxX) {
        for (const slice of grid) {
          for (const row of slice) {
            while (row.length < newX) row.push(0)
          }
        }
      }

      // validate target is air
      const toSlice = grid[to.z]
      const toRow = toSlice[to.y]
      if (toRow[to.x] !== 0) return false

      // move
      console.log('[moveBlock] moving', JSON.stringify(from), '→', JSON.stringify(to), 'fromVal:', fromRow[from.x], 'toVal:', toRow[to.x])
      toRow[to.x] = fromRow[from.x]
      fromRow[from.x] = 0
      console.log('[moveBlock] done, fromRow:', JSON.stringify(fromRow), 'toRow:', JSON.stringify(toRow))
      return true
    },

    getDocument(): Record<string, any> | null {
      return bctx.scene.scene.value as Record<string, any> | null
    },

    projectBlock(pos: { x: number; y: number; z: number }): { x: number; y: number } | null {
      const vp = bctx.viewport
      const camera = vp.camera.value
      const domElement = vp.domElement.value
      const def = vp.definition.value
      if (!camera || !domElement) return null
      // Convert grid coordinates to world coordinates (same as voxelToWorld)
      let wx = pos.x, wy = pos.y, wz = pos.z
      if (def?.cellGrid) {
        const sCol = def.cellGrid[0]?.[0]?.length ?? 1
        const sRow = def.cellGrid[0]?.length ?? 1
        const sZ = def.cellGrid.length ?? 1
        wx = pos.x - sCol / 2 + 0.5
        wy = sRow / 2 - 0.5 - pos.y
        wz = pos.z - sZ / 2 + 0.5
      }
      const worldPos = new THREE.Vector3(wx, wy, wz)
      worldPos.project(camera)
      const rect = domElement.getBoundingClientRect()
      return {
        x: ((worldPos.x + 1) / 2) * rect.width + rect.left,
        y: ((-worldPos.y + 1) / 2) * rect.height + rect.top,
      }
    },

    getGizmoAnchor(axis: 'x' | 'y' | 'z'): { x: number; y: number } | null {
      const vp = bctx.viewport
      const camera = vp.camera.value
      const domElement = vp.domElement.value
      const gizmo = vp.gizmo.value
      if (!camera || !domElement || !gizmo) return null
      if (bctx.selection.items.value.size === 0) return null

      // Use the gizmo's actual world position (set by voxelToWorld in updateGizmo)
      // Offset to the arrow cylinder center (best hit-test surface area)
      const arrowCenter = (ARROW_LENGTH - CONE_LENGTH) / 2
      const gPos = gizmo.root.position
      const anchor = new THREE.Vector3(
        gPos.x + (axis === 'x' ? arrowCenter : 0),
        gPos.y + (axis === 'y' ? arrowCenter : 0),
        gPos.z + (axis === 'z' ? arrowCenter : 0),
      )
      anchor.project(camera)

      const rect = domElement.getBoundingClientRect()
      return {
        x: ((anchor.x + 1) / 2) * rect.width + rect.left,
        y: ((-anchor.y + 1) / 2) * rect.height + rect.top,
      }
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
      const vp = bctx.viewport
      const camera = vp.camera.value
      const contentGroup = vp.contentGroup.value
      const domElement = vp.domElement.value
      const definition = vp.definition.value
      if (!camera || !contentGroup || !domElement || !definition) return null

      const rect = domElement.getBoundingClientRect()
      const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      )

      const raycaster = new THREE.Raycaster()
      raycaster.setFromCamera(mouse, camera)

      const hits = raycaster.intersectObject(contentGroup, true)
      if (!hits.length || !hits[0].face) return null

      const hit = hits[0]
      const normalWorld = hit.face.normal
        .clone()
        .transformDirection((hit.object as THREE.Object3D).matrixWorld)
        .normalize()

      const nx = Math.round(normalWorld.x)
      const ny = Math.round(normalWorld.y)
      const nz = Math.round(normalWorld.z)

      const result = pickVoxelFromPointer({
        clientX: event.clientX, clientY: event.clientY,
        domElement, camera, contentGroup, def: definition,
        layerPreview: vp.layerPreview.value ?? 'all',
      })
      if (!result) return null

      return {
        pos: { x: result.column + nx, y: result.row + ny, z: result.zSlice + nz },
        normal: { x: nx, y: ny, z: nz },
      }
    },

    pickGround(event: PointerEvent) {
      const vp = bctx.viewport
      const camera = vp.camera.value
      const domElement = vp.domElement.value
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
      const vp = bctx.viewport
      const camera = vp.camera.value
      const domElement = vp.domElement.value
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

