/**
 * `adapters/files/multiblockDeclaration` —— **已解析声明 → 内核承载**的边界转换（G1/G2）。
 *
 * ## 本模块替代的旧机制
 *
 * 「多方块声明」此前只有**一个**落点：`context/parsers/multiblockDocument.ts` 的
 * 解析类型（`MultiblockDeclaration` / `MultiblockDecl` / …）。它同时承担了**两件事**：
 *
 *  1. 外部文件格式的**解析与保真**（每个节点带 `raw`，`:180/189/200/224/243/296`）；
 *  2. 内核侧**声明承载**（`RuntimeDocument.multiblock` 直接指向它）。
 *
 * 第 2 件是 #249 §3.3 划给内核的内容（「多方块声明作为**只读内容定义**，由类型化
 * 解析适配接入」）—— 契约的措辞里"适配"就是这个模块。本模块只做第 2 件：
 * 吃**已解析**的声明，产出 `domain/multiblockDocument#MultiblockDeclaration`。
 * 解析与保真的归属不变（`composition/kernelAssembly#declRawOf` 的既有分工）。
 *
 * ## 这是**边界**转换，不是第二份模型
 *
 * 输出类型**复用** `domain/multiblockDocument` 的 `MultiblockDeclaration`（不另立形状）。
 * 输入类型来自旧解析器，两侧同名 ⇒ 本模块用别名导入（`ParsedMultiblockDeclaration`）。
 *
 * 同名冲突的处置建议（**本批不擅改**，报调度者）：内核侧与解析侧都叫
 * `MultiblockDeclaration`，且字段集不同（解析侧有 `decl`/`raw`/`warnings`，
 * 内核侧把 `decl` 摊平并去掉全部 `raw`）。建议后续把解析侧改名为
 * `ParsedMultiblockDocument`（或让它退为 `MultiblockDeclaration` 的**构造来源**），
 * 使"同名不同物"不再可能被误读为同一契约。
 *
 * ## 未承载的东西**报出来**，不静默丢（§12 第 3 段）
 *
 * 内核承载**刻意**没有 `raw` 字段袋（§15 第 2 条），也没有 `frames[].cellGrid`
 * （G3 待裁定）与 `materialPalette`/`textureBlobs`/`tooltipPalette`（契约未把它们
 * 划进内核声明半）。这些一律进 {@link MultiblockAdapterDiagnostic} ——
 * 「不能静默丢失无法解释的语义」是 §12 的明文，诊断就是它的落点。
 */

import {
  blockGeometryAsset,
  decodeBlockGeometry,
  type BlockPaletteEntry,
} from '@/domain/blockGeometry'
import {
  EMPTY_MULTIBLOCK_DECLARATION as EMPTY_KERNEL_DECLARATION,
  type MultiblockBackbone,
  type MultiblockChannel,
  type MultiblockCoupling,
  type MultiblockDeclaration,
  type MultiblockFrame,
  type MultiblockNote,
  type MultiblockRule,
  type MultiblockRunstate,
  type MultiblockSizeStep,
  type MultiblockVariant,
  type MultiblockViewerSemantics,
} from '@/domain/multiblockDocument'
import { type MultiblockDeclaration as ParsedMultiblockDeclaration } from '@/context/parsers/multiblockDocument'

// ─────────────────────────────────────────────────────────────────────────────
// 诊断
// ─────────────────────────────────────────────────────────────────────────────

/** 未进内核承载的字段（**稳定键**，不随语言变化 —— #249 §19.7）。 */
export type MultiblockAdapterDiagnosticCode =
  | 'FrameCellGridNotCarried'
  | 'ParserNodeRawNotCarried'
  | 'ExtraPaletteNotCarried'
  | 'UnknownBodyKeyNotCarried'

export interface MultiblockAdapterDiagnostic {
  readonly code: MultiblockAdapterDiagnosticCode
  /** 缺陷所在路径（`$.frames[2].cellGrid`）。 */
  readonly at: string
  readonly detail: Readonly<Record<string, string | number>>
}

export interface MultiblockAdapterResult {
  /** 内核承载（可直接放进 `DocumentContent.multiblock`）。 */
  readonly declaration: MultiblockDeclaration
  /** 未承载的字段/键；空数组 = 逐字段都已承载。 */
  readonly diagnostics: readonly MultiblockAdapterDiagnostic[]
}

/**
 * 解析器**已知**的内层 body 根级键（多出来的即未知键）。
 *
 * 为什么具名常量：它是"什么算未知"的唯一定义点。散写在转换逻辑里，
 * 「哪些键已被承载」就会随实现漂移，而漂移的表现恰是未知键**从诊断里消失**。
 */
const KNOWN_BODY_KEYS: readonly string[] = Object.freeze([
  'documentShape',
  'format_version',
  'multiblock',
  'multiblockCount',
  'schemaVersion',
  'blockPalette',
  'materialPalette',
  'textureBlobs',
  'tooltipPalette',
  'frames',
])

/** 解析器的**额外调色板数组**（内核声明半不承载；非空才报）。 */
const EXTRA_PALETTE_KEYS: readonly string[] = Object.freeze(['materialPalette', 'textureBlobs', 'tooltipPalette'])

// ─────────────────────────────────────────────────────────────────────────────
// 调色板条目转换
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一个**并集调色板**的原始条目 → 类型化条目。
 *
 * ## 为什么在适配器里解码几何
 *
 * 契约 §6 的 `blockPalette[].geometry` 是外部格式的**内嵌烘焙四边形**；
 * 内核的类型化资产是 `domain/blockGeometry#BlockGeometryAsset`。这一步正是
 * 「外部格式 → 内核」的转换，故它属于适配器（§4 规则 4「实现端口」）。
 *
 * ## 与 `composition/kernelAssembly#unionPaletteOf` 的关系（**已登记**）
 *
 * 那里有一段等价的内联转换（`:969-1002`，`composition/` 不在本批写面内）。
 * 两者是**同一判据**的两处落点，收敛是后续事项（本批如实登记，不静默留分叉）。
 * 口径逐字对齐：非对象条目 → air 形；`registryId`/`meta`/`renderMode` 缺省；
 * `thumbnailPNG` → `thumbnail`；`tooltip` 过滤非字符串。
 *
 * ## 顺序**不**排序（下标即身份）
 *
 * 契约 §4.4 的 `sizeSteps[].cellGrid` 是**调色板下标**网格 ⇒ 并集调色板的
 * 顺序是语义。故本函数**不**调用 `domain/blockGeometry#normalizePalette`
 * （它按内容去重**并排序**，服务的是"呈现清单"而非"下标敏感声明"）。
 * ⚠️ 已登记的既有冲突：`domain/multiblockDocument#normalizeMultiblockDeclaration`
 * 对 `blockPalette` 调用了 `normalizePalette` ⇒ 若在装配路径上用它，下标会错位。
 * 本批**不**改它（超范围），只在此如实标注并回报。
 */
export function paletteEntryOf(raw: unknown): BlockPaletteEntry {
  if (raw === null || typeof raw !== 'object') return airLikePaletteEntry()
  const entry = raw as Record<string, unknown>
  const dec = decodeBlockGeometry(entry.geometry as never)
  const asset = dec === null ? null : blockGeometryAsset(dec.quads)
  const typed: {
    assetId: string
    registryId: string
    meta: number
    renderMode: BlockPaletteEntry['renderMode']
    geometry: BlockPaletteEntry['geometry']
    occludesAdjacentFaces?: boolean
    facing?: BlockPaletteEntry['facing']
    nbt?: Readonly<Record<string, unknown>>
    thumbnail?: string
    tooltip?: readonly string[]
  } = {
    assetId: asset?.id ?? '',
    registryId: typeof entry.registryId === 'string' ? entry.registryId : 'air',
    meta: typeof entry.meta === 'number' ? entry.meta : 0,
    renderMode: typeof entry.renderMode === 'string' ? entry.renderMode : 'BakedModel',
    geometry: asset,
  }
  if (typeof entry.occludesAdjacentFaces === 'boolean') typed.occludesAdjacentFaces = entry.occludesAdjacentFaces
  if (typeof entry.facing === 'string') typed.facing = entry.facing as BlockPaletteEntry['facing']
  if (entry.nbt !== undefined && entry.nbt !== null && typeof entry.nbt === 'object') {
    typed.nbt = entry.nbt as Readonly<Record<string, unknown>>
  }
  if (typeof entry.thumbnailPNG === 'string') typed.thumbnail = entry.thumbnailPNG
  if (Array.isArray(entry.tooltip)) typed.tooltip = Object.freeze(entry.tooltip.filter((x): x is string => typeof x === 'string'))
  return Object.freeze(typed)
}

/** air 形条目（`[0]` 恒为 air；非对象条目落到这里，**不**静默跳过）。 */
export function airLikePaletteEntry(): BlockPaletteEntry {
  return Object.freeze({
    assetId: '',
    registryId: 'air',
    meta: 0,
    renderMode: 'BakedModel' as BlockPaletteEntry['renderMode'],
    geometry: null,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 边界转换
// ─────────────────────────────────────────────────────────────────────────────

function viewerSemanticsOf(vs: ParsedViewerSemanticsLike): MultiblockViewerSemantics {
  const cov = vs.runstateCoverage
  return Object.freeze({
    frameIsVariant: vs.frameIsVariant,
    playback: vs.playback,
    layerPreview: vs.layerPreview,
    runstateCoverage: Object.freeze({
      kind: cov.kind,
      geometryDelta: cov.geometryDelta,
      tesr: cov.tesr,
    }),
  })
}

/** 解析器 `viewerSemantics` 的**结构**面（刻意不 import 旧类型名以避开同名混淆）。 */
interface ParsedViewerSemanticsLike {
  readonly frameIsVariant: boolean
  readonly playback: string
  readonly layerPreview: string
  readonly runstateCoverage: Readonly<{ kind: string; geometryDelta: boolean; tesr: string }>
}

function sizeStepOf(s: ParsedMultiblockDeclaration['decl']['backbone']['sizeSteps'][number]): MultiblockSizeStep {
  const step: {
    channel: string
    layers?: number
    w: number
    hh: number
    d: number
    roles: Readonly<Record<string, number>>
    cellGrid: MultiblockSizeStep['cellGrid']
  } = {
    channel: s.channel,
    w: s.w,
    hh: s.hh,
    d: s.d,
    roles: Object.freeze({ ...s.roles }),
    cellGrid: Object.freeze(s.cellGrid.map((zz) => Object.freeze(zz.map((yy) => Object.freeze([...yy]))))),
  }
  if (s.layers !== undefined) step.layers = s.layers
  return Object.freeze(step)
}

function backboneOf(b: ParsedMultiblockDeclaration['decl']['backbone']): MultiblockBackbone {
  return Object.freeze({
    kind: b.kind,
    sizeChannel: b.sizeChannel,
    sizeSteps: Object.freeze(b.sizeSteps.map(sizeStepOf)),
  })
}

function channelOf(c: ParsedMultiblockDeclaration['decl']['channels'][number]): MultiblockChannel {
  const out: {
    enumName: string | null
    id: string
    key: string
    name: string
    kind: MultiblockChannel['kind']
    slot?: string
    min: number
    max: number
    axis?: string
    unit?: string
    valueSemantics?: string
    domainSource?: string
    domain: Readonly<{ lo: number; hi: number }>
    slider: boolean
  } = {
    enumName: c.enumName,
    id: c.id,
    key: c.key,
    name: c.name,
    kind: c.kind,
    min: c.min,
    max: c.max,
    domain: Object.freeze({ lo: c.domain.lo, hi: c.domain.hi }),
    slider: c.slider,
  }
  if (c.slot !== undefined) out.slot = c.slot
  if (c.axis !== undefined) out.axis = c.axis
  if (c.unit !== undefined) out.unit = c.unit
  if (c.valueSemantics !== undefined) out.valueSemantics = c.valueSemantics
  if (c.domainSource !== undefined) out.domainSource = c.domainSource
  return Object.freeze(out)
}

function runstateOf(r: ParsedMultiblockDeclaration['decl']['runstates'][number]): MultiblockRunstate {
  return Object.freeze({ id: r.id, name: r.name, materialSwap: r.materialSwap })
}

function variantOf(v: ParsedMultiblockDeclaration['decl']['variants'][number]): MultiblockVariant {
  return Object.freeze({
    key: v.key,
    totalTier: v.totalTier,
    values: Object.freeze({ ...v.values }),
    runstate: v.runstate,
  })
}

function ruleOf(r: ParsedMultiblockDeclaration['decl']['rules'][number]): MultiblockRule {
  const out: {
    id: string
    phase: MultiblockRule['phase']
    legend?: string
    kind: MultiblockRule['kind']
    x?: number
    y?: number
    z?: number
    sel?: MultiblockRule['sel']
    index?: number
    indexRole?: string
    channel?: string
    indexTable?: readonly number[]
    indexAliases?: Readonly<Record<string, number>>
    guard?: MultiblockRule['guard']
  } = { id: r.id, phase: r.phase, kind: r.kind }
  if (r.legend !== undefined) out.legend = r.legend
  if (r.x !== undefined) out.x = r.x
  if (r.y !== undefined) out.y = r.y
  if (r.z !== undefined) out.z = r.z
  if (r.sel !== undefined) {
    const sel: { x?: number | readonly number[]; y?: number | readonly number[]; z?: number | readonly number[] } = {}
    // 逐轴搬运：`number[]` → `readonly number[]`（值不动，只冻形态）。
    if (r.sel.x !== undefined) sel.x = Array.isArray(r.sel.x) ? Object.freeze([...r.sel.x]) : r.sel.x
    if (r.sel.y !== undefined) sel.y = Array.isArray(r.sel.y) ? Object.freeze([...r.sel.y]) : r.sel.y
    if (r.sel.z !== undefined) sel.z = Array.isArray(r.sel.z) ? Object.freeze([...r.sel.z]) : r.sel.z
    out.sel = Object.freeze(sel)
  }  if (r.index !== undefined) out.index = r.index
  if (r.indexRole !== undefined) out.indexRole = r.indexRole
  if (r.channel !== undefined) out.channel = r.channel
  if (r.indexTable !== undefined) out.indexTable = Object.freeze([...r.indexTable])
  if (r.indexAliases !== undefined) out.indexAliases = Object.freeze({ ...r.indexAliases })
  if (r.guard !== undefined) {
    out.guard = Object.freeze({
      ...(r.guard.not === undefined ? {} : { not: r.guard.not }),
      clauses: Object.freeze(
        r.guard.clauses.map((cl) =>
          Object.freeze({
            channel: cl.channel,
            ...(cl.value === undefined ? {} : { value: cl.value }),
            ...(cl.min === undefined ? {} : { min: cl.min }),
            ...(cl.max === undefined ? {} : { max: cl.max }),
            ...(cl.not === undefined ? {} : { not: cl.not }),
          }),
        ),
      ),
    })
  }
  return Object.freeze(out)
}

function couplingOf(c: ParsedMultiblockDeclaration['decl']['couplings'][number]): MultiblockCoupling {
  return Object.freeze({ id: c.id, a: c.a, b: c.b, requires: c.requires })
}

function noteOf(n: ParsedMultiblockDeclaration['decl']['notes'][number]): MultiblockNote {
  return Object.freeze({ kind: n.kind, text: n.text })
}

function frameOf(f: ParsedMultiblockDeclaration['frames'][number]): MultiblockFrame {
  const out: {
    index: number
    variant: string
    runstate: string
    stepIndex: number
    rules: readonly MultiblockFrame['rules'][number][]
    label?: string
    durationMs?: number
  } = {
    index: f.index,
    variant: f.variant,
    runstate: f.runstate,
    stepIndex: f.stepIndex,
    rules: Object.freeze(
      f.rules.map((r) => (typeof r === 'string' ? r : Object.freeze({ ...r }))),
    ),
  }
  if (f.label !== undefined) out.label = f.label
  if (f.durationMs !== undefined) out.durationMs = f.durationMs
  return Object.freeze(out)
}

/**
 * **边界转换的唯一入口**：已解析声明 → 内核承载。
 *
 * `parsed === null`（文件不是多方块文档）⇒ 返回空声明
 * （{@link EMPTY_MULTIBLOCK_DECLARATION} 的前身值；调用方通常直接用常量）。
 * 「没读到」与「读到空」在**内核侧**由同一常量表示 —— 这正是 `EMPTY_*` 的设计
 * （见 `domain/multiblockDocument#EMPTY_MULTIBLOCK_DECLARATION` 的判据 2）。
 */
export function multiblockDeclarationOf(parsed: ParsedMultiblockDeclaration | null | undefined): MultiblockAdapterResult {
  const diagnostics: MultiblockAdapterDiagnostic[] = []
  if (parsed === null || parsed === undefined) {
    return Object.freeze({ declaration: EMPTY_KERNEL_DECLARATION, diagnostics: Object.freeze(diagnostics) })
  }

  const decl = parsed.decl

  // ---- 未承载：逐帧 `cellGrid`（G3 待裁定；e2e 取证脚本依赖，故**必须**报） ----
  parsed.frames.forEach((f, i) => {
    if (f.cellGrid === undefined) return
    diagnostics.push(
      Object.freeze({
        code: 'FrameCellGridNotCarried' as const,
        at: `$.frames[${i}].cellGrid`,
        detail: Object.freeze({ frameIndex: f.index, note: '内核帧声明无此字段（G3 待裁定）' }),
      }),
    )
  })

  // ---- 未承载：逐节点 `raw`（§15 第 2 条；保真归属 `declRawOf`） ----
  const rawBags =
    (hasKeys(decl.raw) ? 1 : 0) +
    (hasKeys(parsed.raw) ? 1 : 0) +
    decl.channels.filter((c) => hasKeys(c.raw)).length +
    decl.rules.filter((r) => hasKeys(r.raw)).length +
    decl.variants.filter((v) => hasKeys(v.raw)).length +
    decl.runstates.filter((r) => hasKeys(r.raw)).length +
    decl.backbone.sizeSteps.filter((s) => hasKeys(s.raw)).length +
    parsed.frames.filter((f) => hasKeys(f.raw)).length
  if (rawBags > 0) {
    diagnostics.push(
      Object.freeze({
        code: 'ParserNodeRawNotCarried' as const,
        at: '$',
        detail: Object.freeze({
          rawBags,
          note: '内核承载无 raw 字段袋（§15 第 2 条）；保真由 composition/kernelAssembly#declRawOf 承担',
        }),
      }),
    )
  }

  // ---- 未承载：额外调色板数组（非空才报） ----
  for (const k of EXTRA_PALETTE_KEYS) {
    const v = (parsed as unknown as Record<string, unknown>)[k]
    if (!Array.isArray(v) || v.length === 0) continue
    diagnostics.push(
      Object.freeze({
        code: 'ExtraPaletteNotCarried' as const,
        at: `$.${k}`,
        detail: Object.freeze({ entries: v.length }),
      }),
    )
  }

  // ---- 未承载：未知根级键（**显式**名单，不静默丢） ----
  for (const key of Object.keys(parsed.raw)) {
    if (KNOWN_BODY_KEYS.includes(key)) continue
    diagnostics.push(
      Object.freeze({
        code: 'UnknownBodyKeyNotCarried' as const,
        at: `$.${key}`,
        detail: Object.freeze({ key }),
      }),
    )
  }

  const declaration: MultiblockDeclaration = Object.freeze({
    id: decl.id,
    displayName: decl.displayName,
    ...(decl.sourceClass === undefined ? {} : { sourceClass: decl.sourceClass }),
    hasScopeOverlap: decl.hasScopeOverlap,
    ...(decl.scopeOverlapNote === undefined ? {} : { scopeOverlapNote: decl.scopeOverlapNote }),
    totalTierDomain: Object.freeze({
      min: decl.totalTierDomain.min,
      max: decl.totalTierDomain.max,
      ...(decl.totalTierDomain.default === undefined ? {} : { default: decl.totalTierDomain.default }),
    }),
    tierSample: Object.freeze([...decl.tierSample]),
    channels: Object.freeze(decl.channels.map(channelOf)),
    runstates: Object.freeze(decl.runstates.map(runstateOf)),
    variants: Object.freeze(decl.variants.map(variantOf)),
    rules: Object.freeze(decl.rules.map(ruleOf)),
    backbone: backboneOf(decl.backbone),
    frames: Object.freeze(parsed.frames.map(frameOf)),
    couplings: Object.freeze(decl.couplings.map(couplingOf)),
    couplingMode: decl.couplingMode,
    notes: Object.freeze(decl.notes.map(noteOf)),
    viewerSemantics: viewerSemanticsOf(decl.viewerSemantics as ParsedViewerSemanticsLike),
    // **顺序即语义**：不排序、不去重（见 `paletteEntryOf` 的说明）。
    blockPalette: Object.freeze(parsed.blockPalette.map(paletteEntryOf)),
    schemaVersion: parsed.schemaVersion ?? null,
    multiblockCount: parsed.multiblockCount,
    paletteSource: decl.paletteSource,
    geometryEncoding: decl.geometryEncoding,
    opsLegend: Object.freeze({ ...decl.opsLegend }),
  })

  return Object.freeze({ declaration, diagnostics: Object.freeze(diagnostics) })
}

function hasKeys(o: Record<string, unknown> | undefined): boolean {
  return o !== undefined && o !== null && Object.keys(o).length > 0
}
