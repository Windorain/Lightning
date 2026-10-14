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
import { defaultExecutionInputs } from '@/application/commands'
import type { ApplicationState } from '@/application/state'
import type { Document } from '@/domain/document'
import type { ExecutionInputs } from '@/application/commands'
import type { ObjectTypeDecl } from '@/application/properties'
import type { ObjectFactoryTable } from '@/domain/scene'
import { sampleStripFrameAt, stripTimeline, totalDurationMs, type StripTimeline } from '@/domain/materials'
import { frameDurationsMs, frameCount as axisFrameCount, type DocumentContent } from '@/domain/content'
import { framesPerSecond, timeFromSeconds, type AnimationTrack, type TimeValue } from '@/domain/animation'
import { TIME_ZERO } from '@/domain/editing'
import {
  channelSetOfDeclaration,
  channelStepTrack,
  generatedObjectWriteAuthority,
  resolveChannelEffective,
  sizeChannelStepKeys,
  type ChannelSet,
  type DeclaredChannelLike,
} from '@/domain/multiblock'

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

/**
 * 多方块**总档位**在 `EditContext.channelValues` 里的保留键（#282 P10b）。
 *
 * ## 为什么总档位也用"通道"承载
 *
 * 旧暂存（`shared/viewport/useMultiblockChannels.ts`）把 `totalTier` 与逐通道
 * `values` 分成两个字段存，但两者在内核里是**同一种东西**：一个数值域取值。
 * 用保留键承载后，总档位天然获得"所有 Area 共享"（#249 §3.3）与
 * "参与撤销/内容身份"（`EditContext` 是值），不需要第二个存储或第二条写通路。
 *
 * ## 为什么键名带 `$` 前缀
 *
 * 真实通道名来自多方块声明（`decl.channels[].key`），可能撞上任何普通标识符。
 * `$` 不是合法的声明通道名，故前缀使保留键与真实通道**不可能冲突**（结构性，
 * 不靠约定）。这是"两个不同事实必须可区分"（#249 §19.3）在键空间上的应用。
 */
export const TOTAL_TIER_CHANNEL = '$totalTier'

/**
 * 多方块**运行态**在 `EditContext.channelValues` 里的保留键（#282 P10b）。
 *
 * 值是运行态在声明里的**下标**（`channelValues` 的值类型是 `number`，
 * 契约 §5 如此规定）—— 故离散选择以序数表达，而非把 id 字符串塞进数值域。
 * 该口径差异已登记为 GF-10（#282），不在本层私自扩契约类型。
 */
export const RUNSTATE_CHANNEL = '$runstate'

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

/**
 * 离散通道时间入口的**声明读面**（两个载体归一后的同一形状）。
 *
 * 只有这一条形状参与时间入口：键/名/值域（通道）+ `stepIndex`（帧）+ 尺寸型通道键
 * （骨架）。它刻意**不含**装配面里与本入口无关的东西（调色板/几何资产/声明原文），
 * 于是"时间入口读了声明的哪些字段"在类型上可见（与 `DeclaredChannelLike` 同一手法）。
 */
interface ChannelTimeDeclaration {
  readonly id: string
  readonly channels: readonly DeclaredChannelLike[]
  readonly frames: readonly { readonly stepIndex: number }[]
  readonly sizeChannel: string | null
}

/** `content.multiblock` → 时间入口读面；无通道/无帧/无尺寸型通道 ⇒ `null`（如实无入口）。 */
function channelDeclOfContent(content: DocumentContent): ChannelTimeDeclaration | null {
  const decl = content.multiblock
  if (decl.channels.length === 0 || decl.frames.length === 0) return null
  return Object.freeze({
    id: decl.id,
    channels: Object.freeze(
      decl.channels.map((c) => Object.freeze({ key: c.key, name: c.name, kind: c.kind, min: c.min, max: c.max })),
    ),
    frames: Object.freeze(decl.frames.map((f) => Object.freeze({ stepIndex: f.stepIndex }))),
    sizeChannel: decl.backbone.sizeChannel === '' ? null : decl.backbone.sizeChannel,
  })
}

/**
 * `assemblyFace.multiblock`（**不透明 `unknown`**）→ 时间入口读面。
 *
 * 形状是 `composition/kernelProjection#KernelDeclarationProjection`
 * （`{declaration:{channels,backbone}, frames:[{stepIndex}]}`）。本函数**不** import 那个
 * 类型（会话是内核执行面，依赖方向不得反向）⇒ 逐项 `typeof` 收窄：
 * 任一必需字段缺失/类型不符 ⇒ 整份返回 `null`（宁可没有时间入口，也不拿半个声明造取值）。
 */
function channelDeclOfFace(face: unknown): ChannelTimeDeclaration | null {
  if (typeof face !== 'object' || face === null) return null
  const rec = face as { readonly declaration?: unknown; readonly frames?: unknown; readonly id?: unknown }
  const decl = rec.declaration
  if (typeof decl !== 'object' || decl === null) return null
  const declRec = decl as { readonly channels?: unknown; readonly backbone?: unknown }
  const rawChannels = declRec.channels
  const rawFrames = rec.frames
  if (!Array.isArray(rawChannels) || !Array.isArray(rawFrames)) return null
  const channels: DeclaredChannelLike[] = []
  for (const c of rawChannels) {
    if (typeof c !== 'object' || c === null) return null
    const r = c as { key?: unknown; name?: unknown; kind?: unknown; min?: unknown; max?: unknown }
    if (
      typeof r.key !== 'string' ||
      typeof r.min !== 'number' ||
      typeof r.max !== 'number' ||
      typeof r.kind !== 'string'
    ) {
      return null
    }
    channels.push(
      Object.freeze({ key: r.key, name: typeof r.name === 'string' ? r.name : r.key, kind: r.kind, min: r.min, max: r.max }),
    )
  }
  const frames: { stepIndex: number }[] = []
  for (const f of rawFrames) {
    if (typeof f !== 'object' || f === null) return null
    const r = f as { stepIndex?: unknown }
    if (typeof r.stepIndex !== 'number') return null
    frames.push(Object.freeze({ stepIndex: r.stepIndex }))
  }
  const bb = declRec.backbone
  const sizeChannel =
    typeof bb === 'object' && bb !== null && typeof (bb as { sizeChannel?: unknown }).sizeChannel === 'string'
      ? ((bb as { sizeChannel: string }).sizeChannel === '' ? null : (bb as { sizeChannel: string }).sizeChannel)
      : null
  if (channels.length === 0 || frames.length === 0) return null
  return Object.freeze({ id: typeof rec.id === 'string' ? rec.id : 'multiblock', channels: Object.freeze(channels), frames: Object.freeze(frames), sizeChannel })
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
   * 最近一次内核投递的**通道取值快照**（#282 P10b）。
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

  /**
   * **离散通道的时间入口来源**（采纳声明时置位；卸载清空）。
   *
   * ## 它解决什么（A09 的"离散通道在给定时间求值"）
   *
   * 在它之前，通道取值只有**手动层**（`setChannelValue` 写 `EditContext.channelValues`），
   * 于是播放/跳帧**不改**通道取值，而 `domain/multiblock#channelStepTrack` /
   * `#resolveChannelEffective` 是**零生产消费者**（#388 INV-1 实测）。
   *
   * 声明的**帧清单**本身就是"时间 → 离散取值"的声明：契约 §5.4 明文
   * 「尺寸型由 `frame.stepIndex` 完成」，且解析器判据
   * `sizeSteps.length === 通道 max − min + 1`（`context/parsers/multiblockDocument.ts:739`）
   * ⇒ `取值 = min + stepIndex` 是**双射**（落地在
   * `domain/multiblock#sizeChannelStepKeys`），不需要猜。
   *
   * ## ⚠️ 载体有两个：**内核内容的声明** 与 **装配面的投影**（优先级只有一处）
   *
   * 实测（`npm run` 探针 + 本批判据）：当前生产链 `assembleKernelDocument`
   * 组装的 `DocumentContent` **没有** `multiblock` 键（`composition/kernelAssembly.ts:1739-1743`
   * 只给 `metadata`/`frameAxis`/`resources`）⇒ `content.multiblock` 恒为
   * `EMPTY_MULTIBLOCK_DECLARATION`；声明的**生产载体**是装配面
   * （`documentLoad.ts:269-272` 的 `multiblockProjectionFaceOf`，含 `declaration.channels`
   * 与逐帧 `stepIndex`）。
   *
   * 故 {@link KernelSession.rebindChannelTimeSource} 是**唯一**的载体选择点：
   * 内核内容声明优先（它是文档自己的声明 = 本会话的权威），缺省用装配面投影
   * （生产今天的唯一载体）。两者同时在场时是**同一份声明**（装配面就是它的投影），
   * 故优先级不是语义决定；`content.multiblock` 一旦由装配补齐，本条自动走前者。
   * 任何一个可用的声明都能独立驱动时间入口 —— **不做合并**（合并会造出第三份声明）。
   */
  private channelSet: ChannelSet | null = null

  /** 声明帧清单里每帧的 `stepIndex`（与 `this.timeline().frameIndices` 同序）。 */
  private channelFrameSteps: readonly number[] = Object.freeze([])

  /** 骨架的尺寸型通道键（`backbone.sizeChannel`；`null` = 无可查通道）。 */
  private channelSizeKey: string | null = null

  /** 内核内容侧声明的**可用读面**（`content.multiblock`；无通道/无帧 ⇒ `null`）。 */
  private channelDeclFromContent: ChannelTimeDeclaration | null = null

  /** 装配面侧声明的**可用读面**（`assemblyFace.multiblock.declaration`；同上 ⇒ `null`）。 */
  private channelDeclFromFace: ChannelTimeDeclaration | null = null

  /**
   * 通道阶跃轨道缓存（按通道键）。
   *
   * 轨道是**纯值**（`(set, key, keys)` 决定），故缓存不引入状态分歧；它只为避免
   * 每帧重算同一份关键帧（`channelValues()` 会被视口在每次投递时读）。
   * 载体变化（采纳声明 / 置装配面）/卸载时整体清空 ⇒ 不串档。
   */
  private channelTrackCache = new Map<string, AnimationTrack>()

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
      // 离散通道的时间入口：帧清单（stepIndex）就是"时间 → 取值"的声明（见 `channelSet`）。
      this.adoptChannelContentDeclaration(content)
    } else {
      // 无内容面 ⇒ 内容侧声明必须清掉：留着它就等于用**上一份文档**的帧清单驱动本份
      // 文档的通道取值（串档）。装配面随后会在 `setAssemblyFace` 里给出新载体。
      this.adoptChannelContentDeclaration(null)
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
    // 离散通道的时间入口：声明的**生产载体**就是本装配面（见 `channelSet` 的载体说明）。
    this.adoptChannelFaceDeclaration(face === null ? null : face.multiblock)
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
    // D2：装配面同理（否则换文档后投影会拿旧帧对象映射去重建新文档 = 串档）。
    this.assemblyFace = null
    // 离散通道的时间入口同理：卸载后"这份会话里没有别的文档的帧清单"必须成立，
    // 否则换文档后播放会用**上一份文档**的 stepIndex 驱动通道取值（串档）。
    this.clearChannelTimeSource()
  }

  /**
   * 记下**离散通道的时间入口来源**（`adoptDocument` 采纳内容时置位）。
   *
   * 只有"声明了通道 + 声明了帧"的文档才有时间入口：其余文档（无通道 / 帧为主形态）
   * 的通道取值**逐字保持**旧行为（手动层），故本接线对它们零影响。
   */
  private adoptChannelContentDeclaration(content: DocumentContent | null): void {
    this.channelDeclFromContent = content === null ? null : channelDeclOfContent(content)
    this.rebindChannelTimeSource()
  }

  /**
   * 采纳**装配面投影**里的声明读面（`setAssemblyFace` 调；`null` = 无装配面/非多方块）。
   *
   * 装配面形状是 `unknown`（会话不得 import 装配根的类型，方向会反）⇒ 这里只做
   * **防御性收窄**：数值型判定用 `typeof`，缺一项就整份不采信（宁可没有时间入口，
   * 也不拿半个声明去造取值）。
   */
  private adoptChannelFaceDeclaration(face: unknown): void {
    this.channelDeclFromFace = channelDeclOfFace(face)
    this.rebindChannelTimeSource()
  }

  /**
   * **唯一的载体选择点**：内核内容声明优先，缺省用装配面投影。
   *
   * 两个载体（见 `channelDeclFromContent`/`channelDeclFromFace` 的说明）：
   *  - `content.multiblock`：文档自己的声明（权威；当前生产尚未填，见字段注释）；
   *  - `assemblyFace.multiblock.declaration`：装配期投影（生产今天的唯一载体）。
   *
   * 任一载体只要"有通道 + 有帧 + 有尺寸型通道键"就能独立驱动时间入口；
   * 本方法**不合并**两者（合并会造出第三份声明）。
   */
  private rebindChannelTimeSource(): void {
    const decl = this.channelDeclFromContent ?? this.channelDeclFromFace
    this.channelSet = null
    this.channelFrameSteps = Object.freeze([])
    this.channelSizeKey = null
    this.channelTrackCache = new Map<string, AnimationTrack>()
    if (decl === null) return
    this.channelSet = channelSetOfDeclaration(decl.id, decl.channels)
    this.channelFrameSteps = Object.freeze(decl.frames.map((f) => f.stepIndex))
    this.channelSizeKey = decl.sizeChannel
  }

  /** 清空时间入口来源与轨道缓存（卸载 / 换文档；防串档）。 */
  private clearChannelTimeSource(): void {
    this.channelDeclFromContent = null
    this.channelDeclFromFace = null
    this.rebindChannelTimeSource()
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
    const fps = framesPerSecond(this.playbackSnapshot.time.fps)
    const seconds = fps > 0 ? this.playbackSnapshot.time.frame / fps : 0
    return sampleStripFrameAt(timeline, seconds * 1000)
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

  // ── 通道取值（#282 P10b：退役每视口暂存副本） ──────────────────────────────

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
   * 取值缺失的通道不在结果里（不伪造 0）：调用方按"未设置"处理。
   *
   * ## ⚠️ 它返回的是**有效值**（含时间驱动的轨道层），不是裸手动值
   *
   * #249 §3.3：「动画输出覆盖当前求值参数，**不反写**手动取值」。故本读面按
   * `domain/multiblock#resolveChannelEffective` 解析三层后返回**赢家**：
   * `publishedDefault` → `manualPreview`（`EditContext.channelValues`，仍由
   * {@link KernelSession.setChannelValue} 写） → `trackSample`（帧清单阶跃轨道，
   * 由**播放时间**驱动）。手动值本身**原样保留在 `EditContext` 里**（本节只读），
   * 故"停止播放后手动值仍在、且可继续编辑"是结构性质（不反写）。
   *
   * 「优先级」只有**一个定义点**：`domain/animation#resolveEffectiveValue` 的层表
   * （`LAYER_RANK`）—— 本方法**不**自己比大小、不判"手动还是动画赢"。
   */
  channelValues(): Readonly<Record<string, number>> {
    const base = this.channelSnapshot
    const channelKey = this.channelSizeKey
    if (channelKey === null) return base
    const track = this.channelTrackOf(channelKey)
    if (track === null) return base
    const defaults = this.document()?.animation.publishedDefaults
    const published = defaults === undefined ? undefined : defaults[channelKey]
    const manual = base[channelKey]
    const resolved = resolveChannelEffective({
      ...(typeof published === 'number' ? { publishedDefault: published } : {}),
      ...(typeof manual === 'number' ? { manualPreview: manual } : {}),
      track,
      time: this.channelSampleTime(),
    })
    // 采样失败**不**吞成"0"：如实回落到手动/默认层（读面不制造值）。
    if (!resolved.ok) return base
    const value = resolved.value.value
    if (value === manual) return base
    return Object.freeze({ ...base, [channelKey]: value })
  }

  /**
   * 通道轨道的**采样时间**。
   *
   * 帧条是**循环**的：`domain/materials#sampleStripFrameAt` 内部做
   * `t = ((t % total) + total) % total`（`domain/materials.ts:476-478`）。
   * 通道轨道（通用 `sampleTrack`）在两端是**钳制**而非循环，故这里先把时间折到
   * 一个周期内再交给它 —— 否则播过一圈后会出现"帧下标绕回、通道取值卡在末帧"
   * 的两条轴（A09「同时间同结果」的跨消费者形态）。
   *
   * 周期权威与帧轴**同一处**：`totalDurationMs(this.timeline())`
   * （`sampleStripFrameAt` 内部也用 `totalDurationMs`，见 `domain/materials.ts:473`）。
   */
  private channelSampleTime(): TimeValue {
    const time = this.playbackSnapshot.time
    const fps = framesPerSecond(time.fps)
    if (fps <= 0) return time
    const total = totalDurationMs(this.timeline())
    if (total <= 0) return time
    const ms = (time.frame / fps) * 1000
    return timeFromSeconds((((ms % total) + total) % total) / 1000, time.fps)
  }

  /**
   * **离散通道在帧轴上的阶跃关键帧**（时间 → 取值；纯值，无副作用）。
   *
   * 契约 §5.4：尺寸型通道由 `frame.stepIndex` 完成；取值 = `通道 min + stepIndex`
   * （解析器已保证 `sizeSteps.length === max − min + 1`，故该反演是双射）。
   * 时间轴取自 {@link KernelSession.timeline}（与 `frameIndex()` 同一份），
   * 故"时间 → 帧"与"时间 → 通道取值"在**同一轴**上。
   */
  private channelStepKeysOf(
    channelKey: string,
  ): readonly { readonly time: TimeValue; readonly value: number }[] {
    const set = this.channelSet
    if (set === null || this.channelSizeKey === null || channelKey !== this.channelSizeKey) return Object.freeze([])
    const n = Math.min(this.frameSource.count(), this.channelFrameSteps.length)
    if (n <= 0) return Object.freeze([])
    const timeline = this.timeline()
    if (totalDurationMs(timeline) <= 0) return Object.freeze([])
    // 取值反演与关键帧时刻的算术全在**纯函数**里（唯一构造点）；
    // 本层只负责"哪条轴"（`this.timeline()`）与"哪个通道"（`channelSizeKey`）。
    const built = sizeChannelStepKeys(
      set,
      channelKey,
      this.channelSizeKey,
      this.channelFrameSteps.slice(0, n),
      timeline.durationMs.slice(0, n),
      this.playbackSnapshot.time.fps,
    )
    return built.ok ? built.value : Object.freeze([])
  }

  /**
   * 通道的**阶跃轨道**（经唯一构造点 `domain/multiblock#channelStepTrack`）。
   *
   * `null` = 本会话没有该通道的时间入口（未采纳声明 / 该通道无逐帧声明 / 轨道构造失败）
   * —— 读面据此**如实回落**手动层，不制造值。
   */
  private channelTrackOf(channelKey: string): AnimationTrack | null {
    const cached = this.channelTrackCache.get(channelKey)
    if (cached !== undefined) return cached
    const set = this.channelSet
    if (set === null) return null
    const keys = this.channelStepKeysOf(channelKey)
    if (keys.length === 0) return null
    const built = channelStepTrack(set, channelKey, keys)
    if (!built.ok) return null
    this.channelTrackCache.set(channelKey, built.value)
    return built.value
  }

  /**
   * 设置一个通道的取值（经**唯一写通路**；`setChannelValue` 命令）。
   *
   * 与 `setPlaying`/`seekTime` 同一形态：提交 + 有界排空（接收 ≠ 已生效，见
   * {@link settlementOf}）。取值合法性（夹取/回落）由内核的 `reduceSetChannelValue`
   * 决定，本层**不**自己判 —— 否则就是第二份政策。
   *
   * ## 与时间驱动值的关系（覆盖/优先级）
   *
   * 本方法写的是**手动预览层**（`EditContext.channelValues`）；时间驱动的轨道层由
   * {@link KernelSession.channelValues} 在与它合成时给出。两层的胜负**只有一处判定**：
   * `domain/animation#resolveEffectiveValue` 的层表（`trackSample` 高于 `manualPreview`，
   * 与 `application/queries.ts:431-509` 的 RNA 有效值读数**同一张表**）。
   * ⇒ 时间在推进（有声明帧清单）时，读面给出轨道采样值；时间不推进/无帧清单时，
   * 读面逐字给出手动值。本层**不**判断"谁赢"，也不把赢家写回手动层（不反写）。
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
