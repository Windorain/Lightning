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
import { findObject, findObjectData, objectsInOrder, type ObjectData, type ObjectDataPayload, type Scene, type SceneObject, type Transform } from '@/domain/scene'
import {
  findTrack,
  highestEffectiveLayer,
  sampleTrack,
  type EffectiveValueLayer,
} from '@/domain/animation'
import type { Document } from '@/domain/document'
import type { ApplicationState } from './state'
import { localPropertyOf } from './contracts'
import {
  describeProperty as describeRnaProperty,
  evaluateEditability as evaluateRnaEditability,
  readProperty as readRnaProperty,
  type Editability,
  type EffectiveSources,
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

/**
 * **播放状态读面**（R-WK-03 内核缺口补齐）。
 *
 * ## 为什么是独立查询组，而不是塞进 `ContextSummary`
 *
 * `ContextSummary` 的语义是"这个上下文当前长什么样"（值快照）；
 * 播放读面要回答的是"时间在不在走、以什么倍率走、走完这一段之后到哪"
 * —— 后者是**驱动者**（宿主帧编排）的输入，不是呈现的展示字段。
 * 混进 `ContextSummary` 会让每个展示型消费者都被迫携带播放语义。
 *
 * ## `playing` 与 `time` 的一致性
 *
 * `time` 与 `playing` 都从**同一个** `EditContext` 读，故不存在
 * "读到 playing=true 却配一个旧时间"的组合（`captureReadView` 闭包的是
 * 同一份不可变状态）。
 */
export interface PlaybackQuery {
  readonly playing: boolean
  readonly rate: number
  readonly time: TimeValue
}

export function queryPlayback(state: ApplicationState, contextId: string): Result<PlaybackQuery> {
  const ctx = ctxOf(state, contextId)
  if (!ctx) return err(missingTarget({ contextId }))
  return ok({ playing: ctx.playing, rate: ctx.playbackRate, time: ctx.time })
}

/**
 * **相机读面**（接缝 B；R-WK-03 明列的 `ReadView` 缺口）。
 *
 * ## 为什么相机是"文档相机"而不是"观察视角"
 *
 * #249 §3.1 把两者分开：**相机参数**（投影/fov/裁剪面）属**文档**，
 * **观察视角**（yaw/elevation/distance）属 **3D 编辑器实例**（各实例独立）。
 * `ReadView` 是**文档与上下文**的读面 —— 它没有、也不该有"哪个视口在看"
 * 这个参数。故本查询只回答"文档里这个相机对象声明了什么"。
 *
 * 观察视角的读面在接线层（`runtime/viewportCamera`），不在这里 ——
 * 把它加进来会让"两视口机位独立"无法表达（同一 `ReadView` 只有一个机位）。
 *
 * ## 为什么现在补它（P10 的删除前置）
 *
 * `raw-authority-object` 接缝的消费者里有 embed 初始视角一族
 * （`context/captureEmbedInitialView.ts`、`operators/builtin/embedInitialViewOperators.ts`），
 * 它们要读"文档里有没有一个相机、它的参数是什么"。缺这条查询时，
 * 迁移只能伪造一个不存在的读面 —— 那正是 #1 负对照要判红的形态。
 * 补齐后这些消费者才有真实的新读面可依赖。
 */
export interface CameraProjection {
  readonly objectId: string
  readonly name: string
  /**
   * 投影参数 —— **可选**（R1-β① C3；**GF-21 乙**）。
   *
   * 缺省 = 文档**未声明**该参数，读面**如实缺席**。它曾经不可选：装配把
   * `meta.embed_initial_view`（观察视角）造成相机对象时硬编码了
   * `perspective`/`50`/`0.1`/`1000`，而这条读面把常量当真实参数交出 —— 读到的是伪造值。
   * 现在"未声明"与"声明了某值"在类型上就可区分。
   */
  readonly projection?: 'perspective' | 'orthographic'
  readonly fov?: number
  readonly clipStart?: number
  readonly clipEnd?: number
}

/** 相机载荷 → 读面投影：**只**转发文档真正声明的字段（缺席即省略；GF-21 乙）。 */
function cameraProjectionOf(obj: { readonly id: string; readonly name: string }, p: Extract<ObjectDataPayload, { kind: 'camera' }>): CameraProjection {
  return Object.freeze({
    objectId: obj.id,
    name: obj.name,
    ...(p.projection === undefined ? {} : { projection: p.projection }),
    ...(p.fov === undefined ? {} : { fov: p.fov }),
    ...(p.clipStart === undefined ? {} : { clipStart: p.clipStart }),
    ...(p.clipEnd === undefined ? {} : { clipEnd: p.clipEnd }),
  })
}

export function queryCamera(state: ApplicationState, documentId: string, objectId: string): Result<CameraProjection> {
  const doc = docOf(state, documentId)
  if (!doc) return err(missingTarget({ documentId }))
  const obj = findObject(doc.scene, objectId)
  if (!obj) return err(missingTarget({ objectId }))
  const data = findObjectData(doc.scene, obj.dataId)
  if (!data || data.payload.kind !== 'camera') return err(missingTarget({ dataId: obj.dataId, objectId }))
  return ok(cameraProjectionOf(obj, data.payload))
}

/**
 * 文档里的**相机对象**清单（稳定顺序）。
 *
 * 与 `objects.list()` 的关系：后者返回全部对象投影（含写权、变换），
 * 本查询只回答"哪些对象是相机" —— embed 初始视角一族要的正是这件事，
 * 让它们去 `objects.list()` 里逐条按 `type` 过滤会把"什么是相机"
 * 这条判据复制到每个消费者（而判据必须只有一个来源）。
 */
export function queryCameras(state: ApplicationState, documentId: string): Result<readonly CameraProjection[]> {
  const doc = docOf(state, documentId)
  if (!doc) return err(missingTarget({ documentId }))
  const out: CameraProjection[] = []
  for (const obj of objectsInOrder(doc.scene)) {
    const data = findObjectData(doc.scene, obj.dataId)
    if (!data || data.payload.kind !== 'camera') continue
    out.push(cameraProjectionOf(obj, data.payload))
  }
  return ok(Object.freeze(out))
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
 * 有效值读数：值 + **来源标签** + 是否被轨道驱动。
 *
 * `value` 的权威是 RNA 读面；`source` 的权威是 `domain/animation` 的唯一优先级表
 * （见 `queryEffectiveProperty` 的说明）。两者不是同一件事的两份拷贝。
 */
export interface EffectivePropertyValue {
  readonly value: PropertyValue
  readonly source: EffectiveValueLayer['kind']
  readonly driven: boolean
}

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
 * **有效值来源的层供给**（P4 的接缝面，`#255`）。
 *
 * ## 本文件供给 `trackSampled` 与 `staged` 两层
 *
 * P2 的 `EffectiveSources` 有四层。分工：
 *
 *  - ① 文档基础值 —— 由 RNA 的 `readRaw` 提供（`kernelAccessOf`）；
 *  - ② 手动预览值 —— **适用通道**（`EditContext.channelValues`）。通道不是内核
 *    注册对象类型（它是**内容拥有者** `objectData`，见 `domain/multiblock`），
 *    RNA 描述不了它，故这一层不在本文件供给 —— 见下方说明；
 *  - ③ 已启用轨道的时间采样 —— **P4 在本函数供给**；
 *  - ④ 活动编辑操作的暂存覆盖 —— 本函数供给（`interaction.overrides`）。
 *
 * ## 通道为什么走另一条路（`domain/multiblock#resolveChannelEffective`）
 *
 * 通道的拥有者是**内容**（多方块生成物），不是内核对象类型；把它塞进 RNA 就得给
 * 内容伪造一个对象类型注册，而 #249 §3.3 要求"生成物只读、不编辑生成结果"。
 * 故通道的有效值由 `domain/multiblock` 的纯解析器给出 —— 它**用的是同一张
 * 优先级表**（`domain/animation#resolveEffectiveValue` 的 `LAYER_RANK`），
 * 只是把四层都接上（含 ② 通道手动预览）。P6 在提供 `ChannelSet` 时接上它。
 *
 * ⇒ 这里**不**为通道写第二条优先级实现：要么经 RNA（本函数），要么经
 * `resolveChannelEffective`（通道）。两条路共用优先级表，故不会给出互相矛盾的有效值。
 *
 * ## 只供给**有值**的层
 *
 * 可选字段缺省 = "该层没有值"。**不**用 `undefined` 显式占位后仍传键 ——
 * `resolveEffectiveValue` 判的是 `sources.x !== undefined`，多传一个 `undefined`
 * 与不传等价，但传 `null` 会被当作"有值且值为 null"（合法属性值），两者语义不同。
 */
function effectiveSourcesOf(ctx: EditContext, doc: Document, ref: PropertyRef): EffectiveSources {
  const sources: { trackSampled?: PropertyValue; staged?: PropertyValue } = {}

  // ③ 已启用轨道的时间采样（给定时间直接求值，**无累积量** —— #249 §7
  //    "禁止材质/视口自行累计 tick" 的结构性保证：本函数只吃 ctx.time）。
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
 * 有效值读数（含**来源**与"是否被驱动"）。
 *
 * ## `value` 与 `source` 各有唯一权威（刻意分工，不是重复计算）
 *
 *  - `value` 来自 `readProperty(…, 'effective')` —— RNA 的读面是值的**唯一**实现
 *    （含每层的 handler 校验与分量投影）；
 *  - `source` 是**标签**，由 `domain/animation#highestEffectiveLayer` 的**唯一优先级表**
 *    选出（`LAYER_RANK`）。**不新增第二张优先级表**。
 *
 * 两者由同一组 `EffectiveSources` 驱动，故不可能"值来自轨道、标签说来自暂存"。
 * 若某一层存在但校验失败，`readProperty` 返回错误且本函数**原样透出** ——
 * 不给"被拒绝的值"配一个成功的来源标签。
 */
export function queryEffectiveProperty(
  state: ApplicationState,
  contextId: string,
  ref: PropertyRef,
): Result<EffectivePropertyValue> {
  const ctx = ctxOf(state, contextId)
  if (!ctx) return err(missingTarget({ contextId }))
  const doc = docOf(state, ctx.documentId)
  if (!doc) return err(missingTarget({ documentId: ctx.documentId }))
  const value = readProperty(state, contextId, ref, 'effective')
  if (!value.ok) return value
  const sources = effectiveSourcesOf(ctx, doc, ref)
  const track = findTrack(doc.animation, ref)
  return ok(
    Object.freeze({
      value: value.value,
      source: effectiveSourceOf(sources),
      driven: track !== undefined && track.enabled,
    }),
  )
}

/** 用 `domain/animation` 的**唯一优先级表**给有效值贴来源标签（无覆盖层 ⇒ `base`）。 */
function effectiveSourceOf(sources: EffectiveSources): EffectiveValueLayer['kind'] {
  const present: EffectiveValueLayer['kind'][] = []
  if (sources.preview !== undefined) present.push('manualPreview')
  if (sources.trackSampled !== undefined) present.push('trackSample')
  if (sources.staged !== undefined) present.push('stagingOverride')
  // 无覆盖层 ⇒ 有效值就是基础值。`resolveEffectiveValue` 对空集合返回错误是**对的**
  // （它表达"没有任何覆盖层"），故这里显式回落到 `base` 而不是把错误当成失败。
  return highestEffectiveLayer(present) ?? 'base'
}

/**
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
  /**
   * **播放状态**（R-WK-03 补齐的内核缺口；见 `PlaybackQuery`）。
   *
   * 归本组（而非 `workspace`）的理由：播放是**上下文**的从属事实
   * （与 `context`/`selection`/`effectiveProperty` 同域），
   * 而 `workspace` 组承载文档身份与保存状态。
   */
  readonly playback: () => Result<PlaybackQuery>
}

/**
 * 文档相机查询组（接缝 B：`ReadView` 的相机读面）。
 *
 * ## 为什么相机单独成组而不是并进 `ObjectQueries`
 *
 * `ObjectQueries` 回答"有哪些对象、它是什么"（通用对象读面）；
 * 相机读面回答的是**类型特定能力**（投影/fov/裁剪面）——
 * #249 §13 第 1 条要求"统一对象身份与**类型特定能力**可演示"。
 * 把类型特定字段摊进通用投影，等于让 `ObjectProjection` 变成
 * "所有类型的字段并集"（那正是 A21 禁止的"核心为每个新类型加字段"）。
 * 单独成组后，新增类型只需贡献自己的读面组，不动通用投影。
 */
export interface CameraQueries {
  readonly list: () => Result<readonly CameraProjection[]>
  readonly get: (objectId: string) => Result<CameraProjection>
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
  /**
   * **类型特定能力读面：相机**（接缝 B）。
   *
   * 与 `interaction.playback` 一样，它是 P10 为退役 `raw-authority-object`
   * 消费者而补的真实读面 —— 缺它时消费者只能伪造查询。
   */
  readonly cameras: CameraQueries
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
      playback: () => queryPlayback(state, contextId),
    }),
    cameras: Object.freeze({
      list: () => queryCameras(state, documentId),
      get: (objectId: string) => queryCamera(state, documentId, objectId),
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
