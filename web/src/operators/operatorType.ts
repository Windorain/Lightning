/**
 * OperatorType — 对标 Blender 的 wmOperatorType。
 *
 * 操作符是编辑操作的最小可执行单元。
 * 支持三种执行模式：
 * - exec: 无交互执行（可被 API/脚本调用）
 * - invoke: 初始化交互（解析事件、设置参数）
 * - modal: 模态事件循环（每帧/每事件驱动）
 * 另有 poll（上下文检查）和 cancel（外部中断清理）。
 */
import type { Context } from '@/runtime/context'
import type { PropertyDecl } from '@/application/properties'
import type { CapabilityId } from '@/composition/modules'

/** 操作符属性容器（对标 Blender operator properties） */
export type OperatorProperties = Record<string, unknown>

/** invoke/modal 的返回值 */
export const OP_RESULT = {
  FINISHED: 'FINISHED',
  CANCELLED: 'CANCELLED',
  RUNNING_MODAL: 'RUNNING_MODAL',
  PASS_THROUGH: 'PASS_THROUGH',
} as const

export type OpResult = (typeof OP_RESULT)[keyof typeof OP_RESULT]

export interface OperatorType {
  id: string
  label: string
  description?: string
  /** RNA 属性**声明**（数据，非 get/set 闭包）—— 与属性面板共用同一描述协议 */
  properties?: PropertyDecl[]
  /** 是否自动包裹 undo */
  flagUndo?: boolean
  /** 无交互执行 */
  exec?(ctx: Context, props: OperatorProperties): void
  /** 初始化交互，返回模态状态 */
  invoke?(ctx: Context, props: OperatorProperties, event?: PointerEvent | KeyboardEvent): OpResult
  /** 模态事件循环 */
  modal?(ctx: Context, props: OperatorProperties, event: Event): OpResult
  /**
   * 该算子**要求的能力**（来自装配结果；与 `CommandContribution.requires` 同形）。
   *
   * ## 为什么是声明的字段而不是每个 `poll` 里各写一句
   *
   * 此前，"这个算子在嵌入里不可用"写在算子自己的一句**宿主身份判断**里 —— 那是宿主身份
   * 分叉，而且各算子写法不一：有的在 `poll` 里返回 false（UI 上
   * 悄悄消失），有的在 `exec` 里 `return`（点了没反应）。
   *
   * 现在缺能力由**注册表**在一个地方处理（`operators/operatorRegistry`）：
   *  - `exec`/`invoke` 一律**结构化拒绝**（`UnsupportedOperation` + 能力名，
   *    经 `runtime/rejectionNotice` 写成句原因）—— 不是静默成功，也不是静默消失；
   *  - 能力是否具备由 `Context#hasCapability` 回答（装配结果的事实），不问宿主名。
   *
   * 缺省 = 无要求（与旧行为一致）。
   */
  requires?: readonly CapabilityId[]
  /**
   * 上下文检查（返回 false 时操作符在 UI 中灰掉）。
   *
   * ⚠️ **"灰掉"不再只靠 UI**：`operators/availability#operatorAvailability`
   * 把 `poll` 结算成**一个**答案，供注册表的两条入口（`exec`/`invoke`）与生产菜单
   * （`workbench/ux/UIMenu.vue`）共用。于是 `poll` 为 false 时：
   *  - 菜单项 native `disabled` + `title`/`aria` 给出原因；
   *  - 直接入口（快捷键/脚本）按 {@link pollReason} 的声明决定"只记 info"还是"可见拒绝"。
   *
   * `poll` 会被**多处**调用（每次执行/每次菜单打开），故它必须便宜且无副作用；
   * 有真实开销的判据（如 `plainForSave()` 差集）只允许在**打开菜单/执行**这两个
   * 时机各算一次，不得进渲染循环。
   */
  poll?(ctx: Context): boolean
  /**
   * `poll` 返回 false 时的**可行动原因**（可选）。
   *
   * ## 为什么需要它
   *
   * `poll` 为 false 的历史语义覆盖两类完全不同的事实：
   *
   * | 例子 | 用户视角 |
   * |---|---|
   * | 撤销栈空、当前没有选中目标 | "现在没什么可做的" —— 不是失败，弹拒绝反而吵 |
   * | 当前文档不是 Wiki 载入的结构数据 | "这件事做不了，你得换个做法" —— **必须**说清下一步 |
   *
   * 后者在旧实现里就是"点了没反应"（`registry.invoke` 只写 `log.info`），
   * 正是契约禁止的形态。算子通过实现本方法**声明**自己属于哪一类：
   *
   *  - 实现了 ⇒ 菜单灰显 + 该原因；`exec`/`invoke` **结构化拒绝** + 底栏成句原因；
   *  - 未实现 ⇒ 菜单灰显 + 通用原因；`exec`/`invoke` 与改动前逐字一致（只记 info）。
   *
   * 只在 `poll` 为 false 时被求值（成功路径不付这次开销），且返回值必须是
   * `operators/availability#POLL_REASON` 里登记的标识 —— 句子由
   * `domain/rejectionText` 统一成句（两种语言），不在这里拼串。
   */
  pollReason?(ctx: Context): import('./availability').OperatorPollReason | undefined
  /** 仅脚本/API；不在 operator 列表展示 */
  internal?: boolean
  /** 外部取消时的清理 */
  cancel?(ctx: Context, props: OperatorProperties): void
  /** 创建模态状态（每次 invoke 进入模态时调用） */
  initModalState?: () => OperatorProperties
  /** 视口叠加层渲染（逐帧调用） */
  renderOverlay?(ctx: Context, props: OperatorProperties, overlayGroup: THREE.Group): void
}

/* eslint-disable @typescript-eslint/no-unused-vars */
import type * as THREE from 'three'
