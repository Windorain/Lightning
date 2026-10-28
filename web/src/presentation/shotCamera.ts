/**
 * `presentation/shotCamera` —— **验收器具的显式正交机位 = 一个冻结的 `CameraSpec` 值**（三对齐）。
 *
 * ## 它替代了什么
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | 器具自建 `WebGLRenderer` + 自建正交相机，把内容 AABB 平移到原点再 `lookAt(原点)` | `workbench/exportShotImage.ts`（与新内核不兼容，已删） | 把"指定机位"表示成内核已有的冻结取景值；相机由 `presentation/offscreenCamera#threeCameraOf` 从值构造 |
 *
 * ## 为什么是"值"（而不是又一台相机）
 *
 * 纪律是「导出相机是固定值，不借用正在变化的观察对象」。器具要的是
 * "与游戏内控制面 `CameraSpec` 同机位"的**一张图**，故它同样必须是值：`position` / `target` /
 * `up` / `fov` / `near` / `far` 六项全部在这里算定，之后交给导出作业冻结。
 * 导出端口因此不需要知道"这次是等轴还是验收机位"——它只调 `threeCameraOf(request.camera, …)`。
 *
 * ## 正交全高怎么进入内核口径（不是拟合）
 *
 * 内核的正交支把盒半高定为 `d·tan(fov/2)`（`presentation/offscreenCamera`），其中
 * `d = |position − target|`。器具要的是"竖直全高 = `orthoHeight`"，即半高 = `orthoHeight/2`。
 * 于是取
 *
 * ```
 * fov = 2·atan( (orthoHeight/2) / d )
 * ```
 *
 * 代回去即 `d·tan(fov/2) = orthoHeight/2` —— **结构性**相等，没有任何经验系数。
 * （`fov` 是内核表达"正交盒多大"的唯一字段，器具不另立一个盒尺寸字段。）
 *
 * ## 内容 AABB 与落点的关系（坐标口径）
 *
 * 调用方给的 `offset` 是**相机落点相对内容包围盒中心**的偏移（MC 世界坐标 − 结构中心，
 * 见 `pure/mcShotCamera#mcSpecToShotCamera`）。目标点取内容包围盒中心 ⇒
 * "看结构中心"这条语义与内容是否居中无关（内核**不**平移内容，见 isoExportCamera 头注）。
 *
 * near/far 与等轴四向共用 {@link clipPlanesAroundBounds}（**同一份**裁剪面政策）：
 * near 落在内容最近点之前、far 落在最远点之后。
 */

import type { CameraSpec } from '@/domain/captureSpec'
import { err, invalidValue, ok, type Result } from '@/domain/errors'
import { clipPlanesAroundBounds, type IsoExportBounds } from '@/presentation/isoExportCamera'

/** 验收机位的相对放置（值与内容 AABB 分开给：落点只在"相对中心"的口径下有意义）。 */
export interface ShotPlacement {
  /** 相机落点相对**内容包围盒中心**的偏移（世界单位；MC 口径为 `pos − 结构中心`）。 */
  readonly offset: readonly [number, number, number]
  /** 正交**竖直全高**（方块数；不是半高、不是盒宽）。 */
  readonly orthoHeight: number
}

/**
 * 落点与内容中心的最小距离。
 *
 * 落点与目标点重合时视线方向未定义（`lookAt` 退化）——显式失败，不产出一张
 * "不知为何空白"的图（旧器具的同一守卫，语义不变）。
 */
export const SHOT_MIN_DISTANCE = 1e-3

/**
 * 超过这个视场角就认为"正交全高与落点距离不自洽"。
 *
 * 内核的盒半高 = `d·tan(fov/2)`，而 `threeCameraOf` 把 `fov` 夹到 `< 180°`：
 * 若所需 fov 已贴到 180°，夹取会让盒**静默变小**（出图内容比声明的 orthoHeight 少）。
 * ⇒ 宁可显式失败，也不产出一张"看起来正常、实为另一套取景"的图。
 */
const MAX_EXPRESSIBLE_FOV_DEG = 179.999

function finiteTriple(v: readonly [number, number, number]): boolean {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1]) &&
    Number.isFinite(v[2])
  )
}

/** 内容包围盒中心（与 `isoExportCamera#framingOf` 同一口径；空/非法包围盒 ⇒ `null`）。 */
function centerOf(bounds: IsoExportBounds): [number, number, number] | null {
  const { min, max } = bounds
  if (!finiteTriple(min) || !finiteTriple(max)) return null
  if (min[0] > max[0] || min[1] > max[1] || min[2] > max[2]) return null
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
}

/**
 * 显式正交机位 → 冻结的 `CameraSpec`（值）。
 *
 * 失败一律是 `Result` 的失败侧（`InvalidValue` + 具名 `reason`），不产出"夹取过"的机位。
 */
export function shotCameraSpecOf(bounds: IsoExportBounds, placement: ShotPlacement): Result<CameraSpec> {
  const offset = placement.offset
  if (!finiteTriple(offset)) {
    return err(invalidValue({ reason: 'shotOffsetInvalid', offset: JSON.stringify(offset) }))
  }
  const orthoHeight = placement.orthoHeight
  if (!Number.isFinite(orthoHeight) || orthoHeight <= 0) {
    return err(invalidValue({ reason: 'shotOrthoHeightInvalid', orthoHeight: String(orthoHeight) }))
  }
  const center = centerOf(bounds)
  if (center === null) {
    return err(invalidValue({ reason: 'shotBoundsEmpty' }))
  }

  const distance = Math.hypot(offset[0], offset[1], offset[2])
  if (!(distance >= SHOT_MIN_DISTANCE)) {
    // 落点贴到内容中心：视线方向未定义（`lookAt` 退化）。
    return err(
      invalidValue({
        reason: 'shotOffsetDegenerate',
        distance: distance,
        minDistance: SHOT_MIN_DISTANCE,
      }),
    )
  }
  const dir: readonly [number, number, number] = [
    offset[0] / distance,
    offset[1] / distance,
    offset[2] / distance,
  ]

  const halfHeight = orthoHeight / 2
  const fovDegrees = (2 * Math.atan(halfHeight / distance) * 180) / Math.PI
  if (!Number.isFinite(fovDegrees) || fovDegrees >= MAX_EXPRESSIBLE_FOV_DEG) {
    return err(
      invalidValue({
        reason: 'shotFramingNotExpressible',
        orthoHeight,
        distance,
        fovDegrees: String(fovDegrees),
      }),
    )
  }

  const clip = clipPlanesAroundBounds(bounds, center, dir, distance)
  return ok(
    Object.freeze({
      projection: 'orthographic' as const,
      position: Object.freeze({
        x: center[0] + offset[0],
        y: center[1] + offset[1],
        z: center[2] + offset[2],
      }),
      target: Object.freeze({ x: center[0], y: center[1], z: center[2] }),
      // 竖直上方向交给唯一构造点（`threeCameraOf` 在视线与 up 共线时换轴）——
      // 这里不复制那份退化处理，否则"极点机位的旋向"会有两处解释。
      up: Object.freeze({ x: 0, y: 1, z: 0 }),
      fovDegrees,
      near: clip.near,
      far: clip.far,
    }),
  )
}
