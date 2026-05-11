/**
 * 共面重叠 Quad 的材质栅格叠化（MC quadOrder 越早越先画、越大越后画），浏览器适配层。
 * 像素合成：按 quadOrder 从底到顶做 source-over alpha 混合（与「仅取最大 quadOrder 一层」不同）。
 */

import type { MaterialPaletteEntry, StructureDefinition } from '@/render/schema/types'
import type { BakedQuadGeometryPiece } from '@/render/mesh/structureGeometryCore'
import {
  planeBasisFromQuad,
  projectPointToSt,
  quadWorldCornersFromPiece,
  type Vec2,
  type Vec3,
} from '@/render/mesh/coplanarOverlapCluster'
import { textureBlobToFirstFramePngBlob } from '@/workbench/textureAtlasRaster'

const MIN_TEX = 16
const MAX_TEX = 512
const PIXELS_PER_UNIT = 64

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function bboxCorners2D(poly: Vec2[]): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of poly) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  return { minX, maxX, minY, maxY }
}

/** 点是否在凸四边形内（三角剖分 + 重心） */
function pointInQuad2D(q: Vec2[], p: Vec2): boolean {
  function inTri(a: Vec2, b: Vec2, c: Vec2, pt: Vec2): boolean {
    const sign = (p1: Vec2, p2: Vec2, p3: Vec2) =>
      (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y)
    const d1 = sign(pt, a, b)
    const d2 = sign(pt, b, c)
    const d3 = sign(pt, c, a)
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0
    return !(hasNeg && hasPos)
  }
  return inTri(q[0]!, q[1]!, q[2]!, p) || inTri(q[0]!, q[2]!, q[3]!, p)
}

/** 凸四边形内一点相对四角的双线性逆不够通用；拆成两三角形重心插值 UV */
function uvForSTInQuad(
  stCorners: Vec2[],
  uv8: number[],
  st: Vec2,
): { u: number; v: number } | null {
  if (!pointInQuad2D(stCorners, st)) return null

  function interpTri(
    a: Vec2,
    b: Vec2,
    c: Vec2,
    ua: number,
    va: number,
    ub: number,
    vb: number,
    uc: number,
    vc: number,
    pt: Vec2,
  ): { u: number; v: number } | null {
    const v0x = b.x - a.x
    const v0y = b.y - a.y
    const v1x = c.x - a.x
    const v1y = c.y - a.y
    const v2x = pt.x - a.x
    const v2y = pt.y - a.y
    const den = v0x * v1y - v1x * v0y
    if (Math.abs(den) < 1e-14) return null
    const w1 = (v2x * v1y - v1x * v2y) / den
    const w2 = (v0x * v2y - v2x * v0y) / den
    const w0 = 1 - w1 - w2
    if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) return null
    return {
      u: w0 * ua + w1 * ub + w2 * uc,
      v: w0 * va + w1 * vb + w2 * vc,
    }
  }

  const uvs = [
    [uv8[0]!, uv8[1]!],
    [uv8[2]!, uv8[3]!],
    [uv8[4]!, uv8[5]!],
    [uv8[6]!, uv8[7]!],
  ]
  let r = interpTri(
    stCorners[0]!,
    stCorners[1]!,
    stCorners[2]!,
    uvs[0]![0]!,
    uvs[0]![1]!,
    uvs[1]![0]!,
    uvs[1]![1]!,
    uvs[2]![0]!,
    uvs[2]![1]!,
    st,
  )
  if (r) return r
  r = interpTri(
    stCorners[0]!,
    stCorners[2]!,
    stCorners[3]!,
    uvs[0]![0]!,
    uvs[0]![1]!,
    uvs[2]![0]!,
    uvs[2]![1]!,
    uvs[3]![0]!,
    uvs[3]![1]!,
    st,
  )
  return r
}

async function imageBitmapFromBlobPng(blob: Blob): Promise<ImageBitmap> {
  return await createImageBitmap(blob)
}

/** Forge v：0=贴图顶行；ImageData 行为 y 向下 */
function sampleImageForgeNearest(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  u: number,
  vForge: number,
): [number, number, number, number] {
  const x = clamp(Math.round(u * (w - 1)), 0, w - 1)
  const y = clamp(Math.round(vForge * (h - 1)), 0, h - 1)
  const o = (y * w + x) * 4
  return [data[o]!, data[o + 1]!, data[o + 2]!, data[o + 3]!]
}

/** Porter–Duff source-over：src 叠在 dst 之上（直通道 RGBA，与 Canvas 一致） */
function blendSourceOverStraight(
  dst: [number, number, number, number],
  src: [number, number, number, number],
): void {
  const sr = src[0] / 255
  const sg = src[1] / 255
  const sb = src[2] / 255
  const sa = src[3] / 255
  const dr = dst[0] / 255
  const dg = dst[1] / 255
  const db = dst[2] / 255
  const da = dst[3] / 255
  const oa = sa + da * (1.0 - sa)
  const or = sr * sa + dr * da * (1.0 - sa)
  const og = sg * sa + dg * da * (1.0 - sa)
  const ob = sb * sa + db * da * (1.0 - sa)
  if (oa <= 1e-8) {
    dst[0] = 0
    dst[1] = 0
    dst[2] = 0
    dst[3] = 0
    return
  }
  dst[0] = clamp(Math.round((or / oa) * 255), 0, 255)
  dst[1] = clamp(Math.round((og / oa) * 255), 0, 255)
  dst[2] = clamp(Math.round((ob / oa) * 255), 0, 255)
  dst[3] = clamp(Math.round(oa * 255), 0, 255)
}

export interface CompositeCoplanarResult {
  pngBlob: Blob
  pngFileName: string
  width: number
  height: number
  minS: number
  maxS: number
  minT: number
  maxT: number
  /** 已写入相对合并纹理的 UV */
  mergedPieces: BakedQuadGeometryPiece[]
}

/**
 * 将同一聚类内 Quad 按 quadOrder 从底层到顶层叠画到一张纹理；几何顶点不变，仅重写 UV。
 */
export async function compositeCoplanarCluster(
  cluster: BakedQuadGeometryPiece[],
  def: StructureDefinition,
  blobs: string[],
  mergedId: number,
): Promise<CompositeCoplanarResult> {
  if (cluster.length === 0) throw new Error('compositeCoplanarCluster: 空聚类')

  const sorted = [...cluster].sort((a, b) => a.quadOrder - b.quadOrder)

  const cornersList: Array<[Vec3, Vec3, Vec3, Vec3] | null> = sorted.map((p) => quadWorldCornersFromPiece(p))
  const firstCorners = cornersList[0]!
  if (!firstCorners) throw new Error('compositeCoplanarCluster: 无法解析四角')

  const basis = planeBasisFromQuad(firstCorners)
  if (!basis) throw new Error('compositeCoplanarCluster: 无法建立平面基')

  const all2d: Vec2[] = []
  for (let i = 0; i < sorted.length; i++) {
    const c = cornersList[i]
    if (!c) continue
    for (const p of c) {
      all2d.push(projectPointToSt(p, basis))
    }
  }
  const bb = bboxCorners2D(all2d)
  const spanX = Math.max(bb.maxX - bb.minX, 1e-8)
  const spanY = Math.max(bb.maxY - bb.minY, 1e-8)

  let texW = Math.ceil(spanX * PIXELS_PER_UNIT)
  let texH = Math.ceil(spanY * PIXELS_PER_UNIT)
  texW = clamp(texW, MIN_TEX, MAX_TEX)
  texH = clamp(texH, MIN_TEX, MAX_TEX)

  const minS = bb.minX
  const maxS = bb.maxX
  const minT = bb.minY
  const maxT = bb.maxY

  const canvas = document.createElement('canvas')
  canvas.width = texW
  canvas.height = texH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D 不可用')
  ctx.clearRect(0, 0, texW, texH)

  const imageData = ctx.createImageData(texW, texH)
  const dst = imageData.data

  /** 每个 piece 的 ST 四角与 UV 角（从 positions/uvs 提取） */
  type LayerInfo = {
    piece: BakedQuadGeometryPiece
    stQ: Vec2[]
    uv8: number[]
    img: { data: Uint8ClampedArray; w: number; h: number }
  }

  const layers: LayerInfo[] = []
  for (let i = 0; i < sorted.length; i++) {
    const piece = sorted[i]!
    const c = cornersList[i]
    if (!c) continue
    const stQ = c.map((p) => projectPointToSt(p, basis))
    const uvs = piece.uvs
    /** 四角 p0,p1,p2,p3 与 quadWorldCornersFromPiece 一致 */
    const uv8 = [uvs[0]!, uvs[1]!, uvs[2]!, uvs[3]!, uvs[4]!, uvs[5]!, uvs[10]!, uvs[11]!]
    const ent = def.materialPalette[piece.materialIndex]
    const bidx =
      ent && typeof ent.textureBlobIndex === 'number' ? Math.floor(ent.textureBlobIndex) : -1
    if (bidx < 0 || !blobs[bidx]) continue

    const raw = blobs[bidx] as string
    const rep = ent
    const png = await textureBlobToFirstFramePngBlob(raw, rep)
    const bmp = await imageBitmapFromBlobPng(png)
    const off = document.createElement('canvas')
    off.width = bmp.width
    off.height = bmp.height
    const ox = off.getContext('2d')!
    ox.drawImage(bmp, 0, 0)
    const id = ox.getImageData(0, 0, off.width, off.height)

    layers.push({
      piece,
      stQ,
      uv8,
      img: { data: id.data, w: off.width, h: off.height },
    })
  }

  for (let iy = 0; iy < texH; iy++) {
    for (let ix = 0; ix < texW; ix++) {
      const st: Vec2 = {
        x: minS + ((ix + 0.5) / texW) * (maxS - minS),
        y: minT + ((iy + 0.5) / texH) * (maxT - minT),
      }

      const di = (iy * texW + ix) * 4
      const acc: [number, number, number, number] = [0, 0, 0, 0]
      for (const L of layers) {
        if (!pointInQuad2D(L.stQ, st)) continue
        const uv = uvForSTInQuad(L.stQ, L.uv8, st)
        if (!uv) continue
        const s = sampleImageForgeNearest(L.img.data, L.img.w, L.img.h, uv.u, uv.v)
        blendSourceOverStraight(acc, s)
      }
      dst[di] = acc[0]!
      dst[di + 1] = acc[1]!
      dst[di + 2] = acc[2]!
      dst[di + 3] = acc[3]!
    }
  }

  ctx.putImageData(imageData, 0, 0)

  const pngBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png')
  })

  const mergedPieces: BakedQuadGeometryPiece[] = sorted.map((piece) => {
    const c = quadWorldCornersFromPiece(piece)
    if (!c) return piece

    const newUvs = new Float32Array(piece.uvs.length)
    const nVert = piece.positions.length / 3
    for (let vi = 0; vi < nVert; vi++) {
      const px = piece.positions[vi * 3]!
      const py = piece.positions[vi * 3 + 1]!
      const pz = piece.positions[vi * 3 + 2]!
      const st = projectPointToSt({ x: px, y: py, z: pz }, basis)
      const uTex = (st.x - minS) / (maxS - minS)
      const vTex = (st.y - minT) / (maxT - minT)
      newUvs[vi * 2] = uTex
      newUvs[vi * 2 + 1] = vTex
    }
    return { ...piece, uvs: newUvs }
  })

  return {
    pngBlob,
    pngFileName: `textures/merged_coplanar_${mergedId}.png`,
    width: texW,
    height: texH,
    minS,
    maxS,
    minT,
    maxT,
    mergedPieces,
  }
}

/** 为 MTL 选择叠化后代表混合模式（任一为 translucent 则 translucent） */
export function mergedMaterialBlendForCluster(
  cluster: BakedQuadGeometryPiece[],
  def: StructureDefinition,
): MaterialPaletteEntry | undefined {
  let anyTranslucent = false
  for (const p of cluster) {
    const e = def.materialPalette[p.materialIndex]
    if (e?.blend === 'translucent') anyTranslucent = true
  }
  const first = def.materialPalette[cluster[0]!.materialIndex]
  if (!first) return undefined
  return {
    ...first,
    blend: anyTranslucent ? 'translucent' : 'opaque',
  }
}
