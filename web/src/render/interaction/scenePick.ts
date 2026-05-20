/**
 * 视口场景拾取：统一入口，覆盖方块（faceIndex 反查 triangleMap）和注解（object.name）。
 * 替代旧的 voxelPick.ts 启发式 nudge 算法。
 */

import * as THREE from 'three'

import { buildVoxelVolume } from '../data/grid'
import { effectiveBlockId, type LayerPreviewMode } from '../data/layerPreview'
import type { StructureDefinition } from '../schema/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScenePickBlock {
  kind: 'block'
  blockId: string
  column: number
  row: number
  zSlice: number
  /** 命中面的世界空间法线（已归一化），拾取相邻位置用 */
  normal?: { x: number; y: number; z: number }
}

export interface ScenePickAnnotation {
  kind: 'annotation'
  annotationId: string
  point: { x: number; y: number; z: number }
}

export type ScenePickResult = ScenePickBlock | ScenePickAnnotation | null

export interface ScenePickParams {
  clientX: number
  clientY: number
  domElement: HTMLElement
  camera: THREE.Camera
  contentGroup: THREE.Group
  overlayGroup?: THREE.Group
  def: StructureDefinition
  layerPreview: LayerPreviewMode
}

// ---------------------------------------------------------------------------
// Pick
// ---------------------------------------------------------------------------

export function scenePickFromPointer(params: ScenePickParams): ScenePickResult {
  const { clientX, clientY, domElement, camera, contentGroup, overlayGroup, def, layerPreview } = params

  const rect = domElement.getBoundingClientRect()
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  )

  const raycaster = new THREE.Raycaster()
  raycaster.setFromCamera(ndc, camera)

  const structureHits = raycaster.intersectObject(contentGroup, true)
  const overlayHits = overlayGroup ? raycaster.intersectObject(overlayGroup, true) : []
  const allHits = structureHits.concat(overlayHits).sort((a, b) => a.distance - b.distance)

  const hit = allHits[0]
  if (!hit) return null

  // 1. Annotation hit
  const objName = (hit.object as THREE.Object3D).name || ''
  if (objName.startsWith('anno-')) {
    const lastDash = objName.lastIndexOf('-')
    return {
      kind: 'annotation',
      annotationId: lastDash >= 0 ? objName.slice(lastDash + 1) : objName,
      point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
    }
  }

  // 2. Block hit
  const triangleMap = (hit.object as THREE.Mesh).userData.triangleMap as
    Array<{ col: number; row: number; zSlice: number }> | undefined

  if (!triangleMap) return null
  if (hit.faceIndex == null || hit.faceIndex >= triangleMap.length) return null

  const entry = triangleMap[hit.faceIndex]
  const volume = buildVoxelVolume(def)
  const blockId = effectiveBlockId(volume, entry.col, entry.row, entry.zSlice, volume.sizeRow, layerPreview)
  if (blockId !== 'air') {
    const normalWorld = hit.face
      ? hit.face.normal.clone()
          .transformDirection((hit.object as THREE.Mesh).matrixWorld)
          .normalize()
      : undefined
    return {
      kind: 'block',
      blockId,
      column: entry.col,
      row: entry.row,
      zSlice: entry.zSlice,
      normal: normalWorld ? { x: normalWorld.x, y: normalWorld.y, z: normalWorld.z } : undefined,
    }
  }

  return null
}
