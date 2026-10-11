/**
 * `composition/kernelAssembly` —— **旧文档 → 内核场景装配**（#282 P10b；R-WK-04 的核心交付）。
 *
 * ## 本模块解决什么（它替代的旧机制）
 *
 * R-WK-04（#250）登记的 blocker 原文：
 *
 * > 「内核 `Document` 只承载 block/annotation/camera/mesh，**不承载** `frames`/`cellGrid`/
 * > `textureBlobs`/`materialPalette`/`multiblock`/`meta`，而渲染链按后者工作；
 * > **全树没有任何生产代码从旧场景文件构造内核 `Scene`**。」
 *
 * 本模块就是那个缺失的装配点。它把一份**已解析的旧文档**（`RuntimeDocument`）
 * 映射成内核的四样东西：
 *
 * | 产出 | 内核类型 | 依据 |
 * |---|---|---|
 * | 对象与对象数据 | `domain/scene` 的 `Scene` | #249 §3.1「对象具有稳定 ID、类型、名称、变换、可见性及具体数据引用」 |
 * | 动画 | `domain/animation` 的 `AnimationState` | §3.1「动画」 |
 * | 资源引用 / 元数据 / 帧时长轴 | `domain/content` 的 `DocumentContent` | §3.1「资源引用」；§19.3；§15 第 2 条 |
 * | 未知字段 + 不支持能力 | `adapters/files/fidelityRecord` + 本模块的 {@link AssemblyDiagnostic} | §12 第 3 段「未知字段…放在带源格式/源版本的适配器保真记录中」 |
 *
 * ## 为什么它在 `composition/` 而不是 `adapters/`
 *
 * 这是一条**跨层的装配边**：输入是旧层的 `RuntimeDocument`，输出是新内核的类型。
 * #249 §4 把 `composition/` 定义为「装配」层 —— 它的职责正是"把各层装到一起"，
 * 而"旧模型 → 新模型"恰好是装配问题（哪条路径接通、哪条暂时代偿）。
 *
 * 更硬的理由是**边界闸门**：`adapters/**` 与 `runtime/**` 的新实现登记在
 * `kernel-legacy-isolation.test.ts` 的 `KERNEL_FILES` 里，受「新内核不得 import
 * 任何旧层」约束（#1 负对照「新 facade 内调用旧 runtime」）。把本模块放进
 * `adapters/` 会让它**立刻**违反那条闸门 —— 而放宽闸门正是 #171 禁止的形态。
 * `composition/` 不在 `KERNEL_FILES` 内（它是装配根，契约 §7 明文允许引用各层实现），
 * 故这里是唯一既合法又语义正确的位置。
 *
 * ## 三条映射判据（各自对应一个会被静默违反的约束）
 *
 * ### 1. 整座结构是**一个对象**，不是逐格对象（如实登记，不冒充已迁移）
 *
 * 旧文档的网格是"一格一个下标"，没有逐方块对象身份（这正是 §15 第 9 条
 * 「格坐标/批次序号兼任对象身份」要在 P3 退役的遗留事实）。装配层因此只能
 * 把整座结构映射成**一个** `blockGrid` 对象 —— `presentationAdapter.structurePrimitive`
 * 的文件头对同一事实有逐字说明（"适配层暂时只能喂一个对象"）。
 *
 * 逐格对象化需要文件格式本身带对象身份，属格式演进，**不**在本批伪造
 * （伪造的表现是给每个格子编一个 `block-<z>-<y>-<x>` 式 id —— 那正是
 * "用空间坐标冒充对象身份"，§15 第 9 条的负对照）。
 *
 * ### 2. 多方块生成物是**只读内容**（`source: 'content'`），声明进内容面
 *
 * §3.3 原文：「多方块声明作为**只读内容定义**，由类型化解析适配接入。生成对象可查询
 * 和拾取，但其写能力为**只读**，**不因通用对象模型而变得可编辑**。」
 *
 * ⇒ 多方块文档的对象数据 `source` 是 `'content'`（`domain/scene#writeAuthority`
 * 据此返回 `readOnly`），而**通道定义**归 {@link MultiblockContent} 承载 ——
 * 它是内容面的声明，不是可编辑对象。通道取值属 `EditContext`（§3.4），
 * 故本模块**不**把取值写进文档。
 *
 * ### 3. 未知字段与不支持能力**都不静默**（走保真记录 + 诊断）
 *
 * §12 第 3 段：「未知字段若必须往返保留，放在带源格式/源版本的适配器保真记录中；
 * 编辑发生后对其有效性作明确判断。**不能**将原始 JSON 重新塞进核心 `_extra`，
 * 也**不能**静默丢失无法解释的语义。」
 *
 * ⇒ 每个 `RuntimeDocument` 的 `_extra` 键进 `FidelityRecord`（带 `sourceFormat`/
 * `sourceVersion`），且**同时**产出一条 {@link AssemblyDiagnostic} —— 于是
 * "这份文件有什么我们没解释"在 UI/日志上可见，而不是只在存储里躺着。
 *
 * ## 纯度
 *
 * 本模块**不**碰 DOM/Vue/Three、不读时钟、不做 IO（`composition/` 虽允许碰 DOM，
 * 但装配是纯映射）。所有非纯事实（时间戳、身份分配）由调用方经
 * {@link AssemblyInput} 显式给出 —— 与 #249 §5.3「需要时间、身份分配…时作为输入传入」
 * 同一条纪律。
 */

import type { RuntimeDocument, RuntimeFrame } from '@/context/runtimeDocument'
import type { Grid, SlotBlock } from '@/context/grid'
// 通道装配经 `context/multiblock` 的**公共出口**取得（深度 2）。
// `@/shared/viewport/multiblockChannelUi` 是它的 UI 包装（深度 3，超公共出口上限）——
// 而 `assembleSelection` 本来就在 `context/multiblock` 的出口上（那个 index 逐字导出它）。
// 用更深的那个包装会顺带把 Vue 响应式语义拖进装配层，那也不是装配该做的事。
import { assembleSelection, type AssemblyResult, type MultiblockInnerDocument } from '@/context/multiblock'
// 多方块声明类型经 `context/runtimeDocument` 的**公共出口**取得，不钻
// `@/context/parsers/multiblockDocument`（深度 3 > 契约 §7.3 规则 2 的上限 2）。
// 那个文件本来就是这些类型的公开再出口（它 `export type { MultiblockChannelDecl, … }`），
// 故这不是"为了过闸门而绕路"，而是**走既有的公共出口**。
import type {
  MultiblockChannelDecl,
  MultiblockDecl,
  MultiblockRunstateDecl,
  MultiblockVariantDecl,
} from '@/context/runtimeDocument'
import {
  contentResource,
  documentContent,
  documentMetadata,
  frameAxis,
  normalizeResources,
  type ContentResource,
  type DocumentContent,
  type DocumentMetadata,
  type FrameDeclaration,
  type ResourceBlendMode,
  type ResourceKind,
  type TextureAnimationSpec,
} from '@/domain/content'
import { EMPTY_ANIMATION, type AnimationState } from '@/domain/animation'
import { err, invalidValue, ok, type Result } from '@/domain/errors'
import {
  objectData,
  sceneObject,
  withObject,
  emptyScene,
  type ObjectData,
  type ObjectDataPayload,
  type Scene,
  type SceneObject,
} from '@/domain/scene'
import type { Transform } from '@/domain/scene'
// **刻意不 import `@/adapters/files/fidelityRecord`**（深度 3 > 契约 §7.3 规则 2 的
// 公共出口上限 2）。装配层因此**不自造**保真记录，而是把"本适配器解释不了的字段"
// 作为**纯数据**（`unknownFields`）报出来，由适配器层（`captureFidelity`）构造记录 ——
// 记录格式的**唯一权威**仍在那里，装配层不复制它。
// 这条分工同时让两个闸门都成立：装配层不钻别的层的私有实现，适配器层仍是记录的拥有者。

// ─────────────────────────────────────────────────────────────────────────────
// 诊断（不支持能力 / 形态瑕疵 —— 都不静默）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 装配诊断的稳定码。
 *
 * 用**稳定字符串码**而不是自然语言句子：诊断要被测试断言、被日志聚合、被 UI 分类
 * （#249 §19.9「可以按 command/job/object/version 关联原因与归属」）。
 * 自然语言随翻译/措辞变化，码不会。
 */
export type AssemblyDiagnosticCode =
  /** 顶层有本适配器解释不了的字段（**同时**进保真记录）。 */
  | 'unknownRootField'
  /** 文档形态不在本适配器支持的集合内。 */
  | 'unsupportedShape'
  /** 帧没有网格且文档不是多方块形态 —— 网格缺失，不伪造空网格。 */
  | 'frameWithoutGrid'
  /** 注解形状不在内核 `ObjectDataPayload.annotation.shape` 的封闭联合内。 */
  | 'unsupportedAnnotationShape'
  /** 纹理条目没有可用的内嵌字节，且没有 locator ⇒ 无法取回（显式，不是"空纹理"）。 */
  | 'resourceWithoutPayloadOrLocator'
  /** 多方块装配失败（保留上一次可渲染结果；见 `assembleForSelection`）。 */
  | 'multiblockAssemblyFailed'
  /** 网格超过本装配层的对象上限（防止一份异常文件造出百万对象）。 */
  | 'gridObjectLimitExceeded'

export interface AssemblyDiagnostic {
  readonly code: AssemblyDiagnosticCode
  /** 稳定路径（`$.frames[3].structure`），供机械对账与 UI 定位。 */
  readonly path: string
  /** 人类可读细节（**不**参与判定，只供展示）。 */
  readonly detail: string
}

function diagnostic(code: AssemblyDiagnosticCode, path: string, detail: string): AssemblyDiagnostic {
  return Object.freeze({ code, path, detail })
}

// ─────────────────────────────────────────────────────────────────────────────
// 多方块内容声明（只读内容定义，不是可编辑对象）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 多方块**声明**在内核文档里的承载（#249 §3.3）。
 *
 * ## 为什么它是一个内容声明而不是对象
 *
 * §3.3 要求「生成对象可查询和拾取，但其写能力为只读，**不因通用对象模型而变得可编辑**」。
 * 声明（通道清单/运行态/变体/规则表/骨架）是**文件写的**，不是用户编辑的 ——
 * 把它做成一个可编辑对象会让「改通道声明的值域」变成一次属性写，而那是
 * §3.3 明文禁止的（"不因通用对象模型而变得可编辑"）。
 *
 * ⇒ 它是文档**内容**的一部分（进 `DocumentContent`？—— 见下），由只读投影暴露给 UI。
 *
 * ## 为什么它**不**进 `DocumentContent`（本批的显式取舍）
 *
 * `DocumentContent` 进**内容身份**（改它就变脏、可撤销）。多方块声明来自文件、
 * 不可编辑，把它放进内容身份会让「同一份文件两次装配」的摘要依赖声明对象
 * 的引用相等性 —— 而它是从 JSON 每次重新解析出来的，深比较成本高且
 * 判定点会从"内容变了"漂移成"解析结果结构相同吗"。
 *
 * ⇒ 本批把它放在 {@link AssembledDocument.multiblock} 上，作为装配产物的**旁挂声明**
 * （与保真记录同一处置：适配器的值，不是文档内容）。它是只读投影的数据源。
 * 这条取舍登记为契约缺口 GF-4（见汇报），**不**私自扩展冻结契约。
 */
export interface MultiblockContent {
  /** 声明 id（文件自带）。 */
  readonly id: string
  readonly displayName: string
  readonly channels: readonly MultiblockChannelDecl[]
  readonly runstates: readonly MultiblockRunstateDecl[]
  readonly variants: readonly MultiblockVariantDecl[]
  readonly totalTierDomain: MultiblockDecl['totalTierDomain']
  /** 内层 body 原文（装配器的输入；只读，**不**进内核核心模型）。 */
  readonly source: Readonly<Record<string, unknown>>
}

// ─────────────────────────────────────────────────────────────────────────────
// 装配输入 / 输出
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 多方块通道选择（装配的输入）。
 *
 * ## 为什么在这里声明而不是 import `shared/viewport/multiblockChannelUi`
 *
 * 那个模块是**呈现侧的 UI 状态**类型（它把"每视口暂存"的形状写进类型），
 * 而装配层要的是**装配输入**。两者字段恰好同形（`totalTier`/`values`/`runstate`），
 * 但语义不同：前者的"每视口一份"正是 B5 #4 要退役的形态（§15 第 4 条），
 * 装配层**不该**把那个语义引进类型。
 *
 * 且它是深度 3 的路径（超公共出口上限 2）。⇒ 就地声明装配输入的形状，
 * 与 `context/multiblock#MultiblockSelection`（`totalTier`/`values`/`runstate`）
 * 逐字同形 —— 那是装配器的真实输入类型，也就是本类型要对接的东西。
 */
export interface MultiblockSelectionState {
  readonly totalTier: number
  readonly values: Readonly<Record<string, number>>
  readonly runstate: string
}

/** 装配的对象上限（防一份异常文件造出百万对象；超出**显式**诊断，不静默截断）。 */
export const DEFAULT_OBJECT_LIMIT = 100_000

export interface AssemblyInput {
  /** 已解析的旧文档；`null` = 空文档（装配出一份空内核文档，**不**报错）。 */
  readonly doc: RuntimeDocument | null
  /**
   * **解析器看到的那份 plain 根 JSON**（信封解包 + meta 合并后的产物）。
   *
   * ## 为什么必须有它（本批实测抓出的**有损中间层**）
   *
   * `RuntimeDocument.fromV2Plain` 的 `known` 集合列了 7 个根级键
   * （`label`/`author`/`description`/`gtnhVersion`/`modSource`/`globalConfig`/`schemaVersion`）
   * 却**从不读它们**，同时又把它们排除在 `_extra` 之外 —— 于是它们
   * **既不在 `meta` 里、也不在 `_extra` 里、更不在 `serialize()` 里**：
   * 从 `RuntimeDocument` 出发**无法**恢复。
   *
   * 实测（`multiblock-ebf-2ch`）：`plain.label === 'Fixture — EBF (…)'`
   * 而 `doc.serialize().label === undefined`、`doc.meta.label === undefined`。
   *
   * ⇒ 装配层要吃**未经损失的源**。这不是"多传一个参数"，而是承认
   * `RuntimeDocument` 是**有损**中间层（它只承载被它理解的字段），
   * 而适配器的职责正是"解释一份文件"——解释的输入必须是文件本身。
   *
   * 缺省时回落到 `doc.serialize()`（**如实降级**：此时根级元数据不可恢复，
   * 装配出的元数据为空 —— 而不是伪造一个）。
   */
  readonly plainRoot?: Readonly<Record<string, unknown>>
  /** 内核文档 id（调用方决定；缺省用旧文档 id）。 */
  readonly documentId?: string
  /** 内核场景 id（缺省 `${documentId}-scene`）。 */
  readonly sceneId?: string
  /** 对象数量上限。 */
  readonly objectLimit?: number
  /**
   * 多方块通道选择（**只读装配的输入**）。
   *
   * 缺省 = 文档声明的初始选择（`initialMultiblockSelection`）。
   * 为什么它在这里而不是"装配层自己决定"：通道取值属 `EditContext`（§3.4），
   * 装配要装配**哪一份**取值必须由调用方给出 —— 装配层不持有编辑上下文。
   */
  readonly multiblockSelection?: MultiblockSelectionState
}

/** 装配产物。 */
export interface AssembledDocument {
  readonly documentId: string
  readonly scene: Scene
  readonly animation: AnimationState
  readonly content: DocumentContent
  /** 多方块声明（只读内容定义）；帧为主文档为 `null`。 */
  readonly multiblock: MultiblockContent | null
  /**
   * **本适配器解释不了的顶层字段**（纯数据；键序保留）。
   *
   * ## 为什么是原始字段而不是构造好的 `FidelityRecord`
   *
   * 保真记录的**格式**（`sourceFormat`/`sourceVersion`/`fields` 三元组、
   * `_extra` 拒绝、序列化/解析）有唯一权威：`adapters/files/fidelityRecord`。
   * 装配层若自己造一份记录，就出现了两个记录构造点 —— 而"记录里没有来源格式/版本"
   * 正是那个模块文件头记录的历史缺陷。
   *
   * 同时，`adapters/files/fidelityRecord` 是深度 3 的路径，`composition/` 不得
   * 钻进去（契约 §7.3 规则 2 的公共出口上限 2；`gate/no-private-cross-layer`）。
   *
   * ⇒ 分工：装配层报出**原始未知字段**（纯数据，它本来就有），
   * 适配器层（调用方）用 `captureFidelity({ sourceFormat, sourceVersion, raw, knownKeys })`
   * 构造记录。两处都只做自己有权做的事。
   */
  readonly unknownFields: Readonly<Record<string, unknown>>
  /** 未知字段的来源格式标识（供调用方构造保真记录；与 `captureFidelity` 的入参同义）。 */
  readonly sourceFormat: string
  /** 未知字段的来源版本（同上）。 */
  readonly sourceVersion: string
  /** 全部诊断（未知字段 / 不支持能力 / 形态瑕疵）。 */
  readonly diagnostics: readonly AssemblyDiagnostic[]
  /**
   * 装配出的**帧网格**（帧下标 → 内核对象 id）。
   *
   * 为什么需要它：多帧文档的每一帧是一份网格，而"当前画哪一帧"由
   * `EditContext.time` 派生。渲染侧要按帧下标取到对应对象，故装配产物必须
   * 给出这条映射（否则渲染只能"猜第 0 帧"）。
   *
   * 帧为主文档：长度 = 帧数；多方块文档：长度 = 1（网格是装配产物，
   * 帧只承载变体声明 —— 见 `RuntimeDocument` 文件头的形态说明）。
   */
  readonly frameObjects: readonly string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// 类型化映射表（**唯一**的旧→新字段对应点）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 旧 `meta` 里**已知**的键（其余进保真记录 + 诊断）。
 *
 * 这份清单就是"我们解释了什么"的可执行定义。`embed_initial_view` 在列内是因为
 * 它**确实**被生产消费（`context/embedInitialView`）—— 它映射成一个
 * `camera` 对象（见 {@link cameraObjectsFromMeta}）。
 */
export const KNOWN_META_KEYS: readonly string[] = Object.freeze([
  'name',
  'author',
  'created_at_ms',
  'description',
  'tags',
  'origin',
  'embed_initial_view',
  // 形态判别键：由解析器消费（决定走不走多方块路径），不是"没人懂的字段"。
  'documentShape',
  'mode',
  'label',
  'modSource',
  'fixtureSynthetic',
  'fixtureFile',
])

/**
 * 旧文档**顶层**已解释的键。
 *
 * 与 `context/runtimeDocument#fromV2Plain` 的 `known` 集合**同源但不同用途**：
 * 那里决定"哪些键进 `_extra`"，这里决定"哪些键进保真记录"。两处都列同一批键是
 * **故意**的 —— 若哪天格式新增一个键而只改了一处，本模块会把它报成"未知"
 * （保守方向：宁可多报，不可静默丢），而那个多报会立刻在测试里可见。
 */
export const KNOWN_ROOT_KEYS: readonly string[] = Object.freeze([
  'format_version',
  'id',
  'frames',
  'meta',
  'annotations',
  'labels',
  'textureBlobs',
  'tooltipPalette',
  'cellTooltipGrid',
  'materialPalette',
  'playback',
  'documentShape',
  'multiblock',
  'multiblockCount',
  'blockPalette',
  // 首帧 structure 的顶层展开副本（可由 frames 派生，不是独立语义）。
  'cellGrid',
  'cellPartsGrid',
  'partLists',
  'schemaVersion',
  'label',
  'gtnhVersion',
  'author',
  'description',
  'modSource',
  'globalConfig',
  'itemIndex',
  'partIconTextures',
  'statsTemplate',
  'statsOverride',
])

/**
 * 根级元数据键（**信封 meta 摊平后的落点**；见 `metadataFromLegacy`）。
 *
 * 这些键在 `KNOWN_ROOT_KEYS` 里（故不进保真记录），但它们**不是**"解释后丢弃"——
 * 它们被 {@link metadataFromLegacy} 读进 `DocumentMetadata`。单列这份清单是为了让
 * "根级哪些键其实承载元数据"成为一个**具名事实**，而不是散在优先级表达式里。
 */
export const ROOT_METADATA_KEYS: readonly string[] = Object.freeze(['label', 'author', 'description'])

/** 内核注解载荷支持的形状（与 `ObjectDataPayload.annotation.shape` **同一联合**）。 */
const ANNOTATION_SHAPES: readonly string[] = Object.freeze(['box', 'point', 'line', 'text', 'face'])

/**
 * 核心**禁止**出现的字段袋键名。
 *
 * ## 为什么在这里重述一个字面量，而不是 import `adapters/files/fidelityRecord`
 *
 * 那是深度 3 的路径（`composition/` 不得钻进去，契约 §7.3 规则 2）。
 * 而这里需要的只是**"这个键名不该出现在未知字段里"**这一条判断 ——
 * 它是 §15 第 2 条「核心无 raw JSON/格式字段袋」在**收集阶段**的落点。
 *
 * 值的唯一权威仍是 `adapters/files/fidelityRecord#CORE_EXTRA_BAG_KEY`
 * （保真记录拒绝 `_extra` 的那条判据在那里）。两处同源的事实由
 * `kernelAssembly.test.ts` 的断言把守：装配层若漏掉这个排除，
 * `_extra` 会进 `unknownFields`，而"核心无字段袋"那条断言会判红。
 */
const CORE_EXTRA_BAG_KEY = '_extra'

// ─────────────────────────────────────────────────────────────────────────────
// 方块网格 → 内核 blockGrid 载荷
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 方块在 `blockGrid.cells` 里的**值格式**。
 *
 * ## 为什么是 `minecraft:<name>:<meta>`
 *
 * 与生产代码里既有的方块身份字符串**同一形态**（`context/queries#getFrameBlocks`
 * 与 `getBlockTypeStats` 都写 `` `minecraft:${block.name}:${block.meta}` ``，
 * 而 `runtime/types.ts` 的 `BlockRef.block_state_id` 是它的消费者）。
 * 选它而不是另造格式，是为了让"装配出的 cells 值"与"拾取给出的 block_state_id"
 * **可以直接比较** —— 否则每次比较都要一次翻译，而翻译必然有第二个实现。
 *
 * ## 键格式：`"x,y,z"`（Y-up 世界坐标）
 *
 * 与 `context/grid` 的 `_cellParts` 键（`` `${pos.x},${pos.y},${pos.z}` ``）
 * 同一形态。用**世界坐标**（Y-up，y=0 为底）而不是契约的 `[z][row][x]` 下标：
 * cells 的键描述"这一格在哪"，而"在哪"的唯一权威是场景坐标（§19.2）。
 * row→Y 的翻转由 {@link gridCells} 在装配时一次完成，**不**留到消费者那里
 * （留到消费者 = 每个消费者各自实现一次翻转，那是 §19.2 要退役的"重复坐标翻转"）。
 *
 * ## 契约缺口（如实登记，不静默发明）
 *
 * 冻结契约**没有**规定 `blockGrid.cells` 的键/值格式（`web-kernel-contracts.md`
 * 与 `web-kernel-geometry-contract.md` 全文无 `blockGrid`）。本批按上述既有生产
 * 形态选定并**显式登记为 GF-4**（回 #250 裁决），不私自扩展契约语义。
 */
export function blockCellKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`
}

/** 方块值格式（见 {@link blockCellKey} 的说明）。 */
export function blockCellValue(block: SlotBlock): string {
  return `minecraft:${block.name}:${block.meta}`
}

/**
 * 旧 `Grid` → 内核 `blockGrid.cells`（**唯一**的翻转点）。
 *
 * `Grid` 的 `forEach` 已经按 Y-up 世界坐标回调（`context/grid.ts` 的
 * `_cells[z][y][x]`，y=0 为底），故这里**不**再做任何坐标变换 ——
 * 翻转发生在解析期（`RuntimeDocument._fromV2CellGrid` 的 `structureRowToWorldY`），
 * 装配层重复一次就是"重复坐标翻转"（A26 负对照）。
 */
export function gridCells(grid: Grid): Readonly<Record<string, string>> {
  const cells: Record<string, string> = {}
  grid.forEach((pos, block) => {
    cells[blockCellKey(pos.x, pos.y, pos.z)] = blockCellValue(block)
  })
  return Object.freeze(cells)
}

// ─────────────────────────────────────────────────────────────────────────────
// 元数据 → 内核 DocumentMetadata + 相机对象
// ─────────────────────────────────────────────────────────────────────────────

function readString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function readNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * 旧文档 → 内核 `DocumentMetadata`（逐字段具名；未知键**不**在这里）。
 *
 * ## 展示名的取值优先级：**转发生产的唯一实现**（实测修正，见下）
 *
 * 生产代码对"这份文档叫什么"已有唯一权威：
 * `viewer/sceneDisplayTitle#sceneDisplayTitleFromRootDocument` 的优先级是
 * **根 `label` → `meta.name` → `meta.label` → 根 `id`**。
 *
 * ## 为什么必须同时读根级 `label`（本批实测抓出的真实缺陷）
 *
 * 真实多方块产物的展示名写在**信封 `meta.label`**。而信封解包
 * （`render/data/compactSceneDocument#readEnvelopeLayers`）把信封 `meta` 的键
 * **摊平到 plain 根**（`plain = {...innerStripped, ...meta}`），
 * 于是 `RuntimeDocument.fromV2Plain` 看到的 `raw.meta` 是 `undefined` ——
 * 它回落到"空 meta + `Date.now()`"，而 `label`/`author`/`description`
 * 作为**未知顶层键**进了 `_extra`（在根级，不在 `meta` 里）。
 *
 * 实测（`multiblock-ebf-2ch`）：`doc.meta.name === ''`、`doc.meta.label === undefined`、
 * `doc.serialize().label === 'Fixture — EBF (…)'`。
 *
 * ⇒ 只读 `doc.meta` 会让三份真实夹具全部装配出**空标题/空作者/空描述**
 * （一个"装配成功但元数据丢了"的静默缺陷）。故本函数同时接受**根级** `label`/
 * `author`/`description`，优先级与生产一致（根 `label` 优先于 `meta.name`）。
 *
 * ## 这**不是**在修旧解析路径
 *
 * 旧路径把信封 meta 摊平到根是一个**既有的形态事实**（`readEnvelopeLayers` 的
 * 注释逐字写明"meta 权威"的合并语义）。本批**不**改它（那属 #260/P9 的文件面），
 * 而是在装配层按生产的既有优先级**忠实读取** —— 于是"装配出的元数据"与
 * "UI 显示的标题"同源，不会出现两个答案。
 *
 * @param meta `doc.meta`（可能是空默认值，见上）
 * @param root 文档根级（`doc.serialize()`）；提供时其 `label`/`author`/`description`
 *   参与解析（信封 meta 摊平后的落点）
 */
export function metadataFromLegacy(
  meta: Readonly<Record<string, unknown>>,
  root?: Readonly<Record<string, unknown>>,
): DocumentMetadata {
  const origin = meta.origin as Record<string, unknown> | undefined
  const tags = meta.tags
  const rootLabel = root === undefined ? '' : readString(root.label)
  // 优先级：根 label → meta.name → meta.label（与 `sceneDisplayTitleFromRootDocument` 同序）。
  const name = rootLabel || readString(meta.name) || readString(meta.label)
  const author = readString(meta.author) || (root === undefined ? '' : readString(root.author))
  const description = readString(meta.description) || (root === undefined ? '' : readString(root.description))
  return documentMetadata({
    name,
    author,
    description,
    tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [],
    origin:
      origin && typeof origin === 'object'
        ? { x: readNumber(origin.x) ?? 0, y: readNumber(origin.y) ?? 0, z: readNumber(origin.z) ?? 0 }
        : { x: 0, y: 0, z: 0 },
    createdAtMs: readNumber(meta.created_at_ms),
  })
}

/**
 * 旧 `meta.embed_initial_view` → 一个内核 `camera` 对象。
 *
 * ## 为什么它映射成相机对象（而不是丢掉）
 *
 * `embed_initial_view` 是**真实生产键**（`context/embedInitialView` 读它、
 * `wikiEditSummary` 按它判"发布壳是否需重写"）。它是"读者打开时的初始视角"。
 *
 * 内核的相机模型（§3.1）把两件事分开：**相机参数**（投影/fov/裁剪面）属文档，
 * **观察视角**（yaw/elevation/distance）属 3D 编辑器实例。而 `embed_initial_view`
 * 恰好是**观察视角**（`{target, yawDeg, elevationDeg, distance, zoom}`）——
 * 它是"文档声明的默认观察视角"。
 *
 * ⇒ 本批把它装配成一个 `camera` 对象并**在诊断里如实标注**该口径差异：
 * 内核的 `camera` 载荷只有投影参数，观察视角没有类型化落点。
 * 这条缺口登记为 **GF-5**（见汇报），**不**伪造一个 `perspective/fov` 去冒充它
 * （伪造会让"文档声明的初始视角"看起来已经被内核承载了，而实际没有）。
 */
function cameraObjectsFromMeta(meta: Readonly<Record<string, unknown>>): readonly {
  readonly id: string
  readonly dataId: string
  readonly name: string
  readonly payload: ObjectDataPayload
  readonly view: Readonly<Record<string, unknown>>
}[] {
  const raw = meta.embed_initial_view
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return Object.freeze([])
  const v = raw as Record<string, unknown>
  // 形状判别与 `context/embedInitialView#isViewportCameraState` 同口径 ——
  // 形状不对就**不**造对象（不造一个"看起来是相机"的空壳）。
  const target = v.target as Record<string, unknown> | undefined
  if (
    !target ||
    typeof target !== 'object' ||
    typeof target.x !== 'number' ||
    typeof target.y !== 'number' ||
    typeof target.z !== 'number' ||
    typeof v.yawDeg !== 'number' ||
    typeof v.elevationDeg !== 'number' ||
    typeof v.distance !== 'number' ||
    typeof v.zoom !== 'number'
  ) {
    return Object.freeze([])
  }
  return Object.freeze([
    Object.freeze({
      id: 'camera:embed-initial',
      dataId: 'camera:embed-initial:data',
      name: 'embed_initial_view',
      payload: Object.freeze({
        kind: 'camera' as const,
        projection: 'perspective' as const,
        fov: 50,
        clipStart: 0.1,
        clipEnd: 1000,
      }),
      view: Object.freeze({ ...v }),
    }),
  ])
}

// ─────────────────────────────────────────────────────────────────────────────
// 纹理/材质 → 内核资源引用
// ─────────────────────────────────────────────────────────────────────────────

function readBlendMode(v: unknown): ResourceBlendMode | null {
  return v === 'opaque' || v === 'cutout' || v === 'translucent' ? v : null
}

function readKind(v: unknown): ResourceKind {
  return v === 'animated' ? 'animated' : 'static16'
}

function readAnimationSpec(v: unknown): TextureAnimationSpec | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const out: {
    defaultFrametimeTicks?: number
    frameSequence?: readonly { index: number; timeTicks?: number }[]
    interpolate?: boolean
  } = {}
  const ticks = readNumber(o.defaultFrametimeTicks)
  if (ticks !== null) out.defaultFrametimeTicks = ticks
  if (Array.isArray(o.frameSequence)) {
    const seq: { index: number; timeTicks?: number }[] = []
    for (const e of o.frameSequence) {
      if (e === null || typeof e !== 'object') continue
      const f = e as Record<string, unknown>
      const index = readNumber(f.index)
      if (index === null) continue
      const timeTicks = readNumber(f.timeTicks)
      seq.push(timeTicks === null ? { index } : { index, timeTicks })
    }
    out.frameSequence = Object.freeze(seq)
  }
  if (typeof o.interpolate === 'boolean') out.interpolate = o.interpolate
  return Object.freeze(out)
}

/**
 * 旧 `materialPalette` + `textureBlobs` → 内核资源清单（#249 §3.1「资源引用」）。
 *
 * ## 逐项映射（这就是"材质调色板/纹理 blob 各归其位"）
 *
 * | 旧字段 | 新字段 | 说明 |
 * |---|---|---|
 * | `textureBlobs[entry.textureBlobIndex]` | `payload`（内嵌字节） | 版本由字节摘要派生 |
 * | `entry.locator` | `ref.url`（获取位置） | **不**参与身份 |
 * | `entry.kind` | `kind` | `static16`/`animated` |
 * | `entry.blend` | `blend` | 呈现契约 |
 * | `entry.animation` | `animation` | 声明（采样策略在 `domain/materials`） |
 * | `entry.emissive` / `atlas` / `linear` / `useMipmaps` | 同名字段 | 呈现提示 |
 *
 * `assetId` 用 `` `material:${i}` ``（下标身份）：旧格式**没有**稳定资源 ID
 * （这正是 §19.3「资源引用包含稳定资源 ID」要补的东西），故本批用
 * "调色板槽位"作 id 并**在诊断里如实标注**该口径差异（GF-6）。
 * 用 locator 当 id 会更糟 —— 那会让"同一份贴图换了个镜像地址"变成两个资源。
 */
export function resourcesFromLegacy(
  materialPalette: readonly unknown[] | undefined,
  textureBlobs: Readonly<Record<string, unknown>> | undefined,
): { readonly resources: readonly ContentResource[]; readonly diagnostics: readonly AssemblyDiagnostic[] } {
  const resources: ContentResource[] = []
  const diagnostics: AssemblyDiagnostic[] = []
  if (!materialPalette || materialPalette.length === 0) {
    return { resources: Object.freeze(resources), diagnostics: Object.freeze(diagnostics) }
  }
  const blobs = textureBlobs ?? {}
  for (let i = 0; i < materialPalette.length; i++) {
    const raw = materialPalette[i]
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    const blobIndex = readNumber(entry.textureBlobIndex) ?? readNumber(entry.texture_blob_index)
    const blob = blobIndex === null ? undefined : blobs[String(Math.floor(blobIndex))]
    // 只接受字符串字节：非字符串（对象/数组）说明形态不是"内嵌 Base64"，
    // 显式记为无字节而不是 `String(blob)` 造一个假字节串。
    const payload = typeof blob === 'string' ? blob : null
    const locator = readString(entry.locator)
    if (payload === null && locator === '') {
      // 既没字节也没位置 ⇒ 无法取回。**显式**诊断（A36 负对照「占位被当正式资源」：
      // 静默造一条空资源会让"缺纹理"表现为"画出来是白的"）。
      diagnostics.push(
        diagnostic(
          'resourceWithoutPayloadOrLocator',
          `$.materialPalette[${i}]`,
          `材质槽 ${i} 既无 textureBlobs 字节（下标 ${blobIndex ?? '缺'}）也无 locator —— 该资源无法取回`,
        ),
      )
    }
    resources.push(
      contentResource({
        assetId: `material:${i}`,
        locator,
        kind: readKind(entry.kind),
        payload,
        // 无字节时版本必须由文件给出；旧格式没有这个字段，故用 locator 作退化版本
        // （**不**是"内容版本"，本批在 GF-6 里如实登记该口径差异）。
        contentVersion: `legacy:${locator}`,
        blend: readBlendMode(entry.blend),
        emissive: readNumber(entry.emissive),
        animation: readAnimationSpec(entry.animation),
        atlas: typeof entry.atlas === 'string' ? entry.atlas : null,
        linear: typeof entry.linear === 'boolean' ? entry.linear : null,
        useMipmaps: typeof entry.useMipmaps === 'boolean' ? entry.useMipmaps : null,
      }),
    )
  }
  return { resources: Object.freeze(resources), diagnostics: Object.freeze(diagnostics) }
}

// ─────────────────────────────────────────────────────────────────────────────
// 帧 → 内核帧时长轴
// ─────────────────────────────────────────────────────────────────────────────

/** 旧帧列表 → 内核帧时长轴（时长是文档声明，**不**猜默认值）。 */
export function frameAxisFromLegacy(frames: readonly RuntimeFrame[]): DocumentContent['frameAxis'] {
  return frameAxis(
    frames.map((f) =>
      Object.freeze({
        index: f.index,
        label: f.label ?? null,
        durationMs: typeof f.durationMs === 'number' && Number.isFinite(f.durationMs) ? f.durationMs : null,
      }) satisfies FrameDeclaration,
    ),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 注解 → 内核注解对象
// ─────────────────────────────────────────────────────────────────────────────

interface AnnotationMapping {
  readonly objects: readonly { readonly obj: SceneObject; readonly data: ObjectData }[]
  readonly diagnostics: readonly AssemblyDiagnostic[]
}

/**
 * 旧 `annotations` → 内核 `annotation` 对象。
 *
 * 逐条映射 `id`/`type`（形状）/`visible`；`title`/`description` 合成 `text`
 * （内核注解载荷的 `text` 是**单个**字符串，旧模型把它拆成两个字段 ——
 * 合成时**保留两者**而不是丢掉 `description`：丢掉就是静默丢语义）。
 *
 * 旧注解的形状联合（`box`/`point`/`line`/`text`/`face`）与内核
 * `ObjectDataPayload.annotation.shape` 的联合**逐项相同**，故形状可直接透传；
 * 不在此联合内的形状产出一条诊断并**跳过**（不伪造一个 `box`）。
 */
export function annotationObjects(annotations: readonly unknown[]): AnnotationMapping {
  const objects: { obj: SceneObject; data: ObjectData }[] = []
  const diagnostics: AssemblyDiagnostic[] = []
  for (let i = 0; i < annotations.length; i++) {
    const raw = annotations[i]
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const a = raw as Record<string, unknown>
    const shape = readString(a.type)
    if (!ANNOTATION_SHAPES.includes(shape)) {
      diagnostics.push(
        diagnostic('unsupportedAnnotationShape', `$.annotations[${i}].type`, `注解形状 ${shape || '(缺)'} 不在内核支持集合内`),
      )
      continue
    }
    const id = readString(a.id) || `annotation:${i}`
    const objectId = `annotation:${id}`
    const dataId = `${objectId}:data`
    const title = readString(a.title)
    const description = readString(a.description)
    // 合成规则：两者都在 ⇒ `title\n\ndescription`；只有一个 ⇒ 那一个；都没有 ⇒ 无 text 字段。
    const text = title !== '' && description !== '' ? `${title}\n\n${description}` : title !== '' ? title : description
    const payload: ObjectDataPayload =
      text === ''
        ? Object.freeze({ kind: 'annotation' as const, shape: shape as 'box' | 'point' | 'line' | 'text' | 'face' })
        : Object.freeze({ kind: 'annotation' as const, shape: shape as 'box' | 'point' | 'line' | 'text' | 'face', text })
    objects.push({
      obj: sceneObject({
        id: objectId,
        type: 'annotation',
        name: title !== '' ? title : objectId,
        visible: a.visible === undefined ? true : a.visible === true,
        dataId,
      }),
      data: objectData(dataId, payload, 'document'),
    })
  }
  return { objects: Object.freeze(objects), diagnostics: Object.freeze(diagnostics) }
}

// ─────────────────────────────────────────────────────────────────────────────
// 装配（唯一入口）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把一份旧文档装配成内核文档四要素（#282 的核心函数）。
 *
 * ## 失败是 `Result`，不是抛异常
 *
 * 契约 §0/§3.2：业务失败走 `Result`。本函数只在**输入形态不合法**
 * （`frames` 缺失且不是多方块文档 ⇒ 我们不知道它是什么）时返回
 * `UnsupportedOperation` —— 那是"能力不存在于本 profile"的正确分类，
 * 而**不是**"尽力而为地装配出一份空文档"（#249 §13「不得以空接口、
 * 假成功控件充当旧机制」）。
 *
 * 未知字段与不支持能力**不**导致失败：它们产诊断 + 保真记录，装配继续
 * （§12 第 3 段：保真记录是**为此存在**的）。
 */
export function assembleKernelDocument(input: AssemblyInput): Result<AssembledDocument> {
  const doc = input.doc
  const documentId = input.documentId ?? (doc?.id !== undefined && doc.id !== '' ? doc.id : 'doc-1')
  const sceneId = input.sceneId ?? `${documentId}-scene`
  const objectLimit = input.objectLimit ?? DEFAULT_OBJECT_LIMIT

  // ── 空文档：装配出一份空内核文档（**不是**失败） ──
  if (doc === null) {
    return ok(
      Object.freeze({
        documentId,
        scene: emptyScene(sceneId),
        animation: EMPTY_ANIMATION,
        content: documentContent(),
        multiblock: null,
        unknownFields: Object.freeze({}),
        sourceFormat: 'none',
        sourceVersion: '',
        diagnostics: Object.freeze([]),
        frameObjects: Object.freeze([]),
      }),
    )
  }

  const diagnostics: AssemblyDiagnostic[] = []
  let scene = emptyScene(sceneId)

  // ── ① 顶层未知字段 → 报原始字段 + 诊断（记录由调用方构造，见 `unknownFields`） ──
  //
  // 输入是**信封解包后的 plain 根**（`readEnvelopeLayers` 的产物），不是
  // `doc.serialize()` —— 见 `metadataFromLegacy` 的说明：信封 `meta` 的键
  // （`label`/`author`/`gtnhVersion`…）被摊平到 plain 根，而 `fromV2Plain` 把它们
  // 列进 `known` 却**不读**、也不收进 `_extra` ⇒ `serialize()` 里已经看不到它们。
  // 用 `serialize()` 会让这些键**在保真记录里也消失**（"静默丢失"的最坏形态：
  // 连保真记录都没保住它）。
  const raw = input.plainRoot ?? legacyPlainRoot(doc)
  const sourceFormat = doc.isMultiblock ? 'Multiblock' : 'V2Plain'
  const sourceVersion = doc.formatVersion
  const unknownFields: Record<string, unknown> = {}
  for (const key of Object.keys(raw)) {
    if (key === CORE_EXTRA_BAG_KEY) continue
    if (KNOWN_ROOT_KEYS.includes(key)) continue
    unknownFields[key] = raw[key]
  }
  for (const key of Object.keys(unknownFields)) {
    diagnostics.push(
      diagnostic('unknownRootField', `$.${key}`, `顶层字段 ${key} 本适配器解释不了 —— 由调用方进保真记录（源格式 ${sourceFormat}@${sourceVersion}），不静默丢弃`),
    )
  }

  // ── ② 元数据未知键 → 诊断（meta 的已知键之外的键） ──
  //
  // 它们同时进 `unknownFields`（键名加 `meta.` 前缀以免与根级键撞车）——
  // 于是"这份文件在 meta 里写了什么我们没解释"既能被记录、也能被诊断。
  for (const key of Object.keys(doc.meta)) {
    if (!KNOWN_META_KEYS.includes(key)) {
      unknownFields[`meta.${key}`] = doc.meta[key]
      diagnostics.push(
        diagnostic('unknownRootField', `$.meta.${key}`, `元数据键 ${key} 本适配器解释不了 —— 由调用方进保真记录，不静默丢弃`),
      )
    }
  }

  // ── ③ 帧网格 → blockGrid 对象（每帧一个对象） ──
  const frameObjects: string[] = []
  let objectCount = 0
  for (let i = 0; i < doc.frameCount; i++) {
    const frame = doc.frame(i)
    if (frame === null) continue
    const grid = frame.grid
    if (grid === null) {
      // 多方块文档的帧**设计上**没有网格（网格是装配产物）—— 那不是瑕疵。
      if (!doc.isMultiblock) {
        diagnostics.push(
          diagnostic('frameWithoutGrid', `$.frames[${i}]`, `第 ${i} 帧没有网格且文档不是多方块形态 —— 该帧无可渲染内容`),
        )
      }
      continue
    }
    if (objectCount >= objectLimit) {
      diagnostics.push(
        diagnostic('gridObjectLimitExceeded', `$.frames[${i}]`, `对象数超过上限 ${objectLimit} —— 后续帧未装配（显式截断，不静默）`),
      )
      break
    }
    const objectId = `structure:frame-${frame.index}`
    const dataId = `${objectId}:data`
    const next = withObject(
      scene,
      sceneObject({ id: objectId, type: 'block', name: frame.label ?? objectId, dataId }),
      objectData(dataId, Object.freeze({ kind: 'blockGrid' as const, cells: gridCells(grid) }), 'document'),
    )
    if (next !== null) {
      scene = next
      objectCount += 1
      frameObjects.push(objectId)
    }
  }

  // ── ④ 注解对象 ──
  const annotations = annotationObjects(doc.annotations)
  diagnostics.push(...annotations.diagnostics)
  for (const { obj, data } of annotations.objects) {
    const next = withObject(scene, obj, data)
    if (next !== null) scene = next
  }

  // ── ⑤ 相机对象（来自 meta.embed_initial_view） ──
  for (const cam of cameraObjectsFromMeta(doc.meta)) {
    const next = withObject(
      scene,
      sceneObject({ id: cam.id, type: 'camera', name: cam.name, dataId: cam.dataId }),
      objectData(cam.dataId, cam.payload, 'document'),
    )
    if (next !== null) scene = next
  }

  // ── ⑥ 资源引用 ──
  const res = resourcesFromLegacy(doc.materialPalette, doc.textureBlobs)
  diagnostics.push(...res.diagnostics)

  // ── ⑦ 内容三块 ──
  const content = documentContent({
    metadata: metadataFromLegacy(doc.meta, raw),
    frameAxis: frameAxisFromLegacy(doc.frames),
    resources: normalizeResources(res.resources),
  })

  // ── ⑧ 多方块：只读内容定义 + 装配网格 ──
  let multiblock: MultiblockContent | null = null
  if (doc.isMultiblock) {
    const decl = doc.multiblock?.decl ?? null
    const source = doc.multiblockSource
    if (decl !== null && source !== null) {
      multiblock = Object.freeze({
        id: decl.id,
        displayName: decl.displayName,
        channels: Object.freeze([...decl.channels]),
        runstates: Object.freeze([...decl.runstates]),
        variants: Object.freeze([...decl.variants]),
        totalTierDomain: decl.totalTierDomain,
        source: Object.freeze({ ...source }),
      })
      // 装配当前取值 → 一个 **只读内容** 网格对象（`source: 'content'`，§3.3）。
      //
      // 直接调 `assembleSelection`（`context/multiblock` 的公共出口）而不是
      // `shared/viewport/multiblockChannelUi#assembleForSelection`：后者是**UI 包装**
      // （它做"变体未声明就回落 + 落提示"的展示决策），而装配层要的是**纯装配**。
      // 用包装会把展示政策拖进装配，且它是深度 3 的路径（超公共出口上限）。
      const selection = input.multiblockSelection ?? initialSelection(doc)
      const outcome = tryAssembleSelection(source, selection)
      if (outcome === null) {
        diagnostics.push(
          diagnostic('multiblockAssemblyFailed', '$.multiblock', '多方块装配未产出结果（见 selection 与声明）'),
        )
      } else {
        const objectId = 'structure:multiblock'
        const dataId = `${objectId}:data`
        const next = withObject(
          scene,
          sceneObject({ id: objectId, type: 'block', name: multiblock.displayName || objectId, dataId }),
          objectData(dataId, Object.freeze({ kind: 'blockGrid' as const, cells: gridCells(outcome.grid) }), 'content'),
        )
        if (next !== null) {
          scene = next
          frameObjects.push(objectId)
        }
      }
    }
  }

  // ── ⑨ 形态合法性：既没有帧网格也没有多方块 ⇒ 我们不知道这是什么 ──
  if (frameObjects.length === 0 && multiblock === null) {
    return err(
      invalidValue({
        reason: 'unsupportedDocumentShape',
        documentId,
        frameCount: doc.frameCount,
        isMultiblock: doc.isMultiblock ? 1 : 0,
      }),
    )
  }

  return ok(
    Object.freeze({
      documentId,
      scene,
      animation: EMPTY_ANIMATION,
      content,
      multiblock,
      unknownFields: Object.freeze(unknownFields),
      sourceFormat,
      sourceVersion,
      diagnostics: Object.freeze(diagnostics),
      frameObjects: Object.freeze(frameObjects),
    }),
  )
}

/**
 * 从 `RuntimeDocument` 复原"解析器看到的 plain 根"。
 *
 * ## 为什么需要复原，以及它为什么**有损**（实测，不推断）
 *
 * `RuntimeDocument.fromV2Plain` 的 `known` 集合列了 7 个根级键
 * （`label`/`author`/`description`/`gtnhVersion`/`modSource`/`globalConfig`/`schemaVersion`）
 * 却从不读它们，同时又把它们排除在 `_extra` 之外 ⇒ 它们**从 `RuntimeDocument`
 * 无法恢复**。实测：`plain.label` 有值而 `doc.serialize().label === undefined`。
 *
 * ⇒ 本函数只能复原 `serialize()` **保留下来**的部分，故它**必然有损**。
 * 因此 {@link AssemblyInput.plainRoot} 是恢复元数据的**唯一**正确通路，
 * 而本函数只是"调用方没给 plainRoot 时"的如实降级（元数据为空，不伪造）。
 *
 * `documentFormat: 'Plain'` 由本函数补上：`serialize()` 不写它（它由信封层维护），
 * 而 `classifyShape` 的形态判别需要它才认得 V2Plain。
 */
function legacyPlainRoot(doc: RuntimeDocument): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...doc.serialize(), documentFormat: 'Plain' })
}

/**
 * 装配一个多方块选择（**不抛**：装配异常返回 `null`，由调用方落诊断）。
 *
 * 与 `shared/viewport/multiblockChannelUi#assembleForSelection` 的分工：
 * 那个是**UI 包装**（做"未声明组合回落 + 落提示"的展示决策，返回面板模型），
 * 本函数只要**装配结果**（网格），且**不**吞掉"未声明组合"这件事的语义 ——
 * 它按 §5.2 推论 3「只夹取不拒绝」交给 `assembleSelection` 处理，
 * 那里会把未声明组合回落到最近的已声明变体并落 `report.warnings`。
 *
 * 捕获异常是因为装配可能因文件缺陷抛错（`assembleSelection` 对"变体无 frame"
 * 这类完整性问题抛 `Error`）—— 装配层**不**让文件缺陷变成栈，
 * 而是返回 `null` 让调用方产一条诊断（#249 §12：不静默、也不崩）。
 */
function tryAssembleSelection(
  source: Readonly<Record<string, unknown>>,
  selection: MultiblockSelectionState,
): AssemblyResult | null {
  try {
    return assembleSelection(source as MultiblockInnerDocument, {
      totalTier: selection.totalTier,
      values: { ...selection.values },
      runstate: selection.runstate,
    })
  } catch {
    return null
  }
}

/** 文档声明的初始多方块选择（与 `useMultiblockChannels` 的初始口径同源）。 */
function initialSelection(doc: RuntimeDocument): MultiblockSelectionState {
  const decl = doc.multiblock?.decl
  if (!decl) return { totalTier: 1, values: {}, runstate: '' }
  const domain = decl.totalTierDomain
  const values: Record<string, number> = {}
  for (const c of decl.channels) values[c.key] = 0
  return {
    totalTier: Math.min(Math.max(Math.trunc(domain.default ?? domain.max), Math.trunc(domain.min)), Math.trunc(domain.max)),
    values,
    runstate: decl.runstates[0]?.id ?? '',
  }
}

/** 未使用占位：保持 `Transform` 类型可达（下游类型推导用）。 */
export type { Transform }
