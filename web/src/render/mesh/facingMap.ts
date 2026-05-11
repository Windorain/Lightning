/**
 * 注册表按「正面朝北 -z」烘焙时的方向工具（如 Model 体素绕中心旋转）。
 * 终态 `geometryPhase=baked` 的 BakedQuads 在 `blockMesh` 中按捕获几何原样放置，不经此处旋转。
 */

import * as THREE from 'three'

import type { FaceName } from '../schema/types'
import { structureRowToWorldY } from '../data/grid'

const FACE_VEC: Record<FaceName, THREE.Vector3> = {
  '+x': new THREE.Vector3(1, 0, 0),
  '-x': new THREE.Vector3(-1, 0, 0),
  '+y': new THREE.Vector3(0, 1, 0),
  '-y': new THREE.Vector3(0, -1, 0),
  '+z': new THREE.Vector3(0, 0, 1),
  '-z': new THREE.Vector3(0, 0, -1),
}

export function faceVec3(f: FaceName): THREE.Vector3 {
  return FACE_VEC[f]
}

/** 将任意轴对齐法线归为 FaceName（主分量）；纯数值版供几何核心使用 */
export function vec3ToFaceNameComponents(x: number, y: number, z: number): FaceName {
  const ax = Math.abs(x),
    ay = Math.abs(y),
    az = Math.abs(z)
  if (ax >= ay && ax >= az) return x > 0 ? '+x' : '-x'
  if (ay >= ax && ay >= az) return y > 0 ? '+y' : '-y'
  return z > 0 ? '+z' : '-z'
}

/** 将任意轴对齐法线归为 FaceName（主分量） */
export function vec3ToFaceName(v: THREE.Vector3): FaceName {
  return vec3ToFaceNameComponents(v.x, v.y, v.z)
}

/**
 * 机器正面在世界中为 `machineFront`（外法线）时，世界面 `worldFace` 上显示的贴图来自注册表哪一面。
 * 注册表约定：正面在 `-z`。
 */
export function registryFaceForWorldFace(worldFace: FaceName, machineFront: FaceName): FaceName {
  if (machineFront === '-z') return worldFace
  const q = machineFrontQuaternion(machineFront)
  const inv = q.clone().invert()
  return vec3ToFaceName(faceVec3(worldFace).applyQuaternion(inv))
}

/** 将默认正面（-z）旋至 `machineFront` 的四元数（作用于位置/法线） */
export function machineFrontQuaternion(machineFront: FaceName): THREE.Quaternion {
  const from = new THREE.Vector3(0, 0, -1)
  const to = faceVec3(machineFront)
  if (from.distanceToSquared(to) < 1e-10) return new THREE.Quaternion()
  return new THREE.Quaternion().setFromUnitVectors(from, to)
}

/** 注册表局部外法线（未旋转前与 MC 世界轴对齐）经旋转后得到的世界外法线 */
export function worldNormalFromRegistryFace(registryFace: FaceName, machineFront: FaceName): THREE.Vector3 {
  const q = machineFrontQuaternion(machineFront)
  return faceVec3(registryFace).applyQuaternion(q).normalize()
}

export function voxelCenterWorld(
  col: number,
  row: number,
  zSlice: number,
  sizeColumn: number,
  sizeRow: number,
  sizeZSlice: number,
): THREE.Vector3 {
  const baseX = col - sizeColumn / 2
  const baseZ = zSlice - sizeZSlice / 2
  const voxelY = structureRowToWorldY(row, sizeRow)
  const baseY = voxelY - sizeRow / 2
  return new THREE.Vector3(baseX + 0.5, baseY + 0.5, baseZ + 0.5)
}

/** 旋转 BufferGeometry 的 position/normal（绕 center，用于 Model 体素） */
export function applyRotationAboutCenter(
  geom: THREE.BufferGeometry,
  center: THREE.Vector3,
  q: THREE.Quaternion,
): void {
  const pos = geom.attributes.position
  const normal = geom.attributes.normal
  const v = new THREE.Vector3()
  const n = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    v.sub(center).applyQuaternion(q).add(center)
    pos.setXYZ(i, v.x, v.y, v.z)
    n.fromBufferAttribute(normal, i)
    n.applyQuaternion(q).normalize()
    normal.setXYZ(i, n.x, n.y, n.z)
  }
}
