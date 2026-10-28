/**
 * `editors/property-controls` —— **基础控件模型与交互暂存政策**（纯逻辑）。
 *
 * 依据：「UI 提示与语义约束分离…不能把逗号字符串作为核心类型」、
 * 「RNA 不导入组件名；控件注册和面板布局由 editors/composition 贡献」）、
 * 显示值 / 编辑草稿 / 可提交值分离；Enter/Escape 不重复消费；非法中间草稿不写文档、
 * 「翻译键与单位」；界面需求清单
 * （输入来自实例采集的控件样本）。
 *
 * ## 为什么「控件名」可以出现在这里、但不可以出现在 RNA 描述里
 *
 * RNA 描述（`application/properties.ts` 的 `PropertyDecl`）里**不得**出现控件类型名 ——
 * 那会让「换控件」必须改核心，且把 UI 决策钉进属性语义（属性描述不承载控件决策）。
 * 反过来，本文件属于 **editors** 层，它的职责**就是**「把描述映射成可渲染的控件」，
 * 所以控件名在这里是恰当的领域词汇。
 *
 * 映射是**纯函数 + 可注册**：`resolveControl` 只看 `valueType`/`domain`/`unit`/`display`，
 * 不认识任何对象类型；专用控件经 `ControlRegistry.register` 覆盖（「复杂控件可自定义
 * 但不绕过读写契约」），核心没有任何 `switch (objectType)`。
 *
 * ## 交互暂存：**已整段退役**，判定与时序唯一在输入层
 *
 * 本文件曾提供第二套草稿机制：`PanelSession.drafts` 的解析镜像
 * （`FieldViewModel.draft`/`draftState`，由 `parseDraft` 解析）以及一套纯状态机
 * （`EditSession`/`EditPolicy`/`beginEdit`/`updateDraft`/`tryCommit`/`canCommitDraft`）。
 *
 * 它们**已是死轨**，按退役纪律删除（不留兼容旁路）：
 *
 *  - **判定**：草稿三态的唯一权威是 `domain/textDraft.ts`（含 IME 门、域下传、token 去重）；
 *  - **提交时机**：唯一入口是输入层 `domain/textDraft.settleControl` 产出的 `commit` 效果
 *    → `draft.commit` → `application/inputCommands.resolveIntent` → 唯一写路由；
 *  - **呈现**：组件读 `InputPort.textProjection`（只读投影），不自己存草稿。
 *
 * 删除而不是保留的理由（实测，不是判断）：镜像的**写键与读键不同**
 * （`PropertyInspector.onDraft` 写 `localPropertyOf(desc.id)`＝`tooltip`，而
 * `inspectors/inspector.ts` 的 `makeRow` 与卸载 flush 读 `localIdOf`＝`block.tooltip`），
 * 生产键空间 84 个属性**无一命中** ⇒ 镜像喂给模型与 flush 的路径本就不通；
 * 唯一活路是 `buildField` 的同键读取，而 `buildField` 反过来只被
 * `FieldViewModel.draft` 这条链消费 —— 环上没有任何生产行为。
 *
 * 保留的只是**控件模型**（`ControlModel`/`ControlRegistry`/`modelFor`/`formatValue`
 * 系）与**字段视图模型**（`FieldViewModel`，现已不含草稿字段）。
 *
 * 纯：无 Vue/Three/DOM/IO/时钟。
 */

import {
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
} from '@/application/properties'
// `propertyRef` 的唯一权威是 `domain/identity`（收敛：RNA 侧那份已删）。
import { propertyRef } from '@/domain/identity'

// ─────────────────────────────────────────────────────────────────────────────
// 1. 控件模型
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 控件种类。**这是 editors 层的词汇**，不是 RNA 描述的一部分。
 *
 * `stepper` 与 `slider` 都产出 `number` 字段（步长/精度来自描述符，
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
  /** 枚举项（值 ≠ 显示名）。 */
  options?: readonly EnumItem[]
  /** 向量/四元数的分量名（`component` 寻址用）。 */
  components?: readonly string[]
  /** 多行文本。 */
  multiline?: boolean
  /** 引用类型的目标拥有者种类。 */
  referenceKind?: string
  /** 字符串列表分隔符。 */
  separator?: string
  /** 键盘可达性与 `aria` 所需的最小信息（标签与控件必须建立可访问关联）。 */
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
 * 内置映射（默认，全仓库唯一一处）——对照现有控件映射表：
 *
 * | 值类型 | 条件 | 控件 |
 * |---|---|---|
 * | `number` | 有硬约束 range | `slider`（步长来自描述符） |
 * | `number` | 无 | `number` |
 * | `boolean` | — | `toggle`（原生可聚焦） |
 * | `string` | `domain.kind==='text' && multiline` | `multiline-text` |
 * | `string` | `domain.kind==='string-list'` | `string-list`（**不把逗号字符串当核心类型**） |
 * | `string` | 其它 | `text` |
 * | `enum` | — | `dropdown` |
 * | `color` | — | `color`（校验 + 反馈） |
 * | `vec3` | — | `vector`（分量各有域/步长） |
 * | `quat` | — | `vector`（4 分量） |
 * | `reference` | — | `reference`（引用校验） |
 * | 未知 | — | `readonly-text`（**不静默吞输入**，与"静默吞输入"相反） |
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
 * 「复杂控件可自定义但不绕过读写契约」的落法：注册项**只**决定 `ControlKind`，
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

/** 标签/描述的解析结果（**翻译键 + 回退文字**；语言在实例呈现侧决定）。 */
export type FieldDisplay = Readonly<{
  labelKey: string
  labelFallback: string
  descriptionKey?: string
  descriptionFallback?: string
}>

/**
 * 字段视图模型 —— 组件**只**渲染它，不做判定（「接线层不藏政策」）。
 *
 * `drafts` 里保留的是**文本**：显示值、编辑草稿、可提交值是三个不同的东西
 * 本结构把它们并列而不是压成一个 `value`。
 */
export type FieldViewModel = Readonly<{
  ref: PropertyRef
  descriptor: PropertyDescriptor
  control: ControlModel
  display: FieldDisplay
  value: FieldValueState
  edit: FieldEditState
  /** 上一次提交被拒绝的结构化原因（呈现给用户；`null` 表示没有）。 */
  rejection: DomainError | null
  /** 展示文本（多选混合值是 `—`；不掩盖错误）。 */
  displayText: string
}>

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
    rejection?: DomainError | null
  }>,
  controls?: ControlRegistry,
): FieldViewModel {
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
    rejection: input.rejection ?? null,
    displayText,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 多选批次构造（控件侧）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把「一次编辑手势」变成**原子批次**命令的目标集（控件侧）。
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
  // 5. 坐标轴/分量标签（与 `component` 寻址同源）
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
// 6. 显示回退（翻译键 + 回退文字；语言不影响逻辑）
// ─────────────────────────────────────────────────────────────────────────────

/** 语言 → 展示文本（**回退文字**优先于键；实例呈现决定语言）。 */
export function displayTextFor(display: DisplaySpec, language: 'zh' | 'en'): string {
  void language
  return display.fallback ?? display.labelKey
}
