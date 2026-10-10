/**
 * `editors/useAreaHost` —— **工作区状态 ↔ 组件生命周期的接线层**（#249 §2.1「接线层」
 * + §10；B5 退役矩阵 #10 主责）。
 *
 * ## 它存在的唯一理由：把"状态"与"组件"分开
 *
 * 旧实现里两者**是同一个东西** —— `<WorkbenchShell v-show>` 存活多久，
 * 编辑状态就存活多久。这带来两个方向的错误：
 *
 * | 方向 | 症状 |
 * |---|---|
 * | 组件活着 ⇒ 状态活着 | 关不掉（资源随隐藏子树泄漏） |
 * | 组件死了 ⇒ 状态死了 | 丢视角/丢局部状态（切走再切回回到默认） |
 *
 * 本模块把两者**各自**给一个拥有者：
 *  - **状态**归 `Workspace.layout` 的 `AreaNode.localState`（`domain/workspace`，纯值、可序列化）；
 *  - **组件**归 Vue 的挂载/卸载（`AreaHost.vue`），生命周期与资源账本对齐。
 *
 * 于是：
 *  - 关闭 Area ⇒ 组件卸载 ⇒ 资源归还（`runtime/lifecycle` 计数回基线）；
 *  - 状态**不**随组件消失 —— 因为它在 `Workspace` 里，而不在组件里。
 *
 * ## 接线层的边界（#249 §2.1 明文）
 *
 * 本模块**不做**业务决定："切类型要不要保留旧状态"由 `domain/workspace`
 * 的 `setEditorType` 决定；本模块只负责
 *  1. 在组件卸载**之前**把当前局部状态写回布局树（`captureLocalState`）；
 *  2. 在组件挂载**之后**从布局树读回（`restoreLocalState`）；
 *  3. 维护 `instanceId` 的分配与 `AreaNode.instanceId` 的同步；
 *  4. 维护资源账本（`runtime/lifecycle`）。
 *
 * ## 实例 id 的分配是**显式输入**
 *
 * #249 §2.1 要求纯函数"需要身份分配时作为输入传入"。
 * 故本模块持有一个计数器并把下一个 id 作为参数传进 `setEditorType` 之外的地方；
 * `domain/workspace` 自己不造 id（它只接受 `newAreaId`/`splitId`/`instanceId`）。
 */

import { computed, ref, type Ref } from 'vue'
import {
  areaIds,
  collectAreas,
  findArea,
  splitArea,
  mergeArea,
  setEditorType as setEditorTypeTransition,
  setLocalState,
  localStateOf,
  setAreaTarget,
  setSplitRatio,
  updateArea,
  withInstance,
  withLayout,
  type AreaId,
  type AreaLayout,
  type EditorInstanceId,
  type EditorLocalState,
  type EditorTarget,
  type EditorTypeId,
  type SplitDirection,
  type SplitId,
  type Workspace,
} from '@/domain/workspace'
import type { DomainError } from '@/domain/errors'
import { createLifecycleLedger, type LifecycleLedger } from '@/runtime/lifecycle'
import { createEditorTypeRegistry, type EditorTypeRegistry } from './areaRegistry'
/** 布局命令的结果（成功/失败都用同一种形状报告，便于 UI 显示结构化原因）。 */
export interface LayoutCommandResult {
  readonly ok: boolean
  readonly error?: DomainError
  /** 被释放的实例 id（供资源对账）。 */
  readonly disposedInstances?: readonly EditorInstanceId[]
}

export interface UseAreaHostOptions {
  /** 初始工作区（由装配/持久化给出）。 */
  readonly initial: Workspace
  /** 编辑器类型注册表（决定组件与资源种类）。 */
  readonly registry?: EditorTypeRegistry
  /** 实例 id 前缀（显式输入，使测试可复现）。 */
  readonly instancePrefix?: string
}

export interface AreaHostApi {
  readonly workspace: Ref<Workspace>
  readonly ledger: Ref<LifecycleLedger>
  readonly registry: EditorTypeRegistry
  readonly areaIds: Ref<readonly AreaId[]>
  readonly activeAreaId: Ref<AreaId | null>
  /** 分配一个新的实例 id（被 `AreaHost` 用；纯计数，无全局状态）。 */
  allocateInstanceId(editorType: EditorTypeId): EditorInstanceId
  /** 组件卸载前：把局部状态写回布局树。返回是否真的写入了内容。 */
  captureLocalState(areaId: AreaId, editorType: EditorTypeId, state: EditorLocalState): boolean
  /** 组件挂载后：从布局树读回局部状态。 */
  restoreLocalState(areaId: AreaId, editorType: EditorTypeId): EditorLocalState | undefined
  /** 登记 `AreaNode.instanceId`（`AreaHost` 挂载/卸载时调用）。 */
  bindInstance(areaId: AreaId, instanceId: EditorInstanceId | null): void
  /** 设置账本（`AreaHost` 的唯一写入路径）。 */
  setLedger(next: LifecycleLedger): void

  // ── 布局编辑命令（#257「Area 支持分割、合并、切类型、恢复」）──────────────
  split(areaId: AreaId, direction: SplitDirection, opts?: { ratio?: number; editorType?: EditorTypeId }): LayoutCommandResult
  merge(areaId: AreaId): LayoutCommandResult
  setEditorType(areaId: AreaId, editorType: EditorTypeId): LayoutCommandResult
  setRatio(splitId: SplitId, ratio: number): LayoutCommandResult
  setTarget(areaId: AreaId, target: EditorTarget): LayoutCommandResult
  setActive(areaId: AreaId): void
}

/**
 * 创建工作区接线层。
 *
 * ## 为什么 `ledger` 用 `Ref` 而不是 `reactive`
 *
 * 账本是**不可变值**（`runtime/lifecycle` 的每次转移返回新账本）。
 * 用 `reactive` 会让"新账本/旧账本"变成同一个代理，
 * 从而破坏"每次转移产生新值"这一可对账性质（P1 在 `ApplicationState` 上
 * 有同一条纪律：用 `Record` 而非 `Map`）。
 */
export function useAreaHost(options: UseAreaHostOptions): AreaHostApi {
  const registry = options.registry ?? createEditorTypeRegistry()
  const workspace = ref<Workspace>(options.initial) as Ref<Workspace>
  const ledger = ref<LifecycleLedger>(createLifecycleLedger()) as Ref<LifecycleLedger>

  const prefix = options.instancePrefix ?? 'inst'
  let counter = 0

  const areaIdsRef = computed(() => areaIds(workspace.value.layout))
  const activeAreaId = computed(() => workspace.value.activeAreaId)

  function setLayout(layout: AreaLayout): void {
    workspace.value = withLayout(workspace.value, layout)
  }

  function fail(error: DomainError): LayoutCommandResult {
    return Object.freeze({ ok: false, error })
  }

  function allocateInstanceId(editorType: EditorTypeId): EditorInstanceId {
    counter += 1
    return `${prefix}-${editorType}-${counter}`
  }

  function captureLocalState(areaId: AreaId, editorType: EditorTypeId, state: EditorLocalState): boolean {
    const r = setLocalState(workspace.value.layout, areaId, editorType, state)
    if (!r.ok) return false
    if (r.value === workspace.value.layout) return false
    setLayout(r.value)
    return true
  }

  function restoreLocalState(areaId: AreaId, editorType: EditorTypeId): EditorLocalState | undefined {
    return localStateOf(workspace.value.layout, areaId, editorType)
  }

  function bindInstance(areaId: AreaId, instanceId: EditorInstanceId | null): void {
    // 已被关闭的 Area：忽略（**不是**"静默成功"—— 调用方从 `areaIds` 能看出它没了）。
    if (!findArea(workspace.value.layout, areaId)) return
    const r = withInstance(workspace.value.layout, areaId, instanceId)
    if (r.ok && r.value !== workspace.value.layout) setLayout(r.value)
  }

  function setLedger(next: LifecycleLedger): void {
    ledger.value = next
  }

  // ── 布局编辑命令 ─────────────────────────────────────────────────────────

  /** 按"未使用的 id"生成规则：`a1`… 冲突时顺延（不静默复用已关闭 Area 的 id）。 */
  function nextAreaId(): AreaId {
    const used = new Set(areaIdsRef.value)
    for (let i = 1; i < 10000; i++) {
      const id = `a${i}`
      if (!used.has(id)) return id
    }
    return `a${used.size + 1}`
  }

  function nextSplitId(): SplitId {
    const layout = workspace.value.layout
    const used = new Set<string>()
    const walk = (n: AreaLayout): void => {
      if (!n) return
      if (n.kind === 'split') {
        used.add(n.id)
        walk(n.first)
        walk(n.second)
      }
    }
    walk(layout)
    // 分割会替换掉一个叶子 ⇒ 它的 id 变为可用；用"旧 id 后缀"命名便于阅读
    const base = areaIdOrRoot()
    for (let i = 1; i < 10000; i++) {
      const id = `s${base}-${i}`
      if (!used.has(id)) return id
    }
    return `s${used.size + 1}`
  }

  /** 当前布局里第一个 Area 的数字后缀（供 split id 命名）；无则 0。 */
  function areaIdOrRoot(): number {
    const first = areaIdsRef.value[0]
    if (!first) return 0
    const m = /^a(\d+)$/.exec(first)
    return m ? Number(m[1]) : 0
  }

  function split(areaId: AreaId, direction: SplitDirection, opts?: { ratio?: number; editorType?: EditorTypeId }): LayoutCommandResult {
    const r = splitArea(workspace.value.layout, {
      areaId,
      newAreaId: nextAreaId(),
      splitId: nextSplitId(),
      direction,
      ...(opts?.ratio === undefined ? {} : { ratio: opts.ratio }),
      ...(opts?.editorType === undefined ? {} : { editorType: opts.editorType }),
    })
    if (!r.ok) return fail(r.error)
    setLayout(r.value)
    return Object.freeze({ ok: true })
  }

  function merge(areaId: AreaId): LayoutCommandResult {
    const r = mergeArea(workspace.value.layout, areaId)
    if (!r.ok) return fail(r.error)
    setLayout(r.value.layout)
    return Object.freeze({ ok: true, disposedInstances: r.value.disposedInstances })
  }

  function setEditorType(areaId: AreaId, editorType: EditorTypeId): LayoutCommandResult {
    // 首次访问某类型时的初始局部状态由**注册表**给出（`AreaHost` 挂载后会用
    // `captureLocalState` 覆盖它）。这里刻意**不**塞一个占位值：
    // 空的 `localState` 与"有值"必须可区分（A36 对 `null` 兼表有同一纪律）。
    const r = setEditorTypeTransition(workspace.value.layout, { areaId, editorType })
    if (!r.ok) return fail(r.error)
    setLayout(r.value.layout)
    return Object.freeze({ ok: true, disposedInstances: r.value.disposedInstances })
  }

  function setRatio(splitId: SplitId, ratio: number): LayoutCommandResult {
    const r = setSplitRatio(workspace.value.layout, splitId, ratio)
    if (!r.ok) return fail(r.error)
    setLayout(r.value)
    return Object.freeze({ ok: true })
  }

  function setTarget(areaId: AreaId, target: EditorTarget): LayoutCommandResult {
    const r = setAreaTarget(workspace.value.layout, areaId, target)
    if (!r.ok) return fail(r.error)
    setLayout(r.value)
    return Object.freeze({ ok: true })
  }

  function setActive(areaId: AreaId): void {
    if (!findArea(workspace.value.layout, areaId)) return
    workspace.value = Object.freeze({ ...workspace.value, activeAreaId: areaId })
  }

  return {
    workspace,
    ledger,
    registry,
    areaIds: areaIdsRef,
    activeAreaId,
    allocateInstanceId,
    captureLocalState,
    restoreLocalState,
    bindInstance,
    setLedger,
    split,
    merge,
    setEditorType,
    setRatio,
    setTarget,
    setActive,
  }
}

/** 未使用占位，保持 `collectAreas` / `updateArea` 可达（供下游按需复用）。 */
export { collectAreas, updateArea }
