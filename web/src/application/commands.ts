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
  addAnnotationObject,
  addBlockObject,
  addCameraObject,
  addMeshObject,
  beginSave,
  completeSave,
  createDocument,
  createSaveLedger,
  pushHistory,
  redo as redoDoc,
  undo as undoDoc,
  withScene,
  type Document,
  type SaveLedger,
  type SaveOutcome,
} from '@/domain/document'
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
import { type PropertyValue } from './properties'
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
  readonly objectType: 'block' | 'annotation' | 'camera' | 'mesh'
  readonly name?: string
  readonly annotationShape?: 'box' | 'point' | 'line' | 'text' | 'face'
  /** 网格尺寸（仅 `objectType: 'mesh'`；缺省 1 场景单位）。 */
  readonly meshSize?: number
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
  return Object.freeze({ capabilities })
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
    case 'addObject':
      return reduceAddObject(state, command)
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
  if (!(cmd.time.fps > 0)) return rejected(state, invalidValue({ reason: 'fpsMustBePositive', fps: cmd.time.fps }))
  if (ctx.time.frame === cmd.time.frame && ctx.time.fps === cmd.time.fps) return unchanged(state, doc.version)
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

function reduceAddObject(state: ApplicationState, cmd: AddObjectCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  const lease = acquireFor(state, doc.id, cmd.contextId)
  if (!lease.ok) return rejected(state, lease.error)

  const a1 = allocateId(state.ids, 'object')
  const a2 = allocateId(a1.next, 'data')
  const ref = objectRef(a1.id, a2.next.counter)
  const scene = doc.scene
  let nextScene: Scene | null
  if (cmd.objectType === 'mesh') {
    // 网格（#254 P3）：构造会校验几何参数，故失败原因是**多种**的
    // （尺寸非法 / id 冲突），不压成同一个 `null`（#249 §5「不能用默认值掩盖缺失」）。
    const made = addMeshObject(scene, {
      objectId: a1.id,
      dataId: a2.id,
      ...(cmd.name === undefined ? {} : { name: cmd.name }),
      ...(cmd.meshSize === undefined ? {} : { size: cmd.meshSize }),
    })
    if (!made.ok) return rejected(state, made.error)
    nextScene = made.value
  } else {
    switch (cmd.objectType) {
      case 'block':
        nextScene = addBlockObject(scene, { objectId: a1.id, dataId: a2.id, ...(cmd.name === undefined ? {} : { name: cmd.name }) })
        break
      case 'annotation':
        nextScene = addAnnotationObject(scene, {
          objectId: a1.id,
          dataId: a2.id,
          ...(cmd.name === undefined ? {} : { name: cmd.name }),
          ...(cmd.annotationShape === undefined ? {} : { shape: cmd.annotationShape }),
        })
        break
      case 'camera':
        nextScene = addCameraObject(scene, { objectId: a1.id, dataId: a2.id, ...(cmd.name === undefined ? {} : { name: cmd.name }) })
        break
    }
  }
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
