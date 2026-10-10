/**
 * #253 P2 · **RNA 与运行时的接线桥**（`editors/` 层）。
 *
 * 这是「纯核心」与「活的 Context」之间**唯一**的耦合点。它的存在是为了让
 * `application/properties.ts`、`application/property-commands.ts`、`editors/inspector.ts`、
 * `editors/property-controls.ts` 全部保持**纯**（显式输入、无 Vue/Three/DOM/IO）：
 * 凡需要读文档、读选中集、读能力、拿版本、提交命令的地方，都汇聚到本文件，
 * 由它构造 `PropertyAccess` / `InspectorContextInputs` / 提交动作。
 *
 * ## 本文件里允许出现什么、不允许出现什么
 *
 * 允许：读 `Context`、`clone()` 文档、把命令交给 operator 门面、读写 Vue `ref`。
 * 不允许：**任何业务判据**。合法性、可编辑性、值域、多选原子性、草稿是否可提交，
 * 全部在纯函数里；这里只做「查事实 → 传值 → 转发结果」。
 *
 * 这是 #249 §2.1 的分工：接线层只协调调用、调度、端口与资源。
 *
 * ## 退役 #3 的落点：前缀分派在这里**不存在**
 *
 * 旧实现的三条写路径里，两条靠 `rnaPath` 字符串前缀（`wikiconfig.` / `toolsettings.`）
 * 选 operator，一条直接 `descriptor.set(owner, v)` 写内存。新形态下：
 *
 *  - 目标由 `resolveRefs(descriptor)` 从**选中集**算出（不是从 `rnaPath` 猜）；
 *  - 写入经 `submitSetProperty`（唯一写路由）→ 按**对象类型注册的纯函数**落状态；
 *  - 落状态的结果写回运行时（文档 → `main.replaceDoc`，壳设置 → 对应 ref）。
 *
 * 因此「写到哪里」由**对象类型**决定，不由属性名的字符串前缀决定 ——
 * 新增一种对象类型不需要动这里的任何 `if`（D4）。
 */

import type { Context } from '@/runtime/context'
import { computed, type ComputedRef } from 'vue'
import {
  type CommandOutcome,
  type DomainError,
  type PropertyRef,
  type Result,
  type Version,
  domainError,
  err,
  ok,
} from '@/application/contracts'
import {
  type CapabilityId,
  type PropertyAccess,
  type PropertyDescriptor,
  type PropertyRegistry,
  type PropertyValue,
  type TargetFacts,
  CAP_PROPERTY_WRITE,
  createDefaultPropertyRegistry,
} from '@/application/properties'
import {
  type MultiReadResult,
  type PropertyWritePorts,
  applySetProperty,
  readMultiValue,
} from '@/application/property-commands'
import {
  DEFAULT_EDIT_POLICY,
  type EditPolicy,
  type EditSession,
  type FieldEditState,
  type FieldValueState,
  buildFieldViewModel,
} from './property-controls'
import {
  type DocumentState,
  createWorkbenchWritePorts,
  localPropertyOf,
} from './property-writers'
import {
  type InspectorContextInputs,
  type PanelSelection,
  OBJECT_TYPE,
  PROPERTY_OBJECT_TYPES,
  annotationObjectTypeId,
  buildWorkbenchInspector,
  editStateOf,
  factsOf,
  rejectionSummary,
  resolveInspectorTargets,
} from './workbench-inspector'
import type { InspectorModel } from './inspector'
import { createWorkbenchInspectorLayouts } from './workbench-inspector'

// ─────────────────────────────────────────────────────────────────────────────
// 1. 注册表（每棵树一份；对象类型由各贡献文件登记）
// ─────────────────────────────────────────────────────────────────────────────

/** 造一个登记了本批全部对象类型的注册表。 */
export function createWorkbenchPropertyRegistry(): { registry: PropertyRegistry; errors: readonly DomainError[] } {
  const registry = createDefaultPropertyRegistry()
  const errors: DomainError[] = []
  for (const decl of PROPERTY_OBJECT_TYPES) {
    const r = registry.registerObjectType(decl)
    if (!r.ok) errors.push(r.error)
  }
  return { registry, errors }
}

/** 读运行时版本（`documentVersion` 用结构纪元 + 帧索引的组合，内容版本用 `structEpoch`）。 */
export function versionOf(ctx: Context): Version {
  return {
    documentVersion: ctx.getStructEpoch().value,
    contentVersion: ctx.getCurrentFrameIndex().value,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 选中集 → 目标引用
// ─────────────────────────────────────────────────────────────────────────────

/** 从选中集抽出面板可用的选择事实（不判定，只读）。 */
export function selectionOf(ctx: Context): PanelSelection {
  const items: { kind: 'block' | 'annotation'; id: string }[] = []
  for (const e of ctx.getSelection().items.value) {
    if (e.kind === 'block') {
      const p = e.ref.pos
      items.push({ kind: 'block', id: `${p.x},${p.y},${p.z}` })
    } else {
      // 注解项**不带 `ref`**：`{ kind, id, type }` 直接是实体本身（`context/selection.ts:19`）。
      items.push({ kind: 'annotation', id: e.id })
    }
  }
  const hoveredAnno = ctx.getHoveredAnnotationId().value
  return {
    items,
    active: hoveredAnno,
    annotationTypeOf: (id) => {
      const doc = ctx.getDoc().value
      const list = (doc?.annotations ?? []) as { id?: string; type?: string }[]
      return list.find((a) => a.id === id)?.type ?? null
    },
  }
}

/**
 * 属性描述 → 目标引用集（面板与命令共用）。
 *
 * 目标来自**选中集**，按描述所属对象类型的 `ownerKind` 过滤：
 * 因此「选中的是注解、面板却要写方块属性」不会静默写到错误对象上。
 */
export function resolveRefs(ctx: Context, desc: PropertyDescriptor): readonly PropertyRef[] {
  const objectType = workbenchRegistry().registry.objectType(desc.objectTypeId)
  const kind = objectType?.ownerKind
  const refs: PropertyRef[] = []

  if (kind === 'block') {
    for (const e of ctx.getSelection().items.value) {
      if (e.kind !== 'block') continue
      const p = e.ref.pos
      refs.push({ owner: { kind: 'block', id: `${p.x},${p.y},${p.z}` }, property: desc.id })
    }
    // 无选中但有悬停方块 ⇒ 以悬停为单目标（与注解面板的悬停语义一致）
    if (refs.length === 0) {
      const h = ctx.getHoveredBlock().value
      if (h) refs.push({ owner: { kind: 'block', id: `${h.pos.x},${h.pos.y},${h.pos.z}` }, property: desc.id })
    }
    return refs
  }

  if (kind === 'annotation') {
    for (const e of ctx.getSelection().items.value) {
      if (e.kind !== 'annotation') continue
      refs.push({ owner: { kind: 'annotation', id: e.id }, property: desc.id })
    }
    if (refs.length === 0) {
      const hid = ctx.getHoveredAnnotationId().value
      if (hid) refs.push({ owner: { kind: 'annotation', id: hid }, property: desc.id })
    }
    return refs
  }

  if (kind === 'document') {
    const doc = ctx.getDoc().value
    if (doc) refs.push({ owner: { kind: 'document', id: 'document' }, property: desc.id })
    return refs
  }

  if (kind === 'shellSettings' || kind === 'toolSettings') {
    refs.push({ owner: { kind: kind as string, id: kind as string }, property: desc.id })
    return refs
  }

  return refs
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 读面桥（原始值 → 结构化值）
// ─────────────────────────────────────────────────────────────────────────────

/** 读一个属性的原始值（**不校验**；校验由 RNA 核心统一做）。 */
export function readRawValue(ctx: Context, ref: PropertyRef): Result<unknown> {
  const local = localPropertyOf(ref.property)
  const desc = workbenchRegistry().registry.descriptor(ref.property)
  const objectType = desc ? workbenchRegistry().registry.objectType(desc.objectTypeId) : undefined
  const kind = objectType?.ownerKind

  if (kind === 'block') {
    const doc = ctx.getDoc().value
    const grid = doc?.frame(0)?.grid
    if (!grid) return err(domainError('MissingTarget', { reason: 'no-frame', objectId: ref.owner.id }))
    const [x, y, z] = ref.owner.id.split(',').map(Number)
    const block = grid.at({ x: x ?? 0, y: y ?? 0, z: z ?? 0 })
    if (!block) return err(domainError('MissingTarget', { reason: 'block-absent', objectId: ref.owner.id }))
    switch (local) {
      case 'id':
        return ok(`minecraft:${block.name}:${block.meta}`)
      case 'pos':
        return ok({ x: x ?? 0, y: y ?? 0, z: z ?? 0 })
      case 'tooltip':
      case 'cellTooltip': {
        const grid2 = doc as unknown as { tooltipPalette?: string[]; cellTooltipGrid?: number[][][] }
        const at = grid2.cellTooltipGrid?.[z ?? 0]?.[y ?? 0]?.[x ?? 0]
        if (at === undefined || at < 0) return ok('')
        return ok(grid2.tooltipPalette?.[at] ?? '')
      }
      default:
        return err(domainError('MissingTarget', { reason: 'property-not-registered', property: ref.property }))
    }
  }

  if (kind === 'annotation') {
    const doc = ctx.getDoc().value
    const list = (doc?.annotations ?? []) as Record<string, unknown>[]
    const a = list.find((x) => x.id === ref.owner.id)
    if (!a) return err(domainError('MissingTarget', { reason: 'annotation-absent', objectId: ref.owner.id }))
    const v = a[local]
    if (v === undefined) return err(domainError('MissingTarget', { reason: 'value-absent', property: ref.property }))
    return ok(v)
  }

  if (kind === 'document') {
    const doc = ctx.getDoc().value
    if (!doc) return err(domainError('MissingTarget', { reason: 'no-document' }))
    switch (local) {
      case 'name':
      case 'author':
      case 'description':
        return ok((doc.meta as Record<string, unknown>)[local] ?? '')
      case 'tags': {
        const tags = (doc.meta as Record<string, unknown>).tags
        return ok(Array.isArray(tags) ? tags : [])
      }
      case 'origin': {
        const o = (doc.meta as Record<string, unknown>).origin
        return ok(o && typeof o === 'object' ? o : { x: 0, y: 0, z: 0 })
      }
      case 'created_at': {
        const ms = (doc.meta as Record<string, unknown>).created_at_ms
        return ok(typeof ms === 'number' ? new Date(ms).toLocaleString() : '')
      }
      case 'format_version':
        return ok(doc.formatVersion ?? '')
      default:
        return err(domainError('MissingTarget', { reason: 'property-not-registered', property: ref.property }))
    }
  }

  if (kind === 'shellSettings') {
    const pub = ctx.main.embedPublish.value as unknown as Record<string, unknown>
    const features = (pub.features ?? {}) as Record<string, unknown>
    const FEATURE_KEYS: Record<string, string> = {
      showStats: 'blockStatsSidebar',
      showLayerBar: 'layerBar',
      showFrameControls: 'frameControls',
      showTitle: 'titleBar',
      showDebugStatus: 'debugStatusBar',
      showAxesGizmo: 'showAxesGizmo',
    }
    if (local === 'viewWidth' || local === 'viewHeight' || local === 'sceneBackgroundHex') {
      const v = pub[local]
      if (v === undefined) return err(domainError('MissingTarget', { reason: 'value-absent', property: ref.property }))
      return ok(v)
    }
    const featureKey = FEATURE_KEYS[local]
    if (featureKey) return ok(features[featureKey] ?? false)
    return err(domainError('MissingTarget', { reason: 'property-not-registered', property: ref.property }))
  }

  if (kind === 'toolSettings') {
    const tool = ctx.getToolSettings()
    switch (local) {
      case 'replaceBrush':
        return ok(tool.replaceBrush.value ?? '')
      case 'fillBrush':
        return ok(tool.fillBrush.value ?? '')
      case 'generateType':
        return ok(tool.generateType.value ?? '')
      case 'snapEnabled':
        return ok(tool.snapEnabled.value)
      case 'dragSensitivity':
        return ok(tool.dragSensitivity)
      default:
        return err(domainError('MissingTarget', { reason: 'property-not-registered', property: ref.property }))
    }
  }

  if (kind === 'asset') {
    return err(domainError('ReadOnly', { reason: 'query-result', property: ref.property }))
  }

  return err(domainError('MissingTarget', { reason: 'owner-kind-unsupported', objectId: ref.owner.id }))
}

/**
 * 目标事实 —— 可编辑性的**状态**输入（#253「动态求值」的数据面）。
 *
 * 这里逐条查真实状态，而不是读一个静态 `readOnly` 布尔：
 *  - `exists`：目标是否还在文档中；
 *  - `generated`：多方块文档的网格是**装配产物** ⇒ 只读（#249 §3.3「不编辑生成结果」）；
 *  - `drivenByTrack`：本批尚无轨道（#255 才注册）⇒ 恒 false，但**通道已在**；
 *  - `locked`：注解自身的 `locked` 字段；
 *  - `holdsLease`：本批没有并发租约（P1 的职责）⇒ true，但同样是显式输入而非省略。
 */
export function targetFacts(ctx: Context, ref: PropertyRef): TargetFacts {
  const local = localPropertyOf(ref.property)
  const desc = workbenchRegistry().registry.descriptor(ref.property)
  const objectType = desc ? workbenchRegistry().registry.objectType(desc.objectTypeId) : undefined
  const kind = objectType?.ownerKind
  const doc = ctx.getDoc().value
  const multiblockReadOnly = isMultiblockGenerated(doc)

  if (kind === 'block') {
    if (!doc) return factsOf({ exists: false })
    const grid = doc.frame(0)?.grid
    const [x, y, z] = ref.owner.id.split(',').map(Number)
    const exists = grid?.at({ x: x ?? 0, y: y ?? 0, z: z ?? 0 }) != null
    return factsOf({
      exists,
      generated: multiblockReadOnly,
      holdsLease: !multiblockReadOnly,
      contentVersion: ctx.getStructEpoch().value,
    })
  }

  if (kind === 'annotation') {
    const list = (doc?.annotations ?? []) as Record<string, unknown>[]
    const a = list.find((x) => x.id === ref.owner.id)
    if (!a) return factsOf({ exists: false })
    const locked = local !== 'locked' && a.locked === true
    return factsOf({
      exists: true,
      generated: false,
      locked,
      holdsLease: true,
      contentVersion: ctx.getStructEpoch().value,
    })
  }

  if (kind === 'document') {
    if (!doc) return factsOf({ exists: false })
    return factsOf({ exists: true, generated: multiblockReadOnly, holdsLease: !multiblockReadOnly })
  }

  if (kind === 'shellSettings' || kind === 'toolSettings') {
    return factsOf({ exists: true, holdsLease: true })
  }

  return factsOf({ exists: false })
}

/** 多方块文档的网格是装配产物 ⇒ 只读（#249 §3.3）。 */
function isMultiblockGenerated(doc: { multiblock?: unknown; documentShape?: unknown } | null): boolean {
  if (!doc) return false
  return doc.multiblock != null
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. PropertyAccess 构造（读写共用同一份事实与版本）
// ─────────────────────────────────────────────────────────────────────────────

export function accessOfContext(ctx: Context, capabilities?: ReadonlySet<CapabilityId>): PropertyAccess {
  return {
    version: versionOf(ctx),
    readRaw: (ref) => readRawValue(ctx, ref),
    facts: (ref) => targetFacts(ctx, ref),
    capabilities: capabilities ?? defaultCapabilities(ctx),
    language: ctx.getShellSettings().lang.value,
  }
}

/**
 * 构建/实例能力（A15：查看器不安装写入能力 ⇒ **运行时**拒绝，而不只是隐藏按钮）。
 */
export function defaultCapabilities(ctx: Context): ReadonlySet<CapabilityId> {
  const caps = new Set<CapabilityId>()
  // 嵌入预览（`data-wsr-*`）是**只读**呈现：不给写能力。
  if (!ctx.isEmbed()) caps.add(CAP_PROPERTY_WRITE)
  return caps
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. 写面桥（唯一写路由 → 运行时状态）
// ─────────────────────────────────────────────────────────────────────────────

/** 每棵树的单例（注册表、布局、写端口）——**初始化一次**，不是每次渲染重建。 */
type WorkbenchRna = {
  registry: PropertyRegistry
  layouts: ReturnType<typeof createWorkbenchInspectorLayouts>
  ports: PropertyWritePorts<DocumentState>
  errors: readonly DomainError[]
}

let cached: WorkbenchRna | null = null

export function workbenchRegistry(): WorkbenchRna {
  if (cached) return cached
  const { registry, errors } = createWorkbenchPropertyRegistry()
  cached = {
    registry,
    layouts: createWorkbenchInspectorLayouts(),
    ports: createWorkbenchWritePorts(),
    errors,
  }
  return cached
}

/** 快照当前文档与壳状态为可写的 `DocumentState`。 */
export function documentStateOf(ctx: Context): DocumentState {
  const doc = ctx.getDoc().value
  const shell: Record<string, unknown> = {}
  const pub = ctx.main.embedPublish.value as unknown as Record<string, unknown>
  shell.shellSettings = { ...pub, features: { ...((pub.features ?? {}) as Record<string, unknown>) } }
  const tool = ctx.getToolSettings()
  shell.toolSettings = {
    replaceBrush: tool.replaceBrush.value ?? '',
    fillBrush: tool.fillBrush.value ?? '',
    generateType: tool.generateType.value ?? '',
    snapEnabled: tool.snapEnabled.value,
    dragSensitivity: tool.dragSensitivity,
  }
  return {
    version: versionOf(ctx),
    // 没有文档时给一个占位：写入会被可编辑性/描述解析先行拒绝（`exists:false`）。
    document: doc as never,
    shell,
  }
}

/**
 * 提交一次属性写 —— **唯一写路由的入口**（面板、脚本、命令搜索共用）。
 *
 * 流程：
 *  1. 从当前 ctx 造 `DocumentState` 与 `PropertyAccess`（同一份事实）；
 *  2. 调 `applySetProperty`（纯，多选原子）；
 *  3. **仅当** `applied` 时把候选状态写回运行时（文档经 `replaceDoc`，壳设置写 ref）。
 *
 * 第 3 步是「拒绝后不得报告 applied」的落地：`rejected`/`unchanged` 时**什么都不写**，
 * 于是文档、历史与脏状态不变（契约 §5.2）。
 */
export function submitPropertyWrite(
  ctx: Context,
  refs: readonly PropertyRef[],
  value: PropertyValue,
  commandId?: string,
): CommandOutcome {
  const { registry, ports } = workbenchRegistry()
  const access = accessOfContext(ctx)
  const state = documentStateOf(ctx)
  if (state.document == null) {
    return { status: 'rejected', error: domainError('MissingTarget', { reason: 'no-document' }) }
  }

  const transition = applySetProperty<DocumentState>({
    registry,
    ports,
    state,
    command: {
      kind: 'setProperty',
      refs,
      value,
      ...(commandId ? { commandId } : {}),
    },
    env: { baseVersion: access.version, currentVersion: access.version },
    access,
  })

  if (transition.outcome.status !== 'applied') return transition.outcome

  // 文档内容变化 ⇒ 经具名写回路径（`replaceDoc` 会 bump 结构纪元，触发重绘）。
  const nextDoc = transition.candidate.document
  if (nextDoc !== state.document) {
    ctx.main.replaceDoc(nextDoc, { bumpStructEpoch: true, resetFrameIndex: false })
  }
  applyShellState(ctx, state, transition.candidate)
  return transition.outcome
}

/** 壳设置写回（发布配置 / 工具参数）——不进文档历史（契约 §6.4）。 */
function applyShellState(ctx: Context, before: DocumentState, after: DocumentState): void {
  if (after.shell === before.shell) return
  const pub = after.shell.shellSettings as Record<string, unknown> | undefined
  if (pub) {
    const cur = ctx.main.embedPublish.value
    ctx.main.embedPublish.value = {
      ...cur,
      viewWidth: Number(pub.viewWidth ?? cur.viewWidth),
      viewHeight: Number(pub.viewHeight ?? cur.viewHeight),
      sceneBackgroundHex: String(pub.sceneBackgroundHex ?? cur.sceneBackgroundHex),
      features: { ...cur.features, ...((pub.features ?? {}) as Record<string, unknown>) },
    } as typeof cur
  }
  const tool = after.shell.toolSettings as Record<string, unknown> | undefined
  if (tool) {
    const t = ctx.getToolSettings()
    if (typeof tool.replaceBrush === 'string') t.replaceBrush.value = tool.replaceBrush === '' ? null : tool.replaceBrush
    if (typeof tool.fillBrush === 'string') t.fillBrush.value = tool.fillBrush === '' ? null : tool.fillBrush
    if (typeof tool.generateType === 'string') t.generateType.value = tool.generateType === '' ? null : tool.generateType
    if (typeof tool.snapEnabled === 'boolean') t.snapEnabled.value = tool.snapEnabled
    if (typeof tool.dragSensitivity === 'number') t.dragSensitivity = tool.dragSensitivity
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. 字段视图模型（面板渲染的唯一输入）
// ─────────────────────────────────────────────────────────────────────────────

/** 面板会话状态（草稿 + 拒绝原因）——按属性 ID 索引，跨重渲染保留。 */
export type PanelSession = {
  drafts: Record<string, string | null>
  rejections: Record<string, DomainError>
  sessions: Record<string, EditSession>
}

export function createPanelSession(): PanelSession {
  return { drafts: {}, rejections: {}, sessions: {} }
}

/** 多选读面 → 字段读状态（显式混合值）。 */
export function readFieldState(ctx: Context, desc: PropertyDescriptor): FieldValueState {
  const refs = resolveRefs(ctx, desc)
  if (refs.length === 0) {
    return { kind: 'error', error: domainError('MissingTarget', { reason: 'no-targets', property: desc.id }) }
  }
  const multi: MultiReadResult = readMultiValue(workbenchRegistry().registry, refs, 'authored', accessOfContext(ctx))
  switch (multi.kind) {
    case 'value':
      return { kind: 'value', value: multi.value }
    case 'mixed':
      return { kind: 'mixed', refs: multi.refs }
    case 'error':
      return { kind: 'error', error: multi.error }
  }
}

/** 一个属性在某面板会话下的完整字段模型。 */
export function buildField(
  ctx: Context,
  desc: PropertyDescriptor,
  session: PanelSession,
): ReturnType<typeof buildFieldViewModel> {
  const refs = resolveRefs(ctx, desc)
  const ref: PropertyRef = refs[0] ?? { owner: { kind: 'document', id: '' }, property: desc.id }
  const value = readFieldState(ctx, desc)
  const edit: FieldEditState = refs.length === 0
    ? { kind: 'readOnly', reason: domainError('MissingTarget', { reason: 'no-selection', property: desc.id }) }
    : editStateOf(workbenchRegistry().registry, ref, accessOfContext(ctx))
  const local = localPropertyOf(desc.id)
  const field = buildFieldViewModel(workbenchRegistry().registry, ref, {
    descriptor: desc,
    value,
    edit,
    draft: session.drafts[local] ?? null,
    rejection: session.rejections[local] ?? null,
  })
  return field
}

/** 面板会话的提交动作（草稿 → 唯一写路由；**不是** setter 闭包）。 */
export function commitFieldValue(ctx: Context, desc: PropertyDescriptor, value: PropertyValue): CommandOutcome {
  const refs = resolveRefs(ctx, desc)
  if (refs.length === 0) return { status: 'rejected', error: domainError('MissingTarget', { reason: 'no-targets' }) }
  return submitPropertyWrite(ctx, refs, value, `set:${desc.id}`)
}

/** 提交某个分量（`component` 寻址；其余分量由写入函数保持）。 */
export function commitFieldComponent(
  ctx: Context,
  desc: PropertyDescriptor,
  index: number,
  value: number,
): CommandOutcome {
  const refs = resolveRefs(ctx, desc).map((r): PropertyRef => ({ ...r, component: index }))
  if (refs.length === 0) return { status: 'rejected', error: domainError('MissingTarget', { reason: 'no-targets' }) }
  return submitPropertyWrite(ctx, refs, value, `set:${desc.id}[${index}]`)
}

export { DEFAULT_EDIT_POLICY }
export type { EditPolicy }

/** 面板生成式模型的输入（把 ctx 事实一次性收齐，之后交给纯函数）。 */
export function inspectorInputs(ctx: Context, session: PanelSession): InspectorContextInputs {
  const targets = resolveInspectorTargets(selectionOf(ctx))
  return {
    registry: workbenchRegistry().registry,
    layouts: workbenchRegistry().layouts,
    targets,
    access: accessOfContext(ctx),
    readField: (refs) => readMultiValue(workbenchRegistry().registry, refs, 'authored', accessOfContext(ctx)),
    drafts: session.drafts,
    rejections: session.rejections,
  }
}

/** 生成 Inspector 模型（面板渲染用）。 */
export function buildInspector(ctx: Context, session: PanelSession): InspectorModel {
  return buildWorkbenchInspector(inspectorInputs(ctx, session))
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. 覆盖度与诊断（观测面）
// ─────────────────────────────────────────────────────────────────────────────

/** 「属性 → 可渲染性」查询（替代恒返回 `[]` 的旧 `listRNA`）。 */
export function rnaCoverage(): readonly { propertyId: string; objectTypeId: string; inLayout: boolean }[] {
  const { registry, layouts } = workbenchRegistry()
  const out: { propertyId: string; objectTypeId: string; inLayout: boolean }[] = []
  for (const objectType of registry.objectTypes()) {
    const spec = layouts.forObjectType(objectType.id)
    const inSpec = new Set<string>()
    for (const s of spec?.sections ?? []) for (const p of s.properties) inSpec.add(p)
    for (const desc of registry.describeObjectType(objectType.id)) {
      out.push({
        propertyId: desc.id,
        objectTypeId: objectType.id,
        inLayout: inSpec.has(localPropertyOf(desc.id)),
      })
    }
  }
  return out
}

/** 声明了但**没有写入端口**的可写对象类型（启动期即可发现的装配缺陷）。 */
export function unhandledWritableTypes(): readonly string[] {
  const { ports } = workbenchRegistry()
  const handled = new Set(ports.objectTypeIds())
  return Object.values(OBJECT_TYPE).filter((id) => !handled.has(id) && id !== OBJECT_TYPE.materialView)
}

/** 某属性当前的只读原因（诊断面；`null` 表示此刻可写）。 */
export function readOnlyReasonFor(ctx: Context, desc: PropertyDescriptor): DomainError | null {
  const refs = resolveRefs(ctx, desc)
  const ref = refs[0]
  if (!ref) return domainError('MissingTarget', { reason: 'no-selection', property: desc.id })
  const e = editStateOf(workbenchRegistry().registry, ref, accessOfContext(ctx))
  return e.kind === 'readOnly' ? e.reason : null
}

export { annotationObjectTypeId, rejectionSummary, factsOf }

/** 便利：把 `Result` 的原始值读面暴露给诊断（`LogCenter.getRNA` 用）。 */
export function describeForDiagnostics(ctx: Context, propertyId: string) {
  const desc = workbenchRegistry().registry.descriptor(propertyId)
  if (!desc) return null
  const refs = resolveRefs(ctx, desc)
  const ref = refs[0]
  const raw: Result<unknown> = ref ? readRawValue(ctx, ref) : err(domainError('MissingTarget', { reason: 'no-targets' }))
  const multi = ref ? readFieldState(ctx, desc) : null
  return {
    propertyId,
    objectTypeId: desc.objectTypeId,
    valueType: desc.valueType,
    animatable: desc.animatable,
    readOnly: desc.readOnly,
    liveReadOnlyReason: readOnlyReasonFor(ctx, desc),
    value: raw.ok ? raw.value : null,
    readError: raw.ok ? null : raw.error,
    mixed: multi?.kind === 'mixed',
    targets: refs.length,
    coverage: rnaCoverage().find((c) => c.propertyId === propertyId)?.inLayout ?? false,
  }
}

/** 面板会话的字段模型缓存（组合式；组件用一次、纯函数算一次）。 */
export function useInspectorModel(ctx: Context, session: PanelSession): ComputedRef<InspectorModel> {
  return computed(() => buildInspector(ctx, session))
}
