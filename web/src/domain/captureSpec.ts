/**
 * `domain/captureSpec` —— **固定快照的捕获规格**（纯政策半边）。
 *
 * ## 本模块替代的旧机制
 *
 * 旧导出器（`workbench/exportIsometricImage.ts`、`workbench/export/bundleMeshAssembly.ts`）
 * 在**用户正在操作的视口**上取景：它读当前相机、必要时临时改机位再恢复，并用
 * "现在"的帧序号决定导出哪一帧。要消除的正是这件事，负对照原文是
 * 「导出**借用并旋转实时相机**、**隐式读取最新文档**」。
 *
 * 本模块把"导出要捕获什么"变成一份**不可变的值**：
 *  - 取景是**明确复制的观察视角**或**文档里的相机定义**，不是"当前相机对象"（类型上没有
 *    放实时相机的位置 —— 见 {@link CameraSource}）；
 *  - 时间是**固定的采样序列**，不是"导出时问一下现在第几帧"（见 {@link CaptureSpec.frames}）；
 *  - 内容版本是**捕获时的已提交快照**（由 `application/export` 落进请求），后续编辑只改文档，
 *    不改这份值。
 *
 * ## 时间映射：运行时间动画必须显式映射，否则预检失败
 *
 * 契约明文：「运行时间动画在导出中**必须映射为固定的起始时间与时间序列**；
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
  rationalToNumber,
  secondsOf,
  timeFromSeconds,
  type FrameRateSpec,
  type TimeValue,
} from './animation'
import { LOOP_LIMITS } from './materials'
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
 * 负对照「导出借用并旋转实时相机」在这个类型下**不可表达** ——
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
 * - `document`：用**文档里的相机对象**（相机参数属文档）；
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
  const p = data.payload
  // 投影字段**可选**（缺省 = 文档未声明）⇒ 这里如实失败，
  // **不**替文档编一个 `perspective/50/0.1/1000`（这正是本函数开头的纪律）。
  if (p.projection === undefined || p.fov === undefined || p.clipStart === undefined || p.clipEnd === undefined) {
    return err(invalidValue({ reason: 'cameraProjectionNotDeclared', objectId: source.objectId }))
  }
  if (!Number.isFinite(p.fov) || p.fov <= 0) {
    return err(invalidValue({ reason: 'fovMustBePositive', objectId: source.objectId }))
  }
  return ok(
    Object.freeze({
      projection: p.projection,
      position: Object.freeze({ x: view.position.x, y: view.position.y, z: view.position.z }),
      target: Object.freeze({ x: view.target.x, y: view.target.y, z: view.target.z }),
      up: Object.freeze({ x: view.up.x, y: view.up.y, z: view.up.z }),
      fovDegrees: p.fov,
      near: p.clipStart,
      far: p.clipEnd,
    }),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 时间：固定采样序列
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 时间映射（「运行时间动画必须映射为固定的起始时间与时间序列」）。
 *
 * - `scene`：采样直接是场景时间轴上的帧号（起始帧 + 步长 × 序号）；
 * - `runtime`：**必须**给出 `anchorSeconds` —— 运行时间在导出中的固定起点。
 *   缺它即预检失败，因为"从执行当刻的墙钟开始"正是禁止的事；
 * - `scene-holds`：**逐帧驻留是唯一权威**，采样时刻由累积时长派生。
 *   它表达"一个循环的逐帧 hold"（GIF 时延的来源）；均匀形态在
 *   {@link planCaptureFrames} 内部**展开成同一种 holds**，故生成路径只有一条。
 *
 * `clock` 只在 `runtime` 下出现，且必须是**装配层安装了**的时钟 ID
 * （{@link validateTimeMapping} 逐个核对；未安装 ⇒ `UnsupportedOperation`，
 * 与 `domain/materials.resolveTimeBinding` 同一判据与同一 reason）。
 */
export type TimeMapping =
  | { readonly source: 'scene'; readonly startFrame: number; readonly stepFrames: number }
  | { readonly source: 'runtime'; readonly clock: string; readonly anchorSeconds: number; readonly stepFrames: number }
  /**
   * 逐帧驻留。**时长是唯一权威**，帧序列由累积时长派生。
   *
   * - `startSeconds`：首个采样在场景时间轴上的起点（秒）。整数帧起点也用它表达
   *   （`startFrame / fps`），使 holds 与均匀形态共用同一个"起点"概念。
   * - `holdsMs[i]`：第 i 个采样在产物里的驻留（**毫秒整数、>= 1**）；
   *   第 i 个采样的时刻 = `startSeconds + Σ_{j<i} holdsMs[j]/1000`。
   *
   * 时长上限复用 `domain/materials#LOOP_LIMITS`（与 GIF 的"太长"定义同一张表）。
   * `runtime` 映射**不**支持 holds（`runtimeHoldMappingUnsupported`）：
   * 运行时间映射已有显式 `anchorSeconds`，再叠逐帧 hold 会变成两套语义。
   */
  | { readonly source: 'scene-holds'; readonly startSeconds: number; readonly holdsMs: readonly number[] }

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
  /**
   * 该采样在产物里的驻留（毫秒整数、>= 1）。
   *
   * **缺席 = 未声明驻留**（单帧图片、或未走 `planCaptureFrames` 的手工请求），
   * **不用 0 冒充"没有驻留"**（沿用"缺席就是缺席"的形状纪律）。
   * 动画编码要求每一帧都在场（见 `adapters/export/gifEncoderPort`）。
   */
  readonly holdMs?: number
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
   * 动画状态（轨道 + 发布默认值；属文档状态域）。
   *
   * 采样**不另立播放循环**：导出的每个采样时刻都交给同一份 `AnimationState`
   * 与同一套 `sampleTrack` 求值 —— 与实时视口走同一条求值路径。
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
 * 判据（每条一个 distinct reason，全部在本函数一处判定）：
 *  1. `frameCount` 必须为正整数、渲染尺寸必须为正整数 —— 否则 `InvalidValue`
 *     （不夹取、不"用 1 代替"，「不把任意小数写成非法取值」的同族要求）；
 *  2. `runtime` 映射缺 `anchorSeconds` ⇒ `UnsupportedOperation{reason:'runtimeTimeMappingMissing'}`；
 *     携带 `holdsMs` ⇒ `runtimeHoldMappingUnsupported`（运行时间映射不叠逐帧 hold）；
 *  3. `scene-holds`：起点有限（允许负数）、条数 == `frameCount`
 *     （`holdCountMismatch`）、每项为整数且 >= 1（`holdDurationInvalid`）；
 *  4. 时长上限复用 `LOOP_LIMITS`（`captureHoldsExceedLimits`，**不截断、不抽帧**）；
 *  5. 序列由 `(起点, 步长/累积时长, 序号)` 决定，**不读任何时钟** —— 于是"导出期间继续编辑"
 *     不可能改变这次快照的采样时间（判据原文）。
 *
 * **均匀形态不另走一条路径**：它先按"每帧驻留 = 步长对应的毫秒"展开成 holds
 * （有理帧率下非整数 ⇒ `uniformHoldNotIntegralMs`，不四舍五入），之后与
 * `scene-holds` 共用同一个累积循环 ⇒ "哪个是时间权威"只有一个答案（展开后的序列）。
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
  const fps = rationalToNumber(rate.value)
  const mapping = spec.mapping

  // `runtime` 不得携带逐帧 holds（类型上不可表达；运行时也要判红，
  // 因为反序列化回来的请求与 JS 调用方可以绕过类型）。
  if (mapping.source === 'runtime' && Object.prototype.hasOwnProperty.call(mapping, 'holdsMs')) {
    return err(unsupportedOperation({ reason: 'runtimeHoldMappingUnsupported', clock: mapping.clock }))
  }

  let startSeconds: number
  let holdsMs: number[]
  if (mapping.source === 'scene-holds') {
    // 起点必须有限（**允许负数** —— 采样器对负时间取模，与 `normalizeIsoSeconds` 同口径）。
    startSeconds = mapping.startSeconds
    if (typeof startSeconds !== 'number' || !Number.isFinite(startSeconds)) {
      return err(invalidValue({ reason: 'startSecondsNotFinite', startSeconds: String(startSeconds) }))
    }
    // 条数必须与 `frameCount` 一致（空表也是"不一致"，不产出 1 帧假动画）。
    if (!Array.isArray(mapping.holdsMs) || mapping.holdsMs.length !== spec.frameCount) {
      return err(
        invalidValue({
          reason: 'holdCountMismatch',
          frameCount: spec.frameCount,
          holds: Array.isArray(mapping.holdsMs) ? mapping.holdsMs.length : 0,
        }),
      )
    }
    // 每项须为整数且 >= 1（0/负数/小数在 GIF 里没有含义；1 厘秒地板是**编码层**的量化）。
    holdsMs = []
    for (let i = 0; i < mapping.holdsMs.length; i++) {
      const h = mapping.holdsMs[i]
      if (typeof h !== 'number' || !Number.isInteger(h) || h < 1) {
        return err(
          invalidValue({
            reason: 'holdDurationInvalid',
            index: i,
            holdMs: typeof h === 'number' && Number.isFinite(h) ? h : String(h),
          }),
        )
      }
      holdsMs.push(h)
    }
  } else {
    // 均匀形态：起点与步长按**既有判据**解析（reason 逐字保留）。
    let baseFrame: number
    if (mapping.source === 'scene') {
      baseFrame = mapping.startFrame
    } else {
      // 先用**同一判据**核对时间源是否安装（与 `domain/materials.resolveTimeBinding` 一致）：
      // 显示"支持运行时间"却默默按场景时间播，正是判据要判红的形态。
      if (!available.runtimeClocks.includes(mapping.clock)) {
        return err(
          unsupportedOperation({
            reason: 'runtimeClockNotInstalled',
            clock: mapping.clock,
            binding: 'runtime',
          }),
        )
      }
      const anchor = mapping.anchorSeconds
      if (typeof anchor !== 'number' || !Number.isFinite(anchor)) {
        // 「缺少映射时预检失败」——**不**退回"按场景时间播"（那正是负对照要判红的形态）。
        return err(
          unsupportedOperation({
            reason: 'runtimeTimeMappingMissing',
            clock: mapping.clock,
            binding: 'runtime',
          }),
        )
      }
      baseFrame = anchor * fps
    }
    if (!Number.isFinite(baseFrame)) {
      return err(invalidValue({ reason: 'startFrameNotFinite', frame: String(baseFrame) }))
    }
    const step = mapping.stepFrames
    if (!Number.isInteger(step) || step < 0) {
      return err(invalidValue({ reason: 'stepFramesInvalid', stepFrames: mapping.stepFrames }))
    }

    // **C 案的核心**：均匀形态展开成 holds，之后只有一条生成路径。
    // 每帧驻留 = 采样步长对应的毫秒（`step === 0` 时停在相同时刻，驻留仍按 1 帧计）。
    // 有理帧率下可能不是整数（如 30fps ⇒ 1000/30）⇒ **显式失败、不四舍五入**：
    // 四舍五入会让"每帧 50ms"静默变成"33/34ms 交替"，声明与产物分叉。
    const frameMs = (step === 0 ? 1000 : step * 1000) / fps
    if (!Number.isInteger(frameMs)) {
      return err(
        invalidValue({
          reason: 'uniformHoldNotIntegralMs',
          fps,
          stepFrames: step,
          holdMs: String(frameMs),
        }),
      )
    }
    startSeconds = baseFrame / fps
    holdsMs = new Array(spec.frameCount).fill(frameMs)
  }

  // 上限复用 GIF 的**同一张**表（不另立第二组"太长"的定义）；超限**不截断、不抽帧**。
  let totalMs = 0
  for (const h of holdsMs) totalMs += h
  if (holdsMs.length > LOOP_LIMITS.maxFrames || totalMs > LOOP_LIMITS.maxTotalMs) {
    return err(
      unsupportedOperation({
        reason: 'captureHoldsExceedLimits',
        frames: holdsMs.length,
        totalMs,
        maxFrames: LOOP_LIMITS.maxFrames,
        maxTotalMs: LOOP_LIMITS.maxTotalMs,
      }),
    )
  }

  // 唯一生成路径：时刻 = 起点 + 累积时长；不引入"不前进的采样"。
  const out: CaptureTime[] = []
  let accMs = 0
  for (let i = 0; i < holdsMs.length; i++) {
    const seconds = startSeconds + accMs / 1000
    const time = timeFromSeconds(seconds, spec.frameRate)
    // 「两个时间字段不许互相矛盾」的可检查形态。正常换算不可能触发；
    // 留给"有人改了换算"时炸，而不是静默漂移。
    const timeSeconds = rationalToNumber(secondsOf(time))
    if (Math.abs(timeSeconds - seconds) > 1e-6) {
      return err(invalidValue({ reason: 'holdTimeNotFaithful', index: i, seconds, timeSeconds }))
    }
    out.push(Object.freeze({ index: i, time, seconds, holdMs: holdsMs[i]! }))
    accMs += holdsMs[i]!
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
 * 不可变导出请求。
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
   * 捕获时刻已知的**能力损失**（旧格式可表达性诊断；「必要时导出烘焙结果，
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
    mapping: freezeTimeMapping(init.mapping),
    assets: Object.freeze([...init.assets]),
    capabilityLoss: Object.freeze([...init.capabilityLoss]),
  })
}

/**
 * 冻结时间映射 —— `scene-holds` 的 `holdsMs` 必须**深冻结**。
 *
 * 只做 `{...mapping}` 会让外部仍持有同一个 `holdsMs` 数组：之后一次
 * `push/splice` 就能改掉"不可变请求"的时间序列（判据点）。
 */
function freezeTimeMapping(mapping: TimeMapping): TimeMapping {
  switch (mapping.source) {
    case 'scene':
      return Object.freeze({ source: 'scene', startFrame: mapping.startFrame, stepFrames: mapping.stepFrames })
    case 'runtime':
      return Object.freeze({
        source: 'runtime',
        clock: mapping.clock,
        anchorSeconds: mapping.anchorSeconds,
        stepFrames: mapping.stepFrames,
      })
    case 'scene-holds':
      return Object.freeze({
        source: 'scene-holds',
        startSeconds: mapping.startSeconds,
        holdsMs: Object.freeze([...mapping.holdsMs]),
      })
  }
}

/**
 * 捕获时刻的**能力损失**判定（旧结构格式的可表达性）。
 *
 * 直接用已交付的挂点 `legacyExportDiagnostics`：非整数格平移、非恒等旋转/缩放、
 * 显式枢轴、固定拓扑形变都**不能**忠实写出。本函数只是把它接到导出请求上，
 * **不**重新实现一份判据（否则会出现两套"什么算不可表达"）。
 */
export function captureCapabilityLoss(scene: Scene): readonly LegacyExportDiagnostic[] {
  return legacyExportDiagnostics(scene)
}
