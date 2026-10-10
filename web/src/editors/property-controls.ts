/**
 * #253 P2 · `editors/property-controls` —— **基础控件模型与交互暂存政策**（纯逻辑）。
 *
 * 依据：#249 §6（「UI 提示与语义约束分离…不能把逗号字符串作为核心类型」、
 * 「RNA 不导入组件名；控件注册和面板布局由 editors/composition 贡献」）、
 * §19.1（显示值 / 编辑草稿 / 可提交值分离；Enter/Escape 不重复消费；非法中间草稿不写文档）、
 * §19.7（翻译键与单位）；#253 D1.1/D1.2/D1.4/D1.5/D1.6/D2.1 的界面需求清单
 * （输入来自 #251 B7 `1253e9b-inspector-operation-samples.md`）。
 *
 * ## 为什么「控件名」可以出现在这里、但不可以出现在 RNA 描述里
 *
 * RNA 描述（`application/properties.ts` 的 `PropertyDecl`）里**不得**出现控件类型名 ——
 * 那会让「换控件」必须改核心，且把 UI 决策钉进属性语义（契约 §5.1 明文）。
 * 反过来，本文件属于 **editors** 层，它的职责**就是**「把描述映射成可渲染的控件」，
 * 所以控件名在这里是恰当的领域词汇。
 *
 * 映射是**纯函数 + 可注册**：`resolveControl` 只看 `valueType`/`domain`/`unit`/`display`，
 * 不认识任何对象类型；专用控件经 `ControlRegistry.register` 覆盖（#253「复杂控件可自定义
 * 但不绕过读写契约」），核心没有任何 `switch (objectType)`。
 *
 * ## 交互暂存（D1.1 #2/#3、D2.1 #20/#23）
 *
 * 旧实现是「`@input` 每敲一个字符提交一次」（`RNAWidget.vue:95,105,120`），
 * 且两处 debounce 各自实现、卸载时只清定时器**不 flush**（丢字）。
 * 本文件把提交时机变成**纯状态机**：
 *
 * ```
 * idle --begin--> editing --updateDraft--> editing(draft) --commit--> idle
 *                    |                                        └--reject--> editing(draft, reason)
 *                    └--cancel--> idle
 * ```
 *
 * 政策（作为数据，不是散落的组件回调）：
 *  - `intermediate` 草稿**不提交**（`-`、`1.`、`` 、中文组合中间态）；
 *  - `commitOnBlur`：失焦时提交**完整合法**草稿；非法草稿保留并提示，**不暗中强制转换**；
 *  - `flushPendingOnUnmount`：卸载前把待提交的完整合法草稿提交（旧实现丢字的那条）；
 *  - 拒绝 ⇒ **草稿不丢**、原因可见、文档不变（#249 §8「被拒绝的操作保持文档、历史与
 *    保存脏状态不变，诊断可以改变」）。
 *
 * 纯：无 Vue/Three/DOM/IO/时钟；`commit` 需要的写入委托给调用方传入的 `submit`
 * （**不是** setter 闭包 —— 它是「把一次命令交给唯一写路由」的动作，
 * 与契约 §5.2「调用方不传任意 setter 闭包」不冲突：这里传的是命令执行意图，
 * 目标与值仍是 `PropertyRef` + 值）。
 */

import {
  type CommandOutcome,
  type DomainError,
  type EntityRef,
  type PropertyRef,
} from '@/application/contracts'
import {
  type DisplaySpec,
  type EnumItem,
  type MixedValue,
  type PropertyDescriptor,
  type PropertyRegistry,
  type PropertyValue,
  MIXED_VALUE,
  componentName,
  formatValue,
  parseDraft,
  propertyRef,
} from '@/application/properties'

// ─────────────────────────────────────────────────────────────────────────────
// 1. 控件模型
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 控件种类。**这是 editors 层的词汇**，不是 RNA 描述的一部分。
 *
 * `stepper` 与 `slider` 都产出 `number` 字段（D1.1 #6：步长/精度来自描述符，
 * 不再按 `range/100` 猜「友好刻度」）。
 */
export type ControlKind =
  | 'text'
  | 'multiline-text'
  | 'number'
  | 'slider'
  | 'stepper'
  | 'toggle'
  | 'dropdown'
  | 'color'
  | 'vector'
  | 'reference'
  | 'string-list'
  | 'readonly-text'
  | (string & {})

/** 一个控件的**纯模型**（组件只消费它，不做判定）。 */
export type ControlModel = Readonly<{
  kind: ControlKind
  /** 数值/向量的步长（来自 `domain.step`，**不猜**）。 */
  step?: number
  /** 硬约束（用于 `min`/`max` 属性与滑杆范围）；推荐域不进这里。 */
  min?: number
  max?: number
  /** 小数位（来自 `display.decimals`）。 */
  decimals?: number
  /** 单位（描述符携带；呈现只做展示）。 */
  unit?: PropertyDescriptor['unit']
  /** 枚举项（值 ≠ 显示名；D1.4 #12）。 */
  options?: readonly EnumItem[]
  /** 向量/四元数的分量名（`component` 寻址用）。 */
  components?: readonly string[]
  /** 多行文本。 */
  multiline?: boolean
  /** 引用类型的目标拥有者种类。 */
  referenceKind?: string
  /** 字符串列表分隔符。 */
  separator?: string
  /** 键盘可达性与 `aria` 所需的最小信息（D2.5 #31：标签与控件必须建立可访问关联）。 */
  ariaRole?: string
}>

/** 模块级默认注册表（可由 `createControlRegistry` 覆盖；无对象类型分支）。 */
export function resolveControlKind(desc: PropertyDescriptor, registry?: ControlRegistry): ControlKind {
  if (registry) {
    for (const r of registry.resolvers()) {
      const hit = r(desc)
      if (hit) return hit
    }
  }
  return builtinResolve(desc)
}

/**
 * 内置映射（默认，全仓库唯一一处）——对照 #251 B7 的 B.2 现状映射表：
 *
 * | 值类型 | 条件 | 控件 |
 * |---|---|---|
 * | `number` | 有硬约束 range | `slider`（步长来自描述符） |
 * | `number` | 无 | `number` |
 * | `boolean` | — | `toggle`（原生可聚焦，D1.2 #7） |
 * | `string` | `domain.kind==='text' && multiline` | `multiline-text`（D1.3 #9） |
 * | `string` | `domain.kind==='string-list'` | `string-list`（**不把逗号字符串当核心类型**） |
 * | `string` | 其它 | `text` |
 * | `enum` | — | `dropdown` |
 * | `color` | — | `color`（校验 + 反馈，D1.5 #14） |
 * | `vec3` | — | `vector`（分量各有域/步长，D1.6 #16） |
 * | `quat` | — | `vector`（4 分量） |
 * | `reference` | — | `reference`（引用校验，D1.7 #18） |
 * | 未知 | — | `readonly-text`（**不静默吞输入**，D1.3 #11 的反面） |
 */
function builtinResolve(desc: PropertyDescriptor): ControlKind {
  if (desc.readOnly) return 'readonly-text'
  switch (desc.valueType) {
    case 'number': {
      const d = desc.domain
      if (d && d.kind === 'number' && d.hard && d.min !== undefined && d.max !== undefined) return 'slider'
      return 'number'
    }
    case 'boolean':
      return 'toggle'
    case 'string': {
      const d = desc.domain
      if (d && d.kind === 'string-list') return 'string-list'
      if (d && d.kind === 'text' && d.multiline) return 'multiline-text'
      return 'text'
    }
    case 'enum':
      return 'dropdown'
    case 'color':
      return 'color'
    case 'vec3':
      return 'vector'
    case 'quat':
      return 'vector'
    case 'reference':
      return 'reference'
    default:
      return 'readonly-text'
  }
}

/** 描述 → 控件模型（纯）。 */
export function modelFor(desc: PropertyDescriptor, registry?: ControlRegistry): ControlModel {
  const kind = resolveControlKind(desc, registry)
  const model: {
    kind: ControlKind
    step?: number
    min?: number
    max?: number
    decimals?: number
    unit?: PropertyDescriptor['unit']
    options?: readonly EnumItem[]
    components?: readonly string[]
    multiline?: boolean
    referenceKind?: string
    separator?: string
    ariaRole?: string
  } = { kind }

  if (desc.unit) model.unit = desc.unit
  if (desc.display.decimals !== undefined) model.decimals = desc.display.decimals

  const d = desc.domain
  if (d) {
    switch (d.kind) {
      case 'number':
        if (d.step !== undefined) model.step = d.step
        if (d.min !== undefined) model.min = d.min
        if (d.max !== undefined) model.max = d.max
        break
      case 'enum':
        model.options = d.items
        break
      case 'reference':
        model.referenceKind = d.ownerKind
        break
      case 'text':
        model.multiline = d.multiline
        break
      case 'string-list':
        model.separator = d.separator
        break
      default:
        break
    }
  }

  if (desc.valueType === 'vec3') model.components = ['x', 'y', 'z']
  if (desc.valueType === 'quat') model.components = ['x', 'y', 'z', 'w']
  if (kind === 'toggle') model.ariaRole = 'switch'
  if (kind === 'slider' || kind === 'number' || kind === 'stepper') model.ariaRole = 'spinbutton'
  return model
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 控件注册表（扩展挂点；核心零对象类型分支）
// ─────────────────────────────────────────────────────────────────────────────

/** 专用控件解析器：返回 `null` 表示「不接这个描述」，交由后续解析器或内置映射。 */
export type ControlResolver = (desc: PropertyDescriptor) => ControlKind | null

/**
 * 控件注册表。
 *
 * 「复杂控件可自定义但不绕过读写契约」（#253）的落法：注册项**只**决定 `ControlKind`，
 * 而草稿解析（`parseDraft`）、可编辑性（`evaluateEditability`）、写入（`applySetProperty`）
 * 全部仍走 RNA 核心 —— 自定义控件拿不到第二条写通路。
 */
export interface ControlRegistry {
  register(id: string, resolver: ControlResolver): void
  resolvers(): readonly ControlResolver[]
  /** 值类型 → 专用控件（最常见的一种注册形态；仍只是解析器语法糖）。 */
  registerForValueType(valueType: string, kind: ControlKind): void
}

export function createControlRegistry(): ControlRegistry {
  const items: { id: string; resolver: ControlResolver }[] = []
  return {
    register(id, resolver) {
      const at = items.findIndex((i) => i.id === id)
      if (at >= 0) items[at] = { id, resolver }
      else items.push({ id, resolver })
    },
    registerForValueType(valueType, kind) {
      const id = `valueType:${valueType}`
      const at = items.findIndex((i) => i.id === id)
      const item = { id, resolver: (d: PropertyDescriptor) => (d.valueType === valueType ? kind : null) }
      if (at >= 0) items[at] = item
      else items.push(item)
    },
    resolvers: () => items.map((i) => i.resolver),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 字段视图模型（组件渲染的唯一输入）
// ─────────────────────────────────────────────────────────────────────────────

/** 一个字段在**读面**的状态。 */
export type FieldValueState =
  | Readonly<{ kind: 'value'; value: PropertyValue }>
  | Readonly<{ kind: 'mixed'; refs: readonly PropertyRef[] }>
  | Readonly<{ kind: 'error'; error: DomainError }>
  | Readonly<{ kind: 'unreadable'; reason: DomainError }>

/** 一个字段在**可编辑性**上的状态（结构化原因，不是布尔）。 */
export type FieldEditState =
  | Readonly<{ kind: 'editable' }>
  | Readonly<{ kind: 'readOnly'; reason: DomainError }>

/** 标签/描述的解析结果（**翻译键 + 回退文字**；语言在实例呈现侧决定，§19.7）。 */
export type FieldDisplay = Readonly<{
  labelKey: string
  labelFallback: string
  descriptionKey?: string
  descriptionFallback?: string
}>

/**
 * 字段视图模型 —— 组件**只**渲染它，不做判定（#249 §2.1「接线层不藏政策」）。
 *
 * `drafts` 里保留的是**文本**：显示值、编辑草稿、可提交值是三个不同的东西
 * （#249 §19.1），本结构把它们并列而不是压成一个 `value`。
 */
export type FieldViewModel = Readonly<{
  ref: PropertyRef
  descriptor: PropertyDescriptor
  control: ControlModel
  display: FieldDisplay
  value: FieldValueState
  edit: FieldEditState
  /** 当前草稿文本（`null` 表示未在编辑）。 */
  draft: string | null
  /** 草稿的解析状态（`intermediate` / `invalid` 决定是否允许提交）。 */
  draftState: FieldDraftState
  /** 上一次提交被拒绝的结构化原因（呈现给用户；`null` 表示没有）。 */
  rejection: DomainError | null
  /** 展示文本（多选混合值是 `—`；不掩盖错误）。 */
  displayText: string
}>

export type FieldDraftState =
  | Readonly<{ state: 'none' }>
  | Readonly<{ state: 'intermediate' }>
  | Readonly<{ state: 'invalid'; error: DomainError }>
  | Readonly<{ state: 'complete'; value: PropertyValue }>

export function fieldDisplayOf(desc: PropertyDescriptor): FieldDisplay {
  return {
    labelKey: desc.display.labelKey,
    labelFallback: desc.display.fallback ?? desc.display.labelKey,
    ...(desc.display.descriptionKey ? { descriptionKey: desc.display.descriptionKey } : {}),
    ...(desc.display.descriptionFallback ? { descriptionFallback: desc.display.descriptionFallback } : {}),
  }
}

/** 构造一个字段的视图模型（纯）。 */
export function buildFieldViewModel(
  registry: PropertyRegistry,
  ref: PropertyRef,
  input: Readonly<{
    descriptor: PropertyDescriptor
    value: FieldValueState
    edit: FieldEditState
    draft?: string | null
    rejection?: DomainError | null
  }>,
  controls?: ControlRegistry,
): FieldViewModel {
  const draft = input.draft ?? null
  const draftState: FieldDraftState =
    draft === null
      ? { state: 'none' }
      : (() => {
          const parsed = parseDraft(registry, input.descriptor, draft)
          if (parsed.state === 'complete') return { state: 'complete', value: parsed.value } as const
          if (parsed.state === 'intermediate') return { state: 'intermediate' } as const
          return { state: 'invalid', error: parsed.error } as const
        })()

  const displayText =
    input.value.kind === 'value'
      ? formatValue(registry, input.descriptor, input.value.value)
      : input.value.kind === 'mixed'
        ? formatValue(registry, input.descriptor, MIXED_VALUE as MixedValue)
        : '—'

  return {
    ref,
    descriptor: input.descriptor,
    control: modelFor(input.descriptor, controls),
    display: fieldDisplayOf(input.descriptor),
    value: input.value,
    edit: input.edit,
    draft,
    draftState,
    rejection: input.rejection ?? null,
    displayText,
  }
}

/** 可选提交判据：只有**完整合法**草稿才允许提交（`intermediate`/`invalid` 都不允许）。 */
export function canCommitDraft(field: FieldViewModel): boolean {
  return field.draftState.state === 'complete' && field.edit.kind === 'editable'
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 编辑会话（纯状态机）
// ─────────────────────────────────────────────────────────────────────────────

/** 一次属性编辑会话的状态。 */
export type EditSession = Readonly<{
  ref: PropertyRef
  /** 起始草稿（用于 Escape 还原）。 */
  initialDraft: string
  draft: string
  /** 是否处于「编辑中」（聚焦且已 begin）。 */
  editing: boolean
  /** 待提交标记：`commitOnBlur` 场景下由 `markPending` 置位。 */
  pendingCommit: boolean
  lastRejection: DomainError | null
}>

/** 编辑政策（数据，不是散落在组件里的回调）。 */
export type EditPolicy = Readonly<{
  /** 键入期间就尝试提交（旧行为）—— 默认 **false**（D1.1 #3 要求显式提交时机）。 */
  commitWhileTyping: boolean
  /** 失焦时提交完整合法草稿。 */
  commitOnBlur: boolean
  /** Enter 提交。 */
  commitOnEnter: boolean
  /** Escape 取消并还原草稿。 */
  cancelOnEscape: boolean
  /** 卸载/失活前 flush 待提交草稿（旧实现丢字的那条，D2.1 #23）。 */
  flushPendingOnUnmount: boolean
}>

/**
 * 默认政策：键入只改草稿；Enter/blur 提交；Escape 还原；卸载前 flush。
 *
 * 与旧实现的差别（逐条对应 #251 B7 的 E-11 / C-11 / C-04）：
 *  - 不再每字符提交一次（不会 20 字 20 条 undo）；
 *  - 卸载前 flush（不丢字）；
 *  - Escape 显式还原。
 */
export const DEFAULT_EDIT_POLICY: EditPolicy = {
  commitWhileTyping: false,
  commitOnBlur: true,
  commitOnEnter: true,
  cancelOnEscape: true,
  flushPendingOnUnmount: true,
}

/** 开启编辑会话。 */
export function beginEdit(ref: PropertyRef, displayText: string): EditSession {
  return {
    ref,
    initialDraft: displayText,
    draft: displayText,
    editing: true,
    pendingCommit: false,
    lastRejection: null,
  }
}

/** 更新草稿（键入）。`commitWhileTyping` 由调用方决定是否随后 `tryCommit`。 */
export function updateDraft(session: EditSession, draft: string, commitWhileTyping: boolean): EditSession {
  return {
    ...session,
    draft,
    pendingCommit: session.pendingCommit || commitWhileTyping,
    lastRejection: null,
  }
}

/** 标记「有未提交的完整合法草稿」（失焦/卸载前用）。 */
export function markPending(session: EditSession): EditSession {
  return { ...session, pendingCommit: true }
}

/** 取消：还原初始草稿，清除待提交与拒绝原因。 */
export function cancelEdit(session: EditSession): EditSession {
  return { ...session, draft: session.initialDraft, editing: false, pendingCommit: false, lastRejection: null }
}

/**
 * 提交的结果：**成功** ⇒ 会话结束（`editing=false`，草稿同步为提交后的显示值）；
 * **被拒绝** ⇒ 会话保留、草稿不丢、原因可见；**无变化** ⇒ 会话结束但**不报告 applied**。
 */
export type CommitResult =
  | Readonly<{ kind: 'committed'; session: EditSession; outcome: CommandOutcome }>
  | Readonly<{ kind: 'unchanged'; session: EditSession; outcome: CommandOutcome }>
  | Readonly<{ kind: 'rejected'; session: EditSession; error: DomainError }>
  | Readonly<{ kind: 'not-committable'; session: EditSession; reason: 'intermediate' | 'invalid' | 'read-only' }>

/**
 * 提交草稿 —— 纯函数；真正的写入由 `submit` 完成（把命令交给**唯一写路由**）。
 *
 * 三条纪律：
 *  1. `intermediate` / `invalid` 草稿**不提交**，也不强制转换（#249 §19.1）；
 *  2. 只读字段不提交（`not-committable`，`read-only`），且**保留原因**；
 *  3. `rejected` 时 `session.lastRejection` 被设置、`draft` 不变 —— 于是「拒绝后不得报告
 *     applied」在**会话层**与**命令层**（`CommandOutcome`）两处都成立（D5）。
 */
export function tryCommit(
  session: EditSession,
  field: FieldViewModel,
  submit: (ref: PropertyRef, value: PropertyValue) => CommandOutcome,
): CommitResult {
  if (field.edit.kind !== 'editable') {
    return {
      kind: 'not-committable',
      session: { ...session, lastRejection: field.edit.reason },
      reason: 'read-only',
    }
  }
  if (field.draftState.state === 'intermediate') {
    return { kind: 'not-committable', session, reason: 'intermediate' }
  }
  if (field.draftState.state === 'invalid') {
    return { kind: 'not-committable', session: { ...session, lastRejection: field.draftState.error }, reason: 'invalid' }
  }
  if (field.draftState.state !== 'complete') {
    // `none`：没有草稿可提交（例如控件尚未 begin）。
    return { kind: 'not-committable', session, reason: 'intermediate' }
  }
  const outcome = submit(session.ref, field.draftState.value)
  if (outcome.status === 'rejected') {
    return { kind: 'rejected', session: { ...session, lastRejection: outcome.error }, error: outcome.error }
  }
  if (outcome.status === 'unchanged') {
    return {
      kind: 'unchanged',
      session: { ...session, editing: false, pendingCommit: false, lastRejection: null },
      outcome,
    }
  }
  return {
    kind: 'committed',
    session: { ...session, editing: false, pendingCommit: false, lastRejection: null },
    outcome,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. 多选批次构造（控件侧）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把「一次编辑手势」变成**原子批次**命令的目标集（#253 D2 / D6 的控件侧）。
 *
 * 关键：多选下的字段值来自**混合值读面**；混合态**不预填**任何一方的值
 * （否则就是把首项值冒充全体）。因此：
 *  - 混合值 + 用户未改草稿 ⇒ 不可提交（`mixed-uncommitted`）；
 *  - 用户显式输入 ⇒ 作为**统一值**提交给全部目标（一次命令、一次事务）。
 */
export type BatchIntent =
  | Readonly<{ kind: 'commit'; refs: readonly PropertyRef[]; value: PropertyValue }>
  | Readonly<{ kind: 'blocked'; reason: 'mixed-uncommitted' | 'partial-selection' | 'empty' }>

export function batchIntent(
  refs: readonly PropertyRef[],
  value: FieldValueState,
  editedDraft: PropertyValue | null,
): BatchIntent {
  if (refs.length === 0) return { kind: 'blocked', reason: 'empty' }
  if (editedDraft !== null) return { kind: 'commit', refs, value: editedDraft }
  if (value.kind === 'mixed') return { kind: 'blocked', reason: 'mixed-uncommitted' }
  if (value.kind !== 'value') return { kind: 'blocked', reason: 'partial-selection' }
  return { kind: 'commit', refs, value: value.value }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. 坐标轴/分量标签（D1.6 #16；与 `component` 寻址同源）
// ─────────────────────────────────────────────────────────────────────────────

/** 分量下标 → 标签。**与 `componentName` 同源**，避免两处各写一份轴名。 */
export function componentLabel(desc: PropertyDescriptor, component: number): string {
  const name = componentName(desc.valueType, component)
  if (!name) return String(component)
  return name.toUpperCase()
}

/** 造一个「某目标上某属性的分量」引用（控件逐分量提交时用）。 */
export function componentRef(owner: EntityRef, property: string, component: number): PropertyRef {
  return propertyRef(owner, property, { component })
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. 显示回退（翻译键 + 回退文字；语言不影响逻辑）
// ─────────────────────────────────────────────────────────────────────────────

/** 语言 → 展示文本（**回退文字**优先于键；实例呈现决定语言）。 */
export function displayTextFor(display: DisplaySpec, language: 'zh' | 'en'): string {
  void language
  return display.fallback ?? display.labelKey
}
