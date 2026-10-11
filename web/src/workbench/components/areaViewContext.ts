/**
 * `workbench/components/areaViewContext` —— **Area 渲染树的作用域上下文**
 * （#282 P10b Area 产品接线）。
 *
 * ## 为什么需要它（而不是层层传 props）
 *
 * `AreaNodeView` 是**递归**组件：渲染一个叶子需要"该 Area 的实例 id / region /
 * 组件 / 资源清单 / 账本 / 生命周期回调"，而这些知识全在**外壳**
 * （`AreaLayoutHost`）手里。递归每加深一层就多转一手 props，会让"加深一层"
 * 变成"改 N 个签名" —— 而那正是"新增对象/属性不能要求同步修改不相关外壳"
 * （#249 §15 末段）要禁止的形态。
 *
 * `provide`/`inject` 让递归的每一层只认这一个上下文对象。
 *
 * ## 为什么是 `InjectionKey` + 必填（缺注入即抛）
 *
 * 缺注入意味着"本组件被放到了不该放的位置"——那是**装配错误**，必须响亮失败。
 * 给一个缺省空实现会让它渲染一个空壳，而 #249 §13 明文禁止
 * 「空接口、假成功控件」。
 */

import type { InjectionKey, Component } from 'vue'
import type { LifecycleLedger } from '@/runtime/lifecycle'

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
}

export const AREA_VIEW_CONTEXT: InjectionKey<AreaViewContext> = Symbol('areaViewContext')
