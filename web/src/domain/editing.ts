/**
 * `domain/editing` —— **EditContext、交互事务、文档级修改租约**。
 *
 * ## 本模块替代的旧机制（业务面）
 *
 * 旧实现把通道取值与暂存放在**每个视口各自的 composable** 里
 * （`shared/viewport/useMultiblockChannels.ts` 每视口自持 `state` + `revision`），
 * 于是「同上下文所有 Area 可见的有效读面」并不存在 —— 每个视口只能读到自己那份。
 * 本模块把「选择 / 活动对象 / 时间 / 通道取值 / 活动工具 / 活动交互暂存」收进
 * **一个** `EditContext`，它对同一上下文的所有 Area 是**同一份**值，
 * 从而「松手前两视口有效坐标相同」在类型层面就成立。
 *
 * ## 三条硬要求及其落点
 *
 * ### 交互暂存不整文档复制
 * `InteractionState.overrides` 是 `Readonly<Record<string, Transform>>` —— 只存**被改动的
 * 对象**的新变换，文档 `Scene` 本身**引用不变**。`stagingFootprint()` 如实报告
 * "暂存对象数 / 文档对象总数"，使"暂存有实现证据"可测量而非口头声明。
 *
 * ### 无漂移
 * 「累积移动以**起点加总位移**计算，避免反复对上一步结果应用造成漂移」。
 * ⇒ `updateInteraction` 接收的是**自起点的总位移**，并始终把它应用到 `startTransforms`
 * 上。把同一个总位移连续应用两次结果相同（幂等），这就是"无漂移"的可执行判据。
 *
 * ### 拒绝 / 取消零残留
 * `cancelInteraction` / `rejectInteraction` 只清空 `interaction`，**不碰文档**：
 * `documentVersion`、`contentVersion`、历史、脏状态全部不变。
 */

import {
  documentBusy,
  invalidValue,
  missingTarget,
  type DomainError,
  type Result,
  ok,
  err,
} from './errors'
import { entityRef, digestOf, type EntityRef, type Version } from './identity'
import {
  findObject,
  sameTransform,
  type Scene,
  type SceneObject,
  type Transform,
} from './scene'
import { documentEntityRef, type Document } from './document'

// ─────────────────────────────────────────────────────────────────────────────
// 时间（归 EditContext、由输入注入；有理帧率）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 时间值 —— **由 `domain/animation` 权威定义**（「时间以可序列化时间值及
 * 有理帧率表达」）。
 *
 * 本模块曾定义一个 `{frame: number; fps: number}` 的最小形态，并明确
 * 「完整的有理帧率与采样策略归动画层」。真正的定义在
 * `domain/animation`，本模块**重新导出**它，使既有消费者（`application/commands`、
 * `application/queries`、`domain/editing` 自身）的导入路径无需改动。
 *
 * `fps` 从 `number` 放宽为 `FrameRateSpec`（`number | {num, den}`）——这是**加宽**，
 * 既有的 `fps: 20` 写法仍然完全合法（见 `frameRateOf`）。故不存在"旧值变成非法"的迁移问题。
 */
import {
  advancePlayhead,
  advanceTime,
  createPlayhead,
  framesPerSecond,
  sameTime,
  timeValue,
  type FrameRate,
  type FrameRateSpec,
  type Playhead,
  type TimeValue,
} from './animation'

export type { FrameRate, FrameRateSpec, Playhead, TimeValue }

export const TIME_ZERO: TimeValue = Object.freeze({ frame: 0, fps: 20 })

export { timeValue }

// ─────────────────────────────────────────────────────────────────────────────
// EditContext
// ─────────────────────────────────────────────────────────────────────────────

/** 选择状态（值语义；引用是 `EntityRef`，不含对象指针）。 */
export interface SelectionState {
  readonly selected: readonly EntityRef[]
  readonly active: EntityRef | null
  readonly mode: 'single' | 'box' | 'type' | 'annotation'
}

export const EMPTY_SELECTION: SelectionState = Object.freeze({
  selected: Object.freeze([]),
  active: null,
  mode: 'single',
})

/**
 * 活动交互的暂存。
 *
 * `startTransforms` 是该次交互**开始时**各目标的变换（起点语义的锚）；
 * `overrides` 是当前有效值（= 起点 + 总位移）。两者都只含**目标对象**。
 */
export interface InteractionState {
  readonly tool: string
  readonly targets: readonly string[]
  /** 起点版本：提交时据此校验（「起点版本、目标身份…显式记录」）。 */
  readonly startVersion: Version
  readonly startTransforms: Readonly<Record<string, Transform>>
  readonly overrides: Readonly<Record<string, Transform>>
  /** 当前总位移（自起点，不是自上一帧）。 */
  readonly totalDisplacement: { readonly x: number; readonly y: number; readonly z: number }
}

/**
 * 编辑上下文：同一工作区默认共享的编辑状态域。
 *
 * **不含**观察视角/局部显示 —— 那些属 3D 编辑器实例，各实例独立。
 * 把机位放进来会让"两个 Area 共享选择但机位独立"无法表达。
 */
export interface EditContext {
  readonly id: string
  /** 绑定/观察的文档 id。多个上下文可绑定同一文档。 */
  readonly documentId: string
  readonly selection: SelectionState
  readonly time: TimeValue
  /**
   * **是否正在播放**（播放状态归 `EditContext`，不归宿主）。
   *
   * ## 为什么归 `EditContext` 而不是宿主（替代旧 `Main.framesPlaybackIsPlaying`）
   *
   * **时间**归编辑上下文，且同一上下文的多个 Area
   * **共享当前时间**；播放是时间的**从属事实**（"时间要不要自己走"），
   * 不是某个视口的私有属性。把它放宿主（或放视口）会直接得到
   * 「双视口各播各的」—— 那正是「两视口有效坐标相同」要判红的形态。
   *
   * ## 它与 `time` 的关系（**不是**第二份时间权威）
   *
   * `time` 仍是时间的**唯一**权威；本字段只说"它是否随注入的 delta 前进"。
   * 二者由 {@link playheadOf} 合成一个 `Playhead` 视图（`domain/animation` 的类型），
   * 因此不存在"两处各存一份时间"的可能。
   */
  readonly playing: boolean
  /**
   * 常量播放倍率（1 = 原速）。`0` 合法 —— 等于"playing 但时间不动"，
   * 与 `domain/animation#Playhead.rate` 同一语义（速度是常量，
   * 当前**不**接受轨道驱动的速度）。
   */
  readonly playbackRate: number
  /** 通道取值（手动预览值属编辑上下文）。 */
  readonly channelValues: Readonly<Record<string, number>>
  readonly activeTool: string | null
  /** 活动交互暂存；`null` = 无活动交互。 */
  readonly interaction: InteractionState | null
}

export function createEditContext(id: string, documentId: string): EditContext {
  return Object.freeze({
    id,
    documentId,
    selection: EMPTY_SELECTION,
    time: TIME_ZERO,
    // 默认**暂停**（「默认暂停随场景」）：新建上下文不会自己开始走时间。
    playing: false,
    playbackRate: 1,
    channelValues: Object.freeze({}),
    activeTool: null,
    interaction: null,
  })
}

/** 上下文自身的 `EntityRef`（供 `PropertyRef.owner` 使用）。 */
export function editContextEntityRef(ctx: EditContext): EntityRef {
  return entityRef('editContext', ctx.id)
}

// ─────────────────────────────────────────────────────────────────────────────
// 文档级修改租约
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 修改租约：**文档级**。
 *
 * 「为避免多个上下文同时修改同一文档，本次采用文档级修改租约：其他上下文**仍可观察**，
 * 但修改返回 `DocumentBusy`，**不静默排队等待未来场景**」。
 */
export interface DocumentLease {
  readonly documentId: string
  /** 当前持有修改权的上下文 id；`null` = 无人持有。 */
  readonly holder: string | null
}

export function createLease(documentId: string): DocumentLease {
  return Object.freeze({ documentId, holder: null })
}

/**
 * 申请修改权。
 *
 * - 无持有者 ⇒ 授予；
 * - **同一**持有者重入 ⇒ 幂等授予（同上下文可连续多次编辑）；
 * - 他人持有 ⇒ `DocumentBusy`（**不排队**）。
 */
export function acquireLease(lease: DocumentLease, contextId: string): Result<DocumentLease> {
  if (lease.holder === null || lease.holder === contextId) {
    return ok(Object.freeze({ ...lease, holder: contextId }))
  }
  return err(documentBusy({ documentId: lease.documentId, holder: lease.holder, requester: contextId }))
}

/** 释放修改权（文档关闭、显式切绑定、交互结束）。持有时非本人释放是 no-op。 */
export function releaseLease(lease: DocumentLease, contextId: string): DocumentLease {
  if (lease.holder !== contextId) return lease
  return Object.freeze({ ...lease, holder: null })
}

/** 关闭文档：无论谁持有都释放（「文档关闭也释放租约」）。 */
export function closeLease(lease: DocumentLease): DocumentLease {
  return lease.holder === null ? lease : Object.freeze({ ...lease, holder: null })
}

// ─────────────────────────────────────────────────────────────────────────────
// 有效读面（两个视口读同一份）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 读某对象的**有效**变换：有活动暂存则读暂存，否则读文档。
 *
 * 这是「有效读面」的最小可执行面。负对照「只让发起视口读暂存结果」在本模型下
 * 无法构造 —— 因为暂存在 `EditContext` 上，不在视口上；两个视口读到**同一个**值。
 */
export function effectiveTransform(ctx: EditContext, scene: Scene, objectId: string): Transform | undefined {
  const override = ctx.interaction?.overrides[objectId]
  if (override) return override
  return findObject(scene, objectId)?.transform
}

/** 有效可见性（暂存不改可见性；本函数为读面完备性而存在）。 */
export function effectiveVisible(ctx: EditContext, scene: Scene, objectId: string): boolean | undefined {
  void ctx
  return findObject(scene, objectId)?.visible
}

// ─────────────────────────────────────────────────────────────────────────────
// 交互 begin / update / commit / cancel
// ─────────────────────────────────────────────────────────────────────────────

export interface BeginInteractionInput {
  readonly tool: string
  readonly targets: readonly string[]
}

/**
 * 开始一次交互。
 *
 * 拒绝条件（**显式**，不静默）：
 *  - 已有活动交互（「同一编辑上下文只允许一个活动的修改事务」）；
 *  - 目标不存在（`MissingTarget`）；
 *  - 目标只读（多方块生成物）。
 *
 * 成功时记录起点版本与起点变换 —— 这是"无漂移"的锚。
 */
export function beginInteraction(ctx: EditContext, doc: Document, input: BeginInteractionInput): Result<EditContext> {
  if (ctx.interaction !== null) {
    return err(invalidValue({ reason: 'interactionAlreadyActive', tool: ctx.interaction.tool }))
  }
  if (input.targets.length === 0) {
    return err(invalidValue({ reason: 'noTargets', tool: input.tool }))
  }
  const startTransforms: Record<string, Transform> = {}
  for (const id of input.targets) {
    const obj = findObject(doc.scene, id)
    if (!obj) return err(missingTarget({ objectId: id }))
    const data = doc.scene.data[obj.dataId]
    if (data?.source === 'content') {
      // 写权按拥有者判定，不用文档级布尔。
      return err({ code: 'ReadOnly', params: Object.freeze({ owner: data.source, objectId: id, tool: input.tool }) })
    }
    startTransforms[id] = obj.transform
  }
  const interaction: InteractionState = Object.freeze({
    tool: input.tool,
    targets: Object.freeze([...input.targets]),
    startVersion: doc.version,
    startTransforms: Object.freeze(startTransforms),
    overrides: Object.freeze({}),
    totalDisplacement: Object.freeze({ x: 0, y: 0, z: 0 }),
  })
  return ok(Object.freeze({ ...ctx, activeTool: input.tool, interaction }))
}

export interface UpdateInteractionInput {
  /** **自起点的总位移**（不是自上一帧的增量）。 */
  readonly displacement: { readonly x: number; readonly y: number; readonly z: number }
}

/**
 * 推进一次交互。
 *
 * 语义关键：每次 update 都从 `startTransforms` 重新计算 `起点 + 总位移`，
 * **不是**在上一帧结果上再叠加增量。因此：
 *  - 传入同一个总位移两次 ⇒ 结果相同（幂等，无漂移）；
 *  - 移出再移回（总位移回到 0）⇒ 有效值回到起点，净变化为零。
 *
 * 返回的新上下文与**同一个**文档引用 —— `doc` 参数只用于校验起点版本，
 * 本函数不产生任何文档变更（「无内容版本推进」）。
 */
export function updateInteraction(ctx: EditContext, doc: Document, input: UpdateInteractionInput): Result<EditContext> {
  const it = ctx.interaction
  if (it === null) return err(invalidValue({ reason: 'noActiveInteraction' }))
  if (it.startVersion.documentVersion !== doc.version.documentVersion) {
    // 起点版本已被别的路径推进 ⇒ 该交互的依据失效，显式拒绝（不越序应用）。
    return err({
      code: 'VersionConflict',
      params: Object.freeze({ expected: it.startVersion.documentVersion, actual: doc.version.documentVersion, objectId: it.targets.join(',') }),
    })
  }
  const { displacement } = input
  const overrides: Record<string, Transform> = {}
  for (const id of it.targets) {
    const start = it.startTransforms[id]
    if (!start) continue
    // 起点 + 总位移（**每次重算**，不在上一帧结果上叠加）。
    overrides[id] = Object.freeze({
      ...start,
      position: Object.freeze({
        x: start.position.x + displacement.x,
        y: start.position.y + displacement.y,
        z: start.position.z + displacement.z,
      }),
    })
  }
  const next: InteractionState = Object.freeze({
    ...it,
    overrides: Object.freeze(overrides),
    totalDisplacement: Object.freeze({ x: displacement.x, y: displacement.y, z: displacement.z }),
  })
  return ok(Object.freeze({ ...ctx, interaction: next }))
}

/**
 * 提交一次交互。
 *
 * 返回新的文档与上下文，或 `null`（表示**净变化为零**，不产生历史、不推进版本）。
 *
 * 判据完全落在 `withScene` 的内容身份比较上：总位移为零 ⇒ 候选场景内容与当前相同 ⇒
 * `withScene` 报 `changed: false` ⇒ 这里返回 `null`。这就是"幽灵历史防御"的入口防线，
 * **不是**在历史层打补丁。
 */
export function commitInteraction(ctx: EditContext, doc: Document, sceneWriter: SceneWriter): CommitResult | null {
  const it = ctx.interaction
  if (it === null) return null
  if (it.startVersion.documentVersion !== doc.version.documentVersion) return null
  const write = sceneWriter(doc.scene, it)
  if (write === null) return null
  return { doc, scene: write.scene, interaction: it, changes: write.changes, selectionAfter: write.selectionAfter }
}

/** 提交的候选结果（由命令层提供"如何把暂存写进场景"的纯函数）。 */
export interface SceneWriterResult {
  readonly scene: Scene
  readonly changes: import('./identity').ChangeSummary
  readonly selectionAfter: readonly EntityRef[]
}

/** 把暂存写入场景的纯函数（政策由命令层给出，不在本模块）。 */
export type SceneWriter = (scene: Scene, interaction: InteractionState) => SceneWriterResult | null

export interface CommitResult {
  readonly doc: Document
  readonly scene: Scene
  readonly interaction: InteractionState
  readonly changes: import('./identity').ChangeSummary
  readonly selectionAfter: readonly EntityRef[]
}

/**
 * 取消交互：清空暂存，**文档零残留**。
 *
 * 「cancel 清除暂存」「被拒绝的操作保持文档、历史与保存脏状态不变」。
 */
export function cancelInteraction(ctx: EditContext): EditContext {
  if (ctx.interaction === null) return ctx
  return Object.freeze({ ...ctx, interaction: null, activeTool: null })
}

/**
 * 拒绝一次交互推进（例如越界）。
 *
 * 与 `cancelInteraction` 的区别是语义：拒绝**可以**保留交互继续拖动
 * （「被拒绝的操作保持文档、历史与保存脏状态不变，**诊断可以改变**」），
 * 故本函数只回退本次暂存到"起点有效值"，不清空交互本身。
 */
export function rejectInteractionUpdate(ctx: EditContext, error: DomainError): { ctx: EditContext; error: DomainError } {
  const it = ctx.interaction
  if (it === null) return { ctx, error }
  const reset: InteractionState = Object.freeze({
    ...it,
    overrides: Object.freeze({}),
    totalDisplacement: Object.freeze({ x: 0, y: 0, z: 0 }),
  })
  return { ctx: Object.freeze({ ...ctx, interaction: reset }), error }
}

// ─────────────────────────────────────────────────────────────────────────────
// 暂存不复制文档的实现证据测量
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 暂存占用：`staged` = 被暂存覆盖的对象数，`documentObjects` = 文档对象总数。
 *
 * 若暂存是"整文档复制"，`staged` 会等于 `documentObjects`；
 * 本实现的 `staged` 只等于**被拖动的目标数**。这是暂存不复制文档的可测量证据。
 */
export function stagingFootprint(ctx: EditContext, doc: Document): { staged: number; documentObjects: number } {
  return {
    staged: ctx.interaction ? Object.keys(ctx.interaction.overrides).length : 0,
    documentObjects: Object.keys(doc.scene.objects).length,
  }
}

/** 暂存是否与起点完全相同（净零）。 */
export function isNetZero(ctx: EditContext): boolean {
  const it = ctx.interaction
  if (it === null) return true
  for (const id of it.targets) {
    const start = it.startTransforms[id]
    const cur = it.overrides[id]
    if (start && cur && !sameTransform(start, cur)) return false
    if (start && !cur) return false
  }
  return true
}

// ─────────────────────────────────────────────────────────────────────────────
// 选择（点选不进文档历史 —— 所有权表）
// ─────────────────────────────────────────────────────────────────────────────

export function withSelection(ctx: EditContext, selection: SelectionState): EditContext {
  return Object.freeze({ ...ctx, selection })
}

/** 单选。**不产生历史、不推进文档版本**。 */
export function selectOne(ctx: EditContext, ref: EntityRef): EditContext {
  return withSelection(ctx, Object.freeze({ selected: Object.freeze([ref]), active: ref, mode: 'single' }))
}

export function clearSelection(ctx: EditContext): EditContext {
  return withSelection(ctx, EMPTY_SELECTION)
}

// ─────────────────────────────────────────────────────────────────────────────
// 通道取值 / 时间（归 EditContext）
// ─────────────────────────────────────────────────────────────────────────────

export function withChannelValue(ctx: EditContext, key: string, value: number): EditContext {
  return Object.freeze({ ...ctx, channelValues: Object.freeze({ ...ctx.channelValues, [key]: value }) })
}

export function withTime(ctx: EditContext, time: TimeValue): EditContext {
  return Object.freeze({ ...ctx, time })
}

/**
 * 推进时间（**逻辑**秒数由宿主显式给出）。
 *
 * 本函数取代"某个循环自己 tick"的形态：`deltaSeconds` 是输入，
 * 因此"同一时间 ⇒ 同一样本"与"跳帧 = 直接赋值时间"共用一条路径。
 */
export function advanceContextTime(ctx: EditContext, deltaSeconds: number): EditContext {
  return Object.freeze({ ...ctx, time: advanceTime(ctx.time, deltaSeconds) })
}

/** 定位到某时间（拖动/跳帧/倒退定位）。**不**改文档。 */
export function seekContextTime(ctx: EditContext, time: TimeValue): EditContext {
  return Object.freeze({ ...ctx, time })
}

// ─────────────────────────────────────────────────────────────────────────────
// 播放状态（归 EditContext；替代旧 `Main.framesPlaybackIsPlaying`）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把 `EditContext` 的时间与播放状态**合成**一个 `Playhead` 视图。
 *
 * ## 为什么是"合成视图"而不是在 `EditContext` 上再存一个 `Playhead`
 *
 * `domain/animation#Playhead` 自带 `time` 字段。若 `EditContext` 也持一个 `Playhead`，
 * 就有了**两份时间**（`ctx.time` 与 `ctx.playhead.time`）—— 二者一旦漂移，
 * "同一上下文所有 Area 看到同一时间"就只是巧合。
 * ⇒ 本函数每次从 `ctx.time` + `playing` + `playbackRate` **现算**，
 * 使 `Playhead` 恒为派生值，`ctx.time` 保持唯一权威。
 *
 * 反向的落点见 {@link withPlayhead}：它把推进结果**只**写回 `time`，
 * 因此"用 `Playhead` 推进"不会引入第二个存储位置。
 */
export function playheadOf(ctx: EditContext): Playhead {
  return createPlayhead(ctx.time, ctx.playing, ctx.playbackRate)
}

/**
 * 用 `Playhead` 的推进结果更新上下文（**只**取 `time`；`playing`/`rate` 由调用方显式给）。
 *
 * `playing` 与 `rate` 刻意不从 `playhead` 取：`advancePlayhead` 会把它们原样带回，
 * 从那里取等于让"这次推进"隐式决定播放开关 —— 而开关是**命令**的职责
 * （`setPlaying` / `setPlaybackRate`），不是推进的副作用。
 */
export function withPlayhead(ctx: EditContext, playhead: Playhead): EditContext {
  return ctx.time === playhead.time ? ctx : Object.freeze({ ...ctx, time: playhead.time })
}

/**
 * 开始/停止播放。**不碰时间**（「停止播放保留当前时间」）。
 *
 * 幂等：已经是该状态 ⇒ 返回**原引用**（使"未变化不得谎报推进"可断言）。
 */
export function withPlaying(ctx: EditContext, playing: boolean): EditContext {
  if (ctx.playing === playing) return ctx
  return Object.freeze({ ...ctx, playing })
}

/**
 * 设置常量播放倍率。
 *
 * 非法值（非有限、负）⇒ 返回**原引用**（拒绝零残留；判据在命令层给出结构化错误，
 * 本函数是纯转移，不产出诊断 —— 与 `withPlaying` 同一分工）。
 */
export function withPlaybackRate(ctx: EditContext, rate: number): EditContext {
  if (!Number.isFinite(rate) || rate < 0) return ctx
  if (ctx.playbackRate === rate) return ctx
  return Object.freeze({ ...ctx, playbackRate: rate })
}

/**
 * 推进播放时间（**按注入的经过秒数**）。
 *
 * 这是"宿主按帧注入时间输入"的唯一落点：`deltaSeconds` 是**显式输入**，
 * 本函数不读墙钟。暂停或倍率为 0 时返回原引用 ⇒
 * "没播放就不动"是结构事实，不靠调用方自觉。
 */
export function advancePlayback(ctx: EditContext, deltaSeconds: number): EditContext {
  if (!ctx.playing || ctx.playbackRate === 0 || !Number.isFinite(deltaSeconds)) return ctx
  return withPlayhead(ctx, advancePlayhead(playheadOf(ctx), deltaSeconds))
}


/**
 * 暂存事务版本。
 *
 * 求值缓存身份 `EvaluationKey.stagedTransactionVersion`（「活动编辑事务的暂存版本」）的
 * 数据来源。用**内容摘要**而不是计数器：「dirty 根据内容身份/内容版本…
 * 不使用仅单调增长的提交计数」是同一原则；计数器会让"暂存回到起点"之后
 * 求值键仍然不同，于是几何白重算一次（"重建数为 0"就会假红）。
 */
export function stagedTransactionVersion(ctx: EditContext): number {
  if (ctx.interaction === null) return 0
  return digestOf({
    tool: ctx.interaction.tool,
    targets: ctx.interaction.targets,
    overrides: ctx.interaction.overrides,
    totalDisplacement: ctx.interaction.totalDisplacement,
  })
}

/** 时间是否相同（转发 `domain/animation`，供下游对账）。 */
export const sameContextTime = sameTime

/** 帧率数值（呈现/统计用；**判定**一律用 `compareTime`）。 */
export const contextFramesPerSecond = framesPerSecond

/** 上下文所绑定文档的引用（供换绑判定）。 */
export function boundDocumentRef(ctx: EditContext, doc: Document): EntityRef {
  if (ctx.documentId !== doc.id) {
    // 由调用方在绑定前校验；此处只如实返回（不静默当成已绑定）。
    return entityRef('document', ctx.documentId)
  }
  return documentEntityRef(doc)
}

/** 未使用的占位以免 tree-shake 掉类型导入（`SceneObject` 供下游类型推导）。 */
export type { SceneObject }
