/**
 * 单格单面四边形：与体素网格、物品栏 RTT 共用顶点/UV 约定。
 */

import * as THREE from 'three'

import { uv8ForFace } from './blockFaceUv'
import type { FaceName } from '../schema/types'

/** 导出供物品栏 RTT 单方块烘焙复用（与体素网格同一套顶点/UV 约定） */
export function quadGeometryForFace(
  face: FaceName,
  column: number,
  voxelY: number,
  zSlice: number,
  sizeColumn: number,
  sizeRow: number,
  sizeZSlice: number,
  normal: THREE.Vector3,
  layerIdx: number,
): THREE.BufferGeometry {
  const ox = 0.002 * layerIdx
  const push = normal.clone().multiplyScalar(ox)

  const minX = column - sizeColumn / 2
  const maxX = column + 1 - sizeColumn / 2
  const minY = voxelY - sizeRow / 2
  const maxY = voxelY + 1 - sizeRow / 2
  const minZ = zSlice - sizeZSlice / 2
  const maxZ = zSlice + 1 - sizeZSlice / 2

  const p = (v: THREE.Vector3) => v.add(push)

  let q0: THREE.Vector3
  let q1: THREE.Vector3
  let q2: THREE.Vector3
  let q3: THREE.Vector3

  switch (face) {
    case '+x':
      q0 = p(new THREE.Vector3(maxX, minY, maxZ))
      q1 = p(new THREE.Vector3(maxX, minY, minZ))
      q2 = p(new THREE.Vector3(maxX, maxY, minZ))
      q3 = p(new THREE.Vector3(maxX, maxY, maxZ))
      break
    case '-x':
      q0 = p(new THREE.Vector3(minX, maxY, maxZ))
      q1 = p(new THREE.Vector3(minX, maxY, minZ))
      q2 = p(new THREE.Vector3(minX, minY, minZ))
      q3 = p(new THREE.Vector3(minX, minY, maxZ))
      break
    case '+y':
      q0 = p(new THREE.Vector3(maxX, maxY, maxZ))
      q1 = p(new THREE.Vector3(maxX, maxY, minZ))
      q2 = p(new THREE.Vector3(minX, maxY, minZ))
      q3 = p(new THREE.Vector3(minX, maxY, maxZ))
      break
    case '-y':
      q0 = p(new THREE.Vector3(minX, minY, maxZ))
      q1 = p(new THREE.Vector3(minX, minY, minZ))
      q2 = p(new THREE.Vector3(maxX, minY, minZ))
      q3 = p(new THREE.Vector3(maxX, minY, maxZ))
      break
    case '+z':
      q0 = p(new THREE.Vector3(minX, maxY, maxZ))
      q1 = p(new THREE.Vector3(minX, minY, maxZ))
      q2 = p(new THREE.Vector3(maxX, minY, maxZ))
      q3 = p(new THREE.Vector3(maxX, maxY, maxZ))
      break
    case '-z':
      q0 = p(new THREE.Vector3(minX, maxY, minZ))
      q1 = p(new THREE.Vector3(maxX, maxY, minZ))
      q2 = p(new THREE.Vector3(maxX, minY, minZ))
      q3 = p(new THREE.Vector3(minX, minY, minZ))
      break
    default:
      throw new Error(`unknown face ${face}`)
  }

  const nx = normal.x
  const ny = normal.y
  const nz = normal.z

  const positions = new Float32Array([
    q0.x, q0.y, q0.z,
    q1.x, q1.y, q1.z,
    q2.x, q2.y, q2.z,
    q3.x, q3.y, q3.z,
  ])
  const normals = new Float32Array([
    nx, ny, nz,
    nx, ny, nz,
    nx, ny, nz,
    nx, ny, nz,
  ])
  const uvs = uv8ForFace(face)
  const index = new Uint16Array([0, 1, 2, 0, 2, 3])

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geo.setIndex(new THREE.BufferAttribute(index, 1))

  return geo
}
