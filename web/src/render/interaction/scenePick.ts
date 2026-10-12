/**
 * 视口场景拾取：统一入口，覆盖方块（faceIndex 反查 triangleMap）和注解（object.name）。
 * 替代旧的 voxelPick.ts 启发式 nudge 算法。
 */

import * as THREE from 'three'

import { buildVoxelVolume } from '../data/grid'
import { effectiveBlockId, type LayerPreviewMode } from '../data/layerPreview'
import type { StructureDefinition } from '../schema/types'
// #301 P10f C′1（N4）：不再 import 旧 `Annotation` 联合 —— 本模块对注解的依赖已
// 收窄成结构子集 `ScenePickableBoxAnnotation`（见其说明）。`AnnotationType` 仍在用。
import type { AnnotationType } from '../data/annotationTypes'

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
  /** 主场景内参与深度测试的注解（box overlay=false） */
  worldAnnotationGroup?: THREE.Group
  def: StructureDefinition
  layerPreview: LayerPreviewMode
  /**
   * 参与 AABB 拾取的**盒**注解（可选）。
   *
   * ## 为什么参数收窄成结构子集（#301 P10f C′1，N4）
   *
   * 本函数**只**读 `type` / `visible` / `min` / `max` / `id`（见 `:194-197`、
   * `:204`、`:298-306`）。原先要求完整的 legacy `Annotation` 联合，于是
   * "提供注解"这件事绑定了**旧文档的字段全集** —— 而那正是 `getDoc()` 的
   * 消费面（`N4`）。收窄成它真正需要的**结构子集**后：
   *
   *  - 内核注解读面（`KernelAnnotationView`）可直接传入（字段同名前缀齐备）；
   *  - 旧的 `Annotation[]` 也**仍然**满足该子集（结构兼容）⇒ 调用点零改动；
   *  - 类型系统从此表达"这里到底用了什么"，而不是"它来自哪份旧结构"。
   *
   * ⚠️ `type` 收成 `string`（而非 `AnnotationType`）：`isBox` 的窄化只看
   * `type === 'box'`，而内核来源的形状也是同一套字符串。放宽是**有意的** ——
   * 它让本参数不再声称"我认识所有旧形状"（那是个更强的、用不到的承诺）。
   */
  annotations?: readonly ScenePickableBoxAnnotation[]
}

/**
 * `scenePick` 真正依赖的注解**结构子集**（盒拾取所需的最小面）。
 *
 * 命名带 `ScenePickable` 以免被误当成"通用注解类型" —— 它不是模型，
 * 是这个函数的**输入契约**。
 */
export interface ScenePickableBoxAnnotation {
  readonly id: string
  readonly type: string
  readonly visible: boolean
  readonly min?: { readonly x: number; readonly y: number; readonly z: number }
  readonly max?: { readonly x: number; readonly y: number; readonly z: number }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * 可参与盒拾取的注解（`min`/`max` 已**证明**存在）。
 *
 * 用**类型谓词**（而不是返回 `boolean`）：调用方在 `if (!isPickableBox(a)) continue`
 * 之后需要 `a.min`/`a.max` 是**非可选**的 —— 那正是"判过就不必再判"的类型级表达。
 * 返回 `boolean` 会让 `rayIntersectsBox` 收到 `x | undefined`（第一版实测报
 * TS2345 两处），于是要么加非空断言、要么在调用点重复判断 —— 两者都比谓词差。
 */
type PickableBoxAnnotation = ScenePickableBoxAnnotation & {
  readonly min: { readonly x: number; readonly y: number; readonly z: number }
  readonly max: { readonly x: number; readonly y: number; readonly z: number }
}

/**
 * 该注解是否可参与盒拾取（**结构判据**，不是类型窄化）。
 *
 * 与旧的 `isBox(a)`（`a.type === 'box'`）语义**相同**，但输入是结构子集
 * （见 `ScenePickableBoxAnnotation` 的说明）—— 于是内核注解读面也能传入，
 * 而本函数不需要认识 legacy `Annotation` 联合。
 *
 * ⚠️ `min`/`max` 的存在性一并判：旧联合的 `BoxAnnotation` 由**类型**保证两字段在，
 * 而结构子集下它们可选。少判这一步会让 `rayIntersectsBox` 收到 `undefined`
 * —— 那是**运行期**崩溃而不是编译期错误。
 */
function isPickableBox(a: ScenePickableBoxAnnotation): a is PickableBoxAnnotation {
  return a.type === 'box' && a.visible !== false && a.min !== undefined && a.max !== undefined
}

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
  const { clientX, clientY, domElement, camera, contentGroup, overlayGroup, worldAnnotationGroup, def, layerPreview, annotations } = params

  const rect = domElement.getBoundingClientRect()
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  )

  const raycaster = new THREE.Raycaster()
  raycaster.setFromCamera(ndc, camera)

  // ── Mesh pick ──
  const structureHits = raycaster.intersectObject(contentGroup, true)
  const worldAnnoHits = worldAnnotationGroup ? raycaster.intersectObject(worldAnnotationGroup, true) : []
  const overlayHits = overlayGroup ? raycaster.intersectObject(overlayGroup, true) : []
  const allHits = structureHits.concat(worldAnnoHits, overlayHits).sort((a, b) => a.distance - b.distance)
  const volume = buildVoxelVolume(def)

  let nearestBlock: ScenePickBlock | null = null
  let nearestAnnoMesh: ScenePickAnnotation | null = null

  for (const hit of allHits) {
    const objName = (hit.object as THREE.Object3D).name || ''
    if (objName.startsWith('anno-')) {
      const lastDash = objName.lastIndexOf('-')
      const pick: ScenePickAnnotation = {
        kind: 'annotation',
        distance: hit.distance,
        annotationId: lastDash >= 0 ? objName.slice(lastDash + 1) : objName,
        point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
      }
      if (!nearestAnnoMesh || hit.distance < nearestAnnoMesh.distance) nearestAnnoMesh = pick
      continue
    }
    const triangleMap = (hit.object as THREE.Mesh).userData.triangleMap as
      Array<{ col: number; row: number; zSlice: number; quadIndex?: number }> | undefined
    if (!triangleMap || hit.faceIndex == null || hit.faceIndex >= triangleMap.length) continue
    const entry = triangleMap[hit.faceIndex]
    const blockId = effectiveBlockId(volume, entry.col, entry.row, entry.zSlice, volume.sizeRow, layerPreview)
    if (blockId === 'air') continue
    const normalWorld = hit.face
      ? hit.face.normal.clone()
          .transformDirection((hit.object as THREE.Mesh).matrixWorld)
          .normalize()
      : undefined
    const pick: ScenePickBlock = {
      kind: 'block',
      distance: hit.distance,
      blockId,
      column: entry.col,
      row: entry.row,
      zSlice: entry.zSlice,
      quadIndex: (entry as { quadIndex?: number }).quadIndex,
      normal: normalWorld ? { x: normalWorld.x, y: normalWorld.y, z: normalWorld.z } : undefined,
      point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
    }
    if (!nearestBlock || hit.distance < nearestBlock.distance) nearestBlock = pick
  }

  // ── AABB pick (box annotations only) ──
  let aabbResult: { annotationId: string; distance: number } | null = null
  if (annotations && annotations.length > 0) {
    for (const anno of annotations) {
      if (!isPickableBox(anno)) continue
      const d = rayIntersectsBox(raycaster.ray.origin, raycaster.ray.direction, anno.min, anno.max)
      if (d !== null && (aabbResult === null || d < aabbResult.distance)) {
        aabbResult = { annotationId: anno.id, distance: d }
      }
    }
  }

  // ── Merge ──
  const meshIsBoxAnno = nearestAnnoMesh
    && annotations?.some(a => a.id === nearestAnnoMesh!.annotationId && a.type === 'box')
  const effAnnoMesh = meshIsBoxAnno ? null : nearestAnnoMesh
  const blockDist = nearestBlock?.distance ?? Infinity
  const annoMeshDist = effAnnoMesh?.distance ?? Infinity
  const aabbDist = aabbResult?.distance ?? Infinity
  const annoDist = Math.min(annoMeshDist, aabbDist)

  const PICK_BIAS = 0.005
  if (aabbResult && aabbDist <= blockDist + PICK_BIAS && aabbDist <= annoMeshDist + PICK_BIAS) {
    return { kind: 'annotation', distance: aabbResult.distance, annotationId: aabbResult.annotationId, point: { x: 0, y: 0, z: 0 } }
  }
  if (effAnnoMesh && annoDist <= blockDist + PICK_BIAS) return effAnnoMesh
  return nearestBlock
}

// ---------------------------------------------------------------------------
// Multi-hit pick (for cycling)
// ---------------------------------------------------------------------------

export function scenePickAllFromPointer(params: ScenePickParams): ScenePickEntity[] {
  const { clientX, clientY, domElement, camera, contentGroup, overlayGroup, worldAnnotationGroup, def, layerPreview, annotations } = params

  const rect = domElement.getBoundingClientRect()
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  )

  const raycaster = new THREE.Raycaster()
  raycaster.setFromCamera(ndc, camera)

  const structureHits = raycaster.intersectObject(contentGroup, true)
  const worldAnnoHits = worldAnnotationGroup ? raycaster.intersectObject(worldAnnotationGroup, true) : []
  const overlayHits = overlayGroup ? raycaster.intersectObject(overlayGroup, true) : []
  const allHits = structureHits.concat(worldAnnoHits, overlayHits).sort((a, b) => a.distance - b.distance)

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

  if (annotations && annotations.length > 0) {
    for (const anno of annotations) {
      if (!isPickableBox(anno)) continue
      if (seenAnnos.has(anno.id)) continue
      const d = rayIntersectsBox(raycaster.ray.origin, raycaster.ray.direction, anno.min, anno.max)
      if (d === null) continue
      seenAnnos.add(anno.id)
      results.push({
        kind: 'annotation',
        distance: d,
        annotationId: anno.id,
        annotationType: 'box',
      })
    }
    results.sort((a, b) => a.distance - b.distance)
  }

  return results
}
