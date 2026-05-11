/**
 * 检测焦点体素并设置初始相机：轨道中心对准焦点体素中心，相机位于「正面」外侧，
 * camera.up 为世界 +Y（Minecraft 竖直向上）；正面法线由 `initialCamera.frontFace` 指定。
 *
 * 若 `StructureDefinition.initialCamera` 省略，则使用 fallback，不构建焦点逻辑。
 *
 * 默认朝北为 **-z**（GUI 常从南侧看）。结构行 row 与世界 Y：`structureRowToWorldY`（首行 = 顶 = 高 Y）。
 */

import * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

import type { StructureDefinition } from '../schema/types'
import { FACE_NORMAL } from '../mesh/faceConstants'
import { buildVoxelVolume, findFirstVoxelWithBlockId } from '../data/grid'
import type { VoxelCell } from '../data/grid'
import { structureRowToWorldY } from '../data/grid'

const WORLD_UP = new THREE.Vector3(0, 1, 0)

const DEFAULT_DISTANCE = 10

/**
 * 标准等轴（透视球坐标近似）：视线与水平面夹角 = atan(1/√2) ≈ 35.264°。
 * 与方位角 45°+k·90° 联用时，三轴在画面上的可见伸缩比一致（常见工程/体素等轴示意）。
 */
export const STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG = THREE.MathUtils.radToDeg(
  Math.atan(1 / Math.sqrt(2)),
)

/**
 * 与 simpleMesh 体素中心一致：column、zSlice 为体素下标；row 为 **行下标**（0=顶行），
 * 世界 Y 由 `structureRowToWorldY(row, sizeRow)` 得到。
 */
export function voxelCenterWorld(
  column: number,
  structureRow: number,
  zSlice: number,
  sizeColumn: number,
  sizeRow: number,
  sizeZSlice: number,
  out?: THREE.Vector3,
): THREE.Vector3 {
  const y = structureRowToWorldY(structureRow, sizeRow)
  const v = out ?? new THREE.Vector3()
  v.set(column + 0.5 - sizeColumn / 2, y + 0.5 - sizeRow / 2, zSlice + 0.5 - sizeZSlice / 2)
  return v
}

/** 在网格中查找 `initialCamera.focusBlockId` 的第一个体素；无 `initialCamera` 时返回 null */
export function findFirstFocusVoxel(def: StructureDefinition): VoxelCell | null {
  const ic = def.initialCamera
  if (!ic) return null
  return findFirstVoxelWithBlockId(buildVoxelVolume(def), ic.focusBlockId)
}

/**
 * 正面朝外法线与 world up 几乎平行时，lookAt 与 up 退化，改用 +Z 作为 camera.up。
 */
function setCameraUpParallelToControllerTop(
  camera: THREE.Camera,
  frontOutward: THREE.Vector3,
): void {
  const f = frontOutward
  if (Math.abs(f.dot(WORLD_UP)) > 0.98) {
    camera.up.set(0, 0, 1)
  } else {
    camera.up.copy(WORLD_UP)
  }
}

export interface ApplyInitialCameraOptions {
  /** 覆盖 JSON 中的 distance */
  distance?: number
}

export interface ApplyDiagonalOrbitViewOptions {
  /** 与 `controls.target` 的距离；缺省为当前相机到目标距离 */
  distance?: number
  /** 绕世界 Y 轴方位角（度），默认 45（左旋 45°） */
  yawDeg?: number
  /** 相对水平面的俯仰：视线自水平面向下为「俯视」；缺省为 {@link STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG} */
  elevationFromHorizontalDeg?: number
}

/**
 * 在已有 `controls.target` 下，将球坐标系相机置于目标外侧：默认方位 45° + 标准等轴俯仰。
 */
export function applyDiagonalOrbitView(
  camera: THREE.Camera,
  controls: OrbitControls,
  options?: ApplyDiagonalOrbitViewOptions,
): void {
  const target = controls.target.clone()
  const dist =
    options?.distance ?? Math.max(0.1, camera.position.distanceTo(target))
  const yawDeg = options?.yawDeg ?? 45
  const elevDeg =
    options?.elevationFromHorizontalDeg ?? STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG

  const theta = THREE.MathUtils.degToRad(yawDeg)
  const phi = Math.PI / 2 - THREE.MathUtils.degToRad(elevDeg)

  const offset = new THREE.Vector3().setFromSpherical(
    new THREE.Spherical(dist, phi, theta),
  )
  camera.position.copy(target).add(offset)
  camera.up.copy(WORLD_UP)
  camera.lookAt(target)
  controls.update()
}

/**
 * 若存在 `initialCamera` 且网格中能找到焦点体素：target = 体素中心；相机在正面法线外侧。
 * 若无 `initialCamera`、或找不到焦点体素：使用 fallbackTarget / fallbackPosition（均为世界坐标）。
 */
export function applyInitialCamera(
  camera: THREE.Camera,
  controls: OrbitControls,
  def: StructureDefinition,
  fallbackTarget: THREE.Vector3,
  fallbackPosition: THREE.Vector3,
  options?: ApplyInitialCameraOptions,
): void {
  const ic = def.initialCamera
  if (!ic) {
    controls.target.copy(fallbackTarget)
    camera.position.copy(fallbackPosition)
    camera.up.copy(WORLD_UP)
    camera.lookAt(fallbackTarget)
    return
  }

  const grid = buildVoxelVolume(def)
  const cell = findFirstVoxelWithBlockId(grid, ic.focusBlockId)
  if (!cell) {
    controls.target.copy(fallbackTarget)
    camera.position.copy(fallbackPosition)
    camera.up.copy(WORLD_UP)
    camera.lookAt(fallbackTarget)
    return
  }

  const { sizeColumn, sizeRow, sizeZSlice } = grid
  const target = voxelCenterWorld(
    cell.column,
    cell.row,
    cell.zSlice,
    sizeColumn,
    sizeRow,
    sizeZSlice,
  )

  const frontOut = FACE_NORMAL[ic.frontFace].clone()
  const dist = options?.distance ?? ic.distance ?? DEFAULT_DISTANCE

  setCameraUpParallelToControllerTop(camera, frontOut)
  camera.position.copy(target).add(frontOut.multiplyScalar(dist))
  camera.lookAt(target)
  controls.target.copy(target)
}
