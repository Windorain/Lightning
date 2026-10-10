/**
 * `domain/document` —— **文档状态域**：内容、版本、历史、保存基线（#249 §3.1 §8 §3.4；契约 §1.4 §6）。
 *
 * ## 1. 本模块是「文档内容 / 历史 / 保存基线」的唯一权威拥有者
 *
 * 契约 §6 所有权表头两行：文档内容与历史、保存基线都归**文档状态域**，
 * 「撤销栈与保存基线随**文档**而非工作区存活」。
 * 因此本模块导出的 `Document` 是**值**，`EditContext`（见 `domain/editing`）只持有它的引用。
 *
 * ## 2. 版本两分的落地（契约 §1.4 的 P1 决定，见 `domain/identity` 文件头）
 *
 * - `documentVersion` 单调、只因内容变化推进；
 * - `contentVersion` = 内容摘要，用于**与保存基线比较相等**。
 *
 * 「dirty 根据内容身份/内容版本相对保存基线判断，**不使用仅单调增长的提交计数**；
 * 撤销回实际保存内容必须干净」（#249 §8）在本模块由 `isDirty` 直接实现：
 * 判据是 `sameContent(doc.version, doc.saveBaseline)`。
 *
 * ## 3. 幽灵历史防御（#252 执行范围 + A06）
 *
 * 「拒绝/取消零残留、幽灵历史防御」。两条防线：
 *  - **入场**：`pushHistory` 只在 `before.contentVersion !== after.contentVersion` 时记账。
 *    新建容器不算数（契约 §1.4「仅创建了新容器**不**等于内容变化」）——判据是**内容身份**。
 *  - **净零往返**：拖动移出再移回，内容身份回到起点 ⇒ 记账被拒（`pushHistory` 返回 `null`）。
 *    这条让「取消一次净变化为零的往返拖动不得产生幽灵历史」（#249 §8 末句）成立。
 *
 * ## 4. 历史条目携带选择映射，但不是"回放旧选择直接引用已失效对象"
 *
 * #249 §8：「内容历史条目可携带该操作前后相关选择映射；撤销时**根据当前有效对象解析**」。
 * ⇒ 条目里存的是 `EntityRef`（值），撤销时经 `resolveSelectionAfterUndo` **对着新场景**解析，
 * 已失效目标被丢弃并报告，不直接照搬。这是 A17 负对照「回放旧选择直接引用已失效对象」的落点。
 */

import {
  VERSION_ZERO,
  changeSummary,
  contentDigest,
  digestOf,
  entityRef,
  objectRef,
  sameContent,
  sameVersion,
  version,
  type ChangeSummary,
  type EntityRef,
  type Version,
} from './identity'
import {
  emptyScene,
  findObject,
  sceneObject,
  objectData,
  withObject,
  defaultObjectTypes,
  type Scene,
  type ObjectTypeRegistry,
} from './scene'

// ─────────────────────────────────────────────────────────────────────────────
// 历史
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一个内容历史条目。
 *
 * `beforeScene` / `afterScene` 是**不可变场景的引用**，不是深拷贝：
 * `domain/scene` 的每次结构变更都返回新场景并共享未变子树，
 * 故"存快照"在本模型下等于"存一个指针"，不构成 #249 §3.2 所禁止的
 * 「每次鼠标移动重复复制整份文档」。
 */
export interface HistoryEntry {
  readonly label: string
  readonly beforeScene: Scene
  readonly afterScene: Scene
  readonly beforeVersion: Version
  readonly afterVersion: Version
  readonly changes: ChangeSummary
  /** 操作前相关选择（值引用）。 */
  readonly selectionBefore: readonly EntityRef[]
  /** 操作后相关选择（值引用）。 */
  readonly selectionAfter: readonly EntityRef[]
}

export interface HistoryState {
  readonly past: readonly HistoryEntry[]
  readonly future: readonly HistoryEntry[]
  readonly maxDepth: number
}

export const DEFAULT_HISTORY_DEPTH = 256

export function emptyHistory(maxDepth = DEFAULT_HISTORY_DEPTH): HistoryState {
  return Object.freeze({ past: Object.freeze([]), future: Object.freeze([]), maxDepth })
}

export const canUndo = (h: HistoryState): boolean => h.past.length > 0
export const canRedo = (h: HistoryState): boolean => h.future.length > 0
export const undoLabel = (h: HistoryState): string | null => (h.past.length > 0 ? h.past[h.past.length - 1].label : null)
export const redoLabel = (h: HistoryState): string | null => (h.future.length > 0 ? h.future[h.future.length - 1].label : null)

// ─────────────────────────────────────────────────────────────────────────────
// 文档
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 文档：独立保存与撤销的内容单元（#249 §3.1）。
 *
 * 注意本类型**没有** raw JSON / 格式字段袋（`Record<string, unknown>`）：
 * #249 §15 第 2 条要求「核心无 raw JSON/格式字段袋」，格式保真记录属于
 * `adapters/files`（P9）。这是本批不复制旧 `RuntimeDocument` 的关键差异。
 */
export interface Document {
  readonly id: string
  /** 文档内容。 */
  readonly scene: Scene
  /** 当前版本（单调世代 + 内容身份）。 */
  readonly version: Version
  /** 最后一次成功保存时的**内容身份**。 */
  readonly saveBaseline: Version
  readonly history: HistoryState
  /** 对象类型贡献表（扩展点在装配层，不在核心 switch）。 */
  readonly types: ObjectTypeRegistry
  /** 已成功完成的保存序号（供保存竞态判定，见 `SaveLedger`）。 */
  readonly savedSequence: number
}

export function createDocument(id: string, opts?: { sceneId?: string; maxHistory?: number; types?: ObjectTypeRegistry }): Document {
  const scene = emptyScene(opts?.sceneId ?? `${id}-scene`)
  const contentVersion = digestOf(scene)
  return Object.freeze({
    id,
    scene,
    version: version(0, contentVersion),
    saveBaseline: version(0, contentVersion),
    history: emptyHistory(opts?.maxHistory),
    types: opts?.types ?? defaultObjectTypes(),
    savedSequence: 0,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 内容变更（推进版本）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 用新场景替换文档内容，**仅当内容身份确实改变时**推进 `documentVersion`。
 *
 * 这是契约 §1.4「仅创建了新容器**不**等于内容变化」与
 * #249 §15 第 5 条「非内容版本不得冒充内容变化」的共同落点：
 * 判定按 `digestOf(scene)`，不按"是否新建了对象"。
 */
export function withScene(doc: Document, scene: Scene): { doc: Document; changed: boolean; version: Version } {
  const nextContent = digestOf(scene)
  const curContent = doc.version.contentVersion ?? 0
  if (nextContent === curContent) {
    // 内容相同：保持**原版本对象身份**，不推进任何计数。
    return { doc: Object.freeze({ ...doc, scene }), changed: false, version: doc.version }
  }
  const nextVersion = version(doc.version.documentVersion + 1, nextContent)
  return { doc: Object.freeze({ ...doc, scene, version: nextVersion }), changed: true, version: nextVersion }
}

// ─────────────────────────────────────────────────────────────────────────────
// 历史记账
// ─────────────────────────────────────────────────────────────────────────────

export interface PushHistoryInput {
  readonly label: string
  readonly beforeScene: Scene
  readonly beforeVersion: Version
  readonly afterScene: Scene
  readonly afterVersion: Version
  readonly changes: ChangeSummary
  readonly selectionBefore?: readonly EntityRef[]
  readonly selectionAfter?: readonly EntityRef[]
}

/**
 * 记一条历史。
 *
 * 返回 `null` 表示**拒绝记账**，且必须由调用方如实报告为"无历史产生"：
 *  - 内容身份未变（净零往返 / 拒绝后仍记账 / 取消）；
 *  - 只改了选择（#249 §9 已批准方向：「不把单次点选和观察机位纳入文档历史」）。
 *
 * 这条 `null` 是 A06「无无效历史」的可执行落点。
 */
export function pushHistory(h: HistoryState, input: PushHistoryInput): HistoryState | null {
  if (sameContent(input.beforeVersion, input.afterVersion)) return null
  const entry: HistoryEntry = Object.freeze({
    label: input.label,
    beforeScene: input.beforeScene,
    afterScene: input.afterScene,
    beforeVersion: input.beforeVersion,
    afterVersion: input.afterVersion,
    changes: input.changes,
    selectionBefore: Object.freeze([...(input.selectionBefore ?? [])]),
    selectionAfter: Object.freeze([...(input.selectionAfter ?? [])]),
  })
  const past = [...h.past, entry]
  // 超深时丢弃最旧条目（**不**静默丢弃最新，否则"刚做的操作撤不回"）
  while (past.length > h.maxDepth) past.shift()
  return Object.freeze({ past: Object.freeze(past), future: Object.freeze([]), maxDepth: h.maxDepth })
}

// ─────────────────────────────────────────────────────────────────────────────
// 撤销 / 重做
// ─────────────────────────────────────────────────────────────────────────────

export interface HistoryStepResult {
  readonly doc: Document
  /** 应用后应发布的相关选择（已按**当前场景**解析，失效项在内）。 */
  readonly selection: readonly EntityRef[]
  /** 被丢弃的失效引用（诊断用；A17「无悬空引用」）。 */
  readonly droppedReferences: readonly EntityRef[]
}

/**
 * 选择引用解析：只保留在当前场景里**仍然存在**的引用。
 *
 * #249 §8：「撤销时根据当前有效对象解析」。⇒ 不照搬旧条目里的选择，
 * 而是对着**应用后的新场景**逐条验证；失效项进入 `dropped` 而不是被静默保留
 * （A17 负对照「回放旧选择直接引用已失效对象」必须判红）。
 */
export function resolveSelection(scene: Scene, refs: readonly EntityRef[]): { resolved: readonly EntityRef[]; dropped: readonly EntityRef[] } {
  const resolved: EntityRef[] = []
  const dropped: EntityRef[] = []
  for (const r of refs) {
    if (r.kind === 'object') {
      if (findObject(scene, r.id)) resolved.push(r)
      else dropped.push(r)
    } else {
      // 非对象引用（文档/上下文/资源）不由场景存在性判定，原样保留。
      resolved.push(r)
    }
  }
  return { resolved: Object.freeze(resolved), dropped: Object.freeze(dropped) }
}

/** 撤销一步。返回 `null` 表示无历史可撤（调用方应报告 `unchanged`，不报错）。 */
export function undo(doc: Document): HistoryStepResult | null {
  const entry = doc.history.past[doc.history.past.length - 1]
  if (!entry) return null
  const { resolved, dropped } = resolveSelection(entry.beforeScene, entry.selectionBefore)
  const next: Document = Object.freeze({
    ...doc,
    scene: entry.beforeScene,
    version: entry.beforeVersion,
    history: Object.freeze({
      past: Object.freeze(doc.history.past.slice(0, -1)),
      future: Object.freeze([...doc.history.future, entry]),
      maxDepth: doc.history.maxDepth,
    }),
  })
  return Object.freeze({ doc: next, selection: resolved, droppedReferences: dropped })
}

/** 重做一步。 */
export function redo(doc: Document): HistoryStepResult | null {
  const entry = doc.history.future[doc.history.future.length - 1]
  if (!entry) return null
  const { resolved, dropped } = resolveSelection(entry.afterScene, entry.selectionAfter)
  const next: Document = Object.freeze({
    ...doc,
    scene: entry.afterScene,
    version: entry.afterVersion,
    history: Object.freeze({
      past: Object.freeze([...doc.history.past, entry]),
      future: Object.freeze(doc.history.future.slice(0, -1)),
      maxDepth: doc.history.maxDepth,
    }),
  })
  return Object.freeze({ doc: next, selection: resolved, droppedReferences: dropped })
}

// ─────────────────────────────────────────────────────────────────────────────
// 保存基线与 dirty
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 文档是否脏。
 *
 * 判据 = **内容身份**与保存基线是否相等（契约 §1.4 + #249 §8）。
 * 因此"撤销回实际保存内容 ⇒ 干净"自动成立，无需任何补偿逻辑。
 */
export function isDirty(doc: Document): boolean {
  return !sameContent(doc.version, doc.saveBaseline)
}

/** 内容身份是否与基线逐位相同（含世代；供严格对账）。 */
export function isPristine(doc: Document): boolean {
  return sameVersion(doc.version, doc.saveBaseline)
}

// ─────────────────────────────────────────────────────────────────────────────
// 保存目标写入串行化（核心政策；适配器接入归 #260）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一次保存请求的**不可变快照**。
 *
 * #249 §8：「保存捕获已提交快照 S0、文档身份、源绑定代数和保存序号」。
 * `bindingGeneration` 是"源绑定代数"——文档被关闭/重绑后它推进，
 * 使迟到的完成事件可被识别为过期（A16 负对照「旧绑定不被污染」）。
 */
export interface SaveRequest {
  readonly sequence: number
  readonly documentId: string
  readonly bindingGeneration: number
  /** 捕获时的内容身份（S0）。 */
  readonly capturedVersion: Version
  readonly capturedScene: Scene
}

/** 保存台账：串行化与竞态判定的**纯**状态。 */
export interface SaveLedger {
  readonly nextSequence: number
  readonly inFlight: SaveRequest | null
  /** 已成功落地的最高序号。 */
  readonly committedSequence: number
  readonly bindingGeneration: number
}

export function createSaveLedger(): SaveLedger {
  return Object.freeze({ nextSequence: 1, inFlight: null, committedSequence: 0, bindingGeneration: 0 })
}

/**
 * 发起一次保存。**已有在途写入时返回 `null`** ——
 * #249 §8：「每个保存目标写入**串行化**，或由远端条件版本控制保证顺序；
 * 仅忽略旧响应不足以阻止旧请求最后覆盖远端」。
 *
 * ⇒ 本实现选择**串行化**（前一个未完成就不发下一个），而不是"允许并发再忽略旧响应"。
 * 这就是 A16 负对照「仅忽略响应却允许旧请求覆盖远端」在 P1 核心层的落点。
 */
export function beginSave(ledger: SaveLedger, doc: Document, bindingGeneration: number): { ledger: SaveLedger; request: SaveRequest } | null {
  if (ledger.inFlight !== null) return null
  const request: SaveRequest = Object.freeze({
    sequence: ledger.nextSequence,
    documentId: doc.id,
    bindingGeneration,
    capturedVersion: doc.version,
    capturedScene: doc.scene,
  })
  return {
    ledger: Object.freeze({ ...ledger, nextSequence: ledger.nextSequence + 1, inFlight: request, bindingGeneration }),
    request,
  }
}

/** 结算结果。`committed` 表示远端确实接受了这次写入。 */
export type SaveOutcome =
  | { readonly kind: 'committed' }
  | { readonly kind: 'failed'; readonly code: string }
  | { readonly kind: 'superseded' }

/**
 * 保存完成事件。
 *
 * 三条判据（缺一即 A16 负对照）：
 *  1. 结束的必须是**在途**的那一次（序号相符）；
 *  2. **绑定代数相符** —— 文档已关闭/重绑则旧完成事件不得回写（`superseded`）；
 *  3. 只有 `committed` 才推进保存基线，且基线取**该请求捕获的 S0**
 *     （不是"当前版本"——保存期间的新编辑仍应脏，A16「S1 仍脏」）。
 *     失败**不改基线**（#249 §8 明文）。
 */
export function completeSave(
  ledger: SaveLedger,
  doc: Document,
  request: SaveRequest,
  outcome: SaveOutcome,
  currentBindingGeneration: number,
): { ledger: SaveLedger; doc: Document; applied: boolean } {
  if (ledger.inFlight === null || ledger.inFlight.sequence !== request.sequence) {
    return { ledger, doc, applied: false }
  }
  const released: SaveLedger = Object.freeze({ ...ledger, inFlight: null })
  if (request.bindingGeneration !== currentBindingGeneration) {
    // 旧绑定的完成事件：释放在途槽位，但**不**回写文档。
    return { ledger: released, doc, applied: false }
  }
  if (outcome.kind !== 'committed') {
    return { ledger: released, doc, applied: false }
  }
  const next: Document = Object.freeze({
    ...doc,
    saveBaseline: request.capturedVersion,
    savedSequence: request.sequence,
  })
  return {
    ledger: Object.freeze({ ...released, committedSequence: Math.max(released.committedSequence, request.sequence) }),
    doc: next,
    applied: true,
  }
}

/**
 * 关闭文档 / 重绑源：推进绑定代数并丢弃在途写入。
 *
 * 契约 §6.1：「文档关闭也释放租约、取消归属作业。**资源加载回调不能重新激活已关闭的交互**」。
 * 推进代数使任何迟到回调都无法命中当前绑定。
 */
export function rebindSaveLedger(ledger: SaveLedger): SaveLedger {
  return Object.freeze({ ...ledger, bindingGeneration: ledger.bindingGeneration + 1, inFlight: null })
}

// ─────────────────────────────────────────────────────────────────────────────
// 三类真实对象的最小构造（#252：「方块、注解框、相机三类真实对象类型」）
// ─────────────────────────────────────────────────────────────────────────────

/** 在场景里放一个方块对象（数据为 `blockGrid`）。 */
export function addBlockObject(
  scene: Scene,
  init: { objectId: string; dataId: string; name?: string; cells?: Readonly<Record<string, string>> },
): Scene | null {
  return withObject(
    scene,
    sceneObject({ id: init.objectId, type: 'block', dataId: init.dataId, ...(init.name === undefined ? {} : { name: init.name }) }),
    objectData(init.dataId, { kind: 'blockGrid', cells: init.cells ?? {} }, 'document'),
  )
}

/** 在场景里放一个注解框对象。 */
export function addAnnotationObject(
  scene: Scene,
  init: { objectId: string; dataId: string; name?: string; shape?: 'box' | 'point' | 'line' | 'text' | 'face'; text?: string },
): Scene | null {
  const payload = init.text === undefined ? { kind: 'annotation' as const, shape: init.shape ?? 'box' } : { kind: 'annotation' as const, shape: init.shape ?? 'box', text: init.text }
  return withObject(
    scene,
    sceneObject({ id: init.objectId, type: 'annotation', dataId: init.dataId, ...(init.name === undefined ? {} : { name: init.name }) }),
    objectData(init.dataId, payload, 'document'),
  )
}

/** 在场景里放一个相机对象（相机参数属文档；观察视角属编辑器实例，见 §3.1）。 */
export function addCameraObject(
  scene: Scene,
  init: { objectId: string; dataId: string; name?: string; projection?: 'perspective' | 'orthographic'; fov?: number; clipStart?: number; clipEnd?: number },
): Scene | null {
  return withObject(
    scene,
    sceneObject({ id: init.objectId, type: 'camera', dataId: init.dataId, ...(init.name === undefined ? {} : { name: init.name }) }),
    objectData(
      init.dataId,
      {
        kind: 'camera',
        projection: init.projection ?? 'perspective',
        fov: init.fov ?? 50,
        clipStart: init.clipStart ?? 0.1,
        clipEnd: init.clipEnd ?? 1000,
      },
      'document',
    ),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 小工具（供命令层复用）
// ─────────────────────────────────────────────────────────────────────────────

/** 从对象 id 造 `EntityRef`（含当前内容版本，供 `StaleReference` 判定）。 */
export function objectEntityRef(scene: Scene, objectId: string): EntityRef | undefined {
  const obj = findObject(scene, objectId)
  if (!obj) return undefined
  const data = scene.data[obj.dataId]
  return objectRef(objectId, data?.contentVersion ?? contentDigest(obj.dataId))
}

/** 造一个"内容为空"的变更摘要（`unchanged` 分支用）。 */
export function noChange(): ChangeSummary {
  return changeSummary({ structurallyShared: true })
}

/** 文档自身引用。 */
export function documentEntityRef(doc: Document): EntityRef {
  return entityRef('document', doc.id, doc.version.contentVersion)
}

/** 版本零的便捷引用（测试夹具用）。 */
export const ZERO = VERSION_ZERO
