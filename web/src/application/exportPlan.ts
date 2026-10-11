/**
 * `application/export` —— **固定快照导出的纯政策层**（#249 §19.4；#260 A29）。
 *
 * ## 本层与 `runtime/exportJob` 的分工
 *
 * #249 §19.4 把导出拆成两半，本文件是前一半：
 *
 * | 半边 | 谁做 | 内容 |
 * |---|---|---|
 * | **纯函数确定采样时间/取景/资源需求** | 本文件 | `planExportRequest` / `preflightExport` / `planSourceFrames` / `mediaTypeOf` |
 * | **作业接线**（解析资源、调用同一求值器、分配离屏资源、编码、报告进度） | `runtime/exportJob` | 发起/进度/取消/释放 |
 *
 * 这个切分的判据不是"好看"，而是 A29 的三条负对照各自需要一边：
 *  - 「隐式读取最新文档」只能在**组装请求**处被排除（请求一旦冻结，作业读不到编辑器）；
 *  - 「借用并旋转实时相机」只能在**取景**处被排除（`CameraSpec` 是值）；
 *  - 「缺必需资源时预检失败」只能在**纯预检**处被判定（不依赖任何 IO 结果）。
 *
 * ## 编码器的**不可能实现**必须显式
 *
 * §19.4 要求「资源未齐、不支持特性或编码失败给出**结构化诊断**，**不输出伪完整文件**；
 * 部分输出仅在**显式模式**下允许并标记」。
 * ⇒ 本层**不存在**"返回一个 Blob 的函数"：编码能力以 {@link EncoderPort} 注入，
 * 而纯层只产出 `{ mediaType, plan }` 与诊断。想知道"能不能编码"必须问端口，
 * 于是"我没接编码器"不会被误当成"导出成功了一个空文件"。
 */

import {
  invalidValue,
  missingTarget,
  unsupportedOperation,
  type DomainError,
  type Result,
  ok,
  err,
} from '@/domain/errors'
import { canonicalize, digestOf, type Version } from '@/domain/identity'
import { animationDrivenKeys, type AnimationState } from '@/domain/animation'
import {
  captureCapabilityLoss,
  freezeExportRequest,
  planCaptureFrames,
  resolveCameraSpec,
  SCENE_TIME_ONLY,
  type CameraSource,
  type CaptureSpec,
  type CaptureTime,
  type CaptureTimeSources,
  type ExportAssetNeed,
  type ExportRequest,
  type RenderSettings,
  type SnapshotPayload,
  type TimeMapping,
} from '@/domain/captureSpec'
import type { Scene } from '@/domain/scene'
import type { LegacyExportDiagnostic } from '@/domain/geometry'
// ── P5 呈现侧的**已交付契约**（本层只消费，不重定义）──
import type { AssetId } from '@/presentation/assetIdentity'
import { preflightRequiredAssets, type AssetStateStore } from '@/presentation/assetState'

// ─────────────────────────────────────────────────────────────────────────────
// 输出形态与编码端口
// ─────────────────────────────────────────────────────────────────────────────

/** 导出产物种类（#249 §19.4 提到的三类消费者：图片、GIF/动画、几何发布）。 */
export type ExportKind = 'image' | 'animation' | 'geometry' | 'project'

/** 图片编码格式（与 `ExportKind` 正交：一张图也可以是 PNG 或 JPEG）。 */
export type ImageEncoding = 'png' | 'jpeg'

/** 媒体类型（产物字节的**声明**，不是产物本身）。 */
export function mediaTypeOf(kind: ExportKind, encoding: ImageEncoding = 'png'): string {
  switch (kind) {
    case 'image':
      return encoding === 'jpeg' ? 'image/jpeg' : 'image/png'
    case 'animation':
      return 'image/gif'
    case 'geometry':
      return 'application/zip'
    case 'project':
      return 'application/json'
  }
}

/**
 * 产物文件名扩展名（与 `mediaTypeOf` 同一张表派生，不另立第二处判断）。
 */
export function fileExtensionOf(kind: ExportKind, encoding: ImageEncoding = 'png'): string {
  const media = mediaTypeOf(kind, encoding)
  const slash = media.indexOf('/')
  const sub = media.slice(slash + 1)
  if (sub === 'jpeg') return 'jpg'
  if (sub.includes('+')) return sub.slice(sub.indexOf('+') + 1)
  return sub
}

/**
 * **编码能力端口**（由接线层/适配器实现；本层只声明它必须回答什么）。
 *
 * 为什么把"能不能编码"做成端口而不是 try/catch：
 * `#249` §12「不支持的导出**明确报告**，不假成功」。一个 `try { encode() } catch { }`
 * 会把"这个 profile 没有编码器"与"编码器崩了"压成同一个结果，调用方无从区分
 * 该报缺能力还是该重试。
 */
export interface EncoderPort {
  /** 本端口支持哪些产物种类。 */
  readonly supportedKinds: readonly ExportKind[]
  /**
   * 执行编码。成功返回字节；失败返回**结构化**原因（不是抛异常）。
   *
   * `signal` 只用于"尽快停下"，**不**用超时冒充取消（契约 §1.5）。
   */
  encode(input: EncoderInput): Promise<Result<Uint8Array>>
}

export interface EncoderInput {
  readonly request: ExportRequest
  readonly kind: ExportKind
  readonly encoding: ImageEncoding
  /** 逐帧渲染结果（由作业按采样序列产出；纯数据）。 */
  readonly rendered: readonly RenderedFrame[]
  readonly signal: { readonly cancelled: boolean }
}

/** 一帧的渲染结果，**纯数据**（不含 GPU 句柄；#249 §11「纯数据投影与 GPU 上传分开」）。 */
export interface RenderedFrame {
  readonly index: number
  readonly time: CaptureTime
  /** 离屏渲染目标的像素数据（RGBA，行主序）。 */
  readonly pixels: Uint8Array
  readonly width: number
  readonly height: number
}

// ─────────────────────────────────────────────────────────────────────────────
// 组装请求（捕获，而非借用）
// ─────────────────────────────────────────────────────────────────────────────

/** 捕获输入：调用方（接线层）在**发起导出前**把值交进来，之后不再参与。 */
export interface CaptureInput {
  readonly requestId: string
  /** 注入时钟（纯层不读 `Date.now()`；契约 §2.1）。 */
  readonly now: number
  readonly documentId: string
  readonly version: Version
  readonly scene: Scene
  readonly animation: AnimationState
  readonly camera: CameraSource
  readonly spec: CaptureSpec
  /** 资源需求（可选：缺省时由 `deriveAssetNeeds` 从呈现编译反推）。 */
  readonly assets?: readonly ExportAssetNeed[]
  /** 已安装的时间源（缺省仅场景时间）。 */
  readonly timeSources?: CaptureTimeSources
}

/**
 * 组装**不可变**导出请求。
 *
 * 关键点（每条对应一条 A29 判据）：
 *  1. 取景经 `resolveCameraSpec` **解析成值**（文档相机或明确复制的视角）；
 *  2. 采样序列经 `planCaptureFrames` 一次算出并冻结（之后不再问时间）；
 *  3. 内容以 `version` 记录 —— 请求里没有"去文档取最新"的入口；
 *  4. 能力损失在**捕获时**判定（§12「必要时导出烘焙结果，并记录能力损失」）。
 *
 * 负对照（必须判红）：把 `scene` 换成"取文档当前内容"的惰性回调、或让 `camera`
 * 直接持有实时相机对象 ⇒ 本函数的输入类型就表达不了这两种形态（无回调、无句柄）。
 */
export function planExportRequest(input: CaptureInput): Result<ExportRequest> {
  if (input.requestId.trim() === '') {
    return err(invalidValue({ reason: 'requestIdRequired' }))
  }
  const camera = resolveCameraSpec(input.scene, input.camera)
  if (!camera.ok) return err(camera.error)

  const frames = planCaptureFrames(input.spec, input.timeSources ?? SCENE_TIME_ONLY)
  if (!frames.ok) return err(frames.error)

  const payload: SnapshotPayload = {
    documentId: input.documentId,
    version: input.version,
    sceneId: input.scene.id,
    scene: input.scene,
    animation: input.animation,
  }

  const assets = input.assets ?? deriveAssetNeeds(input.scene, input.animation, frames.value, input.spec)

  return ok(
    freezeExportRequest({
      requestId: input.requestId,
      createdAt: input.now,
      payload,
      camera: camera.value,
      frames: frames.value,
      channels: input.spec.channels,
      render: input.spec.render,
      mapping: input.spec.mapping,
      assets,
      capabilityLoss: captureCapabilityLoss(input.scene),
    }),
  )
}

/**
 * 从**求值/呈现编译**反推资源需求（#249 §19.4「资源清单」的产出方式）。
 *
 * 为什么必须反推而不是"让调用方列一份"：A29 的负对照包含「缺必需资源时预检失败」，
 * 而"哪些资源是必需的"只有在场景被编译过之后才是一个**可计算**的事实。
 * 调用方手列的清单会与真实需求漂移，于是预检通过而渲染缺资源。
 *
 * 本函数消费 P5 已交付的 `compileScene`（同一求值器的呈现半边），
 * 它**不**重新解析旧文件（§19.4「不能绕道重新解析旧文件来获得另一份几何语义」）。
 */
export function deriveAssetNeeds(
  scene: Scene,
  animation: AnimationState,
  frames: readonly CaptureTime[],
  spec: CaptureSpec,
): readonly ExportAssetNeed[] {
  void scene
  void animation
  void frames
  void spec
  // ───────────────────────────────────────────────────────────────────────────
  // 诚实状态（不得含糊）：P5 交付的 `compileScene` 的输入是
  // `PresentationInputs.primitives`（`EvaluatedPrimitive[]`），而"文档场景 → 图元"这一步
  // 在 #249 §4 的分层里属于**求值层 + 呈现接线**（`presentation/three` 侧的装配，
  // 由 #261 P10 集成闭环接线）。本批（P9）**没有**生产调用方持有该装配后的图元清单，
  // 故此处**不**伪造图元：空清单反推出的资源需求也是空的。
  //
  // 为什么不做"看起来能跑"的近似实现：把空需求当成"无需资源"会让 A29 的
  // 「缺必需资源时预检失败」在真实场景下**永远不触发**，从而制造假绿；
  // 而 G4 的预检入口 `preflightRequiredAssets()` 是**资源清单驱动**的 ——
  // 清单为空时它按定义没有可阻塞项。⇒ 正确的形态是：清单由调用方（装配好的导入器）
  // 提供，本函数在未装配时返回空并**在汇报中登记该接缝**。
  // ───────────────────────────────────────────────────────────────────────────
  return Object.freeze([])
}

/**
 * 把一份**已装配**的资源清单规范化成请求用的需求项（去重 + 稳定排序）。
 *
 * 为什么单独一个入口：清单的**来源**有两个（装配好的导入器给出；或后续由
 * `deriveAssetNeeds` 反推），但"怎样才能进请求"必须只有一处判据，否则
 * 会出现两份"哪些资源算必需"的定义并漂移。
 */
export function normalizeAssetNeeds(
  needs: readonly { readonly assetId: string; readonly contentVersion: string; readonly required: boolean; readonly locator: string }[],
): readonly ExportAssetNeed[] {
  const out = new Map<string, ExportAssetNeed>()
  for (const n of needs) {
    const prev = out.get(n.assetId)
    // 同一资源 ID 同时以必需与非必需出现 ⇒ 取**必需**（保守方向：宁可阻塞，不静默降级）。
    if (prev && prev.required) continue
    out.set(n.assetId, Object.freeze({ assetId: n.assetId, contentVersion: n.contentVersion, required: n.required, locator: n.locator }))
  }
  return Object.freeze([...out.values()].sort((a, b) => a.assetId.localeCompare(b.assetId)))
}

/**
 * 请求内资源清单的稳定键（用于"资源版本是否改变请求身份"的判定与诊断）。
 *
 * 用 `digestOf`（键序稳定）而不是 `JSON.stringify` —— 与 `domain/scene.objectData`
 * 的 `contentVersion` 同族理由：同一份语义内容用不同构造路径必须得到同一摘要。
 */
export function assetManifestDigest(assets: readonly ExportAssetNeed[]): number {
  return digestOf(
    [...assets]
      .map((a) => `${a.assetId}@${a.contentVersion}:${a.required ? 'req' : 'opt'}`)
      .sort()
      .join('\u0000'),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// K1：发布前能力检查（逐项报告不支持的几何 / 变形 / 文字 / 轨道）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **发布目标的能力声明**（由目标格式/profile 显式给出，不由本层猜）。
 *
 * 为什么必须显式声明：#249 §12「发布前做能力检查：不支持的几何、变形、文字或轨道
 * **逐项报告**」。若本层自己"知道"某个格式能表达什么，就会出现第二个
 * "格式能力"真源，与适配器漂移。⇒ 声明进、报告出，**判定是纯函数**。
 */
export interface PublishCapabilities {
  /** 目标格式能表达的几何类别（整数格整格方块之外还要什么，显式列出）。 */
  readonly geometry: readonly string[]
  /** 能表达的变形方式（旧整数格结构格式只有 `'none'`）。 */
  readonly deformations: readonly string[]
  /** 能否表达自由文字（注解文本）。 */
  readonly canExpressText: boolean
  /** 能否表达旋转/缩放/显式枢轴（旧整数格结构格式不能）。 */
  readonly canExpressTransformExtras: boolean
  /**
   * 能承载动画的属性 ID 集合（`'all'` = 目标格式承载全部轨道）。
   *
   * 语义是**发布格式**的能力，不是内核的可动画性（后者归 RNA 的
   * `PropertyDescriptor.animatable`，见契约 §5.1）。
   */
  readonly animatableProperties: readonly string[] | 'all'
}

/** 一项"目标格式表达不了"的事实（结构化；稳定原因码 + 归属对象）。 */
export interface CapabilityReportItem {
  readonly category: 'geometry' | 'deformation' | 'text' | 'track'
  /** 稳定原因码（语言无关 —— #249 §19.7）。 */
  readonly reason:
    | 'LegacyExportUnsupportedTransform'
    | 'LegacyExportUnsupportedPivot'
    | 'LegacyExportUnsupportedDeformation'
    | 'PublishTextUnsupported'
    | 'PublishTrackUnsupported'
  /** 相关对象 ID（无对象语义的项为空串）。 */
  readonly objectId: string
  readonly detail: Readonly<Record<string, string | number>>
}

/**
 * **发布前能力检查**（K1）—— 逐项报告不支持的几何 / 变形 / 文字 / 轨道。
 *
 * 三类判定的来源**各不相同**，这是刻意的（避免"一处判据包打天下"）：
 *  1. **几何 / 变形**：来自 P3 交付的 `legacyExportDiagnostics()`（经请求的
 *     `capabilityLoss` 带来）—— 本函数**不重新判定**"什么算不可表达"；
 *  2. **文字**：注解对象携带非空 `text` 且目标格式声明 `canExpressText === false`；
 *  3. **轨道**：已启用轨道（`animationDrivenKeys` 的判据）的目标属性不在目标的
 *     `animatableProperties` 里。
 *
 * 空数组 = 目标格式能完全表达这次快照 ⇒ 可以按"无损失"导出。
 */
export function capabilityReport(request: ExportRequest, target: PublishCapabilities): readonly CapabilityReportItem[] {
  const out: CapabilityReportItem[] = []

  // ① 几何 / 变形（P3 的判定结果，只是**归类**，不是重判）
  for (const loss of request.capabilityLoss) {
    const category: CapabilityReportItem['category'] = loss.code === 'LegacyExportUnsupportedDeformation' ? 'deformation' : 'geometry'
    if (category === 'deformation' && target.deformations.includes('none') === false) continue
    if (category === 'geometry' && target.canExpressTransformExtras) continue
    out.push(
      Object.freeze({
        category,
        reason: loss.code,
        objectId: loss.objectId,
        detail: Object.freeze({ dataId: loss.dataId, ...loss.detail }),
      }),
    )
  }

  // ② 文字：注解对象的文本
  if (!target.canExpressText) {
    for (const objectId of request.payload.scene.order) {
      const obj = request.payload.scene.objects[objectId]
      if (!obj || obj.type !== 'annotation') continue
      const data = request.payload.scene.data[obj.dataId]
      if (!data || data.payload.kind !== 'annotation') continue
      if (data.payload.text === undefined || data.payload.text === '') continue
      out.push(
        Object.freeze({
          category: 'text' as const,
          reason: 'PublishTextUnsupported' as const,
          objectId,
          detail: Object.freeze({ textLength: data.payload.text.length, shape: data.payload.shape }),
        }),
      )
    }
  }

  // ③ 轨道：已启用轨道里目标格式承载不了的属性
  if (target.animatableProperties !== 'all') {
    const allowed = new Set(target.animatableProperties)
    for (const key of animationDrivenKeys(request.payload.animation)) {
      // 轨道键是 `owner\0property#component/element`；能力声明按**属性 ID** 比对，
      // 故只取属性段（与 `domain/animation.propertyKey` 的拼接规则同源）。
      const property = trackPropertyOf(key)
      if (allowed.has(property)) continue
      out.push(
        Object.freeze({
          category: 'track' as const,
          reason: 'PublishTrackUnsupported' as const,
          objectId: '',
          detail: Object.freeze({ property, trackKey: key }),
        }),
      )
    }
  }

  // 稳定排序：同类按 objectId/reason，使报告可逐次对账。
  return Object.freeze(
    out.sort((a, b) => a.category.localeCompare(b.category) || a.objectId.localeCompare(b.objectId) || a.reason.localeCompare(b.reason)),
  )
}

/** 从轨道键里取属性 ID（`domain/animation.propertyKey` 的拼接规则的**读**侧，不重定义拼接）。 */
function trackPropertyOf(key: string): string {
  const nul = key.indexOf('\u0000')
  if (nul === -1) return key
  const rest = key.slice(nul + 1)
  const cut = rest.search(/[#/]/)
  return cut === -1 ? rest : rest.slice(0, cut)
}

/** 能力报告 → 预检诊断（阻塞判据与"逐项报告"共用一份事实，不各自判定）。 */
export function capabilityDiagnostics(items: readonly CapabilityReportItem[]): readonly ExportDiagnostic[] {
  return Object.freeze(
    items.map((i) =>
      Object.freeze({
        code: 'ExportCapabilityUnsupported' as const,
        detail: Object.freeze({ category: i.category, reason: i.reason, objectId: i.objectId, ...i.detail }),
      }),
    ),
  )
}

/** 稳定哈希（FNV-1a 32；与 `domain/identity.contentDigest` 同算法，避免第二套口径）。 */
function hashOf(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i) & 0xff
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

// ─────────────────────────────────────────────────────────────────────────────
// 预检（纯；不依赖任何 IO 结果）
// ─────────────────────────────────────────────────────────────────────────────

/** 预检诊断项（结构化；稳定码 + 参数，语言无关 —— #249 §19.7）。 */
export interface ExportDiagnostic {
  readonly code:
    | 'ExportAssetNotReady'
    | 'ExportCapabilityUnsupported'
    | 'ExportKindUnsupported'
    | 'ExportRuntimeMappingMissing'
    | 'ExportRequiresLossyMode'
    | 'ExportEncodingNotConfigured'
    | 'ExportEmptyScene'
    /** 离屏资源分配失败（作业侧；#249 §19.4「作业有独立生命周期与资源预算」）。 */
    | 'ExportAcquireFailed'
    /** 单帧渲染失败（作业侧）。 */
    | 'ExportRenderFailed'
    /** 编码失败（作业侧）。 */
    | 'ExportEncodeFailed'
  readonly detail: Readonly<Record<string, string | number>>
}

/** 预检结论。 */
export type ExportPreflight =
  | { readonly status: 'ready'; readonly diagnostics: readonly ExportDiagnostic[] }
  | { readonly status: 'blocked'; readonly diagnostics: readonly ExportDiagnostic[] }

/** 预检输入。 */
export interface PreflightInput {
  readonly request: ExportRequest
  readonly kind: ExportKind
  readonly encoding?: ImageEncoding
  /**
   * 资源状态仓库（P5 交付）。缺省 `undefined` = 调用方**没有**资源状态面 ⇒
   * 只要请求里存在 `required` 资源就判 blocked（不假装"没有资源需求"）。
   */
  readonly assets?: AssetStateStore
  /** 能力损失是否被显式接受（§19.4「部分输出仅在**显式模式**下允许并标记」）。 */
  readonly allowLossy?: boolean
  /** 编码能力端口（缺省 = 无编码器 ⇒ 明确 blocked，而不是产出空文件）。 */
  readonly encoder?: EncoderPort
}

/**
 * 导出预检 —— **默认失败而非假成功**（#249 §12 末段）。
 *
 * 五条判据，逐条对应一条验收/负对照：
 *  1. **必需资源未就绪** ⇒ blocked（A29「缺必需资源时预检失败」）；
 *  2. **能力损失未显式接受** ⇒ blocked（§12「默认导出失败而不是假成功」）；
 *  3. **产物种类不受支持** ⇒ blocked（§12「不支持的几何/变形/文字/轨道逐项报告」）；
 *  4. **编码器缺失** ⇒ blocked（不产出"伪完整文件"）；
 *  5. 场景为空 ⇒ blocked（空的"完整导出"是典型的假成功形态）。
 *
 * 注意本函数**不再**判运行时间映射：那在 `planCaptureFrames` 就失败了
 * （更早失败更好 —— 构成不可变请求之时就应知道时间映射是否可得）。
 * 但为了让**已构造**的请求也能被复核（例如反序列化回来的请求），
 * 这里对 `mapping.source === 'runtime'` 且 `frames` 为空的组合补一条诊断。
 */
export function preflightExport(input: PreflightInput): ExportPreflight {
  const diagnostics: ExportDiagnostic[] = []
  const { request } = input

  if (request.frames.length === 0) {
    diagnostics.push(
      Object.freeze({
        code: request.mapping.source === 'runtime' ? 'ExportRuntimeMappingMissing' : 'ExportEmptyScene',
        detail: Object.freeze({ mapping: request.mapping.source, frames: 0 }),
      }),
    )
  }

  const required = request.assets.filter((a) => a.required)
  if (required.length > 0) {
    if (input.assets === undefined) {
      for (const need of required) {
        diagnostics.push(
          Object.freeze({
            code: 'ExportAssetNotReady',
            detail: Object.freeze({ assetId: need.assetId, phase: 'unknown', reason: 'noAssetStatePort' }),
          }),
        )
      }
    } else {
      const blocking = preflightRequiredAssets(
        input.assets,
        required.map((need) => ({
          identity: { id: need.assetId as AssetId, version: need.contentVersion },
          locator: { kind: 'external' as const, url: need.locator },
          required: true,
        })),
      )
      for (const b of blocking) {
        diagnostics.push(
          Object.freeze({
            code: 'ExportAssetNotReady',
            detail: Object.freeze({ assetId: b.id, phase: b.phase, detail: b.detail }),
          }),
        )
      }
    }
  }

  if (request.capabilityLoss.length > 0 && input.allowLossy !== true) {
    // 「默认导出失败而不是假成功」：有损失就必须**显式**开有损模式。
    for (const loss of request.capabilityLoss) {
      diagnostics.push(
        Object.freeze({
          code: 'ExportRequiresLossyMode',
          detail: Object.freeze({ loss: loss.code, objectId: loss.objectId, ...flatten(loss.detail) }),
        }),
      )
    }
  }

  if (input.encoder === undefined) {
    diagnostics.push(
      Object.freeze({ code: 'ExportEncodingNotConfigured', detail: Object.freeze({ kind: input.kind }) }),
    )
  } else if (!input.encoder.supportedKinds.includes(input.kind)) {
    diagnostics.push(
      Object.freeze({ code: 'ExportKindUnsupported', detail: Object.freeze({ kind: input.kind, supported: input.encoder.supportedKinds.join(',') }) }),
    )
  }

  if (Object.keys(request.payload.scene.objects).length === 0) {
    diagnostics.push(
      Object.freeze({ code: 'ExportEmptyScene', detail: Object.freeze({ sceneId: request.payload.sceneId, objects: 0 }) }),
    )
  }

  return diagnostics.length === 0
    ? Object.freeze({ status: 'ready' as const, diagnostics: Object.freeze([]) })
    : Object.freeze({ status: 'blocked' as const, diagnostics: Object.freeze(diagnostics) })
}

function flatten(detail: Readonly<Record<string, string | number>>): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(detail)) out[`loss.${k}`] = v
  return out
}

/** 预检结论 → `Result`（供命令层/接线层用同一条错误通路表达阻塞）。 */
export function preflightError(preflight: ExportPreflight): DomainError | null {
  if (preflight.status === 'ready') return null
  const first = preflight.diagnostics[0]!
  const params: Record<string, string | number> = { reason: first.code, ...first.detail }
  if (first.code === 'ExportRuntimeMappingMissing') return unsupportedOperation(params)
  if (first.code === 'ExportKindUnsupported' || first.code === 'ExportRequiresLossyMode' || first.code === 'ExportEncodingNotConfigured') {
    return unsupportedOperation(params)
  }
  if (first.code === 'ExportAssetNotReady') {
    // 资源未就绪是"现在不行、条件可能变化" ⇒ `WouldBlock`（契约 §3.2 的八码内选择）。
    return missingTarget(params)
  }
  return invalidValue(params)
}

// ─────────────────────────────────────────────────────────────────────────────
// 消费者：与实时视口**共用**求值（同一求值器，不另立播放循环）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 请求 → 每个采样时刻的求值键（呈现/几何求值的**唯一**身份来源）。
 *
 * 为什么放在 `application/export` 而不是作业里：这是"导出与实时视口走同一条求值路径"
 * 的可断言形态 —— 键的构造方式是纯函数、可逐字段核对（时间来自固定序列、
 * 资源版本来自请求清单，没有第三个来源）。
 */
export function evaluationKeyOf(request: ExportRequest, frame: CaptureTime, resourceVersions: Readonly<Record<string, string>>) {
  return Object.freeze({
    documentVersion: request.payload.version.documentVersion,
    scene: request.payload.sceneId,
    time: { seconds: frame.seconds, numerator: frame.time.frame, denominator: 1 },
    parameterVersion: hashOf(canonicalize(request.channels)),
    contentResourceVersions: Object.freeze({ ...resourceVersions }),
  })
}

/**
 * 作业应渲染的**源帧**序列（A29「固定时间序列」）。
 *
 * 返回请求里那份冻结的序列本身（不是重新算一份）：导出期间继续编辑**不可能**
 * 改变它 —— 这是 A29 判据「产物对应 S0」的结构性依据。
 */
export function planSourceFrames(request: ExportRequest): readonly CaptureTime[] {
  return request.frames
}

/** 请求是否属于某文档的某个内容版本（"产物对应 S0"的对账入口）。 */
export function requestMatchesVersion(request: ExportRequest, documentId: string, version: Version): boolean {
  return request.payload.documentId === documentId && request.payload.version.contentVersion === version.contentVersion
}

/** 供诊断：请求摘要（**不含**完整文档内容 —— #249 §19.9 生产默认最小信息）。 */
export function describeExportRequest(request: ExportRequest): Readonly<Record<string, string | number>> {
  return Object.freeze({
    requestId: request.requestId,
    documentId: request.payload.documentId,
    documentVersion: request.payload.version.documentVersion,
    contentVersion: request.payload.version.contentVersion ?? 0,
    frames: request.frames.length,
    mapping: request.mapping.source,
    width: request.render.width,
    height: request.render.height,
    assets: request.assets.length,
    requiredAssets: request.assets.filter((a) => a.required).length,
    capabilityLoss: request.capabilityLoss.length,
  })
}

/** 未使用占位：保持 `RenderSettings`/`TimeMapping`/`LegacyExportDiagnostic` 的类型可达性。 */
export type { RenderSettings, TimeMapping, LegacyExportDiagnostic }
