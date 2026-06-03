/**
 * 检测焦点体素并设置初始相机：轨道中心对准焦点体素中心，相机位于「正面」外侧，
 * camera.up 为世界 +Y（Minecraft 竖直向上）；正面法线由 `initialCamera.frontFace` 指定。
 *
 * 若 `StructureDefinition.initialCamera` 省略，则使用 fallback，不构建焦点逻辑。
 *
 * 默认朝北为 **-z**（GUI 常从南侧看）。结构行 row 与世界 Y：`structureRowToWorldY`（首行 = 顶 = 高 Y）。
 */

import * as THREE from 'three'

import type { StructureDefinition } from '../schema/types'
import { FACE_NORMAL } from '../mesh/faceConstants'
import { buildVoxelVolume, findFirstVoxelWithBlockId } from '../data/grid'
import { voxelCenterWorld } from '@/pure/vec'

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
  /** 与 `orbitTarget` 的距离；缺省为当前相机到目标距离 */
  distance?: number
  /** 绕世界 Y 轴方位角（度），默认 45（左旋 45°） */
  yawDeg?: number
  /** 相对水平面的俯仰：视线自水平面向下为「俯视」；缺省为 {@link STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG} */
  elevationFromHorizontalDeg?: number
}

/**
 * 在已有 `orbitTarget` 下，将球坐标系相机置于目标外侧：默认方位 45° + 标准等轴俯仰。
 * `orbitTarget` 会被函数更新为计算后的目标位置。
 */
export function applyDiagonalOrbitView(
  camera: THREE.Camera,
  orbitTarget: THREE.Vector3,
  options?: ApplyDiagonalOrbitViewOptions,
): void {
  const target = orbitTarget.clone()
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
}

/**
 * 若存在 `initialCamera` 且网格中能找到焦点体素：orbitTarget = 体素中心；相机在正面法线外侧。
 * 若无 `initialCamera`、或找不到焦点体素：使用 fallbackTarget / fallbackPosition（均为世界坐标）。
 * 将计算出的轨道中心写入 `orbitTargetOut`。
 */
export function applyInitialCamera(
  camera: THREE.Camera,
  orbitTargetOut: THREE.Vector3,
  def: StructureDefinition,
  fallbackTarget: THREE.Vector3,
  fallbackPosition: THREE.Vector3,
  options?: ApplyInitialCameraOptions,
): void {
  const ic = def.initialCamera
  if (!ic) {
    orbitTargetOut.copy(fallbackTarget)
    camera.position.copy(fallbackPosition)
    camera.up.copy(WORLD_UP)
    camera.lookAt(fallbackTarget)
    return
  }

  const grid = buildVoxelVolume(def)
  const cell = findFirstVoxelWithBlockId(grid, ic.focusBlockId)
  if (!cell) {
    orbitTargetOut.copy(fallbackTarget)
    camera.position.copy(fallbackPosition)
    camera.up.copy(WORLD_UP)
    camera.lookAt(fallbackTarget)
    return
  }

  const { sizeColumn, sizeRow, sizeZSlice } = grid
  const center = voxelCenterWorld(
    cell.column,
    cell.row,
    cell.zSlice,
    sizeColumn,
    sizeRow,
    sizeZSlice,
  )
  const target = new THREE.Vector3(center.x, center.y, center.z)

  const frontOut = FACE_NORMAL[ic.frontFace].clone()
  const dist = options?.distance ?? ic.distance ?? DEFAULT_DISTANCE

  setCameraUpParallelToControllerTop(camera, frontOut)
  camera.position.copy(target).add(frontOut.multiplyScalar(dist))
  camera.lookAt(target)
  orbitTargetOut.copy(target)
}

/**
 * 正交视锥基准半视场角（度）：用于将透视距离映射到正交 frustum 高度。
 */
export const ORTHO_FRUSTUM_REF_HALF_FOV_DEG = 25

export interface FitCameraToGroupOptions {
  /** 覆盖方位角（度），缺省 225 */
  yawDeg?: number
  /** 覆盖俯仰角（度），缺省 STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG */
  elevationDeg?: number
  /** 覆盖相机到轨道中心的距离 */
  distance?: number
  /** 覆盖正交相机 zoom */
  zoom?: number
  /** 视锥相对包围盒留白，默认 1.06 */
  padding?: number
}

/**
 * 正交视锥在相机视空间内包住世界包围盒（含非正方形视口宽高比）。
 */
export function fitOrthoFrustumToWorldBox(
  camera: THREE.OrthographicCamera,
  box: THREE.Box3,
  viewportAspect: number,
  padding = 1.06,
): void {
  if (box.isEmpty() || !Number.isFinite(box.min.x)) return

  camera.updateMatrixWorld(true)
  const p = new THREE.Vector3()
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity

  const { min, max } = box
  const xs = [min.x, max.x]
  const ys = [min.y, max.y]
  const zs = [min.z, max.z]
  let xi: number
  let yi: number
  let zi: number
  for (xi = 0; xi < 2; xi++) {
    for (yi = 0; yi < 2; yi++) {
      for (zi = 0; zi < 2; zi++) {
        p.set(xs[xi], ys[yi], zs[zi]).applyMatrix4(camera.matrixWorldInverse)
        if (p.x < minX) minX = p.x
        if (p.x > maxX) maxX = p.x
        if (p.y < minY) minY = p.y
        if (p.y > maxY) maxY = p.y
        if (p.z < minZ) minZ = p.z
        if (p.z > maxZ) maxZ = p.z
      }
    }
  }

  const cx = (minX + maxX) * 0.5
  const cy = (minY + maxY) * 0.5
  let halfW = ((maxX - minX) * 0.5) * padding
  let halfH = ((maxY - minY) * 0.5) * padding
  const aspect = Math.max(viewportAspect, 1e-6)
  if (halfW / halfH > aspect) {
    halfH = halfW / aspect
  } else {
    halfW = halfH * aspect
  }
  halfW = Math.max(halfW, 1e-4)
  halfH = Math.max(halfH, 1e-4)

  camera.left = cx - halfW
  camera.right = cx + halfW
  camera.bottom = cy - halfH
  camera.top = cy + halfH

  const zEps = 1e-2
  camera.near = Math.max(0.01, -maxZ + zEps)
  camera.far = Math.max(camera.near + 0.02, -minZ + zEps)
  camera.updateProjectionMatrix()
}

/**
 * 将正交相机适配到 THREE.Group 的内容包围盒。
 * 计算 group 的世界包围盒 → 中心 → 等轴视角 → 视空间视锥贴合模型。
 */
export function fitCameraToGroup(
  camera: THREE.OrthographicCamera,
  group: THREE.Group,
  orbitTarget: THREE.Vector3,
  domElement: HTMLElement,
  options?: FitCameraToGroupOptions,
): void {
  group.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(group)
  if (box.isEmpty() || !Number.isFinite(box.min.x)) return

  const center = new THREE.Vector3()
  const size = new THREE.Vector3()
  box.getCenter(center)
  box.getSize(size)

  const maxDim = Math.max(size.x, size.y, size.z, 0.1)
  const dist = Math.max(8, maxDim * 2.2)
  const finalDist = options?.distance ?? dist

  orbitTarget.copy(center)
  applyDiagonalOrbitView(camera, orbitTarget, {
    yawDeg: options?.yawDeg ?? 225,
    elevationFromHorizontalDeg:
      options?.elevationDeg ?? STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG,
    distance: finalDist,
  })

  const aspect = domElement.clientWidth / Math.max(domElement.clientHeight, 1)
  fitOrthoFrustumToWorldBox(camera, box, aspect, options?.padding ?? 1.06)
  camera.zoom =
    typeof options?.zoom === 'number' && options.zoom > 0 ? options.zoom : 1
  camera.updateProjectionMatrix()
}
