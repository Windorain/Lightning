/**
 * `runtime/inputSession` —— **输入会话**：持有路由状态、文本草稿状态与分发账本，
 * 按**事实**推进，产出命令与平台动作请求
 * （分层规则：`runtime` 调用纯函数、提供执行能力）。
 *
 * ## 为什么与 `adapters/inputBinding` 分开
 *
 * 两件事必须分离，否则会直接违反分层判据：
 *
 * | 模块 | 层 | 能碰什么 | 不能碰什么 |
 * |---|---|---|---|
 * | **本模块** | `runtime`（`corePurity`） | 纯值、执行器端口 | DOM、Vue、Three |
 * | `adapters/inputBinding` | `adapters` | DOM 事件、`setPointerCapture` | 领域决定 |
 *
 * `runtime` 在边界规则里登记为**纯核心**（`boundary-rules.mjs` 的
 * `LAYER_DESTINATIONS.runtime.corePurity === true`），`gate/core-no-dom-globals`
 * 会拒绝其中任何 `document`/`window` 引用。故本模块**只**接受
 * `KeyFact` / `PointerFact`（值），不接受 `KeyboardEvent` / `PointerEvent` ——
 * 事件到事实的翻译在适配器，事实到命令的判定在这里。
 *
 * 这不是"为了过闸门而挪文件"：分层规则明文要求
 * 「浏览器适配器只进行**事实提取**与**平台同步动作**…平台动作根据**纯路由策略提供的
 * 结果**执行」。若让同一个模块既读 DOM 又决定接收者，那条边界就不存在了。
 *
 * ## 一次事件的三段产出
 *
 * 每次 `handleKey` / `handlePointer` 返回：
 *  1. `decision` —— 路由结论（谁收、有没有意图、要不要阻止默认行为）；
 *  2. `platformAction` —— **要做**的平台动作（`preventDefault` / 捕获 / 释放）；
 *     本模块**不执行**它，只描述它；
 *  3. `outcomes` —— 已分发给执行器的命令结果（含 `duplicate`/`rejected`）。
 */

import {
  applyVisibilityChange,
  bindPointerCapture,
  createInputRoutingState,
  modalOpened,
  popModalScope,
  pushModalScope,
  NO_TEXT_FOCUS,
  releasePointerCapture,
  routeKeyboardKey,
  routePointer,
  withActiveRegion,
  withHotkeys,
  withInteraction,
  withTextFocus,
  type CommandIntent,
  type HotkeyBinding,
  type InputRoutingState,
  type KeyFact,
  type ModalScopeState,
  type ParamValue,
  type PointerFact,
  type PointerRoutingDecision,
  type RoutingDecision,
} from '@/domain/input'
import {
  applyCompositionEnd,
  applyCompositionStart,
  applyCompositionUpdate,
  applyDraftInput,
  applyDraftKey,
  blurControl,
  createTextLayerState,
  draftProjection,
  focusControl,
  type DraftKey,
  type DraftRetainReason,
  type RegisterControlInput,
  type TextDraftEffect,
  type TextLayerState,
} from '@/domain/textDraft'
import type { EditorClient } from './execution'
import type { DomainError } from '@/domain/errors'
import {
  createInputCommandBindings,
  dispatchIntent,
  EMPTY_DISPATCH_LEDGER,
  isLocalCommandId,
  type CommandSink,
  type ControlBinding,
  type DispatchLedger,
  type DispatchOutcome,
  type InputCommandBindings,
  type InteractionBinding,
} from '@/application/inputCommands'

// ─────────────────────────────────────────────────────────────────────────────
// 观测面（证据）
// ─────────────────────────────────────────────────────────────────────────────

/** 单条事件的观测记录（**证据**；e2e 探针与诊断读它）。 */
export interface InputTraceEntry {
  readonly token: number
  readonly source: 'key' | 'pointer' | 'composition' | 'focus' | 'visibility' | 'command'
  /**
   * 键事件的细分（**必须**有，否则证据无法区分 keydown / keyup）。
   *
   * 首次端到端运行实测的教训：trace 只记 `source: 'key'` 时，"最后一次键事件"取到的是
   * **keyup**（层级恒为 `none`、无意图），于是"焦点在文本控件 ⇒ 层级是 text"这类
   * 断言会拿到 `none` 而误判为缺陷。把 `keydown`/`keyup` 显式分开，
   * 证据才可机械对账。
   */
  readonly kind: 'keydown' | 'keyup' | 'pointer' | 'composition' | 'focus' | 'visibility' | 'command'
  readonly level: string | null
  readonly receiver: string | null
  readonly commandId: string | null
  readonly reason: string
  readonly startedModal: boolean
  /**
   * 该事件的意图**是否真的交给了分发**（`dispatch`）。仅键事件写入。
   *
   * ## 为什么必须有这一位（运行期实测的假绿）
   *
   * `commandId` 记的是**路由产出**的意图，而不是"意图被发出去"。修复前，
   * `handleKey` 只在 `startsModal` 时才 `dispatch`，于是 `edit.undo`（应用快捷键，
   * `startsModal: false`）的轨迹长这样：
   *
   * ```
   * { level: 'app', commandId: 'edit.undo', reason: 'app-hotkey' }   ← 意图产出了
   * （没有 source: 'command' 的记录）                                  ← 但它从未被分发
   * ```
   *
   * 只看 `commandId` 的判断会得出"撤销已触发"的结论 —— 这正是本缺陷长期潜伏的原因
   * （相关断言只能观察到 `tool.beginInteraction` 不出现，而它**从不**可能出现）。
   * 故把"产出意图"与"交出意图"显式分开记录。
   */
  readonly dispatched?: boolean
}

/** 可观测计数（测试据它断言"只启动一次"）。 */
export interface InputCounters {
  /** 已处理的 **keydown** 数（`keyup` 另计 —— 否则"一次按键"会被算成两次）。 */
  readonly keyEvents: number
  /** 已处理的 keyup 数（只作诊断；不产生命令意图）。 */
  readonly keyUpEvents: number
  /** 因 token 已消费 / 模态启动已消费而被**抑制**的事件数。 */
  readonly suppressedDuplicates: number
  /** 已启动的模态操作数（每个事件至多 +1）。 */
  readonly modalStarts: number
  /** 指针捕获登记数 / 解除数（须平衡）。 */
  readonly capturesAcquired: number
  readonly capturesReleased: number
  /**
   * 捕获丢失事件数（**只**数真正持有过的 pointer；未持有的另计）。
   *
   * 单独计数是为了让"捕获丢失按政策取消"有可判别据：
   * 若把每个 pointer 事件都算成释放，`capturesReleased` 会虚高、
   * 判据失去意义（首个运行期实测到的缺陷，见文件头）。
   */
  readonly captureLostOwned: number
  readonly captureLostNotOwned: number
  /** IME 组合期间被拦下的可打印键数（负对照的反面证据）。 */
  readonly imeSuppressedShortcuts: number
}

/** 平台同步动作请求（由适配器执行；本模块不碰 DOM）。 */
export interface PlatformActionRequest {
  readonly preventDefault: boolean
  readonly stopPropagation: boolean
  /** `-1` 表示不涉及指针。 */
  readonly pointerId: number
  readonly captureAction: 'none' | 'capture' | 'release'
  /** 捕获宿主由适配器解析（Area → DOM 元素的知识不在本层）。 */
  readonly captureRegionId: string | null
}

/** 局部动作处理器（**平台动作**，不产生领域命令）。 */
export type LocalActionHandler = (commandId: string, params: Readonly<Record<string, ParamValue>>) => boolean

/** 一次事件处理的完整产出。 */
export interface InputEventResult {
  readonly token: number
  readonly decision: RoutingDecision | PointerRoutingDecision
  readonly platformAction: PlatformActionRequest
  readonly outcomes: readonly DispatchOutcome[]
  /** 被登记/解除捕获的 pointer（供适配器确认平台动作与状态一致）。 */
  readonly captureRegistered: boolean
  readonly captureReleased: boolean
}

export interface InputSessionOptions {
  readonly sink: CommandSink
  /** 能力集合来源（装配层注入；未注入 ⇒ 空集合 = 最保守）。 */
  readonly capabilities?: () => readonly string[]
  readonly areaHotkeys?: readonly HotkeyBinding[]
  readonly appHotkeys?: readonly HotkeyBinding[]
  readonly traceLimit?: number
  /**
   * **当前编辑上下文 id**（装配层注入）。
   *
   * 缺省 `null` = 不注入 ⇒ 需要 `contextId` 的命令（`edit.undo`/`edit.redo`/
   * `tool.beginInteraction`…）会以 `missingParam` 被**显式拒绝**（不是静默失败）。
   * 装配层应在会话建立时给出（见 `InputSession.setActiveContext`）。
   */
  readonly contextId?: string
}

export interface InputSession {
  handleKey(fact: KeyFact): InputEventResult
  handlePointer(fact: PointerFact): InputEventResult
  setInteraction(interaction: { contextId: string; regionId: string; tool: string } | null): void
  setActiveRegion(regionId: string | null): void
  setHotkeys(area: readonly HotkeyBinding[], app: readonly HotkeyBinding[]): void
  setCapabilities(source: () => readonly string[]): void
  /**
   * 设置**当前编辑上下文 id**（换文档/换工作区时由装配层调用）。
   *
   * 它只影响"需要 `contextId` 的命令能否解析"这一件事 —— 不写任何领域状态。
   */
  setActiveContext(contextId: string | null): void
  /**
   * 按命令 ID 分发一次（菜单/工具栏等**显式 UI 入口**；与键盘事件同一条路径）。
   *
   * 见实现处的说明：它不是第二条写通路 —— 它复用同一个 `dispatch`。
   */
  invokeCommand(commandId: string, params?: Readonly<Record<string, ParamValue>>): DispatchOutcome | null
  openModal(scope: { scopeId: string; blocksBackground?: boolean; confirmOnEnter?: boolean; textControlIds?: readonly string[]; focusId?: string | null }): void
  closeModal(scopeId: string): void
  bindControl(binding: ControlBinding): void
  unbindControl(controlId: string): void
  bindInteraction(binding: InteractionBinding): void
  /** 文本控件会话（由适配器的 focusin/focusout/composition/input 事件驱动）。 */
  registerTextControl(input: RegisterControlInput, token: number): readonly TextDraftEffect[]
  applyTextInput(controlId: string, text: string, token: number): readonly TextDraftEffect[]
  compositionStart(controlId: string, token: number): void
  compositionUpdate(controlId: string, text: string, token: number): void
  compositionEnd(controlId: string, text: string, token: number): void
  blurTextControl(controlId: string, reason: DraftRetainReason, token: number): readonly TextDraftEffect[]
  /** 焦点移到非文本处：结算当前文本控件（提交或保留），并清除显式焦点状态。 */
  blurCurrentTextFocus(reason: DraftRetainReason, token: number): readonly TextDraftEffect[]
  /** 页面可见性（适配器提供事实与时钟）。 */
  applyVisibility(input: { hidden: boolean; now: number; lastTickAt: number; tickInterval: number }): { readonly resumeBaseline: number | null; readonly droppedTicks: number }
  textProjection(controlId: string): ReturnType<typeof draftProjection> | null
  /** 分配事件 token（适配器每条 DOM 事件取一个）。 */
  nextToken(): number
  /**
   * 局部动作处理器（**平台动作**，不产生领域命令）。
   *
   * 覆盖面：`modal.close`（Escape 关闭弹窗）一类"只影响呈现/焦点"的动作。
   * 处理器返回 `true` 表示已处理；返回 `false` 表示本层不认（记入诊断，不静默）。
   *
   * 为什么不是组件各自挂 window 监听：那正是 `wikiInputShield.bindWikiModalEscape`
   * 的形态（第三条 capture keydown）。集中在这里后，「Enter/Escape
   * 不重复消费"由**同一个** token 去重表保证。
   */
  setLocalActionHandler(handler: LocalActionHandler): void
  /** 未被任何局部处理器认领的动作（诊断：防止"命令发出去没人接"的静默失败）。 */
  readonly unhandledLocalActions: readonly string[]
  /** 已登记的控件 id（诊断：`unboundControl` 的对照面）。 */
  readonly boundControlIds: readonly string[]
  readonly trace: readonly InputTraceEntry[]
  readonly counters: InputCounters
  readonly routing: InputRoutingState
  readonly text: TextLayerState
  readonly ledger: DispatchLedger
}

// ─────────────────────────────────────────────────────────────────────────────
// 实现
// ─────────────────────────────────────────────────────────────────────────────

export function createInputSession(options: InputSessionOptions): InputSession {
  const { sink } = options
  const traceLimit = options.traceLimit ?? 256

  let routing: InputRoutingState = createInputRoutingState({
    areaHotkeys: options.areaHotkeys ?? [],
    appHotkeys: options.appHotkeys ?? [],
  })
  let text: TextLayerState = createTextLayerState()
  let bindings: InputCommandBindings = createInputCommandBindings()
  let ledger: DispatchLedger = EMPTY_DISPATCH_LEDGER
  let nextTok = 1
  let capabilitySource: () => readonly string[] = options.capabilities ?? (() => Object.freeze([] as string[]))

  const trace: InputTraceEntry[] = []
  const counters = {
    keyEvents: 0,
    keyUpEvents: 0,
    suppressedDuplicates: 0,
    modalStarts: 0,
    capturesAcquired: 0,
    capturesReleased: 0,
    captureLostOwned: 0,
    captureLostNotOwned: 0,
    imeSuppressedShortcuts: 0,
  }

  function record(entry: InputTraceEntry): void {
    trace.push(entry)
    if (trace.length > traceLimit) trace.splice(0, trace.length - traceLimit)
  }

  function nextToken(): number {
    return nextTok++
  }

  /**
   * **当前编辑上下文 id**（补齐接线缺口）。
   *
   * ## 为什么需要它（一处真实的功能缺口，不是便利）
   *
   * `resolveIntent` 对 `edit.undo`/`edit.redo` 要求 `params.contextId`；而
   * `WORKBENCH_APP_HOTKEYS` 的两条绑定**没有** params，快捷键路由
   * （`domain/input` 第 5 级）也不注入它。实测：
   *
   * ```
   * resolveIntent({ commandId: 'edit.undo', params: {} }, …)
   *   → InvalidValue{ reason: 'missingParam', param: 'contextId' }
   * ```
   *
   * 也就是说 **Ctrl+Z 撤销在工作台里从未真正生效**（它被解析层拒绝，
   * 表现为"按了没反应"）。此前的注释把这件事记为"接入多文档后改为按活动
   * 上下文解析"——此处正是那个接入点，故在此补齐。
   *
   * ## 为什么由**会话**注入而不是让每个绑定自己写 params
   *
   * 绑定的 params 是**配置**（键位表），而"当前上下文是哪个"是**运行期事实**
   * （换文档/换工作区就变）。写进配置表会让"Ctrl+Z 绑到哪个上下文"冻结在
   * 装配时刻 —— 那正是「可用性与业务执行分离」要避免的形态
   * （配置里出现运行期状态）。
   *
   * 注入**只补缺**：绑定自己写了 `contextId` 时以它为准（那是显式意图）。
   */
  let activeContextId: string | null = options.contextId ?? null

  function withActiveContext(intent: CommandIntent): CommandIntent {
    if (activeContextId === null) return intent
    if (intent.params.contextId !== undefined) return intent
    return { commandId: intent.commandId, params: { ...intent.params, contextId: activeContextId } }
  }

  /**
   * 按**命令 ID** 分发一次（供菜单/工具栏一类的**显式 UI 入口**）。
   *
   * ## 为什么需要它，以及它为什么不是第二条写通路
   *
   * 菜单项与快捷键必须是**同一个命令**（明文：旧实现里
   * 快捷键用 `'undo'`、菜单用 `'OPERATOR_UNDO'`，同一个命令三个名字，
   * 无法做命令搜索、也无法审计"谁还能触发撤销"）。
   *
   * 本方法走的是**与键盘事件完全相同**的那条路径：同一个 `dispatch` →
   * 同一个 `resolveIntent` → 同一个 `dispatchIntent` → 同一个 `CommandSink`。
   * 它唯一多做的事是分配一个 token（UI 点击没有 DOM 事件 token）。
   * 于是"菜单与快捷键结论一致"不是靠两处各写一遍，而是因为**只有一条路**。
   *
   * 可用性也走同一条查询（`dispatchIntent` 内部经
   * `evaluateCommandAvailability`）⇒ 菜单不会显示一个点了没反应的项。
   */
  function invokeCommand(commandId: string, params: Readonly<Record<string, ParamValue>> = {}): DispatchOutcome | null {
    const token = nextToken()
    return dispatch({ commandId, params }, token)
  }

  function dispatch(intent: CommandIntent | null, eventToken: number): DispatchOutcome | null {
    if (intent === null) return null
    // 补注入当前上下文（只补缺；见 `withActiveContext` 的说明）。
    // **唯一**注入点：键盘、指针、菜单命令三条入口都经本函数 ⇒
    // "哪些命令拿到 contextId"不可能因入口不同而不同。
    const filled = withActiveContext(intent)
    // `local.*` 是**旧 operator / UI 切换**的转发项，不经 `application/inputCommands`
    // 的领域映射（它们不写文档）。直接交给局部动作处理器；无人认领即记录（不静默）。
    if (isLocalCommandId(filled.commandId)) {
      const handled = localActionHandler !== null && localActionHandler(filled.commandId, filled.params)
      if (!handled) noteUnhandled(filled.commandId, eventToken)
      recordDispatchTrace(filled.commandId, 'local', eventToken, null)
      return Object.freeze({ status: 'local', commandId: filled.commandId, params: filled.params, ledger })
    }
    const outcome = dispatchIntent(sink, ledger, eventToken, filled, bindings, { capabilities: capabilitySource() })
    ledger = outcome.ledger
    // 局部动作（`local`）**不产生领域命令**，但要交给平台动作处理器执行
    // （例如 Escape → 关闭弹窗）。未认领的动作记入诊断而不是静默丢弃。
    if (outcome.status === 'local') {
      const handled = localActionHandler !== null && localActionHandler(outcome.commandId, outcome.params)
      if (!handled) noteUnhandled(outcome.commandId, eventToken)
    }
    recordDispatchTrace(
      filled.commandId,
      outcome.status,
      eventToken,
      // `settled` 也可能是**业务拒绝**：`executeNow` 的返回值里带 `status:'rejected'`。
      // 只按分发状态判会把这条拒绝的原因整个丢掉 —— 轨迹只剩 `dispatched:settled`，
      // 于是"命令被拒了"与"命令生效了"在证据上完全同形。
      // 实测的后果：面板写「方块标识」对本文档所有取值都被
      // `identity-not-in-palette` 拒绝（调色板里同 (注册名尾段, meta) 有多条内容键
      // ⇒ `identityRefOf` 按歧义如实拒绝），而没有任何观测面记下它。
      dispatchRejectionOf(outcome),
    )
    return outcome
  }

  /** 一次分发的**业务拒绝**错误（两种形态：分发被拒 / 已结算但业务被拒）。 */
  function dispatchRejectionOf(outcome: DispatchOutcome): DomainError | null {
    if (outcome.status === 'rejected') return outcome.error
    if (outcome.status === 'settled' && outcome.outcome.status === 'rejected') return outcome.outcome.error
    return null
  }

  /**
   * 记录**实际分发**的结果。
   *
   * 为什么必须有：路由轨迹只说明"判定谁是接收者"，不说明"命令是否真的发出去了"。
   * 缺了它，"Enter 是否只提交一次""提交是否被拒绝"这类断言只能靠界面副作用反推，
   * 而界面副作用要等一帧、可能被别的路径掩盖（端到端实测：Enter 的提交
   * 在轨迹里看不见，只能看到 `text-enter` 的路由结论）。
   *
   * 与路由轨迹**同一条数组**：判的是"一个事件 → 至多一条命令"，
   * 两者必须在同一时间线上才能机械对账。故 `source` 用 `'command'` 区分。
   */
  function recordDispatchTrace(
    commandId: string,
    status: DispatchOutcome['status'],
    eventToken: number,
    error: DomainError | null,
  ): void {
    // 拒绝时**必须**带结构化参数（`DomainError.params`），否则"为什么被拒"不可诊断：
    // 只有错误码时 `UnsupportedOperation` 无法区分 `unboundControl` /
    // `commandNotWiredToInputPort` / `unknownPropertyControl`，
    // 而这三者的修法完全不同（端到端实测到的证据缺口）。
    const detail =
      error === null
        ? ''
        : `:${error.code}:${Object.entries(error.params)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(',')}`
    record({
      token: eventToken,
      source: 'command',
      kind: 'command',
      level: 'command',
      receiver: commandId,
      commandId,
      reason: error === null ? `dispatched:${status}` : `rejected:${status}${detail}`,
      startedModal: false,
    })
  }

  function noteUnhandled(commandId: string, eventToken: number): void {
    unhandledLocalActions.push(`${commandId}@${eventToken}`)
    if (unhandledLocalActions.length > 64) unhandledLocalActions.splice(0, unhandledLocalActions.length - 64)
  }

  let localActionHandler: LocalActionHandler | null = null
  const unhandledLocalActions: string[] = []

  /** 草稿效果 → 领域命令。`commit` 是**唯一**触碰领域的形状。 */
  function runTextEffects(effects: readonly TextDraftEffect[], eventToken: number): readonly DispatchOutcome[] {
    const out: DispatchOutcome[] = []
    for (const effect of effects) {
      if (effect.kind !== 'commit') continue
      const r = dispatch({ commandId: 'draft.commit', params: { controlId: effect.controlId, value: effect.value } }, eventToken)
      if (r) out.push(r)
    }
    return out
  }

  function platformFor(decision: RoutingDecision, pointerId: number, captureRegionId: string | null): PlatformActionRequest {
    return Object.freeze({
      preventDefault: decision.preventDefault,
      stopPropagation: decision.stopPropagation,
      pointerId,
      captureAction: 'none',
      captureRegionId,
    })
  }

  return {
    handleKey(fact) {
      // `keyup` 与 `keydown` **分开计数**：一次按键 = 一次 keydown + 一次 keyup。
      // 若都算进 `keyEvents`，"一次按键只被处理一次"的判据会恒为 2（实测）。
      if (fact.kind === 'keyup') counters.keyUpEvents += 1
      else counters.keyEvents += 1
      const before = routing
      const r = routeKeyboardKey(before, fact)
      routing = r.state
      const d = r.decision

      if (d.reason === 'token-already-consumed' || d.reason === 'modal-start-already-consumed') {
        counters.suppressedDuplicates += 1
      }

      const outcomes: DispatchOutcome[] = []

      /**
       * 文本层是否已经**就地**消费了这次意图（草稿三态：`draft.undo`/`draft.redo`/
       * `draft.key`）。就地消费的意图**不得**再经 `dispatch` 走一遍 ——
       * 否则同一次按键会被当成两条命令（草稿提交已经在 `runTextEffects` 里发出）。
       */
      let consumedByTextLayer = false

      // 文本层语义（草稿三态）在纯函数里执行；本层只搬运状态与效果。
      const activeControlId = before.textFocus.controlId
      if (activeControlId !== null && d.level === 'text' && d.intent !== null && d.intent.commandId.startsWith('draft.')) {
        const key = typeof d.intent.params.key === 'string' ? (d.intent.params.key as DraftKey) : null
        const draftKey: DraftKey | null =
          key ?? (d.intent.commandId === 'draft.undo' ? 'Ctrl+Z' : d.intent.commandId === 'draft.redo' ? 'Ctrl+Shift+Z' : null)
        if (draftKey !== null) {
          consumedByTextLayer = true
          const tr = applyDraftKey(text, activeControlId, draftKey, fact.token)
          if (tr.status === 'duplicate') {
            counters.suppressedDuplicates += 1
          } else {
            text = tr.state
            outcomes.push(...runTextEffects(tr.effects, fact.token))
          }
        }
      } else if (
        activeControlId !== null &&
        d.level === 'text' &&
        d.intent === null &&
        (before.textFocus.composing || fact.composing)
      ) {
        // 组合期间的可打印键：被文本层收下、**未**变成场景快捷键。
        // 计数它，是为了让"忽略 composition 状态"的负对照有可观测差异。
        counters.imeSuppressedShortcuts += 1
      }

      if (d.startsModal && d.intent !== null) counters.modalStarts += 1
      /**
       * 意图 → 分发的**唯一收口**（此处修复）。
       *
       * ## 这里曾经漏掉什么（运行期实测）
       *
       * 旧写法是 `if (d.startsModal) dispatch(d.intent, …)`。于是**只有**启动模态操作的
       * 键（交互 Enter/Escape、弹窗确认）会走到分发；而 `level: 'app'` 与
       * `level: 'area'` 的意图 `startsModal` 为 `false` ⇒ **全部键盘快捷键都不分发**：
       *
       * | 键 | 意图 | 旧行为 |
       * |---|---|---|
       * | Ctrl+Z / Ctrl+Shift+Z | `edit.undo` / `edit.redo`（app） | 意图产出后**被丢弃** ⇒ 静默 no-op |
       * | `g`/`a`/`b`/`l`/`p`/`Tab`/`t`/`n` | `local.*`（area） | 同上 ⇒ 移动工具等全部不可达 |
       * | 弹窗内 Escape | `modal.close`（modal） | 同上 ⇒ Escape 不关弹窗 |
       *
       * 实测证据（撤销诊断记录）：Ctrl+Z 后轨迹出现
       * `{level:'app', commandId:'edit.undo', reason:'app-hotkey', startedModal:false}`，
       * 但**没有**任何 `source:'command'` 记录；同一时刻经菜单入口
       * （`InputPort#invokeCommand('edit.undo')` → 同一个 `dispatch`）撤销**成功**
       * （`canUndo true→false`、`dirty true→false`）⇒ 下游完好，缺的只是这一跳。
       *
       * ## 为什么是"除了文本层已消费的，其余一律交出"
       *
       * 判据不是"哪个层级该分发"（那会把政策复制一份到本层），而是
       * **"路由产出了意图、且还没有人消费它"**：路由层已经用
       * `consumedTokens` / `modalStartTokens` 保证一个事件至多一个意图，
       * `dispatchIntent` 又用 `(token, commandId)` 账本保证同一意图至多执行一次
       * （账本的两处冗余落点不变）。故此处不需要再判层级。
       */
      const handedToDispatch = d.intent !== null && !consumedByTextLayer
      record({
        token: fact.token,
        source: 'key',
        kind: fact.kind,
        level: d.level,
        receiver: d.receiver,
        commandId: d.intent?.commandId ?? null,
        reason: d.reason,
        startedModal: d.startsModal,
        dispatched: handedToDispatch,
      })
      if (handedToDispatch) {
        const o = dispatch(d.intent, fact.token)
        if (o) outcomes.push(o)
      }

      return Object.freeze({
        token: fact.token,
        decision: d,
        platformAction: platformFor(d, -1, null),
        outcomes: Object.freeze(outcomes),
        captureRegistered: false,
        captureReleased: false,
      })
    },

    handlePointer(fact) {
      // 捕获归属的**变更前快照**：`routePointer` 可能自己把归属删掉
      // （浏览器先派发 `lostpointercapture`，随后的 up 就看不到 owned 状态），
      // 故释放计数必须按状态差分算，不能只看决策的 `captureAction`。
      const beforeCaptures = routing.pointerCaptures
      const r = routePointer(routing, fact)
      routing = r.state
      const d = r.decision
      const outcomes: DispatchOutcome[] = []
      let captureRegistered = false
      let captureReleased = false

      if (d.captureAction === 'capture' && fact.kind === 'down') {
        // 捕获**按 pointerId 登记**，与"有没有活动交互"无关（捕获政策
        // 「按 pointerId 判定指针捕获」）。此前只在 `interaction !== null` 时登记，
        // 于是工作台（产品侧尚未声明活动交互）**从不**登记捕获 ——
        // `captured-pointer-single-route` 永远不会出现（端到端实测）。
        const interaction = routing.interaction
        if (d.regionId !== null) {
          routing = bindPointerCapture(routing, {
            pointerId: fact.pointerId,
            regionId: d.regionId,
            contextId: interaction?.contextId ?? '',
            tool: interaction?.tool ?? '',
            startedModal: interaction !== null,
          })
          counters.capturesAcquired += 1
          captureRegistered = true
        }
      }
      if (d.captureAction === 'release' && (fact.kind === 'up' || fact.kind === 'cancel')) {
        // 平台侧显式释放（决策要求时）。**计数**不在这里做 —— 见下面的状态差分。
        routing = releasePointerCapture(routing, fact.pointerId)
      }
      // 捕获丢失**只**数真正持有过的 pointer：否则每个 pointer 事件都会虚增释放数，
      // "丢失按政策取消"就失去可判别据（实测：`capturesReleased` 被 hover 事件刷到 4）。
      if (fact.kind === 'capture-lost') {
        if (d.reason === 'capture-lost-cancel') counters.captureLostOwned += 1
        else counters.captureLostNotOwned += 1
      }

      // 捕获登记/释放**按状态差分计数**，而不是按"哪条分支跑了"。
      //
      // 为什么必须差分：`routePointer` 在 `captured === false` 的 `up` 上
      // **已经**把该 pointer 从 `pointerCaptures` 里删掉了（见 `domain/input`
      // 的捕获丢失分支）。于是"释放"有**两条**产生路径：
      //  (a) 决策带 `captureAction: 'release'`；
      //  (b) 决策不带，但 `routePointer` 已把归属删掉（浏览器先派发了
      //      `lostpointercapture`，随后的 up 就看不到 owned 状态）。
      // 只数 (a) 会让 `released` 恒为 0、登记与释放永不配平
      // （端到端实测：`acquired=1 released=0`）。
      // 差分同时覆盖两条路径，且不会重复计数（状态里本来就没有的就减不出增量）。
      const capturesBefore = Object.keys(beforeCaptures).length
      const capturesAfter = Object.keys(routing.pointerCaptures).length
      if (capturesAfter < capturesBefore) {
        counters.capturesReleased += capturesBefore - capturesAfter
        captureReleased = true
      }

      // 捕获丢失按政策取消（「丢失按政策取消」）
      if (d.cancelInteraction !== null) {
        const o = dispatch(
          { commandId: 'interaction.cancel', params: { contextId: d.cancelInteraction.contextId, tool: d.cancelInteraction.tool } },
          fact.token,
        )
        if (o) outcomes.push(o)
      }

      record({
        token: fact.token,
        source: 'pointer',
        kind: 'pointer',
        level: d.receiverKind,
        receiver: d.receiver,
        commandId: d.intent?.commandId ?? null,
        reason: d.reason,
        startedModal: false,
      })
      if (d.intent !== null) {
        const o = dispatch(d.intent, fact.token)
        if (o) outcomes.push(o)
      }

      return Object.freeze({
        token: fact.token,
        decision: d,
        platformAction: Object.freeze({
          preventDefault: d.preventDefault,
          stopPropagation: false,
          pointerId: fact.pointerId,
          captureAction: d.captureAction,
          captureRegionId: d.regionId,
        }),
        outcomes: Object.freeze(outcomes),
        captureRegistered,
        captureReleased,
      })
    },

    setInteraction(interaction) {
      routing = withInteraction(routing, interaction === null ? null : Object.freeze({ ...interaction }))
    },
    setActiveRegion(regionId) {
      routing = withActiveRegion(routing, regionId)
    },
    setHotkeys(area, app) {
      routing = withHotkeys(routing, area, app)
    },
    setCapabilities(source) {
      capabilitySource = source
    },
    openModal(scope) {
      // **压栈**：后开的作用域成为栈顶，先开的保留在栈里
      // （关掉内层要能回到外层 —— 单槽位会丢失外层，见 `InputRoutingState.modalStack`）。
      routing = pushModalScope(routing, modalOpened(scope))
    },
    closeModal(scopeId) {
      // **出栈**：只移除指定作用域；若它是栈顶，栈顶回落到前一个。
      // `popModalScope` 返回 `null` 表示"这个 id 不在栈里" —— 不动状态（不静默）。
      const r = popModalScope(routing, scopeId)
      if (r !== null) routing = r.state
    },
    bindControl(binding) {
      const controls = { ...bindings.controls, [binding.controlId]: Object.freeze({ ...binding }) }
      bindings = Object.freeze({ ...bindings, controls: Object.freeze(controls) })
    },
    unbindControl(controlId) {
      if (!Object.prototype.hasOwnProperty.call(bindings.controls, controlId)) return
      const controls = { ...bindings.controls }
      delete controls[controlId]
      bindings = Object.freeze({ ...bindings, controls: Object.freeze(controls) })
      const r = blurControl(text, controlId, 'target-invalid', 0)
      if (r.status === 'applied') {
        text = r.state
        runTextEffects(r.effects, 0)
      }
      if (routing.textFocus.controlId === controlId) routing = withTextFocus(routing, NO_TEXT_FOCUS)
    },
    bindInteraction(binding) {
      const interaction = { ...bindings.interaction, [binding.contextId]: Object.freeze({ ...binding }) }
      bindings = Object.freeze({ ...bindings, interaction: Object.freeze(interaction) })
    },

    registerTextControl(input, token) {
      const r = focusControl(text, input, token)
      if (r.status === 'applied') {
        text = r.state
        runTextEffects(r.effects, token)
      }
      routing = withTextFocus(routing, { controlId: input.controlId, composing: false })
      return r.status === 'applied' ? r.effects : Object.freeze([])
    },
    applyTextInput(controlId, value, token) {
      const r = applyDraftInput(text, controlId, value, token)
      if (r.status !== 'applied') return Object.freeze([])
      text = r.state
      runTextEffects(r.effects, token)
      if (routing.textFocus.controlId !== controlId) {
        routing = withTextFocus(routing, { controlId, composing: routing.textFocus.composing })
      }
      return r.effects
    },
    compositionStart(controlId, token) {
      const r = applyCompositionStart(text, controlId, token)
      if (r.status === 'applied') text = r.state
      routing = withTextFocus(routing, { controlId, composing: true })
    },
    compositionUpdate(controlId, value, token) {
      const r = applyCompositionUpdate(text, controlId, value, token)
      if (r.status === 'applied') text = r.state
    },
    compositionEnd(controlId, value, token) {
      const r = applyCompositionEnd(text, controlId, value, token)
      if (r.status === 'applied') text = r.state
      routing = withTextFocus(routing, { controlId, composing: false })
    },
    blurTextControl(controlId, reason, token) {
      const r = blurControl(text, controlId, reason, token)
      if (r.status === 'applied') {
        text = r.state
        runTextEffects(r.effects, token)
      }
      if (routing.textFocus.controlId === controlId) routing = withTextFocus(routing, NO_TEXT_FOCUS)
      return r.status === 'applied' ? r.effects : Object.freeze([])
    },
    blurCurrentTextFocus(reason, token) {
      const controlId = routing.textFocus.controlId
      if (controlId === null) return Object.freeze([])
      const r = blurControl(text, controlId, reason, token)
      if (r.status === 'applied') {
        text = r.state
        runTextEffects(r.effects, token)
      }
      routing = withTextFocus(routing, NO_TEXT_FOCUS)
      return r.status === 'applied' ? r.effects : Object.freeze([])
    },

    applyVisibility(input) {
      const r = applyVisibilityChange(routing, input)
      routing = r.state
      record({
        token: nextToken(),
        source: 'visibility',
        kind: 'visibility',
        level: null,
        receiver: null,
        commandId: null,
        reason: input.hidden ? 'suspended' : `resumed(dropped=${r.droppedTicks})`,
        startedModal: false,
      })
      return Object.freeze({ resumeBaseline: r.resumeBaseline, droppedTicks: r.droppedTicks })
    },

    textProjection(controlId) {
      const c = text.controls[controlId]
      return c ? draftProjection(c) : null
    },
    setLocalActionHandler(handler) {
      localActionHandler = handler
    },
    invokeCommand,
    setActiveContext(contextId) {
      activeContextId = contextId
    },
    get unhandledLocalActions() {
      return Object.freeze([...unhandledLocalActions])
    },
    get boundControlIds() {
      return Object.freeze(Object.keys(bindings.controls))
    },
    nextToken,
    get trace() {
      return Object.freeze([...trace])
    },
    get counters() {
      return Object.freeze({ ...counters })
    },
    get routing() {
      return routing
    },
    get text() {
      return text
    },
    get ledger() {
      return ledger
    },
  }
}

/** 弹窗作用域构造（供呈现层组装，避免各组件自己拼结构）。 */
export function modalScopeFor(input: {
  scopeId: string
  confirmOnEnter?: boolean
  blocksBackground?: boolean
  textControlIds?: readonly string[]
}): ModalScopeState {
  return modalOpened(input)
}

/**
 * 把 `EditorClient` 结构化适配成 `CommandSink`。
 *
 * 为什么需要适配而不是在 `application` 里直接依赖 `EditorClient`：
 * `application` 依赖 `runtime` 会违反分层导入规则，并被
 * `gate/no-private-cross-layer` 判红。分层规则明确 `runtime` 是
 * "调用纯函数、**提供执行能力**"的那一层 —— 端口实现落在这里才符合依赖方向。
 *
 * 适配**不做任何政策判断**：不补能力集合、不改命令形态、不吞 `executeNow` 的拒绝。
 * `Editor` 的两个方法签名与端口一致，故这是结构等价适配（不引入新语义）。
 */
export function editorCommandSink(editor: EditorClient): CommandSink {
  return {
    submit(command, source) {
      const ticket = editor.submit(command, source as Parameters<EditorClient['submit']>[1])
      return { ticketId: ticket.ticketId, commandId: ticket.commandId }
    },
    executeNow(command) {
      return editor.executeNow(command)
    },
  }
}

/**
 * 把输入会话接到一个 `EditorClient` 上：建 sink、建会话、注入能力来源。
 *
 * 这是**装配**（装配根可以引用实现并注册），故放一个便利函数，
 * 避免各外壳重复这三行；政策一律不在其中。
 */
export function createEditorBackedInputSession(parts: {
  readonly editor: EditorClient
  readonly capabilities: () => readonly string[]
  readonly areaHotkeys?: readonly HotkeyBinding[]
  readonly appHotkeys?: readonly HotkeyBinding[]
}): InputSession {
  const session = createInputSession({
    sink: editorCommandSink(parts.editor),
    capabilities: parts.capabilities,
    ...(parts.areaHotkeys === undefined ? {} : { areaHotkeys: parts.areaHotkeys }),
    ...(parts.appHotkeys === undefined ? {} : { appHotkeys: parts.appHotkeys }),
  })
  return session
}
