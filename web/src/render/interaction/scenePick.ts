/**
 * 视口场景拾取：统一入口，覆盖方块（faceIndex 反查 triangleMap）和注解（object.name）。
 * 替代旧的 voxelPick.ts 启发式 nudge 算法。
 */

import * as THREE from 'three'

import { buildVoxelVolume } from '../data/grid'
import { effectiveBlockId, type LayerPreviewMode } from '../data/layerPreview'
import type { StructureDefinition } from '../schema/types'
import type { AnnotationType } from '../data/annotationTypes'

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

/** Deduplicated entity hit for pick cycling. */
export interface ScenePickEntity {
  kind: 'block' | 'annotation'
  distance: number
  // block fields
  blockId?: string
  column?: number
  row?: number
  zSlice?: number
  normal?: { x: number; y: number; z: number }
  // annotation fields
  annotationId?: string
  annotationType?: AnnotationType
}

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
// Helpers
// ---------------------------------------------------------------------------

function parseAnnotationName(objName: string): { id: string; type: AnnotationType } | null {
  if (!objName.startsWith('anno-')) return null
  const rest = objName.slice(5) // strip "anno-"
  const firstDash = rest.indexOf('-')
  if (firstDash < 0) return null
  const type = rest.slice(0, firstDash) as AnnotationType
  const lastDash = objName.lastIndexOf('-')
  const id = lastDash >= 0 ? objName.slice(lastDash + 1) : objName
  return { id, type }
}

// ---------------------------------------------------------------------------
// Single-hit pick (existing, used by Embed Viewer)
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

// ---------------------------------------------------------------------------
// Multi-hit pick (for cycling)
// ---------------------------------------------------------------------------

export function scenePickAllFromPointer(params: ScenePickParams): ScenePickEntity[] {
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

  const seenBlocks = new Set<string>()
  const seenAnnos = new Set<string>()
  const results: ScenePickEntity[] = []

  const volume = buildVoxelVolume(def)

  for (const hit of allHits) {
    const objName = (hit.object as THREE.Object3D).name || ''

    // Annotation hit
    if (objName.startsWith('anno-')) {
      const parsed = parseAnnotationName(objName)
      if (!parsed) continue
      if (seenAnnos.has(parsed.id)) continue
      seenAnnos.add(parsed.id)
      results.push({
        kind: 'annotation',
        distance: hit.distance,
        annotationId: parsed.id,
        annotationType: parsed.type,
      })
      continue
    }

    // Block hit
    const triangleMap = (hit.object as THREE.Mesh).userData.triangleMap as
      Array<{ col: number; row: number; zSlice: number }> | undefined
    if (!triangleMap) continue
    if (hit.faceIndex == null || hit.faceIndex >= triangleMap.length) continue

    const entry = triangleMap[hit.faceIndex]
    const key = `${entry.col},${entry.row},${entry.zSlice}`
    if (seenBlocks.has(key)) continue

    const blockId = effectiveBlockId(volume, entry.col, entry.row, entry.zSlice, volume.sizeRow, layerPreview)
    if (blockId === 'air') continue

    seenBlocks.add(key)
    const normalWorld = hit.face
      ? hit.face.normal.clone()
          .transformDirection((hit.object as THREE.Mesh).matrixWorld)
          .normalize()
      : undefined
    results.push({
      kind: 'block',
      distance: hit.distance,
      blockId,
      column: entry.col,
      row: entry.row,
      zSlice: entry.zSlice,
      normal: normalWorld ? { x: normalWorld.x, y: normalWorld.y, z: normalWorld.z } : undefined,
    })
  }

  return results
}
