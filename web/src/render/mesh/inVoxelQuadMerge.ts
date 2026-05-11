/**
 * 体素内（同一材质桶）烘焙 Quad 合并：共面且邻接边 UV 一致时可合并为更少三角形（纯函数）。
 */

import { mergeBakedQuadPiecesAttributes, type BakedQuadGeometryPiece } from './structureGeometryCore'

const EPS_POS = 1e-5
const EPS_UV = 1e-4

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface CornersAndAttrs {
  /** 四边形环序在世界空间的角点 */
  pos: [Vec3, Vec3, Vec3, Vec3]
  uv: [number, number, number, number, number, number, number, number]
  color: [Vec3, Vec3, Vec3, Vec3]
}

function nearEq(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps
}

function samePos(a: Vec3, b: Vec3): boolean {
  return nearEq(a.x, b.x, EPS_POS) && nearEq(a.y, b.y, EPS_POS) && nearEq(a.z, b.z, EPS_POS)
}

/** 从单 piece 的两枚三角形还原四角（与 bakedQuadTriangleAttributesPure 展开序一致） */
export function extractQuadCornersFromPiece(piece: BakedQuadGeometryPiece): CornersAndAttrs | null {
  const pos = piece.positions
  const uvs = piece.uvs
  const colors = piece.colors
  if (pos.length < 18 || uvs.length < 12 || colors.length < 18) return null

  const p0 = { x: pos[0]!, y: pos[1]!, z: pos[2]! }
  const p1 = { x: pos[3]!, y: pos[4]!, z: pos[5]! }
  const p2 = { x: pos[6]!, y: pos[7]!, z: pos[8]! }
  const q1 = { x: pos[9]!, y: pos[10]!, z: pos[11]! }
  const q2 = { x: pos[12]!, y: pos[13]!, z: pos[14]! }
  const p3 = { x: pos[15]!, y: pos[16]!, z: pos[17]! }

  if (!samePos(p0, q1) || !samePos(p2, q2)) return null

  const c0 = { x: colors[0]!, y: colors[1]!, z: colors[2]! }
  const c1 = { x: colors[3]!, y: colors[4]!, z: colors[5]! }
  const c2 = { x: colors[6]!, y: colors[7]!, z: colors[8]! }
  const c3 = { x: colors[15]!, y: colors[16]!, z: colors[17]! }

  return {
    pos: [p0, p1, p2, p3],
    uv: [uvs[0]!, uvs[1]!, uvs[2]!, uvs[3]!, uvs[4]!, uvs[5]!, uvs[6]!, uvs[7]!],
    color: [c0, c1, c2, c3],
  }
}

function uvPairClose(
  ua: number,
  va: number,
  ub: number,
  vb: number,
): boolean {
  return nearEq(ua, ub, EPS_UV) && nearEq(va, vb, EPS_UV)
}

/** 两条无向边是否重合（端点一致） */
function edgesMatch(a0: Vec3, a1: Vec3, b0: Vec3, b1: Vec3): boolean {
  return (samePos(a0, b0) && samePos(a1, b1)) || (samePos(a0, b1) && samePos(a1, b0))
}

/** 边 UV 是否一致（按端点顺序或反向） */
function edgeUvCompatible(
  q: CornersAndAttrs,
  edgeIdx: 0 | 1 | 2 | 3,
  r: CornersAndAttrs,
  edgeIdx2: 0 | 1 | 2 | 3,
): boolean {
  const e = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
  ] as const
  const [ia0, ia1] = e[edgeIdx]!
  const [ib0, ib1] = e[edgeIdx2]!
  const p0 = q.pos[ia0]!
  const p1 = q.pos[ia1]!
  const u00 = q.uv[ia0 * 2]!
  const v00 = q.uv[ia0 * 2 + 1]!
  const u01 = q.uv[ia1 * 2]!
  const v01 = q.uv[ia1 * 2 + 1]!
  const r0 = r.pos[ib0]!
  const r1 = r.pos[ib1]!
  const u10 = r.uv[ib0 * 2]!
  const v10 = r.uv[ib0 * 2 + 1]!
  const u11 = r.uv[ib1 * 2]!
  const v11 = r.uv[ib1 * 2 + 1]!
  if (samePos(p0, r0) && samePos(p1, r1)) {
    return uvPairClose(u00, v00, u10, v10) && uvPairClose(u01, v01, u11, v11)
  }
  if (samePos(p0, r1) && samePos(p1, r0)) {
    return uvPairClose(u00, v00, u11, v11) && uvPairClose(u01, v01, u10, v10)
  }
  return false
}

/**
 * 尝试将共享一条边且 UV 沿边一致的两枚四边形合并为一枚（仍为凸四边形）。
 */
function tryMergeQuadPair(q: CornersAndAttrs, r: CornersAndAttrs): CornersAndAttrs | null {
  for (let eq = 0 as 0 | 1 | 2 | 3; eq < 4; eq++) {
    const e = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
    ][eq]!
    const qa0 = q.pos[e[0] as 0 | 1 | 2 | 3]!
    const qa1 = q.pos[e[1] as 0 | 1 | 2 | 3]!
    for (let er = 0 as 0 | 1 | 2 | 3; er < 4; er++) {
      const f = [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
      ][er]!
      const rb0 = r.pos[f[0] as 0 | 1 | 2 | 3]!
      const rb1 = r.pos[f[1] as 0 | 1 | 2 | 3]!
      if (!edgesMatch(qa0, qa1, rb0, rb1)) continue
      if (!edgeUvCompatible(q, eq, r, er)) continue

      /* 合并：取并集角点（最多 6 个）；若恰为 4 点则成单四边形 */
      const pts: Vec3[] = [...q.pos, ...r.pos]
      const uniq: Vec3[] = []
      for (const p of pts) {
        if (!uniq.some((u) => samePos(u, p))) uniq.push(p)
      }
      if (uniq.length !== 4) continue

      /* 在平面上按角序排列四个点（用 PCA 近似：取中心，按 atan2） */
      const cx = uniq.reduce((s, p) => s + p.x, 0) / 4
      const cy = uniq.reduce((s, p) => s + p.y, 0) / 4
      const cz = uniq.reduce((s, p) => s + p.z, 0) / 4
      const n = normalFromQuad(q.pos[0]!, q.pos[1]!, q.pos[2]!)
      if (!n) continue
      const { ax, ay, az, bx, by, bz } = orthonormalBasis(n)
      const proj = (p: Vec3) => {
        const dx = p.x - cx
        const dy = p.y - cy
        const dz = p.z - cz
        return { u: dx * ax + dy * ay + dz * az, v: dx * bx + dy * by + dz * bz }
      }
      const sorted = [...uniq].sort((pa, pb) => {
        const ua = proj(pa)
        const ub = proj(pb)
        const aa = Math.atan2(ua.v, ua.u)
        const ab = Math.atan2(ub.v, ub.u)
        return aa - ab
      })

      const matchCorner = (p: Vec3): { pos: Vec3; uv: [number, number]; col: Vec3 } | null => {
        const sources: CornersAndAttrs[] = [q, r]
        for (const src of sources) {
          for (let i = 0; i < 4; i++) {
            if (samePos(p, src.pos[i]!)) {
              return {
                pos: src.pos[i]!,
                uv: [src.uv[i * 2]!, src.uv[i * 2 + 1]!],
                col: src.color[i]!,
              }
            }
          }
        }
        return null
      }

      const ring: CornersAndAttrs['pos'] = [
        sorted[0]!,
        sorted[1]!,
        sorted[2]!,
        sorted[3]!,
      ]
      const outUv: number[] = []
      const outCol: Vec3[] = []
      for (const p of ring) {
        const m = matchCorner(p)
        if (!m) return null
        outUv.push(m.uv[0]!, m.uv[1]!)
        outCol.push(m.col)
      }

      return {
        pos: ring,
        uv: outUv as [number, number, number, number, number, number, number, number],
        color: [outCol[0]!, outCol[1]!, outCol[2]!, outCol[3]!],
      }
    }
  }
  return null
}

function normalFromQuad(a: Vec3, b: Vec3, c: Vec3): { nx: number; ny: number; nz: number } | null {
  const e1x = b.x - a.x
  const e1y = b.y - a.y
  const e1z = b.z - a.z
  const e2x = c.x - a.x
  const e2y = c.y - a.y
  const e2z = c.z - a.z
  let nx = e1y * e2z - e1z * e2y
  let ny = e1z * e2x - e1x * e2z
  let nz = e1x * e2y - e1y * e2x
  const len = Math.hypot(nx, ny, nz)
  if (len < 1e-14) return null
  return { nx: nx / len, ny: ny / len, nz: nz / len }
}

function orthonormalBasis(n: { nx: number; ny: number; nz: number }): {
  ax: number
  ay: number
  az: number
  bx: number
  by: number
  bz: number
} {
  let ax = 1
  let ay = 0
  let az = 0
  if (Math.abs(n.ny) < 0.9) {
    /* cross n x (0,1,0) */
    ax = -n.nz
    ay = 0
    az = n.nx
  } else {
    ax = 0
    ay = n.nz
    az = -n.ny
  }
  const alen = Math.hypot(ax, ay, az)
  ax /= alen
  ay /= alen
  az /= alen
  /* b = n x a */
  const bx = n.ny * az - n.nz * ay
  const by = n.nz * ax - n.nx * az
  const bz = n.nx * ay - n.ny * ax
  const blen = Math.hypot(bx, by, bz)
  return {
    ax,
    ay,
    az,
    bx: bx / blen,
    by: by / blen,
    bz: bz / blen,
  }
}

function quadToTriangles(c: CornersAndAttrs): { positions: Float32Array; uvs: Float32Array; colors: Float32Array } {
  const positions = new Float32Array(18)
  const uvs = new Float32Array(12)
  const colors = new Float32Array(18)
  const triCorners = [
    [0, 1, 2],
    [0, 2, 3],
  ] as const
  let pi = 0
  let ui = 0
  let ci = 0
  for (const [i0, i1, i2] of triCorners) {
    for (const i of [i0, i1, i2]) {
      const p = c.pos[i]!
      positions[pi++] = p.x
      positions[pi++] = p.y
      positions[pi++] = p.z
      uvs[ui++] = c.uv[i * 2]!
      uvs[ui++] = c.uv[i * 2 + 1]!
      const col = c.color[i]!
      colors[ci++] = col.x
      colors[ci++] = col.y
      colors[ci++] = col.z
    }
  }
  return { positions, uvs, colors }
}

/**
 * 同一体素×材质下的片段：反复合并邻接共边四边形，失败则保留三角化结果。
 */
export function mergeBakedQuadsWithinVoxelBucket(pieces: BakedQuadGeometryPiece[]): {
  positions: Float32Array
  uvs: Float32Array
  colors: Float32Array
} {
  if (pieces.length === 0) {
    return { positions: new Float32Array(0), uvs: new Float32Array(0), colors: new Float32Array(0) }
  }
  if (pieces.length === 1) {
    const ex = extractQuadCornersFromPiece(pieces[0]!)
    if (!ex) return mergeBakedQuadPiecesAttributes(pieces)
    return quadToTriangles(ex)
  }

  const quads: CornersAndAttrs[] = []
  const leftover: BakedQuadGeometryPiece[] = []
  for (const p of pieces) {
    const ex = extractQuadCornersFromPiece(p)
    if (ex) quads.push(ex)
    else leftover.push(p)
  }

  let changed = true
  while (changed && quads.length > 1) {
    changed = false
    outer: for (let i = 0; i < quads.length; i++) {
      for (let j = i + 1; j < quads.length; j++) {
        const merged = tryMergeQuadPair(quads[i]!, quads[j]!)
        if (merged) {
          quads.splice(j, 1)
          quads.splice(i, 1)
          quads.push(merged)
          changed = true
          break outer
        }
      }
    }
  }

  if (quads.length === 0) {
    return mergeBakedQuadPiecesAttributes(leftover)
  }

  const template = pieces[0]!
  const parts: BakedQuadGeometryPiece[] = [...leftover]
  for (const q of quads) {
    const tri = quadToTriangles(q)
    parts.push({
      ...template,
      quadOrder: 0,
      positions: tri.positions,
      uvs: tri.uvs,
      colors: tri.colors,
    })
  }
  return mergeBakedQuadPiecesAttributes(parts)
}
