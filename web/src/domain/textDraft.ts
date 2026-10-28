/**
 * `domain/textDraft` —— 文本控件的**显示值 / 编辑草稿 / 可提交值**三态机
 * （纯函数口径）。
 *
 * ## 本模块替代的旧机制
 *
 * 旧实现里"文本输入"分散在各面板的 `v-model` + 手写 debounce：
 * `TooltipEditorPanel.vue` 自己 `setTimeout(300)` 后调 operator、
 * `AnnotationEditorPanel.vue` 自己 `Proxy set` 直接 `patchProperty`、
 * `RNAWidget.vue` 每个 `@input` 立刻 `setValue` 落库。它们的共同形态是
 * **"输入字符 = 一次领域写"**，于是：
 *  - 输入 `-`（只有负号）时把 `NaN` 写进文档；
 *  - IME 组合期间每敲一个拼音字母就写一次；
 *  - 输入框里 Ctrl+Z 同时触发文档撤销（两条历史互相打架）；
 *  - 非法值被静默夹取或静默丢弃。
 *
 * 本模块把三样东西分开：
 *
 * | 值 | 含义 | 谁读 |
 * |---|---|---|
 * | **显示值** `displayValue` | 文档里的当前值，控件打开时的初值 | 呈现 |
 * | **编辑草稿** `text` | 用户正在输入、**尚未承诺**的文本 | 输入法/键盘 |
 * | **可提交值** `parse` | 草稿经纯解析得到的 `完整 / 中间态 / 非法` | 提交决策 |
 *
 * ## 三条硬要求与落点
 *
 * 1. **IME 组合未结束不提交场景操作**：`ime.composing === true` 时 `reducer` 只更新草稿文本，
 *    `effects` 里**不可能**出现 `commit`。这是结构性保证 —— 提交只从
 *    `draftSubmitDecision()` 一个地方发出，而它要求 `!composing`。
 * 2. **Enter/Escape 不重复消费**：每个输入事件携带显式 `token`（接线层分配的单调序号）。
 *    同一 `token` 第二次进入 `reducer` 返回 `{ status: 'duplicate' }` 且 `effects` 为空。
 *    去重表在状态里（有界环形），因此**不依赖接线层的自觉**。
 * 3. **输入框活动编辑期 Ctrl+Z 作用于草稿**：`draftUndo()` 只回退 `text`
 *    （草稿历史在状态里），**不产生** `history`/`commit` 效果。文档历史只能经
 *    `application/inputCommands` 的 `edit.undo` 命令到达，而那只在
 *    **无**活动文本控件时才被路由到（见 `domain/input`）。
 *
 * ## 为什么"中间态"是合法状态而不是错误
 *
 * 「负号、小数点、空字符串、中文组合中间态**可以暂时不是合法领域值**」。
 * 把它们当错误会产生两种坏行为：要么禁止用户输入 `-1`（因为 `-` 不合法），
 * 要么在 `-` 时清空输入框。故解析结果是**三态**：
 * `complete`（可提交）/ `intermediate`（合法暂存、不可提交）/
 * `invalid`（保留草稿 + 提示、不可提交）。
 * **三者都不写文档** —— 只有 `complete` 且经提交决策才写。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 解析（纯）
// ─────────────────────────────────────────────────────────────────────────────

/** 控件声明的值形态（当前只交付数字与文本两类；其余形态由控件贡献方声明）。 */
export type DraftKind = 'number' | 'text'

/** 中间态原因（合法暂存，等用户继续输入）。 */
export type DraftIntermediateReason =
  | 'empty'
  | 'signOnly'
  | 'decimalPointOnly'
  | 'trailingDecimalPoint'
  | 'exponentIncomplete'

/** 非法原因（保留草稿并提示；**不**夹取、**不**静默转换）。 */
export type DraftInvalidReason = 'notANumber' | 'malformed' | 'notFinite' | 'outOfRange'

/**
 * 纯解析结果（「纯解析返回完整/中间态/非法及原因」）。
 *
 * `complete.value` 的类型按 `kind` 收窄：`number` ⇒ `number`，`text` ⇒ `string`。
 */
export type DraftParse =
  | { readonly status: 'complete'; readonly value: number | string }
  | { readonly status: 'intermediate'; readonly reason: DraftIntermediateReason }
  | { readonly status: 'invalid'; readonly reason: DraftInvalidReason; readonly detail?: string }

export interface DraftParseOptions {
  /** 合法域下界（含）。越界 ⇒ `invalid/outOfRange`，**不夹取**（内核契约 §4.2 明文）。 */
  readonly min?: number
  readonly max?: number
  /** 允许指数记法（`1e3`）。默认允许 —— HTML `<input type=number>` 允许。 */
  readonly allowExponent?: boolean
  /** 必填（空串 ⇒ `intermediate/empty` 而不是"合法空值"）。 */
  readonly required?: boolean
  /**
   * 文本**模式**约束（正则源串）。不匹配 ⇒ `invalid/malformed`。
   *
   * ## 为什么解析层要知道它
   *
   * 属性描述自带 `domain: { kind: 'pattern', source: '^\\S+$' }` 这类约束。
   * 若解析层对它一无所知，就会出现**两个解析器各判一次**：
   * 输入层的三态机判 `complete`（"看起来合法"），而属性自己的约束判非法。
   * 结果是界面显示"可以提交"、提交却被唯一写路由拒绝 —— 用户看到的是
   * "输入没反应"，而不是要求的"非法草稿保留并**提示**"。
   *
   * 故把模式**下传**给纯解析：判定仍只有一个来源（本函数），
   * 只是它的输入变完整了。正则只做**匹配**（不执行用户代码），
   * 非法正则按"不约束"处理（不因描述错误而卡住输入）。
   */
  readonly pattern?: string
  /** 模式不匹配时的稳定原因码（供提示与诊断）。 */
  readonly patternReason?: string
  /** 文本长度上限（`domain.kind === 'text'` 的 `maxLength`）。超限 ⇒ `invalid/malformed`。 */
  readonly maxLength?: number
}

const DECIMAL_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/

/**
 * 解析数字草稿。
 *
 * 判定顺序（**中间态优先于非法**，这是本函数的核心取舍）：
 *  - 空串/纯空白 ⇒ `intermediate/empty`（用户刚聚焦或清空，不是错误）；
 *  - `-` / `+` ⇒ `intermediate/signOnly`；
 *  - `.` / `-.` ⇒ `intermediate/decimalPointOnly`；
 *  - `1.` ⇒ `intermediate/trailingDecimalPoint`（用户正打小数位）；
 *  - `1e` / `1e-` ⇒ `intermediate/exponentIncomplete`；
 *  - 其余不匹配 `DECIMAL_RE` ⇒ `invalid/malformed`；
 *  - 匹配但 `Number.isFinite` 为假（`1e999`） ⇒ `invalid/notFinite`；
 *  - 越界 ⇒ `invalid/outOfRange`。
 */
export function parseNumberDraft(text: string, options: DraftParseOptions = {}): DraftParse {
  const trimmed = text.trim()
  if (trimmed === '') return { status: 'intermediate', reason: 'empty' }
  if (trimmed === '-' || trimmed === '+') return { status: 'intermediate', reason: 'signOnly' }
  if (trimmed === '.' || trimmed === '-.' || trimmed === '+.') {
    return { status: 'intermediate', reason: 'decimalPointOnly' }
  }
  if (trimmed.endsWith('.')) return { status: 'intermediate', reason: 'trailingDecimalPoint' }
  if (/[eE][+-]?$/.test(trimmed)) return { status: 'intermediate', reason: 'exponentIncomplete' }
  const allowExponent = options.allowExponent ?? true
  if (!allowExponent && /[eE]/.test(trimmed)) return { status: 'invalid', reason: 'malformed', detail: 'exponent' }
  if (!DECIMAL_RE.test(trimmed)) return { status: 'invalid', reason: 'malformed', detail: trimmed }
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return { status: 'invalid', reason: 'notFinite', detail: trimmed }
  if (options.min !== undefined && n < options.min) {
    return { status: 'invalid', reason: 'outOfRange', detail: `min=${options.min}` }
  }
  if (options.max !== undefined && n > options.max) {
    return { status: 'invalid', reason: 'outOfRange', detail: `max=${options.max}` }
  }
  return { status: 'complete', value: n }
}

/**
 * 解析文本草稿。
 *
 * 文本没有"非法"形态 —— 任意字符串都是合法领域值（内容转义是**呈现边界**
 * 的事，不是本函数的职责）。唯一例外是控件声明 `required` 时的空串：
 * 那是 `intermediate/empty`（还没填完），不是非法。
 */
/**
 * 解析文本草稿。
 *
 * `required` 与 `pattern` 都来自**属性描述**（下传，不在这里重复判定域）：
 *  - `required` 且空白 ⇒ `intermediate/empty`（"还没填"，不是错误）；
 *  - `pattern` 不匹配 ⇒ `invalid/malformed`（"填错了"，可提示且不提交）。
 *
 * 顺序有意如此：空串在必填时是**中间态**而不是非法态 —— 用户刚聚焦或清空
 * 不该立刻报错（与数字解析的 `empty` 同一取舍）。
 */
export function parseTextDraft(text: string, options: DraftParseOptions = {}): DraftParse {
  if (options.required === true && text.trim() === '') return { status: 'intermediate', reason: 'empty' }
  const src = options.pattern
  if (src !== undefined && src !== '') {
    let re: RegExp | null = null
    try {
      re = new RegExp(src)
    } catch {
      // 描述里的正则非法 ⇒ 按"不约束"处理：不因描述错误而卡死输入。
      re = null
    }
    if (re !== null && !re.test(text)) {
      return {
        status: 'invalid',
        reason: 'malformed',
        ...(options.patternReason === undefined ? {} : { detail: options.patternReason }),
      }
    }
  }
  if (options.maxLength !== undefined && text.length > options.maxLength) {
    return { status: 'invalid', reason: 'malformed', detail: 'tooLong' }
  }
  return { status: 'complete', value: text }
}

/** 按控件声明的形态解析。 */
export function parseDraft(kind: DraftKind, text: string, options: DraftParseOptions & { required?: boolean } = {}): DraftParse {
  return kind === 'number' ? parseNumberDraft(text, options) : parseTextDraft(text, options)
}

/** 该解析结果是否**可以**提交（`complete` 是唯一可提交态）。 */
export function isSubmittable(parse: DraftParse): parse is Extract<DraftParse, { status: 'complete' }> {
  return parse.status === 'complete'
}

// ─────────────────────────────────────────────────────────────────────────────
// 状态
// ─────────────────────────────────────────────────────────────────────────────

/** 草稿历史深度上限（Ctrl+Z 作用于草稿，不进文档历史）。 */
export const DRAFT_HISTORY_LIMIT = 64
/** 事件去重表深度上限（Enter/Escape 不重复消费）。 */
export const DEDUPE_TOKEN_LIMIT = 128

export interface TextDraftState {
  readonly controlId: string
  readonly kind: DraftKind
  /** **显示值**：控件打开时的文档值（提交被拒时回退到它）。 */
  readonly displayValue: string
  /** **编辑草稿**：用户当前输入文本（未经承诺）。 */
  readonly text: string
  /** 草稿局部撤销栈（Ctrl+Z 的目标）；**不含**文档历史。 */
  readonly textHistory: readonly string[]
  /** 草稿局部重做栈（Ctrl+Shift+Z）。 */
  readonly textFuture: readonly string[]
  /** 纯解析结果 = **可提交值**的判定输入。 */
  readonly parse: DraftParse
  /** IME 组合态。`composing === true` 时**不允许**提交。 */
  readonly composing: boolean
  /** 控件声明的提交时机（「合法草稿**按控件声明**提交」）。 */
  readonly commitOn: DraftCommitTrigger
  /** 提交时校验的域（来自控件声明；不夹取）。 */
  readonly domain: DraftParseOptions & { readonly required?: boolean }
  /** 是否处于活动编辑（获得焦点且未关闭）。 */
  readonly active: boolean
}

/**
 * 控件声明的提交时机。
 *
 * `'enter-or-blur'` 是默认：Enter 提交、失焦提交 —— 但**非法/中间态**时两者都只保留草稿。
 * `'explicit'` 表示只有显式命令提交（失焦也不提交，例如搜索框）。
 */
export type DraftCommitTrigger = 'enter-or-blur' | 'blur-only' | 'explicit'

/** 保留草稿的原因（提示用；「非法草稿保留并提示，不暗中强制转换」）。 */
export type DraftRetainReason =
  | 'focus-switch'
  | 'enter'
  | 'blur'
  | 'close'
  | 'target-invalid'
  | 'composition-active'

/** 文本层产生的效果（**描述**，由接线层执行；本模块不写文档）。 */
export type TextDraftEffect =
  | {
      readonly kind: 'commit'
      readonly controlId: string
      readonly value: number | string
      /** 恒为 `'single'`：领域提交只有**一次**事务边界。 */
      readonly transaction: 'single'
    }
  | { readonly kind: 'cancel'; readonly controlId: string }
  | { readonly kind: 'retain'; readonly controlId: string; readonly reason: DraftRetainReason }
  | {
      readonly kind: 'notice'
      readonly controlId: string
      readonly code: 'draftInvalid' | 'draftIncomplete' | 'draftRetained'
      readonly params: Readonly<Record<string, string | number>>
    }
  | { readonly kind: 'draftChanged'; readonly controlId: string; readonly text: string }

/** 文本层状态（所有控件 + 焦点 + 去重表）。 */
export interface TextLayerState {
  readonly controls: Readonly<Record<string, TextDraftState>>
  /** 当前获得焦点的文本控件（`null` = 无 —— 此时按键才可能落到场景快捷键）。 */
  readonly focusedControlId: string | null
  /** 已消费的事件 token（有界）。 */
  readonly consumedTokens: readonly number[]
}

export type TextLayerResult =
  | { readonly status: 'applied'; readonly state: TextLayerState; readonly effects: readonly TextDraftEffect[] }
  /** 同一 token 二次进入 ⇒ 空效果（Enter/Escape 不重复消费的结构性保证）。 */
  | { readonly status: 'duplicate'; readonly state: TextLayerState; readonly effects: readonly [] }

export function createTextLayerState(): TextLayerState {
  return Object.freeze({ controls: Object.freeze({}), focusedControlId: null, consumedTokens: Object.freeze([]) })
}

function applied(state: TextLayerState, effects: readonly TextDraftEffect[]): TextLayerResult {
  return Object.freeze({ status: 'applied', state, effects: Object.freeze([...effects]) })
}

/** token 是否已消费；`0` 表示"不参与去重"（供纯内部推进使用）。 */
function tokenConsumed(state: TextLayerState, token: number): boolean {
  return token !== 0 && state.consumedTokens.includes(token)
}

/** 记录 token（有界环形：超出上限丢最旧的）。 */
function consumeToken(state: TextLayerState, token: number): TextLayerState {
  if (token === 0) return state
  if (state.consumedTokens.includes(token)) return state
  const next = [...state.consumedTokens, token]
  const bounded = next.length > DEDUPE_TOKEN_LIMIT ? next.slice(next.length - DEDUPE_TOKEN_LIMIT) : next
  return Object.freeze({ ...state, consumedTokens: Object.freeze(bounded) })
}

function withControl(state: TextLayerState, control: TextDraftState): TextLayerState {
  return Object.freeze({ ...state, controls: Object.freeze({ ...state.controls, [control.controlId]: control }) })
}

function controlOf(state: TextLayerState, controlId: string): TextDraftState | undefined {
  return Object.prototype.hasOwnProperty.call(state.controls, controlId) ? state.controls[controlId] : undefined
}

/** 草稿是否"有未提交的改动且可提交"。 */
export function draftIsSubmittable(control: TextDraftState): boolean {
  return control.active && !control.composing && isSubmittable(control.parse) && control.text !== control.displayValue
}

// ─────────────────────────────────────────────────────────────────────────────
// 注册 / 焦点
// ─────────────────────────────────────────────────────────────────────────────

export interface RegisterControlInput {
  readonly controlId: string
  readonly kind: DraftKind
  readonly displayValue: string
  readonly commitOn?: DraftCommitTrigger
  readonly min?: number
  readonly max?: number
  readonly required?: boolean
  readonly allowExponent?: boolean
  /** 文本模式约束（属性描述下传；见 `DraftParseOptions.pattern`）。 */
  readonly pattern?: string
  /** 模式不匹配时的稳定原因码。 */
  readonly patternReason?: string
  /** 文本长度上限（属性描述下传）。 */
  readonly maxLength?: number
}

/**
 * 聚焦一个文本控件（打开编辑会话）。
 *
 * 焦点切换的**提交/保留**政策在 `focusControl` 内部一次完成
 * （「切换焦点时，完整合法草稿按控件声明提交；非法草稿保留并提示」）：
 *  - 原有控件若是 `complete` 且 `commitOn` 允许失焦提交 ⇒ 产出 `commit`；
 *  - 原有控件若是 `intermediate`/`invalid` ⇒ 产出 `retain` + `notice`，**草稿文本留在状态里**。
 */
export function focusControl(state: TextLayerState, input: RegisterControlInput, token = 0): TextLayerResult {
  if (tokenConsumed(state, token)) return { status: 'duplicate', state, effects: [] }
  let cur = consumeToken(state, token)
  const effects: TextDraftEffect[] = []

  const previous = cur.focusedControlId === null ? undefined : controlOf(cur, cur.focusedControlId)
  if (previous && previous.controlId !== input.controlId) {
    const r = settleControl(previous, 'focus-switch')
    cur = withControl(cur, afterSettle(previous, r))
    effects.push(...r.effects)
  }

  const existing = controlOf(cur, input.controlId)
  /**
   * 重新登记一个**没有挂起草稿**的控件时，草稿种子必须换成**刚读到的文档值**。
   *
   * `displayValue` 每次登记都按 DOM 事实刷新（下面那行），而 `text` 原先一律沿用
   * `existing.text`。若该控件上次留下的 `text` 已不再是挂起的草稿（`text === 它自己的`
   * `displayValue`），两者就会错配：`text` 是旧的文档值、`displayValue` 是新的
   * ⇒ 失焦时以旧值提交，把别处（同一底层值的另一个字段）刚写的新值改回去。
   *
   * 保留 draft 的情形必须原样保住：非法/中间态草稿 `text !== displayValue`
   * —— 那正是「非法草稿保留并提示、切换焦点不丢字」的落点。
   */
  const cleanExisting = existing !== undefined && existing.text === existing.displayValue
  const seed = existing === undefined || cleanExisting ? input.displayValue : existing.text
  const parse = parseDraft(input.kind, seed, {
    ...(input.min === undefined ? {} : { min: input.min }),
    ...(input.max === undefined ? {} : { max: input.max }),
    ...(input.required === undefined ? {} : { required: input.required }),
    ...(input.allowExponent === undefined ? {} : { allowExponent: input.allowExponent }),
    ...(input.pattern === undefined ? {} : { pattern: input.pattern }),
    ...(input.patternReason === undefined ? {} : { patternReason: input.patternReason }),
    ...(input.maxLength === undefined ? {} : { maxLength: input.maxLength }),
  })
  const control: TextDraftState = Object.freeze({
    controlId: input.controlId,
    kind: input.kind,
    displayValue: input.displayValue,
    text: seed,
    textHistory: cleanExisting ? Object.freeze([]) : (existing?.textHistory ?? Object.freeze([])),
    textFuture: cleanExisting ? Object.freeze([]) : (existing?.textFuture ?? Object.freeze([])),
    parse,
    composing: false,
    commitOn: input.commitOn ?? 'enter-or-blur',
    domain: Object.freeze({
      ...(input.min === undefined ? {} : { min: input.min }),
      ...(input.max === undefined ? {} : { max: input.max }),
      ...(input.required === undefined ? {} : { required: input.required }),
      ...(input.allowExponent === undefined ? {} : { allowExponent: input.allowExponent }),
      ...(input.pattern === undefined ? {} : { pattern: input.pattern }),
      ...(input.patternReason === undefined ? {} : { patternReason: input.patternReason }),
      ...(input.maxLength === undefined ? {} : { maxLength: input.maxLength }),
    }),
    active: true,
  })
  cur = withControl(cur, control)
  cur = Object.freeze({ ...cur, focusedControlId: input.controlId })
  return applied(cur, effects)
}

/**
 * 结算一个控件：可提交则提交，否则保留 + 提示。
 *
 * **唯一**产生 `commit` 效果的地方（连同 `settleControl` 的调用者）。
 * `composing === true` 时一律**不提交**（IME 组合未结束）—— 这是硬门。
 */
function settleControl(control: TextDraftState, reason: DraftRetainReason): { control: TextDraftState; effects: TextDraftEffect[] } {
  const effects: TextDraftEffect[] = []
  if (control.composing) {
    effects.push({ kind: 'retain', controlId: control.controlId, reason: 'composition-active' })
    effects.push({ kind: 'notice', controlId: control.controlId, code: 'draftRetained', params: { reason: 'composition-active' } })
    return { control, effects }
  }
  if (isSubmittable(control.parse)) {
    if (control.text === control.displayValue) {
      // 无变化：不算一次提交（不产生幽灵事务）
      return { control, effects }
    }
    effects.push({ kind: 'commit', controlId: control.controlId, value: control.parse.value, transaction: 'single' })
    return { control, effects }
  }
  // 中间态/非法：**保留草稿**并提示（不暗中强制转换、不静默丢弃）
  effects.push({ kind: 'retain', controlId: control.controlId, reason })
  effects.push({
    kind: 'notice',
    controlId: control.controlId,
    code: control.parse.status === 'invalid' ? 'draftInvalid' : 'draftIncomplete',
    params: Object.freeze({
      reason: control.parse.reason,
      ...(control.parse.status === 'invalid' && control.parse.detail !== undefined ? { detail: control.parse.detail } : {}),
    }),
  })
  return { control, effects }
}

/**
 * 失焦（含焦点切换、控件关闭、目标失效）。
 *
 * `reason === 'close' | 'target-invalid'` 时**不提交**：控件没了/目标没了，
 * 提交没有落点（「控件关闭/目标失效时取消其交互」）。
 * 此时草稿被取消（`cancel` 效果）而不是保留 —— 保留一份无法呈现的草稿没有意义。
 */
export function blurControl(state: TextLayerState, controlId: string, reason: DraftRetainReason, token = 0): TextLayerResult {
  if (tokenConsumed(state, token)) return { status: 'duplicate', state, effects: [] }
  let cur = consumeToken(state, token)
  const control = controlOf(cur, controlId)
  if (!control) return applied(cur, [])

  const effects: TextDraftEffect[] = []
  if (reason === 'close' || reason === 'target-invalid') {
    if (control.text !== control.displayValue || control.composing) {
      effects.push({ kind: 'cancel', controlId })
    }
    const cleared: TextDraftState = Object.freeze({
      ...control,
      active: false,
      composing: false,
      text: control.displayValue,
      textHistory: Object.freeze([]),
      textFuture: Object.freeze([]),
    })
    cur = withControl(cur, cleared)
  } else if (control.commitOn === 'explicit' && reason === 'blur') {
    effects.push({ kind: 'retain', controlId, reason })
  } else {
    const r = settleControl(control, reason)
    // 提交成功 ⇒ 草稿与显示值一起对齐（见 `afterSettle`）；保留/非法 ⇒ 只清活动态。
    const next =
      r.effects.some((e) => e.kind === 'commit')
        ? Object.freeze({ ...afterSettle(control, r), active: false })
        : Object.freeze({ ...r.control, active: false })
    cur = withControl(cur, next)
    effects.push(...r.effects)
  }
  if (cur.focusedControlId === controlId) cur = Object.freeze({ ...cur, focusedControlId: null })
  return applied(cur, effects)
}

// ─────────────────────────────────────────────────────────────────────────────
// 输入 / IME / 键
// ─────────────────────────────────────────────────────────────────────────────

function reparse(control: TextDraftState, text: string): DraftParse {
  return parseDraft(control.kind, text, control.domain)
}

/** 更新草稿文本（不提交）。`pushHistory` 控制是否记入草稿历史（Ctrl+Z 的目标）。 */
function withText(control: TextDraftState, text: string, pushHistory: boolean): TextDraftState {
  const history = pushHistory && text !== control.text
    ? Object.freeze([...control.textHistory, control.text].slice(-DRAFT_HISTORY_LIMIT))
    : control.textHistory
  // 新的输入清空重做栈（与通用编辑器语义一致）；纯展示性更新（pushHistory=false）不动它。
  const future = pushHistory && text !== control.text ? Object.freeze([]) : control.textFuture
  return Object.freeze({ ...control, text, textHistory: history, textFuture: future, parse: reparse(control, text) })
}

/** 普通输入（`input` 事件 / 键盘可打印字符）。**不提交**。 */
export function applyDraftInput(state: TextLayerState, controlId: string, text: string, token = 0): TextLayerResult {
  if (tokenConsumed(state, token)) return { status: 'duplicate', state, effects: [] }
  let cur = consumeToken(state, token)
  const control = controlOf(cur, controlId)
  if (!control) return applied(cur, [])
  const next = withText(control, text, true)
  cur = withControl(cur, next)
  return applied(cur, [{ kind: 'draftChanged', controlId, text }])
}

/** IME 组合开始。组合期间**不提交**（`composing` 置位）。 */
export function applyCompositionStart(state: TextLayerState, controlId: string, token = 0): TextLayerResult {
  if (tokenConsumed(state, token)) return { status: 'duplicate', state, effects: [] }
  let cur = consumeToken(state, token)
  const control = controlOf(cur, controlId)
  if (!control) return applied(cur, [])
  cur = withControl(cur, Object.freeze({ ...control, composing: true }))
  return applied(cur, [])
}

/**
 * IME 组合更新：**只**改草稿文本。
 *
 * 这里刻意**不**产出 `commit`，也不产出 `notice` —— 组合中间态是合法暂存，
 * 提示会打扰输入。负对照「忽略 composition 状态」的判红点就在这条：
 * 若实现让组合期间的字母触发场景快捷键或提交，本函数的效果序列会与实际不符。
 */
export function applyCompositionUpdate(state: TextLayerState, controlId: string, text: string, token = 0): TextLayerResult {
  if (tokenConsumed(state, token)) return { status: 'duplicate', state, effects: [] }
  let cur = consumeToken(state, token)
  const control = controlOf(cur, controlId)
  if (!control) return applied(cur, [])
  cur = withControl(cur, withText(control, text, false))
  return applied(cur, [{ kind: 'draftChanged', controlId, text }])
}

/**
 * IME 组合结束（`compositionend`）。
 *
 * 提交由随后的 `input`/`Enter`/失焦决定，**不在** `compositionend` 里直接提交 ——
 * 因为浏览器在 `compositionend` 之后还会派发一次 `input`，两处都提交就会**双重消费**
 * （负对照之一）。此处只解除 `composing`。
 */
export function applyCompositionEnd(state: TextLayerState, controlId: string, text: string, token = 0): TextLayerResult {
  if (tokenConsumed(state, token)) return { status: 'duplicate', state, effects: [] }
  let cur = consumeToken(state, token)
  const control = controlOf(cur, controlId)
  if (!control) return applied(cur, [])
  const next = Object.freeze({ ...withText(control, text, true), composing: false })
  cur = withControl(cur, next)
  return applied(cur, [{ kind: 'draftChanged', controlId, text }])
}

/**
 * 草稿局部撤销（Ctrl+Z 在活动文本编辑期）。
 *
 * **只见草稿**：返回新状态与空效果中的 `draftChanged`，绝不产生文档历史效果。
 * 负对照「文本局部撤销误撤文档」的判红点 = 若此函数产出 `commit`/历史效果，断言失败。
 */
export function draftUndo(state: TextLayerState, controlId: string): TextLayerResult {
  const control = controlOf(state, controlId)
  if (!control || control.textHistory.length === 0) return applied(state, [])
  const history = control.textHistory.slice(0, -1)
  const previous = control.textHistory[control.textHistory.length - 1] ?? ''
  const next = Object.freeze({
    ...withText(control, previous, false),
    textHistory: Object.freeze(history),
    textFuture: Object.freeze([...control.textFuture, control.text].slice(-DRAFT_HISTORY_LIMIT)),
  })
  return applied(withControl(state, next), [{ kind: 'draftChanged', controlId, text: previous }])
}

/**
 * 草稿局部重做（Ctrl+Shift+Z 在活动文本编辑期）——对称能力，同样**只见草稿**。
 *
 * 与 `draftUndo` 成对存在：只提供撤销会让"文本局部历史"变成一个半成品
 * （用户撤销后无法恢复），而这两个函数都不接触文档历史。
 */
export function draftRedo(state: TextLayerState, controlId: string): TextLayerResult {
  const control = controlOf(state, controlId)
  if (!control || control.textFuture.length === 0) return applied(state, [])
  const future = control.textFuture.slice(0, -1)
  const nextText = control.textFuture[control.textFuture.length - 1] ?? control.text
  const next = Object.freeze({
    ...withText(control, nextText, false),
    textHistory: Object.freeze([...control.textHistory, control.text].slice(-DRAFT_HISTORY_LIMIT)),
    textFuture: Object.freeze(future),
  })
  return applied(withControl(state, next), [{ kind: 'draftChanged', controlId, text: nextText }])
}

/** 活动文本编辑期可用的键（由 `domain/input` 路由，本模块只执行语义）。 */
export type DraftKey = 'Enter' | 'Escape' | 'Tab' | 'Ctrl+Z' | 'Ctrl+Shift+Z'

/**
 * 文本层处理一个键。
 *
 * | 键 | 行为 |
 * |---|---|
 * | `Enter` | 按控件声明提交（`explicit` 声明除外）；`composing` 期间**不提交**（IME 确认键） |
 * | `Escape` | 取消草稿（回到显示值），**不提交** |
 * | `Tab` | 等同焦点切换的结算（提交或保留），由接线层随后移动焦点 |
 * | `Ctrl+Z` | 草稿局部撤销（**不**触发文档历史） |
 */
/**
 * 结算结果 → 控件状态：**提交成功后，草稿与显示值必须一起对齐到已提交值**。
 *
 * ## 为什么必须有一个统一的"提交后对齐"（运行期实测的静默回退）
 *
 * `settleControl` 只产出 `commit` **效果**，它**不动状态**（`text` 仍是用户刚敲的
 * 那一串、`displayValue` 仍是提交前的文档值）。于是调用方若不同步这两者，控件在
 * 状态里就永远"挂着一份未提交草稿"。
 *
 * 这个不一致单独看无害（下一次结算会再提交一次同样的值 ⇒ 内核按 `unchanged` 吸收），
 * 但**换焦点**时会兑现成一次真实写入：
 *
 * ```
 * ① 编辑字段 A 并提交（Tab）      → A 的状态：text = 新值, displayValue = 旧值  ← 未对齐
 * ② 焦点落到字段 B（与 A 写同一格）
 * ③ 再回到 A 编辑并提交            → A 对齐
 * ④ B 失焦：B 的状态是上次登记时留下的 text（旧值），
 *    而 focusControl 每次登记都会把 displayValue 刷成**刚读到的**文档值
 *    ⇒ text ≠ displayValue ⇒ settleControl 认为"有一份待提交草稿"
 *    ⇒ **提交旧值，把 A 刚写的新值悄悄改回去**
 * ```
 *
 * 实测（真实信封）：连续两次编辑同一格的
 * Tooltip 后，第三次历史条目来自 `field:lightning.block.cellTooltip`、
 * 值为**第一次**编辑的文本 —— 文档被回退，`canUndo` 也跟着失真。
 * （该缺陷此前被"读面漏行翻转"掩盖：镜像读让 B 的值恒定不变，text 与
 * displayValue 恰好总是相等。修好读面后它才现形。）
 *
 * 判据用**效果**而不是再算一次 `isSubmittable`：`settleControl` 只在
 * "可提交**且**与显示值不同"时产出 `commit` ⇒ "有 commit 效果"就是
 * "这一份草稿已经进文档"的准确标记。非法/中间态（`retain`）**不动**
 * —— 那正是「非法草稿保留并提示」要保留的东西。
 */
function afterSettle(
  control: TextDraftState,
  settled: { readonly control: TextDraftState; readonly effects: readonly TextDraftEffect[] },
): TextDraftState {
  if (!settled.effects.some((e) => e.kind === 'commit')) return settled.control
  // `commit` 蕴含可提交 ⇒ 正常路径必取 `.value`；`isSubmittable` 只用于收窄类型
  // （并作防御：不可提交却出现 commit 效果时**不动**状态，而不是造一个假值）。
  if (!isSubmittable(control.parse)) return settled.control
  const committed = String(control.parse.value)
  return Object.freeze({
    ...settled.control,
    displayValue: committed,
    text: committed,
    textHistory: Object.freeze([]),
    textFuture: Object.freeze([]),
  })
}

export function applyDraftKey(state: TextLayerState, controlId: string, key: DraftKey, token = 0): TextLayerResult {
  if (tokenConsumed(state, token)) return { status: 'duplicate', state, effects: [] }
  let cur = consumeToken(state, token)
  const control = controlOf(cur, controlId)
  if (!control) return applied(cur, [])

  switch (key) {
    case 'Ctrl+Z':
      return draftUndo(cur, controlId)
    case 'Ctrl+Shift+Z':
      return draftRedo(cur, controlId)
    case 'Escape': {
      // Escape **取消**草稿：回到显示值，不提交
      const next = Object.freeze({
        ...control,
        text: control.displayValue,
        textHistory: Object.freeze([]),
        composing: false,
        parse: reparse(control, control.displayValue),
      })
      return applied(withControl(cur, next), [{ kind: 'cancel', controlId }])
    }
    case 'Enter': {
      if (control.composing) {
        // IME 的确认 Enter：只结束组合，**不**提交（否则会双重消费）
        return applied(withControl(cur, Object.freeze({ ...control, composing: false })), [])
      }
      if (control.commitOn === 'explicit') return applied(cur, [])
      const r = settleControl(control, 'enter')
      return applied(withControl(cur, afterSettle(control, r)), r.effects)
    }
    case 'Tab': {
      if (control.commitOn === 'explicit') return applied(cur, [{ kind: 'retain', controlId, reason: 'focus-switch' }])
      const r = settleControl(control, 'focus-switch')
      // ⚠️ 这里曾经**不同步**（与 Enter/失焦两条路径不一致）⇒ 换焦点后控件在状态里
      // 仍挂着已提交的文本，再失焦就会以旧文本再提交一次。见 `afterSettle` 的实测说明。
      return applied(withControl(cur, afterSettle(control, r)), r.effects)
    }
  }
}

/** 只读投影：某控件的三态（供呈现与诊断读取，不暴露可变结构）。 */
export function draftProjection(control: TextDraftState): {
  readonly controlId: string
  readonly displayValue: string
  readonly draft: string
  readonly submittable: number | string | null
  readonly status: DraftParse['status']
  readonly reason: string | null
  readonly composing: boolean
  /**
   * 是否处于**活动编辑**（获得焦点且未关闭）。
   *
   * ⚠️ 呈现端必须用它区分「正在编辑的草稿」与「结算后仍留在会话里的文本」：
   * `draft`（= `text`）在提交**之后**仍等于已提交值，若呈现端无条件以它优先，
   * 那么外部内容变化（撤销/重做、换格、换文档）时那份留存文本会盖住权威读面
   * —— 实测：Ctrl+Z 已把文档改回旧值（`data-input-display` 同步回退），
   * 输入框里却仍显示新值，即"画面不更新"。
   */
  readonly active: boolean
} {
  return Object.freeze({
    controlId: control.controlId,
    displayValue: control.displayValue,
    draft: control.text,
    submittable: isSubmittable(control.parse) ? control.parse.value : null,
    status: control.parse.status,
    reason: control.parse.status === 'complete' ? null : control.parse.reason,
    composing: control.composing,
    active: control.active,
  })
}
