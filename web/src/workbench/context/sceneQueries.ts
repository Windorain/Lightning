/**
 * Scene queries — 对标 Blender 的 BKE_scene_* / ED_view3d_* 查询函数。
 *
 * createProductionQueries(bctx) 返回 BContextQueries 实现。
 * 操作符通过 bctx.queries 隐式获取场景状态，不直接 import 此文件。
 */
import * as THREE from 'three'
import type { BContext, BContextQueries, MaterialQueryItem } from '@/workbench/context/bContext'
import type { BlockRef } from '@/workbench/selectionContext'
import type { V2AnnotationBox } from '@/render/data/sceneDocumentV2'
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

      // 从 structure definition 获取 grid height 以转换 cellGrid row → world Y
      const h = definition.cellGrid[0]?.length ?? 0
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

    moveBlockInCellGrid(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): boolean {
      const doc = bctx.scene.scene.value
      if (!doc) return false
      const rf = doc.frame(bctx.selection.frameIndex.value ?? 0)
      if (!rf?.grid) return false
      return rf.grid.moveBlock(
        { x: from.x, y: from.y, z: from.z },
        { x: to.x, y: to.y, z: to.z },
      )
    },

    getDocument(): Record<string, any> | null {
      return bctx.scene.scene.value?.serialize() ?? null
    },

    projectBlock(pos: { x: number; y: number; z: number }): { x: number; y: number } | null {
      const vp = bctx.viewport
      const camera = vp.camera.value
      const domElement = vp.domElement.value
      if (!camera || !domElement) return null

      const doc = bctx.scene.scene.value
      const rf = doc?.frame(bctx.selection.frameIndex.value ?? 0)
      const grid = rf?.grid
      const sCol = grid?.width ?? 1
      const sRow = grid?.height ?? 1
      const sZ = grid?.depth ?? 1

      // GridPos is Y-up, Three.js scene is centered at origin
      const wx = pos.x - sCol / 2 + 0.5
      const wy = pos.y - sRow / 2 + 0.5
      const wz = pos.z - sZ / 2 + 0.5
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

    getAnnotationBoxes(): V2AnnotationBox[] {
      return (bctx.scene.scene.value?.annotations ?? []) as V2AnnotationBox[]
    },

    getAnnotationBox(id: string): V2AnnotationBox | null {
      return (bctx.scene.scene.value?.annotations?.find((a: any) => a.id === id) ?? null) as V2AnnotationBox | null
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
      if (!hits.length) return null
      const hit = hits[0]
      if (!hit.face) return null
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

      // cellGrid row → world Y
      const h = definition.cellGrid[0]?.length ?? 0
      const worldY = h > 0 ? h - 1 - result.row : result.row

      return {
        pos: { x: result.column + nx, y: worldY + ny, z: result.zSlice + nz },
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

    listMaterials(): MaterialQueryItem[] {
      const doc = bctx.scene.scene.value
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
