/**
 * `presentation/isoExportCamera` —— **等轴四向取景 = 四个固定 `CameraSpec` 值**。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | 导出器在自建 stage 里**置一台透视相机再抄成正交相机**，并把内容整体平移使"轨道目标 = 原点" | `workbench/exportIsometricImage.ts#openIsometricStage`（已删） | 由内容包围盒**一次算出四个 `CameraSpec` 值**；相机对象由 `presentation/offscreenCamera#threeCameraOf` 从值构造 |
 *
 * ## 为什么取景必须是"值"（而不是再在导出端口里构造相机）
 *
 * `CameraSpec` 是**冻结的捕获值**（`domain/captureSpec`）：类型里没有"当前相机"这一项。
 * 本包把等轴四向取景**降成四个值**，于是导出路径上不再存在"构造相机"这一步 ——
 * `SnapshotOffscreenRenderPort` 只调 `threeCameraOf(request.camera, request.render)`。
 * 第二个消费者（尺寸/方向/时间的其他组合）因此不可能各写一份取景政策。
 *
 * ## 正交盒怎么"精确复现" legacy 的半宽（不是拟合）
 *
 * legacy 的口径（`exportIsometricImage#fitOrthographicCameraToBox`）是：
 * 把内容 AABB 的 8 个角投到**相机视空间**，取 `half = max(halfX, halfY, 1e-4)`，
 * 其中 `halfX = max|px| * padding`、`halfY = max|py| * padding`（padding 缺省 1.08）。
 *
 * `threeCameraOf` 的正交支把 `halfHeight` 定为 `d·tan(fov/2)`（`offscreenCamera.ts`）。
 * ⇒ 只要取 `d = half / tan(fov/2)`，正交盒的**半高恰等于 legacy 的 half**；
 * 又因为目标点取内容 AABB 中心（legacy 是"把内容平移到原点 + target=原点"，两者等价），
 * 视空间里 `cx = cy = 0` ⇒ 盒心也逐位一致。
 * 这是"值可以表达同一取景"的**结构性**证明，没有任何经验系数。
 *
 * ⚠️ 不再平移场景：legacy 的 pivot 平移会改变几何的**世界位置**，那会连带改变
 * 拾取/测量等导出以外的语义。本模块只改相机。
 *
 * ## 分层
 *
 * 纯函数（值进、值出）：不读全局、不碰 DOM/视口、不 import 任何实时相机实现，
 * 也不 import `render/` 旧层（取景政策不得绕道旧渲染实现）。
 * 球坐标与视空间基全部用标量算术写出 —— 于是它能在无 GPU 的 vitest 里逐位断言。
 */

import type { CameraSpec } from '@/domain/captureSpec'

/** 四向等轴方位角（度），相邻相差 90°（legacy `ISOMETRIC_EXPORT_YAW_DEG` 的值，宿主迁到这里）。 */
export const ISOMETRIC_EXPORT_YAW_DEG: readonly number[] = Object.freeze([45, 135, 225, 315])

/**
 * 标准等轴仰角（度）= `atan(1/sqrt(2))` ≈ 35.264389682754654。
 *
 * 与 `render/interaction/initialCamera#STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG`
 * **同值同源**（legacy 直接用它）。这里不 import 那个模块：它属 `render/`（旧层）。
 * 值本身由判据钉住（`__tests__/isoExportCamera.test.ts` 与 initialCamera 的常量逐位相等）。
 */
export const STANDARD_ISOMETRIC_ELEVATION_DEG = (Math.atan(1 / Math.sqrt(2)) * 180) / Math.PI

/** legacy 的正交留白（`fitOrthographicCameraToBox` 的 padding 缺省）。 */
export const ISO_EXPORT_ORTHO_PADDING = 1.08

/** legacy 的垂直视场角（`openIsometricStage` 里 `PerspectiveCamera(45, ...)`）。 */
export const ISO_EXPORT_FOV_DEGREES = 45

/** 世界空间 AABB（与 `presentation/batchPlan#BatchPlan.bounds` 同形状）。 */
export interface IsoExportBounds {
  readonly min: readonly [number, number, number]
  readonly max: readonly [number, number, number]
}

export interface IsoCameraSpecInput {
  readonly bounds: IsoExportBounds
  /** 垂直视场角（度）；缺省 45（legacy 同值）。 */
  readonly fovDegrees?: number
  /** 正交留白；缺省 1.08（legacy 同值）。 */
  readonly padding?: number
  /** 仰角（度）；缺省 {@link STANDARD_ISOMETRIC_ELEVATION_DEG}。 */
  readonly elevationDegrees?: number
  /** 四向方位角（度）；缺省 {@link ISOMETRIC_EXPORT_YAW_DEG}。 */
  readonly yawDegrees?: readonly number[]
}

/** 空包围盒的 legacy 回落（`fitOrthographicCameraToBox` 的 `fs = 5` / near 0.1 / far 500）。 */
const EMPTY_BOUNDS_HALF = 5
const EMPTY_BOUNDS_NEAR = 0.1
const EMPTY_BOUNDS_FAR = 500

/** 一个方向要用的标量（目标点与"是否为空"）。 */
interface FramingScalars {
  readonly target: readonly [number, number, number]
  readonly empty: boolean
}

function framingOf(bounds: IsoExportBounds): FramingScalars {
  const [minX, minY, minZ] = bounds.min
  const [maxX, maxY, maxZ] = bounds.max
  const finite = [minX, minY, minZ, maxX, maxY, maxZ].every((v) => Number.isFinite(v))
  if (!finite || minX > maxX || minY > maxY || minZ > maxZ) {
    return { target: [0, 0, 0], empty: true }
  }
  return { target: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2], empty: false }
}

/** 单位方向：从目标指向相机（球坐标；与 `applyDiagonalOrbitView` 的 `Spherical(dist, phi, theta)` 同式）。 */
function cameraDirection(yawDeg: number, elevationDeg: number): readonly [number, number, number] {
  const theta = (yawDeg * Math.PI) / 180
  const phi = Math.PI / 2 - (elevationDeg * Math.PI) / 180
  const sinPhi = Math.sin(phi)
  return [sinPhi * Math.sin(theta), Math.cos(phi), sinPhi * Math.cos(theta)]
}

/**
 * 视空间半宽（legacy 的 `max(halfX, halfY, 1e-4)`）。
 *
 * 视空间基与 `THREE.Object3D#lookAt` 逐字同式：`z = normalize(eye - target)`、
 * `x = normalize(cross(worldUp, z))`、`y = cross(z, x)`。于是 `halfX/halfY` 就是
 * legacy 用 `matrixWorldInverse` 投出来再取 `max|px|/|py|` 的同一个量。
 */
function halfExtentOf(
  bounds: IsoExportBounds,
  target: readonly [number, number, number],
  dir: readonly [number, number, number],
  padding: number,
): number {
  const [dx, dy, dz] = dir
  // x = normalize(cross(up=(0,1,0), z=dir)) = normalize((dz, 0, -dx))
  const xLen = Math.hypot(dz, dx)
  const x: readonly [number, number, number] = xLen === 0 ? [1, 0, 0] : [dz / xLen, 0, -dx / xLen]
  // y = cross(z, x)
  const y: readonly [number, number, number] = [
    dy * x[2] - dz * x[1],
    dz * x[0] - dx * x[2],
    dx * x[1] - dy * x[0],
  ]
  let maxX = 0
  let maxY = 0
  for (const cx of [bounds.min[0], bounds.max[0]]) {
    for (const cy of [bounds.min[1], bounds.max[1]]) {
      for (const cz of [bounds.min[2], bounds.max[2]]) {
        const rx = cx - target[0]
        const ry = cy - target[1]
        const rz = cz - target[2]
        const px = rx * x[0] + ry * x[1] + rz * x[2]
        const py = rx * y[0] + ry * y[1] + rz * y[2]
        if (Math.abs(px) > maxX) maxX = Math.abs(px)
        if (Math.abs(py) > maxY) maxY = Math.abs(py)
      }
    }
  }
  return Math.max(maxX * padding, maxY * padding, 1e-4)
}

/** 内容沿视线方向的深度范围（角点到相机的距离）。 */
function depthRangeOf(
  bounds: IsoExportBounds,
  target: readonly [number, number, number],
  dir: readonly [number, number, number],
  distance: number,
): { readonly min: number; readonly max: number } {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const cx of [bounds.min[0], bounds.max[0]]) {
    for (const cy of [bounds.min[1], bounds.max[1]]) {
      for (const cz of [bounds.min[2], bounds.max[2]]) {
        const along = (cx - target[0]) * dir[0] + (cy - target[1]) * dir[1] + (cz - target[2]) * dir[2]
        const depth = distance - along
        if (depth < min) min = depth
        if (depth > max) max = depth
      }
    }
  }
  return { min, max }
}

/**
 * 裁剪面前后让开的余量（世界单位）。
 *
 * **方向不可写反**：near 必须落在内容最近点**之前**、far 落在最远点**之后**。
 * 写成 "-maxZ + ε"（把近平面放到最近点之后）会让轴对齐机位的贴面整面被裁
 * ——「整排消失只出孤立一枚」就是这条符号错误（实测记录见
 * presentation/__tests__/shotCamera.test.ts 的负对照）。
 */
export const CAMERA_CLIP_MARGIN = 1e-2

/**
 * 内容 AABB 沿视轴方向的 near/far（**向外**包住整个 AABB）。
 *
 * 与 isoCameraSpecOf 用的是**同一份**计算：等轴四向与验收器具的显式机位
 * 不允许各自写一份裁剪面政策（两份必然漂移，而漂移的表现是"某台机位边缘缺一层"）。
 *
 * @param target 内容包围盒中心（世界空间）
 * @param dir 目标点指向相机的**单位**方向（相机位置 = target + dir·distance）
 * @param distance 相机到目标的距离（与 dir 配套；决定近远平面在视轴上的刻度）
 */
export function clipPlanesAroundBounds(
  bounds: IsoExportBounds,
  target: readonly [number, number, number],
  dir: readonly [number, number, number],
  distance: number,
  margin: number = CAMERA_CLIP_MARGIN,
): { readonly near: number; readonly far: number } {
  const depth = depthRangeOf(bounds, target, dir, distance)
  const near = Math.max(0.01, depth.min - margin)
  return { near, far: Math.max(near + 0.02, depth.max + margin) }
}

/** 视场角归一（与 `offscreenCamera#normalizeFov` 同一口径：非有限/非正 ⇒ 50°，夹到 (0,180)）。 */
function normalizeFov(fovDegrees: number): number {
  if (!Number.isFinite(fovDegrees) || fovDegrees <= 0) return 50
  return Math.min(fovDegrees, 179.999)
}

/**
 * **一个方向的固定 `CameraSpec` 值**。
 *
 * `directionIndex` 取 0..3（不在范围内的值由调用方归一 —— 本模块不静默夹取：
 * 索引越界会显式抛出，那说明"哪个方向"在两处被解释成了不同结果）。
 */
export function isoCameraSpecOf(input: IsoCameraSpecInput & { readonly directionIndex: number }): CameraSpec {
  const yawDegrees = input.yawDegrees ?? ISOMETRIC_EXPORT_YAW_DEG
  const fovDegrees = input.fovDegrees ?? ISO_EXPORT_FOV_DEGREES
  const padding = input.padding ?? ISO_EXPORT_ORTHO_PADDING
  const elevationDegrees = input.elevationDegrees ?? STANDARD_ISOMETRIC_ELEVATION_DEG
  const index = input.directionIndex
  if (!Number.isInteger(index) || index < 0 || index >= yawDegrees.length) {
    throw new Error('isoCameraSpecOf: directionIndex 必须是 0..' + String(yawDegrees.length - 1) + ' 的整数（实得 ' + String(index) + '）')
  }

  const framing = framingOf(input.bounds)
  const dir = cameraDirection(yawDegrees[index]!, elevationDegrees)
  const tanHalf = Math.tan((normalizeFov(fovDegrees) * Math.PI) / 360)
  // 空内容：legacy 直接给 ±5 的盒（与相机距离无关）。这里用"半高 = 5"反推距离，
  // 使同一份 `CameraSpec` 在 `threeCameraOf` 下仍得到 ±5 的盒。
  const half = framing.empty ? EMPTY_BOUNDS_HALF : halfExtentOf(input.bounds, framing.target, dir, padding)

  // d = half / tan(fov/2) ⇒ threeCameraOf 的 halfHeight = d·tan(fov/2) = half（精确复现）。
  const distance = Math.max(half / tanHalf, 1e-3)
  const position = Object.freeze({
    x: framing.target[0] + dir[0] * distance,
    y: framing.target[1] + dir[1] * distance,
    z: framing.target[2] + dir[2] * distance,
  })
  const target = Object.freeze({ x: framing.target[0], y: framing.target[1], z: framing.target[2] })

  // near/far：**保守值**（把 AABB 的视空间深度整个包住，前后各留余量）。
  // 必须按**本 spec 的距离**算 —— legacy 是照着 2.2*maxDim 的透视距离算的，
  // 换了距离还用旧 near/far 会把内容切掉（表现为"导出图边缘缺失"，静默）。
  let near = EMPTY_BOUNDS_NEAR
  let far = EMPTY_BOUNDS_FAR
  if (!framing.empty) {
    const clip = clipPlanesAroundBounds(input.bounds, framing.target, dir, distance)
    near = clip.near
    far = clip.far
  }

  return Object.freeze({
    projection: 'orthographic' as const,
    position,
    target,
    up: Object.freeze({ x: 0, y: 1, z: 0 }),
    fovDegrees,
    near,
    far,
  })
}

/** **四向一次算完**（请求里存四个值，而不是"一个值 + 运行时方向"）。 */
export function isoCameraSpecsOf(input: IsoCameraSpecInput): readonly [CameraSpec, CameraSpec, CameraSpec, CameraSpec] {
  const yawDegrees = input.yawDegrees ?? ISOMETRIC_EXPORT_YAW_DEG
  if (yawDegrees.length !== 4) {
    throw new Error('isoCameraSpecsOf: 四向表必须恰好 4 项（实得 ' + String(yawDegrees.length) + '）')
  }
  return Object.freeze([
    isoCameraSpecOf({ ...input, directionIndex: 0 }),
    isoCameraSpecOf({ ...input, directionIndex: 1 }),
    isoCameraSpecOf({ ...input, directionIndex: 2 }),
    isoCameraSpecOf({ ...input, directionIndex: 3 }),
  ]) as readonly [CameraSpec, CameraSpec, CameraSpec, CameraSpec]
}
