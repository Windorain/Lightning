/**
 * #253 P2 · RNA —— **属性描述协议、寻址与受控读面**（纯核心）。
 *
 * 依据：`docs/contracts/web-kernel-contracts.md` §5（RNA 与唯一写路由）、§2.2（读面）、
 * §3.2/§3.3（错误分类与多选原子性）、§1.3（`PropertyRef`）；#249 §6/§7/§19.1/§19.7。
 *
 * ## 这一层替代了什么（退役 #3：`ui-proxy-dispatch`）
 *
 * 旧实现把「属性描述」做成 `PropertyDescriptor { get(owner), set(owner,val), uiWidget }`
 * 的容器（`workbench/ux/rna/structs/*`），写面**三条**：
 * ① `descriptor.set` 直接改内存对象（无 clone / 无 undo / 无 epoch）；
 * ② `AnnotationEditorPanel` 用 `Proxy` 拦截 `set` 转 operator；
 * ③ `RNAWidget` 用 `rnaPath` 字符串前缀（`wikiconfig.` / `toolsettings.`）选写入通道。
 * 三者都是「旁路写入」（#249 §6 禁止），且 ②③ 是**组件内的业务政策**。
 *
 * 本文件确立的是**另一套**：描述是**数据**（无 get/set 闭包），寻址是**值**（`PropertyRef`），
 * 合法性/可编辑性/有效值优先级是**纯函数**（显式输入、不改输入、不依赖 Vue/Three/DOM/时钟/IO），
 * 写入只有**一条**路由（`property-commands.ts` 的 `applySetProperty`）。
 *
 * ## 纯度与可组合性（#249 §2.1）
 *
 * 本文件不 import 本层之外的任何**实现**（只 import `./contracts` 的值类型）。
 * 读值、目标事实、能力、版本全部由调用方经 `PropertyAccess` **显式传入**；
 * 注册表是 `createPropertyRegistry()` 造出来的**显式数据结构**，不是全局可变单例。
 *
 * ## D4：新增属性类型 / 对象类型的扩展挂点
 *
 * 值类型不是 `switch (valueType)` 的硬编码分支，而是**注册的 handler**
 * （`registerValueType`）。内置类型走的是**同一个**公开注册 API
 * （`BUILTIN_VALUE_TYPE_HANDLERS`），因此「新增一种值类型」与「新增一个内置类型」
 * 是同一条路径 —— 这条正是 D4 的证明路径，也是 A21（#257）要复用的挂点。
 */

import {
  type DomainError,
  type DomainErrorCode,
  type EntityOwnerKind,
  type EntityRef,
  type PropertyId,
  type PropertyRef,
  type Result,
  type Version,
  domainError,
  err,
  ok,
  samePropertyRef,
} from './contracts'

// ─────────────────────────────────────────────────────────────────────────────
// 1. 值与展示类型
// ─────────────────────────────────────────────────────────────────────────────

/** 三维向量 —— **值**（只读），不是可变底层数组（契约 §2.2 明文禁止暴露可变底层 TypedArray）。 */
export type Vec3 = Readonly<{ x: number; y: number; z: number }>
/** 四元数 —— 旋转有明确语义，**不把四元数当普通四个数**（#249 §7）。 */
export type Quat = Readonly<{ x: number; y: number; z: number; w: number }>
/** 颜色 —— `#rrggbb`（sRGB）。允不允许 alpha 由 `ValueDomain` 声明。 */
export type ColorValue = string
/** 引用值 —— 指向另一实体；**不**含实例指针（契约 §1.1）。 */
export type ReferenceValue = Readonly<{ kind: EntityOwnerKind; id: string }>

/**
 * RNA 值。**没有 `null`**：缺失用 `MissingTarget` 表达（契约 §3.1「不能用默认值掩盖缺失」），
 * 多选值不同用显式的 `'mixed'` 哨兵（§5.2「不用 null 兼表」）。
 */
export type PropertyValue =
  | number
  | string
  | boolean
  | Vec3
  | Quat
  | ColorValue
  | ReferenceValue
  | readonly string[]

/**
 * 值类型 ID。**开放集**（`string`）—— D4 要求新增类型不改核心，
 * 故此处不得写成封闭联合。
 */
export type PropertyValueType = string

/** 多选值不同的**显式**哨兵（契约 §5.2）。 */
export const MIXED_VALUE = 'mixed' as const
export type MixedValue = typeof MIXED_VALUE

/** 单位规格（#249 §6「单位」+ §19.7「描述保留单位」）。 */
export type UnitSpec = Readonly<{
  kind: 'length' | 'angle' | 'ratio' | 'alpha' | 'pixels' | 'ticks' | 'count' | 'none'
  /** 翻译键 + 可选回退文字；实例呈现决定语言与格式（§19.7）。 */
  symbolKey?: string
  symbolFallback?: string
}>

/** 基础显示说明（契约 §5.1）。**保留翻译键，不保留已翻译字符串**（§5.1 明文）。 */
export type DisplaySpec = Readonly<{
  labelKey: string
  fallback?: string
  descriptionKey?: string
  descriptionFallback?: string
  decimals?: number
}>

/** 枚举项：值 ≠ 显示名（D1.4 #12 要求本地化标签，不再直接渲染原始值）。 */
export type EnumItem = Readonly<{ value: string; display: DisplaySpec }>

/**
 * 合法域（#249 §6「合法域」）。**单一权威**：UI 与写入侧共用同一份
 * （旧实现里 `min/max` 只在 UI 侧、写入侧另有一处 clamp —— 见 Inspector 样例 C-10/C-16）。
 *
 * `range.hard` 区分**硬约束**与**推荐域**（D1.1 #1）：硬约束越界 ⇒ `InvalidValue`；
 * 推荐域只影响控件步长/提示，不成为合法性判据。
 */
export type ValueDomain =
  | Readonly<{ kind: 'number'; min?: number; max?: number; step?: number; hard: boolean }>
  | Readonly<{ kind: 'enum'; items: readonly EnumItem[] }>
  | Readonly<{ kind: 'reference'; ownerKind: EntityOwnerKind }>
  | Readonly<{ kind: 'pattern'; source: string; flags?: string; hintKey?: string; hintFallback?: string }>
  | Readonly<{ kind: 'text'; multiline: boolean; maxLength?: number }>
  | Readonly<{ kind: 'string-list'; separator: string }>
  /**
   * 多通道耦合约束：对**完整候选参数集**运行纯校验（#249 §7「非法组合产生可诊断求值失败，
   * 不悄悄夹取并宣称目标已实现」）。规则本体由注册的耦合校验器提供。
   */
  | Readonly<{ kind: 'coupled'; ruleId: string }>

/** 动画采样策略 ID（挂点；真实策略由 #255 注册，本批不实现采样）。 */
export type SamplingStrategyId = string

/**
 * 属性声明（RNA 描述的数据形态）。
 *
 * **不得**出现控件类型名（契约 §5.1：「`PropertyDescriptor` 里不得出现控件类型名」）——
 * 旧实现的 `uiWidget: 'slider' | 'stepper' | ...` 就是把控件名写进核心，
 * 使「换控件」必须改核心。控件选择由 `editors/property-controls` 依
 * `valueType` + `domain` + `unit` 求值（见 `PropertyControl.vue`）。
 */
export interface PropertyDecl {
  readonly id: PropertyId
  readonly valueType: PropertyValueType
  readonly unit?: UnitSpec
  readonly domain?: ValueDomain
  readonly referenceType?: EntityOwnerKind
  /** 动画资格（#249 §6）。`true` 表示可被轨道驱动 —— 不表示「当前被驱动」。 */
  readonly animatable: boolean
  /** 默认采样策略名（离散阶跃 / 连续插值…）—— 由 #255 注册实现。 */
  readonly defaultSamplingStrategy?: SamplingStrategyId
  readonly display: DisplaySpec
  /**
   * 发布默认值。**只在目标存在且该属性本身缺失时**参与读面
   * （契约 §3.1：「不能用默认值掩盖缺失」⇒ 目标不存在返回 `MissingTarget`）。
   */
  readonly defaultValue?: PropertyValue
  /** 声明级只读（如创建时间、格式版本）。运行时只读另由状态/能力求值。 */
  readonly readOnly?: boolean
  /** 声明级只读的结构化原因参数（供诊断与本地化）。 */
  readonly readOnlyReason?: string
}

/** 对象类型声明 —— 属性按 `'<objectTypeId>.<propertyId>'` 反查（`describe` 的键）。 */
export interface ObjectTypeDecl {
  readonly id: string
  readonly ownerKind: EntityOwnerKind
  readonly display: DisplaySpec
  readonly properties: readonly PropertyDecl[]
  /** 该对象类型的能力要求（profile 裁剪 ⇒ `UnsupportedOperation`，A15）。 */
  readonly requires?: readonly CapabilityId[]
}

/** 能力 ID（装配解析与 profile 裁剪的共用标识；#249 §10）。 */
export type CapabilityId = string

/** 属性写所需能力：查看器构建裁剪掉它 ⇒ 运行时拒绝（A15 负对照「只隐藏按钮」必须判红）。 */
export const CAP_PROPERTY_WRITE: CapabilityId = 'properties.write'

/** 运行时求值出的完整描述（= 声明 + 结构化的解析结果）。 */
export type PropertyDescriptor = Readonly<{
  id: PropertyId
  objectTypeId: string
  valueType: PropertyValueType
  unit?: UnitSpec
  domain?: ValueDomain
  referenceType?: EntityOwnerKind
  animatable: boolean
  display: DisplaySpec
  readOnly: boolean
  readOnlyReason?: string
  defaultValue?: PropertyValue
}>

// ─────────────────────────────────────────────────────────────────────────────
// 2. 值类型 handler（D4 扩展挂点）
// ─────────────────────────────────────────────────────────────────────────────

/** 解析结果（#249 §19.1：「纯解析返回完整/中间态/非法及原因」）。 */
export type ParseOutcome<V> =
  | Readonly<{ state: 'complete'; value: V }>
  | Readonly<{ state: 'intermediate' }>
  | Readonly<{ state: 'invalid'; error: DomainError }>

/** 校验/解析所需的显式输入（不含任何隐式上下文）。 */
export type ValueContext = Readonly<{
  domain?: ValueDomain
  unit?: UnitSpec
  display: DisplaySpec
}>

/**
 * 一种值类型的 handler。**纯**：显式输入、不改输入、不依赖 Vue/Three/DOM/时钟/IO。
 *
 * 这是 D4 的唯一扩展点：内置类型与扩展类型经同一个 `registerValueType` 注册，
 * 核心对「有哪些类型」**零分支**。
 */
export interface PropertyValueTypeHandler<V extends PropertyValue = PropertyValue> {
  readonly id: PropertyValueType
  /** 草稿文本 → 值 / 中间态 / 非法。没有文本表示的（vec3 等）可不实现。 */
  parseDraft?(draft: string, ctx: ValueContext): ParseOutcome<V>
  /** 草稿的初始文本（控件聚焦时的显示值）。 */
  toDraft?(value: V, ctx: ValueContext): string
  /** 结构校验：类型 + 合法域。越界**不得**夹取（#249 §7 明文）。 */
  validate(raw: unknown, ctx: ValueContext): Result<V>
  /** 规范化：只做等价形式归一（如 hex 小写），**不做**取值范围调整。 */
  normalize?(value: V, ctx: ValueContext): V
  /** 相等判定 —— D5「无业务变化返回 unchanged」的判据。 */
  equals(a: V, b: V): boolean
  /** 展示文本（含单位）。`decimals` 来自 `display`。 */
  format(value: V, ctx: ValueContext): string
  /**
   * 默认采样策略名（供 #255 注册与选择）。返回 `undefined` 表示该类型不可动画。
   */
  samplingStrategy?(decl: PropertyDescriptor): SamplingStrategyId | undefined
}

const NUMERIC_DECIMALS_DEFAULT = 3

function trimNumber(n: number, decimals: number | undefined): string {
  if (!Number.isFinite(n)) return String(n)
  const d = decimals ?? NUMERIC_DECIMALS_DEFAULT
  // 去尾零：`2.500` → `2.5`（展示口径，不改值）。
  return String(Number(n.toFixed(Math.max(0, Math.min(10, d)))))
}

function unitSuffix(unit: UnitSpec | undefined): string {
  if (!unit || unit.kind === 'none') return ''
  return unit.symbolFallback ?? ''
}

/** 数值域校验（硬约束才判越界；推荐域不成为判据）。 */
function checkNumberDomain(
  n: number,
  domain: ValueDomain | undefined,
  params: Record<string, string | number>,
): Result<number> {
  if (!domain || domain.kind !== 'number') return ok(n)
  if (!domain.hard) return ok(n)
  if (domain.min !== undefined && n < domain.min) {
    return err(domainError('InvalidValue', { ...params, min: domain.min, value: n, bound: 'min' }))
  }
  if (domain.max !== undefined && n > domain.max) {
    return err(domainError('InvalidValue', { ...params, max: domain.max, value: n, bound: 'max' }))
  }
  return ok(n)
}

const numberHandler: PropertyValueTypeHandler<number> = {
  id: 'number',
  parseDraft(draft, ctx) {
    // 空串 / 负号 / 小数点结尾都是**合法中间态**，不得写模型（D1.1 #2、D1.1 #3）。
    const t = draft.trim()
    if (t === '' || t === '-' || t === '+' || t === '.' || t === '-.' || /[.,]$/.test(t)) {
      return { state: 'intermediate' }
    }
    const n = Number(t)
    if (!Number.isFinite(n)) {
      return { state: 'invalid', error: domainError('InvalidValue', { type: 'number', draft }) }
    }
    const checked = checkNumberDomain(n, ctx.domain, { type: 'number' })
    if (!checked.ok) return { state: 'invalid', error: checked.error }
    return { state: 'complete', value: checked.value }
  },
  toDraft: (v, ctx) => trimNumber(v, ctx.display.decimals),
  validate(raw, ctx) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return err(domainError('InvalidValue', { type: 'number', got: typeof raw }))
    }
    return checkNumberDomain(raw, ctx.domain, { type: 'number' })
  },
  equals: (a, b) => a === b,
  format: (v, ctx) => `${trimNumber(v, ctx.display.decimals)}${unitSuffix(ctx.unit)}`,
  samplingStrategy: (decl) => (decl.animatable ? 'numeric-linear' : undefined),
}

const booleanHandler: PropertyValueTypeHandler<boolean> = {
  id: 'boolean',
  validate(raw) {
    if (typeof raw !== 'boolean') return err(domainError('InvalidValue', { type: 'boolean', got: typeof raw }))
    return ok(raw)
  },
  equals: (a, b) => a === b,
  format: (v) => (v ? 'true' : 'false'),
  samplingStrategy: (decl) => (decl.animatable ? 'discrete-step' : undefined),
}

const stringHandler: PropertyValueTypeHandler<string> = {
  id: 'string',
  parseDraft(draft, ctx) {
    if (ctx.domain?.kind === 'text' && ctx.domain.maxLength !== undefined && draft.length > ctx.domain.maxLength) {
      return {
        state: 'invalid',
        error: domainError('InvalidValue', { type: 'string', maxLength: ctx.domain.maxLength, got: draft.length }),
      }
    }
    return { state: 'complete', value: draft }
  },
  toDraft: (v) => v,
  validate(raw, ctx) {
    if (typeof raw !== 'string') return err(domainError('InvalidValue', { type: 'string', got: typeof raw }))
    if (ctx.domain?.kind === 'pattern') {
      const re = new RegExp(ctx.domain.source, ctx.domain.flags ?? '')
      if (!re.test(raw)) {
        return err(
          domainError('InvalidValue', {
            type: 'string',
            pattern: ctx.domain.source,
            hintKey: ctx.domain.hintKey ?? '',
          }),
        )
      }
    }
    if (ctx.domain?.kind === 'text' && ctx.domain.maxLength !== undefined && raw.length > ctx.domain.maxLength) {
      return err(domainError('InvalidValue', { type: 'string', maxLength: ctx.domain.maxLength, got: raw.length }))
    }
    return ok(raw)
  },
  equals: (a, b) => a === b,
  format: (v) => v,
  samplingStrategy: (decl) => (decl.animatable ? 'discrete-step' : undefined),
}

/** 枚举：值域校验 + 值 ≠ 显示名（D1.4 #12）。 */
const enumHandler: PropertyValueTypeHandler<string> = {
  id: 'enum',
  validate(raw, ctx) {
    if (typeof raw !== 'string') return err(domainError('InvalidValue', { type: 'enum', got: typeof raw }))
    if (ctx.domain?.kind === 'enum') {
      const hit = ctx.domain.items.some((i) => i.value === raw)
      if (!hit) {
        return err(domainError('InvalidValue', { type: 'enum', value: raw, allowed: ctx.domain.items.length }))
      }
    }
    return ok(raw)
  },
  equals: (a, b) => a === b,
  format: (v, ctx) => {
    if (ctx.domain?.kind === 'enum') {
      const hit = ctx.domain.items.find((i) => i.value === v)
      if (hit) return hit.display.fallback ?? hit.display.labelKey
    }
    return v
  },
  samplingStrategy: (decl) => (decl.animatable ? 'discrete-step' : undefined),
}

const HEX6 = /^#[0-9a-f]{6}$/i

/** 颜色：**必须校验**（D1.5 #14；旧实现把唯一校验文案留在未调用的 i18n 里）。 */
const colorHandler: PropertyValueTypeHandler<ColorValue> = {
  id: 'color',
  parseDraft(draft) {
    if (draft === '' || draft === '#') return { state: 'intermediate' }
    if (!HEX6.test(draft)) {
      return { state: 'invalid', error: domainError('InvalidValue', { type: 'color', got: draft.length }) }
    }
    return { state: 'complete', value: draft.toLowerCase() }
  },
  toDraft: (v) => v,
  validate(raw) {
    if (typeof raw !== 'string' || !HEX6.test(raw)) {
      return err(domainError('InvalidValue', { type: 'color' }))
    }
    return ok(raw.toLowerCase())
  },
  normalize: (v) => v.toLowerCase(),
  equals: (a, b) => a.toLowerCase() === b.toLowerCase(),
  format: (v) => v.toLowerCase(),
}

function isVec3(v: unknown): v is Vec3 {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Vec3).x === 'number' &&
    typeof (v as Vec3).y === 'number' &&
    typeof (v as Vec3).z === 'number'
  )
}

/**
 * vec3：**分量各有域/单位**（D1.6 #16），且整体是**一次提交事务**（D1.6 #17）。
 * `component` 属 `PropertyRef`（契约 §1.3），故「分量动画」与标量动画共用同一寻址。
 */
const vec3Handler: PropertyValueTypeHandler<Vec3> = {
  id: 'vec3',
  validate(raw, ctx) {
    if (!isVec3(raw)) return err(domainError('InvalidValue', { type: 'vec3' }))
    const d = ctx.domain
    if (d && d.kind === 'number' && d.hard) {
      for (const [k, n] of [['x', raw.x], ['y', raw.y], ['z', raw.z]] as const) {
        const checked = checkNumberDomain(n, d, { type: 'vec3', component: k })
        if (!checked.ok) return err(checked.error)
      }
    }
    return ok(raw)
  },
  /** 只读副本 —— 绝不回传可变引用（旧实现 `RNAWidget` 就是原地改分量再回写，绕过了 clone）。 */
  normalize: (v) => ({ x: v.x, y: v.y, z: v.z }),
  equals: (a, b) => a.x === b.x && a.y === b.y && a.z === b.z,
  format: (v) => `${trimNumber(v.x, undefined)}, ${trimNumber(v.y, undefined)}, ${trimNumber(v.z, undefined)}`,
  samplingStrategy: (decl) => (decl.animatable ? 'vector-linear' : undefined),
}

const quatHandler: PropertyValueTypeHandler<Quat> = {
  id: 'quat',
  validate(raw) {
    if (typeof raw !== 'object' || raw === null) return err(domainError('InvalidValue', { type: 'quat' }))
    const q = raw as Partial<Quat>
    if (
      typeof q.x !== 'number' ||
      typeof q.y !== 'number' ||
      typeof q.z !== 'number' ||
      typeof q.w !== 'number'
    ) {
      return err(domainError('InvalidValue', { type: 'quat' }))
    }
    return ok({ x: q.x, y: q.y, z: q.z, w: q.w })
  },
  normalize: (v) => ({ x: v.x, y: v.y, z: v.z, w: v.w }),
  equals: (a, b) => a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w,
  format: (v) => `${trimNumber(v.x, undefined)}, ${trimNumber(v.y, undefined)}, ${trimNumber(v.z, undefined)}, ${trimNumber(v.w, undefined)}`,
  /** 旋转用有明确语义的旋转插值，**不把四元数当普通四个数**（#249 §7）。 */
  samplingStrategy: (decl) => (decl.animatable ? 'quat-slerp' : undefined),
}

/** 引用：目标校验由拥有者解析器给出（`validate` 只查形状）。 */
const referenceHandler: PropertyValueTypeHandler<ReferenceValue> = {
  id: 'reference',
  validate(raw, ctx) {
    if (typeof raw !== 'object' || raw === null) return err(domainError('InvalidValue', { type: 'reference' }))
    const r = raw as ReferenceValue
    if (typeof r.id !== 'string' || typeof r.kind !== 'string') {
      return err(domainError('InvalidValue', { type: 'reference' }))
    }
    const want = ctx.domain?.kind === 'reference' ? ctx.domain.ownerKind : undefined
    if (want !== undefined && want !== r.kind) {
      return err(domainError('InvalidValue', { type: 'reference', expectedKind: want, got: r.kind }))
    }
    return ok({ kind: r.kind, id: r.id })
  },
  equals: (a, b) => a.kind === b.kind && a.id === b.id,
  format: (v) => `${v.kind}:${v.id}`,
  samplingStrategy: (decl) => (decl.animatable ? 'discrete-step' : undefined),
}

/** 字符串列表（如场景标签）：`separator` 声明在前，**不把逗号字符串当核心类型**（#249 §6）。 */
const stringListHandler: PropertyValueTypeHandler<readonly string[]> = {
  id: 'string-list',
  parseDraft(draft, ctx) {
    const sep = ctx.domain?.kind === 'string-list' ? ctx.domain.separator : ','
    return {
      state: 'complete',
      value: draft
        .split(sep)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    }
  },
  toDraft: (v, ctx) => v.join(ctx.domain?.kind === 'string-list' ? ctx.domain.separator : ', '),
  validate(raw) {
    if (!Array.isArray(raw) || raw.some((s) => typeof s !== 'string')) {
      return err(domainError('InvalidValue', { type: 'string-list' }))
    }
    return ok(raw as readonly string[])
  },
  equals: (a, b) => a.length === b.length && a.every((s, i) => s === b[i]),
  format: (v, ctx) => v.join(ctx.domain?.kind === 'string-list' ? ctx.domain.separator : ', '),
}

/**
 * 内置值类型 handler —— 经**公开** `registerValueType` 注册，与扩展类型同一路径（D4）。
 *
 * D1 的「RNA 不导入组件名」在这里也成立：handler 只谈**值**（解析/校验/相等/格式化），
 * 没有任何控件名。
 */
export const BUILTIN_VALUE_TYPE_HANDLERS: readonly PropertyValueTypeHandler[] = [
  numberHandler,
  booleanHandler,
  stringHandler,
  enumHandler,
  colorHandler,
  vec3Handler,
  quatHandler,
  referenceHandler,
  stringListHandler,
]

// ─────────────────────────────────────────────────────────────────────────────
// 3. 注册表（显式数据结构，非全局单例）
// ─────────────────────────────────────────────────────────────────────────────

export interface PropertyRegistry {
  /** 注册对象类型（含其属性）—— D4 的「新增普通对象类型」挂点。 */
  registerObjectType(decl: ObjectTypeDecl): Result<ObjectTypeDecl>
  /** 注册值类型 —— D4 的「新增属性类型」挂点。 */
  registerValueType(handler: PropertyValueTypeHandler): Result<PropertyValueTypeHandler>
  /** 注册多通道耦合校验器（`domain.kind === 'coupled'` 的规则本体）。 */
  registerCoupledRule(ruleId: string, rule: CoupledRule): void
  valueTypeHandler(id: PropertyValueType): PropertyValueTypeHandler | undefined
  valueTypes(): readonly PropertyValueType[]
  objectTypes(): readonly ObjectTypeDecl[]
  objectType(id: string): ObjectTypeDecl | undefined
  /** 属性 ID → 描述（含所属对象类型）。 */
  descriptor(propertyId: PropertyId): PropertyDescriptor | undefined
  /** 某拥有者种类下的全部属性描述 —— 生成式 Inspector 与「属性覆盖度」查询的来源。 */
  describeOwnerKind(kind: EntityOwnerKind): readonly PropertyDescriptor[]
  /** 某对象类型的全部属性描述。 */
  describeObjectType(objectTypeId: string): readonly PropertyDescriptor[]
  coupledRule(ruleId: string): CoupledRule | undefined
}

/**
 * 多通道耦合校验器：对**完整候选参数集**运行纯校验（#249 §7）。
 * 返回 `Transition`-无关的纯结果：合法 ⇒ `ok`，非法 ⇒ 结构化 `InvalidValue`。
 */
export type CoupledRule = (
  candidate: Readonly<Record<string, PropertyValue>>,
) => Result<Readonly<Record<string, PropertyValue>>>

export function createPropertyRegistry(options?: {
  valueTypes?: readonly PropertyValueTypeHandler[]
  objectTypes?: readonly ObjectTypeDecl[]
}): PropertyRegistry {
  const valueTypes = new Map<PropertyValueType, PropertyValueTypeHandler>()
  const objectTypes = new Map<string, ObjectTypeDecl>()
  const descriptors = new Map<PropertyId, PropertyDescriptor>()
  const ownerKindIndex = new Map<EntityOwnerKind, PropertyDescriptor[]>()
  const objectTypeIndex = new Map<string, PropertyDescriptor[]>()
  const coupledRules = new Map<string, CoupledRule>()

  function index(desc: PropertyDescriptor): void {
    const byKind = ownerKindIndex.get(descOwnerKind(desc)) ?? []
    byKind.push(desc)
    ownerKindIndex.set(descOwnerKind(desc), byKind)
    const byType = objectTypeIndex.get(desc.objectTypeId) ?? []
    byType.push(desc)
    objectTypeIndex.set(desc.objectTypeId, byType)
  }

  const objectOwnerKind = new Map<string, EntityOwnerKind>()
  function descOwnerKind(desc: PropertyDescriptor): EntityOwnerKind {
    return objectOwnerKind.get(desc.objectTypeId) ?? 'document'
  }

  const registry: PropertyRegistry = {
    registerObjectType(decl) {
      if (objectTypes.has(decl.id)) {
        return err(domainError('InvalidValue', { reason: 'duplicate-object-type', objectType: decl.id }))
      }
      const seen = new Set<string>()
      const built: PropertyDescriptor[] = []
      for (const p of decl.properties) {
        if (seen.has(p.id)) {
          return err(domainError('InvalidValue', { reason: 'duplicate-property', property: `${decl.id}.${p.id}` }))
        }
        seen.add(p.id)
        const key = `${decl.id}.${p.id}`
        if (descriptors.has(key)) {
          return err(domainError('InvalidValue', { reason: 'duplicate-property-id', property: key }))
        }
        built.push({
          id: key,
          objectTypeId: decl.id,
          valueType: p.valueType,
          ...(p.unit ? { unit: p.unit } : {}),
          ...(p.domain ? { domain: p.domain } : {}),
          ...(p.referenceType ? { referenceType: p.referenceType } : {}),
          animatable: p.animatable,
          display: p.display,
          readOnly: p.readOnly === true,
          ...(p.readOnlyReason ? { readOnlyReason: p.readOnlyReason } : {}),
          ...(p.defaultValue !== undefined ? { defaultValue: p.defaultValue } : {}),
        })
      }
      objectTypes.set(decl.id, decl)
      objectOwnerKind.set(decl.id, decl.ownerKind)
      for (const d of built) {
        descriptors.set(d.id, d)
        index(d)
      }
      return ok(decl)
    },

    registerValueType(handler) {
      if (valueTypes.has(handler.id)) {
        return err(domainError('UnsupportedOperation', { reason: 'duplicate-value-type', valueType: handler.id }))
      }
      valueTypes.set(handler.id, handler)
      return ok(handler)
    },

    registerCoupledRule(ruleId, rule) {
      coupledRules.set(ruleId, rule)
    },

    valueTypeHandler: (id) => valueTypes.get(id),
    valueTypes: () => [...valueTypes.keys()],
    objectTypes: () => [...objectTypes.values()],
    objectType: (id) => objectTypes.get(id),
    descriptor: (propertyId) => descriptors.get(propertyId),
    describeOwnerKind: (kind) => [...(ownerKindIndex.get(kind) ?? [])],
    describeObjectType: (id) => [...(objectTypeIndex.get(id) ?? [])],
    coupledRule: (ruleId) => coupledRules.get(ruleId),
  }

  for (const h of options?.valueTypes ?? BUILTIN_VALUE_TYPE_HANDLERS) {
    const r = registry.registerValueType(h)
    if (!r.ok) throw new Error(`RNA: 值类型重复注册 ${h.id}`)
  }
  for (const o of options?.objectTypes ?? []) {
    const r = registry.registerObjectType(o)
    if (!r.ok) throw new Error(`RNA: 对象类型注册失败 ${o.id}`)
  }
  return registry
}

/**
 * 默认注册表（内置值类型，无对象类型）。
 *
 * 对象类型由**各自批次**经 `registerObjectType` 贡献（P2 提供方块/注解/文档/发布配置的
 * 基线声明，见 `web/src/workbench/ux/propertyDecls.ts`），核心不预置任何具体类型 ——
 * 这正是「新增类型不改核心」的形态。
 */
export function createDefaultPropertyRegistry(): PropertyRegistry {
  return createPropertyRegistry()
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 访问输入（显式：值、事实、能力、版本）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 目标事实 —— 由接线层查得，**显式传入**纯函数。
 *
 * 这些事实就是「动态可编辑性由当前状态和能力求值」里的**状态**：
 * 不是静态 readonly 一个开关，也不是整份文档一个布尔
 * （契约 §3.2 负对照：「把 ReadOnly 退化成一个文档级布尔」必须判红）。
 */
export type TargetFacts = Readonly<{
  /** 目标是否仍在文档中（属性/元素/对象）。 */
  exists: boolean
  /** 拥有者是否被登记为**生成物**（如多方块生成对象）⇒ 只读（#249 §3.3）。 */
  generated: boolean
  /** 该属性是否正被**已启用轨道**驱动（#249 §7：编辑时默认显式拒绝普通基础值写入）。 */
  drivenByTrack: boolean
  /** 目标被锁定（如 `annotation.locked`）。 */
  locked: boolean
  /** 当前上下文是否持有该文档的修改租约（契约 §6.1）。 */
  holdsLease: boolean
  /** 元素级当前拓扑版本；`ref.element` 携带的版本与之不符 ⇒ `StaleReference`。 */
  topologyVersion?: number
  /** 拥有者当前内容版本；`ref.owner.contentVersion` 与之不符 ⇒ `StaleReference`。 */
  contentVersion?: number
}>

/** 「目标不存在」的保守事实（缺省即不可写，避免忘记传事实时静默放行）。 */
export const MISSING_TARGET_FACTS: TargetFacts = {
  exists: false,
  generated: false,
  drivenByTrack: false,
  locked: false,
  holdsLease: false,
}

/**
 * 一次属性访问的**全部**隐式环境（#249 §2.1：需要时间/身份/能力时作为输入传入）。
 *
 * `readValue` 返回**未经校验**的原始值：合法性由纯 handler 判定，
 * 读面不替写面做决定，写面也不信任读面（同一条校验路径）。
 */
export interface PropertyAccess {
  /** 一致版本（`read` 捕获；#249 §5 明文）。 */
  readonly version: Version
  /** 原始值读面。目标不存在 ⇒ `MissingTarget`（不得回落默认值）。 */
  readRaw(ref: PropertyRef): Result<unknown>
  /** 目标事实（可编辑性的状态输入）。 */
  facts(ref: PropertyRef): TargetFacts
  /** 本 profile / 构建已有的能力（A15：运行时拒绝写入，不只隐藏按钮）。 */
  readonly capabilities: ReadonlySet<CapabilityId>
  /** 语言只影响**展示**；错误码与命令逻辑不随语言改变（#249 §19.7）。 */
  readonly language: 'zh' | 'en'
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. 描述 — describe
// ─────────────────────────────────────────────────────────────────────────────

/** 属性未注册（或不属于该拥有者种类）—— 目标是「属性」这一层不存在。 */
function missingProperty(ref: PropertyRef): DomainError {
  return domainError('MissingTarget', { reason: 'property-not-registered', property: ref.property })
}

/**
 * `describe(ref)` —— 类型/单位/合法域/引用类型/动画资格/显示说明（契约 §2.2 / §5.1）。
 *
 * 返回值是**值**：调用方不得把它当可变对象改（描述由注册表持有，改它等于改权威）。
 */
export function describeProperty(
  registry: PropertyRegistry,
  ref: PropertyRef,
): Result<PropertyDescriptor> {
  const desc = registry.descriptor(ref.property)
  if (!desc) return err(missingProperty(ref))
  const objectType = registry.objectType(desc.objectTypeId)
  if (!objectType || objectType.ownerKind !== ref.owner.kind) {
    return err(
      domainError('MissingTarget', {
        reason: 'owner-kind-mismatch',
        property: ref.property,
        ownerKind: ref.owner.kind,
        expected: objectType?.ownerKind ?? 'unknown',
      }),
    )
  }
  if (ref.component !== undefined && !componentAddressable(desc)) {
    return err(
      domainError('MissingTarget', {
        reason: 'component-not-addressable',
        property: ref.property,
        component: ref.component,
      }),
    )
  }
  if (ref.component !== undefined && desc.valueType === 'vec3' && (ref.component < 0 || ref.component > 2)) {
    return err(domainError('MissingTarget', { reason: 'component-out-of-range', component: ref.component }))
  }
  if (ref.component !== undefined && desc.valueType === 'quat' && (ref.component < 0 || ref.component > 3)) {
    return err(domainError('MissingTarget', { reason: 'component-out-of-range', component: ref.component }))
  }
  return ok(desc)
}

/** 分量寻址只对有分量的值类型成立（契约 §1.3 选择理由：分量动画与标量动画共用寻址）。 */
function componentAddressable(desc: PropertyDescriptor): boolean {
  return desc.valueType === 'vec3' || desc.valueType === 'quat'
}

/** 组件下标 → 分量名（vec3: x/y/z；quat: x/y/z/w）。 */
export function componentName(valueType: PropertyValueType, component: number): string | undefined {
  if (valueType === 'vec3') return ['x', 'y', 'z'][component]
  if (valueType === 'quat') return ['x', 'y', 'z', 'w'][component]
  return undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. 读面 — read（authored / effective）
// ─────────────────────────────────────────────────────────────────────────────

export type ReadMode = 'authored' | 'effective'

/** 有效值来源（#249 §7「有效值优先级」的显式输入）。 */
export type EffectiveSources = Readonly<{
  /** ① 文档基础值/发布默认值（写面语义）—— 由 `readRaw` 提供。 */
  /** ② 编辑上下文手动预览值（适用通道）。 */
  preview?: PropertyValue
  /** ③ 已启用轨道的时间采样（由 #255 的求值器提供）。 */
  trackSampled?: PropertyValue
  /** ④ 活动编辑操作的暂存覆盖。 */
  staged?: PropertyValue
}>

/**
 * 读一个属性的**权威基础值**（`authored`）。
 *
 * 顺序不可换：
 *  1. 目标不存在 ⇒ `MissingTarget`（**不得**用默认值掩盖缺失，契约 §3.1）；
 *  2. 过期引用 ⇒ `StaleReference`（不静默猜配，#249 §3.2）；
 *  3. 原始值缺失且声明了 `defaultValue` ⇒ 用默认值（目标**存在**时才允许）；
 *  4. 否则交 handler 校验（越界/枚举非法 ⇒ `InvalidValue`，不夹取）。
 */
export function readAuthoredValue(
  registry: PropertyRegistry,
  ref: PropertyRef,
  access: PropertyAccess,
): Result<PropertyValue> {
  const described = describeProperty(registry, ref)
  if (!described.ok) return described
  const desc = described.value

  const facts = access.facts(ref)
  if (!facts.exists) {
    return err(domainError('MissingTarget', { reason: 'target-missing', property: ref.property, objectId: ref.owner.id }))
  }
  const stale = staleReason(ref, facts)
  if (stale) return err(stale)

  const handler = registry.valueTypeHandler(desc.valueType)
  if (!handler) {
    return err(
      domainError('UnsupportedOperation', { reason: 'unknown-value-type', valueType: desc.valueType, property: desc.id }),
    )
  }

  const raw = access.readRaw(ref)
  if (!raw.ok) {
    if (raw.error.code === 'MissingTarget' && desc.defaultValue !== undefined) {
      return ok(desc.defaultValue)
    }
    return raw
  }
  if (raw.value === undefined) {
    if (desc.defaultValue !== undefined) return ok(desc.defaultValue)
    return err(domainError('MissingTarget', { reason: 'value-absent', property: desc.id, objectId: ref.owner.id }))
  }

  const valueCtx: ValueContext = {
    ...(desc.domain ? { domain: desc.domain } : {}),
    ...(desc.unit ? { unit: desc.unit } : {}),
    display: desc.display,
  }
  const validated = handler.validate(raw.value, valueCtx)
  if (!validated.ok) return validated
  return readComponent(desc, validated.value, ref)
}

/** 分量读：整体读回后取分量（分量是**视图**，不是第二份权威）。 */
function readComponent(
  desc: PropertyDescriptor,
  value: PropertyValue,
  ref: PropertyRef,
): Result<PropertyValue> {
  if (ref.component === undefined) return ok(value)
  const name = componentName(desc.valueType, ref.component)
  if (!name) return err(domainError('MissingTarget', { reason: 'component-not-addressable', property: desc.id }))
  const rec = value as unknown as Record<string, number>
  const n = rec[name]
  if (typeof n !== 'number') {
    return err(domainError('InvalidValue', { reason: 'component-not-numeric', property: desc.id, component: name }))
  }
  return ok(n)
}

export function readProperty(
  registry: PropertyRegistry,
  ref: PropertyRef,
  mode: ReadMode,
  access: PropertyAccess,
  sources?: EffectiveSources,
): Result<PropertyValue> {
  const base = readAuthoredValue(registry, ref, access)
  if (mode === 'authored') return base
  return resolveEffectiveValue(registry, ref, base, sources ?? {})
}

/**
 * 有效值优先级（#249 §7）：`staged` > `trackSampled` > `preview` > `authored`。
 *
 * 逐级做**同一份** handler 校验：非法来源不得进入有效值（也就不会「悄悄夹取并宣称
 * 目标已实现」）。基础值本身非法时仍能被上层覆盖 —— 这正是「有效值」的意义，
 * 但**基础值非法这一事实不会被抹掉**：它作为 `InvalidValue` 在 `authored` 分支可见。
 *
 * 本函数**不接收** `PropertyAccess`：有效值解析只处理「已读到的候选集与基础值」，
 * 事实/能力/版本不进这条路径（那些属可编辑性与写入判定）。少一个输入就少一处
 * 「政策悄悄从上下文里读东西」的机会。
 */
export function resolveEffectiveValue(
  registry: PropertyRegistry,
  ref: PropertyRef,
  authored: Result<PropertyValue>,
  sources: EffectiveSources,
): Result<PropertyValue> {
  const described = describeProperty(registry, ref)
  if (!described.ok) return authored.ok ? described : authored
  const desc = described.value
  const handler = registry.valueTypeHandler(desc.valueType)
  if (!handler) {
    return err(
      domainError('UnsupportedOperation', { reason: 'unknown-value-type', valueType: desc.valueType, property: desc.id }),
    )
  }
  const valueCtx: ValueContext = {
    ...(desc.domain ? { domain: desc.domain } : {}),
    ...(desc.unit ? { unit: desc.unit } : {}),
    display: desc.display,
  }
  // 优先级从高到低；命中一级即返回（不继续向下回落 —— 否则同一属性会有两个有效值）。
  const layers: readonly (PropertyValue | undefined)[] = [sources.staged, sources.trackSampled, sources.preview]
  for (const layer of layers) {
    if (layer === undefined) continue
    const validated = handler.validate(layer, valueCtx)
    if (!validated.ok) return validated
    return readComponent(desc, validated.value, ref)
  }
  // 无覆盖层：基础值（其自身错误原样透出）。
  if (!authored.ok) return authored
  const validated = handler.validate(authored.value, valueCtx)
  if (!validated.ok) return validated
  return readComponent(desc, validated.value, ref)
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. 过期引用
// ─────────────────────────────────────────────────────────────────────────────

/** 引用过期 → 结构化原因；未过期 → `null`。**绝不静默猜配**（#249 §3.2）。 */
export function staleReason(ref: PropertyRef, facts: TargetFacts): DomainError | null {
  if (ref.element && facts.topologyVersion !== undefined && ref.element.topologyVersion !== facts.topologyVersion) {
    return domainError('StaleReference', {
      reason: 'topology-version',
      element: ref.element.elementId,
      expected: ref.element.topologyVersion,
      actual: facts.topologyVersion,
    })
  }
  if (
    ref.owner.contentVersion !== undefined &&
    facts.contentVersion !== undefined &&
    ref.owner.contentVersion !== facts.contentVersion
  ) {
    return domainError('StaleReference', {
      reason: 'content-version',
      objectId: ref.owner.id,
      expected: ref.owner.contentVersion,
      actual: facts.contentVersion,
    })
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. 可编辑性 — editability（动态求值，不是静态开关）
// ─────────────────────────────────────────────────────────────────────────────

/** 参与可编辑性求值的**动态事实**（供 #249 §19.9 的诊断面）。 */
export type EditabilityFactor = Readonly<{
  kind: 'capability' | 'state' | 'ownership' | 'animation' | 'lock' | 'lease' | 'existence' | 'declaration'
  id: string
}>

/**
 * 可编辑性（契约 §2.2：**返回结构化原因，不是布尔**）。
 *
 * `editable === false` 时 `reason` 必有；`because` 列出参与求值的动态事实 ——
 * 于是「同一个属性在不同状态下可编辑性不同」是可断言的事实，
 * 而「静态 readonly 一个开关」的实现无法满足这些断言（A08 的动态性判据）。
 */
export type Editability = Readonly<{
  editable: boolean
  reason: DomainError | null
  because: readonly EditabilityFactor[]
}>

function notEditable(reason: DomainError, because: readonly EditabilityFactor[]): Editability {
  return { editable: false, reason, because }
}

function editableWith(because: readonly EditabilityFactor[]): Editability {
  return { editable: true, reason: null, because }
}

/**
 * `editability(ref)` —— 由**当前状态与能力**求值（#249 §6 明文）。
 *
 * 判据顺序（先到先得，保证诊断稳定可重现）：
 *  ① 属性未注册 / 拥有者种类不符 ⇒ `MissingTarget`
 *  ② 目标不存在 ⇒ `MissingTarget`（不用默认值掩盖）
 *  ③ 引用过期 ⇒ `StaleReference`
 *  ④ 能力缺失（profile/构建裁剪）⇒ `UnsupportedOperation`（A15：运行时拒绝）
 *  ⑤ 拥有者为生成物 ⇒ `ReadOnly`（#249 §3.3 多方块生成物只读）
 *  ⑥ 声明级只读 ⇒ `ReadOnly`
 *  ⑦ 被轨道驱动 ⇒ `ReadOnly`（#249 §7：普通基础值写入默认显式拒绝）
 *  ⑧ 锁定 ⇒ `ReadOnly`
 *  ⑨ 未持有修改租约 ⇒ `DocumentBusy`（契约 §6.1，不静默排队）
 *  ⑩ 其它 ⇒ 可编辑
 *
 * **写权按拥有者/内容来源判断**：`generated` 只作用于该目标，同文档内可编辑对象不受影响
 * （契约 §3.2 负对照）。
 */
export function evaluateEditability(
  registry: PropertyRegistry,
  ref: PropertyRef,
  access: PropertyAccess,
): Editability {
  const described = describeProperty(registry, ref)
  if (!described.ok) {
    return notEditable(described.error, [{ kind: 'declaration', id: ref.property }])
  }
  const desc = described.value
  const facts = access.facts(ref)

  if (!facts.exists) {
    return notEditable(
      domainError('MissingTarget', { reason: 'target-missing', property: desc.id, objectId: ref.owner.id }),
      [{ kind: 'existence', id: ref.owner.id }],
    )
  }

  const stale = staleReason(ref, facts)
  if (stale) {
    return notEditable(stale, [
      { kind: 'existence', id: ref.owner.id },
      { kind: 'state', id: `contentVersion:${String(facts.contentVersion ?? '')}` },
    ])
  }

  const objectType = registry.objectType(desc.objectTypeId)
  const requires = [...(objectType?.requires ?? [])]
  if (!access.capabilities.has(CAP_PROPERTY_WRITE)) requires.push(CAP_PROPERTY_WRITE)
  const missingCapability = requires.find((c) => !access.capabilities.has(c))
  if (missingCapability) {
    return notEditable(
      domainError('UnsupportedOperation', {
        reason: 'capability-missing',
        capability: missingCapability,
        property: desc.id,
      }),
      [{ kind: 'capability', id: missingCapability }],
    )
  }

  if (facts.generated) {
    return notEditable(
      domainError('ReadOnly', { reason: 'generated-owner', property: desc.id, objectId: ref.owner.id }),
      [{ kind: 'ownership', id: `${ref.owner.kind}:${ref.owner.id}` }],
    )
  }

  if (desc.readOnly) {
    return notEditable(
      domainError('ReadOnly', {
        reason: desc.readOnlyReason ?? 'declared-read-only',
        property: desc.id,
      }),
      [{ kind: 'declaration', id: desc.id }],
    )
  }

  if (facts.drivenByTrack) {
    return notEditable(
      domainError('ReadOnly', { reason: 'animation-driven', property: desc.id, objectId: ref.owner.id }),
      [{ kind: 'animation', id: desc.id }],
    )
  }

  if (facts.locked) {
    return notEditable(
      domainError('ReadOnly', { reason: 'locked', property: desc.id, objectId: ref.owner.id }),
      [{ kind: 'lock', id: ref.owner.id }],
    )
  }

  if (!facts.holdsLease) {
    return notEditable(
      domainError('DocumentBusy', { reason: 'no-modification-lease', objectId: ref.owner.id }),
      [{ kind: 'lease', id: ref.owner.id }],
    )
  }

  return editableWith([
    { kind: 'capability', id: CAP_PROPERTY_WRITE },
    { kind: 'ownership', id: `${ref.owner.kind}:${ref.owner.id}` },
  ])
}

/** 便利判定：`editability` 结果的布尔投影（**保留**结构化原因的原函数仍需被调用方使用）。 */
export function isEditable(e: Editability): boolean {
  return e.editable
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. 草稿解析的公开入口（#249 §19.1：显示值 / 编辑草稿 / 可提交值分离）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 纯解析草稿：合法性判定在核心、**不在控件回调**（#249 §2.1「接线层不藏政策」）。
 *
 * 非法草稿**保留并提示**，不暗中强制转换（#249 §19.1）；中间态不提交。
 */
export function parseDraft(
  registry: PropertyRegistry,
  desc: PropertyDescriptor,
  draft: string,
): ParseOutcome<PropertyValue> {
  const handler = registry.valueTypeHandler(desc.valueType)
  if (!handler) {
    return {
      state: 'invalid',
      error: domainError('UnsupportedOperation', { reason: 'unknown-value-type', valueType: desc.valueType }),
    }
  }
  const valueCtx: ValueContext = {
    ...(desc.domain ? { domain: desc.domain } : {}),
    ...(desc.unit ? { unit: desc.unit } : {}),
    display: desc.display,
  }
  if (!handler.parseDraft) {
    return { state: 'invalid', error: domainError('UnsupportedOperation', { reason: 'no-draft-parser', valueType: desc.valueType }) }
  }
  const outcome = handler.parseDraft(draft, valueCtx)
  if (outcome.state !== 'complete') return outcome
  const validated = handler.validate(outcome.value, valueCtx)
  if (!validated.ok) return { state: 'invalid', error: validated.error }
  return { state: 'complete', value: validated.value }
}

/** 值 → 草稿文本（控件聚焦时显示）。 */
export function draftOf(registry: PropertyRegistry, desc: PropertyDescriptor, value: PropertyValue): string {
  const handler = registry.valueTypeHandler(desc.valueType)
  if (!handler?.toDraft) return formatValue(registry, desc, value)
  return handler.toDraft(value, {
    ...(desc.domain ? { domain: desc.domain } : {}),
    ...(desc.unit ? { unit: desc.unit } : {}),
    display: desc.display,
  })
}

/** 值 → 展示文本（含单位；语言在实例呈现侧决定与否由调用方负责）。 */
export function formatValue(
  registry: PropertyRegistry,
  desc: PropertyDescriptor,
  value: PropertyValue | MixedValue,
): string {
  if (value === MIXED_VALUE) return '—'
  const handler = registry.valueTypeHandler(desc.valueType)
  if (!handler) return String(value)
  return handler.format(value, {
    ...(desc.domain ? { domain: desc.domain } : {}),
    ...(desc.unit ? { unit: desc.unit } : {}),
    display: desc.display,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. 命令描述（D3：菜单/按钮/快捷键/命令搜索共用同一命令 ID 与参数描述）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 命令参数描述 —— 与属性描述**共用同一描述协议**（#249 §6：「RNA 对象、命令参数和编辑器
 * 设置可共用描述协议，但各自拥有者、历史及保存政策不同」）。
 */
export interface CommandParamDescriptor {
  readonly name: string
  readonly valueType: PropertyValueType
  readonly required: boolean
  readonly domain?: ValueDomain
  readonly display: DisplaySpec
}

/** 命令描述（菜单、按钮、快捷键、命令搜索的**唯一**来源）。 */
export interface CommandDescriptor {
  readonly id: string
  readonly display: DisplaySpec
  readonly params: readonly CommandParamDescriptor[]
  /** 具名命令标记：通用 `SetProperty` 之外的合法命令（#249 §6）。 */
  readonly genericPropertyWrite?: boolean
}

/**
 * 命令目录 —— D3 的落点。
 *
 * 目录是**显式数据结构**（不是全局单例），由装配层用一个数据源构造；
 * 菜单/按钮/快捷键/命令搜索都从它取 `id` + `params`，因此「同一命令 ID 与参数描述」
 * 不是约定而是**同一对象引用**。命令搜索面 `filterCommands` 是纯函数。
 */
export interface CommandCatalog {
  get(id: string): CommandDescriptor | undefined
  all(): readonly CommandDescriptor[]
  register(desc: CommandDescriptor): Result<CommandDescriptor>
}

export function createCommandCatalog(descriptors: readonly CommandDescriptor[] = []): CommandCatalog {
  const byId = new Map<string, CommandDescriptor>()
  const catalog: CommandCatalog = {
    get: (id) => byId.get(id),
    all: () => [...byId.values()],
    register(desc) {
      if (byId.has(desc.id)) {
        return err(domainError('InvalidValue', { reason: 'duplicate-command', command: desc.id }))
      }
      byId.set(desc.id, desc)
      return ok(desc)
    },
  }
  for (const d of descriptors) {
    const r = catalog.register(d)
    if (!r.ok) throw new Error(`RNA: 命令 ID 重复注册 ${d.id}`)
  }
  return catalog
}

/** 命令搜索命中（纯数据；UI 由 #258/P6 承载）。 */
export type CommandMatch = Readonly<{
  command: CommandDescriptor
  /** 命中的位置：命令 ID（机器标识）或显示名（人读）。 */
  matchedOn: 'id' | 'label'
  score: number
}>

/**
 * 命令搜索的**共用**纯函数（D3：与菜单/按钮/快捷键共用同一命令 ID 与参数描述）。
 *
 * 排序是确定性的（分数降序、同分按 id 字典序），因此可用于断言与重放
 * （#249 §9「相同输入流与预算决策记录可重放」）。
 */
export function filterCommands(
  catalog: CommandCatalog,
  query: string,
  language: 'zh' | 'en' = 'zh',
): readonly CommandMatch[] {
  void language // 显示名解析由实例呈现负责；本函数只做确定性排序（语言不改命令逻辑）
  const q = query.trim().toLowerCase()
  const matches: CommandMatch[] = []
  for (const cmd of catalog.all()) {
    const label = cmd.display.fallback ?? cmd.display.labelKey
    const id = cmd.id.toLowerCase()
    const lower = label.toLowerCase()
    if (q === '') {
      matches.push({ command: cmd, matchedOn: 'id', score: 0 })
      continue
    }
    if (id === q) matches.push({ command: cmd, matchedOn: 'id', score: 100 })
    else if (lower === q) matches.push({ command: cmd, matchedOn: 'label', score: 90 })
    else if (id.startsWith(q)) matches.push({ command: cmd, matchedOn: 'id', score: 70 })
    else if (lower.startsWith(q)) matches.push({ command: cmd, matchedOn: 'label', score: 60 })
    else if (id.includes(q)) matches.push({ command: cmd, matchedOn: 'id', score: 40 })
    else if (lower.includes(q)) matches.push({ command: cmd, matchedOn: 'label', score: 30 })
  }
  matches.sort((a, b) => (b.score - a.score) || a.command.id.localeCompare(b.command.id))
  return matches
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. 引用构造与工具
// ─────────────────────────────────────────────────────────────────────────────

/** 造一个属性引用（值语义；不夹带任何实例）。 */
export function propertyRef(
  owner: EntityRef,
  property: PropertyId,
  extra?: { element?: PropertyRef['element']; component?: number },
): PropertyRef {
  return {
    owner,
    property,
    ...(extra?.element ? { element: extra.element } : {}),
    ...(extra?.component !== undefined ? { component: extra.component } : {}),
  }
}

/** 引用列表去重（保序）—— 多选批次里同一个目标只写一次。 */
export function dedupeRefs(refs: readonly PropertyRef[]): readonly PropertyRef[] {
  const out: PropertyRef[] = []
  for (const r of refs) if (!out.some((o) => samePropertyRef(o, r))) out.push(r)
  return out
}

/** 引用是否被 `DomainError` 的关联字段指向（诊断用）。 */
export function errorReferencesObject(error: DomainError, objectId: string): boolean {
  return error.objectId === objectId || error.params.objectId === objectId
}

/** 领域错误码 → 稳定诊断键（日志与测试断言共用；不随语言变化）。 */
export function diagnosticKey(error: DomainError): string {
  const reason = error.params.reason
  return reason === undefined ? error.code : `${error.code}:${String(reason)}`
}

/** 空（无错误）时的诊断键占位，避免调用方写 `?? 'unknown'` 这种不一致口径。 */
export function diagnosticKeyOf(error: DomainError | null): string {
  return error === null ? 'none' : diagnosticKey(error)
}

/** 未使用类型占位（保持 `DomainErrorCode` 在本模块的可用性，供消费方 import）。 */
export type { DomainErrorCode }
