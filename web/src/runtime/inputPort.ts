/**
 * `runtime/inputPort` —— **输入端口**：呈现层声明焦点/弹窗/绑定等**显式状态**的入口
 * （分层规则：`runtime` … 提供执行能力）。
 *
 * ## 为什么需要一层端口
 *
 * 组件（`editors/`/`shells/`）不该直接持有 `InputSession`：
 * 那会让"谁在改路由状态"散落在各组件里，回到被退役的形态
 * （万能 `Context` 裸字段 + 各处直写）。端口把可用的**动作**收敛成一组具名方法，
 * 且这些动作**只写显式状态**，不产生领域命令 —— 领域命令一律由 DOM 事实驱动
 * （`adapters/inputBinding`）。
 *
 * | 端口方法 | 谁调用 | 效果 |
 * |---|---|---|
 * | `openModalScope` | 弹窗组件 | 登记作用域（含自己的文本控件 id 与 Escape 回调） |
 * | `setInteraction` | 交互发起方（工具/视口） | 声明"当前有活动交互" |
 * | `setActiveRegion` | Area 装配 | 声明"最后命中的 Area" |
 * | `bindControl` / `unbindControl` | 属性控件（呈现层） | 声明控件 → 领域属性的绑定 |
 * | `textProjection` | 呈现层 | 读三态投影（只读） |
 * | `counters` / `trace` | 诊断（结构化诊断） | 只读观测面 |
 *
 * ## 与 `EditorClient` 的关系
 *
 * 端口**不**暴露 `submit`/`executeNow`：那会造出第二条写通路（明文禁止）。
 * 命令只能由 `adapters/inputBinding` 从 DOM 事实经 `InputSession` 分发。
 */

import type { ControlBinding, InteractionBinding } from '@/application/inputCommands'
import type { HotkeyBinding } from '@/domain/input'
import type { DraftRetainReason, RegisterControlInput, TextDraftEffect } from '@/domain/textDraft'
import type { InputCounters, InputSession, InputTraceEntry } from './inputSession'
import type { draftProjection } from '@/domain/textDraft'

/** 弹窗作用域声明（含 Escape 回调 —— 它是**平台动作**，不产生领域命令）。 */
export interface ModalScopeDeclaration {
  readonly scopeId: string
  readonly blocksBackground?: boolean
  readonly confirmOnEnter?: boolean
  readonly textControlIds?: readonly string[]
  readonly focusId?: string | null
  /**
   * 弹窗的**根元素**（或其 getter）。
   *
   * ## 为什么这是登记的一部分（评审打回）
   *
   * 模态"阻断背景"必须能区分"背景"与"模态自己 DOM 里"——否则原生 `<select>` /
   * 文本框 / checkbox 全被 `preventDefault` 吞掉（焦点与下拉永远打不开，且无报错）。
   * 只有**登记作用域的组件自己**知道根元素是谁（抽屉还 teleport 到 body），
   * 故根元素随作用域一起提交；输入层把它翻成 `hitModalScopeId` 事实。
   *
   * 用 getter 而不是元素：登记发生在 `watch(open)` 的 `pre` 阶段（DOM 还没 patch），
   * 事件发生时元素才一定存在。返回 `null` ⇒ 该作用域退化为"全部按背景吞"（安全方向）。
   */
  readonly root?: Element | (() => Element | null)
  /** Escape 时的动作（关闭弹窗一类）。**不是**领域命令。 */
  readonly onEscape?: () => void
}

export interface InputPort {
  openModalScope(decl: ModalScopeDeclaration): () => void
  /** 关闭指定作用域（若它就是当前作用域）。Escape 路由的落点。 */
  closeModalScope(scopeId: string): boolean
  readonly modalScopeId: string | null
  /**
   * 某个已登记作用域的**根元素**（未登记/已注销 ⇒ `null`）。
   *
   * 只读事实面：适配器据此判定事件目标在模态内部还是背景。它**不**改任何状态。
   */
  modalRootElementOf(scopeId: string | null): Element | null
  setInteraction(interaction: { contextId: string; regionId: string; tool: string } | null): void
  setActiveRegion(regionId: string | null): void
  setHotkeys(area: readonly HotkeyBinding[], app: readonly HotkeyBinding[]): void
  bindControl(binding: ControlBinding): void
  unbindControl(controlId: string): void
  bindInteraction(binding: InteractionBinding): void
  registerTextControl(input: RegisterControlInput, token: number): readonly TextDraftEffect[]
  applyTextInput(controlId: string, text: string, token: number): readonly TextDraftEffect[]
  blurTextControl(controlId: string, reason: DraftRetainReason, token: number): readonly TextDraftEffect[]
  textProjection(controlId: string): ReturnType<typeof draftProjection> | null
  /** 分配事件 token（组件做命令式调用时用；事件驱动的路径由适配器分配）。 */
  nextToken(): number
  /**
   * 按**命令 ID** 分发一次（菜单/工具栏等显式 UI 入口）。
   *
   * ## 为什么它可以出现在端口上，而 `submit`/`executeNow` 不行
   *
   * 端口的设计纪律是"**不**暴露写通路"（见文件头）。本方法看起来像是例外，
   * 但它**不是**：它不接受 `Command`，只接受**命令 ID**，
   * 如 `edit.undo`，并把它交给与键盘事件**完全相同**的那条路由
   * （`InputSession.invokeCommand` → 同一个 `dispatch` → 同一个
   * `resolveIntent` → 同一个 `CommandSink`）。
   *
   * 换句话说：调用方**无法**用它构造一条绕过 `resolveIntent` 的领域命令 ——
   * 它只能"请求一个已登记的命令 ID"。未登记的 ID 会被显式拒绝
   * （`UnsupportedOperation`），不静默。
   *
   * ## 为什么菜单需要它（而不是继续用 operator ID）
   *
   * 旧实现里同一个"撤销"有三个名字：快捷键 `'undo'`、菜单 `'OPERATOR_UNDO'`、
   * 命令空间 `'edit.undo'`。三者无法互相审计（"谁还能触发撤销"没有单一答案），
   * 且菜单的可用性判定与快捷键各写一遍 ⇒ 可以出现"快捷键禁用但菜单可点"。
   * 收敛到命令 ID 后，两者共用同一个 `evaluateCommandAvailability`。
   */
  invokeCommand(commandId: string, params?: Readonly<Record<string, string | number | boolean>>): void
  /**
   * 订阅"会话推进了"（**只读**通知）。
   *
   * ## 为什么是必需的，而不是可选的便利
   *
   * 文本草稿的权威是 `domain/textDraft` —— 它**不在 Vue 的响应式图里**。
   * 组件要按投影渲染（`textProjection(...).draft`），就必须知道"什么时候该重读"。
   * 没有这条通道，组件只能自己再存一份草稿并靠自身 DOM 事件更新 ——
   * 那正是禁止的"第二份草稿权威"（两套政策并存）。
   *
   * 通知**不携带政策**：订阅者只得到"去重读投影"的信号；判定与提交时机
   * 仍全在纯函数里（组件读不到、也改不了）。
   */
  subscribe(listener: () => void): () => void
  readonly counters: InputCounters
  readonly trace: readonly InputTraceEntry[]
}

/** `createInputPort` 的返回类型：多一个**仅供装配层**调用的广播入口。 */
export interface InputPortHandle extends InputPort {
  /**
   * 广播"会话推进了"。**只**由装配层在事件处理完后调用（`composition/assembleInput`）。
   *
   * 为什么不放进 `InputPort`：组件若能手握广播权，就可能在没发生事件时乱广播，
   * 让"投影何时可信"变得不可推理。收窄到装配层是刻意的。
   */
  publish(): void
}

/**
 * 造输入端口。
 *
 * `escapeHandlers` 按 **scopeId** 索引（不共享全局布尔）—— 这正是
 * `wikiInputShield` 的模块级 `wikiModalOpen` 被淘汰的原因：
 * 同页两个实例各自的弹窗互不干扰。
 *
 * Escape 的**路由**由纯路由判定（`modal.close` 意图），本端口只负责在收到该意图时
 * 执行对应作用域的关闭动作（平台动作）。见 `runtime/inputSession` 的 `drainLocal`。
 */
export function createInputPort(session: InputSession): InputPortHandle {
  const escapeHandlers = new Map<string, () => void>()
  /** 作用域 → 根元素（元素或 getter；见 `ModalScopeDeclaration.root`）。 */
  const modalRoots = new Map<string, Element | (() => Element | null)>()
  const listeners = new Set<() => void>()

  return {
    publish() {
      // 快照遍历：订阅者在通知中退订不得影响本次广播。
      for (const fn of [...listeners]) fn()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    nextToken() {
      return session.nextToken()
    },
    invokeCommand(commandId, params) {
      session.invokeCommand(commandId, params)
    },
    openModalScope(decl) {
      session.openModal({
        scopeId: decl.scopeId,
        ...(decl.blocksBackground === undefined ? {} : { blocksBackground: decl.blocksBackground }),
        ...(decl.confirmOnEnter === undefined ? {} : { confirmOnEnter: decl.confirmOnEnter }),
        ...(decl.textControlIds === undefined ? {} : { textControlIds: decl.textControlIds }),
        ...(decl.focusId === undefined ? {} : { focusId: decl.focusId }),
      })
      if (decl.onEscape) escapeHandlers.set(decl.scopeId, decl.onEscape)
      if (decl.root !== undefined) modalRoots.set(decl.scopeId, decl.root)
      return () => {
        escapeHandlers.delete(decl.scopeId)
        modalRoots.delete(decl.scopeId)
        session.closeModal(decl.scopeId)
      }
    },
    closeModalScope(scopeId) {
      const handler = escapeHandlers.get(scopeId)
      if (!handler) return false
      handler()
      return true
    },
    get modalScopeId() {
      return session.routing.modal.scopeId
    },
    modalRootElementOf(scopeId) {
      if (scopeId === null) return null
      const root = modalRoots.get(scopeId)
      if (root === undefined) return null
      return typeof root === 'function' ? root() : root
    },
    setInteraction(interaction) {
      session.setInteraction(interaction)
    },
    setActiveRegion(regionId) {
      session.setActiveRegion(regionId)
    },
    setHotkeys(area, app) {
      session.setHotkeys(area, app)
    },
    bindControl(binding) {
      session.bindControl(binding)
    },
    unbindControl(controlId) {
      session.unbindControl(controlId)
    },
    bindInteraction(binding) {
      session.bindInteraction(binding)
    },
    registerTextControl(input, token) {
      return session.registerTextControl(input, token)
    },
    applyTextInput(controlId, text, token) {
      return session.applyTextInput(controlId, text, token)
    },
    blurTextControl(controlId, reason, token) {
      return session.blurTextControl(controlId, reason, token)
    },
    textProjection(controlId) {
      return session.textProjection(controlId)
    },
    get counters() {
      return session.counters
    },
    get trace() {
      return session.trace
    },
  }
}
