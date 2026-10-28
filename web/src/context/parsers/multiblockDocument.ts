/**
 * MultiblockDocument — 「多方块为主」文档的类型化声明模型（契约：`docs/contracts/format-multiblock-doc.md`）。
 *
 * 职责边界：
 *  - 本模块只做「判别 + 读取 + 校验 + 类型化」，**不装配、不建 Grid**。
 *    装配（变体 → cellGrid → Grid）由装配器负责；本模块只把契约声明原样交出去。
 *  - `MultiblockDeclaration.raw` = 信封内层 body 原文（含 `multiblock` / `blockPalette` / `frames` …），
 *    即契约 §5.4 装配算法的输入形态（装配器的冻结接缝：内层 JSON 对象 + `{values, runstate}`）。
 *  - `frames[]` 映射为 `RuntimeFrame` 时 `grid` 恒为 `null` —— 帧只承载「变体声明」，
 *    网格是装配产物（契约 §5.3/§5.4）。
 *
 * 错误策略（契约 §2）：
 *  - **硬失败**（抛 `MultiblockParseError`，带原因）：形态断言（§2）、帧内联 `ops`（§5.3）、
 *    以及任何会让装配器/UI 无法工作的结构缺失或悬空引用 —— 绝不静默退化成别的格式。
 *  - **警告**（收集到 `warnings`，不阻断加载）：声明瑕疵但可装配（如 `legend` 未登记、
 *    骨架 dims 声明与实际 cellGrid 形状不一致、变体组合不全）。
 */

import { multiblockIndexViewOf } from '@/domain/multiblockDocument'

/** 文档级形态枚举量（§2）：`"multiblock"` = 多方块为主；缺省 = 帧为主。 */
export const MULTIBLOCK_DOCUMENT_SHAPE = 'multiblock' as const

export type MultiblockChannelKind = 'size' | 'replace' | 'hatch'
export type MultiblockRulePhase = 'backbone' | 'replace' | 'runstate'
export type MultiblockRuleKind = 'setCell' | 'fill'
export type MultiblockCouplingMode = 'none' | 'clamp'
export type MultiblockCouplingRequires = 'ge' | 'le' | 'eq'

/**
 * `fill` 的轴向选择（§4.5.1）：
 *  - 数字：每层同一个坐标；
 *  - 数组：第 i 层取第 i 个坐标（长度不足重复最后一个）；
 *  - 缺省：该轴全长。
 * 越界坐标由装配器跳过（这使得「同一张规则表适配所有骨架阶」成立）。
 */
export type MultiblockAxisSpec = number | number[]

/** 解析失败（显式报错，绝不静默退化）。`reason` 为不加前缀的原因文本。 */
export class MultiblockParseError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`多方块文档解析失败：${reason}`)
    this.name = 'MultiblockParseError'
    this.reason = reason
  }
}

// ---------------------------------------------------------------------------
// 类型化声明模型（与契约 §4 / §5 / §7 逐节对应）
// ---------------------------------------------------------------------------

export interface MultiblockTotalTierDomain {
  min: number
  max: number
  /** 缺省推荐值（UI 初始 Tier） */
  default?: number
  source?: string
}

/**
 * 通道声明（§4.2）。`domain` 是**取值域**：`lo` 恒为 0（0 = "Not set"，恒在域内），
 * `hi` = 声明的 `domain.max`，缺省则回落**总 Tier 域上界**。
 * `min`/`max` 描述的是**有效取值**区间（GT `getValueClamped` 语义），与 `domain` 不是一回事。
 */
export interface MultiblockChannelDecl {
  /** 契约键名 `enum`（GTStructureChannels 枚举名；null = 非枚举通道）。双键 {enum, id} 消歧用。 */
  enumName: string | null
  /** 游戏内通道 id（小写，与 ChannelDescription 对齐） */
  id: string
  /** 本文档内唯一键（= id；重名 id 时用 enum 派生） */
  key: string
  /** **呈现名（UI 标签）**，取 enumName 语义，不是 capitalize(id) */
  name: string
  kind: MultiblockChannelKind
  /** 位置集合的稳定名字（语义说明，装配器不使用） */
  slot?: string
  /** 有效取值下界（`kind === 'size'` 时必填；其它种类缺省 1） */
  min: number
  /** 有效取值上界（缺省 = 取值域上界） */
  max: number
  /** 尺寸型：作用轴 */
  axis?: string
  /** 尺寸型：单位（如 layers） */
  unit?: string
  /** 尺寸型：取值语义（如 clamped-offset） */
  valueSemantics?: string
  /** "game-lang" | "probed"：无书面取值域时标 probed */
  domainSource?: string
  /** 取值域：`lo` 恒 0（= Not set 档），`hi` = 声明 max ?? 总 Tier 域上界 */
  domain: { lo: number; hi: number }
  /** UI 是否生成滑杆：`kind === 'hatch'` 恒 false（§4.2 规则 3） */
  slider: boolean
  raw: Record<string, unknown>
}

export interface MultiblockRunstateDecl {
  id: string
  /** **UI 呈现名**（文件自带，不依赖 GT 语言文件） */
  name: string
  /** 本态差异是否只落在材质/纹理层 */
  materialSwap: boolean
  raw: Record<string, unknown>
}

export interface MultiblockCouplingDecl {
  id: string
  /** 用户会显式设置的一侧 */
  a: string
  /** 被夹取的一侧 */
  b: string
  requires: MultiblockCouplingRequires
  kind?: string
  source?: string
  raw: Record<string, unknown>
}

export interface MultiblockNoteDecl {
  kind: string
  text: string
  source?: string
  raw: Record<string, unknown>
}

export interface MultiblockGuardClause {
  channel: string
  /** 等于 */
  value?: number
  /** ≥ */
  min?: number
  /** ≤ */
  max?: number
  /** 对该 clause 取反（不等于） */
  not?: boolean
  raw: Record<string, unknown>
}

export interface MultiblockGuard {
  /** 对整体取反 */
  not?: boolean
  /** clause 之间 AND；空数组 = 恒真 */
  clauses: MultiblockGuardClause[]
}

export interface MultiblockRuleDecl {
  id: string
  phase: MultiblockRulePhase
  /** 指向 `multiblock.opsLegend` 的说明键 */
  legend?: string
  kind: MultiblockRuleKind
  /** `kind === 'setCell'`：单格坐标 */
  x?: number
  y?: number
  z?: number
  /** `kind === 'fill'`：区间（见 MultiblockAxisSpec） */
  sel?: { x?: MultiblockAxisSpec; y?: MultiblockAxisSpec; z?: MultiblockAxisSpec }
  /** 写入内容三选一：常量下标 */
  index?: number
  /** 写入内容三选一：骨架角色名 → step.roles[名] 查表 */
  indexRole?: string
  /** 写入内容三选一：取值查表（配 indexTable，下标 = 该通道有效取值） */
  channel?: string
  indexTable?: number[]
  /** 「旧下标 → 新下标」整表批量替换（写入之前对当前网格执行一次） */
  indexAliases?: Record<string, number>
  guard?: MultiblockGuard
  raw: Record<string, unknown>
}

export interface MultiblockSizeStep {
  channel: string
  /** 语义标注（层数） */
  layers?: number
  w: number
  hh: number
  d: number
  /** 语义角色 → 调色板下标（规则可用 indexRole 查表） */
  roles: Record<string, number>
  /** 该阶骨架完整布局 [z][y][x]（row 0 = 顶部，与既有 cellGrid 约定一致） */
  cellGrid: number[][][]
  raw: Record<string, unknown>
}

export interface MultiblockBackbone {
  /** 目前只有 `"sizeSteps"`（§4.6） */
  kind: string
  /** 决定取哪一阶的尺寸型通道 key（目前只允许一个；等于 `"totalTier"` 时表示总通道定阶） */
  sizeChannel: string
  sizeSteps: MultiblockSizeStep[]
  raw: Record<string, unknown>
}

export interface MultiblockVariantDecl {
  /** 主键：`<通道key>:<声明值>` 按 channels 顺序 `|` 连接 + `tt:<总Tier>` + `runstate:<id>` */
  key: string
  /** 总 Tier（"总通道"的声明值） */
  totalTier: number
  /** 每个通道的**声明值**（未设置写 0） */
  values: Record<string, number>
  runstate: string
  raw: Record<string, unknown>
}

/** frame → 规则的**有序**引用（纯字符串 = 声明顺序，`order` 取数组下标） */
export interface MultiblockRuleRef {
  id: string
  order: number
}

/** 帧声明 = 变体的存储原语（唯一一个，§5.3）。`grid` 由装配器按需生成，解析期不建。 */
export interface MultiblockFrameDecl {
  index: number
  /** 变体主键（命中 `multiblock.variants[].key`） */
  variant: string
  runstate: string
  /** 本帧用哪一阶骨架 */
  stepIndex: number
  /** 有序规则引用 */
  rules: MultiblockRuleRef[]
  label?: string
  /** 既有帧字段（多方块文档不用，保留兼容） */
  durationMs?: number
  /** 可选参考网格（校验/取证用；生产产物必须省略） */
  cellGrid?: number[][][]
  raw: Record<string, unknown>
}

export interface MultiblockRunstateCoverage {
  /** "texture-material-swap" | "none" */
  kind: string
  /** cellGrid 是否随运行态变化（目前恒 false） */
  geometryDelta: boolean
  /** 恒为 "not-covered"（口径） */
  tesr: string
}

export interface MultiblockViewerSemantics {
  /** 帧语义 = 变体语义（硬约束 2） */
  frameIsVariant: boolean
  /** 帧播放语义，目前恒 "variant-frames" */
  playback: string
  layerPreview: string
  runstateCoverage: MultiblockRunstateCoverage
  raw: Record<string, unknown>
}

/** `multiblock` 节（契约 §4.1）。 */
export interface MultiblockDecl {
  id: string
  /** 多方块显示名（硬约束 3） */
  displayName: string
  sourceClass?: string
  /** 是否存在「一位置多通道」例外 */
  hasScopeOverlap: boolean
  scopeOverlapNote?: string
  totalTierDomain: MultiblockTotalTierDomain
  /** 本文档**实际声明**的总 Tier 取值清单（空 = 未声明，视为整个 totalTierDomain） */
  tierSample: number[]
  channels: MultiblockChannelDecl[]
  runstates: MultiblockRunstateDecl[]
  couplingMode: MultiblockCouplingMode
  couplings: MultiblockCouplingDecl[]
  notes: MultiblockNoteDecl[]
  viewerSemantics: MultiblockViewerSemantics
  /** 恒为 "union-all-variants" */
  paletteSource: string
  /** 几何编码（目前 "bakedQuadsJsonV1"） */
  geometryEncoding: string
  /** 规则说明池（一处解释，全文引用） */
  opsLegend: Record<string, string>
  backbone: MultiblockBackbone
  rules: MultiblockRuleDecl[]
  variants: MultiblockVariantDecl[]
  /** O(1) 查表（装配器与通道面板直接用）。**由域层唯一实现构造**（`multiblockIndexViewOf`）。 */
  ruleById: ReadonlyMap<string, MultiblockRuleDecl>
  variantByKey: ReadonlyMap<string, MultiblockVariantDecl>
  channelByKey: ReadonlyMap<string, MultiblockChannelDecl>
  runstateById: ReadonlyMap<string, MultiblockRunstateDecl>
  raw: Record<string, unknown>
}

/** 一份多方块文档的完整声明（`multiblock` 节 + 根级 `frames` / 并集调色板）。 */
export interface MultiblockDeclaration {
  schemaVersion?: number
  multiblockCount: number
  decl: MultiblockDecl
  /** 根级 frames（变体存储原语，每变体 ≥1 帧） */
  frames: MultiblockFrameDecl[]
  /** 根级并集调色板（`blockPalette[0]` 恒为 air） */
  blockPalette: unknown[]
  materialPalette?: unknown[]
  textureBlobs?: unknown[]
  tooltipPalette?: unknown[]
  /** 声明瑕疵（不阻断加载） */
  warnings: string[]
  /** 信封内层 body 原文 —— 装配器的输入（契约 §5.4 的 `doc`） */
  raw: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// 判别（契约 §2 / §2.3）
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 读取文档级形态枚举量：信封看 `meta.documentShape`（真实产物），裸体看根级 `documentShape`。
 * 缺省 = 未声明 = 「帧为主」（§2）。
 */
export function readDocumentShape(doc: unknown): unknown {
  if (!isPlainObject(doc)) return undefined
  if (doc.documentShape !== undefined) return doc.documentShape
  const meta = doc.meta
  if (isPlainObject(meta) && meta.documentShape !== undefined) return meta.documentShape
  return undefined
}

/** `documentShape === "multiblock"`：形态枚举量判别（与缺省「帧为主」互斥）。 */
export function isMultiblockShapeDocument(doc: unknown): boolean {
  return readDocumentShape(doc) === MULTIBLOCK_DOCUMENT_SHAPE
}

/**
 * 契约 §2 的完整判别式（形态键 + `multiblock` 节 + `multiblockCount === 1` + 无根级 `cellGrid`）。
 *
 * 注意与 `isMultiblockShapeDocument` 的分工：**判别（detect）只看形态键**，
 * 其余三条是 §2.3 的解析期**硬断言** —— 声明了形态却不满足者必须显式报错，而不是被静默交给别的 parser。
 */
export function isMultiblockDocument(inner: unknown): boolean {
  if (!isPlainObject(inner)) return false
  return (
    inner.documentShape === MULTIBLOCK_DOCUMENT_SHAPE &&
    isPlainObject(inner.multiblock) &&
    inner.multiblockCount === 1 &&
    !Array.isArray(inner.cellGrid)
  )
}

// ---------------------------------------------------------------------------
// 读取辅助（严格：类型不符即硬失败，并给出可定位的原因）
// ---------------------------------------------------------------------------

function fail(reason: string): never {
  throw new MultiblockParseError(reason)
}

/**
 * **第一个**重复出现的键（无重复 = `null`）。
 *
 * ## 为什么"查重复"与"建索引"分成两件事
 *
 * 「重复主键 = 文件非法」是**解析期**的判定：它要一条能指到具体键的消息
 * （`规则 id 重复：<id>`），且必须在**读到清单后立刻**判（后面的解析不该在一个
 * 已知非法的文档上继续跑）。
 *
 * 而"按主键查"的索引构造是**纯派生**（`domain/multiblockDocument#multiblockIndexViewOf`，
 * 重复时按 `Map` 语义后写覆盖）——它是域层**唯一**的索引实现（同一语义不得有
 * 第二处实现），**不**承担抛错职责（域层不该有"解析器消息"）。
 *
 * 注：本函数的扫描口径是"清单**顺序**上的第一个重复键"。这与旧形态
 * （边建 `Map` 边 `has` 检查）在**首个**重复键上完全一致 —— 该行为在改写前
 * **全树无覆盖**（实测 `规则 id 重复`/`变体键重复` 两条消息 0 个测试命中），
 * 判据见 `context/parsers/__tests__/multiblockIndexViewWiring.test.ts`。
 */
function firstDuplicateKey(keys: readonly string[]): string | null {
  const seen = new Set<string>()
  for (const k of keys) {
    if (seen.has(k)) return k
    seen.add(k)
  }
  return null
}

function reqObject(v: unknown, what: string): Record<string, unknown> {
  if (!isPlainObject(v)) fail(`${what} 必须是对象（实际 ${describe(v)}）`)
  return v
}

function reqArray(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) fail(`${what} 必须是数组（实际 ${describe(v)}）`)
  return v
}

function reqString(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length === 0) fail(`${what} 必须是非空字符串（实际 ${describe(v)}）`)
  return v
}

function reqNumber(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${what} 必须是有限数字（实际 ${describe(v)}）`)
  return v
}

function reqInteger(v: unknown, what: string): number {
  const n = reqNumber(v, what)
  if (!Number.isInteger(n)) fail(`${what} 必须是整数（实际 ${describe(v)}）`)
  return n
}

function optNumber(v: unknown, what: string): number | undefined {
  if (v === undefined || v === null) return undefined
  return reqNumber(v, what)
}

function optString(v: unknown, what: string): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') fail(`${what} 必须是字符串（实际 ${describe(v)}）`)
  return v
}

function describe(v: unknown): string {
  if (v === undefined) return 'undefined'
  if (v === null) return 'null'
  if (Array.isArray(v)) return `array(${v.length})`
  if (typeof v === 'object') return 'object'
  return JSON.stringify(v)
}

function detectGridShape(grid: number[][][]): { w: number; h: number; d: number } {
  const d = grid.length
  const h = grid[0]?.length ?? 0
  const w = grid[0]?.[0]?.length ?? 0
  return { w, h, d }
}

function readNumericRecord(v: unknown, what: string): Record<string, number> {
  const o = reqObject(v, what)
  const out: Record<string, number> = {}
  for (const [k, value] of Object.entries(o)) {
    out[k] = reqNumber(value, `${what}.${k}`)
  }
  return out
}

// ---------------------------------------------------------------------------
// 解析 + 校验
// ---------------------------------------------------------------------------

function parseChannel(
  raw: Record<string, unknown>,
  totalTierMax: number,
  warnings: string[],
): MultiblockChannelDecl {
  const key = reqString(raw.key, 'multiblock.channels[].key')
  const id = reqString(raw.id, 'multiblock.channels[].id')
  const name = reqString(raw.name, `通道 ${key} 的呈现名 name`)
  const kindRaw = raw.kind
  if (kindRaw !== 'size' && kindRaw !== 'replace' && kindRaw !== 'hatch') {
    fail(`通道 ${key} 的 kind 非法：${describe(kindRaw)}（合法值 "size" | "replace" | "hatch"）`)
  }
  const kind: MultiblockChannelKind = kindRaw
  if (!('enum' in raw)) fail(`通道 ${key} 缺 enum 字段（可为 null，但必须显式声明，契约 §4.2 双键消歧）`)
  const enumName = raw.enum === null || raw.enum === undefined
    ? null
    : reqString(raw.enum, `通道 ${key} 的 enum`)

  // 取值域：lo 恒为 0（"Not set" 恒在域内），hi = 声明 max ?? 总 Tier 域上界（§4.2）
  let domainHi = totalTierMax
  if (raw.domain !== undefined) {
    const dom = reqObject(raw.domain, `通道 ${key} 的 domain`)
    domainHi = dom.max === undefined || dom.max === null
      ? totalTierMax
      : reqNumber(dom.max, `通道 ${key} 的 domain.max`)
  }
  const declaredMin = optNumber(raw.min, `通道 ${key} 的 min`)
  const declaredMax = optNumber(raw.max, `通道 ${key} 的 max`)
  if (kind === 'size' && (declaredMin === undefined || declaredMax === undefined)) {
    fail(`尺寸型通道 ${key} 必须带 min/max（getValueClamped 的偏移语义，契约 §4.2）`)
  }
  const slider = raw.slider === undefined ? kind !== 'hatch' : raw.slider === true
  if (kind === 'hatch' && raw.slider === true) {
    fail(`舱口布局通道 ${key} 不得生成滑杆（契约 §4.2 规则 3）`)
  }
  if (kind === 'size' && declaredMin !== undefined && declaredMin !== 0 && domainHi < declaredMin) {
    warnings.push(`通道 ${key} 的有效取值下界 ${declaredMin} > 取值域上界 ${domainHi}`)
  }

  return {
    enumName,
    id,
    key,
    name,
    kind,
    slot: optString(raw.slot, `通道 ${key} 的 slot`),
    min: declaredMin ?? 1,
    max: declaredMax ?? domainHi,
    axis: optString(raw.axis, `通道 ${key} 的 axis`),
    unit: optString(raw.unit, `通道 ${key} 的 unit`),
    valueSemantics: optString(raw.valueSemantics, `通道 ${key} 的 valueSemantics`),
    domainSource: optString(raw.domainSource, `通道 ${key} 的 domainSource`),
    domain: { lo: 0, hi: domainHi },
    slider,
    raw,
  }
}

function parseAxisSpec(v: unknown, what: string): MultiblockAxisSpec | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'number') return reqNumber(v, what)
  if (Array.isArray(v)) return v.map((x, i) => reqInteger(x, `${what}[${i}]`))
  fail(`${what} 必须是数字或数字数组（实际 ${describe(v)}）`)
}

function parseRule(
  raw: Record<string, unknown>,
  channelKeys: Set<string>,
  warnings: string[],
): MultiblockRuleDecl {
  const id = reqString(raw.id, 'multiblock.rules[].id')
  const phaseRaw = raw.phase
  if (phaseRaw !== 'backbone' && phaseRaw !== 'replace' && phaseRaw !== 'runstate') {
    fail(`规则 ${id} 的 phase 非法：${describe(phaseRaw)}（合法值 "backbone" | "replace" | "runstate"）`)
  }
  const kindRaw = raw.kind
  if (kindRaw !== 'setCell' && kindRaw !== 'fill') {
    fail(`规则 ${id} 的 kind 非法：${describe(kindRaw)}（装配器只认 "setCell" | "fill"）`)
  }

  const index = optNumber(raw.index, `规则 ${id} 的 index`)
  const indexRole = optString(raw.indexRole, `规则 ${id} 的 indexRole`)
  let indexTable: number[] | undefined
  if (raw.indexTable !== undefined && raw.indexTable !== null) {
    indexTable = reqArray(raw.indexTable, `规则 ${id} 的 indexTable`).map((x, i) =>
      reqInteger(x, `规则 ${id} 的 indexTable[${i}]`),
    )
  }
  if (index === undefined && indexRole === undefined && indexTable === undefined) {
    fail(`规则 ${id} 既无 index、也无 indexRole/indexTable（无法确定写入内容，契约 §4.5）`)
  }
  const channel = optString(raw.channel, `规则 ${id} 的 channel`)
  if (indexTable !== undefined) {
    if (channel === undefined) fail(`规则 ${id} 带 indexTable 但缺 channel（查表下标来源未声明）`)
    if (!channelKeys.has(channel)) fail(`规则 ${id} 的 indexTable 引用了未声明通道 ${channel}`)
  }

  let indexAliases: Record<string, number> | undefined
  if (raw.indexAliases !== undefined && raw.indexAliases !== null) {
    indexAliases = readNumericRecord(raw.indexAliases, `规则 ${id} 的 indexAliases`)
  }

  let guard: MultiblockGuard | undefined
  if (raw.guard !== undefined && raw.guard !== null) {
    const g = reqObject(raw.guard, `规则 ${id} 的 guard`)
    const clausesRaw = g.clauses === undefined ? [] : reqArray(g.clauses, `规则 ${id} 的 guard.clauses`)
    const clauses: MultiblockGuardClause[] = clausesRaw.map((c, i) => {
      const cl = reqObject(c, `规则 ${id} 的 guard.clauses[${i}]`)
      const clChannel = reqString(cl.channel, `规则 ${id} 的 guard.clauses[${i}].channel`)
      if (!channelKeys.has(clChannel)) {
        fail(`规则 ${id} 的 guard 引用了未声明通道 ${clChannel}`)
      }
      return {
        channel: clChannel,
        value: optNumber(cl.value, `规则 ${id} 的 guard.clauses[${i}].value`),
        min: optNumber(cl.min, `规则 ${id} 的 guard.clauses[${i}].min`),
        max: optNumber(cl.max, `规则 ${id} 的 guard.clauses[${i}].max`),
        not: cl.not === true ? true : undefined,
        raw: cl,
      }
    })
    guard = { not: g.not === true ? true : undefined, clauses }
  }

  const selRaw = raw.sel === undefined || raw.sel === null
    ? undefined
    : reqObject(raw.sel, `规则 ${id} 的 sel`)

  void warnings
  return {
    id,
    phase: phaseRaw,
    legend: optString(raw.legend, `规则 ${id} 的 legend`),
    kind: kindRaw,
    x: optNumber(raw.x, `规则 ${id} 的 x`),
    y: optNumber(raw.y, `规则 ${id} 的 y`),
    z: optNumber(raw.z, `规则 ${id} 的 z`),
    sel: selRaw
      ? {
          x: parseAxisSpec(selRaw.x, `规则 ${id} 的 sel.x`),
          y: parseAxisSpec(selRaw.y, `规则 ${id} 的 sel.y`),
          z: parseAxisSpec(selRaw.z, `规则 ${id} 的 sel.z`),
        }
      : undefined,
    index,
    indexRole,
    channel,
    indexTable,
    indexAliases,
    guard,
    raw,
  }
}

function parseSizeStep(raw: Record<string, unknown>, i: number, warnings: string[]): MultiblockSizeStep {
  const channel = reqString(raw.channel, `backbone.sizeSteps[${i}].channel`)
  const w = reqInteger(raw.w, `backbone.sizeSteps[${i}].w`)
  const hh = reqInteger(raw.hh, `backbone.sizeSteps[${i}].hh`)
  const d = reqInteger(raw.d, `backbone.sizeSteps[${i}].d`)
  const cellGrid = reqArray(raw.cellGrid, `backbone.sizeSteps[${i}].cellGrid`) as number[][][]
  const actual = detectGridShape(cellGrid)
  if (actual.w !== w || actual.h !== hh || actual.d !== d) {
    warnings.push(
      `骨架阶 ${i}（通道 ${channel}）声明尺寸 [${w},${hh},${d}] ≠ cellGrid 实际 [${actual.w},${actual.h},${actual.d}]`,
    )
  }
  const roles = raw.roles === undefined || raw.roles === null
    ? {}
    : readNumericRecord(raw.roles, `backbone.sizeSteps[${i}].roles`)
  return {
    channel,
    layers: optNumber(raw.layers, `backbone.sizeSteps[${i}].layers`),
    w,
    hh,
    d,
    roles,
    cellGrid,
    raw,
  }
}

function parseVariant(raw: Record<string, unknown>, i: number, warnings: string[]): MultiblockVariantDecl {
  const key = reqString(raw.key, `multiblock.variants[${i}].key`)
  const totalTier = reqInteger(raw.totalTier, `变体 ${key} 的 totalTier`)
  const valuesRaw = raw.values === undefined ? {} : reqObject(raw.values, `变体 ${key} 的 values`)
  const values: Record<string, number> = {}
  for (const [k, v] of Object.entries(valuesRaw)) {
    values[k] = reqInteger(v, `变体 ${key} 的 values.${k}`)
  }
  const runstate = reqString(raw.runstate, `变体 ${key} 的 runstate`)
  void warnings
  return { key, totalTier, values, runstate, raw }
}

function parseFrame(
  raw: Record<string, unknown>,
  i: number,
  variantByKey: ReadonlyMap<string, MultiblockVariantDecl>,
  ruleIds: Set<string>,
  stepCount: number,
  warnings: string[],
): MultiblockFrameDecl {
  if ('ops' in raw) {
    fail(
      `frame ${i} 携带内联 ops：差异规则必须只存一份（multiblock.rules）并由 frame 按 id 引用，` +
        '禁止把规则写进帧（组合展开形态，契约 §5.3）',
    )
  }
  const index = raw.index === undefined ? i : reqInteger(raw.index, `frames[${i}].index`)
  const variant = reqString(raw.variant, `frame ${index} 的 variant`)
  const variantDecl = variantByKey.get(variant)
  if (!variantDecl) fail(`frame ${index} 的 variant 未在 multiblock.variants 中声明：${variant}`)
  const stepIndex = reqInteger(raw.stepIndex, `frame ${index} 的 stepIndex`)
  if (stepIndex < 0 || stepIndex >= stepCount) {
    fail(`frame ${index} 的 stepIndex=${stepIndex} 越界（骨架 ${stepCount} 阶）`)
  }
  const rulesRaw = reqArray(raw.rules, `frame ${index} 的 rules`)
  const rules: MultiblockRuleRef[] = rulesRaw.map((r, k) => {
    if (typeof r === 'string') {
      if (!ruleIds.has(r)) fail(`frame ${index} 引用了未声明规则 ${r}`)
      return { id: r, order: k }
    }
    const o = reqObject(r, `frame ${index} 的 rules[${k}]`)
    const id = reqString(o.id, `frame ${index} 的 rules[${k}].id`)
    if (!ruleIds.has(id)) fail(`frame ${index} 引用了未声明规则 ${id}`)
    return { id, order: optNumber(o.order, `frame ${index} 的 rules[${k}].order`) ?? k }
  })
  const runstate = optString(raw.runstate, `frame ${index} 的 runstate`) ?? variantDecl.runstate
  if (runstate !== variantDecl.runstate) {
    warnings.push(
      `frame ${index} 的 runstate=${runstate} 与变体 ${variant} 的 runstate=${variantDecl.runstate} 不一致`,
    )
  }
  return {
    index,
    variant,
    runstate,
    stepIndex,
    rules,
    label: optString(raw.label, `frame ${index} 的 label`),
    durationMs: optNumber(raw.durationMs, `frame ${index} 的 durationMs`),
    cellGrid: Array.isArray(raw.cellGrid) ? (raw.cellGrid as number[][][]) : undefined,
    raw,
  }
}

/**
 * 解析 + 校验信封内层 body（或裸体根对象）→ 类型化声明。
 * 任何结构缺失/悬空引用/形态违反都抛 `MultiblockParseError`（带原因），绝不静默退化。
 */
export function parseMultiblockDeclaration(inner: Record<string, unknown>): MultiblockDeclaration {
  if (!isPlainObject(inner)) fail(`内层 body 必须是 JSON 对象（实际 ${describe(inner)}）`)
  const warnings: string[] = []

  // ---- §2.3 形态互斥的机器断言 ----
  if (Array.isArray(inner.cellGrid)) {
    fail(
      'documentShape="multiblock" 的文档不得带根级 cellGrid' +
        '（那是「帧为主」形态的根级展开约定，契约 §2）',
    )
  }
  const multiblock = inner.multiblock
  if (!isPlainObject(multiblock)) {
    fail(`documentShape="${MULTIBLOCK_DOCUMENT_SHAPE}" 要求内层存在 multiblock 对象（实际 ${describe(multiblock)}）`)
  }
  if (inner.multiblockCount !== 1) {
    fail(`multiblockCount 必须为 1（本格式「一份文件 = 一台多方块」），实际 ${describe(inner.multiblockCount)}`)
  }

  // ---- 总 Tier 域（§4.1） ----
  const ttRaw = reqObject(multiblock.totalTierDomain, 'multiblock.totalTierDomain')
  const ttMin = reqNumber(ttRaw.min, 'multiblock.totalTierDomain.min')
  const ttMax = reqNumber(ttRaw.max, 'multiblock.totalTierDomain.max')

  // ---- 通道清单（§4.2） ----
  const channelsRaw = reqArray(multiblock.channels, 'multiblock.channels')
  const channels = channelsRaw.map((c, i) =>
    parseChannel(reqObject(c, `multiblock.channels[${i}]`), ttMax, warnings),
  )
  const channelKeys = new Set<string>()
  const channelIds = new Set<string>()
  const channelNames = new Set<string>()
  for (const ch of channels) {
    if (channelKeys.has(ch.key)) fail(`通道 key 重复：${ch.key}`)
    channelKeys.add(ch.key)
    if (channelIds.has(ch.id)) {
      fail(`同一多方块内通道 id 重复：${ch.id}（契约 §4.2 规则 3：导出应失败并落盘原因，不得静默改名）`)
    }
    channelIds.add(ch.id)
    if (channelNames.has(ch.name)) fail(`通道呈现名重复：${ch.name}（UI 必须可区分）`)
    channelNames.add(ch.name)
  }

  // ---- 运行态清单（§7.1） ----
  const runstatesRaw = reqArray(multiblock.runstates, 'multiblock.runstates')
  if (runstatesRaw.length === 0) {
    fail('multiblock.runstates 不得为空（单态也要显式声明，如 [{id:"idle",name:"Idle"}]，契约 §7.1）')
  }
  const runstates: MultiblockRunstateDecl[] = runstatesRaw.map((r, i) => {
    const o = reqObject(r, `multiblock.runstates[${i}]`)
    const id = reqString(o.id, `multiblock.runstates[${i}].id`)
    const name = reqString(o.name, `运行态 ${id} 的呈现名 name（契约 §7.1 硬约束 3）`)
    return { id, name, materialSwap: o.materialSwap === true, raw: o }
  })
  const runstateIds = new Set(runstates.map(r => r.id))
  if (runstateIds.size !== runstates.length) fail('multiblock.runstates 存在重复 id')

  // ---- 骨架（§4.4） ----
  const backboneRaw = reqObject(multiblock.backbone, 'multiblock.backbone')
  if (backboneRaw.kind !== 'sizeSteps') {
    fail(`multiblock.backbone.kind 必须为 "sizeSteps"（本轮只允许一种骨干，§4.6），实际 ${describe(backboneRaw.kind)}`)
  }
  const sizeChannel = reqString(backboneRaw.sizeChannel, 'multiblock.backbone.sizeChannel')
  const stepsRaw = reqArray(backboneRaw.sizeSteps, 'multiblock.backbone.sizeSteps')
  if (stepsRaw.length === 0) fail('multiblock.backbone.sizeSteps 不得为空')
  const sizeSteps = stepsRaw.map((s, i) =>
    parseSizeStep(reqObject(s, `multiblock.backbone.sizeSteps[${i}]`), i, warnings),
  )
  const sizeChannels = channels.filter(c => c.kind === 'size')
  if (sizeChannels.length > 0 && !sizeChannels.some(c => c.key === sizeChannel)) {
    fail(
      `multiblock.backbone.sizeChannel=${sizeChannel} 不是尺寸型通道` +
        `（本文档尺寸型通道：${sizeChannels.map(c => c.key).join(', ')}）`,
    )
  }
  const primarySize = sizeChannels.find(c => c.key === sizeChannel)
  if (primarySize && sizeSteps.length !== primarySize.max - primarySize.min + 1) {
    warnings.push(
      `骨架阶数 ${sizeSteps.length} ≠ 尺寸通道 ${primarySize.key} 的域长度 ` +
        `${primarySize.max - primarySize.min + 1}（契约 §4.4：阶数必须 = 域长度）`,
    )
  }
  const backbone: MultiblockBackbone = { kind: backboneRaw.kind, sizeChannel, sizeSteps, raw: backboneRaw }

  // ---- 差异规则表（§4.5） ----
  const rulesRaw = reqArray(multiblock.rules, 'multiblock.rules')
  if (rulesRaw.length === 0) {
    fail('multiblock.rules 不得为空（差异规则表按引用复用，禁止组合展开，契约 §4.5）')
  }
  const rules = rulesRaw.map((r, i) =>
    parseRule(reqObject(r, `multiblock.rules[${i}]`), channelKeys, warnings),
  )
  // 重复主键的**校验**（解析期硬断言）与索引**构造**是两件事：
  // 前者要可定位的消息（`规则 id 重复：<id>`），后者是域层唯一实现
  // （`multiblockIndexViewOf`；口径：这里不得再自建 Map 索引）。
  const dupRuleId = firstDuplicateKey(rules.map((r) => r.id))
  if (dupRuleId !== null) fail(`规则 id 重复：${dupRuleId}（文件内必须唯一）`)
  const opsLegendRaw = multiblock.opsLegend === undefined || multiblock.opsLegend === null
    ? {}
    : reqObject(multiblock.opsLegend, 'multiblock.opsLegend')
  const opsLegend: Record<string, string> = {}
  for (const [k, v] of Object.entries(opsLegendRaw)) {
    opsLegend[k] = reqString(v, `multiblock.opsLegend.${k}`)
  }
  for (const r of rules) {
    if (r.legend !== undefined && !(r.legend in opsLegend)) {
      warnings.push(`规则 ${r.id} 的 legend=${r.legend} 未在 multiblock.opsLegend 中登记`)
    }
  }
  // indexTable 长度必须 ≥ 该通道取值域长度（第 0 档就是「未设置」分支，契约 §4.5）
  for (const r of rules) {
    if (r.indexTable === undefined || r.channel === undefined) continue
    const ch = channels.find(c => c.key === r.channel)
    if (!ch) continue
    const need = ch.domain.hi + 1
    if (r.indexTable.length < need) {
      fail(
        `规则 ${r.id} 的 indexTable 长度 ${r.indexTable.length} < 通道 ${ch.key} 的取值域长度 ${need}` +
          `（档 0 = "未设置"，契约 §4.5）`,
      )
    }
  }

  // ---- 变体清单（§5.1） ----
  const variantsRaw = reqArray(multiblock.variants, 'multiblock.variants')
  if (variantsRaw.length === 0) fail('multiblock.variants 不得为空')
  const variants = variantsRaw.map((v, i) =>
    parseVariant(reqObject(v, `multiblock.variants[${i}]`), i, warnings),
  )
  const dupVariantKey = firstDuplicateKey(variants.map((v) => v.key))
  if (dupVariantKey !== null) fail(`变体键重复：${dupVariantKey}`)
  // 索引读视图：**唯一**构造点（域层纯函数）。键集固定为四张表 —— 不含 `raw`。
  const index = multiblockIndexViewOf({ rules, variants, channels, runstates })
  const variantByKey = index.variantByKey
  const ruleById = index.ruleById
  for (const v of variants) {
    if (!runstateIds.has(v.runstate)) {
      warnings.push(`变体 ${v.key} 的 runstate=${v.runstate} 未在 multiblock.runstates 中声明`)
    }
    for (const k of Object.keys(v.values)) {
      if (!channelKeys.has(k)) warnings.push(`变体 ${v.key} 的 values 含未声明通道 ${k}`)
    }
  }

  // ---- 帧（§5.3：Frame 是唯一变体存储原语） ----
  const framesRaw = reqArray(inner.frames, 'frames')
  if (framesRaw.length === 0) fail('frames 不得为空（每个变体至少一帧，契约 §5.3）')
  const ruleIds = new Set(ruleById.keys())
  const frames = framesRaw.map((f, i) =>
    parseFrame(reqObject(f, `frames[${i}]`), i, variantByKey, ruleIds, sizeSteps.length, warnings),
  )
  const frameVariants = new Set(frames.map(f => f.variant))
  const noFrame = variants.filter(v => !frameVariants.has(v.key))
  if (noFrame.length > 0) {
    warnings.push(
      `${noFrame.length} 个变体没有对应 frame（Frame 是唯一变体原语，契约 §5.3）：` +
        `${noFrame.slice(0, 3).map(v => v.key).join(', ')}${noFrame.length > 3 ? ' …' : ''}`,
    )
  }

  // ---- 可选元数据（缺省不阻断，契约 §7.2/§7.3/§7.4） ----
  const couplingModeRaw = multiblock.couplingMode ?? 'none'
  if (couplingModeRaw !== 'none' && couplingModeRaw !== 'clamp') {
    fail(`multiblock.couplingMode 非法：${describe(couplingModeRaw)}（合法值 "none" | "clamp"）`)
  }
  const couplings: MultiblockCouplingDecl[] = (multiblock.couplings === undefined || multiblock.couplings === null
    ? []
    : reqArray(multiblock.couplings, 'multiblock.couplings')
  ).map((c, i) => {
    const o = reqObject(c, `multiblock.couplings[${i}]`)
    const id = reqString(o.id, `multiblock.couplings[${i}].id`)
    const a = reqString(o.a, `耦合 ${id} 的 a`)
    const b = reqString(o.b, `耦合 ${id} 的 b`)
    if (!channelKeys.has(a)) fail(`耦合 ${id} 的 a=${a} 不是已声明通道`)
    if (!channelKeys.has(b)) fail(`耦合 ${id} 的 b=${b} 不是已声明通道`)
    const requires = o.requires
    if (requires !== 'ge' && requires !== 'le' && requires !== 'eq') {
      fail(`耦合 ${id} 的 requires 非法：${describe(requires)}（合法值 "ge" | "le" | "eq"）`)
    }
    return {
      id,
      a,
      b,
      requires,
      kind: optString(o.kind, `耦合 ${id} 的 kind`),
      source: optString(o.source, `耦合 ${id} 的 source`),
      raw: o,
    }
  })
  if (couplings.length > 0 && couplingModeRaw === 'none') {
    warnings.push('声明了 couplings 但 couplingMode="none"：耦合不会生效（契约 §7.2 缺省行为）')
  }

  const notes: MultiblockNoteDecl[] = (multiblock.notes === undefined || multiblock.notes === null
    ? []
    : reqArray(multiblock.notes, 'multiblock.notes')
  ).map((n, i) => {
    const o = reqObject(n, `multiblock.notes[${i}]`)
    return {
      kind: optString(o.kind, `multiblock.notes[${i}].kind`) ?? 'note',
      text: reqString(o.text, `multiblock.notes[${i}].text`),
      source: optString(o.source, `multiblock.notes[${i}].source`),
      raw: o,
    }
  })

  const vsRaw = multiblock.viewerSemantics === undefined || multiblock.viewerSemantics === null
    ? {}
    : reqObject(multiblock.viewerSemantics, 'multiblock.viewerSemantics')
  const covRaw = vsRaw.runstateCoverage === undefined || vsRaw.runstateCoverage === null
    ? {}
    : reqObject(vsRaw.runstateCoverage, 'multiblock.viewerSemantics.runstateCoverage')
  const viewerSemantics: MultiblockViewerSemantics = {
    frameIsVariant: vsRaw.frameIsVariant !== false,
    playback: optString(vsRaw.playback, 'multiblock.viewerSemantics.playback') ?? 'variant-frames',
    layerPreview: optString(vsRaw.layerPreview, 'multiblock.viewerSemantics.layerPreview') ?? 'supported',
    runstateCoverage: {
      kind: optString(covRaw.kind, 'multiblock.viewerSemantics.runstateCoverage.kind') ?? 'none',
      geometryDelta: covRaw.geometryDelta === true,
      tesr: optString(covRaw.tesr, 'multiblock.viewerSemantics.runstateCoverage.tesr') ?? 'not-covered',
    },
    raw: vsRaw,
  }
  if (viewerSemantics.runstateCoverage.tesr !== 'not-covered') {
    warnings.push(
      `viewerSemantics.runstateCoverage.tesr=${viewerSemantics.runstateCoverage.tesr}` +
        '（契约 §7.4 要求恒为 "not-covered"：TESR/附属渲染方块本轮不覆盖）',
    )
  }

  const tierSample = (multiblock.tierSample === undefined || multiblock.tierSample === null
    ? []
    : reqArray(multiblock.tierSample, 'multiblock.tierSample').map((t, i) => reqNumber(t, `tierSample[${i}]`))
  )
  for (const t of tierSample) {
    if (t < ttMin || t > ttMax) warnings.push(`tierSample 值 ${t} 越出总 Tier 域 ${ttMin}..${ttMax}`)
  }
  const totalTierDomain: MultiblockTotalTierDomain = {
    min: ttMin,
    max: ttMax,
    default: optNumber(ttRaw.default, 'multiblock.totalTierDomain.default'),
    source: optString(ttRaw.source, 'multiblock.totalTierDomain.source'),
  }

  // ---- 调色板（根级并集，§3/§6.1） ----
  const blockPalette = inner.blockPalette === undefined ? [] : reqArray(inner.blockPalette, 'blockPalette')

  const decl: MultiblockDecl = {
    id: reqString(multiblock.id, 'multiblock.id'),
    displayName: reqString(multiblock.displayName, 'multiblock.displayName（硬约束 3：多方块显示名）'),
    sourceClass: optString(multiblock.sourceClass, 'multiblock.sourceClass'),
    hasScopeOverlap: multiblock.hasScopeOverlap === true,
    scopeOverlapNote: optString(multiblock.scopeOverlapNote, 'multiblock.scopeOverlapNote'),
    totalTierDomain,
    tierSample,
    channels,
    runstates,
    couplingMode: couplingModeRaw,
    couplings,
    notes,
    viewerSemantics,
    paletteSource: optString(multiblock.paletteSource, 'multiblock.paletteSource') ?? '',
    geometryEncoding: optString(multiblock.geometryEncoding, 'multiblock.geometryEncoding') ?? '',
    opsLegend,
    backbone,
    rules,
    variants,
    ruleById: index.ruleById,
    variantByKey: index.variantByKey,
    channelByKey: index.channelByKey,
    runstateById: index.runstateById,
    raw: multiblock,
  }

  return {
    schemaVersion: optNumber(inner.schemaVersion, 'schemaVersion'),
    multiblockCount: 1,
    decl,
    frames,
    blockPalette,
    materialPalette: inner.materialPalette === undefined ? undefined : reqArray(inner.materialPalette, 'materialPalette'),
    textureBlobs: inner.textureBlobs === undefined ? undefined : reqArray(inner.textureBlobs, 'textureBlobs'),
    tooltipPalette: inner.tooltipPalette === undefined ? undefined : reqArray(inner.tooltipPalette, 'tooltipPalette'),
    warnings,
    raw: inner,
  }
}

/**
 * 变体主键派生（契约 §5.1 的唯一派生规则）：
 * `<通道key>:<声明值>` 按 `channels` 数组顺序 `|` 连接，再按序追加 `tt:<总Tier>`、`runstate:<id>`。
 * 键里的值恒为**声明值**（未设置写 0），与装配期求值的有效值无关。
 * 导出以便 UI 与装配器用同一把钥匙定位变体。
 */
export function multiblockVariantKey(
  decl: { readonly channels: readonly { readonly key: string }[] },
  values: Record<string, number>,
  runstate: string,
  totalTier: number,
): string {
  const parts = decl.channels.map(c => `${c.key}:${values[c.key] ?? 0}`)
  parts.push(`tt:${totalTier}`)
  parts.push(`runstate:${runstate}`)
  return parts.join('|')
}
