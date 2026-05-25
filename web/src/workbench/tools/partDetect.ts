// web/src/workbench/tools/partDetect.ts
// Thin wrappers: StructureDefinition → decoded quads → pure AABB functions.
import type { BakedQuad } from '@/render/schema/types'
import type { StructureDefinition } from '@/render/schema/types'
import { buildVoxelVolume } from '@/render/data/grid'
import { structureRowToWorldY } from '@/render/data/grid'
import { decodeBakedGeometry } from '@/render/mesh/bakedGeometryDecode'
import {
  computeQuadsAABB,
  findPartByNormal,
  findPartFromHit,
  ensureMinThickness,
  type Vec3,
} from '@/render/data/aabb'

export interface DetectedBounds {
  min: { x: number; y: number; z: number }
  max: { x: number; y: number; z: number }
  quadIndices: number[]
  totalQuads: number
}

function computeWorldOffset(
  col: number, row: number, zSlice: number,
  sizeCol: number, sizeRow: number, sizeZ: number,
): Vec3 {
  const voxelY = structureRowToWorldY(row, sizeRow)
  return {
    x: col - sizeCol / 2,
    y: voxelY - sizeRow / 2,
    z: zSlice - sizeZ / 2,
  }
}

function computeUnitBlockBounds(
  col: number, row: number, zSlice: number,
  sizeCol: number, sizeRow: number, sizeZ: number,
): DetectedBounds {
  const voxelY = structureRowToWorldY(row, sizeRow)
  const ox = col - sizeCol / 2
  const oy = voxelY - sizeRow / 2
  const oz = zSlice - sizeZ / 2
  return {
    min: { x: ox - 0.5, y: oy - 0.5, z: oz - 0.5 },
    max: { x: ox + 0.5, y: oy + 0.5, z: oz + 0.5 },
    quadIndices: [],
    totalQuads: 0,
  }
}

/**
 * Full-block or part-level AABB from a voxel hit.
 * If hitQuadIndex is given, expands to its part (standard: edge-adjacent; triangle: connected island).
 * Otherwise returns all quads.
 */
export function detectPartBounds(
  def: StructureDefinition,
  column: number,
  worldY: number,
  zSlice: number,
  hitQuadIndex: number | null,
): DetectedBounds | null {
  const volume = buildVoxelVolume(def)
  const { sizeColumn, sizeRow, sizeZSlice } = volume

  const cellGridRow = sizeRow - 1 - worldY

  const idx = def.cellGrid[zSlice]?.[cellGridRow]?.[column]
  if (idx === undefined || idx < 0 || idx >= def.blockPalette.length) return null

  const entry = def.blockPalette[idx]

  let quads: BakedQuad[]
  let hasGeometry = false
  try {
    if ('geometry' in entry && entry.geometry) {
      quads = decodeBakedGeometry(entry.geometry)
      hasGeometry = true
    } else {
      quads = []
    }
  } catch {
    quads = []
  }

  if (!hasGeometry || quads.length === 0) {
    return computeUnitBlockBounds(column, cellGridRow, zSlice, sizeColumn, sizeRow, sizeZSlice)
  }

  let indices: number[]
  if (hitQuadIndex !== null && hitQuadIndex >= 0 && hitQuadIndex < quads.length) {
    indices = findPartFromHit(hitQuadIndex, quads)
  } else {
    indices = Array.from({ length: quads.length }, (_, i) => i)
  }

  const offset = computeWorldOffset(column, cellGridRow, zSlice, sizeColumn, sizeRow, sizeZSlice)
  const aabb = computeQuadsAABB(quads, { indices, offset })

  return {
    min: aabb.min,
    max: aabb.max,
    quadIndices: indices,
    totalQuads: quads.length,
  }
}

/**
 * Face-level AABB from a voxel hit with known face normal.
 *
 * 1. Find the quad whose normal best matches the hit face normal
 * 2. Expand to its part:
 *    - Standard quad (4 vertices) → edge-adjacent BFS among standard quads
 *    - Triangle → vertex-connected BFS (full island)
 * 3. Ensure minimum thickness so the result is always a visible 3D box
 */
export function detectFaceBounds(
  def: StructureDefinition,
  column: number,
  worldY: number,
  zSlice: number,
  faceNormal: { x: number; y: number; z: number },
  quadIndex?: number,
): DetectedBounds | null {
  const volume = buildVoxelVolume(def)
  const { sizeColumn, sizeRow, sizeZSlice } = volume

  const cellGridRow = sizeRow - 1 - worldY

  const idx = def.cellGrid[zSlice]?.[cellGridRow]?.[column]
  if (idx === undefined || idx < 0 || idx >= def.blockPalette.length) return null

  const entry = def.blockPalette[idx]

  let quads: BakedQuad[]
  let hasGeometry = false
  try {
    if ('geometry' in entry && entry.geometry) {
      quads = decodeBakedGeometry(entry.geometry)
      hasGeometry = true
    } else {
      quads = []
    }
  } catch {
    quads = []
  }

  if (!hasGeometry || quads.length === 0) {
    return computeUnitBlockBounds(column, cellGridRow, zSlice, sizeColumn, sizeRow, sizeZSlice)
  }

  const worldOff = computeWorldOffset(column, cellGridRow, zSlice, sizeColumn, sizeRow, sizeZSlice)

  let indices: number[]
  if (quadIndex !== undefined && quadIndex >= 0 && quadIndex < quads.length) {
    // Direct hit: use the quadIndex from raycaster → triangleMap
    indices = findPartFromHit(quadIndex, quads)
  } else {
    // Fallback: match by face normal
    indices = findPartByNormal(quads, faceNormal)
  }

  const aabb = ensureMinThickness(computeQuadsAABB(quads, { indices, offset: worldOff }))

  return {
    min: aabb.min,
    max: aabb.max,
    quadIndices: indices,
    totalQuads: quads.length,
  }
}
