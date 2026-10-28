/**
 * `application/export` —— **固定快照导出的纯政策层**。
 *
 * ## 本层与 `runtime/exportJob` 的分工
 *
 * 导出分为两半，本文件是前一半：
 *
 * | 半边 | 谁做 | 内容 |
 * |---|---|---|
 * | **纯函数确定采样时间/取景/资源需求** | 本文件 | `planExportRequest` / `preflightExport` / `planSourceFrames` / `mediaTypeOf` |
 * | **作业接线**（解析资源、调用同一求值器、分配离屏资源、编码、报告进度） | `runtime/exportJob` | 发起/进度/取消/释放 |
 *
 * 这个切分的判据不是"好看"，而是三条负对照各自需要一边：
 *  - 「隐式读取最新文档」只能在**组装请求**处被排除（请求一旦冻结，作业读不到编辑器）；
 *  - 「借用并旋转实时相机」只能在**取景**处被排除（`CameraSpec` 是值）；
 *  - 「缺必需资源时预检失败」只能在**纯预检**处被判定（不依赖任何 IO 结果）。
 *
 * ## 编码器的**不可能实现**必须显式
 *
 * 发布契约要求「资源未齐、不支持特性或编码失败给出**结构化诊断**，**不输出伪完整文件**；
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
import { delayCsOf } from '@/domain/materials'
// ── 呈现侧的**已交付契约**（本层只消费，不重定义）──
import type { AssetId } from '@/presentation/assetIdentity'
import { preflightRequiredAssets, type AssetStateStore } from '@/presentation/assetState'
import { compileScene } from '@/presentation/compileScene'
import type { PresentationInputs } from '@/presentation/evaluationKey'
import type { TextureBinding, TextureSampling } from '@/presentation/textureBinding'

// ─────────────────────────────────────────────────────────────────────────────
// 输出形态与编码端口
// ─────────────────────────────────────────────────────────────────────────────

/** 导出产物种类（三类消费者：图片、GIF/动画、几何发布）。 */
export type ExportKind = 'image' | 'animation' | 'geometry' | 'project'

/**
 * **产物编码格式**（从"图片格式"扩成"产物格式"）。
 *
 * `gif` 只对 `animation` 合法、`png/jpeg` 只对 `image` 合法 —— 这条约束
 * 由 {@link encodingAllowedFor} **一处**声明，预检与编码端口都读它（不各写一份 switch）。
 */
export type ArtifactEncoding = 'png' | 'jpeg' | 'gif'

/** 兼容别名（既有调用点不动）：图片可用的两种编码。 */
export type ImageEncoding = 'png' | 'jpeg'

/**
 * **kind × encoding 兼容表**（全树唯一一份）。
 *
 * 为什么必须有它：`mediaTypeOf('animation')` 恒为 `image/gif`，于是"格式与种类"
 * 在类型上互相独立；没有这张表的话 `kind:'image'` + `encoding:'gif'` 会被
 * 预检放行、再由某个端口按 PNG 编出来却声明 `image/gif` —— 声明与字节不符。
 */
export function supportedEncodingsFor(kind: ExportKind): readonly ArtifactEncoding[] {
  switch (kind) {
    case 'image':
      return Object.freeze(['png', 'jpeg'] as const)
    case 'animation':
      return Object.freeze(['gif'] as const)
    case 'geometry':
    case 'project':
      return Object.freeze([] as const)
  }
}

/** 该 `kind` 是否允许该 `encoding`（预检与端口共用，不各写一份）。 */
export function encodingAllowedFor(kind: ExportKind, encoding: ArtifactEncoding): boolean {
  return supportedEncodingsFor(kind).includes(encoding)
}

/** 媒体类型（产物字节的**声明**，不是产物本身；不合法组合有 EncodingNotConfigured 挡在前面）。 */
export function mediaTypeOf(kind: ExportKind, encoding: ArtifactEncoding = 'png'): string {
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
export function fileExtensionOf(kind: ExportKind, encoding: ArtifactEncoding = 'png'): string {
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
 * 「不支持的导出**明确报告**，不假成功」。一个 `try { encode() } catch { }`
 * 会把"这个 profile 没有编码器"与"编码器崩了"压成同一个结果，调用方无从区分
 * 该报缺能力还是该重试。
 */
export interface EncoderPort {
  /** 本端口支持哪些产物种类。 */
  readonly supportedKinds: readonly ExportKind[]
  /**
   * 本端口支持哪些编码格式（**可选**）。
   *
   * 缺失 = 端口没有细到 encoding 维度（既有测试替身）；给定时预检会据它判
   * `ExportEncodingNotConfigured`。组合端口（`createEncoderPort`）取各 part 的并集。
   */
  readonly supportedEncodings?: readonly ArtifactEncoding[]
  /** 端口名（诊断用；组合端口在失败侧带它，使"GIF 编不出来"与"PNG 编不出来"可区分）。 */
  readonly name?: string
  /**
   * 执行编码。成功返回字节；失败返回**结构化**原因（不是抛异常）。
   *
   * `signal` 只用于"尽快停下"，**不**用超时冒充取消。
   */
  encode(input: EncoderInput): Promise<Result<Uint8Array>>
}

export interface EncoderInput {
  readonly request: ExportRequest
  readonly kind: ExportKind
  readonly encoding: ArtifactEncoding
  /** 逐帧渲染结果（由作业按采样序列产出；纯数据）。 */
  readonly rendered: readonly RenderedFrame[]
  readonly signal: { readonly cancelled: boolean }
  /**
   * 仅 `kind === 'animation'`：GIF 循环次数（`0` = 无限；缺省 `0`）。
   * 必须是整数 `>= 0`（非法值由 GIF 端口判 `encoderLoopCountInvalid`）。
   */
  readonly loopCount?: number
}

/** 一帧的渲染结果，**纯数据**（不含 GPU 句柄；纯数据投影与 GPU 上传分开）。 */
export interface RenderedFrame {
  readonly index: number
  readonly time: CaptureTime
  /** 离屏渲染目标的像素数据（RGBA，行主序）。 */
  readonly pixels: Uint8Array
  readonly width: number
  readonly height: number
  /**
   * 本帧驻留（毫秒整数、`>= 1`）。**与 `CaptureTime.holdMs` 同一值**（作业搬运，不重算）。
   *
   * 为什么挂在帧上而不是 `EncoderInput.holdsMs` 平行数组：平行数组允许长度不一致
   * （需要一条运行时校验），且会诱使第二个来源（编码器自己按帧率再算一遍 = 第二套时间权威）。
   */
  readonly holdMs?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// 组装请求（捕获，而非借用）
// ─────────────────────────────────────────────────────────────────────────────

/** 捕获输入：调用方（接线层）在**发起导出前**把值交进来，之后不再参与。 */
export interface CaptureInput {
  readonly requestId: string
  /** 注入时钟（纯层不读 `Date.now()`）。 */
  readonly now: number
  readonly documentId: string
  readonly version: Version
  readonly scene: Scene
  readonly animation: AnimationState
  readonly camera: CameraSource
  readonly spec: CaptureSpec
  /** 资源需求（可选：缺省时由 `deriveAssetNeeds` 从呈现编译反推）。 */
  readonly assets?: readonly ExportAssetNeed[]
  /**
   * **已装配**的图元清单（生产装配的产出）。给定时 `assets` 缺省即由它反推，
   * 且**推不出就是请求不可构造**（`err`）—— 不允许落成"清单为空"的请求。
   */
  readonly presentation?: PresentationInputs
  /** 已安装的时间源（缺省仅场景时间）。 */
  readonly timeSources?: CaptureTimeSources
}

/**
 * 组装**不可变**导出请求。
 *
 * 关键点（每条对应一条负对照）：
 *  1. 取景经 `resolveCameraSpec` **解析成值**（文档相机或明确复制的视角）；
 *  2. 采样序列经 `planCaptureFrames` 一次算出并冻结（之后不再问时间）；
 *  3. 内容以 `version` 记录 —— 请求里没有"去文档取最新"的入口；
 *  4. 能力损失在**捕获时**判定（「必要时导出烘焙结果，并记录能力损失」）。
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

  let assets: readonly ExportAssetNeed[]
  if (input.assets !== undefined) {
    assets = input.assets
  } else if (input.presentation !== undefined) {
    // ① 已装配 ⇒ 反推真实需求。**推不出不等于"无需资源"** ⇒ 请求不可构造。
    const derived = deriveAssetNeeds({
      scene: input.scene,
      animation: input.animation,
      frames: frames.value,
      spec: input.spec,
      presentation: input.presentation,
    })
    if (derived.status !== 'derived') {
      return err(unsupportedOperation({ reason: derived.reason, derivation: derived.status }))
    }
    assets = derived.assets
  } else {
    assets = Object.freeze([])
  }

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
 * 资源需求的**推导结论**（①：不得用空清单冒充"无需资源"）。
 *
 * 为什么是判别式联合而不是"返回一个数组"：空数组有两个**语义完全不同**的来源 ——
 * 「装配过、真的不需要资源」与「根本没装配」。用数组表达时两者不可区分，于是
 * `preflightRequiredAssets()` 在第二种情况下按定义没有可阻塞项 ⇒
 * 「缺必需资源时预检失败」永远不触发（假绿，见 `composition/seams.ts` 的
 * `export-asset-manifest-unwired` 登记）。
 * ⇒ 非 `derived` 分支**必带** `reason` 且 `assets` 恒为空，消费方无路可走地
 * 必须显式处理"没有清单"这件事。
 */
export type AssetNeedDerivation =
  | {
      readonly status: 'derived'
      readonly assembled: true
      readonly reason: null
      readonly assets: readonly ExportAssetNeed[]
    }
  | {
      readonly status: 'not-assembled'
      readonly assembled: false
      readonly reason: string
      readonly assets: readonly []
    }
  | {
      readonly status: 'compile-failed'
      readonly assembled: true
      readonly reason: string
      readonly assets: readonly []
    }

/** 未装配时的原因码（消费方据此报告"为什么没有清单"）。 */
export const ASSET_NEEDS_NOT_ASSEMBLED = 'presentation-not-assembled'

/** `deriveAssetNeeds` 的输入（请求组装的同源值 + 可选的已装配图元清单）。 */
export interface DeriveAssetNeedsInput {
  readonly scene: Scene
  readonly animation: AnimationState
  readonly frames: readonly CaptureTime[]
  readonly spec: CaptureSpec
  /**
   * **已装配**的图元清单（生产装配产出，如 `composition/kernelPresentationInputs`）。
   * 缺省 ⇒ 本函数**不伪造**图元，返回 `not-assembled` 并带上原因。
   */
  readonly presentation?: PresentationInputs
}

/**
 * 从**求值/呈现编译**反推资源需求（资源清单的产出方式）。
 *
 * 为什么必须反推而不是"让调用方列一份"：负对照包含「缺必需资源时预检失败」，
 * 而"哪些资源是必需的"只有在场景被编译过之后才是一个**可计算**的事实。
 * 调用方手列的清单会与真实需求漂移，于是预检通过而渲染缺资源。
 *
 * 本函数消费呈现侧已交付的 `compileScene`（同一求值器的呈现半边），
 * 它**不**重新解析旧文件（「不能绕道重新解析旧文件来获得另一份几何语义」）。
 */
export function deriveAssetNeeds(input: DeriveAssetNeedsInput): AssetNeedDerivation {
  const { presentation } = input
  // `scene`/`animation`/`frames`/`spec` 是请求组装的**同源**输入，但本函数**不**从它们
  // 推导资源：「不得绕道重新解析旧文件来获得另一份几何语义」。显式 `void`
  // 表明"刻意未用"，而不是漏用。
  void input.scene
  void input.animation
  void input.frames
  void input.spec

  if (presentation === undefined) {
    // ① 未装配 ⇒ **保持空 + 显式报告未装配**（绝不冒充"无需资源"）。
    return Object.freeze({
      status: 'not-assembled' as const,
      assembled: false as const,
      reason: ASSET_NEEDS_NOT_ASSEMBLED,
      assets: Object.freeze([]) as readonly [],
    })
  }

  const compiled = compileScene(presentation)
  if (!compiled.ok) {
    return Object.freeze({
      status: 'compile-failed' as const,
      assembled: true as const,
      reason: `compile-failed:${compiled.error.code}`,
      assets: Object.freeze([]) as readonly [],
    })
  }

  const needs: { readonly assetId: string; readonly contentVersion: string; readonly required: boolean; readonly locator: string }[] = []
  for (const payload of compiled.value.payloads) {
    // 批次材料的身份就是它所依赖资源的身份（`MaterialDescriptor.id` 的文档口径：
    // 「材质身份（内容身份；纹理替换后身份变）」）。装配层没有解析获取位置 ⇒ `locator`
    // 留空（**不伪造 URL**；`locator` 按契约不参与身份判定）。
    needs.push({
      assetId: payload.material.id,
      contentVersion: payload.material.version,
      required: true,
      locator: '',
    })
  }

  if (needs.length === 0) {
    // 编译通过但**零批次** ⇒ 场景内没有可绘制内容。这**不是**"无需资源"，故走
    // `compile-failed` 分支并带原因，消费方不可能把它读成"清单为空所以不需要资源"。
    return Object.freeze({
      status: 'compile-failed' as const,
      assembled: true as const,
      reason: 'compiled-no-payloads',
      assets: Object.freeze([]) as readonly [],
    })
  }

  return Object.freeze({
    status: 'derived' as const,
    assembled: true as const,
    reason: null,
    assets: normalizeAssetNeeds(needs),
  })
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

/** 清单规范串的每一行（`assetId@contentVersion:req|opt`），**已排序**。 */
export function assetManifestLines(assets: readonly ExportAssetNeed[]): readonly string[] {
  return Object.freeze(
    assets.map((a) => `${a.assetId}@${a.contentVersion}:${a.required ? 'req' : 'opt'}`).sort(),
  )
}

/** 清单规范串（①③ 的机械对账口径：排序行以 `\n` 连接，**不含**任何序号）。 */
export function assetManifestCanonicalText(assets: readonly ExportAssetNeed[]): string {
  return assetManifestLines(assets).join('\n')
}

/** 清单格式版本（随产物同行的载体里写死，使消费方能机械识别）。 */
export const EXPORT_ASSET_MANIFEST_VERSION = 'export-asset-manifest/1'

/**
 * **导出资源清单**（②：随产物同行的实体）。
 *
 * 三件事一体，缺一不可：
 *  1. `entries` —— 请求里那份**冻结**的清单本身（不是再算一份）；
 *  2. `digest` / `canonical` —— 机械对账口径（等于 `assetManifestDigest(entries)`）；
 *  3. `assembled` / `reason` —— 该清单是**装配反推**得来的，还是"根本没有清单"。
 *     未装配时 `reason` 非空 ⇒ 消费方不可能把空清单读成"无需资源"。
 */
export interface ExportAssetManifest {
  readonly manifestVersion: typeof EXPORT_ASSET_MANIFEST_VERSION
  readonly assembled: boolean
  readonly reason: string | null
  readonly digest: number
  readonly canonical: string
  readonly entries: readonly ExportAssetNeed[]
}

/**
 * 组一份清单。
 *
 * `derivation` 缺省 = 消费方**没有**装配来源（例如清单位于请求里但推导记录未随行）
 * ⇒ 如实标 `assembled: false` + `reason: 'asset-needs-derivation-absent'`，
 * 而不是看"清单空不空"来猜（那正是本条接缝的假绿形态）。
 */
export function exportAssetManifest(
  assets: readonly ExportAssetNeed[],
  derivation?: AssetNeedDerivation,
): ExportAssetManifest {
  const assembled = derivation === undefined ? false : derivation.assembled
  const reason =
    derivation === undefined
      ? 'asset-needs-derivation-absent'
      : derivation.status === 'derived'
        ? null
        : derivation.reason
  return Object.freeze({
    manifestVersion: EXPORT_ASSET_MANIFEST_VERSION,
    assembled,
    reason,
    digest: assetManifestDigest(assets),
    canonical: assetManifestCanonicalText(assets),
    entries: Object.freeze([...assets]),
  })
}

/**
 * **一份纹理资源明细**（资源明细面板的唯一数据源；**不进** digest）。
 *
 * 为什么要与 `ExportAssetNeed` 分开：`assetManifestDigest` 只折叠
 * `assetId@contentVersion:req|opt` 四字段（见 {@link assetManifestDigest}），
 * 把采样参数/序列规格塞进清单会**改变 digest**，等于改掉"字节面不变"的契约。
 * ⇒ 明细走这条**独立只读面**，面板只渲染它，不参与摘要与对账。
 */
export interface ExportCaptureFactTexture {
  /** 材质身份（`material:<下标>` 约定；与清单的 `assetId` 同一来源）。 */
  readonly materialId: string
  readonly materialVersion: string
  /** 纹理内容身份的 id 段（`ContentIdentity#id`）。 */
  readonly textureId: string
  /** 纹理内容身份的版本段（`ContentIdentity#version`）。 */
  readonly textureVersion: string
  /** 采样设置（filter/wrap/flipY/mipmaps/anisotropy）。 */
  readonly sampling: TextureSampling
  /**
   * 纹理序列规格；`null` = 静态贴图（**缺席就是缺席**，不写 0 帧）。
   *
   * `durationsMs` 与声明同源（`TextureSequence#frames[].duration` 的有理秒换算），
   * 不在这里做 GIF 的厘秒量化 —— 那是编码层的诊断（`ExportTimeQuantized`）。
   */
  readonly sequence: { readonly frameCount: number; readonly durationsMs: readonly number[] } | null
}

/** 捕获期的**只读**资源明细（资源明细面板；不参与清单身份）。 */
export interface ExportCaptureFacts {
  readonly textures: readonly ExportCaptureFactTexture[]
}

/** 有理秒 → 毫秒（B 块人读；不退化成"帧数 × 默认帧时长"的自算）。 */
function durationMsOf(d: { readonly num: number; readonly den: number }): number {
  if (!Number.isFinite(d.num) || !Number.isFinite(d.den) || d.den === 0) return 0
  return (d.num * 1000) / d.den
}

/**
 * 纹理绑定 → 资源明细（**唯一**构造点）。
 *
 * 只收 `map` 在场的绑定：无贴图材质不是"缺资源"，把它列成一行空纹理会让
 * 面板读起来像"这里少了一张图"。顺序沿用绑定生产顺序（材质去重后稳定）。
 */
export function captureFactsOfBindings(bindings: readonly TextureBinding[]): ExportCaptureFacts {
  const textures: ExportCaptureFactTexture[] = []
  for (const b of bindings) {
    if (b.map === undefined) continue
    const sequence = b.animation === undefined
      ? null
      : Object.freeze({
          frameCount: b.animation.sequence.frames.length,
          durationsMs: Object.freeze(b.animation.sequence.frames.map((f) => durationMsOf(f.duration))),
        })
    textures.push(
      Object.freeze({
        materialId: b.materialId,
        materialVersion: b.materialVersion,
        textureId: b.map.id,
        textureVersion: b.map.version,
        sampling: b.sampling,
        sequence,
      }),
    )
  }
  return Object.freeze({ textures: Object.freeze(textures) })
}

// ─────────────────────────────────────────────────────────────────────────────
// 发布前能力检查（逐项报告不支持的几何 / 变形 / 文字 / 轨道）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **发布目标的能力声明**（由目标格式/profile 显式给出，不由本层猜）。
 *
 * 为什么必须显式声明：「发布前做能力检查：不支持的几何、变形、文字或轨道
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
   * `PropertyDescriptor.animatable`）。
   */
  readonly animatableProperties: readonly string[] | 'all'
}

/** 一项"目标格式表达不了"的事实（结构化；稳定原因码 + 归属对象）。 */
export interface CapabilityReportItem {
  readonly category: 'geometry' | 'deformation' | 'text' | 'track'
  /** 稳定原因码（语言无关）。 */
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
 * **发布前能力检查** —— 逐项报告不支持的几何 / 变形 / 文字 / 轨道。
 *
 * 三类判定的来源**各不相同**，这是刻意的（避免"一处判据包打天下"）：
 *  1. **几何 / 变形**：来自已交付的 `legacyExportDiagnostics()`（经请求的
 *     `capabilityLoss` 带来）—— 本函数**不重新判定**"什么算不可表达"；
 *  2. **文字**：注解对象携带非空 `text` 且目标格式声明 `canExpressText === false`；
 *  3. **轨道**：已启用轨道（`animationDrivenKeys` 的判据）的目标属性不在目标的
 *     `animatableProperties` 里。
 *
 * 空数组 = 目标格式能完全表达这次快照 ⇒ 可以按"无损失"导出。
 */
export function capabilityReport(request: ExportRequest, target: PublishCapabilities): readonly CapabilityReportItem[] {
  const out: CapabilityReportItem[] = []

  // ① 几何 / 变形（已交付的判定结果，只是**归类**，不是重判）
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

/** 预检诊断项（结构化；稳定码 + 参数，语言无关）。 */
export interface ExportDiagnostic {
  readonly code:
    | 'ExportAssetNotReady'
    | 'ExportCapabilityUnsupported'
    | 'ExportKindUnsupported'
    | 'ExportRuntimeMappingMissing'
    | 'ExportRequiresLossyMode'
    | 'ExportEncodingNotConfigured'
    | 'ExportEmptyScene'
    /**
     * 声明时长与产物时长不一致（**已完成但有偏差**，不阻塞）。
     *
     * 来源：GIF 的时延单位是厘秒（1cs = 10ms），故 `holdMs` 非 10 的整数倍时
     * 产物必然比声明短/长。这是外部格式不可表达 ⇒ 结构化报告，不静默。
     */
    | 'ExportTimeQuantized'
    /** 离屏资源分配失败（作业侧；作业有独立生命周期与资源预算）。 */
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
  readonly encoding?: ArtifactEncoding
  /**
   * 资源状态仓库（呈现侧已交付）。缺省 `undefined` = 调用方**没有**资源状态面 ⇒
   * 只要请求里存在 `required` 资源就判 blocked（不假装"没有资源需求"）。
   */
  readonly assets?: AssetStateStore
  /** 能力损失是否被显式接受（「部分输出仅在**显式模式**下允许并标记」）。 */
  readonly allowLossy?: boolean
  /** 编码能力端口（缺省 = 无编码器 ⇒ 明确 blocked，而不是产出空文件）。 */
  readonly encoder?: EncoderPort
}

/**
 * **声明时长 vs 编码时长**的量化诊断（null = 无偏差或无从判定）。
 *
 * 只在 `animation` + `gif` 且每帧都声明了 `holdMs` 时可判定：GIF 的时延单位是
 * 厘秒，故产物时长 = `Σ delayCs × 10`，与声明时长 `Σ holdMs` 可能不同。**不阻塞**：
 * 50ms/100ms 这类合法声明本来就落在整数厘秒上；非整数倍（如 45ms）只是不可完全表达。
 */
export function timeQuantizationOf(
  request: ExportRequest,
  kind: ExportKind,
  encoding: ArtifactEncoding,
): ExportDiagnostic | null {
  if (kind !== 'animation' || encoding !== 'gif') return null
  const holds: number[] = []
  for (const f of request.frames) {
    if (f.holdMs === undefined) return null // 端口会判 `encoderHoldMissing`，这里不猜
    holds.push(f.holdMs)
  }
  if (holds.length === 0) return null
  const delays = delayCsOf(holds)
  if (!delays.ok) return null // 由端口/预检判红，不在这里伪造读数
  const declaredMs = holds.reduce((a, b) => a + b, 0)
  const encodedMs = delays.value.reduce((a, b) => a + b, 0) * 10
  if (declaredMs === encodedMs) return null
  return Object.freeze({
    code: 'ExportTimeQuantized' as const,
    detail: Object.freeze({
      declaredMs,
      encodedMs,
      roundUnit: 'cs',
      frames: holds.length,
      deltaMs: encodedMs - declaredMs,
    }),
  })
}

/**
 * 导出预检 —— **默认失败而非假成功**。
 *
 * 五条判据，逐条对应一条验收/负对照：
 *  1. **必需资源未就绪** ⇒ blocked（负对照：缺必需资源时预检失败）；
 *  2. **能力损失未显式接受** ⇒ blocked（「默认导出失败而不是假成功」）；
 *  3. **产物种类不受支持** ⇒ blocked（「不支持的几何/变形/文字/轨道逐项报告」）；
 *  4. **编码器缺失** ⇒ blocked（不产出"伪完整文件"）；
 *  5. 场景为空 ⇒ blocked（空的"完整导出"是典型的假成功形态）。
 *
 * 注意本函数**不再**判运行时间映射：那在 `planCaptureFrames` 就失败了
 * （更早失败更好 —— 构成不可变请求之时就应知道时间映射是否可得）。
 * 但为了让**已构造**的请求也能被复核（例如反序列化回来的请求），
 * 这里对 `mapping.source === 'runtime'` 且 `frames` 为空的组合补一条诊断。
 */
export function preflightExport(input: PreflightInput): ExportPreflight {
  /** 阻塞项（决定 `blocked`）。 */
  const diagnostics: ExportDiagnostic[] = []
  /** 非阻塞项（"已完成但有偏差"）：状态仍可为 `ready`，但必须随结局报出。 */
  const notes: ExportDiagnostic[] = []
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

  // **kind × encoding 兼容表**。今天没有任何判据打到 `encoding` 维度 ——
  // 于是 `image+gif` 会被放行、再由"按 PNG 编却声明 image/gif"的路径产出伪产物。
  if (input.encoding !== undefined) {
    if (!encodingAllowedFor(input.kind, input.encoding)) {
      diagnostics.push(
        Object.freeze({
          code: 'ExportKindUnsupported',
          detail: Object.freeze({
            kind: input.kind,
            encoding: input.encoding,
            allowed: supportedEncodingsFor(input.kind).join(','),
            reason: 'encodingNotAllowedForKind',
          }),
        }),
      )
    } else if (
      input.encoder !== undefined &&
      input.encoder.supportedEncodings !== undefined &&
      !input.encoder.supportedEncodings.includes(input.encoding)
    ) {
      // 种类对、但端口没有这个编码器（例如 PNG 端口被要求出 gif）⇒ 明确缺能力。
      diagnostics.push(
        Object.freeze({ code: 'ExportEncodingNotConfigured', detail: Object.freeze({ kind: input.kind, encoding: input.encoding }) }),
      )
    } else {
      const quantized = timeQuantizationOf(request, input.kind, input.encoding)
      if (quantized !== null) notes.push(quantized)
    }
  }

  if (Object.keys(request.payload.scene.objects).length === 0) {
    diagnostics.push(
      Object.freeze({ code: 'ExportEmptyScene', detail: Object.freeze({ sceneId: request.payload.sceneId, objects: 0 }) }),
    )
  }

  return diagnostics.length === 0
    ? Object.freeze({ status: 'ready' as const, diagnostics: Object.freeze([...notes]) })
    : Object.freeze({ status: 'blocked' as const, diagnostics: Object.freeze([...diagnostics, ...notes]) })
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
    // 资源未就绪是"现在不行、条件可能变化" ⇒ `WouldBlock`（内核契约 §4.2 的八码内选择）。
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
 * 作业应渲染的**源帧**序列（负对照：固定时间序列）。
 *
 * 返回请求里那份冻结的序列本身（不是重新算一份）：导出期间继续编辑**不可能**
 * 改变它 —— 这是判据「产物对应捕获快照」的结构性依据。
 */
export function planSourceFrames(request: ExportRequest): readonly CaptureTime[] {
  return request.frames
}

/** 请求是否属于某文档的某个内容版本（"产物对应捕获快照"的对账入口）。 */
export function requestMatchesVersion(request: ExportRequest, documentId: string, version: Version): boolean {
  return request.payload.documentId === documentId && request.payload.version.contentVersion === version.contentVersion
}

/** 供诊断：请求摘要（**不含**完整文档内容 —— 生产默认最小信息）。 */
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
