/**
 * pure/meshTypes.ts — Pure mesh type definitions.
 * No framework dependencies: no Three.js, no Vue, no DOM, no I/O.
 */

import type { MaterialPaletteEntry } from '@/pure/materialTypes'

/** 单个烘焙四边形对应的 2 个三角形（非索引、每属性定长） */
export interface BakedQuadGeometryPiece {
  col: number
  row: number
  zSlice: number
  materialIndex: number
  quadOrder: number
  /** 该 quad 在体素解码后 quads[] 数组中的索引 */
  quadIndex: number
  matPalette: MaterialPaletteEntry
  positions: Float32Array
  uvs: Float32Array
  colors: Float32Array
}
