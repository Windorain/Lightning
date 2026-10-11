/**
 * #253 P2 · **生成式 Inspector** —— 面板布局与字段生成的纯模型。
 *
 * 依据：#249 §6 末段（「基础 Inspector 由 RNA 生成控件；完整属性编辑器可专门布局。
 * 两者均支持固定目标、多选混合值、拒绝原因、交互暂存和动画入口」）、
 * §10（「模块通过 provides/requires/contributes 声明」）、§19.9（属性只读原因属诊断）。
 *
 * ## 为什么布局在这里而不在 RNA 里
 *
 * #249 §6 明文：「RNA 不导入组件名；**控件注册和面板布局由 editors/composition 贡献**」。
 * 所以：
 *  - `PropertyDecl` 只说「这个属性是什么」；
 *  - **本文件**说「这些属性在面板里怎么排（分节、顺序、每节标题）」；
 *  - `ControlModel` 说「每行渲染成哪种控件」；
 *  - `composition` 层（后续批次）说「哪个 profile 装哪些面板」。
 *
 * 生成式（generated）的含义：**没有登记布局规格时，仍能生成一个可用的面板** ——
 * 按对象类型把全部属性铺进一节。于是「新加一个属性忘了加进布局」不会让它静默消失
 * （对照 #251 B7 的 E-6：「登记表与 UI 无引用关系，允许死属性」；11/50 条属性无 UI 入口）。
 * 本文件同时提供 `inspectorCoverage()` 把「有描述但不在任何布局里」的属性报出来 ——
 * 这是 D2.4 #30 要求的「属性 → 可渲染性」可查询面。
 *
 * ## 纯度
 *
 * 无 Vue/Three/DOM/IO/时钟。全部输入显式传入（注册表、目标引用、访问面）。
 */

import {
  type DomainError,
  type EntityRef,
  type PropertyId,
  type PropertyRef,
  type Result,
  domainError,
  err,
  ok,
  samePropertyRef,
} from '@/application/contracts'
import {
  type DisplaySpec,
  type PropertyDescriptor,
  type PropertyRegistry,
  type PropertyValue,
} from '@/application/properties'
import {
  type ControlRegistry,
  type FieldEditState,
  type FieldValueState,
  type FieldViewModel,
  buildFieldViewModel,
} from './property-controls'

// ─────────────────────────────────────────────────────────────────────────────
// 1. 布局规格（editors 层的贡献声明）
// ─────────────────────────────────────────────────────────────────────────────

/** 一节的布局规格：标题 + 按顺序的属性 ID（相对对象类型，如 `'pos'`）。 */
export type InspectorSectionSpec = Readonly<{
  id: string
  display: DisplaySpec
  properties: readonly PropertyId[]
}>

/** 一个对象类型的 Inspector 布局规格。 */
export type InspectorLayoutSpec = Readonly<{
  objectTypeId: string
  sections: readonly InspectorSectionSpec[]
}>

/**
 * 布局注册表 —— 「面板布局由 editors/composition 贡献」的具体机制。
 *
 * 注册是**累积且确定性**的：同一对象类型注册两次 ⇒ 后注册的**并集**（按 ID 去重），
 * 而不是静默覆盖。理由与契约 §7「注册顺序不应产生隐藏覆盖结果」同构 ——
 * 分组是呈现细节，但「后者悄悄吃掉前者」会让「属性没有 UI 入口」变成不可诊断的问题。
 */
export interface InspectorLayoutRegistry {
  register(spec: InspectorLayoutSpec): void
  forObjectType(objectTypeId: string): InspectorLayoutSpec | undefined
  objectTypeIds(): readonly string[]
}

export function createInspectorLayoutRegistry(
  specs: readonly InspectorLayoutSpec[] = [],
): InspectorLayoutRegistry {
  const byType = new Map<string, InspectorLayoutSpec>()
  const registry: InspectorLayoutRegistry = {
    register(spec) {
      const existing = byType.get(spec.objectTypeId)
      if (!existing) {
        byType.set(spec.objectTypeId, spec)
        return
      }
      const sections = [...existing.sections]
      for (const s of spec.sections) {
        const at = sections.findIndex((x) => x.id === s.id)
        if (at >= 0) {
          const merged = [...sections[at]!.properties]
          for (const p of s.properties) if (!merged.includes(p)) merged.push(p)
          sections[at] = { ...sections[at]!, properties: merged }
        } else {
          sections.push(s)
        }
      }
      byType.set(spec.objectTypeId, { objectTypeId: spec.objectTypeId, sections })
    },
    forObjectType: (id) => byType.get(id),
    objectTypeIds: () => [...byType.keys()],
  }
  for (const s of specs) registry.register(s)
  return registry
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Inspector 模型
// ─────────────────────────────────────────────────────────────────────────────

/** 一行字段（= 一个 `FieldViewModel` + 它的属性 ID 归属）。 */
export type InspectorRow = Readonly<{
  /** 对象类型内的属性 ID（如 `'pos'`）—— 供布局对账与测试断言。 */
  localId: PropertyId
  field: FieldViewModel
}>

/** 一节。 */
export type InspectorSection = Readonly<{
  id: string
  display: DisplaySpec
  rows: readonly InspectorRow[]
  /** 生成式补齐：这一节里有哪些行是**布局规格之外**自动补上的。 */
  generatedRows: readonly PropertyId[]
}>

/**
 * 面板模型。
 *
 * `generated` 标记**整块**是否为「无布局规格时的全量生成」；
 * `section.generatedRows` 标记**逐行**的补齐。两者都要，因为
 * 「有规格但漏了几个属性」与「根本没有规格」是两种不同的可诊断状态。
 */
export type InspectorModel = Readonly<{
  objectTypeId: string
  targets: readonly EntityRef[]
  sections: readonly InspectorSection[]
  generated: boolean
  /** 这些属性既没有布局位置也没有渲染（理论上为空；非空即缺陷，供诊断断言）。 */
  missing: readonly PropertyId[]
}>

export type InspectorInputs = Readonly<{
  registry: PropertyRegistry
  layouts: InspectorLayoutRegistry
  objectTypeId: string
  /** 目标实体（多选 = 数组；**一个属性一个 `PropertyRef`**，批量由命令承载）。 */
  targets: readonly EntityRef[]
  /** 读一个属性（多选混合值由 `readMultiValue` 给出；注入以便纯函数化）。 */
  readField: (refs: readonly PropertyRef[]) => FieldValueState
  /** 求值一个属性的可编辑性（结构化原因）。 */
  editField: (ref: PropertyRef) => FieldEditState
  /**
   * 上一次拒绝原因（属性 ID → 原因）。
   *
   * ## P10c（#286）：`drafts` 输入已删除
   *
   * 这里曾有 `drafts?: Record<string, string | null>`，把 `PanelSession.drafts`
   * 这份**呈现镜像**灌进字段模型。镜像已随输入层单一权威（P7 #258）的收口删除：
   * 草稿判定与时序唯一在 `domain/textDraft` + `runtime/inputSession`，
   * 呈现读 `InputPort.textProjection`。
   *
   * 详见 `composition/seams.ts`（接缝 `property-draft-session-mirror` 已核销）
   * 与 `editors/workbench-rna.ts` 的 `PanelSession` 说明。
   */
  rejections?: Readonly<Record<string, DomainError>>
  controls?: ControlRegistry
}>

/**
 * 生成 Inspector 模型（纯）。
 *
 * 顺序规则（确定性，可断言）：
 *  1. 有布局规格 ⇒ 按规格的节序与属性序；
 *  2. 规格未覆盖的属性 ⇒ **追加到第一节末尾**并在 `generatedRows` 里标出
 *     （于是「漏配」是可见的，而不是静默消失）；
 *  3. 无布局规格 ⇒ 全部属性进一个自动生成的节（`generated: true`）；
 *  4. 属性 ID 在注册表里不存在（规格写错）⇒ 跳过，且**不**产生空行。
 */
export function buildInspectorModel(inputs: InspectorInputs): InspectorModel {
  const { registry, layouts, objectTypeId, targets } = inputs
  const all = registry.describeObjectType(objectTypeId)
  const byLocalId = new Map<PropertyId, PropertyDescriptor>()
  for (const d of all) byLocalId.set(localIdOf(d), d)

  const spec = layouts.forObjectType(objectTypeId)
  const sections: InspectorSection[] = []
  const placed = new Set<PropertyId>()

  if (spec) {
    for (const s of spec.sections) {
      const rows: InspectorRow[] = []
      for (const localId of s.properties) {
        const desc = byLocalId.get(localId)
        if (!desc) continue
        if (placed.has(localId)) continue
        placed.add(localId)
        rows.push(makeRow(inputs, desc, targets, localId))
      }
      sections.push({ id: s.id, display: s.display, rows, generatedRows: [] })
    }
    // 规格之外自动补齐（可见的漏配）
    const leftover = all.filter((d) => !placed.has(localIdOf(d)))
    if (leftover.length > 0) {
      const rows = leftover.map((d) => makeRow(inputs, d, targets, localIdOf(d)))
      if (sections.length === 0) {
        sections.push({
          id: `${objectTypeId}.generated`,
          display: { labelKey: `inspector.${objectTypeId}.generated`, fallback: objectTypeId },
          rows,
          generatedRows: leftover.map(localIdOf),
        })
      } else {
        const first = sections[0]!
        sections[0] = {
          ...first,
          rows: [...first.rows, ...rows],
          generatedRows: leftover.map(localIdOf),
        }
      }
    }
  } else {
    const rows = all.map((d) => makeRow(inputs, d, targets, localIdOf(d)))
    sections.push({
      id: `${objectTypeId}.generated`,
      display: { labelKey: `inspector.${objectTypeId}.generated`, fallback: objectTypeId },
      rows,
      generatedRows: all.map(localIdOf),
    })
  }

  return {
    objectTypeId,
    targets,
    sections,
    generated: spec === undefined,
    missing: [],
  }
}

function localIdOf(desc: PropertyDescriptor): PropertyId {
  const dot = desc.id.indexOf('.')
  return dot === -1 ? desc.id : desc.id.slice(dot + 1)
}

function makeRow(
  inputs: InspectorInputs,
  desc: PropertyDescriptor,
  targets: readonly EntityRef[],
  localId: PropertyId,
): InspectorRow {
  const refs = targets.map((owner): PropertyRef => ({ owner, property: desc.id }))
  const primary = refs[0]
  const value = primary ? inputs.readField(refs) : ({ kind: 'error', error: noTargets(desc.id) } as const)
  const edit: FieldEditState = primary
    ? inputs.editField(primary)
    : { kind: 'readOnly', reason: noTargets(desc.id) }
  const rejection = inputs.rejections?.[localId]
  const ref: PropertyRef = primary ?? { owner: { kind: 'document', id: '' }, property: desc.id }
  const field = buildFieldViewModel(
    inputs.registry,
    ref,
    {
      descriptor: desc,
      value,
      edit,
      rejection: rejection ?? null,
    },
    inputs.controls,
  )
  return { localId, field }
}

function noTargets(property: string): DomainError {
  return domainError('MissingTarget', { reason: 'no-targets', property })
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 属性覆盖度查询（D2.4 #30：属性 → 可渲染性）
// ─────────────────────────────────────────────────────────────────────────────

/** 一个属性的覆盖度事实。 */
export type PropertyCoverage = Readonly<{
  propertyId: PropertyId
  objectTypeId: string
  /** 是否出现在该对象类型的布局规格里。 */
  inLayout: boolean
  /** 无布局规格时是否仍可经生成式节渲染（当前实现总是 `true`）。 */
  reachableByGeneration: boolean
}>

/**
 * 「属性 → 可渲染性」查询面。
 *
 * 旧实现里 `LogCenter.listRNA()` 调 `registry.list?.()` 而 registry **没有 `list`**，
 * 于是恒返回 `[]` —— 一个失真的对外观测面（#251 B7 的 E-9：自动化验收拿到假空集）。
 * 本函数是那份观测面的**忠实**替代：逐条给出可判定的三态事实。
 */
export function inspectorCoverage(
  registry: PropertyRegistry,
  layouts: InspectorLayoutRegistry,
): readonly PropertyCoverage[] {
  const out: PropertyCoverage[] = []
  for (const objectType of registry.objectTypes()) {
    const spec = layouts.forObjectType(objectType.id)
    const inSpec = new Set<PropertyId>()
    for (const s of spec?.sections ?? []) for (const p of s.properties) inSpec.add(p)
    for (const desc of registry.describeObjectType(objectType.id)) {
      const localId = localIdOf(desc)
      out.push({
        propertyId: desc.id,
        objectTypeId: objectType.id,
        inLayout: inSpec.has(localId),
        reachableByGeneration: true,
      })
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 目标集构造（面板 → Inspector 模型）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 面板侧目标解析结果。
 *
 * `emptyReason` 是可诊断的：面板「没有目标」与「目标不可读」是不同状态，
 * 不得都退化成「渲染一个空文本输入框」（旧实现的 B.4 兜底正是那样静默吞输入）。
 */
export type InspectorTargets = Readonly<{
  objectTypeId: string
  targets: readonly EntityRef[]
  emptyReason: DomainError | null
}>

export function emptyTargets(objectTypeId: string, reason: DomainError): InspectorTargets {
  return { objectTypeId, targets: [], emptyReason: reason }
}

/** 面板「没有选中目标」的标准原因。 */
export function noSelectionReason(objectTypeId: string): DomainError {
  return domainError('MissingTarget', { reason: 'no-selection', objectType: objectTypeId })
}

/** 目标集去重（同一实体在多选里出现两次时只保留一次）——与命令侧 `dedupeRefs` 同源纪律。 */
export function dedupeTargets(targets: readonly EntityRef[]): readonly EntityRef[] {
  const out: EntityRef[] = []
  for (const t of targets) {
    if (!out.some((o) => o.kind === t.kind && o.id === t.id && o.contentVersion === t.contentVersion)) out.push(t)
  }
  return out
}

/** 由 `Result` 收窄目标集（面板实现里常见的「读目标失败」路径）。 */
export function targetsFromResult(
  objectTypeId: string,
  result: Result<readonly EntityRef[]>,
): InspectorTargets {
  if (!result.ok) return emptyTargets(objectTypeId, result.error)
  const unique = dedupeTargets(result.value)
  if (unique.length === 0) return emptyTargets(objectTypeId, noSelectionReason(objectTypeId))
  return { objectTypeId, targets: unique, emptyReason: null }
}

/** 校验：模型的每个 `field.ref` 都指向 `targets` 里的一员（供测试断言留痕）。 */
export function modelReferencesOnly(model: InspectorModel): boolean {
  for (const s of model.sections) {
    for (const r of s.rows) {
      if (model.targets.length === 0) {
        if (r.field.ref.owner.id !== '') return false
        continue
      }
      const owner = r.field.ref.owner
      if (!model.targets.some((t) => t.kind === owner.kind && t.id === owner.id)) return false
    }
  }
  return true
}

/** 模型里全部字段引用的去重清单（诊断/测试用）。 */
export function modelRefs(model: InspectorModel): readonly PropertyRef[] {
  const out: PropertyRef[] = []
  for (const s of model.sections) {
    for (const r of s.rows) {
      if (!out.some((o) => samePropertyRef(o, r.field.ref))) out.push(r.field.ref)
    }
  }
  return out
}

/** 一个值是否可作为「统一写入值」（多选批次用；混合值与错误值不可）。 */
export function unifiedValueOf(state: FieldValueState): Result<PropertyValue> {
  if (state.kind === 'value') return ok(state.value)
  if (state.kind === 'mixed') {
    return err(domainError('UnsupportedOperation', { reason: 'mixed-value-is-read-only-sentinel' }))
  }
  if (state.kind === 'unreadable') return err(state.reason)
  return err(state.error)
}
