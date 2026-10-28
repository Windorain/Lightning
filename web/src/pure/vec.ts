/**
 * pure/vec.ts — Pure vector math utilities.
 * No side effects: no Vue refs, no DOM, no I/O, no mutation of arguments.
 */

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** Round each component of a 3D vector to the nearest integer */
export function roundVector(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: Math.round(v.x), y: Math.round(v.y), z: Math.round(v.z) }
}

/** String key from grid position, e.g. "1,2,3" */
export function posKey(pos: { x: number; y: number; z: number }): string {
  return `${pos.x},${pos.y},${pos.z}`
}

/** Compare two 2D positions within a tolerance using Euclidean distance */
export function isSamePosition(
  a: { x: number; y: number },
  b: { x: number; y: number },
  tolerance = 8,
): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < tolerance
}

/** Convert cellGrid row (0 = top) to world Y (0 = bottom) */
export function structureRowToWorldY(row: number, sizeRow: number): number {
  return sizeRow - 1 - row
}

/** Compute the world-space center of a voxel given its grid indices and dimensions */
export function voxelCenterWorld(
  column: number,
  structureRow: number,
  zSlice: number,
  sizeColumn: number,
  sizeRow: number,
  sizeZSlice: number,
  out?: Vec3,
): Vec3 {
  const y = structureRowToWorldY(structureRow, sizeRow)
  const v = out ?? { x: 0, y: 0, z: 0 }
  v.x = column + 0.5 - sizeColumn / 2
  v.y = y + 0.5 - sizeRow / 2
  v.z = zSlice + 0.5 - sizeZSlice / 2
  return v
}

