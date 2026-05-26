/**
 * 视口场景拾取：统一入口，覆盖方块（faceIndex 反查 triangleMap）和注解（object.name）。
 * 替代旧的 voxelPick.ts 启发式 nudge 算法。
 */

import * as THREE from 'three'

import { buildVoxelVolume } from '../data/grid'
import { effectiveBlockId, type LayerPreviewMode } from '../data/layerPreview'
import type { StructureDefinition } from '../schema/types'
import type { Annotation, AnnotationType } from '../data/annotationTypes'
import { isBox } from '../data/annotationTypes'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScenePickBlock {
  kind: 'block'
  distance: number
  blockId: string
  column: number
  row: number
  zSlice: number
  /** 被击中的 quad 在该体素内的索引 */
  quadIndex?: number
  /** 命中面的世界空间法线（已归一化），拾取相邻位置用 */
  normal?: { x: number; y: number; z: number }
  /** 命中点的世界空间坐标，用于区分同法线的多个面 */
  point?: { x: number; y: number; z: number }
}

export interface ScenePickAnnotation {
  kind: 'annotation'
  distance: number
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
  quadIndex?: number
  normal?: { x: number; y: number; z: number }
  point?: { x: number; y: number; z: number }
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
  /** Optional: box annotations for AABB-based picking (merged with mesh hits) */
  annotations?: Annotation[]
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
// Annotation AABB pick (ray–box intersection, no mesh dependency)
// ---------------------------------------------------------------------------

/** Ray–AABB intersection via slab method. Returns entry distance or null. */
export function rayIntersectsBox(
  rayOrigin: THREE.Vector3,
  rayDirection: THREE.Vector3,
  boxMin: { x: number; y: number; z: number },
  boxMax: { x: number; y: number; z: number },
): number | null {
  let tmin = -Infinity
  let tmax = Infinity

  const origins = [rayOrigin.x, rayOrigin.y, rayOrigin.z]
  const dirs = [rayDirection.x, rayDirection.y, rayDirection.z]
  const mins = [boxMin.x, boxMin.y, boxMin.z]
  const maxs = [boxMax.x, boxMax.y, boxMax.z]

  for (let i = 0; i < 3; i++) {
    if (Math.abs(dirs[i]) < 1e-10) {
      if (origins[i] < mins[i] || origins[i] > maxs[i]) return null
    } else {
      let t1 = (mins[i] - origins[i]) / dirs[i]
      let t2 = (maxs[i] - origins[i]) / dirs[i]
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp }
      tmin = Math.max(tmin, t1)
      tmax = Math.min(tmax, t2)
      if (tmin > tmax) return null
    }
  }

  return tmin >= 0 ? tmin : (tmax >= 0 ? 0 : null)
}

// ---------------------------------------------------------------------------
// Unified single-hit pick — mesh + optional AABB, one raycaster
// ---------------------------------------------------------------------------

/** Pure function: screen position → closest hit (block or annotation).
 *  If `annotations` are provided, box annotations are picked via AABB and merged with mesh hits. */
export function pickAtPointer(params: ScenePickParams): ScenePickResult {
  const { clientX, clientY, domElement, camera, contentGroup, overlayGroup, def, layerPreview, annotations } = params

  const rect = domElement.getBoundingClientRect()
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  )

  const raycaster = new THREE.Raycaster()
  raycaster.setFromCamera(ndc, camera)

  // ── Mesh pick ──
  const structureHits = raycaster.intersectObject(contentGroup, true)
  const overlayHits = overlayGroup ? raycaster.intersectObject(overlayGroup, true) : []
  const allHits = structureHits.concat(overlayHits).sort((a, b) => a.distance - b.distance)
  const meshHit = allHits[0]

  let meshResult: ScenePickResult = null
  if (meshHit) {
    const objName = (meshHit.object as THREE.Object3D).name || ''
    if (objName.startsWith('anno-')) {
      const lastDash = objName.lastIndexOf('-')
      meshResult = {
        kind: 'annotation',
        distance: meshHit.distance,
        annotationId: lastDash >= 0 ? objName.slice(lastDash + 1) : objName,
        point: { x: meshHit.point.x, y: meshHit.point.y, z: meshHit.point.z },
      }
    } else {
      const triangleMap = (meshHit.object as THREE.Mesh).userData.triangleMap as
        Array<{ col: number; row: number; zSlice: number; quadIndex?: number }> | undefined
      if (triangleMap && meshHit.faceIndex != null && meshHit.faceIndex < triangleMap.length) {
        const entry = triangleMap[meshHit.faceIndex]
        const volume = buildVoxelVolume(def)
        const blockId = effectiveBlockId(volume, entry.col, entry.row, entry.zSlice, volume.sizeRow, layerPreview)
        if (blockId !== 'air') {
          const normalWorld = meshHit.face
            ? meshHit.face.normal.clone()
                .transformDirection((meshHit.object as THREE.Mesh).matrixWorld)
                .normalize()
            : undefined
          meshResult = {
            kind: 'block',
            distance: meshHit.distance,
            blockId,
            column: entry.col,
            row: entry.row,
            zSlice: entry.zSlice,
            quadIndex: (entry as any).quadIndex,
            normal: normalWorld ? { x: normalWorld.x, y: normalWorld.y, z: normalWorld.z } : undefined,
            point: { x: meshHit.point.x, y: meshHit.point.y, z: meshHit.point.z },
          }
        }
      }
    }
  }

  // ── AABB pick (box annotations only) ──
  let aabbResult: { annotationId: string; distance: number } | null = null
  if (annotations && annotations.length > 0) {
    for (const anno of annotations) {
      if (!isBox(anno) || anno.visible === false) continue
      const d = rayIntersectsBox(raycaster.ray.origin, raycaster.ray.direction, anno.min, anno.max)
      if (d !== null && (aabbResult === null || d < aabbResult.distance)) {
        aabbResult = { annotationId: anno.id, distance: d }
      }
    }
  }

  // ── Merge ──
  // Box annotation mesh hits are discarded — AABB handles them reliably
  const meshIsBoxAnno = meshResult?.kind === 'annotation'
    && annotations?.some(a => a.id === meshResult.annotationId && a.type === 'box')
  const effMesh = meshIsBoxAnno ? null : meshResult
  const meshDist = effMesh?.distance ?? Infinity
  const aabbDist = aabbResult?.distance ?? Infinity

  if (aabbDist < meshDist && aabbResult) {
    return { kind: 'annotation', distance: aabbResult.distance, annotationId: aabbResult.annotationId, point: { x: 0, y: 0, z: 0 } }
  }
  return effMesh
}

/** Backward-compatible wrapper — delegates to pickAtPointer without AABB annotations. */
export function scenePickFromPointer(params: ScenePickParams): ScenePickResult {
  return pickAtPointer({ ...params, annotations: undefined })
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
      quadIndex: (entry as any).quadIndex,
      normal: normalWorld ? { x: normalWorld.x, y: normalWorld.y, z: normalWorld.z } : undefined,
      point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
    })
  }

  return results
}
