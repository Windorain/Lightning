/**
 * 同一体素内共面且二维投影重叠（含包含）的烘焙片段聚类，用于 OBJ 多层材质合成（纯函数）。
 */

import type { BakedQuadGeometryPiece } from './structureGeometryCore'

const EPS_PLANE = 2e-4
const EPS_2D = 1e-5

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface Vec2 {
  x: number
  y: number
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

function len(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z)
}

function norm(v: Vec3): Vec3 {
  const L = len(v)
  if (L < 1e-20) return { x: 0, y: 1, z: 0 }
  return { x: v.x / L, y: v.y / L, z: v.z / L }
}

/** 单 piece 两枚三角 → 世界空间四角（顺序与 inVoxelQuadMerge 一致） */
export function quadWorldCornersFromPiece(piece: BakedQuadGeometryPiece): [Vec3, Vec3, Vec3, Vec3] | null {
  const pos = piece.positions
  if (pos.length < 18) return null
  const p0 = { x: pos[0]!, y: pos[1]!, z: pos[2]! }
  const p1 = { x: pos[3]!, y: pos[4]!, z: pos[5]! }
  const p2 = { x: pos[6]!, y: pos[7]!, z: pos[8]! }
  const q1 = { x: pos[9]!, y: pos[10]!, z: pos[11]! }
  const p3 = { x: pos[15]!, y: pos[16]!, z: pos[17]! }
  if (
    Math.hypot(p0.x - q1.x, p0.y - q1.y, p0.z - q1.z) > 1e-4 ||
    Math.hypot(p2.x - pos[12]!, p2.y - pos[13]!, p2.z - pos[14]!) > 1e-4
  ) {
    return null
  }
  return [p0, p1, p2, p3]
}

function planeFromQuad(c: [Vec3, Vec3, Vec3, Vec3]): { n: Vec3; o: Vec3; d: number } | null {
  const e1 = sub(c[1]!, c[0]!)
  const e2 = sub(c[2]!, c[0]!)
  const n0 = cross(e1, e2)
  const L = len(n0)
  if (L < 1e-14) return null
  const n = { x: n0.x / L, y: n0.y / L, z: n0.z / L }
  const o = c[0]!
  const d = dot(n, o)
  return { n, o, d }
}

function pointPlaneDist(p: Vec3, n: Vec3, d: number): number {
  return Math.abs(dot(n, p) - d)
}

function coplanarQuads(a: [Vec3, Vec3, Vec3, Vec3], b: [Vec3, Vec3, Vec3, Vec3]): boolean {
  const pl = planeFromQuad(a)
  if (!pl) return false
  for (const q of b) {
    if (pointPlaneDist(q, pl.n, pl.d) > EPS_PLANE) return false
  }
  return true
}

/** 由首 quad 建平面正交基：原点 o，轴 ex, ey（单位）；点投影为 (dot(p-o,ex), dot(p-o,ey)) */
export function planeBasisFromQuad(corners: [Vec3, Vec3, Vec3, Vec3]): { o: Vec3; ex: Vec3; ey: Vec3 } | null {
  const pl = planeFromQuad(corners)
  if (!pl) return null
  const e1 = sub(corners[1]!, corners[0]!)
  const ex0 = len(e1) < 1e-14 ? cross({ x: 0, y: 0, z: 1 }, pl.n) : e1
  const ex = norm(ex0)
  const ey = norm(cross(pl.n, ex))
  return { o: corners[0]!, ex, ey }
}

export function projectPointToSt(p: Vec3, basis: { o: Vec3; ex: Vec3; ey: Vec3 }): Vec2 {
  const r = sub(p, basis.o)
  return { x: dot(r, basis.ex), y: dot(r, basis.ey) }
}

function quad2DFromCorners(c: [Vec3, Vec3, Vec3, Vec3], basis: { o: Vec3; ex: Vec3; ey: Vec3 }): Vec2[] {
  return c.map((p) => projectPointToSt(p, basis))
}

/** 分离轴定理：两凸多边形是否相交（此处用于重叠，含边界/包含） */
function satOverlap(polyA: Vec2[], polyB: Vec2[]): boolean {
  const axes: Vec2[] = []
  function pushAxes(poly: Vec2[]): void {
    const n = poly.length
    for (let i = 0; i < n; i++) {
      const e = { x: poly[(i + 1) % n]!.x - poly[i]!.x, y: poly[(i + 1) % n]!.y - poly[i]!.y }
      const len = Math.hypot(e.x, e.y)
      if (len < 1e-14) continue
      const nx = -e.y / len
      const ny = e.x / len
      axes.push({ x: nx, y: ny })
    }
  }
  pushAxes(polyA)
  pushAxes(polyB)

  function project(poly: Vec2[], ax: Vec2): { min: number; max: number } {
    let mn = Infinity
    let mx = -Infinity
    for (const p of poly) {
      const t = p.x * ax.x + p.y * ax.y
      mn = Math.min(mn, t)
      mx = Math.max(mx, t)
    }
    return { min: mn, max: mx }
  }

  for (const ax of axes) {
    const pa = project(polyA, ax)
    const pb = project(polyB, ax)
    if (pa.max < pb.min - EPS_2D || pb.max < pa.min - EPS_2D) return false
  }
  return true
}

function quadsOverlap2D(
  cornersA: [Vec3, Vec3, Vec3, Vec3],
  cornersB: [Vec3, Vec3, Vec3, Vec3],
  basis: { o: Vec3; ex: Vec3; ey: Vec3 },
): boolean {
  const a2 = quad2DFromCorners(cornersA, basis)
  const b2 = quad2DFromCorners(cornersB, basis)
  return satOverlap(a2, b2)
}

export function piecesCoplanarAndOverlap(
  ia: BakedQuadGeometryPiece,
  ib: BakedQuadGeometryPiece,
  basisA: { o: Vec3; ex: Vec3; ey: Vec3 } | null,
): boolean {
  const ca = quadWorldCornersFromPiece(ia)
  const cb = quadWorldCornersFromPiece(ib)
  if (!ca || !cb) return false
  if (!coplanarQuads(ca, cb)) return false
  const basis = basisA ?? planeBasisFromQuad(ca)
  if (!basis) return false
  return quadsOverlap2D(ca, cb, basis)
}

/** Union-Find */
class DisjointSet {
  readonly p: number[]

  constructor(n: number) {
    this.p = Array.from({ length: n }, (_, i) => i)
  }

  find(i: number): number {
    if (this.p[i] !== i) this.p[i] = this.find(this.p[i]!)
    return this.p[i]!
  }

  union(a: number, b: number): void {
    let ra = this.find(a)
    let rb = this.find(b)
    if (ra === rb) return
    if (ra > rb) [ra, rb] = [rb, ra]
    this.p[rb] = ra
  }
}

/**
 * 单个体素内的片段：按共面 + 2D 重叠（含包含）聚类；返回若干 ID 列表，同簇需合成一张贴图。
 */
export function clusterCoplanarOverlappingPiecesInVoxel(
  pieces: BakedQuadGeometryPiece[],
): BakedQuadGeometryPiece[][] {
  const n = pieces.length
  if (n <= 1) {
    return n === 1 ? [[pieces[0]!]] : []
  }

  const corners: Array<[Vec3, Vec3, Vec3, Vec3] | null> = pieces.map((p) => quadWorldCornersFromPiece(p))
  const basisArr: Array<ReturnType<typeof planeBasisFromQuad> | null> = corners.map((c) =>
    c ? planeBasisFromQuad(c) : null,
  )

  const ds = new DisjointSet(n)
  for (let i = 0; i < n; i++) {
    if (!corners[i]) continue
    for (let j = i + 1; j < n; j++) {
      if (!corners[j]) continue
      if (
        piecesCoplanarAndOverlap(
          pieces[i]!,
          pieces[j]!,
          basisArr[i] ?? basisArr[j],
        )
      ) {
        ds.union(i, j)
      }
    }
  }

  const groups = new Map<number, BakedQuadGeometryPiece[]>()
  for (let i = 0; i < n; i++) {
    const r = ds.find(i)
    let arr = groups.get(r)
    if (!arr) {
      arr = []
      groups.set(r, arr)
    }
    arr.push(pieces[i]!)
  }

  return [...groups.values()].map((g) => [...g].sort((a, b) => a.quadOrder - b.quadOrder))
}
