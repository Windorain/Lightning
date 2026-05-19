// web/src/workbench/tools/partDetect.ts
import type { BakedQuad } from '@/render/schema/types'
import type { StructureDefinition } from '@/render/schema/types'
import { buildVoxelVolume } from '@/render/data/grid'
import { structureRowToWorldY } from '@/render/data/grid'
import { decodeBakedGeometry } from '@/render/mesh/bakedGeometryDecode'

const VERTEX_THRESHOLD = 0.01

export interface PartBounds {
  min: { x: number; y: number; z: number }
  max: { x: number; y: number; z: number }
  quadCount: number
  totalQuads: number
}

/**
 * Detect the Part bounding box from a hit quad.
 * @param def Structure definition
 * @param column Grid column of the hit voxel
 * @param row Grid row of the hit voxel
 * @param zSlice Grid z-slice of the hit voxel
 * @param hitQuadIndex Index of the hit quad within the block's quad array, or null for full-block fallback
 * @returns PartBounds or null if no quads found
 */
export function detectPartBounds(
  def: StructureDefinition,
  column: number,
  row: number,
  zSlice: number,
  hitQuadIndex: number | null,
): PartBounds | null {
  // Step 1: Get block palette entry
  const idx = def.cellGrid[zSlice]?.[row]?.[column]
  if (idx === undefined || idx < 0 || idx >= def.blockPalette.length) return null

  const entry = def.blockPalette[idx]
  const volume = buildVoxelVolume(def)
  const { sizeColumn, sizeRow, sizeZSlice } = volume

  // Step 2: Resolve quads (geometry-based blocks only)
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

  // Step 3: Fallback — no geometry → unit block AABB from voxel position
  if (!hasGeometry || quads.length === 0) {
    return computeUnitBlockAABB(column, row, zSlice, sizeColumn, sizeRow, sizeZSlice)
  }

  // Step 4: Determine which quad indices to include
  let indices: number[]
  if (hitQuadIndex === null || hitQuadIndex < 0 || hitQuadIndex >= quads.length) {
    indices = Array.from({ length: quads.length }, (_, i) => i)
  } else {
    indices = findConnectedQuadGroup(hitQuadIndex, quads)
  }

  return computeWorldAABB(quads, indices, column, row, zSlice, sizeColumn, sizeRow, sizeZSlice)
}

/** BFS to find all quads connected to the start quad via shared vertices */
function findConnectedQuadGroup(start: number, quads: BakedQuad[]): number[] {
  const visited = new Set<number>()
  const queue = [start]
  visited.add(start)

  while (queue.length > 0) {
    const ci = queue.shift()!
    for (let i = 0; i < quads.length; i++) {
      if (visited.has(i)) continue
      if (quadsShareVertex(quads[ci], quads[i])) {
        visited.add(i)
        queue.push(i)
      }
    }
  }

  return [...visited]
}

/** Two quads are connected if they share at least one vertex within threshold */
function quadsShareVertex(a: BakedQuad, b: BakedQuad): boolean {
  for (const va of a.vertices) {
    for (const vb of b.vertices) {
      const dx = va.x - vb.x
      const dy = va.y - vb.y
      const dz = va.z - vb.z
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= VERTEX_THRESHOLD) {
        return true
      }
    }
  }
  return false
}

/** Compute unit (1x1x1) block AABB for entries without geometry */
function computeUnitBlockAABB(
  col: number, row: number, zSlice: number,
  sizeCol: number, sizeRow: number, sizeZ: number,
): PartBounds {
  const voxelY = structureRowToWorldY(row, sizeRow)
  const ox = col - sizeCol / 2
  const oy = voxelY - sizeRow / 2
  const oz = zSlice - sizeZ / 2
  return {
    min: { x: ox - 0.5, y: oy - 0.5, z: oz - 0.5 },
    max: { x: ox + 0.5, y: oy + 0.5, z: oz + 0.5 },
    quadCount: 0,
    totalQuads: 0,
  }
}

/** Compute world-space AABB from quad vertices */
function computeWorldAABB(
  quads: BakedQuad[],
  indices: number[],
  col: number, row: number, zSlice: number,
  sizeCol: number, sizeRow: number, sizeZ: number,
): PartBounds {
  // Convert grid position to world offset
  const voxelY = structureRowToWorldY(row, sizeRow)
  const ox = col - sizeCol / 2
  const oy = voxelY - sizeRow / 2
  const oz = zSlice - sizeZ / 2

  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity

  for (const i of indices) {
    for (const v of quads[i].vertices) {
      const wx = v.x + ox
      const wy = v.y + oy
      const wz = v.z + oz
      if (wx < minX) minX = wx; if (wy < minY) minY = wy; if (wz < minZ) minZ = wz
      if (wx > maxX) maxX = wx; if (wy > maxY) maxY = wy; if (wz > maxZ) maxZ = wz
    }
  }

  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
    quadCount: indices.length,
    totalQuads: quads.length,
  }
}
