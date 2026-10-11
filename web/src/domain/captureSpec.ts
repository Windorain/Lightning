/**
 * `domain/captureSpec` —— **固定快照的捕获规格**（#249 §19.4；#260 A29 的纯政策半边）。
 *
 * ## 本模块替代的旧机制
 *
 * 旧导出器（`workbench/exportIsometricImage.ts`、`workbench/export/bundleMeshAssembly.ts`）
 * 在**用户正在操作的视口**上取景：它读当前相机、必要时临时改机位再恢复，并用
 * "现在"的帧序号决定导出哪一帧。B5 退役矩阵第 13 条（`exporter-borrows-live-viewport`）
 * 要退役的正是这件事，A29 的负对照原文是「导出**借用并旋转实时相机**、**隐式读取最新文档**」。
 *
 * 本模块把"导出要捕获什么"变成一份**不可变的值**：
 *  - 取景是**明确复制的观察视角**或**文档里的相机定义**，不是"当前相机对象"（类型上没有
 *    放实时相机的位置 —— 见 {@link CameraSource}）；
 *  - 时间是**固定的采样序列**，不是"导出时问一下现在第几帧"（见 {@link CaptureSpec.frames}）；
 *  - 内容版本是**捕获时的 S0**（由 `application/export` 落进请求），后续编辑只改文档，
 *    不改这份值。
 *
 * ## 时间映射：运行时间动画必须显式映射，否则预检失败
 *
 * #249 §19.4 明文：「运行时间动画在导出中**必须映射为固定的起始时间与时间序列**；
 * 缺少映射时**预检失败**，不能读取执行当刻墙钟。」
 * ⇒ {@link TimeMapping} 有两种形态：`scene`（场景时间，本身就是固定序号）与
 * `runtime`（**必须**显式给出 `anchorSeconds` 起点）。后者缺 `anchorSeconds` 时，
 * {@link planCaptureFrames} 返回 `UnsupportedOperation` 而不是"从 0 开始假装"。
 *
 * ## 纯度
 *
 * 本模块不含 Vue / Three / DOM / IO，不读全局时钟（时间以 `TimeValue` 值传入、
 * 秒数由 `domain/animation` 的有理数精确换算）。边界闸门
 * `tests/architecture/export-purity.test.ts` 与 `presentation-purity.test.ts` 会盯着这一点。
 */

import { invalidValue, unsupportedOperation, type Result, ok, err } from './errors'
import {
  compareTime,
  frameRateOf,
  framesPerSecond,
  rationalToNumber,
  secondsOf,
  timeValue,
  type FrameRateSpec,
  type TimeValue,
} from './animation'
import { findObject, findObjectData, type ObjectData, type Scene } from './scene'
import { legacyExportDiagnostics, type LegacyExportDiagnostic } from './geometry'
import type { Version } from './identity'
import type { AnimationState } from './animation'

// ─────────────────────────────────────────────────────────────────────────────
// 取景：明确复制的视角 **或** 文档相机定义
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 冻结的取景参数。
 *
 * **刻意不是** Three 的 `Camera`/`PerspectiveCamera`，也不是持有引用：
 * 它是一份普通值，捕获那一刻复制、之后不再与任何实时对象共享可变状态。
 * A29 的「导出借用并旋转实时相机」在这个类型下**不可表达** ——
 * 想旋转实时相机，得先把它变成 `CameraSpec`，而那时已经复制完毕。
 */
export interface CameraSpec {
  readonly projection: 'perspective' | 'orthographic'
  /** 世界空间位置。 */
  readonly position: Readonly<{ x: number; y: number; z: number }>
  /** 世界空间注视点。 */
  readonly target: Readonly<{ x: number; y: number; z: number }>
  /** 世界空间上方向。 */
  readonly up: Readonly<{ x: number; y: number; z: number }>
  /** 垂直视场角（度；`orthographic` 下同样用于确定取景盒高度）。 */
  readonly fovDegrees: number
  readonly near: number
  readonly far: number
}

/**
 * 取景来源。
 *
 * - `document`：用**文档里的相机对象**（相机参数属文档，见 #249 §3.1）；
 *   它的**观察视角**由 `view` 附上（文档相机不含机位，机位属编辑器实例）。
 * - `view`：明确复制的观察视角（例如"把当前视口视角复制一份"）。
 *
 * 两种形态都是**值**。类型里没有"当前相机"这一项，也没有可变字段。
 */
export type CameraSource =
  | { readonly kind: 'document'; readonly objectId: string; readonly view: CameraSpec }
  | { readonly kind: 'view'; readonly view: CameraSpec; readonly label: string }

/**
 * 把一个（可能来自实时视口的）视角参数**复制**成冻结的 `CameraSpec`。
 *
 * 这是"复制"的唯一入口，也是"借用"与"复制"的分界：调用方在**发起导出前**调用它，
 * 之后导出只持有复制品。函数**不保留**入参引用（逐字段复制 + `Object.freeze`），
 * 于是之后旋转实时相机不可能改变这份值。
 */
export function copyCameraSpec(spec: CameraSpec): CameraSpec {
  return Object.freeze({
    projection: spec.projection,
    position: Object.freeze({ x: spec.position.x, y: spec.position.y, z: spec.position.z }),
    target: Object.freeze({ x: spec.target.x, y: spec.target.y, z: spec.target.z }),
    up: Object.freeze({ x: spec.up.x, y: spec.up.y, z: spec.up.z }),
    fovDegrees: spec.fovDegrees,
    near: spec.near,
    far: spec.far,
  })
}

/** 解析取景来源为冻结的 `CameraSpec`（文档相机缺数据时**显式失败**，不编造默认值）。 */
export function resolveCameraSpec(scene: Scene, source: CameraSource): Result<CameraSpec> {
  if (source.kind === 'view') return ok(copyCameraSpec(source.view))
  const obj = findObject(scene, source.objectId)
  if (!obj) return err(invalidValue({ reason: 'cameraObjectMissing', objectId: source.objectId }))
  const data: ObjectData | undefined = findObjectData(scene, obj.dataId)
  if (!data || data.payload.kind !== 'camera') {
    return err(invalidValue({ reason: 'objectIsNotCamera', objectId: source.objectId, dataId: obj.dataId }))
  }
  // 相机**定义**（投影/视场/裁剪）取自文档；**观察视角**取自 `source.view`。
  // 两者合并成一份冻结值 —— 合并结果与两个来源都不再共享引用。
  const view = source.view
  if (!Number.isFinite(data.payload.fov) || data.payload.fov <= 0) {
    return err(invalidValue({ reason: 'fovMustBePositive', objectId: source.objectId }))
  }
  return ok(
    Object.freeze({
      projection: data.payload.projection,
      position: Object.freeze({ x: view.position.x, y: view.position.y, z: view.position.z }),
      target: Object.freeze({ x: view.target.x, y: view.target.y, z: view.target.z }),
      up: Object.freeze({ x: view.up.x, y: view.up.y, z: view.up.z }),
      fovDegrees: data.payload.fov,
      near: data.payload.clipStart,
      far: data.payload.clipEnd,
    }),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 时间：固定采样序列
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 时间映射（#249 §19.4「运行时间动画必须映射为固定的起始时间与时间序列」）。
 *
 * - `scene`：采样直接是场景时间轴上的帧号（起始帧 + 步长 × 序号）；
 * - `runtime`：**必须**给出 `anchorSeconds` —— 运行时间在导出中的固定起点。
 *   缺它即预检失败，因为"从执行当刻的墙钟开始"正是 §19.4 禁止的事。
 *
 * `clock` 只在 `runtime` 下出现，且必须是**装配层安装了**的时钟 ID
 * （{@link validateTimeMapping} 逐个核对；未安装 ⇒ `UnsupportedOperation`，
 * 与 `domain/materials.resolveTimeBinding` 同一判据与同一 reason）。
 */
export type TimeMapping =
  | { readonly source: 'scene'; readonly startFrame: number; readonly stepFrames: number }
  | { readonly source: 'runtime'; readonly clock: string; readonly anchorSeconds: number; readonly stepFrames: number }

/** 已安装的时间源（由装配层提供；纯层只读它，不自己探测环境）。 */
export interface CaptureTimeSources {
  readonly runtimeClocks: readonly string[]
}

export const SCENE_TIME_ONLY: CaptureTimeSources = Object.freeze({ runtimeClocks: Object.freeze([]) as readonly string[] })

/** 一个采样时刻（帧号 + 精确秒数；秒数是**导出侧**的统一时间输入） */
export interface CaptureTime {
  readonly index: number
  readonly time: TimeValue
  readonly seconds: number
}

/** 一次导出的帧数与渲染设置。 */
export interface CaptureSpec {
  readonly frameRate: FrameRateSpec
  readonly frameCount: number
  readonly mapping: TimeMapping
  /** 通道参数（多方块/动画通道；导出时固定，不随用户后续操作改变）。 */
  readonly channels: Readonly<Record<string, number>>
  readonly camera: CameraSource
  /** 渲染设置（尺寸/背景/是否透明）。 */
  readonly render: RenderSettings
  /**
   * 动画状态（轨道 + 发布默认值；#249 §3.4 属文档状态域）。
   *
   * 采样**不另立播放循环**：导出的每个采样时刻都交给同一份 `AnimationState`
   * 与同一套 `sampleTrack`（P4 交付）求值 —— 与实时视口走同一条求值路径。
   */
  readonly animation: AnimationState
}

export interface RenderSettings {
  readonly width: number
  readonly height: number
  /** 背景（整型色 `0xRRGGBB`）或 `'transparent'`。 */
  readonly background: number | 'transparent'
}

/**
 * 规划固定采样序列 —— **纯函数**（同一 `spec` 恒得同一序列）。
 *
 * 三条判据：
 *  1. `frameCount` 必须为正整数、渲染尺寸必须为正整数 —— 否则 `InvalidValue`
 *     （不夹取、不"用 1 代替"，#249 §7「不把任意小数写成非法取值」的同族要求）；
 *  2. `runtime` 映射缺 `anchorSeconds` ⇒ `UnsupportedOperation{reason:'runtimeTimeMappingMissing'}`；
 *  3. 序列由 `(起点, 步长, 序号)` 决定，**不读任何时钟** —— 于是"导出期间继续编辑"
 *     不可能改变这次快照的采样时间（A29 原文）。
 */
export function planCaptureFrames(spec: CaptureSpec, available: CaptureTimeSources = SCENE_TIME_ONLY): Result<readonly CaptureTime[]> {
  if (!Number.isInteger(spec.frameCount) || spec.frameCount <= 0) {
    return err(invalidValue({ reason: 'frameCountMustBePositive', frameCount: spec.frameCount }))
  }
  if (!Number.isInteger(spec.render.width) || spec.render.width <= 0) {
    return err(invalidValue({ reason: 'widthMustBePositive', width: spec.render.width }))
  }
  if (!Number.isInteger(spec.render.height) || spec.render.height <= 0) {
    return err(invalidValue({ reason: 'heightMustBePositive', height: spec.render.height }))
  }
  const rate = frameRateOf(spec.frameRate)
  if (!rate.ok) return err(rate.error)

  let baseFrame: number
  let step: number
  if (spec.mapping.source === 'scene') {
    baseFrame = spec.mapping.startFrame
    step = spec.mapping.stepFrames
  } else {
    // 先用**同一判据**核对时间源是否安装（与 `domain/materials.resolveTimeBinding` 一致）：
    // 显示"支持运行时间"却默默按场景时间播，正是 A27/A28 要判红的形态。
    if (!available.runtimeClocks.includes(spec.mapping.clock)) {
      return err(
        unsupportedOperation({
          reason: 'runtimeClockNotInstalled',
          clock: spec.mapping.clock,
          binding: 'runtime',
        }),
      )
    }
    const anchor = spec.mapping.anchorSeconds
    if (typeof anchor !== 'number' || !Number.isFinite(anchor)) {
      // 「缺少映射时预检失败」——**不**退回"按场景时间播"（那正是负对照要判红的形态）。
      return err(
        unsupportedOperation({
          reason: 'runtimeTimeMappingMissing',
          clock: spec.mapping.clock,
          binding: 'runtime',
        }),
      )
    }
    baseFrame = anchor * framesPerSecond(spec.frameRate)
    step = spec.mapping.stepFrames
  }
  if (!Number.isFinite(baseFrame)) {
    return err(invalidValue({ reason: 'startFrameNotFinite', frame: String(baseFrame) }))
  }
  if (!Number.isInteger(step) || step < 0) {
    return err(invalidValue({ reason: 'stepFramesInvalid', stepFrames: spec.mapping.stepFrames }))
  }

  const out: CaptureTime[] = []
  for (let i = 0; i < spec.frameCount; i++) {
    const frame = baseFrame + step * i
    const time = timeValue(frame, spec.frameRate)
    // 秒数由有理数精确换算 —— 循环内的**唯一**时间来源，没有第二个时钟。
    const seconds = rationalToNumber(secondsOf(time))
    out.push(Object.freeze({ index: i, time, seconds }))
  }
  return ok(Object.freeze(out))
}

/** 采样序列是否单调递增（诊断与断言用；`step === 0` 时允许相等）。 */
export function isSequenceMonotonic(frames: readonly CaptureTime[]): boolean {
  for (let i = 1; i < frames.length; i++) {
    if (compareTime(frames[i - 1]!.time, frames[i]!.time) > 0) return false
  }
  return true
}

// ─────────────────────────────────────────────────────────────────────────────
// 请求负载与请求
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 请求负载：把"要导出的内容"变成**纯数据**。
 *
 * 这是"隐式读取最新文档"与"捕获固定内容"的分界：负载里存的是捕获时刻的
 * `Version` + 类型化内容（`Scene` 与 `AnimationState` 都是不可变值，结构共享，
 * 不是深拷贝）。导出作业**只**读负载，从不回到编辑器取文档。
 */
export interface SnapshotPayload {
  readonly documentId: string
  readonly version: Version
  readonly sceneId: string
  readonly scene: Scene
  readonly animation: AnimationState
}

/** 请求状态。 */
export type ExportRequestState = 'prepared' | 'running' | 'completed' | 'cancelled' | 'failed'

/** 资源需求（由呈现编译反推；键是稳定资源 ID，值是内容版本）。 */
export interface ExportAssetNeed {
  readonly assetId: string
  readonly contentVersion: string
  /** `required` 的资源未就绪 ⇒ 预检失败；可选资源缺失只降级。 */
  readonly required: boolean
  /** 获取位置（不参与身份判定）。 */
  readonly locator: string
}

/**
 * 不可变导出请求（#249 §19.4 逐项）。
 *
 * 「导出捕获文档内容版本、场景、相机定义、时间采样序列、通道参数、渲染设置及资源清单，
 * 形成**不可变请求**。」—— 本类型逐项对应，且全部字段 `readonly`。
 */
export interface ExportRequest {
  readonly requestId: string
  /** 注入的时间戳（纯层不读墙钟）。 */
  readonly createdAt: number
  readonly payload: SnapshotPayload
  readonly camera: CameraSpec
  readonly frames: readonly CaptureTime[]
  readonly channels: Readonly<Record<string, number>>
  readonly render: RenderSettings
  readonly mapping: TimeMapping
  readonly assets: readonly ExportAssetNeed[]
  /**
   * 捕获时刻已知的**能力损失**（旧格式可表达性诊断；#249 §12「必要时导出烘焙结果，
   * 并记录能力损失」）。它是请求的一部分而不是"导出后补记" —— 预检据它决定
   * 默认失败还是显式有损模式。
   */
  readonly capabilityLoss: readonly LegacyExportDiagnostic[]
}

/** 组装一份不可变请求（逐字段冻结；调用方之后无法改它）。 */
export function freezeExportRequest(init: {
  requestId: string
  createdAt: number
  payload: SnapshotPayload
  camera: CameraSpec
  frames: readonly CaptureTime[]
  channels: Readonly<Record<string, number>>
  render: RenderSettings
  mapping: TimeMapping
  assets: readonly ExportAssetNeed[]
  capabilityLoss: readonly LegacyExportDiagnostic[]
}): ExportRequest {
  return Object.freeze({
    requestId: init.requestId,
    createdAt: init.createdAt,
    payload: Object.freeze({ ...init.payload }),
    camera: copyCameraSpec(init.camera),
    frames: Object.freeze([...init.frames]),
    channels: Object.freeze({ ...init.channels }),
    render: Object.freeze({ ...init.render }),
    mapping: Object.freeze({ ...init.mapping }),
    assets: Object.freeze([...init.assets]),
    capabilityLoss: Object.freeze([...init.capabilityLoss]),
  })
}

/**
 * 捕获时刻的**能力损失**判定（旧结构格式的可表达性）。
 *
 * 直接用 P3 交付的挂点 `legacyExportDiagnostics`：非整数格平移、非恒等旋转/缩放、
 * 显式枢轴、固定拓扑形变都**不能**忠实写出。本函数只是把它接到导出请求上，
 * **不**重新实现一份判据（否则会出现两套"什么算不可表达"）。
 */
export function captureCapabilityLoss(scene: Scene): readonly LegacyExportDiagnostic[] {
  return legacyExportDiagnostics(scene)
}
