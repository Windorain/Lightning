/**
 * `domain/multiblockDocument` —— **多方块声明的类型化承载**（#289 P10d；R-WK-06）。
 *
 * ## 本模块解决什么（它替代的旧机制）
 *
 * P10c（#286）实测（机械证据，Lead 认可）：
 *
 * > `MultiblockContent.source` 是"内层 body 原文"，`projectKernelDocument` 把它
 * > **摊平回产物根**（`kernelProjection.ts:447-454`）。于是"内核通道"能渲染，
 * > 靠的是**把原始 JSON 原样吐回**——不是内核承载了它。
 *
 * 而 #289 执行范围第 1 条与 R-WK-06 裁决第 3 条逐字要求：
 *
 * > `MultiblockContent.source` 的原始 JSON 回显在 #289 同批退役
 * > （#249 §12「不能将原始 JSON 重新塞进核心」）。
 *
 * ## 与 `domain/multiblock` 的分工（**不是**重复，是两半）
 *
 * | 模块 | 承载什么 | 依据 |
 * |---|---|---|
 * | `domain/multiblock`（P4 交付） | **求值半**：通道值域、约束、纯装配求值、写权、轨道采样 | #249 §3.3「通道定义描述值类型、合法域及约束」；§7 通道动画 |
 * | 本模块（P10d） | **声明半**：通道清单的**呈现事实**（key/name/kind/slider/slot）、运行态、变体、差异规则、骨架阶、总档位域、耦合、说明 | #249 §3.3「多方块声明作为**只读内容定义**，由类型化解析适配接入」 |
 *
 * 两半的分界是 **"回答取值合法性" vs "回答文件写了什么"**：
 * 前者是求值（纯规则），后者是内容（只读声明）。`domain/multiblock` 的文件头
 * 已逐字说明它**只**覆盖求值半边，且 `AssemblyRule` 刻意是不透明回调
 * 「不引入任何几何声明」—— 本模块正是那个被刻意留出的落点。
 *
 * ## 三条设计判据
 *
 * ### 1. 声明是**只读内容**，不是可编辑对象（§3.3 明文）
 *
 * 「生成对象可查询和拾取，但其写能力为**只读**，**不因通用对象模型而变得可编辑**。」
 * ⇒ 本模块的类型全部 `readonly`，且**不**提供任何构造"改一份声明"的入口 ——
 * 声明只能整体替换（换文档）。这与 `domain/scene#DataSource: 'content'` 的
 * `writeAuthority` 判定是同一政策在类型层的落点。
 *
 * ### 2. 骨架阶的 `cellGrid` 是**声明的组成**，逐格坐标仍用世界坐标
 *
 * 旧形态的 `sizeSteps[].cellGrid` 是 `[z][row][col]`、row 0 = 顶部（契约 §4.4）。
 * 内核的逐格键是 Y-up 世界坐标（`domain/scene#cellContentKeyOf`）。
 * ⇒ 本模块承载骨架阶时**如实保存文件朝向**（因为它要原样投影回文件），
 * 而在**装配**时由 `context/multiblock#assembleSelection` 做那一次翻转
 * （它已是既有的唯一装配翻转点，本批**不**新增第二处 —— §19.2 的"重复坐标翻转"是 A26 负对照）。
 *
 * ### 3. 未识别的声明键**不静默丢**，但也不进核心
 *
 * §12 第 3 段：「未知字段若必须往返保留，放在带源格式/源版本的适配器保真记录中…
 * **不能**将原始 JSON 重新塞进核心 `_extra`，也**不能**静默丢失无法解释的语义。」
 *
 * 旧 `source` 的形态正是"整个原始 JSON 塞进核心"（它是 `Record<string, unknown>`）。
 * 本模块把**已知键**类型化，**未知键**由装配层报进 `AssemblyDiagnostic` +
 * `unknownFields`（保真记录的输入）—— 与 `composition/kernelAssembly` 对顶层字段的
 * 既有处置**同一手法**（那里逐字写明分工：装配层报原始字段，适配器层构造记录）。
 *
 * ## 契约接触点（回 #250 登记，接续 GF 编号）
 *
 * 冻结契约全文无 `multiblock`（实测 0 命中）；多方块**文件格式**契约
 * （`docs/contracts/format-multiblock-doc.md`）是外部格式的权威，本模块**忠实承载**它，
 * 但内核承载面的形状（本模块的类型）属契约未覆盖处 ⇒ 登记 GF-12（见汇报）。
 *
 * ## 纯度
 *
 * 无 IO、无 DOM、无时钟、不 import 任何旧层（`domain/` 是纯核心，#249 §4 规则 1）。
 * `cellGrid: number[][][]` 是**纯数字**（不是旧层的 `Grid` 实例）—— 后者带
 * `_cellParts`/`_paletteCache` 等运行期状态，是 `context/` 的实现类型。
 */

import { digestOf } from './identity'
import { type BlockPaletteEntry } from './blockGeometry'

// ─────────────────────────────────────────────────────────────────────────────
// 通道 / 运行态 / 变体 / 规则
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 通道用途分类（契约 §4.3）。
 *
 * 与 `domain/multiblock#ChannelValueKind` 的区别：那是**值域形态**（能不能插值、怎么量化），
 * 这是**装配用途**（选骨架阶 / 写内容 / 不参与装配）。两者不是替代关系，
 * 故各自承载（`domain/multiblock` 文件头对同一分工有逐字说明）。
 */
export type MultiblockChannelKind = 'size' | 'replace' | 'hatch'

/** 一条通道的**声明**（契约 §4.2）。 */
export interface MultiblockChannel {
  /** GTStructureChannels 枚举名；`null` = 非枚举通道。 */
  readonly enumName: string | null
  /** 游戏内通道 id（小写）。 */
  readonly id: string
  /** 本文档内唯一键。 */
  readonly key: string
  /** **呈现名（UI 标签）**，取 enum 语义 —— 不做 `capitalize(id)` 猜测。 */
  readonly name: string
  readonly kind: MultiblockChannelKind
  readonly slot?: string
  /** 有效取值下界（`kind === 'size'` 时必填）。 */
  readonly min: number
  /** 有效取值上界（缺省 = 取值域上界）。 */
  readonly max: number
  readonly axis?: string
  readonly unit?: string
  readonly valueSemantics?: string
  readonly domainSource?: string
  /** 取值域：`lo` 恒 0（= Not set 档），`hi` = 声明 `max ?? 总档位域上界`。 */
  readonly domain: Readonly<{ lo: number; hi: number }>
  /** UI 是否生成滑杆：`kind === 'hatch'` 恒 `false`（契约 §4.3）。 */
  readonly slider: boolean
}

/** 运行态声明（契约 §7.1）。 */
export interface MultiblockRunstate {
  readonly id: string
  /** **UI 呈现名**（文件自带，不依赖 GT 语言文件）。 */
  readonly name: string
  readonly materialSwap: boolean
}

/** 运行态覆盖范围（契约 §7.4；`context/parsers/multiblockDocument.ts` 的解析判据同族）。 */
export interface MultiblockRunstateCoverage {
  /** `"texture-material-swap" | "none"`。 */
  readonly kind: string
  /** `cellGrid` 是否随运行态变化（本轮恒 `false`，T0.3 裁决）。 */
  readonly geometryDelta: boolean
  /** 恒为 `"not-covered"`（契约 §7.4：TESR/附属渲染方块本轮不覆盖）。 */
  readonly tesr: string
}

/**
 * **呈现语义**（契约 §7.4；`docs/contracts/format-multiblock-doc.md`）。
 *
 * ## 为什么它是领域承载的一部分（G3）
 *
 * 查看器必须能回答「这份声明的帧**是不是**变体语义」「层预览能不能做」，而这不是
 * 装配求值能推出来的事实 —— 它是**文件声明的呈现策略**。旧承载把它放在
 * `context/parsers/multiblockDocument.ts#MultiblockViewerSemantics`（含一个
 * `raw: Record<string, unknown>` 字段袋），而内核声明承载此前**完全没有**它
 * ⇒ 一旦旧解析器退为边界转换，「声明了什么呈现语义」就没有类型化落点。
 *
 * ## 为什么**不带** `raw`
 *
 * 旧形态的 `raw` 是 §15 第 2 条要退役的「核心无 raw JSON/格式字段袋」形态：
 * 未知键属于**适配器的保真记录**（`composition/kernelAssembly#declRawOf` 已有的分工），
 * 不属于内核内容。故这里只承载已知键，未知键由适配器报出（不静默丢）。
 */
export interface MultiblockViewerSemantics {
  /** 帧语义 = 变体语义（硬约束 2）。 */
  readonly frameIsVariant: boolean
  /** 帧播放语义，本轮恒 `"variant-frames"`。 */
  readonly playback: string
  readonly layerPreview: string
  readonly runstateCoverage: MultiblockRunstateCoverage
}

/**
 * 呈现语义的**缺省**。
 *
 * 取值逐条等于旧解析器对缺失键的落地口径（`context/parsers/multiblockDocument.ts:872-882`）：
 * `frameIsVariant`（只有显式 `false` 才否）、`playback ?? 'variant-frames'`、
 * `layerPreview ?? 'supported'`、coverage `kind ?? 'none'` / `geometryDelta === true` /
 * `tesr ?? 'not-covered'`。
 *
 * 为什么把缺省**具名**而不是在每个构造点写 `?? ...`：缺省是判据（「文件没声明」与
 * 「声明了缺省值」必须给出同一行为），散写就有 N 份，且会随解析器改动静默漂移。
 */
export const DEFAULT_VIEWER_SEMANTICS: MultiblockViewerSemantics = Object.freeze({
  frameIsVariant: true,
  playback: 'variant-frames',
  layerPreview: 'supported',
  runstateCoverage: Object.freeze({ kind: 'none', geometryDelta: false, tesr: 'not-covered' }),
})

/** 一条变体声明（契约 §5.1）。`key` 是主键，值恒为**声明值**（未设置写 0）。 */
export interface MultiblockVariant {
  readonly key: string
  readonly totalTier: number
  readonly values: Readonly<Record<string, number>>
  readonly runstate: string
}

/** guard 子句（契约 §4.5.3）：四种形态之一，之间 AND。 */
export interface MultiblockGuardClause {
  readonly channel: string
  readonly value?: number
  readonly min?: number
  readonly max?: number
  readonly not?: boolean
}

/** guard（契约 §4.5.3）：`not: true` 对整体取反；无 clauses = 恒真。 */
export interface MultiblockGuard {
  readonly not?: boolean
  readonly clauses: readonly MultiblockGuardClause[]
}

/** 装配相位（契约 §5.4：尺寸型已由 `stepIndex` 完成，剩下三档）。 */
export type MultiblockRulePhase = 'backbone' | 'replace' | 'runstate'

/** 规则写入方式（契约 §4.5.1）。 */
export type MultiblockRuleKind = 'setCell' | 'fill'

/** `fill` 的单轴写法：数组 = 逐层一个坐标；数字 = 每层同一坐标；缺省 = 全长。 */
export type MultiblockAxisSpec = number | readonly number[]

/** 一条差异规则（契约 §4.5）。**按引用复用**：帧只存 id。 */
export interface MultiblockRule {
  readonly id: string
  readonly phase: MultiblockRulePhase
  readonly legend?: string
  readonly kind: MultiblockRuleKind
  readonly x?: number
  readonly y?: number
  readonly z?: number
  readonly sel?: Readonly<{ x?: MultiblockAxisSpec; y?: MultiblockAxisSpec; z?: MultiblockAxisSpec }>
  readonly index?: number
  readonly indexRole?: string
  readonly channel?: string
  readonly indexTable?: readonly number[]
  readonly indexAliases?: Readonly<Record<string, number>>
  readonly guard?: MultiblockGuard
}

/** 一阶骨架（契约 §4.4）。`cellGrid` 朝向 `[z][y][x]`、**row 0 = 顶部**（卡片判据 2）。 */
export interface MultiblockSizeStep {
  readonly channel: string
  readonly layers?: number
  readonly w: number
  /** 该阶高度（沿用契约字段名 `hh`，避免与 `h` 混淆）。 */
  readonly hh: number
  readonly d: number
  /** 语义角色 → 调色板下标。 */
  readonly roles: Readonly<Record<string, number>>
  readonly cellGrid: readonly (readonly (readonly number[])[])[]
}

/** 骨架（契约 §4.4）。 */
export interface MultiblockBackbone {
  readonly kind: string
  readonly sizeChannel: string
  readonly sizeSteps: readonly MultiblockSizeStep[]
}

/** 一条帧的规则引用：纯字符串 = 声明顺序；对象形式可显式给 `order`。 */
export type MultiblockRuleRef = string | Readonly<{ id: string; order?: number }>

/** 一条帧声明（契约 §5.3）：**唯一**变体存储原语，不携带内联 ops。 */
export interface MultiblockFrame {
  readonly index: number
  readonly variant: string
  readonly runstate: string
  readonly stepIndex: number
  readonly rules: readonly MultiblockRuleRef[]
  readonly label?: string
  readonly durationMs?: number
}

/** 通道耦合（契约 §7.2）。 */
export interface MultiblockCoupling {
  readonly id: string
  readonly a: string
  readonly b: string
  readonly requires: string
}

/** 一条声明级说明（契约 §7.3 软约束）。 */
export interface MultiblockNote {
  readonly kind: string
  readonly text: string
}

/** 总档位域（契约 §4.1）。 */
export interface MultiblockTotalTierDomain {
  readonly min: number
  readonly max: number
  readonly default?: number
}

/**
 * 一份多方块**声明**（契约 §4.1 的 `multiblock` 节 + §5 的帧清单）。
 *
 * ## 为什么帧清单在里面（而不是与通道清单并列）
 *
 * 帧是**变体的存储原语**（契约 §5.3）——「一个变体至少一帧」。声明与它的帧是
 * 同一条事实的两半：只有声明无法装配（不知道用哪一阶骨架），只有帧无法解释
 * （不知道变体是什么）。旧 `context/multiblock/types.ts#MultiblockInnerDocument`
 * 把它们放在同一个对象里（`multiblock` + `frames`，都是内层 body 的键），
 * 本模块**保持这个边界**，只是把 `Record<string, unknown>` 换成类型化字段。
 */
export interface MultiblockDeclaration {
  readonly id: string
  readonly displayName: string
  readonly sourceClass?: string
  readonly hasScopeOverlap: boolean
  readonly scopeOverlapNote?: string
  readonly totalTierDomain: MultiblockTotalTierDomain
  /** 本文档**实际声明**的总档位取值清单。 */
  readonly tierSample: readonly number[]
  readonly channels: readonly MultiblockChannel[]
  readonly runstates: readonly MultiblockRunstate[]
  readonly variants: readonly MultiblockVariant[]
  readonly rules: readonly MultiblockRule[]
  readonly backbone: MultiblockBackbone
  readonly frames: readonly MultiblockFrame[]
  readonly couplings: readonly MultiblockCoupling[]
  readonly couplingMode: string
  readonly notes: readonly MultiblockNote[]
  /**
   * 呈现语义（G3；见 {@link MultiblockViewerSemantics}）。
   *
   * **不进** {@link multiblockDeclDigest}：它不改变生成物的几何（与 `notes`/`opsLegend`/
   * `sourceClass` 同一判据 —— 让「只改一句播放说明」触发全量重建正是 A11 要拦的形态）。
   */
  readonly viewerSemantics: MultiblockViewerSemantics
  /** 并集调色板（契约 §6；`[0]` 恒为 air）。**与逐格网格共用同一份资产身份**。 */
  readonly blockPalette: readonly BlockPaletteEntry[]
  /**
   * 契约/payload 的 `schemaVersion`（文件自带的格式版本）。
   *
   * ## 为什么承载它（实测：它是回显的**唯一**来源之一）
   *
   * P10c 侦察（Lead 认可）实测：`schemaVersion` 是内层 body 里**只有回显**能提供、
   * 投影侧从不重建的两个键之一。多方块解析器读它（`multiblockDocument.ts:935`）——
   * 不承载它，一次"装配 → 投影"往返就会丢掉它（#249 §12「不能静默丢失」）。
   */
  readonly schemaVersion: number | null
  /** `multiblockCount`（契约 §2.3：**必须** `=== 1`，否则解析器拒绝）。 */
  readonly multiblockCount: number
  readonly paletteSource: string
  readonly geometryEncoding: string
  readonly opsLegend: Readonly<Record<string, string>>
}

// ─────────────────────────────────────────────────────────────────────────────
// 身份与查询
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **「这份文档没有多方块声明」的唯一表示**（G1）。
 *
 * ## 为什么是「一份显式空声明」而不是 `null` / `undefined`
 *
 * 三条理由，都是判据上的：
 *
 *  1. **禁止 `undefined` 冒充「无」**。可空字段会让「没读到」「解析器忘了填」
 *     与「文件确实声明了空」在类型上不可区分 —— 那正是 §15 第 2 条要退役的形态。
 *  2. **同一语义只能有一个值**。本模块的 `EMPTY_*` 族（`EMPTY_METADATA` /
 *     `EMPTY_FRAME_AXIS`）口径一致：空值是**载体类型的冻结实例**，于是
 *     「无声明」在 `canonicalize` 下只有一个字符串（`digestOf` 的键序已稳定），
 *     ⇒ 同一语义不会出现两种内容摘要（见 `domain/document#contentOf`）。
 *  3. **真实声明不可能与之相等**。契约 §2.3 要求 `multiblockCount === 1` 且
 *     `multiblock.id` / `displayName` 为非空字符串 ⇒ 「空值 ⟺ 无声明」是结构事实，
 *     不是约定。
 *
 * 注意 `multiblockCount: 0` 是**刻意的**：它不是一份「合法的多方块文档」
 * （那种文档恒为 1），而是「本内核文档没有多方块节点」这个事实的显式编码。
 */
export const EMPTY_MULTIBLOCK_DECLARATION: MultiblockDeclaration = Object.freeze({
  id: '',
  displayName: '',
  hasScopeOverlap: false,
  totalTierDomain: Object.freeze({ min: 0, max: 0 }),
  tierSample: Object.freeze([]) as readonly number[],
  channels: Object.freeze([]) as readonly MultiblockChannel[],
  runstates: Object.freeze([]) as readonly MultiblockRunstate[],
  variants: Object.freeze([]) as readonly MultiblockVariant[],
  rules: Object.freeze([]) as readonly MultiblockRule[],
  backbone: Object.freeze({ kind: '', sizeChannel: '', sizeSteps: Object.freeze([]) }) as MultiblockBackbone,
  frames: Object.freeze([]) as readonly MultiblockFrame[],
  couplings: Object.freeze([]) as readonly MultiblockCoupling[],
  couplingMode: '',
  notes: Object.freeze([]) as readonly MultiblockNote[],
  viewerSemantics: DEFAULT_VIEWER_SEMANTICS,
  blockPalette: Object.freeze([]) as readonly BlockPaletteEntry[],
  schemaVersion: null,
  multiblockCount: 0,
  paletteSource: '',
  geometryEncoding: '',
  opsLegend: Object.freeze({}) as Readonly<Record<string, string>>,
})

/**
 * 声明的**内容身份**。
 *
 * 覆盖全部**参与装配或呈现**的字段（通道/运行态/变体/规则/骨架/帧/调色板/耦合）。
 * 不覆盖诊断性字段（`notes`/`opsLegend`/`sourceClass`）：它们不改变生成物的几何，
 * 让它们进身份会使"只改一句说明"触发全量重建（A11「只改注解描述 ⇒ 方块几何重建数为 0」
 * 的同族要求；这正是 §15 第 5 条要退役的"非内容版本冒充内容变化"）。
 *
 * 复用 `domain/identity#digestOf`（唯一摘要算法）。
 */
export function multiblockDeclDigest(decl: MultiblockDeclaration): number {
  return digestOf({
    id: decl.id,
    totalTierDomain: decl.totalTierDomain,
    tierSample: decl.tierSample,
    channels: decl.channels.map((c) => [c.key, c.kind, c.min, c.max, c.domain.lo, c.domain.hi, c.slider]),
    runstates: decl.runstates.map((r) => [r.id, r.materialSwap]),
    variants: decl.variants.map((v) => [v.key, v.totalTier, v.values, v.runstate]),
    rules: decl.rules.map((r) => [r.id, r.phase, r.kind, r.index ?? null, r.indexRole ?? null, r.channel ?? null, r.indexTable ?? null, r.indexAliases ?? null, r.sel ?? null, r.x ?? null, r.y ?? null, r.z ?? null, r.guard ?? null]),
    backbone: decl.backbone.sizeSteps.map((s) => [s.channel, s.w, s.hh, s.d, s.roles, s.cellGrid]),
    frames: decl.frames.map((f) => [f.index, f.variant, f.runstate, f.stepIndex, f.rules]),
    couplings: decl.couplings.map((c) => [c.id, c.a, c.b, c.requires]),
    palette: decl.blockPalette.map((e) => [e.registryId, e.meta, e.assetId]),
  })
}

/** 通道按 key 查（`undefined` = 未声明，由调用方决定是 `UnsupportedOperation` 还是 `InvalidValue`）。 */
export function findMultiblockChannel(decl: MultiblockDeclaration, key: string): MultiblockChannel | undefined {
  return decl.channels.find((c) => c.key === key)
}

/** 变体按 key 查（契约 §5.1：`key` 是主键）。 */
export function findMultiblockVariant(decl: MultiblockDeclaration, key: string): MultiblockVariant | undefined {
  return decl.variants.find((v) => v.key === key)
}

/** 运行态按 id 查。 */
export function findMultiblockRunstate(decl: MultiblockDeclaration, id: string): MultiblockRunstate | undefined {
  return decl.runstates.find((r) => r.id === id)
}

/** 规则按 id 查（帧只存引用，故它是装配的热路径）。 */
export function findMultiblockRule(decl: MultiblockDeclaration, id: string): MultiblockRule | undefined {
  return decl.rules.find((r) => r.id === id)
}

/** 变体键的**声明集合**（供"组合是否已声明"判定，替代旧 `variantByKey` 的 `Map`）。 */
export function declaredVariantKeys(decl: MultiblockDeclaration): ReadonlySet<string> {
  return new Set(decl.variants.map((v) => v.key))
}

/**
 * 规范化一份声明：各清单冻结，**调色板按下标语义原样保序**。
 *
 * ## 为什么不排序、不去重、不删除任何调色板条目（R2 裁决 #388 7501 第 2 项）
 *
 * 本函数的 `blockPalette` **不是呈现清单，而是下标空间**：`backbone.sizeSteps[].cellGrid`
 * 逐格存的就是调色板下标（契约 §4.4 `cellGrid[z][y][x]`；§5 装配伪码明文
 * `ASSERT 每个下标 ∈ [0, blockPalette.length)`；§6「air 恒下标 0」）。
 * ⇒ 任何重排/删除都会把每一格指向**另一个方块**，且**静默**（网格本身仍然合法）。
 *
 * 旧实现在此处调 `domain/blockGeometry#normalizePalette`（按 `blockPaletteEntryKey`
 * 去重 + `localeCompare` 排序）—— 那是**呈现清单**的口径（`blockGeometry` 判据 2/3：
 * 去重键是内容、排序使"两种枚举顺序 ⇒ 同一张表"），照搬到下标空间上就是静默换方块。
 *
 * 为什么连"去重"也不做：契约 §6 要求并集调色板在**编码期**全局去重 ⇒ 合法输入本就
 * 没有重复条目，此处的去重对任何合法输入都是**空操作**；而一旦真有重复（非法输入），
 * 删掉一条就会让其后的**全部**下标错位。故只保序等长复制。
 * （§4.5.2 `indexAliases` 的存在本身证明"编号顺序在编码器之间会变"——它就是为
 * "骨干 `index` 命名与并集调色板最终编号不一致"准备的批量重编号。）
 *
 * ## 不排序其它清单
 *
 * 通道/运行态/变体/规则/帧的**顺序是语义**（变体键由通道顺序派生、规则按
 * `(phase, order)` 稳定排序、运行态首项是回落目标）。
 *
 * ## 与内容身份的推论
 *
 * `multiblockDeclDigest` 既按**下标顺序**哈希 `blockPalette`，又哈希
 * `sizeSteps[].cellGrid` ⇒ 旧实现会让同一份声明在不同枚举顺序下得到两个摘要
 * （内容身份被破坏）。本函数现在是**逐位同内容**的：长度相等且
 * `out.blockPalette[i]` 与 `in.blockPalette[i]` 同内容 ——
 * 判据 `web/src/domain/__tests__/multiblockDeclarationNormalize.test.ts`。
 */
export function normalizeMultiblockDeclaration(decl: MultiblockDeclaration): MultiblockDeclaration {
  return Object.freeze({
    ...decl,
    tierSample: Object.freeze([...decl.tierSample]),
    channels: Object.freeze([...decl.channels]),
    runstates: Object.freeze([...decl.runstates]),
    variants: Object.freeze([...decl.variants]),
    rules: Object.freeze([...decl.rules]),
    frames: Object.freeze([...decl.frames]),
    couplings: Object.freeze([...decl.couplings]),
    notes: Object.freeze([...decl.notes]),
    // 保序、等长：调色板是**下标空间**，不是呈现清单（理由见函数头注释）。
    blockPalette: Object.freeze([...decl.blockPalette]),
  })
}
