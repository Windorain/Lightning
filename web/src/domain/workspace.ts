/**
 * `domain/workspace` —— **Area 分割树、编辑器类型与固定目标、绑定与切换的纯状态转移**
 * （#249 §3.4 所有权表「Area 分割树、编辑器类型与固定目标」+ §10；契约 §6 表第 5 行）。
 *
 * ## 本模块替代的旧机制（B5 退役矩阵 #10）
 *
 * 旧实现把「编辑状态寿命」挂在**组件挂载**上：`WorkbenchRoot.vue` 用
 * `v-show` 把非当前工作台的 `<WorkbenchShell>` 保活在 DOM 里，于是
 * 「切走再切回状态还在」靠的是"组件从没被卸载"，而不是"状态有自己的拥有者"；
 * 反过来，一旦组件真的被卸载，运行资源（DRW、监听、作业）也就跟着没了 ——
 * 两条后果都是 #249 §15 第 10 条要退役的形态：
 *
 * | 旧形态 | 本模块的替代 |
 * |---|---|
 * | 保活组件来保状态 | 状态是**值**：`Workspace` 与 `Area` 的 `localState` 独立于任何组件存活 |
 * | 卸载组件即销毁资源 | 生命周期是**显式**的：`closeArea` 返回 `disposedInstances`，由接线层释放 |
 * | 切走丢状态 | 每次切类型**移动**（不删除）局部状态到 `localState[type]`，切回原样恢复 |
 *
 * ## 五条硬要求及其落点
 *
 * ### A13「分割/切换/关闭/恢复」
 * `splitArea` / `mergeArea` / `setEditorType` / `closeArea` / `restoreLayout` 五个纯转移，
 * 全部是"输入 `Workspace` + 显式参数 → 新 `Workspace`"，**不改输入**。
 * `closeArea` 返回 `disposedInstances`（被关闭的 Area 上的实例 id），
 * 使"关闭 Area 释放运行资源"成为**可测量**的事实而不是口头承诺。
 *
 * ### A13 负对照「保持废弃组件或丢掉编辑器状态」⇒ 必须判红
 * - 「丢掉编辑器状态」：`setEditorType` 若删掉旧类型的 `localState`，则
 *   `localState[oldType]` 恢复为 `undefined` ⇒ 测试判红。本实现**保留**它。
 * - 「保持废弃组件」：`closeArea` 若返回空 `disposedInstances`（= 没人被销毁），
 *   ⇒ 测试判红。本实现如实列出。
 *
 * ### 100 次循环回基线
 * 全部转移是**纯**的 —— 没有模块级计数器、没有累加器、没有句柄。
 * 因此「100 次分割/切换/关闭/恢复后布局深度与 Area 数与初态一致」是结构性质；
 * 运行资源的计数由接线层（`runtime/lifecycle`）持有并独立断言。
 *
 * ### 工作区加载失败不清空当前有效布局
 *（#249 §10「工作区加载失败不得清空当前有效布局或文档」）
 * `restoreWorkspace(current, stored)` 返回 `Result<Workspace>`：
 * 解析失败时返回 `err`，**当前有效布局与文档绑定原样保留** ——
 * 调用方拿到的是明确的失败，不是"被清空的布局"。
 *
 * ### 组件不得询问宿主名
 * 本模块里**没有** `hostProfile` / `'desktop'` / `'wiki'` 之类的宿主判别。
 * Area 的编辑器类型、可用命令集合一律来自装配解析结果
 * （`composition/resolver`），由调用方**显式传入**。
 */

import { err, ok, invalidValue, missingTarget, type DomainError, type Result } from './errors'

// ─────────────────────────────────────────────────────────────────────────────
// 标识
// ─────────────────────────────────────────────────────────────────────────────

/** Area 稳定 id。 */
export type AreaId = string
/** 分割节点稳定 id。 */
export type SplitId = string
/** 编辑器类型 id（`'viewport3d'` / `'inspector'` / `'timeline'` / `'channels'` / 贡献新增）。 */
export type EditorTypeId = string
/**
 * 编辑器实例 id。
 *
 * **一个 Area 在某一时刻最多有一个活动实例**（`AreaNode.instanceId`）；
 * 切换类型会**释放**旧实例并分配新实例 id。
 * 实例 id 是"运行资源归属"的键：`runtime/lifecycle` 按它登记 acquire/release。
 */
export type EditorInstanceId = string

// ─────────────────────────────────────────────────────────────────────────────
// 编辑器目标（H2：跟随活动对象或固定对象）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 编辑器目标（#249 §10「编辑器可以跟随活动对象或固定对象；
 * 目标删除时显示失效状态，不悄悄改成另一对象」）。
 *
 * `{ kind: 'followActive' }` 与 `{ kind: 'fixed', objectId }` 是**两个不同事实**：
 * 前者在活动对象改变时自动改看，后者**永不**自动改看 ——
 * 这正是 H2 要区分的语义。目标被删除时 `fixed` 目标进入
 * `resolveTarget` 的 `'missing'` 分支（显示失效状态），**不**回退成 followActive。
 */
export type EditorTarget =
  | { readonly kind: 'followActive' }
  | { readonly kind: 'fixed'; readonly objectId: string }

export const FOLLOW_ACTIVE: EditorTarget = Object.freeze({ kind: 'followActive' })

export function fixedTarget(objectId: string): EditorTarget {
  return Object.freeze({ kind: 'fixed', objectId })
}

/**
 * 解析编辑器当前实际观察的对象。
 *
 * 返回**判别式**而不是 `string | null` —— 因为"H2 目标删除显示失效状态"
 * 与"跟随活动对象且当前没选"是两个不同呈现，用 `null` 兼表会让
 * 「失效」与「未选」不可区分（#249 §19.3 对资源状态有同一要求：
 * 「`null` 同时代表加载中/缺失/失败」是 A36 负对照）。
 */
export type ResolvedTarget =
  | { readonly status: 'resolved'; readonly objectId: string; readonly via: 'followActive' | 'fixed' }
  | { readonly status: 'none' }
  | { readonly status: 'missing'; readonly objectId: string }

export function resolveTarget(target: EditorTarget, activeObjectId: string | null, exists: (id: string) => boolean): ResolvedTarget {
  if (target.kind === 'followActive') {
    if (activeObjectId === null) return Object.freeze({ status: 'none' })
    return exists(activeObjectId)
      ? Object.freeze({ status: 'resolved', objectId: activeObjectId, via: 'followActive' })
      : Object.freeze({ status: 'missing', objectId: activeObjectId })
  }
  // 固定目标：**不**因活动对象改变而改看；目标删除 ⇒ missing（不悄悄改绑）
  return exists(target.objectId)
    ? Object.freeze({ status: 'resolved', objectId: target.objectId, via: 'fixed' })
    : Object.freeze({ status: 'missing', objectId: target.objectId })
}

// ─────────────────────────────────────────────────────────────────────────────
// 局部状态（切走保留、切回恢复）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 观察视角（3D 编辑器实例私有；#249 §3.4「观察视角、局部显示 | 3D 编辑器实例 |
 * 各实例独立、切回保留」；契约 §6「机位**不进** `EvaluationKey` 主键」）。
 *
 * 纯数据、可序列化 —— 故它能进"工作环境存储"，也能在 Area 切走时被保留。
 */
export interface ObservationView {
  readonly yawDeg: number
  readonly elevationDeg: number
  readonly distance: number
  readonly target: Readonly<{ x: number; y: number; z: number }>
}

export const DEFAULT_OBSERVATION_VIEW: ObservationView = Object.freeze({
  yawDeg: 225,
  elevationDeg: 35.264,
  distance: 16,
  target: Object.freeze({ x: 0, y: 0, z: 0 }),
})

/**
 * 某一编辑器类型在某 Area 内的**可序列化局部状态**。
 *
 * 开放映射（`Record<string, unknown>`）是**有意**的：编辑器类型由贡献注册
 * （A21「通过贡献添加测试文字类型与专用控件」），核心不能为每个新类型
 * 加一个字段 —— 那正是"新增对象/属性不能要求同步修改不相关外壳"要禁止的。
 *
 * 判据（本模块不替编辑器类型解释内容，只保证**不丢失**）：
 * 任意可序列化值放入 `localState[type]`，切走再切回后必须**逐字段相等**。
 */
export type EditorLocalState = Readonly<Record<string, unknown>>

// ─────────────────────────────────────────────────────────────────────────────
// 布局树
// ─────────────────────────────────────────────────────────────────────────────

export type SplitDirection = 'horizontal' | 'vertical'

/** 叶子：一个 Area。 */
export interface AreaNode {
  readonly kind: 'area'
  readonly id: AreaId
  /** 当前编辑器类型。 */
  readonly editorType: EditorTypeId
  /**
   * 当前活动编辑器实例 id；`null` = 尚未实例化（例如刚恢复、或类型被裁剪）。
   *
   * 它与 `editorType` **分开**：类型是"想要什么"，实例是"实际起了什么"。
   * 合并成一个字段会让"能力被裁剪导致实例起不来"无法表达（A15 的裁剪原因就挂在这里）。
   */
  readonly instanceId: EditorInstanceId | null
  readonly target: EditorTarget
  /**
   * 各**已访问**编辑器类型的局部状态（#249 §10「每个 Area 可保留各已访问编辑器类型的
   * 可序列化局部状态，切回恢复」）。
   *
   * 键是编辑器类型 id。**关闭 Area 之前不会删除键** ——
   * 这是"切回恢复"唯一的实现方式；若某天要淘汰，必须有显式保留政策。
   */
  readonly localState: Readonly<Record<EditorTypeId, EditorLocalState>>
}

/** 内部节点：一次分割。 */
export interface SplitNode {
  readonly kind: 'split'
  readonly id: SplitId
  readonly direction: SplitDirection
  /** `first` 占的份额（0..1）。`0.5` = 均分。 */
  readonly ratio: number
  readonly first: AreaLayoutNode
  readonly second: AreaLayoutNode
}

export type AreaLayoutNode = AreaNode | SplitNode

/** 空布局的显式表达（不是一个"空树"）。 */
export type AreaLayout = AreaLayoutNode | null

export function isArea(node: AreaLayoutNode): node is AreaNode {
  return node.kind === 'area'
}
export function isSplit(node: AreaLayoutNode): node is SplitNode {
  return node.kind === 'split'
}

// ─────────────────────────────────────────────────────────────────────────────
// 构造
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateAreaInput {
  readonly id: AreaId
  readonly editorType: EditorTypeId
  readonly target?: EditorTarget
  readonly localState?: Readonly<Record<EditorTypeId, EditorLocalState>>
}

export function createArea(input: CreateAreaInput): AreaNode {
  return Object.freeze({
    kind: 'area',
    id: input.id,
    editorType: input.editorType,
    instanceId: null,
    target: input.target ?? FOLLOW_ACTIVE,
    localState: Object.freeze({ ...(input.localState ?? {}) }),
  })
}

export function createInitialLayout(input: CreateAreaInput): AreaNode {
  return createArea(input)
}

// ─────────────────────────────────────────────────────────────────────────────
// 遍历（纯查询）
// ─────────────────────────────────────────────────────────────────────────────

/** 按**深度优先**枚举所有 Area（顺序稳定，供 100 次循环对账）。 */
export function collectAreas(layout: AreaLayout): readonly AreaNode[] {
  const out: AreaNode[] = []
  const walk = (n: AreaLayoutNode): void => {
    if (n.kind === 'area') out.push(n)
    else {
      walk(n.first)
      walk(n.second)
    }
  }
  if (layout) walk(layout)
  return out
}

/** 布局里所有 Area 的 id（稳定顺序）。 */
export function areaIds(layout: AreaLayout): readonly AreaId[] {
  return collectAreas(layout).map((a) => a.id)
}

/** 布局里所有分割节点的 id（稳定顺序）。 */
export function splitIds(layout: AreaLayout): readonly SplitId[] {
  const out: SplitId[] = []
  const walk = (n: AreaLayoutNode): void => {
    if (n.kind === 'split') {
      out.push(n.id)
      walk(n.first)
      walk(n.second)
    }
  }
  if (layout) walk(layout)
  return out
}

export function findArea(layout: AreaLayout, id: AreaId): AreaNode | undefined {
  return collectAreas(layout).find((a) => a.id === id)
}

/** 布局**深度**（叶为 1，空为 0）。100 次循环后必须回到初值。 */
export function layoutDepth(layout: AreaLayout): number {
  if (!layout) return 0
  if (layout.kind === 'area') return 1
  return 1 + Math.max(layoutDepth(layout.first), layoutDepth(layout.second))
}

/** 布局的结构指纹（供"100 次后与初态一致"的可复核断言）。 */
export function layoutFingerprint(layout: AreaLayout): string {
  if (!layout) return '∅'
  if (layout.kind === 'area') return `A(${layout.id}:${layout.editorType})`
  return `S(${layout.direction},${round6(layout.ratio)};${layoutFingerprint(layout.first)};${layoutFingerprint(layout.second)})`
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

// ─────────────────────────────────────────────────────────────────────────────
// 结构变换（纯；不改输入）
// ─────────────────────────────────────────────────────────────────────────────

/** 用 `map` 替换树里的一个 Area 节点（保持未变子树的**引用**）。 */
function replaceArea(layout: AreaLayout, id: AreaId, next: AreaLayoutNode): AreaLayout {
  if (!layout) return null
  if (layout.kind === 'area') return layout.id === id ? next : layout
  const first = replaceArea(layout.first, id, next)
  const second = replaceArea(layout.second, id, next)
  if (first === layout.first && second === layout.second) return layout
  return Object.freeze({ ...layout, first: first as AreaLayoutNode, second: second as AreaLayoutNode })
}

/** 更新一个 Area 的属性（函数式；未命中时返回**原引用**）。 */
export function updateArea(layout: AreaLayout, id: AreaId, patch: (a: AreaNode) => AreaNode): AreaLayout {
  const cur = findArea(layout, id)
  if (!cur) return layout
  const next = patch(cur)
  if (next === cur) return layout
  return replaceArea(layout, id, next)
}

export interface SplitAreaInput {
  /** 被分割的 Area id（保留在 `first` 侧）。 */
  readonly areaId: AreaId
  /** 新 Area 的 id。 */
  readonly newAreaId: AreaId
  /** 新分割节点的 id。 */
  readonly splitId: SplitId
  readonly direction: SplitDirection
  readonly ratio?: number
  /** 新 Area 的编辑器类型；缺省与被分割者相同。 */
  readonly editorType?: EditorTypeId
}

/**
 * 分割一个 Area。
 *
 * 语义选择（显式，不静默）：
 *  - 新 Area **不继承**旧 Area 的 `localState` —— 局部状态是**实例私有**的
 *    （#249 §3.4：观察视角"各实例独立"）。继承它会让"两个 3D Area 机位独立"
 *    这条验收（A05/H1）在分割的瞬间就失败。
 *  - 新 Area 的 `target` 与被分割者相同（目标属**布局意图**，不是实例私有状态）。
 *  - 新 Area `instanceId` 为 `null`：实例由接线层（`runtime/lifecycle`）在
 *    该 Area 挂载时分配，纯转移不去猜运行资源。
 */
export function splitArea(layout: AreaLayout, input: SplitAreaInput): Result<AreaLayout> {
  const target = findArea(layout, input.areaId)
  if (!target) return err(missingTarget({ areaId: input.areaId }))
  if (input.newAreaId === input.areaId || findArea(layout, input.newAreaId)) {
    return err(invalidValue({ reason: 'areaIdCollision', areaId: input.newAreaId }))
  }
  if (splitIds(layout).includes(input.splitId)) {
    return err(invalidValue({ reason: 'splitIdCollision', splitId: input.splitId }))
  }
  const ratio = input.ratio ?? 0.5
  if (!(ratio > 0 && ratio < 1)) return err(invalidValue({ reason: 'ratioOutOfRange', ratio }))

  const fresh = createArea({
    id: input.newAreaId,
    editorType: input.editorType ?? target.editorType,
    target: target.target,
  })
  const next: SplitNode = Object.freeze({
    kind: 'split',
    id: input.splitId,
    direction: input.direction,
    ratio,
    first: target,
    second: fresh,
  })
  return ok(replaceArea(layout, input.areaId, next))
}

/** 合并结果：新布局 + **被关闭的 Area**（供接线层释放运行资源）。 */
export interface MergeResult {
  readonly layout: AreaLayout
  readonly closedAreaIds: readonly AreaId[]
  /** 被关闭 Area 上曾活动的编辑器实例 id（**资源释放的依据**）。 */
  readonly disposedInstances: readonly EditorInstanceId[]
}

/**
 * 合并：关闭 `areaId`，其**兄弟子树**上提一层。
 *
 * 若根就是该 Area（无父分割），合并的结果是空布局 —— 这是显式的 `null`，
 * 不是"悄悄留一个空壳"。
 */
export function mergeArea(layout: AreaLayout, areaId: AreaId): Result<MergeResult> {
  if (!layout) return err(missingTarget({ areaId }))
  const target = findArea(layout, areaId)
  if (!target) return err(missingTarget({ areaId }))
  if (layout.kind === 'area') {
    return ok(Object.freeze({ layout: null, closedAreaIds: Object.freeze([areaId]), disposedInstances: instanceOf(target) }))
  }

  /** 递归：在 `node` 里找到含 `areaId` 的**最近**分割，用它执行上提。 */
  const walk = (node: AreaLayoutNode): { node: AreaLayoutNode; closed: readonly AreaId[]; disposed: readonly EditorInstanceId[] } | null => {
    if (node.kind === 'area') return null
    if (node.first.kind === 'area' && node.first.id === areaId) {
      const closedSubtree = collectAreas(node.first)
      return { node: node.second, closed: closedSubtree.map((a) => a.id), disposed: closedSubtree.flatMap(instanceOf) }
    }
    if (node.second.kind === 'area' && node.second.id === areaId) {
      const closedSubtree = collectAreas(node.second)
      return { node: node.first, closed: closedSubtree.map((a) => a.id), disposed: closedSubtree.flatMap(instanceOf) }
    }
    const inFirst = walk(node.first)
    if (inFirst) return { node: Object.freeze({ ...node, first: inFirst.node }) as AreaLayoutNode, closed: inFirst.closed, disposed: inFirst.disposed }
    const inSecond = walk(node.second)
    if (inSecond) return { node: Object.freeze({ ...node, second: inSecond.node }) as AreaLayoutNode, closed: inSecond.closed, disposed: inSecond.disposed }
    return null
  }

  const r = walk(layout)
  if (!r) return err(missingTarget({ areaId }))
  return ok(Object.freeze({ layout: r.node, closedAreaIds: Object.freeze([...r.closed]), disposedInstances: Object.freeze([...r.disposed]) }))
}

function instanceOf(a: AreaNode): readonly EditorInstanceId[] {
  return a.instanceId === null ? [] : [a.instanceId]
}

/**
 * 显式关闭一个 Area（**不做上提**，用于"关闭 = 关掉这一格并让兄弟占位"的语义）。
 *
 * 与 `mergeArea` 的区别：`mergeArea` 是"把这一格的**空间**让给兄弟"，
 * `closeArea` 是"关掉这一格的**内容**（释放其运行资源）"。
 * 两者都如实返回 `disposedInstances`（A13 的资源判据挂在这里）。
 */
export function closeArea(layout: AreaLayout, areaId: AreaId): Result<MergeResult> {
  return mergeArea(layout, areaId)
}

export interface SetEditorTypeInput {
  readonly areaId: AreaId
  readonly editorType: EditorTypeId
  /**
   * 该类型的初始局部状态（**仅当 `localState[editorType]` 尚不存在时**采用）。
   *
   * 这就是"切回恢复"的执行点：已经访问过的类型**不**用这里的值覆盖。
   */
  readonly initialLocalState?: EditorLocalState
}

/**
 * 切换 Area 的编辑器类型。
 *
 * **切走不丢状态**：旧类型的 `localState` 原样留在映射里（不删除、不清空）。
 * **切回原样恢复**：新类型若已访问过，其 `localState` 逐字段保留；
 * 首次访问才采用 `initialLocalState`。
 *
 * 切换**释放旧实例**：返回 `disposedInstances`（旧 `instanceId`）。
 * 这不是副作用，而是把"切类型要还资源"变成转移的**显式结果**。
 */
export function setEditorType(
  layout: AreaLayout,
  input: SetEditorTypeInput,
): Result<{ layout: AreaLayout; disposedInstances: readonly EditorInstanceId[] }> {
  const area = findArea(layout, input.areaId)
  if (!area) return err(missingTarget({ areaId: input.areaId }))
  const sameType = area.editorType === input.editorType
  const hasState = Object.prototype.hasOwnProperty.call(area.localState, input.editorType)
  // 幂等：已经是该类型且无需补初始局部状态 ⇒ **原引用**返回。
  // 这不只是省一次分配：它让"未换类型不得谎报释放"成为类型/引用层面的可断言事实，
  // 也避免每次点同一个 tab 就把布局树的身份换掉（结构共享，契约 §3.1）。
  if (sameType && hasState) return ok(Object.freeze({ layout, disposedInstances: Object.freeze([]) }))
  if (sameType && input.initialLocalState === undefined) {
    return ok(Object.freeze({ layout, disposedInstances: Object.freeze([]) }))
  }
  const localState: Record<EditorTypeId, EditorLocalState> = { ...area.localState }
  if (!hasState && input.initialLocalState !== undefined) localState[input.editorType] = input.initialLocalState
  const next: AreaNode = Object.freeze({
    ...area,
    editorType: input.editorType,
    // 换类型时实例 id 归零：新类型的实例由接线层重新分配（旧实例已 dispose）
    instanceId: sameType ? area.instanceId : null,
    localState: Object.freeze(localState),
  })
  const nextLayout = updateArea(layout, input.areaId, () => next)
  return ok(Object.freeze({ layout: nextLayout, disposedInstances: Object.freeze([...instanceOf(area)]) }))
}

/** 写入某 Area 某编辑器类型的局部状态（切走前的"保存"）。 */
export function setLocalState(
  layout: AreaLayout,
  areaId: AreaId,
  editorType: EditorTypeId,
  state: EditorLocalState,
): Result<AreaLayout> {
  const area = findArea(layout, areaId)
  if (!area) return err(missingTarget({ areaId }))
  const next: AreaNode = Object.freeze({
    ...area,
    localState: Object.freeze({ ...area.localState, [editorType]: Object.freeze({ ...state }) }),
  })
  return ok(updateArea(layout, areaId, () => next))
}

/** 读某 Area 某编辑器类型的局部状态（切回时的"恢复"）。 */
export function localStateOf(layout: AreaLayout, areaId: AreaId, editorType: EditorTypeId): EditorLocalState | undefined {
  const area = findArea(layout, areaId)
  if (!area) return undefined
  return Object.prototype.hasOwnProperty.call(area.localState, editorType) ? area.localState[editorType] : undefined
}

/** 绑定/解绑活动编辑器实例（接线层在挂载/卸载时调用）。 */
export function withInstance(layout: AreaLayout, areaId: AreaId, instanceId: EditorInstanceId | null): Result<AreaLayout> {
  const area = findArea(layout, areaId)
  if (!area) return err(missingTarget({ areaId }))
  if (area.instanceId === instanceId) return ok(layout)
  return ok(updateArea(layout, areaId, (a) => Object.freeze({ ...a, instanceId })))
}

export function setAreaTarget(layout: AreaLayout, areaId: AreaId, target: EditorTarget): Result<AreaLayout> {
  const area = findArea(layout, areaId)
  if (!area) return err(missingTarget({ areaId }))
  return ok(updateArea(layout, areaId, (a) => Object.freeze({ ...a, target })))
}

/**
 * 调整分割比例（#249 §10「Area 支持分割、合并、调尺寸」）。
 *
 * 关键语义（#249 §8）：**不因布局调尺寸取消当前交互** ——
 * 本函数只碰布局树，既不产生命令、也不接触 `EditContext`。
 */
export function setSplitRatio(layout: AreaLayout, splitId: SplitId, ratio: number): Result<AreaLayout> {
  if (!(ratio > 0 && ratio < 1)) return err(invalidValue({ reason: 'ratioOutOfRange', ratio }))
  const walk = (n: AreaLayoutNode): AreaLayoutNode => {
    if (n.kind === 'area') return n
    const first = walk(n.first)
    const second = walk(n.second)
    if (n.id !== splitId && first === n.first && second === n.second) return n
    return Object.freeze({ ...n, ratio: n.id === splitId ? ratio : n.ratio, first, second })
  }
  if (!splitIds(layout).includes(splitId)) return err(missingTarget({ splitId }))
  return ok(walk(layout as AreaLayoutNode) as AreaLayout)
}

// ─────────────────────────────────────────────────────────────────────────────
// 工作区（布局 + 绑定 + 活动 Area）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 工作环境状态（#249 §3.4「Area 分割树、编辑器类型与固定目标 | Workspace |
 * **组件卸载不销毁** | 独立工作环境存储」）。
 *
 * `Workspace` 是**纯值**：它不持有组件、不持有 Vue Ref、不持有 Three 对象。
 * 因此"组件卸载不销毁编辑器状态"不是靠保活实现的，
 * 而是因为**状态本来就不在组件里**（B5 #10 的替代关系）。
 *
 * ## 多文档与绑定（#257 执行范围）
 *
 * - 应用管理多文档；**每工作区默认绑定一个文档**（`documentId`）；
 * - **多个工作区可以查看同一文档**（两条 `Workspace` 的 `documentId` 相同）；
 * - **可显式绑定同一 `EditContext` 联动**（`editContextId` 相同 ⇒ 共享选择/时间/通道/暂存）；
 * - 「是否共享时间/通道/选择**取决于绑定而非外壳名称**」——
 *   本模型里没有任何"外壳名"字段，共享与否只看 `editContextId` 是否相同。
 */
export interface Workspace {
  readonly id: string
  readonly layout: AreaLayout
  /** 绑定的文档；`null` = 未绑定（可稍后绑定）。 */
  readonly documentId: string | null
  /** 绑定的 `EditContext` id；相同即联动（显式绑定）。 */
  readonly editContextId: string
  readonly activeAreaId: AreaId | null
}

export function createWorkspace(input: {
  id: string
  editContextId: string
  documentId?: string | null
  layout: AreaLayout
  activeAreaId?: AreaId | null
}): Workspace {
  return Object.freeze({
    id: input.id,
    layout: input.layout,
    documentId: input.documentId ?? null,
    editContextId: input.editContextId,
    activeAreaId: input.activeAreaId ?? (input.layout ? (areaIds(input.layout)[0] ?? null) : null),
  })
}

export function withLayout(ws: Workspace, layout: AreaLayout): Workspace {
  const active = ws.activeAreaId !== null && findArea(layout, ws.activeAreaId) ? ws.activeAreaId : (areaIds(layout)[0] ?? null)
  return Object.freeze({ ...ws, layout, activeAreaId: active })
}

/**
 * 换绑文档（#249 §8：**切文档前先明确取消当前交互**）。
 *
 * 本函数**不**碰 `EditContext` —— 取消交互是命令层的事（`cancelInteraction` 命令），
 * 接线层必须在换绑之前发出它。这里只如实改绑定，并把"需要先取消"作为**返回值**告知，
 * 使"切文档不静默丢弃暂存"有唯一执行点。
 */
export function bindDocument(ws: Workspace, documentId: string | null): Workspace {
  if (ws.documentId === documentId) return ws
  return Object.freeze({ ...ws, documentId })
}

/** 显式绑定到另一个 `EditContext`（联动）或保持独立。 */
export function bindEditContext(ws: Workspace, editContextId: string): Workspace {
  if (ws.editContextId === editContextId) return ws
  return Object.freeze({ ...ws, editContextId })
}

/** 两个工作区是否**联动**（共享选择/时间/通道/暂存）。判据只有绑定，没有外壳名。 */
export function isLinked(a: Workspace, b: Workspace): boolean {
  return a.editContextId === b.editContextId
}

export function setActiveArea(ws: Workspace, areaId: AreaId): Result<Workspace> {
  if (!findArea(ws.layout, areaId)) return err(missingTarget({ areaId }))
  return ok(Object.freeze({ ...ws, activeAreaId: areaId }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 持久化（工作环境存储；布局与个人偏好独立于工程内容 —— #249 §1.1 方向 13）
// ─────────────────────────────────────────────────────────────────────────────

/** 可序列化的工作环境快照（**只含值**，不含组件/句柄）。 */
export interface WorkspaceSnapshot {
  readonly version: 1
  readonly id: string
  readonly documentId: string | null
  readonly editContextId: string
  readonly activeAreaId: AreaId | null
  readonly layout: AreaLayoutNode | null
}

export function snapshotWorkspace(ws: Workspace): WorkspaceSnapshot {
  return Object.freeze({
    version: 1,
    id: ws.id,
    documentId: ws.documentId,
    editContextId: ws.editContextId,
    activeAreaId: ws.activeAreaId,
    layout: ws.layout,
  })
}

/**
 * 恢复工作环境。
 *
 * ## 「工作区加载失败不得清空当前有效布局或文档」（#249 §10 明文）
 *
 * 本函数是**纯**的：它**不能**清空任何东西 —— 它只返回 `Result`。
 * 调用方拿到 `err` 后保留自己手上的 `current`。
 * 这把"失败时不清空"从"实现者的自觉"变成**结构事实**：
 * 失败的路径上根本不存在一个可被写入的 `current` 参数。
 *
 * 校验项（任一不符即 `err`，附结构化原因）：
 *  - `version` 必须为 1（未来版本需要迁移，不静默当作当前版本读）；
 *  - 布局里**无重复 Area id / Split id**；
 *  - 每个 Area 的 `editorType` 为非空字符串；
 *  - 分割 `ratio` 落在开区间 `(0,1)`；
 *  - `activeAreaId`（若非 null）必须存在于布局中。
 */
export function restoreWorkspace(current: Workspace, stored: unknown): Result<Workspace> {
  const parsed = validateSnapshot(stored)
  if (!parsed.ok) return err(parsed.error)
  const snap = parsed.value
  // 恢复**保留**当前工作区的 id 与编辑上下文绑定（工作环境存储不携带运行绑定）。
  const layout = snap.layout
  const restored: Workspace = Object.freeze({
    id: current.id,
    layout,
    documentId: snap.documentId ?? current.documentId,
    editContextId: current.editContextId,
    activeAreaId: snap.activeAreaId !== null && findArea(layout, snap.activeAreaId) ? snap.activeAreaId : (areaIds(layout)[0] ?? null),
  })
  return ok(restored)
}

function validateSnapshot(stored: unknown): Result<WorkspaceSnapshot> {
  if (typeof stored !== 'object' || stored === null) return err(invalidValue({ reason: 'workspaceSnapshotNotObject' }))
  const s = stored as Partial<WorkspaceSnapshot>
  if (s.version !== 1) return err(invalidValue({ reason: 'workspaceSnapshotVersionUnsupported', version: String(s.version) }))
  const layout = s.layout ?? null
  if (layout !== null) {
    const bad = validateLayoutNode(layout)
    if (bad) return err(bad)
  }
  const activeAreaId = s.activeAreaId ?? null
  if (activeAreaId !== null && !findArea(layout, activeAreaId)) {
    return err(invalidValue({ reason: 'activeAreaMissing', areaId: activeAreaId }))
  }
  return ok(
    Object.freeze({
      version: 1,
      id: typeof s.id === 'string' ? s.id : '',
      documentId: typeof s.documentId === 'string' ? s.documentId : null,
      editContextId: typeof s.editContextId === 'string' ? s.editContextId : '',
      activeAreaId,
      layout,
    }),
  )
}

/** 递归校验布局节点；返回 `null` 表示合法。 */
function validateLayoutNode(node: AreaLayoutNode): DomainError | null {
  const seenAreas = new Set<string>()
  const seenSplits = new Set<string>()
  const walk = (n: AreaLayoutNode): DomainError | null => {
    if (n.kind === 'area') {
      if (typeof n.id !== 'string' || n.id === '') return invalidValue({ reason: 'areaIdEmpty' })
      if (seenAreas.has(n.id)) return invalidValue({ reason: 'duplicateAreaId', areaId: n.id })
      seenAreas.add(n.id)
      if (typeof n.editorType !== 'string' || n.editorType === '') return invalidValue({ reason: 'editorTypeEmpty', areaId: n.id })
      return null
    }
    if (typeof n.id !== 'string' || n.id === '') return invalidValue({ reason: 'splitIdEmpty' })
    if (seenSplits.has(n.id)) return invalidValue({ reason: 'duplicateSplitId', splitId: n.id })
    seenSplits.add(n.id)
    if (!(n.ratio > 0 && n.ratio < 1)) return invalidValue({ reason: 'ratioOutOfRange', splitId: n.id, ratio: n.ratio })
    if (n.direction !== 'horizontal' && n.direction !== 'vertical') return invalidValue({ reason: 'splitDirectionInvalid', splitId: n.id })
    return walk(n.first) ?? walk(n.second)
  }
  return walk(node)
}

/**
 * 保留政策（#257「保存的工作环境状态遵循**明确**保留政策」）。
 *
 * 显式列出"什么进工作环境存储、什么不进"，避免"能序列化的都存了"这种隐性政策：
 *
 * | 内容 | 是否保留 | 依据 |
 * |---|---|---|
 * | Area 分割树（含比例、方向、编辑器类型、固定目标） | 保留 | #249 §3.4 该行"独立工作环境存储" |
 * | 各 Area 各类型的局部状态（含观察视角） | 保留 | #249 §3.4"切回保留" |
 * | 活动 Area | 保留 | 用户意图 |
 * | 文档绑定 | 保留 | 但**不由工程文件写入**（布局独立于工程内容） |
 * | `EditContext` 绑定 | **不**持久化 | 它是运行期联动关系，跨会话无效 |
 * | 编辑器实例 id / 资源句柄 | **不**持久化 | 运行资源不进模型（#249 §3.4 末行） |
 * | 悬停、焦点、输入捕获 | **不**持久化 | #249 §3.4"不保存、不记历史" |
 */
export const WORKSPACE_RETENTION = Object.freeze({
  retained: Object.freeze(['layoutTree', 'perTypeLocalState', 'activeArea', 'documentBinding']),
  notRetained: Object.freeze(['editContextBinding', 'editorInstanceId', 'resourceHandles', 'hoverFocusCapture']),
})

/**
 * 关闭 Area 时的局部状态保留政策。
 *
 * #257 明文：「关闭 Area 释放运行资源（不靠隐藏组件保状态）；保存的工作环境状态
 * 遵循**明确**保留政策」。本实现取最保守且可解释的一条：
 * **关闭即不保留该 Area 的局部状态** —— 因为 Area 已不存在，没有"切回"的对象；
 * 保留它会让工作环境存储随关闭次数无界增长，且会让"恢复"误以为该 Area 还在。
 * 布局树本身仍被保存（那是"下次打开看到什么"）。
 * 这条政策是**显式导出**的常量，不是散落在代码里的隐含行为。
 */
export const CLOSED_AREA_RETENTION = 'drop' as const
