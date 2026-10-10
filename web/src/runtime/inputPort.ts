/**
 * `runtime/inputPort` —— **输入端口**：呈现层声明焦点/弹窗/绑定等**显式状态**的入口
 * （#249 §4 规则 3「`runtime` … 提供执行能力」；§19.1；P7 = #258）。
 *
 * ## 为什么需要一层端口
 *
 * 组件（`editors/`/`shells/`）不该直接持有 `InputSession`：
 * 那会让"谁在改路由状态"散落在各组件里，回到 #249 §15 第 1 条要退役的形态
 * （万能 `Context` 裸字段 + 各处直写）。端口把可用的**动作**收敛成一组具名方法，
 * 且这些动作**只写显式状态**，不产生领域命令 —— 领域命令一律由 DOM 事实驱动
 * （`adapters/inputBinding`）。
 *
 * | 端口方法 | 谁调用 | 效果 |
 * |---|---|---|
 * | `openModalScope` | 弹窗组件 | 登记作用域（含自己的文本控件 id 与 Escape 回调） |
 * | `setInteraction` | 交互发起方（工具/视口） | 声明"当前有活动交互" |
 * | `setActiveRegion` | Area 装配（P6） | 声明"最后命中的 Area" |
 * | `bindControl` / `unbindControl` | 属性控件（呈现层） | 声明控件 → 领域属性的绑定 |
 * | `textProjection` | 呈现层 | 读三态投影（只读） |
 * | `counters` / `trace` | 诊断（§19.9） | 只读观测面 |
 *
 * ## 与 `EditorClient` 的关系
 *
 * 端口**不**暴露 `submit`/`executeNow`：那会造出第二条写通路（契约 §5.2 明文禁止）。
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
  /** Escape 时的动作（关闭弹窗一类）。**不是**领域命令。 */
  readonly onEscape?: () => void
}

export interface InputPort {
  openModalScope(decl: ModalScopeDeclaration): () => void
  /** 关闭指定作用域（若它就是当前作用域）。Escape 路由的落点。 */
  closeModalScope(scopeId: string): boolean
  readonly modalScopeId: string | null
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
  readonly counters: InputCounters
  readonly trace: readonly InputTraceEntry[]
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
export function createInputPort(session: InputSession): InputPort {
  const escapeHandlers = new Map<string, () => void>()

  return {
    openModalScope(decl) {
      session.openModal({
        scopeId: decl.scopeId,
        ...(decl.blocksBackground === undefined ? {} : { blocksBackground: decl.blocksBackground }),
        ...(decl.confirmOnEnter === undefined ? {} : { confirmOnEnter: decl.confirmOnEnter }),
        ...(decl.textControlIds === undefined ? {} : { textControlIds: decl.textControlIds }),
        ...(decl.focusId === undefined ? {} : { focusId: decl.focusId }),
      })
      if (decl.onEscape) escapeHandlers.set(decl.scopeId, decl.onEscape)
      return () => {
        escapeHandlers.delete(decl.scopeId)
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
