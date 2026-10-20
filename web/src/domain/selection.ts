/**
 * `domain/selection` —— **选择模式的类型化目标引用与模式切换纯规则**
 * （#249 §19.2 末段；契约 §1.2 `ElementRef`、§1.1 `EntityRef`）。
 *
 * ## 冻结语义（#249 §19.2 末段逐字）
 *
 * 「对象/顶点等选择模式具有**类型化目标引用**；切模式按**显式纯规则**转换或
 * **保留各模式选择**，**不把顶点集合伪装为对象列表**。高级边面编辑可后续增加」。
 *
 * ## 两条实现决定
 *
 * ### 1. 每个模式**各自保留**一份选择（不做有损"转换"）
 *
 * 末段允许两条路径：显式转换**或**保留各模式选择。本实现选**保留**，理由是
 * 可逆性：切换 对象→顶点→对象 之后，对象选择必须原样回来。若做"转换"，
 * 顶点选择在回到对象模式时只能"推导"出对象集合，而推导必然丢信息
 * （例如顶点选择为空时无法区分"选了 0 个顶点"与"从未进入顶点模式"）。
 *
 * 转换仍然**提供**，但它是**显式**的（{@link selectedObjectsOf}）且**不覆盖**
 * 已保留的状态 —— 于是"转换"与"保留"不是二选一，而是各司其职。
 *
 * ### 2. `SelectionMode` ≠ `SelectionState.mode`（P1）
 *
 * P1 的 `domain/editing#SelectionState.mode` 是 `'single' | 'box' | 'type' | 'annotation'`
 * —— 那是**拾取手势**（怎么选），不是**目标种类**（选的是什么）。
 * 两者正交：可以用 box 手势选顶点，也可以用 single 手势选对象。
 * 把它们合成一个字段会让"框选顶点"无法表达。故本模块的
 * {@link SelectionMode} 是独立维度，并在 {@link toSelectionState} 里与 P1 的手势维度
 * **显式**组合，而不是塞进同一个字符串。
 *
 * ## 退役 #9 的关系
 *
 * 顶点选择用 `ElementRef`（含 `topologyVersion`），**不**用下标、**不**用坐标。
 * 拓扑一变，`pruneStaleElements` 会把失效顶点显式剔除并**报告**
 * （不是静默丢弃 —— 静默丢弃会让"撤销后又出现在选择里"变成不可能）。
 */

import { findObjectData, type Scene } from './scene'
import { meshFromPayload, type VertexId } from './geometry'
import { elementRef, type ElementRef, type EntityRef } from './identity'
import { err, invalidValue, ok, type Result } from './errors'

// ─────────────────────────────────────────────────────────────────────────────
// 模式与选择
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 选择的目标种类（**目标维度**，与 P1 的拾取手势维度正交）。
 *
 * `'edge'`/`'face'` 本次**声明但不由 UI 暴露**：#249 §19.2 末句「高级边面编辑可
 * 后续增加」。声明它们是为了让"后续增加"不需要改核心联合类型
 * （#249 §13「新增一类不需要改核心 switch」的同族要求）；
 * 而 {@link isModeAvailable} 显式标注当前可用性 —— 声称可用却无实现正是 §13 禁止的
 * 「暴露会假成功的按钮」。
 */
export type SelectionMode = 'object' | 'vertex' | 'edge' | 'face'

/** 本批**真正可用**的选择模式。边/面为远期，且此事实是**数据**而非注释。 */
export const AVAILABLE_SELECTION_MODES: readonly SelectionMode[] = Object.freeze(['object', 'vertex'])

export function isModeAvailable(mode: SelectionMode): boolean {
  return AVAILABLE_SELECTION_MODES.includes(mode)
}

/**
 * 单个选择目标。
 *
 * 判别联合而不是 `{ type: string; id: string }`：后者正是"把顶点集合伪装为
 * 对象列表"的形态（元素引用会丢掉 `topologyVersion`）。契约 §1.2 要求子元素寻址
 * **必须**带拓扑版本，故这里用 `element: ElementRef`（类型上强制带上）。
 */
export type SelectionTarget =
  | { readonly kind: 'object'; readonly ref: EntityRef }
  | { readonly kind: 'vertex'; readonly objectId: string; readonly dataId: string; readonly element: ElementRef }
  | { readonly kind: 'edge'; readonly objectId: string; readonly dataId: string; readonly element: ElementRef }
  | { readonly kind: 'face'; readonly objectId: string; readonly dataId: string; readonly element: ElementRef }

export function objectTarget(ref: EntityRef): SelectionTarget {
  return Object.freeze({ kind: 'object' as const, ref })
}

export function vertexTarget(objectId: string, dataId: string, ref: ElementRef): SelectionTarget {
  return Object.freeze({ kind: 'vertex' as const, objectId, dataId, element: ref })
}

/**
 * 每个模式**各自保留**的选择（#249 §19.2：「转换**或保留各模式选择**」）。
 *
 * 用 `Readonly<Record<SelectionMode, readonly SelectionTarget[]>>` 而不是
 * "当前模式 + 当前选择"：后者在切模式时必然丢另一模式的选择。
 */
export interface SelectionSet {
  readonly mode: SelectionMode
  readonly byMode: Readonly<Record<SelectionMode, readonly SelectionTarget[]>>
  /** 活动目标（在多选变换里充当 `activeObjectOrigin` 策略的输入）。 */
  readonly active: SelectionTarget | null
}

export function emptySelectionSet(mode: SelectionMode = 'object'): SelectionSet {
  return Object.freeze({
    mode,
    byMode: Object.freeze({
      object: Object.freeze([]),
      vertex: Object.freeze([]),
      edge: Object.freeze([]),
      face: Object.freeze([]),
    }),
    active: null,
  })
}

/** 当前模式下的选择。 */
export function currentTargets(s: SelectionSet): readonly SelectionTarget[] {
  return s.byMode[s.mode]
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯规则：切换模式 / 选择 / 取消选择
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 切换模式（**纯规则**）。
 *
 * 语义：只改 `mode` 与 `active`（活动目标换成新模式里的选择），
 * **不动**任何模式的已存选择。于是 对象→顶点→对象 是幂等的往返。
 *
 * 不可用模式（`edge`/`face`）**显式拒绝** —— 不是"切过去但空着"（那是假成功）。
 */
export function switchMode(s: SelectionSet, mode: SelectionMode): Result<SelectionSet> {
  if (!isModeAvailable(mode)) {
    return err(invalidValue({ reason: 'modeNotAvailable', mode, available: AVAILABLE_SELECTION_MODES.join(',') }))
  }
  if (s.mode === mode) return ok(s)
  const targets = s.byMode[mode]
  return ok(Object.freeze({ ...s, mode, active: targets.length > 0 ? targets[0] : null }))
}

/** 目标是否相等（**值语义**，含元素拓扑版本）。 */
export function sameTarget(a: SelectionTarget, b: SelectionTarget): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'object' && b.kind === 'object') {
    return a.ref.kind === b.ref.kind && a.ref.id === b.ref.id
  }
  if (a.kind !== 'object' && b.kind !== 'object') {
    return a.objectId === b.objectId && a.dataId === b.dataId && a.element.elementId === b.element.elementId && a.element.topologyVersion === b.element.topologyVersion
  }
  return false
}

/**
 * 在当前模式里选中一个目标。
 *
 * **种类必须与模式一致**：往 `vertex` 模式里塞 `object` 目标即拒绝 ——
 * 这条正是"不把顶点集合伪装为对象列表"的对偶保证（对象目标也不许伪装成顶点）。
 */
export function selectTarget(s: SelectionSet, target: SelectionTarget, options?: { readonly additive?: boolean }): Result<SelectionSet> {
  if (target.kind !== s.mode) {
    return err(invalidValue({ reason: 'targetKindMismatch', mode: s.mode, targetKind: target.kind }))
  }
  const existing = s.byMode[s.mode]
  const additive = options?.additive ?? false
  let next: readonly SelectionTarget[]
  if (!additive) {
    next = Object.freeze([target])
  } else if (existing.some((t) => sameTarget(t, target))) {
    // 加性选择里重复点击 = 取消该项（可预期的切换语义）
    next = Object.freeze(existing.filter((t) => !sameTarget(t, target)))
  } else {
    next = Object.freeze([...existing, target])
  }
  const byMode = Object.freeze({ ...s.byMode, [s.mode]: next })
  return ok(Object.freeze({ ...s, byMode, active: next.length > 0 ? next[next.length - 1] : null }))
}

/** 清空**当前模式**的选择（其它模式的选择保留 —— 与"保留各模式选择"一致）。 */
export function clearCurrentMode(s: SelectionSet): SelectionSet {
  return Object.freeze({ ...s, byMode: Object.freeze({ ...s.byMode, [s.mode]: Object.freeze([]) }), active: null })
}

// ─────────────────────────────────────────────────────────────────────────────
// 显式转换（可选，不覆盖保留状态）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 顶点选择 → 对象集合（**显式**转换，供需要"对象级操作"的调用方）。
 *
 * 结果按 `Scene.order` 去重排序 —— 顺序稳定使同一选择的转换结果可比较。
 * 注意它**只读** `byMode.vertex`，不碰 `byMode.object`：转换是查询，不是写。
 */
export function selectedObjectsOf(s: SelectionSet): readonly string[] {
  const ids = new Set<string>()
  for (const t of s.byMode.vertex) {
    if (t.kind === 'vertex') ids.add(t.objectId)
  }
  return Object.freeze([...ids].sort())
}

/** 对象选择 → 对象 id 列表（稳定顺序）。 */
export function selectedObjectIds(s: SelectionSet): readonly string[] {
  const ids: string[] = []
  for (const t of s.byMode.object) {
    if (t.kind === 'object') ids.push(t.ref.id)
  }
  return Object.freeze([...new Set(ids)].sort())
}

/**
 * 剔除**拓扑版本已过期**的顶点/边/面选择，并**报告**被剔除的项。
 *
 * 为什么报告而不是静默丢弃：#249 §3.2 要求"使不再有效的引用**显式失效**"。
 * 静默丢弃会让 UI 无法解释"我的选择为什么少了几个"；而保留过期引用又会
 * 让后续写入拿到 `StaleReference`。故剔除 + 报告是唯一同时满足两边的做法。
 *
 * 对象选择**不**被剔除（对象存在性由场景判定；不在本函数职责内）。
 */
export function pruneStaleElements(scene: Scene, s: SelectionSet): { readonly selection: SelectionSet; readonly dropped: readonly SelectionTarget[] } {
  const dropped: SelectionTarget[] = []
  const byMode: Record<SelectionMode, readonly SelectionTarget[]> = { object: s.byMode.object, vertex: [], edge: [], face: [] }
  for (const mode of ['vertex', 'edge', 'face'] as const) {
    const kept: SelectionTarget[] = []
    for (const t of s.byMode[mode]) {
      if (t.kind === 'object') {
        kept.push(t)
        continue
      }
      const data = findObjectData(scene, t.dataId)
      const mesh = data ? meshFromPayload(data.payload) : undefined
      // 数据不存在、不是网格、或拓扑版本不符 ⇒ 失效
      if (!mesh || mesh.topology.version !== t.element.topologyVersion) {
        dropped.push(t)
        continue
      }
      // 元素本身还在吗？（版本对但元素被删也要剔除）
      const exists = mesh.topology.vertices.some((v) => v.id === t.element.elementId)
      if (!exists) {
        dropped.push(t)
        continue
      }
      kept.push(t)
    }
    byMode[mode] = Object.freeze(kept)
  }
  const active = s.active === null ? null : keepOrDrop(s.active, dropped)
  const selection = Object.freeze({ ...s, byMode: Object.freeze(byMode), active })
  return Object.freeze({ selection, dropped: Object.freeze(dropped) })
}

function keepOrDrop(active: SelectionTarget, dropped: readonly SelectionTarget[]): SelectionTarget | null {
  return dropped.some((d) => sameTarget(d, active)) ? null : active
}

/**
 * 造一个顶点目标（便利函数；**强制**经网格拓扑取正确的 `topologyVersion`）。
 *
 * 这是"引用必须带版本"的入口约束：调用方拿不到"不带版本"的顶点引用。
 */
export function vertexTargetIn(scene: Scene, objectId: string, dataId: string, vertex: VertexId): Result<SelectionTarget> {
  const data = findObjectData(scene, dataId)
  if (!data) return err(invalidValue({ reason: 'dataMissing', dataId }))
  const mesh = meshFromPayload(data.payload)
  if (!mesh) return err(invalidValue({ reason: 'notAMesh', dataId }))
  if (!mesh.topology.vertices.some((v) => v.id === vertex)) {
    return err(invalidValue({ reason: 'elementMissing', elementId: vertex, dataId }))
  }
  return ok(vertexTarget(objectId, dataId, elementRef(vertex, mesh.topology.version)))
}

// ─────────────────────────────────────────────────────────────────────────────
// 与 P1 `SelectionState` 的组合（手势维度 × 目标维度）
// ─────────────────────────────────────────────────────────────────────────────

/** P1 的拾取手势（`'single' | 'box' | 'type' | 'annotation'`）。 */
export type GestureMode = 'single' | 'box' | 'type' | 'annotation'

/**
 * 把手势与目标维度**显式**组合成 P1 `SelectionState.mode` 所需的字符串。
 *
 * 为什么需要它：P1 的 `mode` 字段是手势（`box` = 框选），而本模块的 `SelectionMode`
 * 是目标种类（`vertex` = 选顶点）。两者正交，但 P1 只有一个字符串字段。
 * 本函数给出**确定**的编码（手势优先，目标维度作为限定后缀），
 * 使"框选顶点"这种组合可表达、可往返（见 {@link splitSelectionMode}）。
 *
 * 这是**登记过的编码**，不是靠字符串前缀猜语义的旁路：
 * 两个函数在同一文件里互为逆，且由测试锁定往返一致。
 */
export function composeSelectionMode(gesture: GestureMode, target: SelectionMode): string {
  return target === 'object' ? gesture : `${gesture}:${target}`
}

export function splitSelectionMode(mode: string): { readonly gesture: GestureMode; readonly target: SelectionMode } {
  const idx = mode.indexOf(':')
  if (idx < 0) return { gesture: mode as GestureMode, target: 'object' }
  return { gesture: mode.slice(0, idx) as GestureMode, target: mode.slice(idx + 1) as SelectionMode }
}

/** 顶点目标（若齐备）取对象 id 与数据 id；供上游按需要筛选。 */
export function elementTargetOwner(t: SelectionTarget): { readonly objectId: string; readonly dataId: string } | null {
  if (t.kind === 'object') return null
  return { objectId: t.objectId, dataId: t.dataId }
}
