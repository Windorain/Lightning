/**
 * 面法线与体素索引空间邻接增量（ForgeDirection ↔ FaceName ↔ 世界外法线）。
 * 供 simpleMesh（外露判定 + 四边形）、initialCamera 共用。
 *
 * **ForgeDirection（MC 1.7 / Forge）↔ FaceName（轴符号）↔ 世界外法线**
 *
 * | ForgeDirection | FaceName | 外法线 |
 * |----------------|----------|--------|
 * | DOWN           | `-y`     | (0,-1,0) |
 * | UP             | `+y`     | (0,+1,0) |
 * | NORTH          | `-z`     | (0,0,-1) |
 * | SOUTH          | `+z`     | (0,0,+1) |
 * | WEST           | `-x`     | (-1,0,0) |
 * | EAST           | `+x`     | (+1,0,0) |
 *
 * 与 MyCTMLib `UVDomain` 分组一致：顶/底面 U↔X、V↔Z；南/北面 U↔X、V↔Y；东/西面 U↔Z、V↔Y。
 */

import * as THREE from 'three'

import type { FaceName } from '../schema/types'

/** 世界空间外法线（与 FaceName 一一对应；命名与 ForgeDirection 对齐见上表） */
export const FACE_NORMAL: Record<FaceName, THREE.Vector3> = {
  '+x': new THREE.Vector3(1, 0, 0),
  '-x': new THREE.Vector3(-1, 0, 0),
  '+y': new THREE.Vector3(0, 1, 0),
  '-y': new THREE.Vector3(0, -1, 0),
  '+z': new THREE.Vector3(0, 0, 1),
  '-z': new THREE.Vector3(0, 0, -1),
}

/**
 * 邻格在 (column, row, zSlice) 索引空间中的增量；
 * 顺序为 [dColumn, dRow, dZSlice]；row 与 `cellGrid[zSlice][row]` 一致（0=顶行）。
 * 世界 +Y 对应更小 row（行轴向下标增大 → 世界 Y 减小）。
 */
export const NEIGHBOR_STRUCTURE_DELTA: Record<FaceName, [number, number, number]> = {
  '+x': [1, 0, 0],
  '-x': [-1, 0, 0],
  '+y': [0, -1, 0],
  '-y': [0, 1, 0],
  '+z': [0, 0, 1],
  '-z': [0, 0, -1],
}
