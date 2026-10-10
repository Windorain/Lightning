/**
 * `application/queries` —— **语义查询与只读能力**（契约 §2.2 `ReadView`）。
 *
 * ## 这个模块存在的理由（它替代的旧机制）
 *
 * 契约 §2.1：「`read` **不导出**内部 `ApplicationState`、Vue Ref、文档实例字段或渲染对象。
 * ⇒ `ReadView` 的字段全部是**查询方法**，不是数据字段」。
 *
 * 旧机制是 `runtime/context.ts` 的 getter 群：`getDoc()` 直接返回 `Ref<RuntimeDocument>`、
 * `getStructEpoch()` 返回 `Ref<number>`。消费者拿到的不是一个"读面"，而是**权威本身**，
 * 于是可以（也确实）`.value = …` 直接写。本模块的做法是：
 *  - 查询函数接收 `ApplicationState` 作为**显式参数**（纯函数，可独立测试）；
 *  - `ReadView` 把状态**闭包**在里面，只暴露查询方法 —— 结构上无法从 `ReadView` 取回状态；
 *  - 每个查询返回 `Result<T>` 或普通值，**没有**返回 `Ref`/实例的入口。
 *
 * ## 与 P2 的分工
 *
 * `describe` / `read` / `editability` 三个方法在契约 §2.2 里属 `PropertyQueries`。
 * 它们的**类型描述来源**是 RNA（P2 #253 落地 `PropertyDescriptor`）。
 * 本批按契约 §5.3 的精神只提供**骨架 + 已有属性的最小描述**：
 * 不预造 P2 的注册表，也不返回假描述 —— 未注册的属性一律 `UnsupportedOperation`。
 */

import { err, ok, missingTarget, unsupportedOperation, type Result } from '@/domain/errors'
import { samePropertyRef, type EntityRef, type PropertyRef, type Version } from '@/domain/identity'
import { effectiveTransform, type EditContext, type SelectionState, type TimeValue } from '@/domain/editing'
import { findObject, findObjectData, objectsInOrder, type ObjectData, type Scene, type SceneObject, type Transform } from '@/domain/scene'
import type { Document } from '@/domain/document'
import type { ApplicationState } from './state'

// ─────────────────────────────────────────────────────────────────────────────
// 查询函数（显式接受状态；纯）
// ─────────────────────────────────────────────────────────────────────────────

export interface DocumentSummary {
  readonly id: string
  readonly version: Version
  readonly objectCount: number
  readonly dirty: boolean
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly undoLabel: string | null
  readonly redoLabel: string | null
}

export function queryDocument(state: ApplicationState, documentId: string): Result<DocumentSummary> {
  const doc = docOf(state, documentId)
  if (!doc) return err(missingTarget({ documentId }))
  return ok({
    id: doc.id,
    version: doc.version,
    objectCount: Object.keys(doc.scene.objects).length,
    dirty: !sameContentVersion(doc.version, doc.saveBaseline),
    canUndo: doc.history.past.length > 0,
    canRedo: doc.history.future.length > 0,
    undoLabel: doc.history.past.length > 0 ? doc.history.past[doc.history.past.length - 1].label : null,
    redoLabel: doc.history.future.length > 0 ? doc.history.future[doc.history.future.length - 1].label : null,
  })
}

/**
 * 对象查询：返回**值投影**，不是场景/实例。
 *
 * 契约 §5：「大批量几何查询提供只读批量投影或明确借用契约，不能强迫百万次动态属性调用，
 * 也不能暴露可变底层 TypedArray」。本函数返回冻结的小型投影；
 * 大量对象时调用方用 `queryObjects` 一次取回（批量投影），不逐对象往返。
 */
export interface ObjectProjection {
  readonly id: string
  readonly type: string
  readonly name: string
  readonly visible: boolean
  readonly dataId: string
  readonly parentId: string | null
  /** 变换是**冻结副本**，不是场景内部对象的引用。 */
  readonly transform: Transform
  /** 写权（按数据来源判定，#249 §3.3）。 */
  readonly authority: 'writable' | 'readOnly' | 'missing'
}

export function projectObject(scene: Scene, obj: SceneObject): ObjectProjection {
  const data = findObjectData(scene, obj.dataId)
  return Object.freeze({
    id: obj.id,
    type: obj.type,
    name: obj.name,
    visible: obj.visible,
    dataId: obj.dataId,
    parentId: obj.parentId ?? null,
    transform: obj.transform,
    authority: data === undefined ? 'missing' : data.source === 'content' ? 'readOnly' : 'writable',
  })
}

export function queryObject(state: ApplicationState, documentId: string, objectId: string): Result<ObjectProjection> {
  const doc = docOf(state, documentId)
  if (!doc) return err(missingTarget({ documentId }))
  const obj = findObject(doc.scene, objectId)
  if (!obj) return err(missingTarget({ objectId }))
  return ok(projectObject(doc.scene, obj))
}

/** 批量投影（一次调用取回全部对象；供应商不暴露 `Scene` 本身）。 */
export function queryObjects(state: ApplicationState, documentId: string): Result<readonly ObjectProjection[]> {
  const doc = docOf(state, documentId)
  if (!doc) return err(missingTarget({ documentId }))
  return ok(Object.freeze(objectsInOrder(doc.scene).map((o) => projectObject(doc.scene, o))))
}

/** 对象数据投影（只读；不含可变 TypedArray）。 */
export function queryObjectData(state: ApplicationState, documentId: string, dataId: string): Result<ObjectData> {
  const doc = docOf(state, documentId)
  if (!doc) return err(missingTarget({ documentId }))
  const data = findObjectData(doc.scene, dataId)
  if (!data) return err(missingTarget({ dataId }))
  return ok(data)
}

/** 交互查询：活动交互的**有效**变换（两视口读同一份，#249 A05）。 */
export interface InteractionQuery {
  readonly active: boolean
  readonly tool: string | null
  readonly targets: readonly string[]
  readonly stagedCount: number
}

export function queryInteraction(state: ApplicationState, contextId: string): Result<InteractionQuery> {
  const ctx = ctxOf(state, contextId)
  if (!ctx) return err(missingTarget({ contextId }))
  const it = ctx.interaction
  return ok({
    active: it !== null,
    tool: it?.tool ?? null,
    targets: it?.targets ?? Object.freeze([]),
    stagedCount: it ? Object.keys(it.overrides).length : 0,
  })
}

/**
 * **有效**变换查询（`mode: 'effective'` 的交互暂存那一层）。
 *
 * 这个查询是 A05 的关键：它只依赖 `EditContext`，**不依赖任何视口身份** ——
 * 因此两个 Area 各自调用它必然得到同一结果。"只让发起视口读暂存结果"在接口层面
 * 无法表达，因为接口里没有"视口"这个参数。
 */
export function queryEffectiveTransform(state: ApplicationState, contextId: string, objectId: string): Result<Transform> {
  const ctx = ctxOf(state, contextId)
  if (!ctx) return err(missingTarget({ contextId }))
  const doc = docOf(state, ctx.documentId)
  if (!doc) return err(missingTarget({ documentId: ctx.documentId }))
  const t = effectiveTransform(ctx, doc.scene, objectId)
  if (!t) return err(missingTarget({ objectId }))
  return ok(t)
}

/** 选择查询（返回 `EntityRef` 值，不返回 Set/对象）。 */
export function querySelection(state: ApplicationState, contextId: string): Result<SelectionState> {
  const ctx = ctxOf(state, contextId)
  if (!ctx) return err(missingTarget({ contextId }))
  return ok(ctx.selection)
}

/** 上下文摘要（时间、通道取值、活动工具）。 */
export interface ContextSummary {
  readonly id: string
  readonly documentId: string
  readonly time: TimeValue
  readonly channelValues: Readonly<Record<string, number>>
  readonly activeTool: string | null
}

export function queryContext(state: ApplicationState, contextId: string): Result<ContextSummary> {
  const ctx = ctxOf(state, contextId)
  if (!ctx) return err(missingTarget({ contextId }))
  return ok({
    id: ctx.id,
    documentId: ctx.documentId,
    time: ctx.time,
    channelValues: ctx.channelValues,
    activeTool: ctx.activeTool,
  })
}

/** 租约查询（诊断用；A16/C3 观察侧需要知道谁持有）。 */
export function queryLease(state: ApplicationState, documentId: string): Result<string | null> {
  if (!Object.prototype.hasOwnProperty.call(state.docs, documentId)) return err(missingTarget({ documentId }))
  const lease = state.leases[documentId]
  return ok(lease?.holder ?? null)
}

// ─────────────────────────────────────────────────────────────────────────────
// 属性查询（骨架；类型描述来源是 P2 的 RNA）
// ─────────────────────────────────────────────────────────────────────────────

export interface PropertyDescriptor {
  readonly id: string
  readonly valueType: 'number' | 'vec3' | 'quat' | 'string' | 'boolean' | 'enum' | 'color' | 'reference'
  readonly unit?: string
  readonly animatable: boolean
  readonly display: { readonly labelKey: string; readonly fallback?: string }
}

/** 结构属性的最小描述（不预造 P2 的 RNA 注册表）。 */
const STRUCTURAL_DESCRIPTORS: Readonly<Record<string, PropertyDescriptor>> = Object.freeze({
  name: Object.freeze({ id: 'name', valueType: 'string', animatable: false, display: Object.freeze({ labelKey: 'property.name', fallback: 'Name' }) }),
  visible: Object.freeze({ id: 'visible', valueType: 'boolean', animatable: false, display: Object.freeze({ labelKey: 'property.visible', fallback: 'Visible' }) }),
  'transform.position': Object.freeze({
    id: 'transform.position',
    valueType: 'vec3',
    unit: 'm',
    animatable: true,
    display: Object.freeze({ labelKey: 'property.transform.position', fallback: 'Location' }),
  }),
  'transform.rotation': Object.freeze({
    id: 'transform.rotation',
    valueType: 'quat',
    animatable: true,
    display: Object.freeze({ labelKey: 'property.transform.rotation', fallback: 'Rotation' }),
  }),
  'transform.scale': Object.freeze({
    id: 'transform.scale',
    valueType: 'vec3',
    animatable: true,
    display: Object.freeze({ labelKey: 'property.transform.scale', fallback: 'Scale' }),
  }),
})

export function describeProperty(state: ApplicationState, ref: PropertyRef): Result<PropertyDescriptor> {
  const resolved = resolvePropertyTarget(state, ref)
  if (!resolved.ok) return resolved
  const desc = STRUCTURAL_DESCRIPTORS[ref.property]
  if (!desc) {
    // 未登记属性一律显式 UnsupportedOperation —— 不返回假描述（#249 §13 禁止假成功）
    return err(unsupportedOperation({ property: ref.property, ownerId: ref.owner.id }))
  }
  return ok(desc)
}

/** `authored` = 文档基础值；`effective` = 经暂存/动画覆盖后的有效值（契约 §2.2 显式二选一）。 */
export type PropertyReadMode = 'authored' | 'effective'

export type PropertyValue = number | string | boolean | null | Readonly<{ x: number; y: number; z: number }> | Readonly<{ x: number; y: number; z: number; w: number }>

export function readProperty(state: ApplicationState, contextId: string, ref: PropertyRef, mode: PropertyReadMode): Result<PropertyValue> {
  const resolved = resolvePropertyTarget(state, ref)
  if (!resolved.ok) return resolved
  const ctx = ctxOf(state, contextId)
  if (!ctx) return err(missingTarget({ contextId }))
  const doc = docOf(state, ctx.documentId)
  if (!doc) return err(missingTarget({ documentId: ctx.documentId }))

  const obj = findObject(doc.scene, ref.owner.id)
  if (!obj) return err(missingTarget({ objectId: ref.owner.id }))

  if (ref.property === 'name') return ok(obj.name)
  if (ref.property === 'visible') return ok(obj.visible)
  if (ref.property.startsWith('transform.')) {
    const t = mode === 'effective' ? (effectiveTransform(ctx, doc.scene, obj.id) ?? obj.transform) : obj.transform
    const field = ref.property.slice('transform.'.length)
    if (field === 'position') return ok(t.position)
    if (field === 'scale') return ok(t.scale)
    if (field === 'rotation') return ok(t.rotation)
    if (field === 'pivot') return ok(t.pivot)
    return err(unsupportedOperation({ property: ref.property }))
  }
  return err(unsupportedOperation({ property: ref.property, ownerId: ref.owner.id }))
}

/** 可编辑性：**结构化原因**，不是布尔（契约 §2.2：「`editability` 返回结构化原因」）。 */
export type Editability =
  | { readonly kind: 'editable' }
  | { readonly kind: 'readOnly'; readonly owner: string; readonly reason: string }
  | { readonly kind: 'missing'; readonly target: string }

export function editability(state: ApplicationState, ref: PropertyRef): Result<Editability> {
  if (ref.owner.kind !== 'object') {
    return ok({ kind: 'readOnly', owner: ref.owner.kind, reason: 'notAnObjectProperty' })
  }
  // 目标不存在时**不**用 `editability` 报错（它是"可编辑性查询"，不是存在性查询）
  const doc = firstDocument(state)
  if (!doc) return err(missingTarget({ documentId: ref.owner.id }))
  const obj = findObject(doc.scene, ref.owner.id)
  if (!obj) return ok({ kind: 'missing', target: ref.owner.id })
  const data = findObjectData(doc.scene, obj.dataId)
  if (!data) return ok({ kind: 'missing', target: obj.dataId })
  if (data.source === 'content') return ok({ kind: 'readOnly', owner: data.source, reason: 'contentOwned' })
  if (!STRUCTURAL_DESCRIPTORS[ref.property]) {
    return ok({ kind: 'readOnly', owner: 'rna', reason: 'propertyNotRegistered' })
  }
  return ok({ kind: 'editable' })
}

// ─────────────────────────────────────────────────────────────────────────────
// ReadView（闭包持有状态；**不导出**状态本身）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 对象查询组（契约 §2.2 `ObjectQueries`）。
 *
 * 每个方法都返回 `Result<投影>`；**没有任何**方法返回 `Scene`、`SceneObject`
 * 或可变数组 —— 拿到投影也无法就地改文档。
 */
export interface ObjectQueries {
  readonly list: () => Result<readonly ObjectProjection[]>
  readonly get: (objectId: string) => Result<ObjectProjection>
  readonly data: (dataId: string) => Result<ObjectData>
}

/**
 * 属性查询组（契约 §2.2 `PropertyQueries` 逐字三个方法）。
 *
 * 方法名**必须**与契约一致（`describe` / `read` / `editability`），
 * 因为 P2（RNA）按这些名字接线。
 */
export interface PropertyQueries {
  readonly describe: (ref: PropertyRef) => Result<PropertyDescriptor>
  /** `mode` 必须显式二选一，**不得**有隐含默认（契约 §2.2）。 */
  readonly read: (ref: PropertyRef, mode: PropertyReadMode) => Result<PropertyValue>
  readonly editability: (ref: PropertyRef) => Result<Editability>
}

/** 工作区查询组（契约 §2.2 `WorkspaceQueries`；P1 的最小面：文档身份与保存状态）。 */
export interface WorkspaceQueries {
  readonly document: () => Result<DocumentSummary>
  readonly leaseHolder: () => Result<string | null>
}

/** 交互查询组（契约 §2.2 `InteractionQueries`；有效读面在这里）。 */
export interface InteractionQueries {
  readonly state: () => Result<InteractionQuery>
  readonly effectiveTransform: (objectId: string) => Result<Transform>
  readonly selection: () => Result<SelectionState>
  readonly context: () => Result<ContextSummary>
}

/**
 * 只读视图（契约 §2.2 的五个成员，逐字对齐）。
 *
 * `version` 是**数据字段**（契约如此规定：它是"捕获的一致版本"这一事实本身）；
 * 其余四组**全部是查询方法**。状态被闭包在工厂函数里 ——
 * 拿到 `ReadView` 的代码在结构上无法取回 `ApplicationState`、无法取回 `Ref`、
 * 无法取回文档实例。这是契约 §2.1「`read` 不导出内部 `ApplicationState`、
 * Vue Ref、文档实例字段或渲染对象」的可执行形式。
 *
 * ## 为什么四组是嵌套对象而不是把方法摊平
 *
 * 契约 §2.2 就是这么定义的（`objects` / `properties` / `workspace` / `interaction`）。
 * P1 初版曾摊平，结果让 `readonly document: () => Result<DocumentSummary>`
 * 与 **DOM 全局 `document`** 同名 —— 并且真的被本批新建的 DOM 闸门判红了。
 * 那次判红是**真** finding（同名会造成读取歧义），契约的四组结构正好消除它：
 * 文档查询归口 `workspace.document()`。
 */
export interface ReadView {
  readonly version: Version
  readonly objects: ObjectQueries
  readonly properties: PropertyQueries
  readonly workspace: WorkspaceQueries
  readonly interaction: InteractionQueries
}

/**
 * 捕获一个**一致版本**的只读视图。
 *
 * 一致性来源：`state` 是**不可变值**，整个视图生命周期内读到的都是同一个状态对象。
 * 因此订阅者不可能看到「新文档、旧选择、半更新历史」的组合
 * （#249 §2.1 + #252 验收 C1）—— 那个组合在不可变状态里根本不可表达。
 */
export function captureReadView(state: ApplicationState, documentId: string, contextId: string): Result<ReadView> {
  const doc = docOf(state, documentId)
  if (!doc) return err(missingTarget({ documentId }))
  const ctx = ctxOf(state, contextId)
  if (!ctx) return err(missingTarget({ contextId }))
  const version = doc.version
  const view: ReadView = Object.freeze({
    version,
    objects: Object.freeze({
      list: () => queryObjects(state, documentId),
      get: (objectId: string) => queryObject(state, documentId, objectId),
      data: (dataId: string) => queryObjectData(state, documentId, dataId),
    }),
    properties: Object.freeze({
      describe: (ref: PropertyRef) => describeProperty(state, ref),
      read: (ref: PropertyRef, mode: PropertyReadMode) => readProperty(state, contextId, ref, mode),
      editability: (ref: PropertyRef) => editability(state, ref),
    }),
    workspace: Object.freeze({
      document: () => queryDocument(state, documentId),
      leaseHolder: () => queryLease(state, documentId),
    }),
    interaction: Object.freeze({
      state: () => queryInteraction(state, contextId),
      effectiveTransform: (objectId: string) => queryEffectiveTransform(state, contextId, objectId),
      selection: () => querySelection(state, contextId),
      context: () => queryContext(state, contextId),
    }),
  })
  return ok(view)
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部
// ─────────────────────────────────────────────────────────────────────────────

function docOf(state: ApplicationState, id: string): Document | undefined {
  return Object.prototype.hasOwnProperty.call(state.docs, id) ? state.docs[id] : undefined
}

function ctxOf(state: ApplicationState, id: string): EditContext | undefined {
  return Object.prototype.hasOwnProperty.call(state.contexts, id) ? state.contexts[id] : undefined
}

function firstDocument(state: ApplicationState): Document | undefined {
  for (const id of Object.keys(state.docs)) return state.docs[id]
  return undefined
}

function sameContentVersion(a: Version, b: Version): boolean {
  return (a.contentVersion ?? 0) === (b.contentVersion ?? 0)
}

/** 解析属性目标的所属文档（属性引用只带 owner，不带文档 id）。 */
function resolvePropertyTarget(state: ApplicationState, ref: PropertyRef): Result<{ documentId: string }> {
  if (ref.owner.kind === 'document') {
    if (!docOf(state, ref.owner.id)) return err(missingTarget({ documentId: ref.owner.id }))
    return ok({ documentId: ref.owner.id })
  }
  if (ref.owner.kind === 'object' || ref.owner.kind === 'objectData') {
    for (const [docId, doc] of Object.entries(state.docs)) {
      if (ref.owner.kind === 'object' && findObject(doc.scene, ref.owner.id)) return ok({ documentId: docId })
      if (ref.owner.kind === 'objectData' && findObjectData(doc.scene, ref.owner.id)) return ok({ documentId: docId })
    }
    return err(missingTarget({ ownerKind: ref.owner.kind, ownerId: ref.owner.id }))
  }
  // 编辑上下文/工作区/资源不属本查询面
  return err(unsupportedOperation({ ownerKind: ref.owner.kind }))
}

/** 两个属性引用是否指向同一目标（转发 `domain/identity`，供下游对账）。 */
export const sameProperty = samePropertyRef

/** 未使用参数占位（保持类型导出可被下游引用）。 */
export type { EntityRef }
