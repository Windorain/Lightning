/**
 * `domain/input` —— **纯输入路由**：键盘焦点、指针命中 Area、活动编辑上下文、
 * 活动交互捕获、弹窗作用域（#249 §19.1；P7 = #258）。
 *
 * ## 这个模块存在的理由（它替代的旧机制）
 *
 * 旧实现把"该谁收这个键"的判断散在 5 个文件里，且判据互相矛盾：
 *  - `runtime/chromeBinder.ts` 的 document 级 `keydown`（capture）；
 *  - `runtime/viewportBinder.ts` 的**又一**条 document 级 `keydown`（capture）；
 *  - `wiki/wikiInputShield.ts` 的"Wiki 宿主下是否跳过"（读 `event.target` + 全局 `wikiModalOpen`）；
 *  - `handlers/keymapHandler.ts` 的 region keymap；
 *  - 各处组件自己的 `window.addEventListener('keydown')`。
 *
 * 于是同一次按键会被**两条** capture 监听各判一次，各自决定是否 dispatch；
 * 而"我在不在输入框里"这个判断由 `util/browser.isEditingTarget(event.target)` 在
 * **语义层**完成 —— 它读的是 DOM 事实，而不是显式状态。这正是 #249 §19.1 要退役的形态：
 * 「浏览器适配器采集事实；纯路由函数根据**显式状态**决定接收者…**语义层不读取
 * `document.activeElement`**」。
 *
 * 本模块把这件事变成**一个纯函数**：输入是（显式状态 + 事件事实），输出是
 * （接收者层级 + 命令意图 + 是否阻止默认行为）。所有 DOM 事实由 `adapters/inputFacts`
 * 提取；本模块不 import 任何 DOM 类型、不读任何全局。
 *
 * ## 键盘优先级（#249 §19.1 逐字，**不得**重排）
 *
 * ```
 * 模态 UI 的焦点范围 → 获得焦点的文本/IME 输入 → 当前编辑交互 → Area 快捷键 → 应用快捷键
 * ```
 *
 * 每一级都有一条**可判红的负对照**（见 `web/src/domain/__tests__/inputRouting.test.ts`）：
 *  - 打乱顺序 ⇒ 在弹窗里按 G 会启动移动工具（而不是留在弹窗）；
 *  - IME 组合期不短路 ⇒ 拼音字母 g 触发场景快捷键（A25 负对照「忽略 composition 状态」）；
 *  - 缺"同一事件不启动两次模态操作"的去重 ⇒ 两条 handler 各启动一次（A22 负对照）。
 *
 * ## 指针路由（**不用**键盘优先级替代）
 *
 * #249 §19.1：「指针捕获对所属 pointerId 单独路由，不用键盘优先级替代」。
 * 故 `routePointer` 与 `routeKeyboard` 是**两个**函数、两份状态：捕获按 `pointerId` 索引，
 * 捕获丢失（`lostpointercapture`）只影响那一个 pointer，并按其政策取消它启动的交互。
 *
 * ## 输入事件契约不只容纳鼠标字段
 *
 * `PointerFact` 显式携带触屏/手写笔字段（`pointerType`、`pressure`、`tiltX/Y`、`twist`、
 * `width/height`）以及**轨迹点**（`trail`）。#249 §9：「笔划等轨迹输入**不得默认丢点**；
 * down/up/cancel 和命令顺序不合并」—— 故 `trail` 是数组且原样交给接收者，
 * `kind: 'down' | 'up' | 'cancel'` 各自独立判据，没有任何合并路径。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 命令意图（菜单/按钮/快捷键/命令搜索引用**同一** ID 与参数描述 —— #249 §19.1）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 命令参数值（**可序列化**）。
 *
 * 允许字符串数组是为了承载"一次交互的多个目标"（`beginInteraction.targets`）——
 * 那是**一个**命令的参数，不是"把命令数组化"（契约 §5.2 禁止的形态）。
 * 参数里**不得**出现函数/闭包/DOM 节点：命令意图要能进重放记录（A04）。
 */
export type ParamValue = string | number | boolean | readonly string[]

/**
 * 命令意图：**纯数据**，不含执行闭包。
 *
 * #249 §19.1：「菜单、按钮、快捷键、命令搜索引用同一命令 ID 和参数描述」。
 * 故这里是 `commandId` + 可序列化参数 —— 与 `application/inputCommands.ts` 的命令
 * 注册表按 ID 对接；`runtime` 把它翻成 P1 的 `submit` / `executeNow`。
 */
export interface CommandIntent {
  readonly commandId: string
  readonly params: Readonly<Record<string, ParamValue>>
}

/** 键盘路由层级（顺序即优先级；见文件头）。 */
export type RoutingLevel = 'modal' | 'text' | 'interaction' | 'area' | 'app' | 'none'

/**
 * 一次路由的结果。
 *
 * `startsModal` 是 A22「同一事件不启动两次模态操作」的落点：
 * 只有**会启动模态操作**的判定才置位，同一 `token` 第二次时整个判定退化为 `none`。
 */
export interface RoutingDecision {
  readonly level: RoutingLevel
  /** 接收者标识（`modal:<id>` / `text:<controlId>` / `interaction:<ctxId>` / `area:<regionId>` / `app`）。 */
  readonly receiver: string
  readonly intent: CommandIntent | null
  readonly preventDefault: boolean
  readonly stopPropagation: boolean
  readonly startsModal: boolean
  /** 结构化理由（诊断；不参与业务分支）。 */
  readonly reason: string
}

// ─────────────────────────────────────────────────────────────────────────────
// 事件事实（由 adapters/browser 提取；**语义层不读 DOM**）
// ─────────────────────────────────────────────────────────────────────────────

export interface KeyFact {
  /** 接线层分配的单调 token。去重、A22 判定与重放都依赖它。 */
  readonly token: number
  readonly kind: 'keydown' | 'keyup'
  /** `KeyboardEvent.key`（归一后，`'a'` 之类单字符是小写）。 */
  readonly key: string
  readonly ctrl: boolean
  readonly shift: boolean
  readonly alt: boolean
  readonly meta: boolean
  /** 长按重复。与首次按下**不同**：不重复启动模态操作。 */
  readonly repeat: boolean
  /** 事件自身的组合态（`KeyboardEvent.isComposing`）。**事实**，不参与政策。 */
  readonly composing: boolean
  /** 目标是否为可编辑元素 —— **适配器提取的事实**（语义层不查 `activeElement`）。 */
  readonly targetEditable: boolean
  /**
   * 该事件目标落在哪个已登记模态根内（`null` = 背景）。
   *
   * 与 {@link PointerFact.hitModalScopeId} 同一事实、同一理由：模态**内部**的原生控件
   * （textarea/input）要拿到按键的默认行为（插入字符），而背景仍要被 Modal 语义吞掉。
   */
  readonly hitModalScopeId: string | null
  readonly defaultPrevented: boolean
}

/** 轨迹点（笔划）。`timeStamp` 由适配器提供（可来自 `event.timeStamp`）。 */
export interface TrailPoint {
  readonly x: number
  readonly y: number
  readonly timeStamp: number
  /** 该点来自合并事件还是原始事件（`getCoalescedEvents`）。保留是为了不丢点的可审计性。 */
  readonly fromCoalesced: boolean
}

export type PointerKind = 'down' | 'move' | 'up' | 'cancel' | 'capture-lost' | 'enter' | 'leave' | 'wheel'

/**
 * 指针事件事实。
 *
 * **不只鼠标字段**：`pointerType` 覆盖 `pen`/`touch`，并携带压感/倾角/接触几何。
 * 完整触屏/手写笔工具链不在本次范围（#258「退出与边界」），但字段与路由必须已就位。
 */
export interface PointerFact {
  readonly token: number
  readonly kind: PointerKind
  readonly pointerId: number
  readonly pointerType: 'mouse' | 'pen' | 'touch'
  readonly button: number
  readonly buttons: number
  readonly clientX: number
  readonly clientY: number
  readonly isPrimary: boolean
  readonly ctrl: boolean
  readonly shift: boolean
  readonly alt: boolean
  readonly meta: boolean
  /** 触屏/手写笔专有字段（鼠标恒为缺省）。 */
  readonly pressure?: number
  readonly tiltX?: number
  readonly tiltY?: number
  readonly twist?: number
  readonly width?: number
  readonly height?: number
  /** 该事件命中的 Area（由适配器按坐标事实判定；`null` = 不在任何 Area 内）。 */
  readonly hitRegionId: string | null
  /**
   * 该事件目标落在哪个**已登记模态根**内（`null` = 不在任何模态内）。
   *
   * ## 为什么必须有这一维（M5-5 打回：设置抽屉的原生下拉打不开）
   *
   * 模态的"阻断背景"是**正当语义**，但它此前无法区分"点在模态**背景**"与
   * "点在模态**自己**的 DOM 里"：适配器只报坐标事实，路由拿不到"目标在谁内部"，
   * 于是对**所有**未捕获指针事件一律 `preventDefault`。按钮靠 `click` 侥幸可用，
   * 而原生 `<select>` / 文本框 / checkbox 吃 `pointerdown` 的默认行为（焦点、下拉）
   * ⇒ 模态里的这些控件全部失效，且**没有任何报错**。
   *
   * ## 为什么是"作用域 id"而不是布尔
   *
   * 只报"在模态内"会让**另一个**未打开模态的 DOM（比如前一个弹窗残留节点）也算内部。
   * 带上 scopeId，路由才能核对"是不是**当前**这个模态"（见 `routePointer`）。
   * 适配器负责把 DOM 事件目标翻成这个事实（它知道已登记模态的根元素）。
   */
  readonly hitModalScopeId: string | null
  /** 该 `pointerId` 当前是否已被本应用捕获（平台事实）。 */
  readonly captured: boolean
  /** 轨迹点（**不合并、不丢弃**；空数组表示本次事件无轨迹）。 */
  readonly trail: readonly TrailPoint[]
}

// ─────────────────────────────────────────────────────────────────────────────
// 显式状态（#249 §19.1「纯路由函数根据显式状态决定接收者」）
// ─────────────────────────────────────────────────────────────────────────────

/** 弹窗作用域（模态 UI 的焦点范围）。 */
export interface ModalScopeState {
  readonly open: boolean
  readonly scopeId: string | null
  /** 弹窗内的焦点元素 id（用于 Enter 确认的落点判定）。 */
  readonly focusId: string | null
  /** 是否阻断背景（`true` ⇒ 未匹配的键不落到交互/Area/应用层）。 */
  readonly blocksBackground: boolean
  /** 是否把 Enter 解释为确认。 */
  readonly confirmOnEnter: boolean
  /** 该弹窗**内部**的文本控件 id（它们在弹窗内仍接收输入，不被"模态优先"吃掉）。 */
  readonly textControlIds: readonly string[]
}

export const NO_MODAL: ModalScopeState = Object.freeze({
  open: false,
  scopeId: null,
  focusId: null,
  blocksBackground: false,
  confirmOnEnter: false,
  textControlIds: Object.freeze([]) as readonly string[],
})

/** 文本焦点（由 focusin/focusout 事实同步；**不查** `document.activeElement`）。 */
export interface TextFocusState {
  readonly controlId: string | null
  /** IME 组合中（`compositionstart` 置位、`compositionend` 清除）。 */
  readonly composing: boolean
}

export const NO_TEXT_FOCUS: TextFocusState = Object.freeze({ controlId: null, composing: false })

/** 活动编辑交互（哪个上下文、哪个 Area、哪个工具）。 */
export interface ActiveInteractionState {
  readonly contextId: string
  readonly regionId: string
  readonly tool: string
}

/** 快捷键绑定（Area 与应用两层共用结构；具体映射表属**配置**，#258「退出与边界」）。 */
export interface HotkeyBinding {
  readonly key: string
  readonly ctrl?: boolean
  readonly shift?: boolean
  readonly alt?: boolean
  /** 命中的命令意图。 */
  readonly commandId: string
  readonly params?: Readonly<Record<string, ParamValue>>
  /** 是否阻止浏览器默认行为（默认 `true`：注册过的组合键不该同时触发浏览器动作）。 */
  readonly preventDefault?: boolean
  /** 该命令是否启动一次模态操作（A22 的判定输入）。 */
  readonly startsModal?: boolean
}

/** 指针捕获归属（**按 `pointerId` 单独路由**）。 */
export interface PointerCaptureOwnership {
  readonly pointerId: number
  readonly regionId: string
  readonly contextId: string
  /** 该 pointer 启动的交互命令（捕获丢失时按政策取消它）。 */
  readonly tool: string
  /** 该 pointer 是否启动过一次模态操作（A22：同一事件不启动两次）。 */
  readonly startedModal: boolean
}

/**
 * 路由状态（**纯值**）。
 *
 * 两处去重表都是有界的：
 *  - `consumedTokens`：Enter/Escape 不重复消费；
 *  - `modalStartTokens`：同一事件不启动两次模态操作。
 * 放在状态里而不是接线层的闭包里，是为了让"不重复消费"成为**可重放**的性质
 * （接线层写错也绕不过去）。
 */
export interface InputRoutingState {
  /**
   * 当前作用域（栈顶）。`NO_MODAL` 表示无弹窗。
   *
   * 与 `modalStack` 的关系：`modal` 恒等于栈顶（或 `NO_MODAL`）。
   * 保留它是因为**绝大多数判据只关心当前作用域**（键盘归属、指针阻断），
   * 让它们读 `state.modal` 比读 `stack[stack.length-1]` 更直白、也更难写错。
   */
  readonly modal: ModalScopeState
  /**
   * 已打开的作用域**栈**（底部在前）。
   *
   * ## 为什么必须是栈，而不是单个槽位
   *
   * 单个槽位有一个结构性缺陷：后开的弹窗**覆盖**先开的，关闭后者时前者
   * 无从恢复。旧实现（`wikiInputShield` 的模块级 `let wikiModalOpen`）正是这个形态，
   * 只不过退化成一个布尔，连"哪个作用域"都表达不了。
   *
   * 真实场景要求嵌套：设置抽屉里再点"保存到 Wiki"（Wiki 弹窗），
   * 或在 Wiki 弹窗里再开结构选择器。关掉内层必须**回到外层**，
   * 而不是"一律变回无弹窗"（P7 首跑 e2e 实测：单槽位下关掉内层直接变 `null`）。
   */
  readonly modalStack: readonly ModalScopeState[]
  readonly textFocus: TextFocusState
  readonly interaction: ActiveInteractionState | null
  /** 最后命中的 Area（键盘落到哪个 Area 的快捷键表）。 */
  readonly activeRegionId: string | null
  readonly areaHotkeys: readonly HotkeyBinding[]
  /** 显式保留的应用命令（#249 §19.1「由规则列明，**不拦截所有键**」）。 */
  readonly appHotkeys: readonly HotkeyBinding[]
  readonly pointerCaptures: Readonly<Record<number, PointerCaptureOwnership>>
  readonly consumedTokens: readonly number[]
  readonly modalStartTokens: readonly number[]
  /** 页面挂起基线（见 `applyVisibilityChange`）。 */
  readonly suspension: SuspensionState
}

export const DEDUPE_TOKEN_LIMIT = 256

export interface SuspensionState {
  readonly suspended: boolean
  /** 挂起开始时刻（毫秒；来自适配器注入的时钟，**不读**全局）。 */
  readonly suspendedAt: number
  /** 本次挂起期间被**丢弃**（不追赶）的 tick 数。恢复时如实报告。 */
  readonly droppedTicks: number
}

export const NOT_SUSPENDED: SuspensionState = Object.freeze({ suspended: false, suspendedAt: 0, droppedTicks: 0 })

export function createInputRoutingState(parts: {
  areaHotkeys?: readonly HotkeyBinding[]
  appHotkeys?: readonly HotkeyBinding[]
  activeRegionId?: string | null
} = {}): InputRoutingState {
  return Object.freeze({
    modal: NO_MODAL,
    modalStack: Object.freeze([]) as readonly ModalScopeState[],
    textFocus: NO_TEXT_FOCUS,
    interaction: null,
    activeRegionId: parts.activeRegionId ?? null,
    areaHotkeys: Object.freeze([...(parts.areaHotkeys ?? [])]),
    appHotkeys: Object.freeze([...(parts.appHotkeys ?? [])]),
    pointerCaptures: Object.freeze({}),
    consumedTokens: Object.freeze([]),
    modalStartTokens: Object.freeze([]),
    suspension: NOT_SUSPENDED,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

function tokenSeen(list: readonly number[], token: number): boolean {
  return token !== 0 && list.includes(token)
}

function pushBounded(list: readonly number[], token: number, limit = DEDUPE_TOKEN_LIMIT): readonly number[] {
  if (token === 0 || list.includes(token)) return list
  const next = [...list, token]
  return Object.freeze(next.length > limit ? next.slice(next.length - limit) : next)
}

function createRoutingState(base: InputRoutingState, patch: Partial<InputRoutingState>): InputRoutingState {
  return Object.freeze({ ...base, ...patch })
}

// ─────────────────────────────────────────────────────────────────────────────
// 键盘路由（纯）
// ─────────────────────────────────────────────────────────────────────────────

function decision(parts: Partial<RoutingDecision> & { level: RoutingLevel; receiver: string; reason: string }): RoutingDecision {
  return Object.freeze({
    level: parts.level,
    receiver: parts.receiver,
    intent: parts.intent ?? null,
    preventDefault: parts.preventDefault ?? false,
    stopPropagation: parts.stopPropagation ?? false,
    startsModal: parts.startsModal ?? false,
    reason: parts.reason,
  })
}

/** 快捷键表匹配（显式修饰键语义：未声明即要求**未按下**）。 */
export function matchHotkey(bindings: readonly HotkeyBinding[], key: string, mods: { ctrl: boolean; shift: boolean; alt: boolean }): HotkeyBinding | null {
  const normalized = key.length === 1 ? key.toLowerCase() : key
  for (const b of bindings) {
    const bk = b.key.length === 1 ? b.key.toLowerCase() : b.key
    if (bk !== normalized) continue
    if ((b.ctrl ?? false) !== mods.ctrl) continue
    if ((b.shift ?? false) !== mods.shift) continue
    if ((b.alt ?? false) !== mods.alt) continue
    return b
  }
  return null
}

/**
 * 文本层键处理（在 `domain/input` 的层级里只负责**判定归属与意图**，
 * 草稿的三态语义在 `domain/textDraft`）。
 *
 * 返回 `null` 表示"文本层不认这个键" ⇒ 由外层继续按优先级下落。
 * 这是"文本输入不拦截所有键"的落点：未注册的键**不**被文本层吞掉，
 * 只是默认不把它们交给场景快捷键（因为焦点在输入框里）。
 */
function routeTextKey(state: InputRoutingState, fact: KeyFact): RoutingDecision {
  const controlId = state.textFocus.controlId
  if (controlId === null) return decision({ level: 'none', receiver: 'none', reason: 'no-text-focus' })
  const receiver = `text:${controlId}`

  // IME 组合期：**任何**键都不产生场景意图（A25 负对照「忽略 composition 状态」的判红点）。
  // 组合期间 Ctrl+Z 也不作用于草稿局部历史 —— 输入法自己在管理组合串。
  if (state.textFocus.composing || fact.composing) {
    return decision({
      level: 'text',
      receiver,
      preventDefault: false,
      stopPropagation: true,
      reason: 'ime-composing',
    })
  }

  if (fact.key === 'z' && fact.ctrl && !fact.shift) {
    // #249 §19.1：输入框活动编辑期间 Ctrl+Z **默认作用于输入草稿**，不同时触发文档历史
    return decision({
      level: 'text',
      receiver,
      intent: { commandId: 'draft.undo', params: { controlId } },
      preventDefault: true,
      stopPropagation: true,
      reason: 'text-draft-undo',
    })
  }
  if (fact.key === 'z' && fact.ctrl && fact.shift) {
    return decision({
      level: 'text',
      receiver,
      intent: { commandId: 'draft.redo', params: { controlId } },
      preventDefault: true,
      stopPropagation: true,
      reason: 'text-draft-redo',
    })
  }
  if (fact.key === 'Enter') {
    return decision({
      level: 'text',
      receiver,
      intent: { commandId: 'draft.key', params: { controlId, key: 'Enter' } },
      preventDefault: true,
      stopPropagation: true,
      reason: 'text-enter',
    })
  }
  if (fact.key === 'Escape') {
    return decision({
      level: 'text',
      receiver,
      intent: { commandId: 'draft.key', params: { controlId, key: 'Escape' } },
      preventDefault: true,
      stopPropagation: true,
      reason: 'text-escape',
    })
  }
  if (fact.key === 'Tab') {
    return decision({
      level: 'text',
      receiver,
      intent: { commandId: 'draft.key', params: { controlId, key: 'Tab' } },
      preventDefault: false,
      stopPropagation: true,
      reason: 'text-tab',
    })
  }
  // 其余键：留给浏览器做原生文本编辑（**不**当快捷键、**不**阻止默认行为）。
  // 注意这里**不**返回 null：焦点在输入框时场景快捷键**不该**收到这个键，
  // 这正是 A25「只有目标接收者处理」。
  return decision({
    level: 'text',
    receiver,
    preventDefault: false,
    stopPropagation: false,
    reason: 'text-native-editing',
  })
}

function routeModalKey(state: InputRoutingState, fact: KeyFact): RoutingDecision {
  const modal = state.modal
  const scope = modal.scopeId ?? 'anonymous'
  const receiver = `modal:${scope}`

  if (fact.key === 'Escape') {
    return decision({
      level: 'modal',
      receiver,
      intent: { commandId: 'modal.close', params: { scopeId: scope } },
      preventDefault: true,
      stopPropagation: true,
      startsModal: false,
      reason: 'modal-escape',
    })
  }
  // 弹窗**内部**的文本控件仍接收输入（"模态优先"不等于"吃掉自己输入框的字符"）
  if (state.textFocus.controlId !== null && modal.textControlIds.includes(state.textFocus.controlId)) {
    return routeTextKey(state, fact)
  }
  if (modal.confirmOnEnter && fact.key === 'Enter') {
    return decision({
      level: 'modal',
      receiver,
      intent: { commandId: 'modal.confirm', params: { scopeId: scope, focusId: modal.focusId ?? '' } },
      preventDefault: true,
      stopPropagation: true,
      startsModal: true,
      reason: 'modal-enter-confirm',
    })
  }
  // 命中**当前模态自身** DOM ⇒ 交给浏览器做原生编辑（同 `PointerFact` 的那一维）。
  // 关键只有 `preventDefault: false`：在 document 的 keydown 上 `preventDefault`
  // 会取消字符插入（模态里的 textarea 因此一个字也打不进去）。
  // 仍然 `level: 'modal'`：这个键**不**得下落成 Area/应用快捷键。
  if (fact.hitModalScopeId !== null && fact.hitModalScopeId === modal.scopeId) {
    return decision({
      level: 'modal',
      receiver,
      preventDefault: false,
      stopPropagation: false,
      reason: fact.targetEditable ? 'modal-interior-native-editing' : 'modal-interior-passthrough',
    })
  }
  if (modal.blocksBackground) {
    return decision({
      level: 'modal',
      receiver,
      preventDefault: true,
      stopPropagation: true,
      reason: 'modal-blocks-background',
    })
  }
  // 不阻断背景的弹窗（如非模态浮层）：未匹配的键继续下落。
  return decision({ level: 'none', receiver: 'none', reason: 'modal-fallthrough' })
}

function routeInteractionKey(state: InputRoutingState, fact: KeyFact): RoutingDecision {
  const it = state.interaction
  if (it === null) return decision({ level: 'none', receiver: 'none', reason: 'no-interaction' })
  const receiver = `interaction:${it.contextId}`
  if (fact.key === 'Escape') {
    return decision({
      level: 'interaction',
      receiver,
      intent: { commandId: 'interaction.cancel', params: { contextId: it.contextId, regionId: it.regionId } },
      preventDefault: true,
      stopPropagation: true,
      startsModal: true,
      reason: 'interaction-escape-cancel',
    })
  }
  if (fact.key === 'Enter') {
    return decision({
      level: 'interaction',
      receiver,
      intent: { commandId: 'interaction.commit', params: { contextId: it.contextId, regionId: it.regionId } },
      preventDefault: true,
      stopPropagation: true,
      startsModal: true,
      reason: 'interaction-enter-commit',
    })
  }
  // 活动交互期间其余键交给它（模态操作拥有键盘；#249 §8「启动另一修改操作时先明确取消」）
  return decision({
    level: 'interaction',
    receiver,
    preventDefault: false,
    stopPropagation: false,
    reason: 'interaction-owns-keyboard',
  })
}

/**
 * **键盘路由**（#249 §19.1 的优先级逐字实现）。
 *
 * 返回 `{ state, decision }`：`state` 只可能因为**去重表**变化（消费 token、
 * 记录模态启动），业务语义一律不在本函数里发生。
 *
 * ## 同一事件不启动两次模态操作（A22）
 *
 * 判据是 `modalStartTokens`：一次判定若 `startsModal === true` 且该 token 已在表里，
 * 则**整个判定退化为 `none`**（没有接收者、没有意图、不阻止默认行为）。
 * 于是"两条 handler 各启动一次"在路由层就不可表达 —— 第二条拿不到意图。
 */
export function routeKeyboardKey(
  state: InputRoutingState,
  fact: KeyFact,
): { readonly state: InputRoutingState; readonly decision: RoutingDecision } {
  // keyup 不产生命令意图（避免 up/down 两处各启动一次）；但仍消费 token 以免被当成新事件。
  if (fact.kind === 'keyup') {
    return {
      state: createRoutingState(state, { consumedTokens: pushBounded(state.consumedTokens, fact.token) }),
      decision: decision({ level: 'none', receiver: 'none', reason: 'keyup-no-intent' }),
    }
  }
  if (fact.repeat) {
    // 长按重复：**不**重复启动模态操作。已消费 token ⇒ 同样退化。
    return {
      state: createRoutingState(state, { consumedTokens: pushBounded(state.consumedTokens, fact.token) }),
      decision: decision({ level: 'none', receiver: 'none', reason: 'key-repeat' }),
    }
  }
  if (tokenSeen(state.consumedTokens, fact.token)) {
    return { state, decision: decision({ level: 'none', receiver: 'none', reason: 'token-already-consumed' }) }
  }

  const mods = { ctrl: fact.ctrl || fact.meta, shift: fact.shift, alt: fact.alt }

  /**
   * 层级下落的判定必须是"**真的**被接收了"。
   *
   * 为什么用 `level !== 'none'` 而不是 `d === null`：`routeModalKey` 在
   * "非阻断背景的弹窗未匹配任何键"时必须**主动交出**（返回 `level: 'none'`），
   * 让键继续落到交互/Area/应用层。若把"返回了对象"当作"已处理"，
   * 非模态浮层就会静默吞掉全部快捷键 —— 这是一处会被 A25 抓到的假绿。
   */
  const handled = (r: RoutingDecision | null): boolean => r !== null && r.level !== 'none'

  // ── 1. 模态 UI 的焦点范围 ──
  let d: RoutingDecision | null = null
  if (state.modal.open) d = routeModalKey(state, fact)

  // ── 2. 获得焦点的文本 / IME 输入 ──
  // 注意 `targetEditable` 是适配器提取的**事实**；焦点状态是**显式状态**。
  // 语义层以显式状态为准（不查 `document.activeElement`），两者不一致时
  // 由 `reason` 记下事实，供诊断与测试对账。
  if (!handled(d) && state.textFocus.controlId !== null) {
    const textDecision = routeTextKey(state, fact)
    if (fact.targetEditable !== true) {
      d = decision({
        ...textDecision,
        reason: `${textDecision.reason}|focus-state-without-editable-target`,
      })
    } else {
      d = textDecision
    }
  }

  // ── 3. 当前编辑交互 ──
  if (!handled(d) && state.interaction !== null) d = routeInteractionKey(state, fact)

  // ── 4. Area 快捷键 ──
  if (!handled(d)) {
    const hit = matchHotkey(state.areaHotkeys, fact.key, mods)
    if (hit) {
      d = decision({
        level: 'area',
        receiver: `area:${state.activeRegionId ?? 'none'}`,
        intent: { commandId: hit.commandId, params: hit.params ?? {} },
        preventDefault: hit.preventDefault ?? true,
        stopPropagation: true,
        startsModal: hit.startsModal ?? false,
        reason: 'area-hotkey',
      })
    }
  }

  // ── 5. 应用快捷键（**显式列明**，不拦截所有键） ──
  if (!handled(d)) {
    const hit = matchHotkey(state.appHotkeys, fact.key, mods)
    if (hit) {
      d = decision({
        level: 'app',
        receiver: 'app',
        intent: { commandId: hit.commandId, params: hit.params ?? {} },
        preventDefault: hit.preventDefault ?? true,
        stopPropagation: true,
        startsModal: hit.startsModal ?? false,
        reason: 'app-hotkey',
      })
    }
  }

  // ── 6. 无人接收：**不**阻止默认行为、**不**产生意图 ──
  if (!handled(d)) d = decision({ level: 'none', receiver: 'none', reason: 'unhandled' })
  const finalDecision = d as RoutingDecision

  // A22：同一事件不启动两次模态操作
  const consumed = pushBounded(state.consumedTokens, fact.token)
  let modalStartTokens = state.modalStartTokens
  if (finalDecision.startsModal) {
    if (tokenSeen(state.modalStartTokens, fact.token)) {
      return {
        state: createRoutingState(state, { consumedTokens: consumed }),
        decision: decision({ level: 'none', receiver: 'none', reason: 'modal-start-already-consumed' }),
      }
    }
    modalStartTokens = pushBounded(state.modalStartTokens, fact.token)
  }

  return {
    state: createRoutingState(state, { consumedTokens: consumed, modalStartTokens }),
    decision: finalDecision,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 指针路由（按 pointerId 单独路由）
// ─────────────────────────────────────────────────────────────────────────────

export type PointerReceiverKind = 'captured-owner' | 'region' | 'modal' | 'none'

export interface PointerRoutingDecision {
  readonly receiverKind: PointerReceiverKind
  readonly receiver: string
  readonly regionId: string | null
  readonly intent: CommandIntent | null
  readonly captureAction: 'none' | 'capture' | 'release'
  readonly preventDefault: boolean
  /** 轨迹点**原样**交出（不丢点、不合并）。 */
  readonly trail: readonly TrailPoint[]
  /** 捕获丢失时按政策取消的交互（`null` = 无）。 */
  readonly cancelInteraction: { readonly contextId: string; readonly tool: string } | null
  readonly reason: string
}

function pdec(parts: Partial<PointerRoutingDecision> & { receiverKind: PointerReceiverKind; receiver: string; reason: string }): PointerRoutingDecision {
  return Object.freeze({
    receiverKind: parts.receiverKind,
    receiver: parts.receiver,
    regionId: parts.regionId ?? null,
    intent: parts.intent ?? null,
    captureAction: parts.captureAction ?? 'none',
    preventDefault: parts.preventDefault ?? false,
    trail: Object.freeze([...(parts.trail ?? [])]),
    cancelInteraction: parts.cancelInteraction ?? null,
    reason: parts.reason,
  })
}

/** 触摸/手写笔手势的默认阻止默认行为政策（避免页面滚动/缩放手势与视口操作打架）。 */
export function isScreenPointer(fact: PointerFact): boolean {
  return fact.pointerType === 'touch' || fact.pointerType === 'pen'
}

/**
 * **指针路由**。
 *
 * 三条判据（#249 §9 §19.1）：
 *  1. **按 `pointerId`**：已被捕获的 pointer，其事件**只**交给捕获归属者 ——
 *     即使它此刻物理上在别的 Area 上（这正是"捕获"的语义）。
 *  2. **捕获丢失按政策取消**：`kind === 'capture-lost'` 时释放归属，
 *     并给出 `cancelInteraction`（若该 pointer 启动过交互）。**不**静默继续。
 *  3. **down/up/cancel 不合并、轨迹不丢点**：`trail` 原样透传，
 *     `down` 才可能 `captureAction: 'capture'`。
 */
export function routePointer(
  state: InputRoutingState,
  fact: PointerFact,
): { readonly state: InputRoutingState; readonly decision: PointerRoutingDecision } {
  const owner = Object.prototype.hasOwnProperty.call(state.pointerCaptures, fact.pointerId)
    ? state.pointerCaptures[fact.pointerId]
    : undefined

  // ── 捕获丢失：释放归属；政策 = 取消该 pointer 启动过的交互 ──
  if (fact.kind === 'capture-lost' || (owner !== undefined && fact.captured === false && fact.kind === 'up')) {
    const captures = { ...state.pointerCaptures }
    delete captures[fact.pointerId]
    const next = createRoutingState(state, { pointerCaptures: Object.freeze(captures) })
    if (owner === undefined) {
      // 丢的是一个我们从未持有的 pointer：如实报告，不伪造取消
      return {
        state: next,
        decision: pdec({ receiverKind: 'none', receiver: 'none', reason: 'capture-lost-not-owned' }),
      }
    }
    return {
      state: next,
      decision: pdec({
        receiverKind: 'none',
        receiver: `capture:${owner.regionId}`,
        regionId: owner.regionId,
        // 丢失按政策取消（#249 A22「丢失按政策取消」），不是"继续用最后坐标"
        cancelInteraction: owner.startedModal ? { contextId: owner.contextId, tool: owner.tool } : null,
        reason: 'capture-lost-cancel',
      }),
    }
  }

  // ── 已被捕获：只交给归属者（不看键盘优先级、不看命中 Area） ──
  if (owner !== undefined) {
    const isEnd = fact.kind === 'up' || fact.kind === 'cancel'
    return {
      state,
      decision: pdec({
        receiverKind: 'captured-owner',
        receiver: `pointer:${fact.pointerId}@${owner.regionId}`,
        regionId: owner.regionId,
        trail: fact.trail,
        captureAction: isEnd ? 'release' : 'none',
        preventDefault: isScreenPointer(fact),
        reason: 'captured-pointer-single-route',
      }),
    }
  }

  // ── 未捕获 ──
  if (state.modal.open && state.modal.blocksBackground) {
    const scope = state.modal.scopeId ?? 'anonymous'
    // 命中**当前模态自身** DOM ⇒ 它是普通 DOM：不吞默认行为、不产生区域意图。
    // 否则原生 select 下拉 / 文本框焦点 / checkbox 勾选全部失效（按钮只因走 click 幸免）。
    if (fact.hitModalScopeId !== null && fact.hitModalScopeId === state.modal.scopeId) {
      return {
        state,
        decision: pdec({ receiverKind: 'modal', receiver: `modal:${scope}`, preventDefault: false, reason: 'modal-interior-passthrough' }),
      }
    }
    return {
      state,
      decision: pdec({ receiverKind: 'modal', receiver: `modal:${scope}`, preventDefault: true, reason: 'modal-blocks-pointer' }),
    }
  }

  if (fact.kind === 'wheel') {
    return {
      state,
      decision: pdec({
        receiverKind: fact.hitRegionId ? 'region' : 'none',
        receiver: fact.hitRegionId ? `area:${fact.hitRegionId}` : 'none',
        regionId: fact.hitRegionId,
        trail: fact.trail,
        preventDefault: true,
        reason: 'wheel-to-region',
      }),
    }
  }

  if (fact.kind === 'move' || fact.kind === 'enter' || fact.kind === 'leave') {
    return {
      state,
      decision: pdec({
        receiverKind: fact.hitRegionId ? 'region' : 'none',
        receiver: fact.hitRegionId ? `area:${fact.hitRegionId}` : 'none',
        regionId: fact.hitRegionId,
        trail: fact.trail,
        preventDefault: isScreenPointer(fact) && fact.buttons !== 0,
        reason: 'hover-to-region',
      }),
    }
  }

  // down / up / cancel
  const regionId = fact.hitRegionId
  const intent: CommandIntent | null =
    fact.kind === 'down' && fact.button === 0
      ? { commandId: 'pointer.down', params: { regionId: regionId ?? '', button: fact.button, pointerType: fact.pointerType } }
      : fact.kind === 'up'
        ? { commandId: 'pointer.up', params: { regionId: regionId ?? '', button: fact.button, pointerType: fact.pointerType } }
        : fact.kind === 'cancel'
          ? { commandId: 'pointer.cancel', params: { regionId: regionId ?? '', pointerId: fact.pointerId } }
          : null

  return {
    state,
    decision: pdec({
      receiverKind: regionId ? 'region' : 'none',
      receiver: regionId ? `area:${regionId}` : 'none',
      regionId,
      intent,
      // 只有 down 才申请捕获；up/cancel 释放（平台同步动作由适配器执行）
      captureAction: fact.kind === 'down' && fact.button === 1 ? 'capture' : fact.kind === 'up' || fact.kind === 'cancel' ? 'release' : 'none',
      preventDefault: fact.button === 1 || isScreenPointer(fact),
      trail: fact.trail,
      reason: `pointer-${fact.kind}`,
    }),
  }
}

/**
 * 登记指针捕获归属（由适配器在 `setPointerCapture` 成功后调用）。
 *
 * `startedModal` 由调用方从该 pointer 的路由判定传入 —— 它决定捕获丢失时**是否**要取消交互
 * （只有启动过模态操作/交互的 pointer 丢失才需要取消，纯悬停无需）。
 */
export function bindPointerCapture(
  state: InputRoutingState,
  input: { pointerId: number; regionId: string; contextId: string; tool: string; startedModal: boolean },
): InputRoutingState {
  const captures = {
    ...state.pointerCaptures,
    [input.pointerId]: Object.freeze({
      pointerId: input.pointerId,
      regionId: input.regionId,
      contextId: input.contextId,
      tool: input.tool,
      startedModal: input.startedModal,
    }),
  }
  return createRoutingState(state, { pointerCaptures: Object.freeze(captures) })
}

/** 显式解除捕获归属（`up` 后适配器已 `releasePointerCapture`）。 */
export function releasePointerCapture(state: InputRoutingState, pointerId: number): InputRoutingState {
  if (!Object.prototype.hasOwnProperty.call(state.pointerCaptures, pointerId)) return state
  const captures = { ...state.pointerCaptures }
  delete captures[pointerId]
  return createRoutingState(state, { pointerCaptures: Object.freeze(captures) })
}

// ─────────────────────────────────────────────────────────────────────────────
// 页面挂起 / 恢复（#249 §9；A22「恢复不爆发历史 tick」）
// ─────────────────────────────────────────────────────────────────────────────

export interface VisibilityChangeInput {
  readonly hidden: boolean
  /** 当前逻辑时刻（毫秒；由**适配器注入**，不读全局时钟）。 */
  readonly now: number
  /** 上一次 tick 的时刻（毫秒）。 */
  readonly lastTickAt: number
  /** tick 间隔（毫秒）。 */
  readonly tickInterval: number
}

export interface VisibilityChangeResult {
  readonly state: InputRoutingState
  /** 恢复时应当采用的**新基线**（`null` = 不恢复）。 */
  readonly resumeBaseline: number | null
  /**
   * 本次挂起期间"本来会跑"的 tick 数 —— **如实报告但不追赶**
   * （#249 §9「恢复不追赶不可见的所有帧」）。
   */
  readonly droppedTicks: number
}

/**
 * 页面可见性变化。
 *
 * 政策（#249 §9 明文）：「交互式动画在页面挂起时暂停，恢复**不追赶**不可见的所有帧」。
 * ⇒ 恢复时给出一条**基线**（`resumeBaseline = now`），由 runtime 的时钟接线据此重置，
 * 而不是把 `elapsed / interval` 个 tick 一次补上。
 *
 * `droppedTicks` 是**诊断/证据**字段：A22 的断言正是"恢复了但 droppedTicks > 0"，
 * 用它证明"确实挂起过，且确实没追赶"——若把它当成待补的 tick 数去跑，断言会立刻判红。
 */
export function applyVisibilityChange(state: InputRoutingState, input: VisibilityChangeInput): VisibilityChangeResult {
  if (input.hidden) {
    if (state.suspension.suspended) return { state, resumeBaseline: null, droppedTicks: state.suspension.droppedTicks }
    return {
      state: createRoutingState(state, {
        suspension: Object.freeze({ suspended: true, suspendedAt: input.now, droppedTicks: 0 }),
      }),
      resumeBaseline: null,
      droppedTicks: 0,
    }
  }
  if (!state.suspension.suspended) return { state, resumeBaseline: null, droppedTicks: 0 }
  const interval = input.tickInterval > 0 ? input.tickInterval : 1
  const elapsed = Math.max(0, input.now - state.suspension.suspendedAt)
  const dropped = Math.floor(elapsed / interval)
  return {
    state: createRoutingState(state, {
      suspension: Object.freeze({ suspended: false, suspendedAt: 0, droppedTicks: dropped }),
    }),
    // 基线 = 现在。**不**返回"应补的 tick 列表"——那正是"爆发历史 tick"。
    resumeBaseline: input.now,
    droppedTicks: dropped,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 状态转移（接线层用；全部纯）
// ─────────────────────────────────────────────────────────────────────────────

export function withModal(state: InputRoutingState, modal: ModalScopeState): InputRoutingState {
  return createRoutingState(state, { modal })
}

/**
 * 打开一个作用域（**压栈**）。
 *
 * 若同 id 的作用域已在栈里，先移除再压顶 —— 语义是"把它提到最前"，
 * 而不是重复登记（避免同一弹窗重开后栈里留两份）。
 */
export function pushModalScope(state: InputRoutingState, modal: ModalScopeState): InputRoutingState {
  const without = state.modalStack.filter((m) => m.scopeId !== modal.scopeId)
  const stack = Object.freeze([...without, modal])
  return createRoutingState(state, { modalStack: stack, modal })
}

/**
 * 关闭一个作用域（**出栈**）。
 *
 * `scopeId` 必须在栈里，否则状态不变（返回 `null` 表示"不是我们开的"，
 * 调用方据此报告而不是静默改状态）。关掉**非栈顶**的作用域时，
 * 栈顶保持不变（内层仍在前台），只是那一层被移除。
 */
export function popModalScope(
  state: InputRoutingState,
  scopeId: string,
): { readonly state: InputRoutingState; readonly removed: boolean } | null {
  const idx = state.modalStack.findIndex((m) => m.scopeId === scopeId)
  if (idx < 0) return null
  const stack = Object.freeze(state.modalStack.filter((_, i) => i !== idx))
  const top = stack.length > 0 ? stack[stack.length - 1]! : NO_MODAL
  return { state: createRoutingState(state, { modalStack: stack, modal: top }), removed: true }
}

export function modalOpened(input: {
  scopeId: string
  blocksBackground?: boolean
  confirmOnEnter?: boolean
  textControlIds?: readonly string[]
  focusId?: string | null
}): ModalScopeState {
  return Object.freeze({
    open: true,
    scopeId: input.scopeId,
    focusId: input.focusId ?? null,
    blocksBackground: input.blocksBackground ?? true,
    confirmOnEnter: input.confirmOnEnter ?? false,
    textControlIds: Object.freeze([...(input.textControlIds ?? [])]),
  })
}

export const MODAL_CLOSED: ModalScopeState = NO_MODAL

export function withTextFocus(state: InputRoutingState, textFocus: TextFocusState): InputRoutingState {
  return createRoutingState(state, { textFocus })
}

export function withInteraction(state: InputRoutingState, interaction: ActiveInteractionState | null): InputRoutingState {
  return createRoutingState(state, { interaction })
}

export function withActiveRegion(state: InputRoutingState, regionId: string | null): InputRoutingState {
  return createRoutingState(state, { activeRegionId: regionId })
}

export function withHotkeys(state: InputRoutingState, areaHotkeys: readonly HotkeyBinding[], appHotkeys: readonly HotkeyBinding[]): InputRoutingState {
  return createRoutingState(state, {
    areaHotkeys: Object.freeze([...areaHotkeys]),
    appHotkeys: Object.freeze([...appHotkeys]),
  })
}
