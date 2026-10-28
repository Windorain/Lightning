/**
 *
 * `composition/assembleInput` —— **输入面的装配根**：把命令执行器、输入会话与浏览器适配器
 * 拼成可用的整体（`composition/modules` 是装配根，可以引用实现并注册）。
 *
 * ## 为什么装配要单独一个模块
 *
 * `WorkbenchRoot.vue` 已经承担了 UI 编排。把"建会话、注入能力、挂事件绑定、
 * 暴露 e2e 观测"塞进组件的 `onMounted` 会让三件事混在一起，且**无法被单测覆盖**
 * （组件挂载需要完整 DOM 与 Three）。
 *
 * 本模块是**纯装配**：不做政策判断、不持有业务状态、可被单测直接调用
 * （见 `src/composition/__tests__/assembleInput.test.ts` 的挂卸平衡与
 * 单一挂载点断言）。
 *
 * ## 与命令执行器的接线
 *
 * 输入产出的是 `CommandIntent`（输入层的 ID 空间：`edit.undo`、`tool.beginInteraction`…）。
 * `resolveIntent`（`application/inputCommands`）把它映射成领域 `Command`；
 * 命令经 `sink.submit` / `sink.executeNow` 进入**唯一写通路** `reduceCommand`。
 *
 * `sink` 由装配方提供。产品侧与测试侧现在走**同一个**内核执行器家族：
 * 产品侧 `workbench/inputHotkeys` 的 `workbenchCommandSink`（把领域命令交给
 * `Context#submitContentEditSettlement`/`submitKernelUndoRedo` —— 内核提交**并投影**），
 * 测试与其它 `EditorClient` 外壳是 `editorCommandSink(editor)`。
 * 旧的"具名命令 ID → 既有 operator"转发表已删除。
 */

import { createInputSession, type InputEventResult, type InputSession } from '@/runtime/inputSession'
import { createInputPort, type InputPortHandle } from '@/runtime/inputPort'
import { createInputBinding, type HitTest, type InputBinding } from '@/adapters/inputBinding'
import type { HotkeyBinding } from '@/domain/input'
import type { TextDraftEffect } from '@/domain/textDraft'
import type { CommandSink, ControlBinding, InteractionBinding } from '@/application/inputCommands'

export interface AssembleInputOptions {
  /**
   * 命令接收端口（`EditorClient` 的最小子集）。
   *
   * ## 为什么是端口而不是直接要一个 `Editor`
   *
   * 端口是 `application` 层的契约（本层不认识 `runtime` 的实现类型）。产品侧实现
   * 是 `workbench/inputHotkeys#workbenchCommandSink` —— 它把领域命令交给
   * `Context` 的**已结算**入口（内核 submit → drain → 结算 → `syncLegacyFromKernel`
   * 投影）；`EditorClient` 外壳（测试、嵌入）用
   * `runtime/inputSession#editorCommandSink`。
   *
   * 这条分界是**显式且逐条列明**的（见 `workbench/inputHotkeys.ts` 的
   * `KERNEL_SETTLEMENT_KINDS`），不是"新门面包旧核心"：命令 ID 空间、幂等账本、
   * 可用性查询、路由优先级全部是输入层的新实现，只有"最终落到哪个执行器"这一个点
   * 由装配层选择。该点已从旧 operator 转发换成内核提交路径，调用方（本函数）不变。
   */
  readonly sink: CommandSink
  /** 能力集合（profile 裁剪；由装配层决定）。 */
  readonly capabilities: readonly string[]
  /** "坐标 → Area"的判定（Area 布局知识由装配提供）。 */
  readonly hitTest: HitTest
  /** Area 快捷键表（配置；具体映射表属配置）。 */
  readonly areaHotkeys?: readonly HotkeyBinding[]
  /** 应用快捷键表（**显式列明**，不拦截所有键）。 */
  readonly appHotkeys?: readonly HotkeyBinding[]
  readonly controls?: readonly ControlBinding[]
  /**
   * 装配**之前**已挂载的控件声明（晚绑定汇合）。
   *
   * Vue 子是先于父 `onMounted` 挂载的，故属性面板里的控件会先于本装配运行
   * （e2e 实测：控件因此从未登记，提交报 `unboundControl`）。
   * 装配层把它们从 `WM.pendingControlBindings` 传进来排空。
   */
  readonly pendingControls?: readonly ControlBinding[]
  readonly interactions?: readonly InteractionBinding[]
  /** 挂载点（缺省 `document`）。 */
  readonly keyTarget?: Document | HTMLElement
  readonly pointerTarget?: Document | HTMLElement
  /**
   * **键盘事件归属根**：事件 target 不属于这些根（也不是当前模态根）时，
   * 输入绑定在进入会话前直接忽略 —— 宿主页面自己的输入框/正文不归工作台。
   *
   * 缺省 `undefined` ⇒ 不设边界（普通工作台/嵌入与改动前逐字一致）。
   * 仅 Wiki 宿主外壳传入（见 `WorkbenchRoot`）。
   */
  readonly keyScopeRoots?: () => readonly (Element | null)[]
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
   * 每条事件处理后的观测回调（诊断观测 + 呈现层镜像刷新）。
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
   * 输入过程中的草稿与"非法草稿"提示就不会刷新（e2e 实测到的缺陷）。
   */
  readonly onTextEffects?: (controlId: string, effects: readonly TextDraftEffect[]) => void
  /**
   * **当前编辑上下文 id**。
   *
   * 为什么由装配层传而不是让绑定自己写 params：见
   * `runtime/inputSession` 的 `withActiveContext` 说明 —— 上下文是**运行期事实**
   * （换文档就变），而绑定的 params 是**配置**。写进配置会让"Ctrl+Z 绑到哪个
   * 上下文"冻结在装配时刻。
   *
   * 缺省 `null`：需要 `contextId` 的命令会被**显式拒绝**（`missingParam`），
   * 不静默 —— 实测这曾导致 `edit.undo` 在工作台里从未真正生效。
   */
  readonly contextId?: string | null
  /**
   * **平台动作失败**的上报口：装配层把它接到诊断面。
   *
   * 适配器（`adapters/inputBinding`）不 import 诊断层，故这条回调由本层注入 ——
   * 与 `onEvent`/`onTextEffects` 同一形态（装配边是唯一允许跨层接线的地方）。
   */
  readonly onPlatformFailure?: (failures: readonly { readonly action: string; readonly error: string }[]) => void
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
 * 这是「两个 handler 各启动一次操作」在装配层的结构防御。
 */
export function assembleInput(options: AssembleInputOptions, claim = true): AssembledInput {
  const session = createInputSession({
    sink: options.sink,
    capabilities: () => options.capabilities,
    ...(options.areaHotkeys === undefined ? {} : { areaHotkeys: options.areaHotkeys }),
    ...(options.appHotkeys === undefined ? {} : { appHotkeys: options.appHotkeys }),
    ...(options.contextId == null ? {} : { contextId: options.contextId }),
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
  // 若让各组件自己猜（或各自在 DOM 事件里更新本地副本），就会长出第二份草稿权威。
  // 这里把"事件已处理完 ⇒ 现在可读"变成装配层的单点事实。
  const notify = (): void => port.publish()
  const binding = createInputBinding({
    session,
    hitTest: options.hitTest,
    // 模态"内部 vs 背景"的判定依据：根元素由弹窗在 openModalScope 时登记。
    modalRootOf: (scopeId) => port.modalRootElementOf(scopeId),
    ...(options.keyTarget === undefined ? {} : { keyTarget: options.keyTarget }),
    ...(options.pointerTarget === undefined ? {} : { pointerTarget: options.pointerTarget }),
    ...(options.keyScopeRoots === undefined ? {} : { keyScopeRoots: options.keyScopeRoots }),
    ...(options.onResume === undefined ? {} : { onResume: options.onResume }),
    onEvent: (result) => {
      options.onEvent?.(result)
      notify()
    },
    onTextEffects: (controlId, effects) => {
      options.onTextEffects?.(controlId, effects)
      notify()
    },
    ...(options.onPlatformFailure === undefined ? {} : { onPlatformFailure: options.onPlatformFailure }),
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
