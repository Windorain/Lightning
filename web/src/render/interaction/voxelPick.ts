/**
 * 视口内鼠标 → 体素 block_registry 键（effectiveBlockId）：Raycaster + 命中点推入体内 + 与 simpleMesh 一致的格点映射。
 * 格点 `(column,row,zSlice)` 与 `cellGrid[zSlice][row][column]` / `buildVoxelVolume#get` 一致。
 */

import * as THREE from 'three'

import { buildVoxelVolume } from '../data/grid'
import { effectiveBlockId, type LayerPreviewMode } from '../data/layerPreview'
import type { StructureDefinition } from '../schema/types'

const AIR = 'air'
const NUDGE = 0.002

export interface PickBlockIdParams {
  clientX: number
  clientY: number
  domElement: HTMLElement
  camera: THREE.Camera
  contentGroup: THREE.Group
  def: StructureDefinition
  layerPreview: LayerPreviewMode
}

export interface VoxelPickResult {
  blockId: string
  column: number
  row: number
  zSlice: number
}

/**
 * 与 `quadGeometryForFace` 包围盒一致：世界坐标 → 体素索引。
 */
export function worldPointToVoxelIndices(
  p: THREE.Vector3,
  sizeColumn: number,
  sizeRow: number,
  sizeZSlice: number,
): { column: number; voxelY: number; zSlice: number } {
  const column = Math.min(sizeColumn - 1, Math.max(0, Math.floor(p.x + sizeColumn / 2)))
  const voxelY = Math.min(sizeRow - 1, Math.max(0, Math.floor(p.y + sizeRow / 2)))
  const zSlice = Math.min(sizeZSlice - 1, Math.max(0, Math.floor(p.z + sizeZSlice / 2)))
  return { column, voxelY, zSlice }
}

/**
 * 拾取非空气体素时返回 `blockId` 与 `cellGrid` 同下标的格点（供 `cellTooltipGrid`）。
 */
export function pickVoxelFromPointer(params: PickBlockIdParams): VoxelPickResult | null {
  const { clientX, clientY, domElement, camera, contentGroup, def, layerPreview } = params

  const rect = domElement.getBoundingClientRect()
  const x = ((clientX - rect.left) / rect.width) * 2 - 1
  const y = -((clientY - rect.top) / rect.height) * 2 + 1

  const raycaster = new THREE.Raycaster()
  raycaster.setFromCamera(new THREE.Vector2(x, y), camera)

  const hits = raycaster.intersectObject(contentGroup, true)
  if (!hits.length) return null

  const hit = hits[0]
  if (!hit.face) return null

  const normalWorld = hit.face.normal
    .clone()
    .transformDirection((hit.object as THREE.Mesh).matrixWorld)
    .normalize()

  const inside = hit.point.clone().addScaledVector(normalWorld, -NUDGE)

  const volume = buildVoxelVolume(def)
  const { sizeColumn, sizeRow, sizeZSlice } = volume

  let { column, voxelY, zSlice } = worldPointToVoxelIndices(inside, sizeColumn, sizeRow, sizeZSlice)
  let row = sizeRow - 1 - voxelY

  let id = effectiveBlockId(volume, column, row, zSlice, sizeRow, layerPreview)
  if (id === AIR) {
    const p2 = hit.point.clone().addScaledVector(normalWorld, -NUDGE * 4)
    ;({ column, voxelY, zSlice } = worldPointToVoxelIndices(p2, sizeColumn, sizeRow, sizeZSlice))
    row = sizeRow - 1 - voxelY
    id = effectiveBlockId(volume, column, row, zSlice, sizeRow, layerPreview)
  }

  if (id === AIR) return null
  return { blockId: id, column, row, zSlice }
}

export function pickBlockIdFromPointer(params: PickBlockIdParams): string | null {
  return pickVoxelFromPointer(params)?.blockId ?? null
}
