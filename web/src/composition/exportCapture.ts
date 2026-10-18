/**
 * `composition/exportCapture` —— **一次导出捕获 = 派生场景 + 四个相机值 + 冻结帧序列 + 资源表**（M6-3）。
 *
 * ## 它替代了什么（旧链的两处"第二权威"）
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | 导出内容 = `ctx.plainForSave().plain`（**声明态**），再自建材质库/网格 | `workbench/exportIsometricImage.ts`（M6-3 已删） | 内容 = `kernelPresentationSnapshot()` 的**派生场景**（与屏上同一个求值点） |
 * | 时间 = 一个 `seconds` 参数，逐帧再 `setSceneTime` | `workbench/exportAnimatedGif.ts`（已删） | 时间 = `planCaptureFrames` 产出的**冻结序列**（含逐帧 `holdMs`） |
 *
 * ## 为什么捕获必须与屏上共用一个求值方法
 *
 * 屏上的画面源是 `Context#kernelPresentationDocument()`。本模块只读
 * `kernelPresentationSnapshot()`（它内部调的就是那一个方法），**不**自己调
 * `evaluateMultiblockPresentation`，也**不**自己读 `channelValues()` 再拼。
 * ⇒ "取值 → 派生"的组合仍然只有一处；屏上改了 memo 键，导出自动跟着改。
 *
 * ## 三件事必须来自**同一次**捕获（不是三次调用）
 *
 * 1. `textureResources`（喂设备 **和** 绑会话的是**同一个数组值**）；
 * 2. `assetNeeds`（清单与画面同源；见设计 R8）；
 * 3. `presentation`（编译输入只算一次）。
 *
 * ## 纯性
 *
 * 本模块**不**解码字节（`TextureDecoder` 是注入的端口）、不碰 DOM、不读墙钟。
 * ⇒ 它能在 vitest 里用真实夹具跑完整捕获（判据见 `__tests__/exportCapture.test.ts`）。
 */

import { err, ok, unsupportedOperation, type Result } from '@/domain/errors'
import type { AnimationState } from '@/domain/animation'
import { sceneClockOf, timeFromSeconds } from '@/domain/animation'
import type { CameraSpec, CaptureSpec, ExportAssetNeed, ExportRequest, RenderSettings, TimeMapping } from '@/domain/captureSpec'
import { freezeExportRequest } from '@/domain/captureSpec'
import type { DocumentContent } from '@/domain/content'
import type { Version } from '@/domain/identity'
import { LOOP_LIMITS, planSequenceLoop, type SequenceLoopPlan } from '@/domain/materials'
import type { Scene } from '@/domain/scene'
import type { AssetNeedDerivation, CaptureInput } from '@/application/exportPlan'
import { deriveAssetNeeds, planExportRequest } from '@/application/exportPlan'
import type { EvaluationKey, PresentationInputs } from '@/presentation/evaluationKey'
import { isoCameraSpecsOf, type IsoExportBounds } from '@/presentation/isoExportCamera'
import { compileScene } from '@/presentation/compileScene'
import type { TextureResource } from '@/presentation/textureBinding'
import { AssetStateStore } from '@/presentation/assetState'
import { kernelPresentationInputs } from '@/composition/kernelPresentationInputs'
import { textureResourcesOf, type TextureDecoder } from '@/composition/kernelTextureResources'

/**
 * 捕获读面（**窄接口**：本模块不 import `runtime/context`）。
 *
 * 生产里传的就是 `Context` 自己（结构满足）。窄接口的用处：捕获可被单测/探针
 * 用"手搓的值"驱动，而那**不会**让生产多出第二条求值路径。
 */
export interface ExportCaptureSource {
  kernelPresentationSnapshot(): {
    readonly scene: Scene
    readonly content: DocumentContent
    readonly animation: AnimationState
    readonly version: Version
    readonly channels: Readonly<Record<string, number>>
  } | null
}

export type ExportCaptureKind = 'image' | 'animation'

export interface ExportCaptureOptions {
  readonly kind: ExportCaptureKind
  /** 等轴方向 0..3（调用方已归一 —— 本模块不静默夹取）。 */
  readonly directionIndex: number
  /** 渲染边长（像素）。**形参搬运**：缺省值属于命令侧（Q1/M6-5 未统一），本模块不写死。 */
  readonly pixelSize: number
  /** 仅 `kind === 'image'`：场景秒（缺省 0 由调用方归一后传入）。 */
  readonly seconds?: number
  /** 纹理解码器（注入；本模块不碰 DOM）。 */
  readonly decoder: TextureDecoder
  /** 注入时钟（纯层不读 `Date.now()`）。 */
  readonly now: number
  /** 请求 ID（诊断用；缺省按 kind 生成）。 */
  readonly requestId?: string
  /**
   * 逐帧驻留的上限表（缺省 = `domain/materials#LOOP_LIMITS`，与 GIF 的"太长"同一张表）。
   *
   * ## 为什么它是**参数**而不是常量
   *
   * 上限本身是产品政策（30 s / 240 帧），但"超限要显式失败"这条**行为**必须可判。
   * 夹具不可能真的声明 30 s+ 的循环（那会让判据本身变慢且脆弱），故判据把上限压低到
   * 夹具可触发的量级 —— 判的是**同一条路径**（`planSequenceLoop` 的 `textureLoopTooLong`
   * → 捕获失败 → 零产物），不是另写一条"模拟超限"的分支。
   */
  readonly loopLimits?: { readonly maxFrames: number; readonly maxTotalMs: number }
}

/** 一次捕获的**全部**产物（值；之后不再回读编辑器）。 */
export interface ExportCapture {
  readonly request: ExportRequest
  readonly content: DocumentContent
  readonly textureResources: readonly TextureResource[]
  readonly assetNeeds: AssetNeedDerivation
  readonly assets: AssetStateStore
  /** 四个相机值（请求里存被选中的那一个；其余三个同批算出，供诊断）。 */
  readonly cameras: readonly [CameraSpec, CameraSpec, CameraSpec, CameraSpec]
  readonly bounds: IsoExportBounds
  /** 动画的时间计划（`kind === 'animation'` 时在场；帧数与总时长是 UI 声明的来源）。 */
  readonly loop: SequenceLoopPlan | null
}

/** 批次计划的并集包围盒（世界空间；`BatchPlan.bounds` 逐字段来自图元）。 */
function unionBoundsOf(plans: readonly { readonly bounds: IsoExportBounds }[]): IsoExportBounds {
  if (plans.length === 0) return { min: [0, 0, 0], max: [0, 0, 0] }
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const p of plans) {
    for (let i = 0; i < 3; i += 1) {
      if (p.bounds.min[i]! < min[i]!) min[i] = p.bounds.min[i]!
      if (p.bounds.max[i]! > max[i]!) max[i] = p.bounds.max[i]!
    }
  }
  return { min, max }
}

/** 有理秒 → 毫秒整数（非整数 ⇒ `null`：声明时长不可精确表达，由调用方显式失败）。 */
function durationMsOf(d: { readonly num: number; readonly den: number }): number | null {
  if (!Number.isFinite(d.num) || !Number.isFinite(d.den) || d.den === 0) return null
  const ms = (d.num * 1000) / d.den
  return Number.isInteger(ms) && ms > 0 ? ms : null
}

/**
 * 从**捕获期那一份**资源表反推"一个循环"的逐帧驻留（毫秒）。
 *
 * 帧数与逐帧时长来自 `TextureAnimationBinding.sequence`（由**声明 + 像素尺寸**派生，
 * `domain/textureAnimation`）；共同循环的排布来自 `domain/materials#planSequenceLoop`
 * —— 与旧链**同一个**函数、同一份口径（不再问材质库）。
 */
function loopOf(
  resources: readonly TextureResource[],
  limits: { readonly maxFrames: number; readonly maxTotalMs: number },
): Result<SequenceLoopPlan> {
  const strips: { readonly id: string; readonly frameCount: number; readonly durationsMs: readonly number[] }[] = []
  for (const r of resources) {
    const animation = r.animation
    if (animation === undefined) continue
    const durationsMs: number[] = []
    for (const f of animation.sequence.frames) {
      const ms = durationMsOf(f.duration)
      if (ms === null) {
        return err(
          unsupportedOperation({
            reason: 'textureDurationNotIntegralMs',
            assetId: r.identity.id,
            seconds: String(f.duration.num) + '/' + String(f.duration.den),
          }),
        )
      }
      durationsMs.push(ms)
    }
    strips.push({ id: r.identity.id, frameCount: animation.sequence.frames.length, durationsMs })
  }
  if (strips.length === 0) {
    // 没有动画序列 ⇒ **显式失败**（不产出单帧假 GIF，与旧链同一处置）。
    return err(unsupportedOperation({ reason: 'noAnimatedSequences' }))
  }
  return planSequenceLoop(strips, limits)
}

/** `SequenceLoopPlan` → 逐段驻留（与帧一一对应；最后一段回绕到 `totalMs`）。 */
function holdsOf(loop: SequenceLoopPlan): readonly number[] {
  return loop.atMs.map((at, i) => (i + 1 < loop.atMs.length ? loop.atMs[i + 1]! : loop.totalMs) - at)
}

/**
 * **捕获一次导出**（唯一入口）。
 *
 * 顺序（每一步失败都**不产出**请求）：
 *  1. 读与屏上同一求值点的派生场景（`kernelPresentationSnapshot`）；
 *  2. 编译一次（`kernelPresentationInputs` → `compileScene`）：拿到包围盒与可绘制批次；
 *  3. 解码纹理（注入的解码器）：得到**唯一一份** `TextureResource[]`；
 *  4. 反推资源需求（`deriveAssetNeeds`，消费同一次编译输入）；
 *  5. 四向相机 = 四个值（包围盒 → `isoCameraSpecsOf`）；
 *  6. 冻结帧序列与不可变请求（`planExportRequest`）。
 */
export async function captureExportSnapshot(
  source: ExportCaptureSource,
  options: ExportCaptureOptions,
): Promise<Result<ExportCapture>> {
  const snap = source.kernelPresentationSnapshot()
  if (snap === null) {
    // 无会话/未采纳内容 ⇒ **如实失败**，不回落旧文档（那会成为第二条内容权威）。
    return err(unsupportedOperation({ reason: 'exportCaptureNoKernelDocument' }))
  }
  const frameRate = 20
  const startSeconds = options.kind === 'image' ? (options.seconds ?? 0) : 0
  const firstTime = timeFromSeconds(startSeconds, frameRate)
  const key: EvaluationKey = Object.freeze({
    documentVersion: snap.version.documentVersion,
    scene: snap.scene.id,
    time: sceneClockOf(firstTime),
    parameterVersion: 0,
    // 资源版本参与内容身份（与屏上同一口径：逐资源 contentVersion）。
    contentResourceVersions: Object.freeze(
      Object.fromEntries(snap.content.resources.map((r) => [r.ref.assetId, r.ref.contentVersion])),
    ),
  })

  // ② 与屏上**同一编译输入**（`layerWorldY: null` = 不分层，与导出语义一致）。
  const presented: { readonly inputs: PresentationInputs; readonly skipped: readonly { readonly objectId: string; readonly reason: string }[] } =
    kernelPresentationInputs({ scene: snap.scene, content: snap.content, key, layerWorldY: null })
  const compiled = compileScene(presented.inputs)
  if (!compiled.ok) {
    return err(unsupportedOperation({ reason: 'exportCaptureCompileFailed', code: compiled.error.code }))
  }
  if (compiled.value.payloads.length === 0) {
    const merged = [
      ...presented.skipped,
      ...compiled.value.skipped.map((s) => ({ objectId: s.objectId, reason: String(s.reason) })),
    ]
    return err(
      unsupportedOperation({
        reason: 'exportCaptureNoDrawableContent',
        skipped: merged.map((s) => s.objectId + ':' + s.reason).join(','),
      }),
    )
  }

  // ③ 纹理：**唯一一份**（同一数组值同时喂设备与绑定；见设计 $7.2 第三层）。
  let textureResources: readonly TextureResource[]
  try {
    textureResources = await textureResourcesOf(snap.content.resources, options.decoder)
  } catch (e) {
    return err(unsupportedOperation({ reason: 'exportCaptureTextureDecodeThrew', detail: String(e) }))
  }

  const bounds = unionBoundsOf(compiled.value.plans)
  const cameras = isoCameraSpecsOf({ bounds })
  if (!Number.isInteger(options.directionIndex) || options.directionIndex < 0 || options.directionIndex > 3) {
    return err(unsupportedOperation({ reason: 'exportCaptureDirectionInvalid', direction: options.directionIndex }))
  }
  const camera = cameras[options.directionIndex]!
  const render: RenderSettings = { width: options.pixelSize, height: options.pixelSize, background: 'transparent' }

  // ⑥ 时间序列（GIF：逐帧驻留来自声明；PNG：单帧在 `seconds`）。
  const loop = options.kind === 'animation'
    ? loopOf(textureResources, options.loopLimits ?? LOOP_LIMITS)
    : null
  if (loop !== null && !loop.ok) return err(loop.error)
  const plannedLoop = loop !== null && loop.ok ? loop.value : null
  const mapping: TimeMapping = plannedLoop !== null
    ? { source: 'scene-holds', startSeconds: 0, holdsMs: holdsOf(plannedLoop) }
    : { source: 'scene', startFrame: startSeconds * frameRate, stepFrames: 0 }
  const frameCount = plannedLoop !== null ? plannedLoop.frameCount : 1
  const spec: CaptureSpec = {
    frameRate,
    frameCount,
    mapping,
    channels: snap.channels,
    camera: { kind: 'view', label: 'iso-' + String(options.directionIndex), view: camera },
    render,
    animation: snap.animation,
  }

  // ④ 资源需求（消费**同一次**编译输入 ⇒ 清单与画面同源）。
  const assetNeeds = deriveAssetNeeds({
    scene: snap.scene,
    animation: snap.animation,
    frames: [],
    spec,
    presentation: presented.inputs,
  })
  if (assetNeeds.status !== 'derived') {
    return err(unsupportedOperation({ reason: assetNeeds.reason, derivation: assetNeeds.status }))
  }

  const init: CaptureInput = {
    requestId: options.requestId ?? 'export-' + options.kind + '-' + String(options.directionIndex),
    now: options.now,
    documentId: snap.scene.id,
    version: snap.version,
    scene: snap.scene,
    animation: snap.animation,
    camera: spec.camera,
    spec,
    // 清单与画面同源：这里传的是**同一次**反推的产物。
    assets: assetNeeds.assets,
  }
  const planned = planExportRequest(init)
  if (!planned.ok) return err(planned.error)

  // 资源状态面：**按捕获期的事实**登记（就绪的才算就绪；缺/失败的留在非就绪态
  // ⇒ 预检按 A29 判 blocked，而不是"先放行再画一张缺贴图的图"）。
  const assets = new AssetStateStore()
  for (const r of textureResources) {
    const need = assetNeeds.assets.find((a) => a.assetId === r.identity.id)
    if (need === undefined) continue
    const ticket = assets.begin({
      identity: { id: r.identity.id, version: r.identity.version },
      locator: { kind: r.locator.kind, url: r.locator.url },
      required: need.required,
    })
    if (r.state === 'ready') assets.complete(r.identity.id, ticket.requestId, r.identity.version)
    else if (r.state === 'failed') {
      assets.markFailed(r.identity.id, ticket.requestId, r.failure ?? 'decode-failed', true)
    }
  }

  // `planExportRequest` 内部已冻过一次；这里再冻一次是**幂等**的，且让
  // "返回的请求确实不可变"成为本函数的后置条件（而不是调用方的信任）。
  const request = freezeExportRequest({
    requestId: planned.value.requestId,
    createdAt: planned.value.createdAt,
    payload: planned.value.payload,
    camera: planned.value.camera,
    frames: planned.value.frames,
    channels: planned.value.channels,
    render: planned.value.render,
    mapping: planned.value.mapping,
    assets: planned.value.assets,
    capabilityLoss: planned.value.capabilityLoss,
  })

  return ok(
    Object.freeze({
      request,
      content: snap.content,
      textureResources,
      assetNeeds,
      assets,
      cameras,
      bounds,
      loop: plannedLoop,
    }),
  )
}

/** 供判据/诊断：请求里的资源条目（与 `ExportAssetNeed` 同形状）。 */
export type { ExportAssetNeed }
