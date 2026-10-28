/**
 * `workbench/components/areaViewContext` —— **Area 渲染树的作用域上下文**
 * （Area 产品接线）。
 *
 * ## 为什么需要它（而不是层层传 props）
 *
 * `AreaNodeView` 是**递归**组件：渲染一个叶子需要"该 Area 的实例 id / region /
 * 组件 / 资源清单 / 账本 / 生命周期回调"，而这些知识全在**外壳**
 * （`AreaLayoutHost`）手里。递归每加深一层就多转一手 props，会让"加深一层"
 * 变成"改 N 个签名" —— 而那正是"新增对象/属性不能要求同步修改不相关外壳"
 * 这是要禁止的形态。
 *
 * `provide`/`inject` 让递归的每一层只认这一个上下文对象。
 *
 * ## 为什么是 `InjectionKey` + 必填（缺注入即抛）
 *
 * 缺注入意味着"本组件被放到了不该放的位置"——那是**装配错误**，必须响亮失败。
 * 给一个缺省空实现会让它渲染一个空壳，而契约明文禁止
 * 「空接口、假成功控件」。
 */

import type { InjectionKey, Component } from 'vue'
import type { LifecycleLedger } from '@/runtime/lifecycle'

/**
 * Area 局部状态的可序列化载荷（结构等价于 `domain/workspace#EditorLocalState`）。
 *
 * ## 为什么在这里重述而不是 import 内核类型（架构边纪律）
 *
 * `workbench/**` 是**旧层**：它 import `@/domain/workspace` 会被
 * `tests/architecture/kernel-legacy-isolation.test.ts` 判为"未登记的旧→新依赖"。
 * 本文件只需要"一个 `Record<string, unknown>` 的形状"来表达端口，不消费任何
 * 内核语义 ⇒ 用结构类型，不新增一条需要登记与核销的迁移边（新边应留给真实消费者）。
 * 真正消费 `EditorLocalState` 的是 `editors/AreaHost.vue`（新层，可直接引用）。
 */
export type AreaLocalState = Readonly<Record<string, unknown>>

/** Area 渲染树的作用域能力（由 `AreaLayoutHost` 提供）。 */
export interface AreaViewContext {
  /** 某 Area 的 region id（机位/输入域/槽位按它分配）。 */
  regionIdFor(areaId: string): string
  /** 某 Area 当前的编辑器实例 id（`null` = 尚未实例化）。 */
  instanceIdOf(areaId: string): string | null
  /** 编辑器类型 → 组件（`null` = 本装配无该类型的实现）。 */
  componentFor(editorType: string): Component | null
  /** 该编辑器类型挂载时要 acquire 的资源种类。 */
  resourcesOf(editorType: string): readonly string[]
  /** 当前账本（不可变值）。 */
  ledger(): LifecycleLedger
  /** 写回新账本（`AreaHost` 的唯一写入路径）。 */
  setLedger(next: LifecycleLedger): void
  /** 实例挂载完成 ⇒ 登记 `AreaNode.instanceId`。 */
  onInstanceOpen(payload: { areaId: string; instanceId: string }): void
  /** 实例卸载前 ⇒ 清空 `AreaNode.instanceId`（局部状态已在布局树里）。 */
  onInstanceClose(payload: { areaId: string }): void
  /** 资源账本异常（漏还/过度释放）。 */
  onLifecycleError(payload: { areaId: string; reason: string; detail: unknown }): void
  /**
   * 该 Area 在**当前编辑器类型**下已保存的局部状态（`Workspace.layout.localState`）。
   *
   * 读面给 `AreaHost`，由它作为 `:local-state` 传给编辑器组件 —— 组件在**首次呈现前**
   * 就拿到恢复后的形态，而不是"先默认再改回"。
   */
  localStateOf(areaId: string, editorType: string): AreaLocalState | undefined
  /**
   * 编辑器关闭前交回的局部状态 ⇒ 写回布局树（`useAreaHost#captureLocalState`）。
   *
   * 这是此前**零调用**的那条死机制（`useAreaHost.ts` 的 `captureLocalState`
   * 定义齐备但生产无调用者）：现在由 `AreaHost` 在关闭前问子组件、经此写回。
   */
  onLocalStateCapture(areaId: string, editorType: string, state: AreaLocalState): void
  /**
   * **把该 Area 设为"最后操作的区"**。
   *
   * 布局命令（分割/合并/切类型）的目标解析读活动 Area
   * （`operators/builtin/areaOperators#resolveAreaId`）。旧实现只有分割/合并
   * 算子自己写它 ⇒ 菜单命令永远作用在"上一次被算子选中的那个区"，
   * 与用户刚点的视口无关。
   *
   * 由叶子的 `pointerdown`（捕获阶段，事件首站）调用 —— 见 `AreaNodeView`。
   */
  onActivateArea(areaId: string): void
}

export const AREA_VIEW_CONTEXT: InjectionKey<AreaViewContext> = Symbol('areaViewContext')