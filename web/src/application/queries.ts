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
import {
  authoredValue,
  findTrack,
  propertyKey,
  resolveEffectiveValue,
  sampleTrack,
  type EffectiveValueLayer,
  type TrackValue,
} from '@/domain/animation'
import type { Document } from '@/domain/document'
import type { ApplicationState } from './state'
import { localPropertyOf } from './contracts'
import {
  describeProperty as describeRnaProperty,
  evaluateEditability as evaluateRnaEditability,
  readProperty as readRnaProperty,
  type Editability,
  type PropertyValue,
  type PropertyDescriptor,
  type ReadMode,
} from './properties'
import { kernelAccessOf, kernelPropertyRegistry } from './kernel-properties'
import { ALL_CAPABILITIES } from './commands'

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
// 有效值查询（P4：把「有效值优先级」接到读面上）
//
// 机制与 `staged` 层由 P2 的 `EffectiveSources` 承载（`application/properties`）；
// P4 负责供给另外两层：`preview`（编辑上下文手动预览值）与 `trackSampled`
// （已启用轨道的时间采样）。**不存在第二套有效值实现** —— 见下方 `readProperty`。
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 属性查询 —— 描述与读取**全部来自 RNA 注册表**（#250 GF-5 收敛项 1/2）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `PropertyDescriptor` —— **唯一权威是 `application/properties`**。
 *
 * 本文件曾本地定义一份窄化版本（`valueType` 是封闭的 8 项联合、没有 `domain`/`nullable`），
 * 与 RNA 的完整描述**同名不同义**。那不是"两处实现同一个概念"，而是
 * **两套不兼容的描述**：按 `queries.ts` 的定义，`number` 与 `vec3` 之外的信息无法表达
 * （单位、合法域、引用类型、可空性），UI 只能拿到描述的一半。
 * 收敛后本文件只再导出 RNA 的定义。
 */
export type { PropertyDescriptor }

/**
 * `PropertyValue` —— **唯一权威是 `application/properties`**。
 *
 * 本文件曾本地定义一份（缺 `ColorValue`/`ReferenceValue`/`string[]`/`ExtensionValue`），
 * 使"读面能返回的值"比"写面能接受的值"窄 —— 扩展类型的值经读面会被类型系统判为非法。
 */
export type { PropertyValue }

/**
 * 结构属性的描述**来自注册表**，不再是本文件的第二份表。
 *
 * 本文件曾有 `STRUCTURAL_DESCRIPTORS`（`name`/`visible`/`transform.position|rotation|scale`
 * 五条的硬编码描述），与 RNA 注册表并存。它已被删除：
 * `describeProperty` 现在查 `kernelPropertyRegistry()`，
 * 于是「未注册属性返回 `UnsupportedOperation`」与「已注册属性的单位/域/动画资格」
 * 来自**同一份权威**，不再有两套描述谁先命中的问题。
 *
 * 注意 `transform.pivot` 就在这次收敛中暴露了旧表的缺口：旧表没有它，
 * 而 RNA 声明有 —— 旧实现下 `describe('transform.pivot')` 会报"未注册"，
 * 尽管写面（`applyPropertyValue`）确实支持它。这个不一致正是"两份描述"的必然结果。
 */

export function describeProperty(state: ApplicationState, ref: PropertyRef): Result<PropertyDescriptor> {
  const resolved = resolvePropertyTarget(state, ref)
  if (!resolved.ok) return resolved
  // 描述由 RNA 注册表解析（含 objectTypeId 与 owner.kind 的一致性校验）。
  return describeRnaProperty(kernelPropertyRegistry().registry, ref)
}

/** `authored` = 文档基础值；`effective` = 经暂存/动画覆盖后的有效值（契约 §2.2 显式二选一）。 */
export type PropertyReadMode = ReadMode

/**
 * 读一个属性值 —— 经**同一份** RNA 值 handler（含分量寻址与有效值优先级）。
 *
 * `mode === 'effective'` 时的覆盖层来自编辑上下文的交互暂存（`interaction.overrides`），
 * 与 `interaction.effectiveTransform` 共用同一状态，因此两个读面不可能给出互相矛盾的有效值。
 */
export function readProperty(
  state: ApplicationState,
  contextId: string,
  ref: PropertyRef,
  mode: PropertyReadMode,
): Result<PropertyValue> {
  const resolved = resolvePropertyTarget(state, ref)
  if (!resolved.ok) return resolved
  const ctx = ctxOf(state, contextId)
  if (!ctx) return err(missingTarget({ contextId }))
  const doc = docOf(state, ctx.documentId)
  if (!doc) return err(missingTarget({ documentId: ctx.documentId }))
  const access = kernelAccessOf(doc, contextId, ALL_CAPABILITIES, true)
  if (mode === 'authored') return readRnaProperty(kernelPropertyRegistry().registry, ref, 'authored', access)
  // 有效值四层（#249 §7）：`authored`（RNA `readRaw`）→ `preview` → `trackSampled` → `staged`。
  // P2 提供机制与 `staged` 层；**P4 提供 `preview` 与 `trackSampled`** 两层，
  // 于是"读有效值"仍只有一处实现（不新增第二套优先级）。
  const sources = effectiveSourcesOf(ctx, doc, ref)
  return readRnaProperty(kernelPropertyRegistry().registry, ref, 'effective', access, sources)
}

/**

/**
 * **有效值来源的层供给**（P4 的接缝面，`#255`）。
 *
 * ## 为什么在这里而不是在 `properties.ts`
 *
 * `properties.ts` 是 RNA 的**机制**层（优先级与校验），它不该知道"轨道存在哪"；
 * "轨道存在 `doc.animation`、通道手动值存在 `ctx.channelValues`"是本内核的
 * **状态事实**，归本文件（读面接线）。于是机制与状态的边界与 P2 的
 * `kernelAccessOf`（事实供给）同形。
 *
 * ## 只供给**有值**的层
 *
 * 可选字段缺省 = "该层没有值"。**不**用 `undefined` 显式占位后仍传键 ——
 * `resolveEffectiveValue` 判的是 `sources.x !== undefined`，多传一个 `undefined`
 * 与不传等价，但传 `null` 会被当作"有值且值为 null"（合法属性值），两者语义不同。
 */
function effectiveSourcesOf(ctx: EditContext, doc: Document, ref: PropertyRef): EffectiveSources {
  const sources: { preview?: PropertyValue; trackSampled?: PropertyValue; staged?: PropertyValue } = {}

  // ② 编辑上下文手动预览值（通道面；`EditContext.channelValues` 按通道键索引）
  const channelKey = channelKeyOf(ref.property)
  if (channelKey !== null && ctx.channelValues[channelKey] !== undefined) {
    sources.preview = ctx.channelValues[channelKey]
  }

  // ③ 已启用轨道的时间采样（给定时间直接求值，无累积量）
  const track = findTrack(doc.animation, ref)
  if (track && track.enabled) {
    const sampled = sampleTrack(track, ctx.time)
    if (sampled.ok) sources.trackSampled = sampled.value.value as PropertyValue
    // 采样失败（非法轨道）**不**吞掉：让 `authored` 层的结果如实返回，
    // 而轨道数据本身的合法性由 `insertKeyframe` 在写入点保证。
  }

  // ④ 活动编辑操作的暂存覆盖
  if (ref.owner.kind === 'object') {
    const staged = stagedValueOf(ctx, doc, ref)
    if (staged !== undefined) sources.staged = staged
  }

  return sources
}

/**
 * 通道键提取：限定式属性 ID `<objectTypeId>.channel.<key>` 与未限定的 `channel.<key>`
 * 都要认（前者是 RNA 限定式口径，后者是 `domain/multiblock#channelToPropertyRef` 的
 * 内容拥有者口径 —— 多方块通道不是内核注册对象类型）。
 */
function channelKeyOf(property: string): string | null {
  const marker = 'channel.'
  const at = property.indexOf(marker)
  if (at === -1) return null
  // 只接受"开头"或"紧跟一个点"的形态，避免命中 `xchannel.y` 这类子串。
  if (at !== 0 && property[at - 1] !== '.') return null
  return property.slice(at + marker.length)
}
 * 交互相对于该属性的暂存值（`mode === 'effective'` 的输入）。
 *
 * 暂存按**对象**记录（`interaction.overrides[objectId]` 是一整个 `Transform`），
 * 故只有 `transform.*` 属性能从中取值；其余属性无暂存层，读面回落到基础值。
 */
function stagedValueOf(ctx: EditContext, doc: Document, ref: PropertyRef): PropertyValue | undefined {
  if (ctx.interaction === null) return undefined
  const override = ctx.interaction.overrides[ref.owner.id]
  if (!override) return undefined
  const local = localPropertyOf(ref.property, ref.owner.kind === 'object' ? objectTypeOf(doc, ref.owner.id) : undefined)
  if (!local.startsWith('transform.')) return undefined
  const field = local.slice('transform.'.length) as 'position' | 'rotation' | 'scale' | 'pivot'
  return override[field]
}

/** 对象在文档里的类型（供 `localPropertyOf` 剥离限定前缀时的 objectTypeId）。 */
function objectTypeOf(doc: Document, objectId: string): string | undefined {
  return findObject(doc.scene, objectId)?.type
}

/**
 * 可编辑性 —— 由**当前状态与能力**求值（#249 §6），走 RNA 的同一函数。
 *
 * 本文件曾有第二个 `editability`（返回 `{kind: 'editable'|'readOnly'|'missing'}`），
 * 与 RNA 的 `{editable, reason, because}` **形态不同**。两个可编辑性求值必然漂移，
 * 且窄形态丢掉了 `because`（参与求值的动态事实）—— 那正是 A08「动态性」判据要断言的东西。
 * 收敛后本文件再导出 RNA 的 `Editability`，`ReadView` 的 `properties.editability`
 * 返回同一形态。
 */
export type { Editability }

export function editability(state: ApplicationState, ref: PropertyRef): Result<Editability> {
  const resolved = resolvePropertyTarget(state, ref)
  if (!resolved.ok) return resolved
  const ctx = contextOfOwner(state, ref)
  const doc = ctx ? docOf(state, ctx.documentId) : firstDocument(state)
  if (!doc) return err(missingTarget({ documentId: ref.owner.id }))
  const access = kernelAccessOf(doc, ctx?.id ?? '', ALL_CAPABILITIES, true)
  return ok(evaluateRnaEditability(kernelPropertyRegistry().registry, ref, access))
}

/** 该引用所属文档上绑定的编辑上下文（用于租约与暂存事实）。 */
function contextOfOwner(state: ApplicationState, ref: PropertyRef): EditContext | undefined {
  for (const ctx of Object.values(state.contexts)) {
    const doc = docOf(state, ctx.documentId)
    if (doc && ref.owner.kind === 'object' && findObject(doc.scene, ref.owner.id)) return ctx
  }
  return undefined
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
  /**
   * **有效属性值**（P4 增补）—— 四层优先级的唯一读面入口。
   *
   * 与 `effectiveTransform` 的关系：后者是"只要变换、只要暂存那两层"的窄查询
   * （P1 为 A05 引入）；本方法覆盖完整优先级（含轨道采样与发布默认值）。
   * 保留两个入口而不是合并成一个，是因为 `effectiveTransform` 的返回类型是
   * `Transform`（整变换）而本方法按 `PropertyRef` 逐属性 ——
   * 合并会让"取整变换"退化成多次属性查询，属于用接口美观换性能。
   */
  readonly effectiveProperty: (ref: PropertyRef) => Result<EffectivePropertyValue>
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
      effectiveProperty: (ref: PropertyRef) => queryEffectiveProperty(state, contextId, ref),
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
