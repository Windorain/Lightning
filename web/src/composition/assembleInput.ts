/**
 * `composition/assembleInput` —— **输入面的装配根**：把 P1 执行器、P7 输入会话与浏览器适配器
 * 拼成可用的整体（#249 §4 规则 5「`composition/modules` 是装配根，可以引用实现并注册」；
 * §10；P7 = #258）。
 *
 * ## 为什么装配要单独一个模块
 *
 * `WorkbenchRoot.vue` 已经承担了 UI 编排。把"建会话、注入能力、挂事件绑定、
 * 暴露 e2e 探针"塞进组件的 `onMounted` 会让三件事混在一起，且**无法被单测覆盖**
 * （组件挂载需要完整 DOM 与 Three）。
 *
 * 本模块是**纯装配**：不做政策判断、不持有业务状态、可被单测直接调用
 * （见 `src/composition/__tests__/assembleInput.test.ts` 的挂卸平衡与
 * 单一挂载点断言）。
 *
 * ## 与 P1 的接线
 *
 * 输入产出的是 `CommandIntent`（P7 的 ID 空间：`edit.undo`、`tool.beginInteraction`…）。
 * `resolveIntent`（`application/inputCommands`）把它映射成 P1 的 `Command`；
 * 命令经 `sink.submit` / `sink.executeNow` 进入**唯一写通路** `reduceCommand`。
 *
 * `sink` 由装配方提供：产品侧当前是"具名命令 ID → 既有 operator"的转发表
 * （P10 收口点，见 `workbench/inputHotkeys.ts` 的 `workbenchCommandSink`），
 * 测试侧是 `editorCommandSink(editor)`（真正的 P1 执行器）。
 */

import { createInputSession, type InputEventResult, type InputSession } from '@/runtime/inputSession'
import { createInputPort, type InputPortHandle } from '@/runtime/inputPort'
import { createInputBinding, type HitTest, type InputBinding } from '@/adapters/inputBinding'
import type { HotkeyBinding } from '@/domain/input'
import type { TextDraftEffect } from '@/domain/textDraft'
import type { CommandSink, ControlBinding, InteractionBinding } from '@/application/inputCommands'

export interface AssembleInputOptions {
  /**
   * 命令接收端口（P1 `EditorClient` 的最小子集）。
   *
   * ## 为什么是端口而不是直接要一个 `Editor`
   *
   * 工作台当前的**真实文档**仍是旧 `RuntimeDocument`（P1 已知缺口：72 个生产文件读它，
   * 归口 P10 集成把真实文档换成 P1 的类型化文档）。因此今天产品侧交给输入面的
   * `sink` 是"把具名命令 ID 转发到既有 operator 入口"的实现，
   * 而**测试**交给它的是真正的 P1 `Editor`（`editorCommandSink`）。
   *
   * 这条分界是**显式且逐条列明**的（见 `workbench/inputHotkeys.ts`），
   * 不是"新门面包旧核心"：命令 ID 空间、幂等账本、可用性查询、路由优先级
   * 全部是 P7 的新实现，只有"最终落到哪个执行器"这一个点由装配层选择。
   * P10 把该点换成 `editorCommandSink(editor)` 即完成收口。
   */
  readonly sink: CommandSink
  /** 能力集合（profile 裁剪；由装配层决定）。 */
  readonly capabilities: readonly string[]
  /** "坐标 → Area"的判定（Area 布局知识由 P6 的装配提供）。 */
  readonly hitTest: HitTest
  /** Area 快捷键表（配置；#258「快捷键具体映射表属配置」）。 */
  readonly areaHotkeys?: readonly HotkeyBinding[]
  /** 应用快捷键表（**显式列明**，不拦截所有键）。 */
  readonly appHotkeys?: readonly HotkeyBinding[]
  readonly controls?: readonly ControlBinding[]
  /**
   * 装配**之前**已挂载的控件声明（晚绑定汇合）。
   *
   * Vue 子是先于父 `onMounted` 挂载的，故属性面板里的控件会先于本装配运行
   * （P7 首跑 e2e 实测：控件因此从未登记，提交报 `unboundControl`）。
   * 装配层把它们从 `WM.pendingControlBindings` 传进来排空。
   */
  readonly pendingControls?: readonly ControlBinding[]
  readonly interactions?: readonly InteractionBinding[]
  /** 挂载点（缺省 `document`）。 */
  readonly keyTarget?: Document | HTMLElement
  readonly pointerTarget?: Document | HTMLElement
  /** 该绑定的所有者名（用于单一挂载点断言与诊断）。 */
  readonly owner: string
  /**
   * 局部动作（`local.*` 与 `modal.close` 一类**不写文档**的动作）。
   *
   * 由装配层逐条提供 —— 不得用"兜底 switch"实现（那正是旧 `keymapHandler` 的形态）。
   * 未登记的 `local.*` 会进 `unhandledLocalActions` 诊断，**不静默**。
   */
  readonly localActions?: Readonly<Record<string, () => void>>
  /** 页面恢复回调。 */
  readonly onResume?: (input: { resumeBaseline: number; droppedTicks: number }) => void
  /**
   * 每条事件处理后的观测回调（诊断探针 + 呈现层镜像刷新）。
   *
   * **只读**语义：回调不得改写路由状态（改写必须经 `InputPort` 的方法）。
   * `RNAWidget` 用它把草稿投影刷进呈现镜像 —— 那是"读会话、写展示"，
   * 不是第二条状态权威（见该组件 `syncDraftMirror` 的说明）。
   */
  readonly onEvent?: (result: InputEventResult) => void
  /**
   * 文本状态推进的通知（与 `onEvent` 互补）。
   *
   * 文本路径返回 `TextDraftEffect[]` 而非 `InputEventResult`；若不单独报，
   * 输入过程中的草稿与"非法草稿"提示就不会刷新（P7 首跑 e2e 实测到的缺陷）。
   */
  readonly onTextEffects?: (controlId: string, effects: readonly TextDraftEffect[]) => void
}

export interface AssembledInput {
  readonly session: InputSession
  /** 端口句柄：呈现层用 `InputPort` 面，装配层另有 `publish()`。 */
  readonly port: InputPortHandle
  readonly binding: InputBinding
  dispose(): void
}

/**
 * 装配输入面。
 *
 * `claim` 默认 `true`：装配即声明"我是唯一的 document keydown 持有者"。
 * 第二个装配（例如误在嵌入预览里再建一次）会**抛错**而不是与第一个静默打架 ——
 * 这是 A22「两个 handler 各启动操作」在装配层的结构防御。
 */
export function assembleInput(options: AssembleInputOptions, claim = true): AssembledInput {
  const session = createInputSession({
    sink: options.sink,
    capabilities: () => options.capabilities,
    ...(options.areaHotkeys === undefined ? {} : { areaHotkeys: options.areaHotkeys }),
    ...(options.appHotkeys === undefined ? {} : { appHotkeys: options.appHotkeys }),
  })
  for (const c of options.controls ?? []) session.bindControl(c)
  for (const i of options.interactions ?? []) session.bindInteraction(i)

  const port = createInputPort(session)
  session.setCapabilities(() => options.capabilities)

  // **晚绑定汇合**：控件可能早于本装配挂载（Vue 子先父后），
  // 它们把声明暂存在 `pendingControlBindings`，此处排空。
  for (const c of options.pendingControls ?? []) session.bindControl(c)

  // 局部动作：逐条登记；未登记的 `local.*` 进 `unhandledLocalActions`（不静默失败）。
  session.setLocalActionHandler((commandId, params) => {
    const action = options.localActions?.[commandId]
    if (action) {
      action()
      return true
    }
    const modalScopeId = typeof params.scopeId === 'string' ? params.scopeId : null
    if (commandId === 'modal.close' && modalScopeId !== null) return port.closeModalScope(modalScopeId)
    return false
  })

  // 每条事件后广播"会话推进了" ⇒ 订阅的组件（属性控件）重读投影。
  //
  // 为什么收敛到这一处：投影是**只读**的，但"何时可信"必须唯一。
  // 若让各组件自己猜（或各自在 DOM 事件里更新本地副本），就会长出第二份草稿权威
  // （#249 §19.1 禁止）。这里把"事件已处理完 ⇒ 现在可读"变成装配层的单点事实。
  const notify = (): void => port.publish()
  const binding = createInputBinding({
    session,
    hitTest: options.hitTest,
    ...(options.keyTarget === undefined ? {} : { keyTarget: options.keyTarget }),
    ...(options.pointerTarget === undefined ? {} : { pointerTarget: options.pointerTarget }),
    ...(options.onResume === undefined ? {} : { onResume: options.onResume }),
    onEvent: (result) => {
      options.onEvent?.(result)
      notify()
    },
    onTextEffects: (controlId, effects) => {
      options.onTextEffects?.(controlId, effects)
      notify()
    },
  })
  if (claim) binding.claimExclusive(options.owner)

  return {
    session,
    port,
    binding,
    dispose() {
      binding.dispose()
    },
  }
}
