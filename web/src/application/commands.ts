/**
 * `application/commands` —— **唯一写通路**：纯命令转移 `reduceCommand`（契约 §5.2 §5.3）。
 *
 * ## 本模块的三条不可协商性质
 *
 * 1. **纯**：`reduceCommand(state, command, env)` **不改输入**、不读全局时钟/随机/DOM/Vue/网络、
 *    不隐式发事件、不记日志、不写文件（#249 §2.1 + 契约 §5.3）。需要时间、身份分配、
 *    能力、随机种子时一律经 `ExecutionInputs` 显式传入。
 * 2. **唯一写通路**：不存在第二条属性写通路 —— 没有 JS Proxy，没有 setter 旁路，
 *    没有"暴露任意字段 patch"的通用命令（契约 §5.2 明文）。
 *    ⇒ `Command` 是**封闭判别联合**，不是 `{ kind: string; patch: unknown }`。
 * 3. **无政策藏在接线里**：合法性、写权、冲突、原子性全部在 `domain/*` 的纯函数里；
 *    本模块只做**编排**（把命令路由到对应纯函数并按契约组装 `Transition`）。
 *
 * ## 为什么 `Transition` 里带 `effects`
 *
 * #249 §9：「接纳已排序输入 → 纯命令转移/交互推进 → 验证并原子提交 → 失效传播与
 * 必要查询求值 → **发出效果/发布只读更新**」。效果**发起**是接线层的事，
 * 但"该发什么效果"是业务政策的一部分（保存命令必须产生 save 效果请求），
 * 故由纯转移描述、由 `runtime/effects` 执行。这样 A04 的"效果序列一致"才有唯一来源。
 *
 * ## `applied` 与 `unchanged` 的界线（本批的一处口径澄清）
 *
 * 契约 §3.1：「`unchanged` 必须保持未改分支的身份（结构共享），但不因"创建了新容器"
 * 就判 `applied`」。契约同时规定 `documentVersion` 只随**内容**推进。
 * 于是存在第三类情形：**业务确实变了，但文档内容没变**（改选择、改时间、改通道取值、
 * begin/update 交互暂存）。这类一律报 `applied`，`changes` 如实描述，
 * 而 `version.documentVersion` **保持不变** —— 因为推进它才是违约。
 * 把它们错报成 `unchanged` 会让 A03 的"订阅者看到变化"失去依据；
 * 把它们错报成"推进版本"会让 A06 判红。两者都不是本实现的选择。
 */

import {
  beginSave,
  completeSave,
  createDocument,
  createSaveLedger,
  pushHistory,
  redo as redoDoc,
  undo as undoDoc,
  withAnimation,
  withScene,
  type Document,
  type SaveLedger,
  type SaveOutcome,
} from '@/domain/document'
// A21：对象构造入口直接取自 `domain/scene`（不经 `domain/document` 转出口 ——
// 契约 §7.3 规则 1 禁 barrel；同层具名导入是常态）。
import { DEFAULT_OBJECT_FACTORIES, createObjectOfType, withObject } from '@/domain/scene'
import {
  acquireLease,
  beginInteraction,
  cancelInteraction,
  clearSelection,
  commitInteraction,
  createEditContext,
  createLease,
  releaseLease,
  selectOne,
  updateInteraction,
  withChannelValue,
  withTime,
  type DocumentLease,
  type EditContext,
  type InteractionState,
  type SceneWriter,
  type SelectionState,
  type TimeValue,
} from '@/domain/editing'
import {
  checkValueAgainstDeclaredType,
  findTrack,
  insertKeyframe,
  propertyKey,
  removeKeyframe,
  sameTime,
  sampleTrack,
  setTrackEnabled,
  withTrack,
  withoutTrack,
  withPublishedDefault,
  frameRateOf,
  type AnimationKey,
  type AnimationState,
  type AnimationTrack,
  type InterpolationKind,
  type TrackValue,
  type TrackValueType,
} from '@/domain/animation'
import {
  err,
  invalidValue,
  missingTarget,
  ok,
  readOnly,
  unsupportedOperation,
  versionConflict,
  type DomainError,
  type Result,
} from '@/domain/errors'
import {
  allocateId,
  changeSummary,
  entityRef,
  objectRef,
  sameContent,
  type ChangeSummary,
  type EntityRef,
  type IdState,
  type PropertyRef,
  type Version,
} from '@/domain/identity'
import { findObject, findObjectData, sameTransform, type Scene, type Transform, type Vec3 } from '@/domain/scene'
import type { ApplicationState, EffectRequest } from './state'
import { applySetProperty, type SetPropertyCommand } from './property-commands'
import {
  describeProperty as describeRnaProperty,
  type PropertyDescriptor,
  type PropertyValue,
} from './properties'
import { kernelAccessOf, kernelPropertyRegistry, kernelWritePorts } from './kernel-properties'

// ─────────────────────────────────────────────────────────────────────────────
// 命令（封闭判别联合 —— 唯一写通路的类型级保证）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 属性值 —— **唯一权威是 `application/properties`**（#250 GF-5 收敛项 1）。
 *
 * 本文件曾本地定义 `PropertyValue = number | string | boolean | Vec3 | Quat | null`，
 * 那是转录期与 P2 并行的产物。收敛后本文件**不再定义**任何属性值类型：
 * 它只 import RNA 侧的定义，于是「值类型」不可能出现两个不兼容版本
 * （两个版本会让「同一个值在写路由与值 handler 眼里合法性不同」）。
 */
export type { PropertyValue }

/**
 * 属性写命令（契约 §5.2 `SetPropertyCommand`）—— **唯一权威是 `application/property-commands`**。
 *
 * 本文件曾本地定义一份（含 `contextId`/`expectedVersion`）。收敛后唯一权威在
 * `property-commands.ts`：那里是 RNA 的公开命令类型，面板/脚本/命令搜索共用同一个定义。
 * `reduceSetProperty` 从命令的 `refs[0].owner` 解析文档，不再要求命令携带 `contextId`
 * —— 文档由**引用**决定，不由调用方另填一个可能与引用矛盾的字段决定。
 */
export type { SetPropertyCommand }

export interface SetTransformCommand {
  readonly kind: 'setTransform'
  readonly contextId: string
  readonly objectId: string
  readonly transform: Transform
  readonly expectedVersion?: Version
}

export interface AddObjectCommand {
  readonly kind: 'addObject'
  readonly contextId: string
  /**
   * 对象类型 id（`ObjectTypeId` = `string`，**不是**封闭联合）。
   *
   * ## 为什么这里必须开放（P6 实测修正；变基合流时由 #254 的真实需求再次印证）
   *
   * P6 初版写的是 `'block' | 'annotation' | 'camera'` 三元联合。A21 的判据
   * （「通过现有贡献接口新增类型，**而非改核心**」）把它抓了出来 ——
   * 那个联合让"新增 `text` 类型"必须回来改**命令类型的定义**，
   * 即核心仍需为每个新类型改动。
   *
   * **变基合流印证**：P3（#254）交付 `mesh` 时，正是回到这个联合里加了 `'mesh'`、
   * 并加了一个 `meshSize` 具名字段 —— 同一形态的第二次出现。
   * 合流采用开放通道：`meshSize` 移入 `params.meshSize`。
   *
   * 现在它是开放字符串，合法性由**类型描述表**在运行时判定
   * （`domain/scene#typeDescriptor` + `createObjectOfType`）：
   * 表里没有该类型 ⇒ `UnsupportedOperation`，而不是编译期封闭。
   * 这正是 #249 §13 末段要求的："新增属性类型之外的普通对象类型"不得需要改核心。
   */
  readonly objectType: string
  readonly name?: string
  /**
   * 类型特有的构造参数（**唯一**的开放通道）。
   *
   * 各类型自己的字段（注释形状 `shape`、网格尺寸 `meshSize`、相机投影…）
   * 一律经这里传入，核心**不**认识任何单类型特有的字段名 ——
   * 那会让"新增一个类型"变成"回来改命令类型"，即 A21 要禁止的形态。
   */
  readonly params?: Readonly<Record<string, unknown>>
}

export interface DeleteObjectCommand {
  readonly kind: 'deleteObject'
  readonly contextId: string
  readonly objectId: string
}

export interface BeginInteractionCommand {
  readonly kind: 'beginInteraction'
  readonly contextId: string
  readonly tool: string
  readonly targets: readonly string[]
}

export interface UpdateInteractionCommand {
  readonly kind: 'updateInteraction'
  readonly contextId: string
  /** 自**起点**的总位移（不是自上一帧的增量）。 */
  readonly displacement: Vec3
}

export interface CommitInteractionCommand {
  readonly kind: 'commitInteraction'
  readonly contextId: string
  readonly label: string
}

export interface CancelInteractionCommand {
  readonly kind: 'cancelInteraction'
  readonly contextId: string
}

export interface SelectCommand {
  readonly kind: 'select'
  readonly contextId: string
  readonly target: EntityRef | null
}

export interface SetTimeCommand {
  readonly kind: 'setTime'
  readonly contextId: string
  readonly time: TimeValue
}

export interface SetChannelValueCommand {
  readonly kind: 'setChannelValue'
  readonly contextId: string
  readonly channel: string
  readonly value: number
}

/**
 * 插入/替换一个关键帧（#249 §7「要求使用关键帧命令或禁用轨道」里的**关键帧命令**）。
 *
 * 为什么是具名命令而不是"通用属性写 + 一个 flag"：契约 §5.2 明文
 * 「插入关键帧等**保持具名命令**」。而且它与 `setProperty` 的**语义不同** ——
 * `setProperty` 写基础值（被轨道驱动时会被拒），本命令写**轨道**（永远合法，
 * 前提是目标属性可动画）。合成一个命令会让"我到底改了哪一层"在命令类型上消失。
 */
export interface InsertKeyframeCommand {
  readonly kind: 'insertKeyframe'
  readonly contextId: string
  readonly target: PropertyRef
  readonly time: TimeValue
  readonly value: TrackValue
  /** 缺省：已有轨道则沿用其策略，无轨道则按值类型推断（见 `defaultInterpolationFor`）。 */
  readonly interpolation?: InterpolationKind
  readonly valueType?: TrackValueType
  /** 枚举/布尔的合法取值（由 RNA 描述提供）。 */
  readonly legalValues?: readonly TrackValue[]
  readonly quantization?: AnimationTrack['quantization']
}

export interface RemoveKeyframeCommand {
  readonly kind: 'removeKeyframe'
  readonly contextId: string
  readonly target: PropertyRef
  readonly time: TimeValue
}

/** 启用/禁用轨道（#249 §3.3「禁用轨道后回到手动/默认值」）。 */
export interface SetTrackEnabledCommand {
  readonly kind: 'setTrackEnabled'
  readonly contextId: string
  readonly target: PropertyRef
  readonly enabled: boolean
}

/** 发布默认值（有效值优先级的**第一层**；#249 §3.3「可发布默认值…属文档」）。 */
export interface PublishDefaultCommand {
  readonly kind: 'publishDefault'
  readonly contextId: string
  readonly target: PropertyRef
  readonly value: TrackValue
}

export interface UndoCommand {
  readonly kind: 'undo'
  readonly contextId: string
}

export interface RedoCommand {
  readonly kind: 'redo'
  readonly contextId: string
}

export interface SaveCommand {
  readonly kind: 'save'
  readonly contextId: string
}

/** 保存完成（**完成事件**入口，不是第二条写通路：它走同一个 `reduceCommand`）。 */
export interface SaveCompletedCommand {
  readonly kind: 'saveCompleted'
  readonly documentId: string
  readonly sequence: number
  readonly bindingGeneration: number
  readonly outcome: SaveOutcome
}

export interface OpenDocumentCommand {
  readonly kind: 'openDocument'
  readonly documentId: string
  readonly contextId: string
}

export interface CloseDocumentCommand {
  readonly kind: 'closeDocument'
  readonly documentId: string
}

export type Command =
  | SetPropertyCommand
  | SetTransformCommand
  | AddObjectCommand
  | DeleteObjectCommand
  | BeginInteractionCommand
  | UpdateInteractionCommand
  | CommitInteractionCommand
  | CancelInteractionCommand
  | SelectCommand
  | SetTimeCommand
  | SetChannelValueCommand
  | InsertKeyframeCommand
  | RemoveKeyframeCommand
  | SetTrackEnabledCommand
  | PublishDefaultCommand
  | UndoCommand
  | RedoCommand
  | SaveCommand
  | SaveCompletedCommand
  | OpenDocumentCommand
  | CloseDocumentCommand

/**
 * 无效果、可有界完成的命令集合（契约 §2 `executeNow` 的适用范围）。
 *
 * `save` / `saveCompleted` / `openDocument` / `closeDocument` **不在其中**：
 * 前两者涉及 IO 效果，后两者改变可观察的文档集合。契约 §2.1：
 * 「`executeNow` 仅允许**无效果、可有界完成**的命令」。
 */
export type ImmediateCommand = Extract<
  Command,
  | { kind: 'select' }
  | { kind: 'setTime' }
  | { kind: 'setChannelValue' }
  | { kind: 'setProperty' }
  | { kind: 'setTransform' }
  | { kind: 'beginInteraction' }
  | { kind: 'updateInteraction' }
  | { kind: 'cancelInteraction' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'addObject' }
  | { kind: 'deleteObject' }
  | { kind: 'insertKeyframe' }
  | { kind: 'removeKeyframe' }
  | { kind: 'setTrackEnabled' }
  | { kind: 'publishDefault' }
>

/** 命令是否需要进入队列（有副作用或需要效果）。 */
export function requiresQueue(command: Command): boolean {
  return command.kind === 'save' || command.kind === 'saveCompleted' || command.kind === 'openDocument' || command.kind === 'closeDocument'
}

// ─────────────────────────────────────────────────────────────────────────────
// 执行输入
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 执行输入（契约 §5.3 `ExecutionInputs`）。
 *
 * 这里**没有**时钟函数、随机源或 IO 句柄 —— 因为纯转移不需要它们。
 * 时间是命令携带的值（`SetTimeCommand.time`），身份来自状态里的 `ids`。
 * 这一"什么都不给"本身是 A02 纯性的结构性保证：没有可读的全局来源。
 */
export interface ExecutionInputs {
  /**
   * 能力集合（profile 裁剪）。缺失能力时命令返回 `UnsupportedOperation`
   * —— 契约 §3.2 要求「必须可由**运行时**拒绝，不只靠 UI 隐藏按钮」（A15 负对照）。
   */
  readonly capabilities: readonly string[]
  /**
   * **对象类型构造工厂**（A21 的落点；#249 §5.3「需要…能力…时，作为输入或状态传入」）。
   *
   * ## 为什么它在输入里而不在 `Document`
   *
   * P6 首次实现把工厂放进了 `Document.types` 的描述符里，`pureDomain.test.ts`
   * 立刻判红：`structuredClone(openDocumentState())` 抛 `DataCloneError`
   * —— 应用状态必须可克隆、可重放（A04），而函数是运行期句柄。
   * 契约 §2.1 也要求「`read` 不导出…文档实例字段」。
   *
   * ⇒ 工厂是**执行输入**（能力），不是**状态**（内容）。
   * 缺省取内置三类（`DEFAULT_OBJECT_FACTORIES`），使 P1 的行为逐字不变；
   * 装配层可以覆盖它来加载贡献的类型（见 `composition`）。
   */
  readonly objectFactories?: import('@/domain/scene').ObjectFactoryTable
  /** 该次执行的关联 id（供诊断，不参与语义）。 */
  readonly correlationId?: string
}

export const ALL_CAPABILITIES: readonly string[] = Object.freeze([
  'content.edit',
  'content.add',
  'content.delete',
  'interaction.begin',
  'save.write',
])

/** 查看器 profile：无内容编辑能力（A15 负对照的输入）。 */
export const VIEWER_CAPABILITIES: readonly string[] = Object.freeze(['interaction.begin'])

export function defaultExecutionInputs(capabilities: readonly string[] = ALL_CAPABILITIES): ExecutionInputs {
  return Object.freeze({ capabilities, objectFactories: DEFAULT_OBJECT_FACTORIES })
}

// ─────────────────────────────────────────────────────────────────────────────
// 转移（契约 §3.1 CommandOutcome 的对应物）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 三分支**互斥且穷尽**（契约 §3.1）。
 *
 * `rejected` 分支**不带可写状态**，只有原状态引用 —— 于是"拒绝后仍报告 applied"
 * 在类型层面不可表达，而不是靠实现自觉。这是 A06 的结构性保证。
 */
export type Transition =
  | {
      readonly status: 'applied'
      readonly state: ApplicationState
      readonly version: Version
      readonly changes: ChangeSummary
      readonly effects: readonly EffectRequest[]
    }
  | {
      readonly status: 'unchanged'
      readonly state: ApplicationState
      readonly version: Version
      readonly effects: readonly EffectRequest[]
    }
  | {
      readonly status: 'rejected'
      readonly state: ApplicationState
      /**
       * 拒绝时**未变**的版本。
       *
       * 契约 §3.1 的 `CommandOutcome.rejected` 不带版本；这里带上它是为了让
       * 重放摘要（A04）能在拒绝分支上同样记录"当时处于哪个版本"，
       * 从而"改变一项输入应产生差异"在拒绝路径上也可对账。
       * 它恒等于拒绝前状态的版本，不表示任何推进。
       */
      readonly version: Version
      readonly error: DomainError
      readonly effects: readonly EffectRequest[]
    }

const NO_EFFECTS: readonly EffectRequest[] = Object.freeze([])

function applied(state: ApplicationState, version: Version, changes: ChangeSummary, effects: readonly EffectRequest[] = NO_EFFECTS): Transition {
  return Object.freeze({ status: 'applied', state, version, changes, effects })
}
function unchanged(state: ApplicationState, version: Version, effects: readonly EffectRequest[] = NO_EFFECTS): Transition {
  return Object.freeze({ status: 'unchanged', state, version, effects })
}
/** 拒绝：`state` **恒为原引用**，版本取该次转移实际作用于的文档版本（A06「拒绝…零残留」）。 */
function rejected(state: ApplicationState, error: DomainError, version?: Version): Transition {
  return Object.freeze({ status: 'rejected', state, version: version ?? versionOfFirstDocument(state), error, effects: NO_EFFECTS })
}

/** 拒绝路径的版本取当前（未变）版本；无文档时给零版本。 */
function versionOfFirstDocument(state: ApplicationState): Version {
  for (const id of Object.keys(state.docs)) return state.docs[id].version
  return Object.freeze({ documentVersion: 0, contentVersion: 0 })
}

// ─────────────────────────────────────────────────────────────────────────────
// reduceCommand —— 唯一入口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 纯命令转移（契约 §5.3）。
 *
 * `submit` 与 `executeNow` **共用**本函数（契约 §2.1：「与 `executeNow` 共用同一条
 * 逻辑更新入口（§5 明文"不是第二写通路"）」）。两者差别只在**执行器**如何处置
 * 需要排队/需要效果的情形，不在转移本身。
 */
export function reduceCommand(state: ApplicationState, command: Command, env: ExecutionInputs): Transition {
  for (const cap of capabilityFor(command)) {
    if (!env.capabilities.includes(cap)) {
      return rejected(state, unsupportedOperation({ capability: cap, command: command.kind }))
    }
  }
  switch (command.kind) {
    case 'openDocument':
      return reduceOpenDocument(state, command)
    case 'closeDocument':
      return reduceCloseDocument(state, command)
    case 'select':
      return reduceSelect(state, command)
    case 'setTime':
      return reduceSetTime(state, command)
    case 'setChannelValue':
      return reduceSetChannelValue(state, command)
    case 'insertKeyframe':
      return reduceInsertKeyframe(state, command)
    case 'removeKeyframe':
      return reduceRemoveKeyframe(state, command)
    case 'setTrackEnabled':
      return reduceSetTrackEnabled(state, command)
    case 'publishDefault':
      return reducePublishDefault(state, command)
    case 'addObject':
      return reduceAddObject(state, command, env)
    case 'deleteObject':
      return reduceDeleteObject(state, command)
    case 'setTransform':
      return reduceSetTransform(state, command)
    case 'setProperty':
      return reduceSetProperty(state, command, env)
    case 'beginInteraction':
      return reduceBeginInteraction(state, command)
    case 'updateInteraction':
      return reduceUpdateInteraction(state, command)
    case 'commitInteraction':
      return reduceCommitInteraction(state, command)
    case 'cancelInteraction':
      return reduceCancelInteraction(state, command)
    case 'undo':
      return reduceUndoRedo(state, command.contextId, 'undo')
    case 'redo':
      return reduceUndoRedo(state, command.contextId, 'redo')
    case 'save':
      return reduceSave(state, command, env)
    case 'saveCompleted':
      return reduceSaveCompleted(state, command)
  }
}

/** 命令 → 所需能力。**单点**判定表，不散落在各处。 */
function capabilityFor(command: Command): readonly string[] {
  switch (command.kind) {
    case 'addObject':
      return ['content.add']
    case 'deleteObject':
      return ['content.delete']
    case 'setTransform':
    case 'setProperty':
    case 'commitInteraction':
    case 'insertKeyframe':
    case 'removeKeyframe':
    case 'setTrackEnabled':
    case 'publishDefault':
      return ['content.edit']
    case 'beginInteraction':
    case 'updateInteraction':
      return ['interaction.begin']
    case 'save':
      return ['save.write']
    default:
      return []
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 文档生命周期
// ─────────────────────────────────────────────────────────────────────────────

function reduceOpenDocument(state: ApplicationState, cmd: OpenDocumentCommand): Transition {
  if (has(state.docs, cmd.documentId)) return rejected(state, invalidValue({ reason: 'documentAlreadyOpen', documentId: cmd.documentId }))
  if (has(state.contexts, cmd.contextId)) return rejected(state, invalidValue({ reason: 'contextAlreadyExists', contextId: cmd.contextId }))
  const doc = createDocument(cmd.documentId)
  const ctx = createEditContext(cmd.contextId, cmd.documentId)
  const next: ApplicationState = Object.freeze({
    ...state,
    docs: Object.freeze({ ...state.docs, [cmd.documentId]: doc }),
    contexts: Object.freeze({ ...state.contexts, [cmd.contextId]: ctx }),
    leases: Object.freeze({ ...state.leases, [cmd.documentId]: createLease(cmd.documentId) }),
    saveLedgers: Object.freeze({ ...state.saveLedgers, [cmd.documentId]: createSaveLedger() }),
  })
  return applied(next, doc.version, changeSummary({ createdEntities: [entityRef('document', cmd.documentId)] }))
}

function reduceCloseDocument(state: ApplicationState, cmd: CloseDocumentCommand): Transition {
  const doc = getDoc(state, cmd.documentId)
  if (!doc) return rejected(state, missingTarget({ documentId: cmd.documentId }))
  const docs = { ...state.docs }
  delete docs[cmd.documentId]
  const leases = { ...state.leases }
  delete leases[cmd.documentId]
  const saveLedgers = { ...state.saveLedgers }
  delete saveLedgers[cmd.documentId]
  // 绑定该文档的上下文一并移除 —— 契约 §6.1：「文档关闭也释放租约、取消归属作业」
  const contexts: Record<string, EditContext> = {}
  for (const [id, ctx] of Object.entries(state.contexts)) {
    if (ctx.documentId !== cmd.documentId) contexts[id] = ctx
  }
  const next: ApplicationState = Object.freeze({
    ...state,
    docs: Object.freeze(docs),
    contexts: Object.freeze(contexts),
    leases: Object.freeze(leases),
    saveLedgers: Object.freeze(saveLedgers),
  })
  return applied(next, doc.version, changeSummary({ removedEntities: [entityRef('document', cmd.documentId)] }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 上下文状态（选择/时间/通道）
// ─────────────────────────────────────────────────────────────────────────────

function reduceSelect(state: ApplicationState, cmd: SelectCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  const nextCtx = cmd.target === null ? clearSelection(ctx) : selectOne(ctx, cmd.target)
  if (sameSelection(ctx.selection, nextCtx.selection)) return unchanged(state, doc.version)
  // 业务确实变了（选择），但**文档内容版本不动**（契约 §6 所有权表：点选不记文档历史）
  return applied(
    withContext(state, nextCtx),
    doc.version,
    changeSummary({ changedProperties: [], structurallyShared: true }),
  )
}

function reduceSetTime(state: ApplicationState, cmd: SetTimeCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  // 帧率合法性判据在 `domain/animation`（纯、含有理帧率的规范化），
  // **不**在本层重写一遍。拒绝的 `reason` 与 P1 保持同一个（`fpsMustBePositive`），
  // 使既有断言与消费者无需改动。
  const rate = frameRateOf(cmd.time.fps)
  if (!rate.ok) return rejected(state, rate.error)
  // 比较用 `sameTime`（精确、含有理数约分），不用 `frame`/`fps` 逐字段比对 ——
  // 后者会让 `20` 与 `{num:40,den:2}` 被判为不同时间，从而白推一次求值。
  if (sameTime(ctx.time, cmd.time)) return unchanged(state, doc.version)
  // 时间属 EditContext：改它**不推进 documentVersion**（#249 §7「动画播放不增加文档版本」）
  return applied(withContext(state, withTime(ctx, cmd.time)), doc.version, changeSummary({ structurallyShared: true }))
}

function reduceSetChannelValue(state: ApplicationState, cmd: SetChannelValueCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  if (!Number.isFinite(cmd.value)) return rejected(state, invalidValue({ reason: 'notFinite', channel: cmd.channel, value: String(cmd.value) }))
  if (ctx.channelValues[cmd.channel] === cmd.value) return unchanged(state, doc.version)
  // 通道取值属编辑上下文（#249 §3.3「手动预览取值属编辑上下文」）⇒ 不动文档
  return applied(withContext(state, withChannelValue(ctx, cmd.channel, cmd.value)), doc.version, changeSummary({ structurallyShared: true }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 对象增删
// ─────────────────────────────────────────────────────────────────────────────

function reduceAddObject(state: ApplicationState, cmd: AddObjectCommand, env: ExecutionInputs): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  const lease = acquireFor(state, doc.id, cmd.contextId)
  if (!lease.ok) return rejected(state, lease.error)

  const a1 = allocateId(state.ids, 'object')
  const a2 = allocateId(a1.next, 'data')
  const ref = objectRef(a1.id, a2.next.counter)
  const scene = doc.scene
  /**
   * **唯一**的对象构造入口：经**执行输入**里的工厂表
   * （`domain/scene#createObjectOfType`），核心**不**为对象类型开 switch
   * （#249 §13 A21：「扩展验证要求通过现有贡献接口新增类型，而非改核心 switch」）。
   *
   * P6 实测修正两处：
   *  1. 初版这里是 `switch (cmd.objectType)` 三分支；A21 判据抓出后改为查表；
   *  2. 第二版把工厂塞进 `Document.types`，`pureDomain.test.ts` 抓到
   *     `structuredClone` 抛错（状态必须可克隆 ⇒ 函数不能进状态），
   *     故最终把它移到 `ExecutionInputs.objectFactories`（能力，不是内容）。
   *
   * 变基合流（× P3 #254）：P3 的 `mesh` 需要**结构化失败**
   * （`badBoxSize` 与 id 冲突不可压成同一个结果），故工厂返回
   * `Result<ObjectCreation> | null` —— `null` = 类型不认识、`err` = 构造失败。
   */
  const built = createObjectOfType(env.objectFactories ?? DEFAULT_OBJECT_FACTORIES, cmd.objectType, {
    objectId: a1.id,
    dataId: a2.id,
    ...(cmd.name === undefined ? {} : { name: cmd.name }),
    params: Object.freeze({ ...(cmd.params ?? {}) }),
  })
  // 没有该类型的工厂 ⇒ 本装配不认识它。这是 `UnsupportedOperation`（能力缺失），
  // 不是 `InvalidValue`（输入本身没问题）—— 契约 §3.2 的触发条件表。
  if (built === null) return rejected(state, unsupportedOperation({ objectType: cmd.objectType, kind: 'addObject' }))
  // 类型认识但构造失败 ⇒ **原样透出结构化错误**（例如 `badBoxSize`），
  // 不压成 `null`/`idCollision`（#249 §5「不能用默认值掩盖缺失」）。
  if (!built.ok) return rejected(state, built.error)
  const nextScene = withObject(scene, built.value.object, built.value.data)
  if (nextScene === null) return rejected(state, invalidValue({ reason: 'idCollision', objectId: a1.id }))

  const write = withScene(doc, nextScene)
  const changes = changeSummary({ createdEntities: [ref], structurallyShared: true })
  const withHistory = recordHistory(write.doc, {
    label: cmd.name ?? `add ${cmd.objectType}`,
    beforeScene: doc.scene,
    beforeVersion: doc.version,
    afterScene: nextScene,
    afterVersion: write.version,
    changes,
    selectionBefore: ctx.selection.selected,
    selectionAfter: [ref],
  })
  const next: ApplicationState = Object.freeze({
    ...state,
    ids: a2.next,
    docs: Object.freeze({ ...state.docs, [doc.id]: withHistory }),
    contexts: Object.freeze({ ...state.contexts, [ctx.id]: selectOne(ctx, ref) }),
    leases: Object.freeze({ ...state.leases, [doc.id]: lease.value }),
  })
  return applied(next, write.version, changes)
}

function reduceDeleteObject(state: ApplicationState, cmd: DeleteObjectCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  const obj = findObject(doc.scene, cmd.objectId)
  if (!obj) return rejected(state, missingTarget({ objectId: cmd.objectId }))
  const data = findObjectData(doc.scene, obj.dataId)
  if (data?.source === 'content') return rejected(state, readOnly({ owner: data.source, objectId: cmd.objectId }))
  const lease = acquireFor(state, doc.id, cmd.contextId)
  if (!lease.ok) return rejected(state, lease.error)

  const objects = { ...doc.scene.objects }
  delete objects[cmd.objectId]
  const dataMap = { ...doc.scene.data }
  // 仅当无其他对象引用时才删数据（共享几何的其它消费者必须保持完好，#249 §3.2）
  const stillShared = Object.values(objects).some((o) => o.dataId === obj.dataId)
  if (!stillShared) delete dataMap[obj.dataId]
  const nextScene: Scene = Object.freeze({
    ...doc.scene,
    objects: Object.freeze(objects),
    data: Object.freeze(dataMap),
    order: Object.freeze(doc.scene.order.filter((id) => id !== cmd.objectId)),
  })
  const write = withScene(doc, nextScene)
  const changes = changeSummary({ removedEntities: [objectRef(cmd.objectId)], structurallyShared: true })
  const withHistory = recordHistory(write.doc, {
    label: `delete ${cmd.objectId}`,
    beforeScene: doc.scene,
    beforeVersion: doc.version,
    afterScene: nextScene,
    afterVersion: write.version,
    changes,
    selectionBefore: ctx.selection.selected,
    selectionAfter: [],
  })
  const next: ApplicationState = Object.freeze({
    ...state,
    docs: Object.freeze({ ...state.docs, [doc.id]: withHistory }),
    contexts: Object.freeze({ ...state.contexts, [ctx.id]: clearSelection(ctx) }),
    leases: Object.freeze({ ...state.leases, [doc.id]: lease.value }),
  })
  return applied(next, write.version, changes)
}

// ─────────────────────────────────────────────────────────────────────────────
// 直接变换写
// ─────────────────────────────────────────────────────────────────────────────

function reduceSetTransform(state: ApplicationState, cmd: SetTransformCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  const obj = findObject(doc.scene, cmd.objectId)
  if (!obj) return rejected(state, missingTarget({ objectId: cmd.objectId }))
  const guard = writeGuard(doc, obj.id)
  if (guard) return rejected(state, guard)
  if (cmd.expectedVersion && cmd.expectedVersion.documentVersion !== doc.version.documentVersion) {
    return rejected(state, versionConflict({ expected: cmd.expectedVersion.documentVersion, actual: doc.version.documentVersion }))
  }
  // 无变化 ⇒ unchanged（**不**因新建容器而记 applied；契约 §1.4）
  if (sameTransform(obj.transform, cmd.transform)) return unchanged(state, doc.version)
  const lease = acquireFor(state, doc.id, cmd.contextId)
  if (!lease.ok) return rejected(state, lease.error)

  const nextScene: Scene = Object.freeze({
    ...doc.scene,
    objects: Object.freeze({ ...doc.scene.objects, [cmd.objectId]: Object.freeze({ ...obj, transform: cmd.transform }) }),
  })
  const write = withScene(doc, nextScene)
  const changes = changeSummary({ changedProperties: [{ owner: objectRef(obj.id), property: 'transform' }], structurallyShared: true })
  const withHistory = recordHistory(write.doc, {
    label: `transform ${cmd.objectId}`,
    beforeScene: doc.scene,
    beforeVersion: doc.version,
    afterScene: nextScene,
    afterVersion: write.version,
    changes,
    selectionBefore: ctx.selection.selected,
    selectionAfter: ctx.selection.selected,
  })
  const next: ApplicationState = Object.freeze({
    ...state,
    docs: Object.freeze({ ...state.docs, [doc.id]: withHistory }),
    leases: Object.freeze({ ...state.leases, [doc.id]: lease.value }),
  })
  return applied(next, write.version, changes)
}

// ─────────────────────────────────────────────────────────────────────────────
// 属性写（唯一写路由 + 多选原子性）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 属性写 —— 路由到 **RNA 注册表**（#250 GF-5 收敛项 2：`reduceCommand` 成为唯一写入口）。
 *
 * ## 本函数在收敛前后做的事（这是 GF-5 的核心差别）
 *
 * **收敛前**：本函数自带一整套**内联属性词汇** ——
 * `validatePropertyWrite` 里的 `isStructuralProperty('name'|'visible')` +
 * `doc.types[obj.type].animatableProperties.includes(...)` 白名单，
 * 以及 `applyPropertyValue` 里对 `'name'`/`'visible'`/`'transform.*'`/`'projection.*'`/
 * `'annotation.text'` 的 `switch`。属性语义因此有**两套**（P1 的内联表 + P2 的 RNA 表），
 * 且两套描述的属性集合不相交。
 *
 * **收敛后**：本函数**零属性词汇**。它只做三件事：
 *  1. 从引用解析出文档与绑定的上下文（文档由**引用**决定，不由调用方另填字段决定）；
 *  2. 把注册表、写端口、显式访问环境交给 `applySetProperty` —— 后者按 RNA 描述
 *     算可编辑性、校验值、逐目标聚合失败；
 *  3. 把纯转移结果映射成 `Transition` 并记历史。
 *
 * 于是「新增一种内置属性类型」或「新增一个普通对象类型」只需经
 * `registerValueType`/`registerObjectType` 注册 —— 本函数**必须改**这件事不再成立，
 * 那正是 D4 的证明路径。
 *
 * ## 为什么上下文从文档反查（而不是命令携带 `contextId`）
 *
 * 契约 §1.1 方向 8：「不提供跨文档编辑事务」⇒ 一条命令只作用于**一个**文档。
 * 而 `contextId` 若由调用方另填，就存在"引用指向文档 A、contextId 指向文档 B"
 * 的矛盾输入，必须额外校验两者一致。让上下文**由目标文档唯一确定**消除了这类
 * 矛盾输入的存在空间 —— 一致性由构造保证，不靠校验兜。
 */
function reduceSetProperty(state: ApplicationState, cmd: SetPropertyCommand, env: ExecutionInputs): Transition {
  // 空引用是**调用方缺陷**（没有目标就没有属性写），显式拒绝而不是静默 unchanged。
  if (cmd.refs.length === 0) return rejected(state, invalidValue({ reason: 'noTargets' }))
  if (cmd.value === 'mixed') return rejected(state, invalidValue({ reason: 'mixedHasNoConcreteValue' }))

  const target = resolvePropertyDocument(state, cmd.refs)
  if (!target.ok) return rejected(state, target.error)
  const { doc, ctx } = target.value

  const lease = acquireFor(state, doc.id, ctx.id)
  if (!lease.ok) return rejected(state, lease.error)

  const { registry, errors } = kernelPropertyRegistry()
  if (errors.length > 0) {
    // 内核注册表构造失败是**装配缺陷**，必须显式暴露（不得静默降级为"属性不存在"）。
    return rejected(state, unsupportedOperation({ reason: 'kernel-registry-invalid', detail: String(errors[0]!.params.reason ?? errors[0]!.code) }))
  }

  const access = kernelAccessOf(doc, ctx.id, env.capabilities, true)
  const write = applySetProperty<Document>({
    registry,
    ports: kernelWritePorts(),
    state: doc,
    command: cmd,
    env: { baseVersion: doc.version, currentVersion: doc.version },
    access,
  })

  if (write.outcome.status === 'rejected') return rejected(state, write.outcome.error, doc.version)
  if (write.outcome.status === 'unchanged') return unchanged(state, doc.version)

  // 写端口返回的候选文档**已**经 `withScene` 推进过版本（内容身份判据在 `domain/document`），
  // 故此处直接取它的版本 —— 不再二次 `withScene`（那会重复摘要计算且掩盖"谁推进了版本"）。
  const nextDoc = write.candidate as Document
  const changed = write.outcome.changes.changedProperties
  const changes = changeSummary({ changedProperties: changed, structurallyShared: write.outcome.changes.structurallyShared })
  const withHistory = recordHistory(nextDoc, {
    label: cmd.refs.length > 1 ? `set ${cmd.refs.length} properties` : `set ${cmd.refs[0]!.property}`,
    beforeScene: doc.scene,
    beforeVersion: doc.version,
    afterScene: nextDoc.scene,
    afterVersion: nextDoc.version,
    changes,
    selectionBefore: ctx.selection.selected,
    selectionAfter: ctx.selection.selected,
  })
  const next: ApplicationState = Object.freeze({
    ...state,
    docs: Object.freeze({ ...state.docs, [doc.id]: withHistory }),
    leases: Object.freeze({ ...state.leases, [doc.id]: lease.value }),
  })
  return applied(next, nextDoc.version, changes)
}

/**
 * 从属性引用解析「目标文档 + 绑定该文档的编辑上下文」。
 *
 * 判据（顺序即优先级）：
 *  1. 引用必须指向 `object` 拥有者 —— 编辑上下文属性有具名命令（`setTime`/`setChannelValue`），
 *     不经通用属性写承载；
 *  2. 对象必须**恰好**存在于一个打开的文档里 —— 找不到是 `MissingTarget`，
 *     出现在多个文档里是身份歧义（`InvalidValue`，不静默取第一个）；
 *  3. 该文档必须有绑定的编辑上下文 —— 没有则无租约可申请（`DocumentBusy`）。
 */
function resolvePropertyDocument(
  state: ApplicationState,
  refs: readonly PropertyRef[],
): Result<{ doc: Document; ctx: EditContext }> {
  const unsupportedKind = refs.find((r) => r.owner.kind !== 'object')
  if (unsupportedKind) {
    return err(unsupportedOperation({ ownerKind: unsupportedKind.owner.kind, property: unsupportedKind.property }))
  }
  const first = refs[0]!

  const matches: { doc: Document; ctx: EditContext }[] = []
  for (const ctx of Object.values(state.contexts)) {
    const doc = getDoc(state, ctx.documentId)
    if (!doc) continue
    if (findObject(doc.scene, first.owner.id)) matches.push({ doc, ctx })
  }
  if (matches.length === 0) return err(missingTarget({ objectId: first.owner.id, property: first.property }))
  if (matches.length > 1) {
    return err(invalidValue({ reason: 'ambiguous-target-document', objectId: first.owner.id, docs: matches.map((m) => m.doc.id).join(',') }))
  }
  return ok(matches[0]!)
}

/**
 * 多目标写拒绝的逐目标聚合 —— **已迁至** `application/property-commands.ts` 的 `aggregateFailure`。
 *
 * 本文件曾有自己的 `aggregatePropertyFailures`，与 RNA 侧的 `aggregateFailure` 同名同义
 * （同样拼 `failedTargets`/`totalTargets`/`reasons`/`homogeneous`）。两份聚合必然漂移，
 * 而漂移的后果是「UI 说为什么拒绝」与「核心说为什么拒绝」不一致 ——
 * 正是冻结 #5 要消除的。收敛后 `reduceSetProperty` 直接把结果透出，不再二次聚合。
 */

/** 对象是否可写（存在 + 非只读内容来源）。返回 `null` 表示可写。 */
function writeGuard(doc: Document, objectId: string): DomainError | null {
  const obj = findObject(doc.scene, objectId)
  if (!obj) return missingTarget({ objectId })
  const data = findObjectData(doc.scene, obj.dataId)
  if (!data) return missingTarget({ dataId: obj.dataId })
  if (data.source === 'content') return readOnly({ owner: data.source, objectId })
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// 已删除的内联属性词汇（#250 GF-5 收敛项 2 —— 退役记录，不是注释掉的代码）
// ─────────────────────────────────────────────────────────────────────────────
//
// 本文件曾有 5 个函数承载**内核侧的属性语义**，它们是"`reduceCommand` 不是唯一写入口"
// 的直接原因（属性词汇在两处各有一份，且两套集合不相交）：
//
// | 已删除 | 原职责 | 现在的唯一归属 |
// |---|---|---|
// | `validatePropertyWrite` | 内联白名单：`name`/`visible` + `doc.types[type].animatableProperties` | RNA 描述 + `evaluateEditability`（`properties.ts`）|
// | `isStructuralProperty` | 把 `name`/`visible` 当"结构属性"特例放行 | 注册表里的**普通声明**（`kernel-properties.ts`）|
// | `applyPropertyValue` | 对 `'name'`/`'visible'`/`'transform.*'`/`'projection.*'`/`'annotation.text'` 的 `switch` | 值 handler 校验 + 写端口（`kernel-properties.ts`）|
// | `propertyActuallyChanged` | 按属性名逐个判"是否真变了" | 值 handler 的 `equals`（D5 的唯一判据）|
// | `aggregatePropertyFailures` | 第二份多选失败聚合（与 P2 的 `aggregateFailure` 同名同义）| `aggregateFailure`（`property-commands.ts`）|
//
// 连同 `isVec3`/`isQuat`（只在 `applyPropertyValue` 里用的形状判定）与本地
// `animationDriven`（被 `kernel-properties.ts` 的 `kernelDrivenProperties` 取代）一并删除。
// 这些**不留兼容包装**：留着"以防万一"的包装正是 #171 说的"新门面包旧核心"。

// ─────────────────────────────────────────────────────────────────────────────
// 交互
// ─────────────────────────────────────────────────────────────────────────────

function reduceBeginInteraction(state: ApplicationState, cmd: BeginInteractionCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  const lease = acquireFor(state, doc.id, cmd.contextId)
  if (!lease.ok) return rejected(state, lease.error)
  const r = beginInteraction(ctx, doc, { tool: cmd.tool, targets: cmd.targets })
  if (!r.ok) return rejected(state, r.error)
  const next: ApplicationState = Object.freeze({
    ...state,
    contexts: Object.freeze({ ...state.contexts, [ctx.id]: r.value }),
    leases: Object.freeze({ ...state.leases, [doc.id]: lease.value }),
  })
  // 状态变了（多了活动交互）但**文档内容未变** ⇒ applied + 版本不动
  return applied(next, doc.version, changeSummary({ structurallyShared: true }))
}

function reduceUpdateInteraction(state: ApplicationState, cmd: UpdateInteractionCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  const r = updateInteraction(ctx, doc, { displacement: cmd.displacement })
  if (!r.ok) return rejected(state, r.error)
  const next: ApplicationState = Object.freeze({ ...state, contexts: Object.freeze({ ...state.contexts, [ctx.id]: r.value }) })
  // 一次 update **不记历史**、不推进内容版本（#249 §8）
  return applied(next, doc.version, changeSummary({ structurallyShared: true }))
}

function reduceCommitInteraction(state: ApplicationState, cmd: CommitInteractionCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  if (ctx.interaction === null) return rejected(state, invalidValue({ reason: 'noActiveInteraction' }))

  const writer: SceneWriter = (scene, interaction) => collectStagedTransforms(scene, interaction)
  const result = commitInteraction(ctx, doc, writer)
  if (result === null) {
    // 净零提交（或起点版本失配）：清空交互，**文档零变化**（A06「移出再移回」）
    return unchanged(withContext(state, cancelInteraction(ctx)), doc.version)
  }
  const write = withScene(doc, result.scene)
  const withHistory = recordHistory(write.doc, {
    label: cmd.label,
    beforeScene: doc.scene,
    beforeVersion: doc.version,
    afterScene: result.scene,
    afterVersion: write.version,
    changes: result.changes,
    selectionBefore: ctx.selection.selected,
    selectionAfter: result.selectionAfter,
  })
  const next: ApplicationState = Object.freeze({
    ...state,
    docs: Object.freeze({ ...state.docs, [doc.id]: withHistory }),
    contexts: Object.freeze({ ...state.contexts, [ctx.id]: cancelInteraction(ctx) }),
  })
  return applied(next, write.version, result.changes)
}

/**
 * 把暂存变换收集进场景。
 *
 * 净零（无任何目标真正改变）时返回 `null` —— 候选场景不存在 ⇒ 不产生历史、不推进版本。
 */
function collectStagedTransforms(scene: Scene, interaction: InteractionState): ReturnType<SceneWriter> {
  const objects = { ...scene.objects }
  const changed: PropertyRef[] = []
  for (const id of interaction.targets) {
    const obj = objects[id]
    const nextT = interaction.overrides[id]
    if (!obj || !nextT) continue
    if (sameTransform(obj.transform, nextT)) continue
    objects[id] = Object.freeze({ ...obj, transform: nextT })
    changed.push({ owner: objectRef(id), property: 'transform.position' })
  }
  if (changed.length === 0) return null
  return {
    scene: Object.freeze({ ...scene, objects: Object.freeze(objects) }),
    changes: changeSummary({ changedProperties: changed, structurallyShared: true }),
    selectionAfter: interaction.targets.map((id) => objectRef(id)),
  }
}

function reduceCancelInteraction(state: ApplicationState, cmd: CancelInteractionCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  if (ctx.interaction === null) return unchanged(state, doc.version)
  // 取消：清空暂存 + 释放租约；**文档、历史、脏状态全不变**
  const released = releaseFor(state, doc.id, cmd.contextId)
  return applied(withContext(released, cancelInteraction(ctx)), doc.version, changeSummary({ structurallyShared: true }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 历史
// ─────────────────────────────────────────────────────────────────────────────

function reduceUndoRedo(state: ApplicationState, contextId: string, kind: 'undo' | 'redo'): Transition {
  const found = contextAndDoc(state, contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  // #249 §8：撤销前先明确取消当前交互（不因布局调尺寸或观察移动取消 —— 那两条不产生命令）
  const ctxNoInteraction = cancelInteraction(ctx)
  const step = kind === 'undo' ? undoDoc(doc) : redoDoc(doc)
  if (step === null) return unchanged(state, doc.version)
  const nextCtx: EditContext = Object.freeze({
    ...ctxNoInteraction,
    // 「撤销时根据**当前有效对象**解析」——失效引用已被 resolveSelection 丢弃，不悬空
    selection: Object.freeze({
      selected: step.selection,
      active: step.selection.length > 0 ? step.selection[0] : null,
      mode: ctx.selection.mode,
    }),
  })
  const next: ApplicationState = Object.freeze({
    ...state,
    docs: Object.freeze({ ...state.docs, [doc.id]: step.doc }),
    contexts: Object.freeze({ ...state.contexts, [ctx.id]: nextCtx }),
  })
  return applied(next, step.doc.version, changeSummary({ structurallyShared: true }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 保存（A16 的核心语义层；适配器接入归 #260）
// ─────────────────────────────────────────────────────────────────────────────

function reduceSave(state: ApplicationState, cmd: SaveCommand, env: ExecutionInputs): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  const ledger = ledgerOf(state, doc.id)
  const started = beginSave(ledger, doc, ledger.bindingGeneration)
  if (started === null) {
    // #249 §8：写入**串行化**。已有在途写入 ⇒ 拒绝，不并发、不丢弃（不"仅忽略旧响应"）。
    return rejected(state, invalidValue({ reason: 'saveAlreadyInFlight', documentId: doc.id }))
  }
  const effect: EffectRequest = Object.freeze({
    kind: 'save',
    correlationId: env.correlationId ?? `${doc.id}#${started.request.sequence}`,
    params: Object.freeze({
      documentId: doc.id,
      sequence: started.request.sequence,
      bindingGeneration: started.request.bindingGeneration,
      contentVersion: started.request.capturedVersion.contentVersion ?? 0,
    }),
  })
  const next: ApplicationState = Object.freeze({
    ...state,
    saveLedgers: Object.freeze({ ...state.saveLedgers, [doc.id]: started.ledger }),
    effects: Object.freeze([...state.effects, effect]),
  })
  // 保存**不**改变内容与基线（基线在完成事件里推进）；此处只登记在途与效果描述
  void ctx
  return applied(next, doc.version, changeSummary({ structurallyShared: true }), Object.freeze([effect]))
}

/**
 * 保存完成事件。
 *
 * 三条判据（A16）：
 *  1. 结束的必须是**在途**那一次（序号相符）——否则忽略；
 *  2. **绑定代数相符** —— 文档已关闭/重绑则旧事件不得回写（`superseded`）；
 *  3. 只有 `committed` 推进基线，且基线取**该请求捕获的 S0**（保存期间的新编辑仍脏）。
 */
function reduceSaveCompleted(state: ApplicationState, cmd: SaveCompletedCommand): Transition {
  const doc = getDoc(state, cmd.documentId)
  if (!doc) {
    // 文档已关闭：迟到事件不得回写（契约 §6.1 负对照）
    return unchanged(state, { documentVersion: 0 })
  }
  const ledger = ledgerOf(state, doc.id)
  if (ledger.inFlight === null || ledger.inFlight.sequence !== cmd.sequence) {
    return unchanged(state, doc.version)
  }
  const request = ledger.inFlight
  const result = completeSave(ledger, doc, request, cmd.outcome, cmd.bindingGeneration)
  if (!result.applied) {
    const next: ApplicationState = Object.freeze({ ...state, saveLedgers: Object.freeze({ ...state.saveLedgers, [doc.id]: result.ledger }) })
    return unchanged(next, doc.version)
  }
  const next: ApplicationState = Object.freeze({
    ...state,
    docs: Object.freeze({ ...state.docs, [doc.id]: result.doc }),
    saveLedgers: Object.freeze({ ...state.saveLedgers, [doc.id]: result.ledger }),
  })
  return applied(next, result.doc.version, changeSummary({ structurallyShared: true }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

function has(rec: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(rec, key)
}

function getDoc(state: ApplicationState, id: string): Document | undefined {
  return has(state.docs, id) ? state.docs[id] : undefined
}

function ledgerOf(state: ApplicationState, documentId: string): SaveLedger {
  return has(state.saveLedgers, documentId) ? state.saveLedgers[documentId] : createSaveLedger()
}

/** 取上下文与其绑定文档；任一缺失即 `MissingTarget`（不静默降级）。 */
function contextAndDoc(state: ApplicationState, contextId: string): Result<{ ctx: EditContext; doc: Document }> {
  if (!has(state.contexts, contextId)) return err(missingTarget({ contextId }))
  const ctx = state.contexts[contextId]
  if (!has(state.docs, ctx.documentId)) return err(missingTarget({ documentId: ctx.documentId }))
  return ok({ ctx, doc: state.docs[ctx.documentId] })
}

function acquireFor(state: ApplicationState, documentId: string, contextId: string): Result<DocumentLease> {
  const lease = has(state.leases, documentId) ? state.leases[documentId] : createLease(documentId)
  return acquireLease(lease, contextId)
}

function releaseFor(state: ApplicationState, documentId: string, contextId: string): ApplicationState {
  if (!has(state.leases, documentId)) return state
  const lease = state.leases[documentId]
  const next = releaseLease(lease, contextId)
  if (next === lease) return state
  return Object.freeze({ ...state, leases: Object.freeze({ ...state.leases, [documentId]: next }) })
}

function withContext(state: ApplicationState, ctx: EditContext): ApplicationState {
  if (state.contexts[ctx.id] === ctx) return state
  return Object.freeze({ ...state, contexts: Object.freeze({ ...state.contexts, [ctx.id]: ctx }) })
}

/** 记历史；`pushHistory` 返回 `null` 表示净零/仅选择变化 ⇒ 文档原样返回（幽灵历史防御）。 */
function recordHistory(doc: Document, input: Parameters<typeof pushHistory>[1]): Document {
  const h = pushHistory(doc.history, input)
  return h === null ? doc : Object.freeze({ ...doc, history: h })
}

function sameSelection(a: SelectionState, b: SelectionState): boolean {
  if (a.selected.length !== b.selected.length) return false
  for (let i = 0; i < a.selected.length; i++) {
    const x = a.selected[i]
    const y = b.selected[i]
    if (x.kind !== y.kind || x.id !== y.id || x.contentVersion !== y.contentVersion) return false
  }
  const sameActive =
    (a.active === null && b.active === null) ||
    (a.active !== null && b.active !== null && a.active.kind === b.active.kind && a.active.id === b.active.id && a.active.contentVersion === b.active.contentVersion)
  return sameActive && a.mode === b.mode
}

/**
 * 动画轨道索引 —— **已迁至** `application/kernel-properties.ts` 的 `kernelDrivenProperties`。
 *
 * 迁移理由：它服务的 `validatePropertyWrite` 已删除，而"哪些属性被轨道驱动"是
 * **RNA 可编辑性求值的状态事实**（`TargetFacts.drivenByTrack`），归 `propertyAccess` 的
 * 构造处（`kernelAccessOf`）提供，不再由命令层各算一份 —— 两份轨道索引必然漂移，
 * 而漂移会让"动画驱动的属性被拒绝"在两条路径上给出不同答案（A10 负对照）。
 */
/** 默认插值策略（无显式声明时按值类型推断；#249 §7 的"采样策略由属性值类型和定义选择"）。 */
function defaultInterpolationFor(valueType: TrackValueType): InterpolationKind {
  switch (valueType) {
    case 'quat':
      return 'slerp'
    case 'integer':
      return 'quantized'
    case 'enum':
    case 'boolean':
    case 'string':
      return 'step'
    case 'vec3':
    case 'number':
      return 'linear'
  }
}

/** 由值推断类型（调用方未声明时的兜底；显式声明优先）。 */
function inferValueType(value: TrackValue): TrackValueType {
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'string') return 'enum'
  if (typeof value === 'object' && value !== null && 'w' in value) return 'quat'
  return 'vec3'
}

/**
 * 插入关键帧。
 *
 * 两条语义要点：
 *  1. **写轨道，不写基础值**：这是"关键帧命令"与"普通基础值写入"的分界。
 *     被驱动属性的基础值写入仍被 `validatePropertyWrite` 拒绝（A10 的负对照面），
 *     而本命令永远合法（只要目标可动画）。
 *  2. **值必须过类型与合法域校验**（`sampleTrack` 的同一套判据）：
 *     插入一个非法枚举值会让之后每次采样都失败 —— 与其把坏数据存进文档，
 *     不如在插入点拒绝，并给出同一个 `InvalidValue` 诊断。
 */
function reduceInsertKeyframe(state: ApplicationState, cmd: InsertKeyframeCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  const guard = validateAnimationTarget(doc, cmd.target)
  if (guard) return rejected(state, guard)
  const lease = acquireFor(state, doc.id, cmd.contextId)
  if (!lease.ok) return rejected(state, lease.error)

  const existing = findTrack(doc.animation, cmd.target)
  // 类型优先取**属性声明**（RNA 描述），其次已有轨道，最后才由值推断。
  // 顺序不能颠倒：只从值推断会让"往 vec3 属性插一个数字"变成合法操作。
  //
  // GF-5 收敛后类型**不再**由本层的第二张表给出（P4 曾有 `declaredValueType(property)`），
  // 而是向 RNA 注册表解析 —— `validateAnimationTarget` 已保证描述可解析，故此处直接取用。
  const described = describeRnaProperty(kernelPropertyRegistry().registry, cmd.target)
  if (!described.ok) return rejected(state, described.error)
  const declaredType = trackValueTypeOf(described.value.valueType)
  const valueType = cmd.valueType ?? declaredType ?? existing?.valueType ?? inferValueType(cmd.value)
  const interpolation = cmd.interpolation ?? existing?.interpolation ?? defaultInterpolationFor(valueType)
  // 枚举/布尔的合法取值同样取自**声明域**（RNA `ValueDomain`），不另立一份。
  const legalValues = cmd.legalValues ?? existing?.legalValues ?? legalValuesOf(described.value)
  const quantization = cmd.quantization ?? existing?.quantization

  // 值与属性声明类型不符 ⇒ 在写入点拒绝（不把坏数据存进文档）
  if (declaredType !== undefined) {
    const typeError = checkValueAgainstDeclaredType(declaredType, cmd.value)
    if (typeError) return rejected(state, typeError)
  }

  const base: AnimationTrack =
    existing ??
    Object.freeze({
      id: `track:${propertyKey(cmd.target)}`,
      target: cmd.target,
      valueType,
      interpolation,
      enabled: true,
      keys: Object.freeze([]) as readonly AnimationKey[],
      ...(legalValues === undefined ? {} : { legalValues }),
      ...(quantization === undefined ? {} : { quantization }),
    })

  const candidate = insertKeyframe(
    Object.freeze({ ...base, valueType, interpolation, ...(legalValues === undefined ? {} : { legalValues }), ...(quantization === undefined ? {} : { quantization }) }),
    Object.freeze({ time: cmd.time, value: cmd.value }),
  )

  // 校验：用**采样器本身**判定"这份轨道在该时间能否产出合法值"。
  // 这样"插入时接受的"与"采样时产出的"是同一套判据，不会出现
  // "插入成功但每次采样都失败"的文档。
  const check = sampleTrack(candidate, cmd.time)
  if (!check.ok) return rejected(state, check.error)

  return applyAnimationChange(state, doc, ctx, withTrack(doc.animation, candidate), `keyframe ${cmd.target.property}`)
}

function reduceRemoveKeyframe(state: ApplicationState, cmd: RemoveKeyframeCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  const track = findTrack(doc.animation, cmd.target)
  if (!track) return rejected(state, missingTarget({ property: cmd.target.property, objectId: cmd.target.owner.id }))
  const next = removeKeyframe(track, cmd.time)
  if (next === track) return unchanged(state, doc.version)
  const lease = acquireFor(state, doc.id, cmd.contextId)
  if (!lease.ok) return rejected(state, lease.error)
  return applyAnimationChange(
    state,
    doc,
    ctx,
    next.keys.length === 0 ? withoutTrack(doc.animation, cmd.target) : withTrack(doc.animation, next),
    `remove keyframe ${cmd.target.property}`,
  )
}

function reduceSetTrackEnabled(state: ApplicationState, cmd: SetTrackEnabledCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  const track = findTrack(doc.animation, cmd.target)
  if (!track) return rejected(state, missingTarget({ property: cmd.target.property, objectId: cmd.target.owner.id }))
  const next = setTrackEnabled(track, cmd.enabled)
  if (next === track) return unchanged(state, doc.version)
  const lease = acquireFor(state, doc.id, cmd.contextId)
  if (!lease.ok) return rejected(state, lease.error)
  // 禁用轨道 ⇒ 属性回到手动/默认值（#249 §3.3）。这不是"清空轨道数据"，
  // 而是让 `animationDrivenKeys` 不再含它 ⇒ 基础值写入重新被允许。
  return applyAnimationChange(state, doc, ctx, withTrack(doc.animation, next), `${cmd.enabled ? 'enable' : 'disable'} track ${cmd.target.property}`)
}

function reducePublishDefault(state: ApplicationState, cmd: PublishDefaultCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  const guard = validateAnimationTarget(doc, cmd.target)
  if (guard) return rejected(state, guard)
  const lease = acquireFor(state, doc.id, cmd.contextId)
  if (!lease.ok) return rejected(state, lease.error)
  const next = withPublishedDefault(doc.animation, propertyKey(cmd.target), cmd.value)
  return applyAnimationChange(state, doc, ctx, next, `publish default ${cmd.target.property}`)
}

/**
 * RNA 值类型 → 轨道值类型。
 *
 * 两侧的**取值空间不同**，映射是有损的、也是必须显式的一处：
 *  - RNA 的 `PropertyValueType` 是**开放字符串**（`PropertyValueType = string`）
 *    —— 扩展类型可以注册进来，故不能写成封闭联合；
 *  - 轨道的 `TrackValueType` 是**可动画子集**（离散/连续插值各自有明确语义）。
 *
 * 未映射的类型返回 `undefined` ⇒ 调用方回落到"已有轨道类型"或"由值推断"。
 * **不**在这里猜一个类型：猜错会让"不可动画的值类型"被插进轨道。
 */
function trackValueTypeOf(valueType: string): TrackValueType | undefined {
  switch (valueType) {
    case 'number':
    case 'integer':
    case 'vec3':
    case 'quat':
    case 'string':
    case 'boolean':
      return valueType
    default:
      return undefined
  }
}

/**
 * 由 RNA **声明域**推出轨道的合法取值集合（枚举/布尔）。
 *
 * 为什么取自声明域而不是由调用方传：`legalValues` 是"这条轨道允许哪些值"，
 * 而"该属性允许哪些值"是**属性声明的同一事实**。两处各写一份 ⇒ 枚举项
 * 增删后轨道校验静默失效（插入了声明域外的值，直到采样时才暴露）。
 *
 * 返回 `undefined` = 该类型不做成员校验（数值类由域的范围约束在值 handler 里管）。
 */
function legalValuesOf(desc: PropertyDescriptor): readonly TrackValue[] | undefined {
  const domain = desc.domain
  if (!domain) return undefined
  if (domain.kind === 'enum') return domain.items.map((i) => i.value)
  return undefined
}

/** 动画目标的公共校验：目标存在、可写、类型允许动画。 */function validateAnimationTarget(doc: Document, ref: PropertyRef): DomainError | null {
  if (ref.owner.kind !== 'object') {
    return unsupportedOperation({ ownerKind: ref.owner.kind, property: ref.property })
  }
  const obj = findObject(doc.scene, ref.owner.id)
  if (!obj) return missingTarget({ objectId: ref.owner.id, property: ref.property })
  const data = findObjectData(doc.scene, obj.dataId)
  if (!data) return missingTarget({ dataId: obj.dataId, property: ref.property })
  // 写权按拥有者判定（#249 §3.3）：多方块生成物的**内容**只读。
  if (data.source === 'content') return readOnly({ owner: data.source, objectId: ref.owner.id, property: ref.property })
  // 动画资格（契约 §5.1 `PropertyDescriptor.animatable`）：不可动画的属性不能建轨道，
  // 否则 UI 会提供一个"关键帧按钮点了没反应"的假成功控件（#249 §13 明文禁止）。
  //
  // ## 权威是 **RNA 注册表**（P2 GF-5 收敛后），不是本层的第二张表
  //
  // P1-P4 开发期这里读的是 `doc.types[obj.type].animatableProperties`（文档模型自带的
  // 类型描述）。GF-5 收敛把属性语义的**唯一权威**移到 RNA 注册表（`application/properties`），
  // 内核类型经 `kernel-properties.ts` 注册 —— `doc.types` 已不再是属性词汇的持有者。
  // 若此处仍读旧字段，就会出现"注册表说不可动画、命令层说可以"的两套判据
  // （正是 #250 GF-5 要消除的形态）。故改为向注册表解析描述。
  //
  // `describeProperty` 对未注册属性返回 `UnsupportedOperation`，其错误**原样透出** ——
  // 不折叠成本层的 `propertyNotAnimatable`，否则"未注册"与"已注册但不可动画"
  // 在诊断上会变成同一件事（而两者的处置不同：前者是缺登记，后者是设计如此）。
  const described = describeRnaProperty(kernelPropertyRegistry().registry, ref)
  if (!described.ok) return described.error
  if (!described.value.animatable) {
    return unsupportedOperation({ reason: 'propertyNotAnimatable', property: ref.property, objectType: obj.type })
  }
  return null
}

/**
 * 应用一次动画状态变更：推进内容版本 + 记历史。
 *
 * 与 `reduceSetProperty` 的分工：那条命令走属性写校验（会被轨道驱动拒绝），
 * 本函数走**动画面**（轨道本身的变更）—— 两者都经 `withContent`/`pushHistory`，
 * 因此"内容身份是否真的变了"只有一个判据点（`domain/document`）。
 */
function applyAnimationChange(
  state: ApplicationState,
  doc: Document,
  ctx: EditContext,
  animation: AnimationState,
  label: string,
): Transition {
  const write = withAnimation(doc, animation)
  if (!write.changed) {
    // 内容身份未变（例如插入同时间同值的关键帧）⇒ unchanged，
    // **不**因"新建了容器"而记账（契约 §1.4）。
    return unchanged(write.doc === doc ? state : withDoc(state, write.doc), doc.version)
  }
  const changes = changeSummary({ changedProperties: [], structurallyShared: true })
  const withHistory = recordHistory(write.doc, {
    label,
    beforeScene: doc.scene,
    beforeVersion: doc.version,
    afterScene: doc.scene,
    afterVersion: write.version,
    changes,
    selectionBefore: ctx.selection.selected,
    selectionAfter: ctx.selection.selected,
    beforeAnimation: doc.animation,
    afterAnimation: animation,
  })
  const next = withDocState(state, withHistory, doc.id)
  return applied(next, write.version, changes)
}

/** 把新文档写回状态（动画面用；不碰上下文与租约）。 */
function withDocState(state: ApplicationState, doc: Document, documentId: string): ApplicationState {
  return Object.freeze({ ...state, docs: Object.freeze({ ...state.docs, [documentId]: doc }) })
}

/** 只替换文档值（不推进版本）。 */
function withDoc(state: ApplicationState, doc: Document): ApplicationState {
  return withDocState(state, doc, doc.id)
}

// ─────────────────────────────────────────────────────────────────────────────
// 便捷构造（供接线层与测试；不构成第二写通路 —— 它也是走 reduceCommand）
// ─────────────────────────────────────────────────────────────────────────────

/** 打开一个文档 + 上下文的初始状态，等价于一条 `openDocument` 命令的结果。 */
export function openDocumentState(documentId = 'doc-1', contextId = 'ctx-1', prefix = 'wk'): ApplicationState {
  const t = reduceCommand(
    { docs: {}, contexts: {}, leases: {}, saveLedgers: {}, ids: { prefix, counter: 0 } as IdState, effects: [] },
    { kind: 'openDocument', documentId, contextId },
    defaultExecutionInputs(),
  )
  return t.state
}

/** 便利：状态里 `effects` 的长度（供 A04 效果序列对账）。 */
export function effectCount(state: ApplicationState): number {
  return state.effects.length
}

/** 内容是否与保存基线相同（dirty 的对外呈现；判据在 `domain/document`）。 */
export function isDirtyState(state: ApplicationState, documentId: string): boolean {
  const doc = getDoc(state, documentId)
  if (!doc) return false
  return !sameContent(doc.version, doc.saveBaseline)
}
