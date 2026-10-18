/**
 * `runtime/kernelSession` —— **宿主侧的内核会话**：把 P1 执行协议接进生产
 * （R-WK-03 裁决：内核→生产接线是 #261 的核心内容）。
 *
 * ## 本模块解决什么（它替代的旧机制）
 *
 * R-WK-03 的侦察结论是「内核在生产代码**零调用方**」：`new Editor(` 零生产构造、
 * `runtime/evaluation.ts` 零导入者、没有任何生产调用方推进 `EditContext` 时间。
 * 于是**播放与纹理动画的生产唯一来源**是待删的旧机制：
 * `drwMeshPipeline` 的 `setTimeout` 自续播放调度 + `renderEngine` 里
 * `materialLibrary.tick(clock.getDelta())` 的每材质累加器 + `Main` 上的两个 Vue Ref。
 *
 * 本模块把那三者的**权威**搬进内核：
 *
 * | 旧机制 | 本模块的替代 |
 * |---|---|
 * | `Main.framesPlaybackIsPlaying`（Vue Ref） | `EditContext.playing`（值；经 `setPlaying` 命令写） |
 * | `Main.currentFrameIndex`（Vue Ref） | **派生值**：由 `EditContext.time` + 帧时长轴算出（见 {@link KernelSession.frameIndex}） |
 * | `drwMeshPipeline` 的 `setTimeout` 自续 | 宿主**按帧**调用 {@link KernelSession.frame} 注入经过秒数 |
 * | `materialLibrary.tick(delta)` 累加 | 时间进 `EditContext.time`，采样是纯函数（`domain/materials`） |
 *
 * ## 三条硬要求及其落点
 *
 * ### 1. 宿主创建 `Editor`，内核不自跑（A03）
 * 本模块**没有** `requestAnimationFrame` / `setTimeout` / `setInterval` ——
 * 它是 `runtime` 层（`corePurity: true`），连 Vue 都不能 import。
 * 帧时钟在 `composition/kernelRuntime`（装配层），本模块只提供
 * {@link KernelSession.frame} 这个**被调用**的入口。
 *
 * ### 2. 时间输入是**显式**的（#249 §9「时钟以输入注入」）
 * {@link KernelSession.frame} 接收 `deltaSeconds` 并把它作为
 * `advancePlayback` 命令的参数提交 —— 纯转移因此不读墙钟，
 * 且"同一时间 ⇒ 同一样本"（A09/A27）与"跳帧 = 直接定位"共用一条求值路径。
 *
 * ### 3. 读面是**推**的，不是每帧重建（A03「发布版本内一致」）
 * 构造时 `observe({kind:'context'})` 订阅一次；每次权威变化由内核**投递**
 * 一份一致快照。于是"渲染消费求值结果"不需要每帧重新 `read()` 一个完整 `ReadView`
 * （那是每帧一次的对象分配风暴），也不会读到"新时间配旧播放开关"的组合
 * —— 投递的值来自**同一个**不可变状态。
 *
 * ## 与 A3（文档内容迁移）的分工
 *
 * 本模块接的是**编辑上下文与时间/播放**这条线（R-WK-03 明列的内核缺口）。
 * 工作台的**文档内容**由具名读面读取（`Context#kernelGrid` / `kernelAnnotations` /
 * `frameDeclarations` / …；旧 `context.getDoc()` **已终删**，见 #301 P10f D3），
 * 而**写模型与渲染链的旧格式**仍是旧 `RuntimeDocument`（已登记接缝），
 * 故帧声明（帧数、每帧时长）由宿主经 {@link KernelSession.bindFrameSource} 注入 ——
 * 这是一条**显式登记**的适配接缝，不是"内核偷偷读旧文档"：
 * 内核只接受 `count()` / `durationsMs()` 两个纯值提供者，不认识 `RuntimeDocument`。
 */

import { Editor, type CommandTicket, type QuerySpec } from './execution'
import type { Command } from '@/application/commands'
import type { CommandOutcome } from '@/application/contracts'
import type { InputSource } from './scheduling'
import { queryDocument, type DocumentSummary, type ReadView } from '@/application/queries'
import { defaultExecutionInputs, type SaveCompletedCommand } from '@/application/commands'
import type { ApplicationState } from '@/application/state'
import type { Document } from '@/domain/document'
import type { Version } from '@/domain/identity'
import type { ExecutionInputs } from '@/application/commands'
import type { ObjectTypeDecl } from '@/application/properties'
import type { ObjectFactoryTable } from '@/domain/scene'
import { sampleStripFrameAt, stripTimeline, type StripTimeline } from '@/domain/materials'
import { frameDurationsMs, frameCount as axisFrameCount, type DocumentContent } from '@/domain/content'
import { framesPerSecond, type TimeValue } from '@/domain/animation'
import { TIME_ZERO } from '@/domain/editing'
import type { MultiblockBody } from '@/domain/multiblockDocument'
import { generatedObjectWriteAuthority } from '@/domain/multiblock'
// M5-2：保留键下沉到 domain（面板/装配/画面求值共用同一份取值空间契约）。
import { RUNSTATE_CHANNEL, TOTAL_TIER_CHANNEL } from '@/domain/multiblockSelection'
export { RUNSTATE_CHANNEL, TOTAL_TIER_CHANNEL }

// ─────────────────────────────────────────────────────────────────────────────
// 稳定身份（单一来源）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 内核文档 id。
 *
 * ## 为什么是一个**常量**而不是"每次随机"
 *
 * `ReadScope` 与 `QuerySpec` 都按 id 寻址；重放记录（A04）也按 id 对齐。
 * 若每次构造换一个随机 id，同一份输入流在两次运行里会产生不同的语义摘要
 * —— 于是"相同输入可重放"就不再成立。
 *
 * 单文档是本批的口径（`ApplicationState` 支持多文档，但工作台/嵌入各只开一个）；
 * 多文档接线时这两个常量应改为按工作区生成的稳定 id（那时重放要对齐工作区 id）。
 */
export const KERNEL_DOCUMENT_ID = 'doc-1'

/** 内核编辑上下文 id（时间/播放/选择的归属；同一实例内唯一）。 */
export const KERNEL_CONTEXT_ID = 'ctx-1'

// `TOTAL_TIER_CHANNEL` / `RUNSTATE_CHANNEL` 的定义已下沉到
// `domain/multiblockSelection`（本文件只 re-export，见文件头 import）：
// 保留键是**取值空间契约**，面板投影（domain）与画面求值（composition）都要读它，
// 留在 runtime 会让下两层无法使用同一份常量。

/** 空取值表（**冻结**的同一个实例：`channelValues()` 无结果时返回它，不每次新建）。 */
const EMPTY_CHANNEL_VALUES: Readonly<Record<string, number>> = Object.freeze({})

// ─────────────────────────────────────────────────────────────────────────────
// 对外类型
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 播放读面（内核 `ReadView.interaction.playback()` 的投影）。
 *
 * `time` 与 `playing` 来自**同一份**内核状态，故不存在"开关说在播、时间却是旧的"。
 */
export interface KernelPlayback {
  readonly playing: boolean
  readonly rate: number
  readonly time: TimeValue
}

/**
 * **装配面**（#301 P10f D2）。
 *
 * 投影（`composition/kernelProjection`）重建旧格式产物时，有两样事实**只有装配期知道**：
 * 帧对象映射与多方块类型化投影面。本接口是它们交给会话保管时的**不透明**形状。
 *
 * ⚠️ `multiblock` 是 `unknown`，理由见 `KernelSession#assemblyFace` 的说明
 * （内核不得 import 装配根的类型 —— 方向会反）。
 */
export interface KernelAssemblyFace {
  /** 帧下标 → 内核对象 id（装配产物原样；长度 = 帧数，多方块文档为 1）。 */
  readonly frameObjects: readonly string[]
  /** 多方块类型化投影面（`composition` 侧解释）；`null` = 帧为主文档。 */
  readonly multiblock: unknown
}

/**
 * 帧声明提供者（**显式适配接缝**）。
 *
 * 两个方法都必须是**纯值读取**：内核不持有文档、不认识 `RuntimeDocument`、
 * 也不在内部缓存它们的结果（每次问、每次用）。
 *
 * 为什么是函数而不是"数组参数"：帧声明会随文档替换而变化（打开另一份文件），
 * 传数组会要求宿主在每次换文档时重新调 `bindFrameSource` 并保证不漏 ——
 * 而漏一次就得到"渲染按旧帧表选帧"的静默错误。函数形式让"总是读当前值"
 * 成为结构事实。
 */
export interface FrameSource {
  /** 帧总数。 */
  count(): number
  /** 每帧的停留时长（毫秒）；长度不足时缺项按 `1` 处理。 */
  durationsMs(): readonly number[]
}

export interface KernelSessionOptions {
  /** 文档 id（内核身份空间）。 */
  readonly documentId: string
  /** 编辑上下文 id（时间/播放/选择都挂在这里）。 */
  readonly contextId: string
  /** 能力集合（profile 裁剪；来自装配结果）。 */
  readonly capabilities: readonly string[]
  /** 身份前缀（进 `IdState`，使重放可复现）。 */
  readonly prefix?: string
  /** 对象类型构造工厂（装配层可覆盖以加载贡献类型）。 */
  readonly objectFactories?: ObjectFactoryTable
  /**
   * **装配贡献的对象类型 RNA 声明**（`#262` P11-F 段①：A21 的属性写半边）。
   *
   * 由装配层从 `Assembly.contributions.objectTypes[].rna` 派生
   * （`composition/contributedObjectTypes#objectTypeDeclarationsOf`），
   * 经 `ExecutionInputs` 交给 `reduceCommand` —— 缺省 = 只有内核内置类型，
   * 与会话在 P11-F 之前的行为逐字相同。
   */
  readonly contributedObjectTypes?: readonly ObjectTypeDecl[]
}

// ─────────────────────────────────────────────────────────────────────────────
// 生产保存的结算凭据（M8-2 / D1）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一次生产保存请求的**不可变凭据**（`beginSaveRequest` 的返回值）。
 *
 * 三样都是**捕获时刻**的事实：请求序号（在途判据）、绑定代数（旧完成事件判据）、
 * 捕获的内容身份 S0（成功时基线的落点）。宿主只把它原样递回
 * `completeSaveRequest` —— 不允许在完成时重新读"当前版本"来推基线。
 */
export interface KernelSaveRequest {
  readonly sequence: number
  readonly bindingGeneration: number
  readonly capturedVersion: Version
}

/** 一次生产保存的结局（只有 `committed` 推进基线；失败/过期一律不动）。 */
export type KernelSaveOutcome =
  | { readonly kind: 'committed' }
  | { readonly kind: 'failed'; readonly code: string }

const COMMITTED: { readonly kind: 'committed' } = Object.freeze({ kind: 'committed' })

// ─────────────────────────────────────────────────────────────────────────────
// 会话
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一个运行实例的内核会话。
 *
 * 一个外壳（工作台 / 嵌入 / wiki 工作台）持有一个会话；它**不**是模块级单例
 * （那正是 B5 #7 要退役的形态），由宿主在装配时创建并注入 `Context`。
 */
export class KernelSession {
  private editor: Editor
  readonly documentId: string
  readonly contextId: string
  /** 身份前缀（`adoptDocument` 重建 `Editor` 时必须沿用，否则重放 id 会漂移）。 */
  private readonly prefix: string
  /** 执行输入（能力裁剪；重建 `Editor` 时必须重新注入 —— 否则能力回退成全能力）。 */
  private executionInputs: ExecutionInputs
  private disposeObserver: () => void

  /**
   * 最近一次内核投递的播放快照。
   *
   * 初值取 `TIME_ZERO` + 暂停：它**不是**一个"猜的默认值"，而是
   * `createEditContext` 的真实初值（`domain/editing` 里写死的那三个）。
   * 订阅回调会立刻投递一次当前值（`Editor.observe` 的首次投递），故初值
   * 只在构造与首次投递之间可见。
   */
  private playbackSnapshot: KernelPlayback = Object.freeze({
    playing: false,
    rate: 1,
    time: TIME_ZERO,
  })

  /** 帧声明提供者；缺省"无帧"（0 帧 ⇒ 帧下标恒 0）。 */
  private frameSource: FrameSource = { count: () => 0, durationsMs: () => [] }

  /**
   * 最近一次内核投递的**通道取值快照**（唯一读面）（#282 P10b）。
   *
   * ## 为什么与 `playbackSnapshot` 同一手法（由内核推、不是每次重建）
   *
   * 视口渲染必须**反应式**地跟随取值变化（旧形态靠每视口 `revision` 计数器 +
   * `watch` 推 mesh 重建）。取值现在归 `EditContext`，而 `context` 观察规格
   * 的投递值**已经包含** `channelValues`（见 `runtime/execution.ts` 的
   * `case 'context'`）—— 故复用同一个订阅即可，不需要第二条订阅或第二个轮询。
   *
   * 初值是**冻结的空表**：它是 `createEditContext` 的真实初值
   * （`domain/editing.ts` 里 `channelValues: Object.freeze({})`），不是猜的默认值。
   */
  private channelSnapshot: Readonly<Record<string, number>> = EMPTY_CHANNEL_VALUES



  constructor(opts: KernelSessionOptions) {
    this.documentId = opts.documentId
    this.contextId = opts.contextId
    this.prefix = opts.prefix ?? 'wk'
    this.editor = new Editor({ prefix: this.prefix })
    // 执行输入来自**装配结果**（能力裁剪），不是内核默认的全能力 ——
    // A15「运行时绕 UI 发编辑命令被拒绝」的第二道落点就在这里。
    // `objectFactories` 缺省时由 `defaultExecutionInputs` 给内置三类；
    // 装配层要加载贡献类型时显式覆盖。
    this.executionInputs =
      opts.objectFactories === undefined
        ? defaultExecutionInputs(opts.capabilities)
        : { capabilities: opts.capabilities, objectFactories: opts.objectFactories }
    // 贡献类型声明**按需附加**（不是无条件加一个空字段）：缺省时执行输入与
    // P11-F 之前逐字相同 —— `reduceCommand` 走那两个构造期固定的单例。
    if (opts.contributedObjectTypes !== undefined && opts.contributedObjectTypes.length > 0) {
      this.executionInputs = Object.freeze({
        ...this.executionInputs,
        contributedObjectTypes: opts.contributedObjectTypes,
      })
    }
    this.editor.setExecutionInputs(this.executionInputs)
    // 打开文档 + 上下文（一条命令，与 `openDocumentState` 同一入口）。
    this.editor.submit({ kind: 'openDocument', documentId: opts.documentId, contextId: opts.contextId })
    this.editor.drain()
    // 订阅上下文快照：时间/播放/通道的变化由内核**推**过来。
    this.disposeObserver = () => {}
    this.subscribeContext()
  }

  /** 绑定帧声明提供者（宿主在文档加载/替换后设置一次；提供者自身读当前值）。 */
  bindFrameSource(source: FrameSource): void {
    this.frameSource = source
  }

  /**
   * **采纳一份已装配的内核文档**（#282 P10b：装配 → 生产接线的落点）。
   *
   * ## 为什么需要它，以及为什么不能用现有命令
   *
   * 内核的 `openDocument` 命令**总是**造一个空场景的文档
   * （`reduceOpenDocument` → `createDocument(id)`，见 `application/commands`），
   * 且对已打开的 `documentId` 直接拒绝。故"把一份装配好的 `Document` 装进会话"
   * 在现有命令面上**不可表达**。
   *
   * 而新增一条 `adoptDocument` 命令会扩展**冻结契约**的封闭命令联合
   * （契约 §5.2 的封闭判别联合；`freeze-convergence.test.ts` 逐条断言那 24 项）。
   * 契约 §8 明文：遇到未覆盖之处"就地记录、不就地实现"，缺口回 #250 裁决 ——
   * 故本批**不**私自扩命令面，而是走 `Editor` 的**既有公开注入点**
   * `EditorOptions.initial`（它被设计为"唯一受支持的把预建状态交给 Editor 的通路"）。
   *
   * ## 代价（如实登记，不掩盖）
   *
   * 它**重建** `Editor` 实例：旧实例的订阅、票据与重放流水随之作废。故本方法
   * 重新建立上下文订阅，且**不**被设计为高频调用（每次"打开/替换文档"一次）。
   * 这条代价登记为遗留缺口（见汇报），根治需要那条命令 —— 归 #250 裁决。
   *
   * ## 顺序
   *
   * 1. 取当前快照（保留 `ids` 分配状态 ⇒ 装配后的编辑仍可重放）；
   * 2. 把 `docs[documentId]` 换成装配产物；
   * 3. 用 `initial` 建新 `Editor`，重建订阅。
   */
  adoptDocument(document: Document, content?: DocumentContent): void {
    const base = this.editor.snapshot()
    const withDoc: ApplicationState = Object.freeze({
      ...base,
      docs: Object.freeze({ ...base.docs, [this.documentId]: document }),
    })
    this.disposeObserver()
    this.editor = new Editor({ prefix: this.prefix, initial: withDoc })
    this.editor.setExecutionInputs(this.executionInputs)
    // 帧声明：优先用**装配产物的帧时长轴**（内核文档自己声明的事实），
    // 而不是外部注入的提供者 —— 那正是"文档内容面迁进内核"的可观测含义。
    // 外部提供者仍可用 `bindFrameSource` 覆盖（例如宿主想在换文档前先绑定）。
    if (content !== undefined) {
      this.frameSource = {
        count: () => axisFrameCount({ frames: content.frameAxis.frames }),
        durationsMs: () => frameDurationsMs({ frames: content.frameAxis.frames }),
      }
    }
    // 采纳即"已装载"（A′ GF-15）+ "已承载装配产物"（C′1 GF-16）。
    // 两个标记**分别**置位：前者是存在性，后者是"内核里的就是这份文档"。
    this.markLoaded()
    this.markContentAdopted()
    this.subscribeContext()
  }

  // ── 装载状态（#301 P10f A′；GF-15） ──────────────────────────────────────

  /**
   * 当前**已装载**的文档身份（`null` = 未装载）。
   *
   * ## 为什么记"身份"而不是一个裸布尔
   *
   * `false` 有**两种成因**，它们在诊断与处置上不同：
   *  - **从未装载**：会话刚构造，或某条路径从未装过内容；
   *  - **已卸载**：曾经装过，随后被显式卸载（关文档 / 切换工作区）。
   *
   * 记身份使两者可区分（未来要报"上一次装载的是哪份"也有值可查），
   * 而裸布尔会把它们压成同一个事实 —— 与 `domain/cellContent` 判据 3
   * 「字段缺席 ≠ 空值」同一口径。
   */
  private adoptedDocumentId: string | null = null

  /**
   * **内核是否承载"装配成功"的内容**（#301 P10f C′1；GF-16）。
   *
   * 与 `adoptedDocumentId` **并列而非合并**（理由见 `hasAdoptedContent`）：
   * 前者是"有文档"，后者是"内核里的就是那份文档"。D8 的本质是把两者当成了一件事。
   */
  private contentAdopted = false

  /**
   * **源文件的未知顶层字段**（#301 P10f D1；G-6a 的产物侧承载）。
   *
   * ## 它承载什么
   *
   * 装配时（`assembleKernelDocument`）算出的"本适配器解释不了的顶层键"
   * （含 `meta.` 前缀的元数据未知键）—— 即"保存 → 再打开"要保留、否则**静默丢弃**的那些。
   *
   * ## ⚠️ 三态（不是两态）—— 与 `domain/cellContent` 判据 3「缺席 ≠ 空」同一口径
   *
   * | 值 | 含义 |
   * |---|---|
   * | `null` | **未采集**（这条装载路径没走装配，或尚未装载）—— "不知道" |
   * | `{}` | **采集了，且确实没有**未知字段 —— "知道，且为空" |
   *
   * 把 `null` 压成 `{}` 会让"没采集"冒充"没有"⇒ 保存侧会理直气壮地丢掉字段
   * （那正是本批要消灭的形态）。故初值与卸载都置 `null`，**不**置 `{}`。
   *
   * ## 为什么是 `Readonly<Record<string, unknown>>` 而不是 `FidelityRecord`
   *
   * `FidelityRecord` 定义在 `adapters/files/fidelityRecord.ts` ⇒ 引用它是**深度 3**，
   * 而本文件是闸门执行面（登记在 `runtime/` 的 `activeSubpaths`）⇒ 会触
   * `gate/no-private-cross-layer`。会话侧只需要**字段表本身**
   * （`sourceFormat`/`sourceVersion` 已被 `adapters/fidelityCapture` 内部消费）
   * ⇒ 收成纯数据，本文件**零新增 import**。
   */
  private fidelityFieldMap: Readonly<Record<string, unknown>> | null = null

  /**
   * 记下源文件的未知顶层字段（`null` = 未采集；见 `fidelityFieldMap` 的三态）。
   *
   * 调用方是装配路径（`composition/documentLoad` 的 `adoptLoadedDocument`）——
   * 它是唯一手里同时有 `unknownFields`/`sourceFormat`/`sourceVersion` 的地方。
   */
  setFidelityFieldMap(fields: Readonly<Record<string, unknown>> | null): void {
    // 冻结副本：调用方之后改自己的对象不得影响本会话记录的事实。
    this.fidelityFieldMap = fields === null ? null : Object.freeze({ ...fields })
  }

  /**
   * 读源文件的未知顶层字段（`null` = **未采集**，不是"没有"）。
   *
   * ⚠️ 消费方（保存/导出投影，D2）**必须**区分 `null` 与 `{}`：
   * 前者应回落（不传 `fidelityFields`），后者应显式传空表。
   */
  fidelityFieldMapOf(): Readonly<Record<string, unknown>> | null {
    return this.fidelityFieldMap
  }

  /**
   * **无损装配源根**（`null` = 未采集）—— 装配这份文档时解析器看到的 plain 根。
   *
   * ## 为什么必须由会话保管（G5 的落点）
   *
   * `RuntimeDocument.fromV2Plain` 的 `known` 集合列了
   * `label`/`author`/`description`/`gtnhVersion`/`modSource`/`globalConfig`/`schemaVersion`
   * 七个根级键却**从不读**它们、又把它们排除在 `_extra` 之外 ⇒ 它们既不在
   * `meta` 里、也不在 `_extra` 里、更不在 `serialize()` 里：**从 `RuntimeDocument`
   * 出发无法恢复**（实测登记在 `adapters/plainRoot.ts` 文件头与
   * `composition/kernelAssembly#legacyPlainRoot` 的说明里）。
   *
   * 于是任何"从 `doc.serialize()` 出发"的投影都**必然有损**。渲染视图这条链
   * （`composition/kernelRenderView`）原先就是这么走的（`:98-99` 的缺省回落），
   * 后果是"渲染视图的元数据与装配/保存两条链不一致"——同一个装配函数
   * （`assembleKernelDocument`）在保存链吃无损源、在渲染链吃有损源，
   * 两处算出的 `content.metadata` 因此不同。
   *
   * ## 为什么写进会话（而不是留在装配函数局部）
   *
   * 消费方是**视口层的 composable**（`shared/viewport/useKernelChannels`），
   * 与装配（`composition/documentLoad`）不在同一个调用栈上 ⇒ 记录必须有
   * **生命周期 = 文档生命周期**的宿主。会话正是它（先例：`fidelityFieldMap`、
   * `assemblyFace`）：装载时置位、卸载时清空（`markUnloaded`）⇒ 不串档。
   *
   * ## 冻结副本
   *
   * 与 `setFidelityFieldMap` 同口径：浅拷贝 + 冻结，调用方之后改自己的对象
   * 不得影响本会话记录的事实。
   */
  private assemblySourceRoot: Readonly<Record<string, unknown>> | null = null

  /** 记下**无损装配源根**（`null` = 未采集；三态口径同 `fidelityFieldMap`）。 */
  setAssemblySourceRoot(root: Readonly<Record<string, unknown>> | null): void {
    this.assemblySourceRoot = root === null ? null : Object.freeze({ ...root })
  }

  /**
   * 读**无损装配源根**（`null` = **未采集**，不是"没有"）。
   *
   * ⚠️ 消费方**必须**把 `null` 当成"没有无损源可用"（如实降级），
   * 不得伪造一份空对象 —— 空对象会被装配层当成"源里什么都没有"，
   * 把"未采集"静默变成"元数据为空"（GD 系列的同型缺陷）。
   */
  assemblySourceRootOf(): Readonly<Record<string, unknown>> | null {
    return this.assemblySourceRoot
  }

  /**
   * **多方块内层 body 的内核承运**（G3 / #388 裁决第 3 项）。
   *
   * ## 为什么放在会话（与 `assemblySourceRoot` / `assemblyFace` 同一宿主）
   *
   * body（多方块声明的内核承载 + 逐帧参考网格的**取证**通道）只有**装配期**能产出：
   * 它的输入是解析结果（`adapters/files/multiblockDeclaration`），而消费方
   * （`shared/viewport/useKernelChannels` 的再装配，见
   * `composition/kernelAssembly#assembleMultiblockKernelFace`）在**另一个调用栈**上。
   * ⇒ 承运必须有"生命周期 = 文档生命周期"的宿主：装载置位、卸载清空（`markUnloaded`）
   * ⇒ 换文档不串档（判据：换文档后不得读到上一份的 body）。
   *
   * ## 为什么不是"哈希/摘要"或"再解析一次"
   *
   * body 是**类型化内核承运**（冻结纯数据），不是旧文档的替身：会话不 import
   * 装配根的投影形状，也不持有 `RuntimeDocument` —— 它只保管这份不可变值。
   * 求值端口（`context/multiblock`）在装配层适配（见
   * `composition/kernelAssembly#evaluatorDocumentOf`），本处只做保管。
   */
  private multiblockBody: MultiblockBody | null = null

  /** 记下**多方块内层 body**（`null` = 该文档没有多方块声明 / 未装配）。 */
  setMultiblockBody(body: MultiblockBody | null): void {
    this.multiblockBody = body
  }

  /**
   * 读**多方块内层 body**（`null` = 未装配 / 帧为主文档）。
   *
   * ⚠️ `null` 是**如实答案**（"这份文档没有可再装配的 body"），消费方必须据此
   * 显式失败或降级（`assembleMultiblockKernelFace` 的 `multiblockBodyNotCarried`），
   * **不得**回头去旧文档里翻（那正是 G3 要拆掉的那条路）。
   */
  multiblockBodyOf(): MultiblockBody | null {
    return this.multiblockBody
  }

  /**
   * **装配面**（#301 P10f D2）：投影侧要用的、装配期才知道的两样东西。
   *
   * ## 为什么由会话保管（而不是让投影自己去场景里翻）
   *
   * | 需要的东西 | 为什么投影自己翻不到 |
   * |---|---|
   * | `frameObjects`（帧下标 → 对象 id） | 帧为主文档是 `structure:frame-<i>`、多方块文档是 `structure:multiblock` —— 让投影按 id 约定去猜，就是把**装配的命名约定泄漏给投影层**（`kernelAssembly.ts:475-483` 已就此裁定"装配显式给出，投影只做重建"） |
   * | 多方块**类型化投影面** | 同上；且它含并集调色板/几何资产/帧声明，从载荷重建会造出第二份重建逻辑 |
   *
   * ⇒ 装配处（`composition/documentLoad`）把两样交进来，会话只**保管**。
   *
   * ## ⚠️ `multiblock` 为什么是 `unknown`（刻意的，不是偷懒）
   *
   * 它的类型是 `KernelDeclarationProjection`（在 `composition/kernelProjection.ts`）。
   * 本文件是**内核执行面**（登记在 `runtime/` 的 `activeSubpaths`），
   * 若 import 装配根的类型，方向就反了 —— **内核不该依赖装配根**（装配根依赖各层）。
   * ⇒ 会话只保管**不透明载荷**，唯一消费者（`composition/`）在那一侧做类型收窄。
   * 这是"用 `unknown` 换取依赖方向正确"的**有意**取舍。
   */
  private assemblyFace: KernelAssemblyFace | null = null

  /**
   * 记下装配面（`null` = 未采集，与 `fidelityFieldMap` 同三态口径）。
   *
   * 调用方是 `composition/documentLoad#adoptLoadedDocument`（唯一做装配的地方）。
   */
  setAssemblyFace(face: KernelAssemblyFace | null): void {
    this.assemblyFace =
      face === null
        ? null
        : Object.freeze({
            frameObjects: Object.freeze([...face.frameObjects]),
            multiblock: face.multiblock,
          })
  }

  /** 读装配面（`null` = **未采集**，不是"没有帧"）。 */
  assemblyFaceOf(): KernelAssemblyFace | null {
    return this.assemblyFace
  }

  /**
   * **文档是否已装载**（#301 P10f A′；GF-15 读面）。
   *
   * ## 它回答的问题：区分「空文档」与「无文档」
   *
   * 内核会话在**构造时**就提交 `openDocument`，而 `reduceOpenDocument`
   * **无条件** `createDocument(...)` ⇒ `document()` 从构造起就**恒为 defined**
   * （实测：`document()` 已定义、但 `scene.objects` 长度为 0）。
   *
   * ⇒ `document() !== undefined` **不能**表达"用户打开了一份文档"这件事。
   * 本读面补上那个缺失的事实，于是：
   *
   * | 情形 | `document()` | `hasLoadedDocument()` |
   * |---|---|---|
   * | 刚构造 | defined（空） | **false** |
   * | 文件选择器/内置/SDE/wiki-data/嵌入 打开成功 | defined | **true** |
   * | 打开失败 / 关文档 / 工作区重置 | defined（仍旧或空） | **false** |
   *
   * ## 迁移目标（本批只建立读面，**不**改消费面）
   *
   * 本读面是 `raw-authority-object` 那 29 处 N1 存在性判定在**后续批次**
   * （B′）获得"同义替代"的前提 —— A′ 先让它在 21 处调用点上与 legacy
   * legacy 侧的"有没有文档"（`main.doc.value !== null`）**逐点对齐**
   *（判据见 `p10f-documentLifecycle.test.ts`）。⚠️ 该事实曾在生产里经
   * `getDoc()` 读取，而**该访问器已终删**（#301 P10f D3）。
   *
   * ## 为什么**不**复用 `closeDocument`
   *
   * `reduceCloseDocument` 会一并删除绑定该文档的 `contexts`/`leases`/`saveLedgers`
   * —— 而 `miscOperators.ts:206` 卸载后**紧跟** `:208` 的 `seekFrame(0)`（走
   * `contextAndDoc`），复用会让那次帧归零**静默失效**。故"未装载"由本字段表达，
   * 内核文档 datablock 保持存在（它承载 `EditContext` 的宿主关系）。
   */
  hasLoadedDocument(): boolean {
    return this.adoptedDocumentId === this.documentId
  }

  /**
   * 标记"文档已装载"（#301 P10f A′）。
   *
   * ## 它**不**声称"内核内容与 legacy 同步"（措辞刻意收窄）
   *
   * 本读面是**存在性**事实，不是**内容时效**事实。两者的区别有实测依据：
   * `adoptLoadedDocument` 对"内核装配不支持的形态"会**如实降级并返回 false**
   * （旧路径照常渲染）—— 那种情况下 legacy `doc.value` 非 null，故"已装载"
   * 仍应为 `true`（对齐口径），而内核承载的内容**可能**是空的或上一次的。
   *
   * ⇒ 「内容是否同步」是另一件事，归后续批次（C′）用内容身份判据回答；
   * 本批的判据只比对存在性，并在测试里**显式声明不断言内容一致性**。
   *
   * 调用方是 `Context.setDocument` / `KernelSession.adoptDocument`。
   */
  markLoaded(): void {
    this.adoptedDocumentId = this.documentId
    // ⚠️ **GF-16 必须一起清掉**（C′1 实测抓出的自身缺陷）：
    //
    // "有了一份文档"**不蕴含**"内核里的就是它"。`setDocument` 正是先置存在性、
    // 再（可能）装配 —— 在装配成功之前，内核承载的是**上一份**文档的内容。
    //
    // 反例（实测）：装载 A（装配成功，GF-16=true）→ `NewScene` 调
    // `setDocument(空文档)`（**不** adopt）⇒ 若 GF-16 仍为 true，
    // 则所有"读内核"的面都返回 **A 的注解/材质/帧轴**（错文档），
    // 而 legacy 已是空文档。那正是"读到上一份文档"的静默错误。
    //
    // 清掉之后：装配失败/未装配 ⇒ GF-16=false ⇒ 帧声明回落 legacy（D8 修复生效），
    // 侧表读面返回空表（诚实：内核侧确实没有当前文档的内容）。
    //
    // 顺序：`adoptDocument` 先调本方法、再调 `markContentAdopted()` ⇒ 装配成功时
    // 最终为 true。两行的**先后是语义的一部分**（反过来会被本行清掉）。
        this.contentAdopted = false
  }

  /**
   * **内核是否承载"装配成功"的内容**（#301 P10f C′1；**GF-16** 读面）。
   *
   * ## 它与 `hasLoadedDocument()`（GF-15）的区别 —— 两个**不同**的事实
   *
   * | 读面 | 回答的问题 | 由谁置位 |
   * |---|---|---|
   * | `hasLoadedDocument()`（GF-15） | "用户**有**一份文档吗"（存在性） | `Context.setDocument`（写 legacy 时镜像） |
   * | `hasAdoptedContent()`（GF-16） | "内核承载的**就是**这份文档的装配产物吗"（装配成功） | `adoptDocument`（**仅**装配成功时） |
   *
   * 两者**不等价**，而 D8 正是它们之间的那段缝：
   *
   * ```
   * ctx.setDocument(doc)            → GF-15 = true   （存在性：有文档）
   * adoptLoadedDocument(...)        → 可能**失败**（形态不被支持）
   *   成功 ⇒ adoptDocument ⇒ GF-16 = true
   *   失败 ⇒ 什么都不做   ⇒ GF-16 = **false**，但 GF-15 仍是 true
   * ```
   *
   * ⇒ 装配失败时内核文档是**构造期的空文档**（或上一次的陈旧文档），
   * 而 `hasLoadedDocument()` 无法区分 —— 这就是 GF-16 存在的理由。
   *
   * ## D8：那个缺口为什么表现为"帧数 0"
   *
   * `composition/useKernelFrameLoop` 的帧源原本这样守卫：
   *
   * ```ts
   * const kdoc = kernel.document()
   * if (kdoc !== undefined) return axisFrameCount(kdoc.content.frameAxis)   // ← 恒走这里
   * return ctx.getDoc()...                                                  // ← 永不执行
   * ```
   *
   * 它测的是**文档存在**（恒真），**不是装配成功** ⇒ 装配失败时返回**空帧轴（0）**，
   * 而注释声称"装配未覆盖时回落 legacy（能力不回退）"—— **那处回落从未生效**。
   *
   * ⇒ 本读面是那处回落的**正确守卫**（见 `useKernelFrameLoop` 的 D8 修复）。
   *
   * ## 为什么不用 `hasLoadedDocument()` 兼任
   *
   * 兼任会让"装配失败"与"未装载"重新混为一谈，而那正是 D8 的成因。
   * 与 `domain/cellContent` 判据 3「字段缺席 ≠ 空值」同一口径：
   * 两个事实就该有两个读面。
   */
  hasAdoptedContent(): boolean {
    return this.contentAdopted
  }

  /**
   * 标记"内核已承载装配产物"（**仅**由 {@link adoptDocument} 调用）。
   *
   * ⚠️ 刻意**不**被 `markLoaded` 调用：`markLoaded` 表达存在性，
   * 而本标记表达"装配真的成功"。让前者顺带置后者，D8 会原样复发。
   */
  private markContentAdopted(): void {
    this.contentAdopted = true
  }

  /**
   * 标记"未装载"（#301 P10f A′）：文档被置空 / 打开失败 / 工作区重置。
   *
   * **不**关闭内核文档 datablock（理由见 {@link hasLoadedDocument}）。
   */
  markUnloaded(): void {
    this.adoptedDocumentId = null
    // GF-16 必须**一起**清掉：卸载后"内核里的就是那份文档"不再成立
    // （内核 datablock 仍在，但它承载的是上一次的产物）。
    this.contentAdopted = false
    // D1：源文件未知字段回到**未采集**（`null`，不是 `{}`）——
    // 卸载后"这份会话里没有别的文档的保真字段"必须成立，否则
    // 下一次保存会把**上一份文档**的未知字段写进**新**产物（串档）。
    this.fidelityFieldMap = null
    // G5：无损装配源根同理 —— 卸载后"这份会话里没有别的文档的源根"必须成立，
    // 否则换文档后渲染链会拿**上一份文档**的根级元数据（串档）。
    this.assemblySourceRoot = null
    // G3：多方块内层 body 同理 —— 卸载后"这份会话里没有别的文档的声明/骨架"必须成立，
    // 否则换文档后通道再装配会用**上一份文档**的声明与骨架阶求值（串档）。
    this.multiblockBody = null
    // D2：装配面同理（否则换文档后投影会拿旧帧对象映射去重建新文档 = 串档）。
    this.assemblyFace = null
  }

  /** 重建上下文订阅（`adoptDocument` 换了 Editor 实例，故订阅必须重建）。 */
  private subscribeContext(): void {
    const query: QuerySpec = { kind: 'context', contextId: this.contextId }
    this.disposeObserver = this.editor.observe(query, (value: unknown) => {
      const v = value as {
        time?: TimeValue
        playing?: boolean
        rate?: number
        channelValues?: Readonly<Record<string, number>>
      } | null
      if (v === null) return
      this.playbackSnapshot = Object.freeze({
        playing: v.playing === true,
        rate: typeof v.rate === 'number' ? v.rate : 1,
        time: v.time ?? TIME_ZERO,
      })
      // 同一次投递里取通道取值：`context` 规格的值**本就包含**它
      // （`runtime/execution.ts` 的 `case 'context'`），故不新增订阅。
      this.channelSnapshot =
        v.channelValues !== undefined && v.channelValues !== null
          ? Object.freeze({ ...v.channelValues })
          : EMPTY_CHANNEL_VALUES
    })
  }

  /**
   * 会话当前持有的**内核文档**（供装配层/诊断读；`undefined` = 文档已关闭）。
   *
   * 返回内核值本身（不可变），不是投影 —— 于是"渲染/保存读的是内核"
   * 可以被直接断言（而不必绕道旧文档再反推）。
   */
  document(): Document | undefined {
    return this.editor.snapshot().docs[this.documentId]
  }

  /**
   * **文档摘要**（R1-β① C2；撤销读面的权威来源）。
   *
   * ## 为什么不新增一份"撤销状态"
   *
   * 撤销可用性与标签**已经是**文档历史的一个投影：权威在
   * `Document#history.past/future`（`application/queries#queryDocument` 与
   * `runtime/execution` 的 `case 'document'` 两处**逐字同口径**：
   * `past.length > 0` / `future.length > 0`，标签取栈顶元素的 `label`）。
   *
   * ⇒ 本方法是那条口径在**会话层**的取用点，而不是第三种"撤销状态"。
   * 若这里再记一份（例如缓存 `canUndo`），就会出现"两份撤销事实"并必然漂移
   * —— 本项目三度实测过的形态。
   *
   * ## 为什么复用 `queryDocument` 而不是自己读 `doc.history`
   *
   * 直接读 `doc.history` 会让"什么算可撤销"在会话层有一份**实现**，
   * 而它在外面的 `queries.ts`/`execution.ts` 已有两份。复用它 ⇒ 三处同源。
   *
   * @returns `null` = 文档未打开（调用方据此**不**把旧栈当权威）
   */
  documentSummary(): DocumentSummary | null {
    const result = queryDocument(this.editor.snapshot(), this.documentId)
    return result.ok ? result.value : null
  }

  // ── 生产保存的**内核侧**结算（M8-2：D1 收口；B1 的唯一推进者）──────────────

  /**
   * 发起一次**生产保存请求**：捕获 S0（在途序号 + 绑定代数 + 内容身份）。
   *
   * ## 为什么是"走既有命令"而不是在这里另写一套判断
   *
   * 保存的三条语义判据（在途序号、绑定代数、只有 `committed` 才推进基线）
   * 已经**只有一份实现**：`application/commands#reduceSave` / `#reduceSaveCompleted`
   * → `domain/document#beginSave` / `#completeSave`。
   * 本方法只是把那条命令面暴露给宿主（生产保存算子），因此：
   *  - 串行化（在途 ⇒ 返回 `null`）与 `reduceSave` 的拒绝判据同源；
   *  - 基线推进取**该请求捕获的 `capturedVersion`**（不是"当前版本"）——
   *    保存期间的新编辑仍脏（SPEC §9:293 / `commands.ts:2336`）。
   *
   * ## 为什么不直接用 `SaveCoordinator`（`adapters/saveTarget`）
   *
   * 那个协调器自带**一份独立 `SaveLedger`**（构造参数 `ledger`）并要求
   * `SaveTargetPort`（条件版本写入 + 序列化端口）。三条生产保存路径的目标分别是
   * 浏览器下载（无远端修订）与 MediaWiki 编辑（冲突由 `mw.Api` 的
   * `editconflict` 回答，见 `wikiDataWikiApiAdapter`），没有一条需要"本实例的
   * 第二本账"。用它 = 在 `ApplicationState.saveLedgers` 之外再造一份"什么算保存成功"，
   * 正是本包要消灭的双写。⇒ **不接**；reduce 路径自足（见 `completeSaveRequest`）。
   *
   * @returns `null` = 无会话 / 未装配 / **已有在途保存**（串行化；调用方如实失败）
   */
  beginSaveRequest(): KernelSaveRequest | null {
    if (!this.hasAdoptedContent()) return null
    const before = this.editor.snapshot()
    // 没有台账 = 该文档从未发起过保存（`ledgerOf` 同样按缺省台账处理）⇒ 直接发命令
    const ledger = before.saveLedgers[this.documentId]
    if (ledger !== undefined && ledger.inFlight !== null) return null
    this.editor.submit({ kind: 'save', contextId: this.contextId })
    this.editor.drain()
    const started = this.editor.snapshot().saveLedgers[this.documentId]
    if (started === undefined || started.inFlight === null) return null
    const request = started.inFlight
    return Object.freeze({
      sequence: request.sequence,
      bindingGeneration: request.bindingGeneration,
      capturedVersion: request.capturedVersion,
    })
  }

  /**
   * 结算一次生产保存请求（成功/失败/过期都由 `completeSave` 判定）。
   *
   * @returns 是否**真的推进了基线**（`savedSequence` 变成该请求序号）
   */
  completeSaveRequest(request: KernelSaveRequest, outcome: KernelSaveOutcome): boolean {
    const ledger = this.editor.snapshot().saveLedgers[this.documentId]
    if (ledger === undefined || ledger.inFlight === null || ledger.inFlight.sequence !== request.sequence) {
      // 不是**在途**的那一次（迟到/重复/已被 rebind 丢弃）⇒ 不提交命令，也不改基线
      return false
    }
    const command: SaveCompletedCommand = {
      kind: 'saveCompleted',
      documentId: this.documentId,
      sequence: request.sequence,
      bindingGeneration: request.bindingGeneration,
      outcome: outcome.kind === 'committed' ? COMMITTED : Object.freeze({ kind: 'failed' as const, code: outcome.code }),
    }
    this.editor.submit(command)
    this.editor.drain()
    return this.document()?.savedSequence === request.sequence
  }

  /**
   * **对象写权读面**（R1-β① C6 收口）。
   *
   * ## 为什么它必须经过会话，而不是让外壳直接 import 领域函数
   *
   * 判定本身是纯领域事实（`domain/multiblock#generatedObjectWriteAuthority`：
   * `data.source === 'content'` ⇒ 生成内容 ⇒ 只读），与
   * `application/kernel-properties.ts` 的 `generated: data?.source === 'content'` 同源。
   *
   * 但 `runtime/context.ts` 是**旧层**文件（`kernel-legacy-isolation` 的判定面）——
   * 它直接 import `@/domain/multiblock` 会新增一条**未登记的旧→新依赖**，
   * 闸门正确判红（实测：`src/runtime/context.ts:66 → @/domain/multiblock`）。
   *
   * ⇒ 会话属新层：**由它向领域取值、外壳只转发**，依赖方向才是单向的。
   *
   * @returns `'missing'` = 未装配 / 未采纳内容 / 无该对象（如实降级，**不**猜 `writable`）
   */
  writeAuthorityOf(objectId: string): 'writable' | 'readOnly' | 'missing' {
    if (!this.hasAdoptedContent()) return 'missing'
    const doc = this.document()
    if (doc === undefined) return 'missing'
    return generatedObjectWriteAuthority(doc.scene, objectId)
  }

  // ── 读面 ─────────────────────────────────────────────────────────────────

  /** 捕获一个一致版本的只读视图（契约 §2.2）。 */
  read(): ReadView {
    return this.editor.read({ documentId: this.documentId, contextId: this.contextId })
  }

  /** 当前播放快照（由内核投递，**不**每次重建）。 */
  playback(): KernelPlayback {
    return this.playbackSnapshot
  }

  /**
   * 当前世界帧下标 —— **派生值**，不是独立状态。
   *
   * ## 为什么派生（旧 `Main.currentFrameIndex` 是一个可被任意写的 Ref）
   *
   * 旧形态下帧下标是**独立权威**：它由 `OPERATOR_SET_FRAME_INDEX` 直接写，
   * 与时间无关。于是"播放到第 5 帧"与"时间是第几帧"可以互相矛盾 ——
   * 而两者本该是同一件事（帧下标 = 时间落在帧时长轴的哪一段）。
   *
   * 现在唯一权威是 `EditContext.time`；帧下标由它经**离散阶跃采样**
   * （`domain/materials#sampleStripFrameAt`，与 `domain/animation#sampleTrack`
   * 的 `step` 策略同一语义）算出。于是：
   *  - 拖动定位与连续播放必然一致（同一条求值路径，#249 §7）；
   *  - 两个 Area 读到**同一个**帧下标（时间属共享 `EditContext`，A05）；
   *  - "跳帧"就是 `setTime`，不需要第二条写通路。
   *
   * ## 时长轴
   *
   * 每帧占 `durationMs`（缺省 50ms = 1 MC tick，与旧
   * `DEFAULT_WORLD_FRAME_DWELL_MS` 同一常量口径）。因此"帧停留多久"仍是
   * 文档声明的事实，只是现在它**参与时间→帧的映射**，而不是驱动一个定时器。
   */
  frameIndex(): number {
    const n = this.frameSource.count()
    if (n <= 0) return 0
    const timeline = this.timeline()
    if (timeline.frameIndices.length === 0) return 0
    return sampleStripFrameAt(timeline, this.axisMsOf(this.playbackSnapshot.time))
  }

  /**
   * 时间值 → **帧轴毫秒**（帧轴唯一的"时间 → 毫秒"换算点）。
   *
   * ## 为什么需要显式 epsilon 归整（实测缺陷，不是洁癖）
   *
   * 定位链是"毫秒 → 秒 → `time.frame` →（`frameIndex`）→ 秒 → 毫秒"的**往返**换算，
   * 浮点末位误差让本该**恰好落在帧起点**的时刻变成 `431 − 1e-13` 一类值；而
   * `domain/materials#sampleStripFrameAt` 内部用 `Math.floor` ⇒ 差 1e-13 就丢一整帧。
   *
   * 实测（`multiblock-ebf-2ch`，432 帧、每帧 1ms）：`seekFrame(431)` 的帧读面是 **430**
   * —— 末帧永远定位不到；`seekFrame(1)/seekFrame(216)` 等中间帧恰好没有误差，故问题
   * 只在特定帧上显形（这正是"重放/跳帧不一致"这类缺陷难被抓的原因）。
   *
   * ## 处置：对**换算**做显式归整，而不是对**结果**做钳制
   *
   * 归整到 1e-6 ms：远大于该往返的浮点误差（~1e-13），又远小于任何有意义的帧时长
   * ⇒ 真正的亚毫秒时刻（如 430.4ms）仍落在它该在的帧里，**不改变**帧轴语义。
   * 刻意**不**用"钳到 `n-1`"：那会把"定位到末帧"换成"定位到另一个错帧"，把缺陷藏起来。
   */
  private axisMsOf(time: TimeValue): number {
    const fps = framesPerSecond(time.fps)
    if (fps <= 0) return 0
    const frame = Number.isFinite(time.frame) ? time.frame : 0
    const ms = (frame / fps) * 1000
    return Math.round(ms * 1e6) / 1e6
  }

  /** 帧总数（转发帧声明；供呈现判断"是否多帧"）。 */
  frameCount(): number {
    return Math.max(0, this.frameSource.count())
  }

  /** 帧时长轴（毫秒整数；每项 `> 0`）。 */
  private timeline(): StripTimeline {
    const n = this.frameSource.count()
    if (n <= 0) return stripTimeline([], [])
    const durations = this.frameSource.durationsMs()
    const indices: number[] = []
    const durs: number[] = []
    for (let i = 0; i < n; i++) {
      indices.push(i)
      durs.push(durations[i] ?? 0)
    }
    return stripTimeline(indices, durs)
  }

  // ── 写面（全部经唯一写通路） ──────────────────────────────────────────────

  /** 提交一条命令（**接收不等于已生效**；契约 §1.5）。 */
  submit(command: Command, source: InputSource = 'command'): CommandTicket {
    return this.editor.submit(command, source)
  }

  /** 推进到队列排空（有界）。 */
  drain(): void {
    this.editor.drain()
  }

  /**
   * 查一张票据的结算结果（`null` = 尚未结算）。
   *
   * 契约 §1.5：「接收**不等于**已生效」⇒ 提交方需要一个显式通路去问"它到底怎么了"。
   * 缺它时调用方只能靠副作用猜测（例如"对象数变没变"）—— 那是把**拒绝**与
   * **未结算**混为一谈，而两者对调用方的动作完全不同（前者该报错，后者该等）。
   *
   * 转发 `Editor.settlement`（唯一权威）；会话层不自己记票据，故不存在第二份结算状态。
   */
  settlementOf(ticket: CommandTicket): CommandOutcome | null {
    return this.editor.settlement(ticket)
  }

  /**
   * **宿主按帧注入时间输入并驱动批次**（R-WK-03 的"按帧注入时间输入"）。
   *
   * 一次调用做两件事，顺序不可颠倒：
   *  1. 提交 `advancePlayback(deltaSeconds)` —— 时间推进是**输入**，不是副作用；
   *  2. `drain()` 把队列（含本帧由事件产生的其它命令）在一个有界批次里结算。
   *
   * 暂停时 `advancePlayback` 判 `unchanged`（`advancePlayback` 返回原引用），
   * 故"没在播放时宿主仍每帧调用"是**无副作用**的 ——
   * 宿主因此不必自己判断要不要发（那个判断会变成第二份播放状态判据）。
   */
  frame(deltaSeconds: number): void {
    this.editor.submit({ kind: 'advancePlayback', contextId: this.contextId, deltaSeconds }, 'timer')
    this.editor.drain()
  }

  /** 开始/停止播放（**不碰时间**；#249 §3.3「停止播放保留当前时间」）。 */
  setPlaying(playing: boolean): void {
    this.editor.submit({ kind: 'setPlaying', contextId: this.contextId, playing })
    this.editor.drain()
  }

  /** 设置常量播放倍率。 */
  setPlaybackRate(rate: number): void {
    this.editor.submit({ kind: 'setPlaybackRate', contextId: this.contextId, rate })
    this.editor.drain()
  }

  /** 定位时间（拖动/跳帧/倒退）。**不**改播放开关。 */
  seekTime(time: TimeValue): void {
    this.editor.submit({ kind: 'setTime', contextId: this.contextId, time })
    this.editor.drain()
  }

  /** 定位到帧下标（按帧时长轴换算成时间，再走 `setTime`）。 */
  seekFrame(index: number): void {
    const n = this.frameSource.count()
    if (n <= 0) return
    const fps = framesPerSecond(this.playbackSnapshot.time.fps)
    const timeline = this.timeline()
    const target = ((Math.floor(index) % n) + n) % n
    let ms = 0
    for (let i = 0; i < target; i++) ms += timeline.durationMs[i] ?? 0
    const seconds = ms / 1000
    this.seekTime({ frame: seconds * fps, fps: this.playbackSnapshot.time.fps })
  }

  /** 释放订阅（外壳卸载时调用；**不**释放内核状态 —— 状态是值，由 GC 处理）。 */
  dispose(): void {
    this.disposeObserver()
  }

  // ── 通道取值（#282 P10b：退役每视口暂存副本；M5-1：场景 ≠ 时间轴） ──────────

  /**
   * **当前通道取值**（共享 `EditContext.channelValues` 的读面投影）。
   *
   * ## 为什么它在会话上（而不是每个视口自持）
   *
   * #249 §3.3/§3.4：通道取值属**编辑上下文**，故"同一上下文的所有 Area 读到同一份值"
   * （A05「两视口有效坐标相同」的通道面）。旧形态是
   * `shared/viewport/useMultiblockChannels.ts` 的**每视口暂存副本** —— 每个视口自持
   * `{totalTier, values, runstate}` + `revision`，于是"同上下文可见的有效读面"并不存在
   * （每个视口只能读到自己那份）。这正是 B5 #4 `per-viewport-staging` 要退役的形态。
   *
   * ## 为什么不新增状态
   *
   * 由内核**投递**（与 `playback()` 同一手法）：`context` 观察规格的投递值本就包含
   * `channelValues`，故 `subscribeContext` 顺手记一份快照，本方法只读它。
   * 于是"两个 Area 读到同一份值"是结构事实（同一个会话的同一份快照），
   * 而不是靠调用方自觉。
   *
   * ## M5-1（2026-10-18 用户裁决）：多方块的「场景清单」**不合成时间轨道**
   *
   * 多方块文档的帧清单是**变体配置集合（场景，Scene）**，不是时间轴上的帧：
   * 它与 `EditContext.time` 无关，也**永不参与播放**。故本读面**只**投影手动预览层
   * —— 不存在"帧清单 → 阶跃轨道"的合成层，手动写入的值就是有效值
   * （SPEC §3.7:109「普通基础值写入不能静默成功却不可见」）。
   *
   * 播放/动画仍走**通用关键帧 + 插值**系统（`domain/animation`）；多方块场景切换
   * 由取值驱动、不是动画。旧的 `channelStepTrack`/`sizeChannelStepKeys` 消费链
   * （把 `frame.stepIndex` 折成时间轴关键帧）已同批退出生产 —— 它把"变体配置"
   * 误读成"时间轴"，正是断点①的本体。
   *
   * 取值缺失的通道不在结果里（不伪造 0）：调用方按"未设置"处理。
   */
  channelValues(): Readonly<Record<string, number>> {
    return this.channelSnapshot
  }

  /**
   * 设置一个通道的取值（经**唯一写通路**；`setChannelValue` 命令）。
   *
   * 与 `setPlaying`/`seekTime` 同一形态：提交 + 有界排空（接收 ≠ 已生效，见
   * {@link settlementOf}）。取值合法性（夹取/回落）由内核的 `reduceSetChannelValue`
   * 决定，本层**不**自己判 —— 否则就是第二份政策。
   *
   * ## 与时间的关系：**没有**时间驱动层
   *
   * 本方法写的是**手动预览层**（`EditContext.channelValues`），而
   * {@link KernelSession.channelValues} **逐字**把它读回 —— 多方块场景清单不合成
   * 时间轨道（M5-1），故不存在"写入成功却被轨道压住"的读面。播放推进只改
   * `EditContext.time`，不碰本方法的写入 ⇒ "手动值即有效值"是结构性质。
   *
   * 动画（若将来要驱动通道）走通用关键帧系统；那属于**文档内容**，会以显式关键帧
   * 编辑进入，绝不是"按场景清单自动合成一条轨道"。
   */
  setChannelValue(channel: string, value: number): void {
    this.editor.submit({ kind: 'setChannelValue', contextId: this.contextId, channel, value })
    this.editor.drain()
  }

  /**
   * 设置多方块总档位（`totalTier`）。
   *
   * ## 为什么它也是一个"通道取值"
   *
   * 旧暂存把 `totalTier` 与逐通道 `values` 分开存（`MultiblockSelectionState`），
   * 但两者在内核里是**同一种东西**：`EditContext.channelValues` 的一个键值对。
   * 总档位用保留键 {@link TOTAL_TIER_CHANNEL} 表达 —— 于是它天然满足
   * "所有 Area 共享"与"参与撤销/内容身份"，不需要第二条写通路或第二个存储。
   */
  setTotalTier(tier: number): void {
    this.setChannelValue(TOTAL_TIER_CHANNEL, tier)
  }

  /** 当前总档位（未设置时为 `null`，**不**伪造 1）。 */
  totalTier(): number | null {
    const v = this.channelValues()[TOTAL_TIER_CHANNEL]
    return typeof v === 'number' ? v : null
  }

  /**
   * 设置运行态（多方块 `runstate`）。
   *
   * 与总档位同理：运行态是**离散取值**，用保留键 {@link RUNSTATE_CHANNEL} 承载
   * （值取 `runstate` 在声明里的**下标** —— `channelValues` 的类型是
   * `Record<string, number>`，这是它唯一能表达离散选择的形态）。
   *
   * ## 为什么用下标而不是 id 字符串
   *
   * `channelValues` 的值类型是 `number`（契约如此：通道取值是连续/离散的数值域）。
   * 把 id 塞进去需要改契约的读面类型 —— 那是**扩契约**，须按 §8 回 #250。
   * 用下标是当前契约下**唯一**不伪造的表达，且声明顺序稳定（`decl.runstates` 是数组）。
   * 已登记为 GF-10（见 #282 汇报）。
   */
  setRunstateIndex(index: number): void {
    this.setChannelValue(RUNSTATE_CHANNEL, index)
  }

  /** 当前运行态下标（未设置时为 `null`）。 */
  runstateIndex(): number | null {
    const v = this.channelValues()[RUNSTATE_CHANNEL]
    return typeof v === 'number' ? v : null
  }
}

/** 构造一个会话（便利函数；装配层用）。 */
export function createKernelSession(opts: KernelSessionOptions): KernelSession {
  return new KernelSession(opts)
}
