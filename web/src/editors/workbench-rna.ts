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
import { localPropertyOf } from '@/application/contracts'
import { KERNEL_ANNOTATION_TYPE } from '@/application/kernel-properties'
import { KERNEL_CONTEXT_ID } from '@/runtime/kernelSession'
import { annotationObjectIdOf } from '@/runtime/annotationRead'
import type { DocumentMetadata } from '@/domain/content'
import { NO_CHANGE } from '@/domain/identity'
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
  type FieldEditState,
  type FieldValueState,
  buildFieldViewModel,
} from './property-controls'
import {
  type DocumentState,
  createWorkbenchWritePorts,
  parseBlockStateId,
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
  sceneKindOf,
  contractKindOf,
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

/**
 * 读运行时版本（旧文档桥的版本映射；原登记 `kernel-property-write-dual-track`
 * 已于 R1-β① C3 核销 —— 本函数仍在，因为**版本读面**是面板与写命令的公共输入）。
 *
 * ## P10 #261 修正：`contentVersion` **不再**取帧下标
 *
 * 旧实现是：
 *
 * ```ts
 * contentVersion: ctx.getCurrentFrameIndex().value   // ← 帧下标当内容版本
 * ```
 *
 * 那是**语义错误**，且在本批之前不可见：帧下标当时是一个"只有显式换帧才变"
 * 的独立权威，于是它恰好表现为一个粗粒度的内容计数器。本批把帧下标改为
 * 由 `EditContext.time` **派生**之后，这个错误立刻显形 ——
 * **播放会让 `contentVersion` 每帧都变**，于是：
 *  - `isDirty` 判"内容与保存基线不同" ⇒ 播放把文档标脏（违反 #249 §7）；
 *  - `pushHistory` 的 `sameContent` 判据被播放推进 ⇒ 产生幽灵历史（违反 A06）。
 *
 * ⇒ 改用 `contentRefreshTick`：它是**内容确实变了**的唯一信号
 * （`Main.replaceDoc` 与 `Main.requestContentRefresh` 都 bump 它，
 * 而播放**不**碰它）。于是"播放不弄脏文档"重新成立。
 *
 * ## 这是**有损**映射，且如实登记（不假装它等价于内核版本）
 *
 * 内核的 `Version` 要求 `documentVersion` 单调推进、`contentVersion` 是
 * **内容摘要**（用于与保存基线比较相等）。本函数两者都取同一个粗粒度计数器，
 * 因此：
 *  - ✅ "内容变 ⇒ 版本变"成立（该计数器只在内容变化时变）；
 *  - ❌ "内容回到已提交状态 ⇒ contentVersion 相等"**不**成立
 *    （计数器只增不减，撤销回原内容后仍不相等）。
 *
 * 后者是这条接缝的真实代价：它由接缝的退出（工作台文档迁到内核
 * `Document`，届时版本由 `domain/document#withContent` 的**内容身份**给出）
 * 一并消除。在那之前，`contentVersion` 在这条旧桥上只是"变过没有"的标记，
 * 而**不是**内容身份 —— 本注释是这一事实的唯一登记点，避免下游误以为
 * 它可以用来判"内容是否回到基线"。
 */
export function versionOf(ctx: Context): Version {
  const tick = ctx.getContentRefreshTick().value
  return {
    documentVersion: tick,
    contentVersion: tick,
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
      // #301 P10f D3（R2）：注解表走内核注解读面（15 字段；含 `type`）。
      return ctx.kernelAnnotations().find((a) => a.id === id)?.type ?? null
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
  // 冻结 #2：'block'/'annotation' 是**场景对象种类**（由 objectTypeId 推出），
  // 不是 owner.kind —— 后者的场景对象一律 'object'。
  const kind = objectType ? sceneKindOf(objectType.id) : null
  const refs: PropertyRef[] = []

  if (kind === 'block') {
    for (const e of ctx.getSelection().items.value) {
      if (e.kind !== 'block') continue
      const p = e.ref.pos
      refs.push({ owner: { kind: 'object', id: `${p.x},${p.y},${p.z}` }, property: desc.id })
    }
    // 无选中但有悬停方块 ⇒ 以悬停为单目标（与注解面板的悬停语义一致）
    if (refs.length === 0) {
      const h = ctx.getHoveredBlock().value
      if (h) refs.push({ owner: { kind: 'object', id: `${h.pos.x},${h.pos.y},${h.pos.z}` }, property: desc.id })
    }
    return refs
  }

  if (kind === 'annotation') {
    for (const e of ctx.getSelection().items.value) {
      if (e.kind !== 'annotation') continue
      refs.push({ owner: { kind: 'object', id: e.id }, property: desc.id })
    }
    if (refs.length === 0) {
      const hid = ctx.getHoveredAnnotationId().value
      if (hid) refs.push({ owner: { kind: 'object', id: hid }, property: desc.id })
    }
    return refs
  }

  if (kind === 'document') {
    // #301 P10f C′1（N1）：纯存在性 ⇒ GF-15 读面（B′ 已证不变量）。
    if (ctx.hasLoadedDocument()) refs.push({ owner: { kind: 'document', id: 'document' }, property: desc.id })
    return refs
  }

  // 非场景对象（发布配置 = workspace、工具参数 = editContext）：
  // owner.kind 取契约 §1.1 的种类，id 用对象类型 ID（本批每类只有一个实例）。
  if (objectType) {
    const ownerKind = contractKindOf(objectType.id)
    if (ownerKind !== 'object') {
      refs.push({ owner: { kind: ownerKind, id: objectType.id }, property: desc.id })
      return refs
    }
  }

  return refs
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 读面桥（原始值 → 结构化值）
// ─────────────────────────────────────────────────────────────────────────────

/** 读一个属性的原始值（**不校验**；校验由 RNA 核心统一做）。 */
export function readRawValue(ctx: Context, ref: PropertyRef): Result<unknown> {
  const desc = workbenchRegistry().registry.descriptor(ref.property)
  const objectType = desc ? workbenchRegistry().registry.objectType(desc.objectTypeId) : undefined
  // 局部名必须用 `objectTypeId` 剥离（属性 ID 形如 `lightning.block.pos`）。
  const local = localPropertyOf(ref.property, desc?.objectTypeId)
  // 场景对象种类（block/annotation）—— 只用于"是不是场景对象"的分支。
  const sceneKind = objectType ? sceneKindOf(objectType.id) : null
  // 契约 §1.1 的 owner kind —— 用于非场景对象的分支（document/workspace/editContext/asset）。
  const ownerKind = objectType ? contractKindOf(objectType.id) : null

  if (sceneKind === 'block') {
    // #301 P10f D3（R5）：网格读面。⚠️ 帧下标**逐字保留 `0`**（旧实现就是 `frame(0)`）——
    // 多方块文档"一变体一帧"，改读当前帧会**静默改语义**（不是同义迁移）。
    const grid = ctx.kernelGrid(0)
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
        // #301 P10f D3（R6）：逐格说明走**自己的**读面（侧表不在网格上 ⇒
        // `kernelGrid.tooltipAt` 在 legacy 分支无从回答，见 `runtime/gridRead` 文件头）。
        const tips = ctx.cellTooltips()
        const at = tips?.grid[z ?? 0]?.[y ?? 0]?.[x ?? 0]
        if (at === undefined || at < 0) return ok('')
        return ok(tips?.palette[at] ?? '')
      }
      default:
        return err(domainError('MissingTarget', { reason: 'property-not-registered', property: ref.property }))
    }
  }

  if (sceneKind === 'annotation') {
    // #301 P10f D3（R2）：注解属性读走内核注解读面。
    // ⚠️ 读面是**封闭 15 字段**表（`runtime/annotationRead` 的 `ANNOTATION_FIELD_PAIRS`）；
    // RNA 描述符里的宽字段（`renderOpacity`/`fillOpacity`/`frameThickness`/`overlay`/
    // `icon`/`size`/…）**不在**读面的命名空间里（读面用 legacy 口径名，见其字段表）。
    // ⇒ 未命中时**如实失败**（`value-absent`），**不**伪造值也不静默回落旧文档：
    // 读面本就是"这一刻（内核或 legacy）的事实"，编一个值比失败更坏。
    // 该收窄已登记：`composition/seams.ts` 的 `annotation-wide-field-face`。
    const view = ctx.kernelAnnotations().find((x) => x.id === ref.owner.id)
    if (!view) return err(domainError('MissingTarget', { reason: 'annotation-absent', objectId: ref.owner.id }))
    const v = (view as unknown as Record<string, unknown>)[local]
    if (v === undefined) return err(domainError('MissingTarget', { reason: 'value-absent', property: ref.property }))
    return ok(v)
  }

  if (ownerKind === 'document') {
    if (!ctx.hasLoadedDocument()) return err(domainError('MissingTarget', { reason: 'no-document' }))
    // #301 P10f D3（R7）：文档元数据读面（内核 `DocumentContent.metadata` 优先）。
    const meta = ctx.documentMetadata()
    switch (local) {
      case 'name':
        return ok(meta.name)
      case 'author':
        return ok(meta.author)
      case 'description':
        return ok(meta.description)
      case 'tags':
        return ok([...meta.tags])
      case 'origin':
        return ok(meta.origin)
      case 'created_at':
        // ⚠️ 格式化留在**调用点**（读面只给毫秒事实；`null` ⇒ 空串，与旧 `?? ''` 同形）。
        return ok(meta.createdAtMs === null ? '' : new Date(meta.createdAtMs).toLocaleString())
      case 'format_version':
        return ok(meta.formatVersion)
      default:
        return err(domainError('MissingTarget', { reason: 'property-not-registered', property: ref.property }))
    }
  }

  if (ownerKind === 'workspace') {
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

  if (ownerKind === 'editContext') {
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

  if (ownerKind === 'asset') {
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
  const desc = workbenchRegistry().registry.descriptor(ref.property)
  const objectType = desc ? workbenchRegistry().registry.objectType(desc.objectTypeId) : undefined
  // 局部名必须用 `objectTypeId` 剥离（属性 ID 形如 `lightning.block.pos`）。
  const local = localPropertyOf(ref.property, desc?.objectTypeId)
  const kind = objectType ? sceneKindOf(objectType.id) : null
  const ownerKind = objectType ? contractKindOf(objectType.id) : null
  // #301 P10f D3：多方块生成态由读面给出（**外部格式事实**，内核不承载）；
  // 网格走 R5 网格读面（帧下标逐字保留 `0` —— 同上方属性读的理由）。
  const multiblockReadOnly = isMultiblockGenerated(ctx)
  const grid = kind === 'block' ? ctx.kernelGrid(0) : null

  if (kind === 'block') {
    if (!ctx.hasLoadedDocument()) return factsOf({ exists: false })
    const [x, y, z] = ref.owner.id.split(',').map(Number)
    const exists = grid?.at({ x: x ?? 0, y: y ?? 0, z: z ?? 0 }) != null
    return factsOf({
      exists,
      generated: multiblockReadOnly,
      holdsLease: !multiblockReadOnly,
      contentVersion: ctx.getContentRefreshTick().value,
    })
  }

  if (kind === 'annotation') {
    // #301 P10f D3（R2）：注解事实走内核注解读面（`locked` 是读面 15 字段之一）。
    const a = ctx.kernelAnnotations().find((x) => x.id === ref.owner.id) as
      | (Record<string, unknown> & { locked?: boolean })
      | undefined
    if (!a) return factsOf({ exists: false })
    const locked = local !== 'locked' && a.locked === true
    return factsOf({
      exists: true,
      generated: false,
      locked,
      holdsLease: true,
      contentVersion: ctx.getContentRefreshTick().value,
    })
  }

  if (ownerKind === 'document') {
    if (!ctx.hasLoadedDocument()) return factsOf({ exists: false })
    return factsOf({ exists: true, generated: multiblockReadOnly, holdsLease: !multiblockReadOnly })
  }

  // 非文档拥有的面：发布配置（workspace）/ 工具参数（editContext）/ 材质视图（asset）。
  // 它们不因文档是多方块生成而只读。
  if (ownerKind === 'workspace' || ownerKind === 'editContext' || ownerKind === 'asset') {
    return factsOf({ exists: true, holdsLease: true })
  }

  return factsOf({ exists: false })
}

/**
 * 多方块文档的网格是装配产物 ⇒ 只读（#249 §3.3）。
 *
 * #301 P10f D3：入参由旧文档改为 `Context`，事实取自
 * `ctx.legacyRenderSource()`（R9 的**外部格式边界**读面）——`multiblock` 声明
 * 的内层 body（`multiblockSource`）内核不承载，故这条事实仍只能从旧格式读。
 * ⚠️ 它**只**回答"是不是多方块生成"这一位（不给内容读入口），
 * 与 R9 的登记用途一致（见 `runtime/context#legacyRenderSource` 的说明）。
 */
function isMultiblockGenerated(ctx: Context): boolean {
  const doc = ctx.legacyRenderSource()
  if (!doc) return false
  return (doc as unknown as { multiblock?: unknown }).multiblock != null
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

/**
 * 快照当前**壳状态**为可写的 `DocumentState`（R1-β① C3）。
 *
 * ## 它为什么不再构造"文档字段"了
 *
 * `DocumentState` 曾携带 `document: RuntimeDocument` —— 面板每次读写都要从
 * `Context#legacyDocumentModel()` 取旧文档**本体**（每格一 clone 会在大文档上产生
 * 可感的卡顿，故取本体）。那正是 `composition/seams.ts` 的
 * `property-write-legacy-document-model` 登记的**最后一条**旧写模型双轨。
 *
 * 本批把文档内容写全部改走内核命令（见 `submitPropertyWrite` 的分流表），
 * 于是本函数只剩**壳设置**：发布配置（`workspace` 拥有者）与工具参数
 * （`editContext` 拥有者）—— 它们不是文档内容、不进文档历史（契约 §6.4）。
 * 旧数据模型取值口因此**不再有生产消费者**。
 */
export function documentStateOf(ctx: Context): DocumentState {
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
  return { version: versionOf(ctx), shell }
}

/**
 * 面板 RNA 的局部 ID → 内核 `DocumentMetadata` 的具名字段（**边界映射的唯一落点**）。
 *
 * 只列**可写**字段：`created_at`/`format_version` 在面板声明里是只读，
 * 内核 `setDocumentMeta` 也只接受具名字段（GF-14 口径：未知键按**文档身份**走保真记录，
 * 不因此放宽 `Partial<DocumentMetadata>`）。
 */
const DOC_META_PATCH_KEYS: Readonly<Record<string, 'name' | 'author' | 'description' | 'tags' | 'origin'>> = Object.freeze({
  name: 'name',
  author: 'author',
  description: 'description',
  tags: 'tags',
  origin: 'origin',
})

/**
 * **内核写入的结算 → 面板回执**（R1-β① C3）。
 *
 * | 内核结算 | 面板回执 | 为什么 |
 * |---|---|---|
 * | `applied` | `applied`（版本取内容重读信号） | 回写已由 `Context#submitContentEditSettlement` 做完 |
 * | `unchanged` | `unchanged` | **不得**记成 applied：无业务变化不记账（A06 同族） |
 * | `rejected` | **原样**回报 | §3.1：拒绝必须具名，结构化原因不许被压成布尔 |
 * | `null`（无会话 / 未装配） | `rejected`（`kernel-not-adopted`） | 写权威只有内核这一条：**如实失败**，不回落旧栈 |
 *
 * ⚠️ 最后一行是**刻意的**：#387 的完成判据要求"打断旧运行时源 ⇒ 仍完全可用；
 * 打断**新**提交/装配 ⇒ 同一生产测试**失败**"。未装配时静默写旧栈既掩盖了新栈的故障，
 * 也就是本批要消除的双轨形态 ⇒ 这里改成显式红灯。
 */
function kernelWriteOutcome(ctx: Context, outcome: CommandOutcome | null, ref: PropertyRef): CommandOutcome {
  if (outcome === null) {
    return {
      status: 'rejected',
      error: domainError('UnsupportedOperation', {
        reason: 'kernel-not-adopted',
        property: ref.property,
        objectId: ref.owner.id,
      }),
    }
  }
  if (outcome.status !== 'applied') return outcome
  return { status: 'applied', version: versionOf(ctx), changes: NO_CHANGE }
}

/**
 * 提交一次属性写 —— **唯一写路由的入口**（面板、脚本、命令搜索共用）。
 *
 * ## R1-β① C3：分流表（文档内容写**全部**改走内核命令）
 *
 * | 目标 | 命令 | 边界映射 |
 * |---|---|---|
 * | 方块身份 `id` | `setCellIdentity` | 面板 `x,y,z` → `CellPosition`；身份引用走 `Context#kernelCellIdentityRef`（**不**反拼命名空间） |
 * | 逐格说明 | `setCellTooltip` | 同上；空串 ⇒ `null`（删除） |
 * | 注解字段 | `setProperty` | legacy 裸注解 id → `annotation:<id>`；面板属性 ID → `annotation.<local>` |
 * | 场景元数据 | `setDocumentMeta` | 面板局部 ID → 具名字段（`DOC_META_PATCH_KEYS`） |
 * | 壳设置 | 纯壳转移（`applySetProperty<DocumentState>`） | 无（它不是文档内容） |
 *
 * ## 为什么映射必须在**这一层**做（裁决②）
 *
 * 「旧寻址 → 内核 id」的映射**只许**落在边界/投影层：核心不认识 `x,y,z` / `anno_x`
 * 这类面板寻址。本文件是面板与内核之间**唯一**的接线点，故映射收口在此
 * （`annotationObjectIdOf` 是那一条唯一实现）。
 *
 * ## 可编辑性仍在**面板注册表**上判（不能被内核命令绕过）
 *
 * 内核命令不认识面板的 `readOnly`（`created_at` 的 `timestamp`、锁定注解的其余字段、
 * 查看器无写入能力）⇒ 提交前逐个 `editStateOf` 预检，**任一不可编辑即整批拒绝**
 * （多选原子性，契约 §3.3）——与 `applySetProperty` 用的是**同一个**纯判据函数。
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
  // 无文档 ⇒ 原行为的等价形态：**所有**属性写一律拒绝（壳设置也要有文档才谈得上"面板"）。
  if (refs.length === 0) return { status: 'unchanged', version: versionOf(ctx) }
  if (!ctx.hasLoadedDocument()) {
    return { status: 'rejected', error: domainError('MissingTarget', { reason: 'no-document' }) }
  }

  // ── 可编辑性预检（面板注册表的判据；内核命令不会替我们判）──────────────────
  for (const r of refs) {
    const edit = editStateOf(registry, r, access)
    if (edit.kind === 'readOnly') return { status: 'rejected', error: edit.reason }
  }

  // #301 P10f D0：**逐格说明改走内核命令**（本入口原先经 `applySetProperty` 改 legacy 侧表）。
  //
  // ## 为什么在这一层拦截（而不是改 `property-writers#writeBlockProperty`）
  //
  // `writeBlockProperty` 的签名与职责是"**纯**转移：`DocumentState` → `DocumentState`"，
  // 它**拿不到 `Context`**，因而无法发内核命令。而本函数是面板的**唯一写路由入口**、
  // 且已持有 `ctx` ⇒ 只有这里能"先发命令、再决定要不要走 legacy 路径"。
  // 这也是成对铁律第④项要求的"同一事实的全部写者同批迁移"的落点：
  // 算子路径（`metaEditOperators`）与本面板路径现在**都**经内核命令。
  //
  // ## 拦截条件（窄，只覆盖逐格说明）
  //
  // 仅当**全部** ref 都是 `cellTooltip`/`tooltip` 属性时才拦截：
  //  - 单属性 ⇒ 语义与命令一一对应；
  //  - 混合属性（同一次提交里既改说明又改别的）⇒ **不拦截**，整批走 legacy
  //    （命令只表达逐格说明，拆成两半会让"多选一失败整批拒"失效）。
  const localIds = refs.map((r) => localPropertyOf(r.property, 'lightning.block'))
  const tooltipOnly =
    refs.length > 0 &&
    refs.every((r) => r.owner.kind === 'object' && r.component === undefined) &&
    localIds.every((id) => id === 'cellTooltip' || id === 'tooltip')
  if (tooltipOnly && typeof value === 'string') {
    const cells: { x: number; y: number; z: number }[] = []
    for (const r of refs) {
      const parts = r.owner.id.split(',')
      if (parts.length !== 3) continue
      const [x, y, z] = parts.map((s) => Number(s))
      if (x === undefined || y === undefined || z === undefined) continue
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
      cells.push({ x, y, z })
    }
    if (cells.length === refs.length) {
      // 旧面板路径对空串写的是 `-1`（无说明）⇒ 空串映射为 `null`（删除），保持行为一致。
      const outcome = ctx.submitContentEditSettlement({
        kind: 'setCellTooltip',
        contextId: KERNEL_CONTEXT_ID,
        cells,
        text: value === '' ? null : value,
      })
      // ⚠️ **#333 的教训仍然适用**：内核对 `cellContent.tooltip` 的写必须**同时**有
      // 投影回写（`syncLegacyFromKernel` 已由 `submitContentEditSettlement` 在
      // `applied` 时调用，覆盖网格 + 逐格说明 + 注解三块）——否则"提交成功但看不到"
      // （e2e A25-3b 双 project 确定性红，单测全绿）。
      // 判据把守见 `p10fPanelTooltipWrite.test.ts`（本入口的内核路径）。
      return kernelWriteOutcome(ctx, outcome, refs[0]!)
    }
  }

  // R1-β① C3：**方块身份改走内核命令** —— 与上一条逐格说明拦截同形。
  //
  // ## 为什么必须绕开 `writeBlockProperty`（GF-7 的写侧成因）
  //
  // 旧写点把面板给的名字直接写进 `SlotBlock.name`，而该字段按
  // `pure/gridTypes.ts:18` 是**已截去命名空间**的注册名 ⇒ 显示侧
  // `context/queries.ts:164` 再按 `` `minecraft:${name}` `` 拼回 ⇒ 任何非 `minecraft`
  // 命名空间在"读出→写回"一个来回后被改写（GF-7 投影侧实测 68 条调色板里 66 条被改写）。
  //
  // 内核命令 `setCellIdentity` 的取值是**「`cells` 值（截前缀注册名）+
  // `cellPalette` 值（真 registryId 内容键）」的二元组** ⇒ 两半在同一事务里
  // 成对落表，**没有**从名字反拼命名空间的环节。
  //
  // ## 为什么只接受**调色板里真实存在**的引用
  //
  // `cellPalette` 的值必须是本文档调色板里真实存在的内容键。找不到 ⇒ 说明
  // "这一格的方块不在本文档调色板里"，那是**装配/调色板维护**的事，不是属性写
  // 能决定的 ⇒ **如实拒绝**，既不按 `minecraft:${name}` 反拼引用兜底
  // （那正是本段要消除的事故成因），也不回落 legacy 写（那会让内核与 legacy
  // 就同一格给出两个身份）。
  const identityOnly =
    refs.length > 0 &&
    refs.every((r) => r.owner.kind === 'object' && r.component === undefined) &&
    localIds.every((id) => id === 'id')
  if (identityOnly && typeof value === 'string') {
    const parsed = parseBlockStateId(value)
    if (parsed === null) {
      return {
        status: 'rejected',
        error: domainError('InvalidValue', { reason: 'malformed-block-id', hintKey: 'validation.locator' }),
      }
    }
    const cells: { x: number; y: number; z: number }[] = []
    for (const r of refs) {
      const parts = r.owner.id.split(',')
      if (parts.length !== 3) continue
      const [x, y, z] = parts.map((s) => Number(s))
      if (x === undefined || y === undefined || z === undefined) continue
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
      cells.push({ x, y, z })
    }
    // 旧寻址（`x,y,z`）解不开 ⇒ 报错，**不静默跳过**（否则"报告成功但没写"）。
    // 旧寻址→内核 id 的映射只许落在这里（边界层），核心不认识它。
    if (cells.length !== refs.length) {
      return {
        status: 'rejected',
        error: domainError('InvalidValue', { reason: 'malformed-cell-owner-id' }),
      }
    }
    // `parsed.name` 已按 `parseBlockStateId` 剥离命名空间（与 `SlotBlock.name` 同口径）。
    // 引用走**读面**（`ctx.kernelCellIdentityRef`），不自己拼 —— 拼就是 GF-7。
    const first = cells[0]!
    const ref0 = ctx.kernelCellIdentityRef(0, first, parsed.name, parsed.meta)
    if (ref0 === null) {
      return {
        status: 'rejected',
        error: domainError('UnsupportedOperation', {
          reason: 'identity-not-in-palette',
          property: refs[0]!.property,
          objectId: refs[0]!.owner.id,
        }),
      }
    }
    const outcome = ctx.submitContentEditSettlement({
      kind: 'setCellIdentity',
      contextId: KERNEL_CONTEXT_ID,
      cells,
      identity: { name: parsed.name, paletteRef: ref0, meta: parsed.meta },
    })
    return kernelWriteOutcome(ctx, outcome, refs[0]!)
  }

  // ── 注解字段 → 内核 `setProperty`（边界做"面板寻址 → 内核寻址"的映射）────────
  const firstDesc = registry.descriptor(refs[0]!.property)
  const firstType = firstDesc ? registry.objectType(firstDesc.objectTypeId) : undefined
  const sceneKind = firstType ? sceneKindOf(firstType.id) : null
  const ownerKind = firstType ? contractKindOf(firstType.id) : null

  if (sceneKind === 'annotation') {
    const translated: PropertyRef[] = []
    for (const r of refs) {
      const desc = registry.descriptor(r.property)
      const local = localPropertyOf(r.property, desc?.objectTypeId)
      // 内核属性 ID 是 `<objectTypeId>.<localId>`（见 `application/kernel-properties#localOf`）。
      if (local === '') {
        return { status: 'rejected', error: domainError('MissingTarget', { reason: 'property-not-registered', property: r.property }) }
      }
      translated.push({
        owner: { kind: 'object', id: annotationObjectIdOf(r.owner.id) },
        property: `${KERNEL_ANNOTATION_TYPE}.${local}`,
        ...(r.component === undefined ? {} : { component: r.component }),
      })
    }
    const outcome = ctx.submitContentEditSettlement({
      kind: 'setProperty',
      // ⚠️ `SetPropertyCommand` **不带 `contextId`**：上下文由目标文档**反查**
      // （`application/commands.ts` 的 `reduceSetProperty` —— 契约 §1.1 方向 8
      // 「不提供跨文档编辑事务」⇒ 一致性由构造保证，不靠校验兜）。
      refs: translated,
      value,
      ...(commandId ? { commandId } : {}),
    })
    return kernelWriteOutcome(ctx, outcome, refs[0]!)
  }

  // ── 场景元数据 → 内核 `setDocumentMeta`（只接受**具名**字段）──────────────
  if (ownerKind === 'document') {
    const patch: Record<string, unknown> = {}
    for (const r of refs) {
      const desc = registry.descriptor(r.property)
      const local = localPropertyOf(r.property, desc?.objectTypeId)
      const key = DOC_META_PATCH_KEYS[local]
      if (key === undefined) {
        return {
          status: 'rejected',
          error: domainError('UnsupportedOperation', { reason: 'no-write-path', property: r.property, objectId: r.owner.id }),
        }
      }
      patch[key] = value
    }
    const outcome = ctx.submitContentEditSettlement({
      kind: 'setDocumentMeta',
      contextId: KERNEL_CONTEXT_ID,
      patch: patch as Partial<DocumentMetadata>,
      ...(commandId ? { commandId } : {}),
    })
    return kernelWriteOutcome(ctx, outcome, refs[0]!)
  }

  // ── 壳设置（workspace / editContext 拥有者）：纯转移，不进文档历史 ──────────
  //
  // 文档内容以外的目标（发布配置、工具参数）**没有**内核命令，也不该有：
  // 它们不是文档内容（契约 §6.4）。落点、校验与入口仍与其他面共用。
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

/**
 * 面板会话状态（**仅**提交被拒绝的结构化原因）——按属性 ID 索引，跨重渲染保留。
 *
 * ## P10c（#286）退役：`drafts` 呈现镜像已删除
 *
 * 本类型曾同时携带 `drafts`（每个字段一份草稿文本的**镜像**）与 `sessions`
 * （`EditSession` 表）。两者都是 P7（#258）之前那套"P2 自己解析草稿"的残留，
 * 与输入层的三态机并存 —— 正是 `composition/seams.ts` 的
 * `property-draft-session-mirror` 登记的那条双轨。
 *
 * 本批删除，判据是接缝自己写下的退出条件（`buildField` 不再读 `session.drafts`）
 * 加上两处实测：
 *
 *  - 镜像的**写键与读键不同**（写 `localPropertyOf(desc.id)`＝`tooltip`；
 *    `editors/inspector.ts` 与卸载 flush 读 `localIdOf`＝`block.tooltip`），
 *    生产 84 个属性**无一命中** ⇒ 喂模型与 flush 的路本就不通；
 *  - `sessions` 从未被写入使用（`createPanelSession` 之外的唯一命中是 LogCenter
 *    的同名局部变量，与本类型无关）。
 *
 * 留下的是**唯一**那条真实需要跨重渲染保留的状态：拒绝原因（写路由的真实结论，
 * 见 D5「拒绝后不得报告成功」）。
 */
export type PanelSession = {
  rejections: Record<string, DomainError>
}

export function createPanelSession(): PanelSession {
  return { rejections: {} }
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
  const local = localPropertyOf(desc.id, desc.objectTypeId)
  const field = buildFieldViewModel(workbenchRegistry().registry, ref, {
    descriptor: desc,
    value,
    edit,
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

/** 面板生成式模型的输入（把 ctx 事实一次性收齐，之后交给纯函数）。 */
export function inspectorInputs(ctx: Context, session: PanelSession): InspectorContextInputs {
  const targets = resolveInspectorTargets(selectionOf(ctx))
  return {
    registry: workbenchRegistry().registry,
    layouts: workbenchRegistry().layouts,
    targets,
    access: accessOfContext(ctx),
    readField: (refs) => readMultiValue(workbenchRegistry().registry, refs, 'authored', accessOfContext(ctx)),
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
        inLayout: inSpec.has(localPropertyOf(desc.id, objectType.id)),
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
