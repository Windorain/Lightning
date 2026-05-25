// Pure functions for annotation AABB computation.
// No Three.js, no StructureDefinition, no side effects.

// ── Types ──

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface QuadLike {
  vertices: Vec3[]
}

export interface AABB {
  min: Vec3
  max: Vec3
}

export interface BarDef {
  cx: number
  cy: number
  cz: number
  sx: number
  sy: number
  sz: number
}

const DEFAULT_VERTEX_THRESHOLD = 0.01

// ── AABB from quads ──

export interface ComputeQuadsAABBOpts {
  /** Which quad indices to include (default: all) */
  indices?: number[]
  /** World-space offset added to every vertex */
  offset?: Vec3
}

export function computeQuadsAABB(quads: QuadLike[], opts?: ComputeQuadsAABBOpts): AABB {
  const ox = opts?.offset?.x ?? 0
  const oy = opts?.offset?.y ?? 0
  const oz = opts?.offset?.z ?? 0
  const idxs = opts?.indices ?? Array.from({ length: quads.length }, (_, i) => i)

  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity

  for (const i of idxs) {
    for (const v of quads[i].vertices) {
      const wx = v.x + ox
      const wy = v.y + oy
      const wz = v.z + oz
      if (wx < minX) minX = wx
      if (wy < minY) minY = wy
      if (wz < minZ) minZ = wz
      if (wx > maxX) maxX = wx
      if (wy > maxY) maxY = wy
      if (wz > maxZ) maxZ = wz
    }
  }

  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
  }
}

// ── Wireframe vertices (24 floats: 8 corners → 12 line segments) ──

export function computeBoxWireframe(min: Vec3, max: Vec3): number[] {
  const x1 = min.x, y1 = min.y, z1 = min.z
  const x2 = max.x, y2 = max.y, z2 = max.z
  return [
    x1, y1, z1, x2, y1, z1, x2, y1, z1, x2, y2, z1, x2, y2, z1, x1, y2, z1, x1, y2, z1, x1, y1, z1,
    x1, y1, z2, x2, y1, z2, x2, y1, z2, x2, y2, z2, x2, y2, z2, x1, y2, z2, x1, y2, z2, x1, y1, z2,
    x1, y1, z1, x1, y1, z2, x2, y1, z1, x2, y1, z2, x2, y2, z1, x2, y2, z2, x1, y2, z1, x1, y2, z2,
  ]
}

// ── Box frame bars (12 bars, one per edge, with overlap at corners) ──

export function computeBoxFrameBars(min: Vec3, max: Vec3, halfThickness: number): BarDef[] {
  const t = halfThickness
  const defs: BarDef[] = []

  for (const y of [min.y, max.y]) {
    for (const z of [min.z, max.z]) {
      const len = max.x - min.x + t * 2
      defs.push({ cx: (min.x + max.x) / 2, cy: y, cz: z, sx: len, sy: t * 2, sz: t * 2 })
    }
  }
  for (const x of [min.x, max.x]) {
    for (const z of [min.z, max.z]) {
      const len = max.y - min.y + t * 2
      defs.push({ cx: x, cy: (min.y + max.y) / 2, cz: z, sx: t * 2, sy: len, sz: t * 2 })
    }
  }
  for (const x of [min.x, max.x]) {
    for (const y of [min.y, max.y]) {
      const len = max.z - min.z + t * 2
      defs.push({ cx: x, cy: y, cz: (min.z + max.z) / 2, sx: t * 2, sy: t * 2, sz: len })
    }
  }

  return defs
}

// ── Union AABB ──

export function computeUnionAABB(aabbs: AABB[]): AABB {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (const a of aabbs) {
    if (a.min.x < minX) minX = a.min.x
    if (a.min.y < minY) minY = a.min.y
    if (a.min.z < minZ) minZ = a.min.z
    if (a.max.x > maxX) maxX = a.max.x
    if (a.max.y > maxY) maxY = a.max.y
    if (a.max.z > maxZ) maxZ = a.max.z
  }
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } }
}

// ── AABB intersection ──

export function aabbsIntersect(a: AABB, b: AABB, tolerance = 0.001): boolean {
  if (a.max.x + tolerance < b.min.x || b.max.x + tolerance < a.min.x) return false
  if (a.max.y + tolerance < b.min.y || b.max.y + tolerance < a.min.y) return false
  if (a.max.z + tolerance < b.min.z || b.max.z + tolerance < a.min.z) return false
  return true
}

// ── Quad normal (from first 3 vertices) ──

export function computeQuadNormal(quad: QuadLike): Vec3 {
  const [v0, v1, v2] = quad.vertices
  const ax = v1.x - v0.x, ay = v1.y - v0.y, az = v1.z - v0.z
  const bx = v2.x - v0.x, by = v2.y - v0.y, bz = v2.z - v0.z
  const nx = by * az - bz * ay
  const ny = bz * ax - bx * az
  const nz = bx * ay - by * ax
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
  if (len < 1e-10) return { x: 0, y: 0, z: 0 }
  return { x: nx / len, y: ny / len, z: nz / len }
}

// ── Vertex sharing ──

export function quadsShareVertex(a: QuadLike, b: QuadLike, threshold = DEFAULT_VERTEX_THRESHOLD): boolean {
  for (const va of a.vertices) {
    for (const vb of b.vertices) {
      const dx = va.x - vb.x
      const dy = va.y - vb.y
      const dz = va.z - vb.z
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= threshold) {
        return true
      }
    }
  }
  return false
}

// ── Connected quad groups (BFS over shared vertices) ──

export function findConnectedQuadGroup(start: number, quads: QuadLike[]): number[] {
  const visited = new Set<number>()
  const queue: number[] = [start]
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


// ── Edge sharing (2+ shared vertices) ──

export function quadsShareEdge(a: QuadLike, b: QuadLike, threshold = DEFAULT_VERTEX_THRESHOLD): boolean {
  let shared = 0
  for (const va of a.vertices) {
    for (const vb of b.vertices) {
      const dx = va.x - vb.x
      const dy = va.y - vb.y
      const dz = va.z - vb.z
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= threshold) {
        shared++
        if (shared >= 2) return true
      }
    }
  }
  return false
}

// ── Edge-adjacent group (standard quads only, one-hop only) ──

/**
 * Find standard quads (4 vertices) that share an edge with the start quad.
 * One-hop only — no recursive BFS, to avoid leaking into adjacent parts.
 */
export function findEdgeAdjacentGroup(start: number, quads: QuadLike[]): number[] {
  const result = [start]
  for (let i = 0; i < quads.length; i++) {
    if (i === start) continue
    if (quads[i].vertices.length !== 4) continue
    if (quadsShareEdge(quads[start], quads[i])) {
      result.push(i)
    }
  }
  return result
}

// ── Part detection from a hit quad ──

/**
 * Given a hit quad index, expand to the part it belongs to:
 * - Standard quad (4 vertices) → edge-adjacent BFS among standard quads
 * - Triangle or non-standard → vertex-connected BFS (full island)
 */
export function findPartFromHit(start: number, quads: QuadLike[]): number[] {
  if (quads[start].vertices.length === 4) {
    return findEdgeAdjacentGroup(start, quads)
  }
  return findConnectedQuadGroup(start, quads)
}

/**
 * Find the quad whose normal best matches the given reference normal,
 * then expand to its part via findPartFromHit.
 * If hitPoint (local-space) is provided, uses it to disambiguate
 * between multiple quads with the same normal.
 * Falls back to all quads if no match found.
 */
export function findPartByNormal(
  quads: QuadLike[],
  referenceNormal: Vec3,
  hitPoint?: Vec3,
): number[] {
  // Collect all quads whose normal matches the reference
  const candidates: number[] = []
  for (let i = 0; i < quads.length; i++) {
    const n = computeQuadNormal(quads[i])
    if (n.x === 0 && n.y === 0 && n.z === 0) continue
    const dot = n.x * referenceNormal.x + n.y * referenceNormal.y + n.z * referenceNormal.z
    if (dot > 0.999) candidates.push(i)
  }

  if (candidates.length === 0) return Array.from({ length: quads.length }, (_, i) => i)

  // Pick the candidate closest to the hit point (if provided)
  let bestIndex = candidates[0]
  if (hitPoint && candidates.length > 1) {
    let bestDist = Infinity
    for (const i of candidates) {
      const verts = quads[i].vertices
      let cx = 0, cy = 0, cz = 0
      for (const v of verts) { cx += v.x; cy += v.y; cz += v.z }
      cx /= verts.length; cy /= verts.length; cz /= verts.length
      const dx = cx - hitPoint.x, dy = cy - hitPoint.y, dz = cz - hitPoint.z
      const dist = dx * dx + dy * dy + dz * dz
      if (dist < bestDist) { bestDist = dist; bestIndex = i }
    }
  }

  return findPartFromHit(bestIndex, quads)
}

// ── Minimum thickness ──

const MIN_THICKNESS = 0.1

/**
 * If an AABB is flat (thickness ≈ 0) in any axis, expand it
 * by half MIN_THICKNESS in both directions on that axis.
 */
export function ensureMinThickness(aabb: AABB): AABB {
  const dx = aabb.max.x - aabb.min.x
  const dy = aabb.max.y - aabb.min.y
  const dz = aabb.max.z - aabb.min.z

  const cx = (aabb.min.x + aabb.max.x) / 2
  const cy = (aabb.min.y + aabb.max.y) / 2
  const cz = (aabb.min.z + aabb.max.z) / 2

  const half = MIN_THICKNESS / 2
  return {
    min: {
      x: dx < 0.001 ? cx - half : aabb.min.x,
      y: dy < 0.001 ? cy - half : aabb.min.y,
      z: dz < 0.001 ? cz - half : aabb.min.z,
    },
    max: {
      x: dx < 0.001 ? cx + half : aabb.max.x,
      y: dy < 0.001 ? cy + half : aabb.max.y,
      z: dz < 0.001 ? cz + half : aabb.max.z,
    },
  }
}
