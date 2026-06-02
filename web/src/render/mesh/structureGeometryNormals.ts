/**
 * 法线向量计算（纯函数）：从烘焙四边形顶点计算外向世界空间面方向。
 */

import { structureRowToWorldY } from '../data/grid'
import { vec3ToFaceNameComponents } from './facingMap'
import type { BakedQuad, FaceName } from '../schema/types'

/** 外向世界空间面（用于遮挡与域剔除）；与烘焙四边形法线一致 */
export function outwardWorldFaceFromBakedQuadPure(
  quad: BakedQuad,
  col: number,
  row: number,
  zSlice: number,
  sizeColumn: number,
  sizeRow: number,
  sizeZSlice: number,
): FaceName | null {
  const v = quad.vertices
  if (!v || v.length !== 4) return null
  const voxelY = structureRowToWorldY(row, sizeRow)
  const ox = col - sizeColumn / 2
  const oy = voxelY - sizeRow / 2
  const oz = zSlice - sizeZSlice / 2
  const bcx = ox + 0.5
  const bcy = oy + 0.5
  const bcz = oz + 0.5

  const cx: number[] = []
  const cy: number[] = []
  const cz: number[] = []
  for (let i = 0; i < 4; i++) {
    cx.push(v[i].x + ox)
    cy.push(v[i].y + oy)
    cz.push(v[i].z + oz)
  }

  const e1x = cx[1]! - cx[0]!
  const e1y = cy[1]! - cy[0]!
  const e1z = cz[1]! - cz[0]!
  const e2x = cx[2]! - cx[0]!
  const e2y = cy[2]! - cy[0]!
  const e2z = cz[2]! - cz[0]!
  let nx = e1y * e2z - e1z * e2y
  let ny = e1z * e2x - e1x * e2z
  let nz = e1x * e2y - e1y * e2x
  const nlen = Math.hypot(nx, ny, nz)
  if (nlen < 1e-12) return null
  nx /= nlen
  ny /= nlen
  nz /= nlen

  const qcx = (cx[0]! + cx[1]! + cx[2]! + cx[3]!) * 0.25
  const qcy = (cy[0]! + cy[1]! + cy[2]! + cy[3]!) * 0.25
  const qcz = (cz[0]! + cz[1]! + cz[2]! + cz[3]!) * 0.25
  const vx = qcx - bcx
  const vy = qcy - bcy
  const vz = qcz - bcz
  if (nx * vx + ny * vy + nz * vz < 0) {
    nx = -nx
    ny = -ny
    nz = -nz
  }
  return vec3ToFaceNameComponents(nx, ny, nz)
}
