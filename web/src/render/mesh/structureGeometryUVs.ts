/**
 * UV 坐标计算（纯函数）：从烘焙四边形顶点提取 UV 及顶点色。
 */

import { structureRowToWorldY } from '../data/grid'
import type { BakedQuad } from '../schema/types'

function rgbTripletFromMcTessellatorColor(packed: number | undefined): [number, number, number] {
  if (packed === undefined || !Number.isFinite(packed)) return [1, 1, 1]
  const u = packed >>> 0
  const r = (u & 0xff) / 255
  const g = ((u >>> 8) & 0xff) / 255
  const b = ((u >>> 16) & 0xff) / 255
  return [r, g, b]
}

/**
 * 单四边形 → 6 顶点 × (position3 + uv2 + color3)，与 {@link blockMesh} 原 `bufferGeometryFromBakedQuad` 数值一致。
 */
export function bakedQuadTriangleAttributesPure(
  quad: BakedQuad,
  col: number,
  row: number,
  zSlice: number,
  sizeColumn: number,
  sizeRow: number,
  sizeZSlice: number,
): { positions: Float32Array; uvs: Float32Array; colors: Float32Array } | null {
  const v = quad.vertices
  if (!v || v.length !== 4) return null
  const voxelY = structureRowToWorldY(row, sizeRow)
  const ox = col - sizeColumn / 2
  const oy = voxelY - sizeRow / 2
  const oz = zSlice - sizeZSlice / 2
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
      const p = v[i]
      positions[pi++] = p.x + ox
      positions[pi++] = p.y + oy
      positions[pi++] = p.z + oz
      uvs[ui++] = p.u
      uvs[ui++] = p.v
      const rgb = rgbTripletFromMcTessellatorColor(p.color)
      colors[ci++] = rgb[0]
      colors[ci++] = rgb[1]
      colors[ci++] = rgb[2]
    }
  }
  return { positions, uvs, colors }
}
