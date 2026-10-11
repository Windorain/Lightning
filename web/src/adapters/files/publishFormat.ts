/**
 * `adapters/files/publishFormat` —— **发布格式**：查看所需内容 / 默认参数 / 需播放轨道，
 * 必要时烘焙并**记录能力损失**（#249 §12 第 2 段；#260 交付范围第 4 项；A20 判据 3+4）。
 *
 * ## 本模块替代的旧机制
 *
 * 旧导出器把"发布"与"保存"混在一条路径上：`operators/builtin/exportOperators.ts` 的
 * `OPERATOR_EXPORT_ENVELOPE` / `OPERATOR_SAVE_FILE` 是**同一个文档**的两种序列化，
 * 没有任何"查看者需要什么 vs 编辑者需要什么"的区分。后果是 #249 §12 末段点名的两件事：
 *
 * > 「发布前做能力检查：不支持的几何、变形、文字或轨道**逐项报告**。
 * > **可选有损输出必须是显式模式**；**默认导出失败而不是假成功**。」
 *
 * 旧实现下，不可表达的变换会被**静默降采样**（对象落在非整数格 ⇒ 渲染时舍入到格，
 * 用户拿到一份"看起来完整"的产物）。A20 的负对照 b 正是这条：
 * 「形变被静默降采样（带 `deformation` 的对象在旧格式发布时未产生
 * `LegacyExportUnsupportedDeformation` 诊断 ⇒ 判红）」。
 *
 * ## 与 `application/exportPlan` 的分工（**不重复实现**）
 *
 * P9 的另一半（本批父执行者交付）已经有 `preflightExport`，它判五件事：
 * 必需资源未就绪、能力损失未显式接受、产物种类不受支持、编码器缺失、场景为空
 * （`application/exportPlan.ts:328-418`）。本模块**不**重写那五条。
 *
 * 本模块负责**发布格式特有的三件事**，它们是 `preflightExport` 判不了的：
 *
 * | 面 | 为什么 `preflightExport` 判不了 |
 * |---|---|
 * | **查看所需内容**（`#249` §12："发布格式包含**查看所需内容**"） | 那是"发布格式的哪部分进了产物"的**集合**问题，不是单次导出的预检 |
 * | **需播放的轨道**（`playback:{loop:false,defaultFrameIndex:0}`） | 它默认**不播放**（B-23），"需播放的轨道"必须被**显式列出**，而不是被顺手启用 |
 * | **能力损失记录随产物落盘** | `captureSpec` 把损失放进请求（内存），发布格式要求它**进产物**（可被下游读到） |
 *
 * ## B-23：`playback` 原样保留，**不得顺手启用播放**
 *
 * 依据 `docs/contracts/format-scene-file.md:103-111`：
 *
 * > - `loop` **硬编码 `false`**：这是既定事实（#96 §6.1 明写「不作为本期缺陷」）。
 * >   播放功能留作以后立项。
 * > - `defaultFrameIndex` 恒 `0`。**本期不实现、不验收播放**，只看帧数据正确可用。
 * > - 契约 1.6 **不**新增播放相关字段。
 *
 * ⇒ 本模块的 {@link PUBLISH_PLAYBACK_DEFAULT} 是**常量**，且 {@link publishPlayback}
 * 只做"原样搬运"。任何"把 `loop` 改成 `true` 让发布物能播"的实现都会让
 * `publishPlaybackIsUnaltered` 判红 —— 那条函数存在的唯一目的是让这件事可测。
 */

import { invalidValue, type DomainError, type Result, ok, err } from '@/domain/errors'
import type { LegacyExportDiagnostic, LegacyExportDiagnosticCode } from '@/domain/geometry'
import { legacyExportDiagnostics } from '@/domain/geometry'
import type { Scene } from '@/domain/scene'
import type { AnimationState, AnimationTrack } from '@/domain/animation'
import { trackKey } from '@/domain/animation'
import type { SnapshotPayload } from '@/domain/captureSpec'

/**
 * 发布物的 `playback` 默认值（B-23 / F-09）。
 *
 * **逐字**取自 `docs/contracts/format-scene-file.md:105-107` 的 JSON 与
 * `mod/.../ExportSceneWriter.java:247-250` 的写出点。
 */
export const PUBLISH_PLAYBACK_DEFAULT = Object.freeze({
  loop: false as const,
  defaultFrameIndex: 0 as const,
})

/**
 * 原样搬运 `playback`（B-23）。
 *
 * 三条纪律：
 *  1. 源里**没有** `playback` ⇒ 不放（`copyIfPresent` 语义，`format-scene-file.md:156`）；
 *  2. 源里有 ⇒ **逐字段原样**拷贝（含 `loop: true` 这种"历史文件里就是这样"的情形 ——
 *     本模块不修订既有文件，只保证**我们自己**不改它）；
 *  3. 源里**没有** `loop` 时补 `false` 与补 `defaultFrameIndex: 0` —— 这两项是
 *     **契约规定的必填默认**（F-09 的字段表把 `playback` 标为"是"必填），
 *     故对"World 形态但缺 playback"的旧文件补默认是**如实表达契约**，
 *     不是"顺手启用播放"（`loop` 补的是 `false`）。
 */
export function publishPlayback(source: unknown): Readonly<{ loop: boolean; defaultFrameIndex: number }> | null {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    // 非对象（含 `undefined`）：不凭空造一个 playback。调用方据 `null` 决定是补默认还是拒绝。
    return null
  }
  const o = source as Record<string, unknown>
  return Object.freeze({
    loop: typeof o.loop === 'boolean' ? o.loop : PUBLISH_PLAYBACK_DEFAULT.loop,
    defaultFrameIndex:
      typeof o.defaultFrameIndex === 'number' && Number.isFinite(o.defaultFrameIndex)
        ? Math.floor(o.defaultFrameIndex)
        : PUBLISH_PLAYBACK_DEFAULT.defaultFrameIndex,
  })
}

/**
 * `playback` 是否**未被本模块篡改**（B-23 负对照的可执行面）。
 *
 * 判据：输出的每个字段必须与**源**的同名字段相等（源缺席的字段必须等于契约默认）。
 * 于是"顺手把 `loop` 打开"这件事必然判红 —— 不是靠 review 看出来的。
 */
export function publishPlaybackIsUnaltered(source: unknown, published: ReturnType<typeof publishPlayback>): boolean {
  if (published === null) return source === null || source === undefined || typeof source !== 'object' || Array.isArray(source)
  const o = source as Record<string, unknown>
  const loop = typeof o.loop === 'boolean' ? o.loop : PUBLISH_PLAYBACK_DEFAULT.loop
  const dfi =
    typeof o.defaultFrameIndex === 'number' && Number.isFinite(o.defaultFrameIndex)
      ? Math.floor(o.defaultFrameIndex)
      : PUBLISH_PLAYBACK_DEFAULT.defaultFrameIndex
  return published.loop === loop && published.defaultFrameIndex === dfi
}

// ─────────────────────────────────────────────────────────────────────────────
// 查看所需内容 / 需播放轨道
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 发布格式里"查看所需内容"的逐项（#249 §12 第 2 段）。
 *
 * 每一项都**指明来源**（`source`）：不是"我们决定带上这些"，而是"查看者要看到
 * 这份文档的哪部分，那部分在哪"。这条区分让"漏带一项"可以直接对到具体的文档字段，
 * 而不是只能笼统地说"发布物不完整"。
 */
export interface ViewerRequirement {
  readonly item: 'geometry' | 'palette' | 'texture' | 'tooltip' | 'annotation' | 'label' | 'playback'
  /** 该需求是否被满足（由 {@link inspectPublishableContent} 逐项判定）。 */
  readonly present: boolean
  readonly source: string
}

/** 发布内容清点结果。 */
export interface PublishableContent {
  readonly requirements: readonly ViewerRequirement[]
  /** 缺失项（`present === false`）——**默认导出必须失败**的依据。 */
  readonly missing: readonly ViewerRequirement['item'][]
}

function hasNonEmptyArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0
}

/**
 * 清点"查看所需内容"（发布的**准入**判据）。
 *
 * 与 `preflightExport` 的分工见文件头。本函数的判据来源是各字段在契约里的**必填性**：
 *
 * | 需求 | 必填依据 |
 * |---|---|
 * | `geometry` | `format-scene-file.md:123`（`cellGrid`）—— 没有它就什么都没有可看 |
 * | `palette` | `:124`（`blockPalette`）—— `cellGrid` 的整数必须能解到方块 |
 * | `texture` | B1 的 F-12（`textureBlobs` 是体积大头，但它是**渲染**的前提） |
 * | `tooltip` | F-13 的成对 idioms（"无说明时空数组不是缺省"）⇒ 它**不必非空**，但**必须存在** |
 * | `annotation` / `label` | F-29（V2 新增；**可以为空数组**，那是合法内容） |
 * | `playback` | F-09（必填） |
 *
 * ⇒ "必须存在"与"必须非空"是两件事，本函数逐项区分。混为一谈会造出
 * "一个没有注解的文档无法发布"这种假拒绝 —— 而假拒绝比假成功更隐蔽：
 * 用户会以为是自己文档的问题。
 */
export function inspectPublishableContent(payload: SnapshotPayload | null, doc?: unknown): PublishableContent {
  const reqs: ViewerRequirement[] = []
  const put = (item: ViewerRequirement['item'], present: boolean, source: string): void => {
    reqs.push(Object.freeze({ item, present, source }))
  }
  // 文档形态输入（`doc`）优先：发布判据是**文件字段**层面的，而 `SnapshotPayload`
  // 是求值输入层面的。两者都支持是为了让"从工程发布"与"从旧文件发布"共用一条判据。
  const d = doc !== undefined && doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null
  const frame = d && Array.isArray(d.frames) ? (d.frames[0] as Record<string, unknown> | undefined) : null
  const struct = frame && typeof frame === 'object' && !Array.isArray(frame) && frame.structure !== undefined ? (frame.structure as Record<string, unknown>) : d
  const s = struct !== null && typeof struct === 'object' && !Array.isArray(struct) ? (struct as Record<string, unknown>) : null

  const geometryPresent = s !== null ? hasNonEmptyArray(s.cellGrid) : payload !== null && Object.keys(payload.scene.objects).length > 0
  put('geometry', geometryPresent, s !== null ? 'cellGrid' : 'scene.objects')

  const palettePresent = s !== null ? hasNonEmptyArray(s.blockPalette) || hasNonEmptyArray(d?.blockPalette ?? undefined) : geometryPresent
  put('palette', palettePresent, s !== null ? 'blockPalette' : 'scene.objects')

  const texturePresent = d !== null ? hasNonEmptyArray(d.textureBlobs) || hasNonEmptyArray(s?.textureBlobs) : false
  put('texture', texturePresent, 'textureBlobs')

  // tooltip：**必须存在**（成对 idioms），但**允许为空数组**（无说明是合法内容）。
  put('tooltip', s !== null ? Array.isArray(s.cellTooltipGrid) || Array.isArray(d?.tooltipPalette) : false, 'cellTooltipGrid/tooltipPalette')

  put('annotation', d !== null ? Array.isArray(d.annotations) : false, 'annotations')
  put('label', d !== null ? Array.isArray(d.labels) : false, 'labels')
  put('playback', d !== null ? d.playback !== undefined : true, 'playback')

  const missing = reqs.filter((r) => !r.present).map((r) => r.item)
  return Object.freeze({ requirements: Object.freeze(reqs), missing: Object.freeze(missing) })
}

/**
 * **需播放的轨道**（#249 §12："发布格式包含…需要播放的轨道"）。
 *
 * ## 为什么"需要播放的轨道"要单独列，而不是把动画整份带走
 *
 * 查看者不需要**编辑**轨道，也不需要知道哪些轨道被禁用了。它只需要知道
 * "在发布物里，哪些属性会随时间变" —— 那是**已启用**轨道的集合
 * （`domain/animation.animationDrivenKeys` 的同一判据：`enabled` 才算驱动）。
 *
 * 把禁用轨道也带走会让查看者误以为它们会动；把它们**丢掉**则会让"用户明确禁用了
 * 某条轨道"这个决定在发布物里不可表达。⇒ 本函数返回**显式清单**（含 `enabled`），
 * 由发布格式决定怎么落盘；**不**自行过滤，因为"过滤掉禁用轨道"是一个会丢信息的
 * 决定，必须由调用方显式做（`#249` §12「不静默丢语义」）。
 */
export interface PlaybackTrackRequirement {
  readonly key: string
  readonly trackId: string
  readonly enabled: boolean
  readonly valueType: AnimationTrack['valueType']
  readonly keyCount: number
}

export function playbackTrackRequirements(animation: AnimationState): readonly PlaybackTrackRequirement[] {
  return Object.freeze(
    animation.tracks.map((t: AnimationTrack) =>
      Object.freeze({
        // `trackKey` 是 `domain/animation` 的规范键（与轨道查找、驱动判定同一算法）。
        key: trackKey(t),
        trackId: t.id,
        enabled: t.enabled,
        valueType: t.valueType,
        keyCount: t.keys.length,
      }),
    ),
  )
}

/** 真正**需要播放**（已启用且有键）的轨道。 */
export function requiringPlayback(animation: AnimationState): readonly PlaybackTrackRequirement[] {
  return Object.freeze(playbackTrackRequirements(animation).filter((t) => t.enabled && t.keyCount > 0))
}

// ─────────────────────────────────────────────────────────────────────────────
// 能力损失（接 P3 的挂点；**不**重新实现"什么算不可表达"）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 能力损失记录（发布物的一部分）。
 *
 * ## 为什么它进产物而不是只进诊断
 *
 * `#249` §12 的原文是「必要时导出烘焙结果，**并记录能力损失**」——
 * "记录"的接收者是**下游**（看这份产物的人/工具），不是本次导出的日志。
 * 一份被烘焙过的产物若不携带"哪些东西没法忠实表达"，下游就无从知道
 * 它看到的是近似结果。
 *
 * `legacyExportDiagnostics()`（P3 在 `domain/geometry.ts:853-903` 交付的挂点）
 * 是**唯一**的判据来源。本模块接它进发布预检，**不**重新写一遍"什么算不可表达"
 * （父执行者已把它接进 `captureSpec.captureCapabilityLoss`，本模块消费同一份记录）。
 */
export interface CapabilityLossRecord {
  /** 稳定码计数（按码聚合；`LegacyExportUnsupported*`）。 */
  readonly byCode: Readonly<Record<string, number>>
  /** 逐项明细（不聚合丢掉 objectId —— 诊断要能定位到对象）。 */
  readonly items: readonly LegacyExportDiagnostic[]
  /** 是否显式接受了有损输出（`#249` §12「可选有损输出必须是**显式模式**」）。 */
  readonly lossyAccepted: boolean
}

/** 由能力损失明细构造记录（纯）。 */
export function capabilityLossRecord(items: readonly LegacyExportDiagnostic[], lossyAccepted = false): CapabilityLossRecord {
  const byCode: Record<string, number> = {}
  for (const d of items) byCode[d.code] = (byCode[d.code] ?? 0) + 1
  return Object.freeze({
    byCode: Object.freeze(byCode),
    items: Object.freeze([...items]),
    lossyAccepted,
  })
}

/** 从场景采集能力损失（转发 P3 的挂点；**唯一**判据来源）。 */
export function collectCapabilityLoss(scene: Scene, lossyAccepted = false): CapabilityLossRecord {
  return capabilityLossRecord(legacyExportDiagnostics(scene), lossyAccepted)
}

/** 按码取出明细（证据输出与逐项报告用）。 */
export function lossItemsOfCode(record: CapabilityLossRecord, code: LegacyExportDiagnosticCode): readonly LegacyExportDiagnostic[] {
  return Object.freeze(record.items.filter((d) => d.code === code))
}

// ─────────────────────────────────────────────────────────────────────────────
// 发布预检（**默认失败**而非假成功）
// ─────────────────────────────────────────────────────────────────────────────

/** 发布诊断码（结构化；语言无关 —— #249 §19.7）。 */
export type PublishDiagnosticCode =
  | 'PublishMissingViewerContent'
  | 'PublishCapabilityLossUnaccepted'
  | 'PublishPlaybackModified'
  | 'PublishProjectShapeSelected'
  | 'PublishEmptyTrackSet'

export interface PublishDiagnostic {
  readonly code: PublishDiagnosticCode
  readonly detail: Readonly<Record<string, string | number>>
}

/**
 * 发布预检结论。
 *
 * **没有第三个状态**：非 `ready` 即 `blocked`。加一个 `partial` 会让"部分成功"
 * 变成一个正常返回值 —— 而 `#249` §12 明确"部分输出仅在**显式模式**下允许并标记"，
 * 那种情形由 `lossyAccepted` 表达（它仍在 `ready` 或 `blocked` 里二选一）。
 */
export type PublishPreflight =
  | { readonly status: 'ready'; readonly diagnostics: readonly PublishDiagnostic[]; readonly loss: CapabilityLossRecord }
  | { readonly status: 'blocked'; readonly diagnostics: readonly PublishDiagnostic[]; readonly loss: CapabilityLossRecord }

export interface PublishPreflightInput {
  /** 待发布的**文档**（旧格式形态；发布判据是文件字段层面的）。 */
  readonly document: unknown
  /** 动画状态（需播放轨道的来源）。 */
  readonly animation?: AnimationState
  readonly scene?: Scene
  /**
   * 是否**显式**接受有损输出（`#249` §12）。
   *
   * 缺省 `false` ⇒ 有任何能力损失即 blocked。这条默认值是本模块最重要的一行：
   * 反过来（缺省接受）会让所有"不支持的变形"静默降采样，而调用方**永远**不会
   * 注意到自己需要传这个参数。
   */
  readonly allowLossy?: boolean
  /** 已采集的能力损失（缺省由 `scene` 现采）。 */
  readonly capabilityLoss?: readonly LegacyExportDiagnostic[]
  /** 源 `playback`（用于"未被篡改"判据；缺省从 `document` 读）。 */
  readonly sourcePlayback?: unknown
  /** 输出形态是否为**发布**（false = 工程）。工程形态不适用发布判据。 */
  readonly publish?: boolean
}

/**
 * 发布预检 —— **默认失败而非假成功**（#249 §12 末段；A20 判据 4）。
 *
 * 四条判据，逐条对应一条验收/负对照：
 *  1. **查看所需内容缺项** ⇒ blocked（A20 判据 3 的发布面）；
 *  2. **有未接受的能力损失** ⇒ blocked（**默认**导出失败，A20 负对照 b 的落点）；
 *  3. **`playback` 被篡改** ⇒ blocked（B-23「不得顺手启用播放」）；
 *  4. **形态不是发布** ⇒ blocked（拿工程去发布是显式错误，不是"顺便也能发"）。
 *
 * 注意第 2 条**不**区分损失的种类：任何一种 `LegacyExportUnsupported*` 都阻塞。
 * 理由：`#249` §12 要求"逐项报告"而不是"选最严重的一项报"，而按种类分优先级会让
 * 新增一种损失时默认被忽略（新 code 不在白名单里 ⇒ 不阻塞）。
 */
export function preflightPublish(input: PublishPreflightInput): PublishPreflight {
  const diagnostics: PublishDiagnostic[] = []
  const loss = capabilityLossRecord(
    input.capabilityLoss ?? (input.scene ? legacyExportDiagnostics(input.scene) : []),
    input.allowLossy === true,
  )

  if (input.publish === false) {
    // 显式标注类型：`detail` 的字面量里 `publish: false` 会被推断成 `boolean` 之外的
    // 收窄形态，与 `PublishDiagnostic.detail` 的 `string | number` 值类型不合。
    const detail: Record<string, string | number> = { publish: 0 }
    diagnostics.push(Object.freeze({ code: 'PublishProjectShapeSelected' as const, detail: Object.freeze(detail) }))
  }

  const content = inspectPublishableContent(null, input.document)
  if (content.missing.length > 0) {
    diagnostics.push(
      Object.freeze({
        code: 'PublishMissingViewerContent' as const,
        detail: Object.freeze({ missing: content.missing.join(',') , checked: content.requirements.length }),
      }),
    )
  }

  if (loss.items.length > 0 && input.allowLossy !== true) {
    // 逐项报告（不是"有 N 项损失"一句）—— `#249` §12 原文要求"逐项报告"。
    for (const d of loss.items) {
      diagnostics.push(
        Object.freeze({
          code: 'PublishCapabilityLossUnaccepted' as const,
          detail: Object.freeze({ loss: d.code, objectId: d.objectId, dataId: d.dataId, ...flattenDetail(d.detail) }),
        }),
      )
    }
  }

  const sourcePlayback = input.sourcePlayback !== undefined ? input.sourcePlayback : readPlaybackOf(input.document)
  const published = publishPlayback(sourcePlayback)
  if (sourcePlayback !== undefined && sourcePlayback !== null && !publishPlaybackIsUnaltered(sourcePlayback, published)) {
    diagnostics.push(Object.freeze({ code: 'PublishPlaybackModified' as const, detail: Object.freeze({ source: JSON.stringify(sourcePlayback) }) }))
  }

  return diagnostics.length === 0
    ? Object.freeze({ status: 'ready' as const, diagnostics: Object.freeze([]), loss })
    : Object.freeze({ status: 'blocked' as const, diagnostics: Object.freeze(diagnostics), loss })
}

function readPlaybackOf(document: unknown): unknown {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return undefined
  return (document as Record<string, unknown>).playback
}

function flattenDetail(detail: Readonly<Record<string, string | number>>): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(detail)) out[`loss.${k}`] = v
  return out
}

/**
 * 发布预检结论 → 结构化错误（**失败的产物侧**）。
 *
 * 返回 `null` 表示"可以继续"，非 `null` 表示**必须中止且不得产出文件**。
 * 调用方拿到非 `null` 时**没有**任何"退化成有损输出"的路径 —— 那正是
 * A20 判据 4「必须断言失败时没有产物返回」要的结构性质：本模块的公开面里
 * **不存在**"返回一个字节"的函数，故"失败了但仍然拿到产物"不可表达。
 */
export function publishPreflightError(preflight: PublishPreflight): DomainError | null {
  if (preflight.status === 'ready') return null
  const first = preflight.diagnostics[0]!
  const params: Record<string, string | number> = { reason: first.code, ...first.detail }
  // 缺查看内容 ⇒ 值不合法（文件缺必填项）；能力损失 ⇒ 能力不存在（#249 §12 的
  // "不支持的几何、变形、文字或轨道"）；形态选错 ⇒ 值不合法。
  if (first.code === 'PublishCapabilityLossUnaccepted') {
    return { code: 'UnsupportedOperation', params: Object.freeze(params) }
  }
  return invalidValue(params)
}

/** 发布预检结论 → 能力报告（供 `#249` §12「逐项报告」的展示面消费）。 */
export interface PublishCapabilityReport {
  readonly ready: boolean
  readonly lossItems: readonly LegacyExportDiagnostic[]
  readonly lossByCode: Readonly<Record<string, number>>
  readonly playbackTracks: readonly PlaybackTrackRequirement[]
  readonly viewerRequirements: readonly ViewerRequirement[]
}

export function publishCapabilityReport(preflight: PublishPreflight, animation: AnimationState | undefined, document: unknown): PublishCapabilityReport {
  return Object.freeze({
    ready: preflight.status === 'ready',
    lossItems: preflight.loss.items,
    lossByCode: preflight.loss.byCode,
    playbackTracks: animation ? playbackTrackRequirements(animation) : Object.freeze([]),
    viewerRequirements: inspectPublishableContent(null, document).requirements,
  })
}

/** 未使用占位：保持 `err`/`Result`/`ok` 可达（下游按 `Result` 组合）。 */
export type { Result }
void ok
void err
