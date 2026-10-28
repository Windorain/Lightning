/**
 * 多方块契约 JSON 的类型（`docs/contracts/format-multiblock-doc.md` §3–§7）。
 *
 * **本包只面向契约 JSON 编程**：不 import RuntimeDocument、不 import 任何 GT/StructureLib 知识。
 * 这里的接口是"文档里写了什么"的直译，不含任何游戏语义推导。
 */

// ---------------------------------------------------------------------------
// 通道 / 骨架 / 规则（契约 §4）
// ---------------------------------------------------------------------------

/** 通道种类（契约 §4.3）：`size` 选骨架阶、`replace` 写内容、`hatch` 暂不参与装配。 */
export type ChannelKind = 'size' | 'replace' | 'hatch'

/** 装配相位（契约 §5.4）：尺寸型已由 stepIndex 完成，剩下三档。 */
export type AssemblyPhase = 'backbone' | 'replace' | 'runstate'

/** 规则写入方式（契约 §4.5）：装配器只认这两种。 */
export type RuleKind = 'setCell' | 'fill'

/** 通道取值域：`0` 恒为"未设置"（Not set），`max` 缺省 = 总 Tier 域上界。 */
export interface ChannelDomain {
  min?: number
  max?: number
}

/** 通道清单条目（契约 §4.2）。 */
export interface MultiblockChannel {
  /** GTStructureChannels 枚举名；null = 非枚举通道 */
  enum?: string | null
  /** 游戏内通道 id（小写） */
  id: string
  /** 本文档内唯一键（= id；重名 id 时用 enum 派生） */
  key: string
  /** **呈现名（UI 标签）**，取 enumName 语义 */
  name: string
  kind: ChannelKind
  /** 位置集合的稳定名字（语义说明，装配器不使用） */
  slot?: string
  /** 有效取值下界（replace） */
  min?: number
  /** 有效取值上界（replace） */
  max?: number
  /** 尺寸作用轴（size） */
  axis?: string
  /** 尺寸单位（size） */
  unit?: string
  /** 尺寸取值语义标注（size），装配器只做夹取、不解释 */
  valueSemantics?: string
  domainSource?: string
  domain?: ChannelDomain
  [k: string]: unknown
}

/** 骨架阶（契约 §4.4）。`cellGrid` 朝向与既有约定一致：`[z][y][x]`，**row 0 = 顶部**。 */
export interface MultiblockSizeStep {
  channel: string
  /** 语义标注（层数），装配器不使用 */
  layers?: number
  w: number
  /** 该阶高度（字段名沿用契约的 `hh`，避免与 `MultiblockSizeStep.h` 混淆） */
  hh: number
  d: number
  /** 语义角色 → 调色板下标（`indexRole` 的查表目标） */
  roles?: Record<string, number>
  cellGrid: number[][][]
  [k: string]: unknown
}

/** 骨架（契约 §4.4）：目前只允许一个尺寸型通道。 */
export interface MultiblockBackbone {
  kind: string
  sizeChannel: string
  sizeSteps: MultiblockSizeStep[]
  [k: string]: unknown
}

/** guard 子句（契约 §4.5.3）：四种形态之一，之间 AND。 */
export interface GuardClause {
  channel: string
  value?: number
  min?: number
  max?: number
  not?: boolean
}

/** guard（契约 §4.5.3）：`not:true` 对整体取反；无 clauses = 恒真。 */
export interface Guard {
  clauses?: GuardClause[]
  not?: boolean
  [k: string]: unknown
}

/** `fill` 的单轴写法（契约 §4.5.1）：数组 = 逐层一个坐标；数字 = 每层同一坐标；缺省 = 全长。 */
export type AxisSelector = number | number[]

/** 差异规则（契约 §4.5）。**按引用复用**：frame 只存 id。 */
export interface MultiblockRule {
  id: string
  phase?: AssemblyPhase
  legend?: string
  kind: RuleKind
  guard?: Guard
  /** 写入什么（三选一，纯查表） */
  index?: number
  indexRole?: string
  channel?: string
  indexTable?: number[]
  /** 「旧下标 → 新下标」整表批量替换（写入之前执行一次） */
  indexAliases?: Record<string, number>
  /** `setCell` 单格坐标 */
  x?: number
  y?: number
  z?: number
  /** `fill` 区间 */
  sel?: { x?: AxisSelector; y?: AxisSelector; z?: AxisSelector }
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// 变体 / 帧（契约 §5）
// ---------------------------------------------------------------------------

/** 变体声明（契约 §5.1）。`key` 是主键，值恒为**声明值**（未设置写 0）。 */
export interface MultiblockVariant {
  key: string
  totalTier?: number
  values?: Record<string, number>
  runstate?: string
  [k: string]: unknown
}

/** frame 的规则引用：纯字符串 = 声明顺序；对象形式可显式给 `order`。 */
export type MultiblockRuleRef = string | { id: string; order?: number }

/** 帧（契约 §5.3）：**唯一**变体存储原语，不携带内联 ops。 */
export interface MultiblockFrame {
  index?: number
  /** 变体主键（frame → variant 的引用） */
  variant: string
  runstate?: string
  /** 本帧用哪一阶骨架 */
  stepIndex?: number
  rules?: MultiblockRuleRef[]
  label?: string
  durationMs?: number
  /** 参考网格：只作校验/取证，生产产物省略 */
  cellGrid?: number[][][]
  [k: string]: unknown
}

/** 运行态声明（契约 §7.1）。 */
export interface MultiblockRunstate {
  id: string
  /** **UI 呈现名**（文件自带，不依赖 GT 语言文件） */
  name?: string
  materialSwap?: boolean
  [k: string]: unknown
}

/**
 * 通道耦合（契约 §7.2）：语义为 `effective[a] (requires) effective[b]`；
 * 违反时把 `effective[b]` 夹到满足为止（`b` 是被夹取的一方）。
 */
export interface MultiblockCoupling {
  id?: string
  a: string
  b: string
  requires: 'ge' | 'le' | 'eq' | string
  kind?: string
  source?: string
  [k: string]: unknown
}

/** 总 Tier 域（契约 §4.1）。 */
export interface TotalTierDomain {
  min: number
  max: number
  default?: number
  source?: string
  [k: string]: unknown
}

/** 可装配性的最小骨架：装配器只读这些键，其余键原样忽略。 */
export interface MultiblockBackboneRef {
  kind: string
  sizeChannel: string
  sizeSteps: MultiblockSizeStep[]
}

/** `multiblock` 对象（契约 §4.1）。 */
export interface MultiblockDecl {
  id: string
  displayName?: string
  sourceClass?: string
  hasScopeOverlap?: boolean
  scopeOverlapNote?: string
  totalTierDomain: TotalTierDomain
  /** 本文档**实际声明**的总 Tier 取值清单 */
  tierSample?: number[]
  channels: MultiblockChannel[]
  runstates: MultiblockRunstate[]
  couplingMode?: 'none' | 'clamp' | string
  couplings?: MultiblockCoupling[]
  notes?: Array<Record<string, unknown>>
  viewerSemantics?: Record<string, unknown>
  paletteSource?: string
  geometryEncoding?: string
  opsLegend?: Record<string, string>
  backbone: MultiblockBackboneRef & Record<string, unknown>
  rules: MultiblockRule[]
  variants: MultiblockVariant[]
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// 内层 body（契约 §3）
// ---------------------------------------------------------------------------

/** 调色板条目（契约 §6）：`blockPalette[0]` 恒为 air。 */
export interface MultiblockPaletteEntry {
  registryId: string
  meta?: number
  [k: string]: unknown
}

/**
 * 信封内层 body 的最小形态。
 *
 * 这是装配器的**唯一输入**（`multiblock` + `blockPalette` + `frames`）。信封解包（base64/gzip）
 * 属解析器的职责，本包不重复实现。
 */
export interface MultiblockInnerDocument {
  schemaVersion?: number
  multiblockCount?: number
  multiblock?: MultiblockDecl
  blockPalette?: MultiblockPaletteEntry[]
  frames?: MultiblockFrame[]
  materialPalette?: unknown[]
  textureBlobs?: unknown[]
  tooltipPalette?: unknown[]
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// 装配输入 / 输出
// ---------------------------------------------------------------------------

/** 取值选择（UI 接线的输入）：声明值 0 = "Not set"。 */
export interface MultiblockSelection {
  /** 总 Tier（"总通道"）；缺省取 `totalTierDomain.default` */
  totalTier?: number
  /** `channelKey → 声明值`（未出现的通道视为 0 = Not set） */
  values?: Record<string, number>
  /** 运行态 id；缺省取 `runstates[0]` */
  runstate?: string
}

/** 网格尺寸。 */
export interface Dims {
  w: number
  h: number
  d: number
}

/** 域夹取记录（契约 §5.2）：`was` 是夹取**前**的有效值。 */
export interface DomainClampRecord {
  field: string
  was: number
  now: number
  reason: 'domain'
}

/** 耦合夹取记录（契约 §7.2）。 */
export interface CouplingClampRecord {
  coupling: string
  a: string
  b: string
  requires: string
  bWas: number
  bNow: number
}

export type ClampRecord = DomainClampRecord | CouplingClampRecord

/** 装配报告：夹取清单 + 诊断（UI 提示的落点）。 */
export interface AssemblyReport {
  variantKey: string
  frameIndex: number
  runstate: string
  totalTier: number
  /** 本帧实际使用的骨架阶 */
  stepIndex: number
  dims: Dims
  /** 夹取后的有效取值（`channelKey → 有效值`） */
  effective: Record<string, number>
  clamped: ClampRecord[]
  /** 被拒绝的组合：契约 §5.2/§5.4 的「只夹取不拒绝」 下**恒为空**（只夹取不拒绝） */
  rejections: string[]
  warnings: string[]
  /** 实际写入的格数（含重复写入，与参考实现同口径） */
  opsApplied: number
  /** 实际生效的规则 id（guard 通过且已应用） */
  rulesApplied: string[]
}

/** 单个 frame 的装配结果（契约 §5.4 的一次 ASSEMBLE）。 */
export interface AssemblyResult {
  variantKey: string
  /** frame 序号（`frame.index`） */
  frameIndex: number
  stepIndex: number
  runstate: string
  totalTier: number
  dims: Dims
  /** 装配结果（调色板下标）。朝向沿用契约：`[z][y][x]`，**row 0 = 顶部** */
  cellGrid: number[][][]
  /** 接入既有 Grid 的形态（Y-up，`cells[z][y][x]`），y 已按 row→世界 Y 翻转 */
  grid: import('@/context/grid').Grid
  /** 调色板下标 → SlotBlock（air = null） */
  blocks: Array<import('@/pure/gridTypes').SlotBlock | null>
  effective: Record<string, number>
  report: AssemblyReport
}
