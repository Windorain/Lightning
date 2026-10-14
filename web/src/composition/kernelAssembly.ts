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
// 深度 2 的公共出口（契约 §7.3 规则 2）——实现留在 `adapters/files/`（族内），
// 直接 import 深度 3 会被 `gate/no-private-cross-layer` 判红（首次接线实测 1 条）。
import { multiblockDeclarationContentOf } from '@/adapters/multiblockDeclaration'
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
import { normalizeCellContent, type CellContent, type CellContentTable } from '@/domain/cellContent'
import { cellPositionKey } from '@/domain/cellPosition'
import { blockGeometryAsset, decodeBlockGeometry, type BlockGeometryAsset, type BlockPaletteEntry } from '@/domain/blockGeometry'
import {
  annotationTextOf,
  objectData,
  sceneObject,
  withObject,
  emptyScene,
  type AnnotationGeometry,
  type ObjectData,
  type ObjectDataPayload,
  type Scene,
  type SceneObject,
} from '@/domain/scene'
import type { Transform } from '@/domain/scene'
import { assemblePaletteContent, assembleTooltipContent, type AssembledPalette } from './kernelPaletteAssembly'
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
  /** 调色板条目的烘焙几何里有被**跳过**的四边形（顶点数 ≠ 4 / 非有限分量）。 */
  | 'blockGeometrySkippedQuads'
  /** 调色板条目的几何解码成功但拓扑不合法（未产出资产）。 */
  | 'blockGeometryNoAsset'

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

/**
 * 装配层诊断构造器作为**收窄**回调（供 `composition/kernelPaletteAssembly` 用）。
 *
 * 该模块产出的码是本文件的 `AssemblyDiagnosticCode` 联合的成员，但它在
 * **另一个模块**里，无法引用本文件的类型（会成环：本文件 import 它）。故它的
 * 构造器签名收 `string`，这里用一个**显式窄化**的包装把它接回本文件的联合 ——
 * 于是"码必须是已知码"这条约束仍然只有一个定义点（`AssemblyDiagnosticCode`），
 * 而不是在两处各列一遍。
 */
const diagnosticSink: (code: string, path: string, detail: string) => AssemblyDiagnostic = (code, path, detail) =>
  diagnostic(code as AssemblyDiagnosticCode, path, detail)

/**
 * 生产解析器产出的 `MultiblockDecl`（**类型化**）→ 投影面的类型化声明。
 *
 * ## 为什么是"显式逐字段搬运 + 逐元素编码"而不是 `...decl` 展开
 *
 * 展开会把 `decl` 的**全部**字段一起带进去，其中两类必须排除：
 *
 * | 排除项 | 理由 |
 * |---|---|
 * | `ruleById`/`variantByKey`/`channelByKey`/`runstateById`（四个 `Map`） | 不是 JSON 可序列化的（投影产物要能 `JSON.stringify`） |
 * | `decl.raw`（单个原始 JSON 节点） | 带上它就等于把回显请回来（本批正在退役的东西） |
 *
 * ## 逐元素**编码**是必需的（本批实测抓出）
 *
 * 通道元素的一个字段名与文件格式**不同**：类型化面叫 `enumName`，而文件键是 `enum`
 * （契约 §4.2 的双键消歧；解析器硬断言 `'enum' in raw`）。
 * 直接把类型化元素写出去会让解析器判红 `通道 key 缺 enum 字段` ——
 * 这与几何的 `encodeBlockGeometry` 是同一类问题：**内部形状 ≠ 文件形状**，
 * 故必须有一步显式编码。
 *
 * 其余元素的字段名与文件一致（规则 `phase`/`kind`/`index`/`indexRole`/`indexTable`/
 * `channel`/`guard`/`sel`/`x`/`y`/`z`/`legend`；骨架阶 `channel`/`cellGrid`/`layers`/
 * `w`/`hh`/`d`/`roles`；变体 `key`/`totalTier`/`values`/`runstate`；运行态 `id`/`name`/
 * `materialSwap`），故只做浅拷贝 —— 但**每个元素都过一遍编码函数**，
 * 于是"将来哪个字段改名"只会在这里暴露一次，而不是静默产出非法文件。
 *
 * 元素自带的 `raw`（每元素一个原始节点）**保留**：那是元素**内部**扩展键的保真，
 * 去掉它会让"某条规则的族特有字段"静默丢失（§12 第 3 段）。
 * 类型化的是**结构**（哪些字段已知、有类型），不是"禁止任何原始节点存在"。
 */
export function typedDeclarationOf(decl: MultiblockDecl): {
  sourceClass?: string
  hasScopeOverlap: boolean
  scopeOverlapNote?: string
  totalTierDomain: Readonly<Record<string, unknown>>
  tierSample: readonly number[]
  channels: readonly Readonly<Record<string, unknown>>[]
  runstates: readonly Readonly<Record<string, unknown>>[]
  variants: readonly Readonly<Record<string, unknown>>[]
  rules: readonly Readonly<Record<string, unknown>>[]
  backbone: Readonly<Record<string, unknown>>
  couplings: readonly Readonly<Record<string, unknown>>[]
  couplingMode: string
  notes: readonly Readonly<Record<string, unknown>>[]
  paletteSource: string
  geometryEncoding: string
  opsLegend: Readonly<Record<string, string>>
} {
  const out: {
    sourceClass?: string
    hasScopeOverlap: boolean
    scopeOverlapNote?: string
    totalTierDomain: Readonly<Record<string, unknown>>
    tierSample: readonly number[]
    channels: readonly Readonly<Record<string, unknown>>[]
    runstates: readonly Readonly<Record<string, unknown>>[]
    variants: readonly Readonly<Record<string, unknown>>[]
    rules: readonly Readonly<Record<string, unknown>>[]
    backbone: Readonly<Record<string, unknown>>
    couplings: readonly Readonly<Record<string, unknown>>[]
    couplingMode: string
    notes: readonly Readonly<Record<string, unknown>>[]
    paletteSource: string
    geometryEncoding: string
    opsLegend: Readonly<Record<string, string>>
  } = {
    hasScopeOverlap: decl.hasScopeOverlap === true,
    totalTierDomain: Object.freeze({ ...decl.totalTierDomain }),
    tierSample: Object.freeze([...decl.tierSample]),
    // **元素编码**（两个字段名/形状与文件格式不同 —— 本批实测抓出）：
    //  ① `enumName` → 文件键 `enum`（契约 §4.2 双键消歧；解析器硬断言 `'enum' in raw`）。
    //  ② `domain` → 文件的**取值域区间** `{min, max}`。类型化面的 `domain` 是**算出来的**
    //     `{lo, hi}`（`lo` 恒 0），而解析器读的是 `domain.max`（`parseChannel` 第 435 行）——
    //     把 `{lo, hi}` 原样写回会让 `domain.max` 缺席，于是 `domainHi` 回落成总档位上界，
    //     进而让 `indexTable` 长度校验判红（实测：`coil` 的 need 从 4 变成 15）。
    //     用类型化的 `min`/`max`（有效取值下/上界）写回区间，语义等价且校验通过。
    channels: Object.freeze(
      decl.channels.map((c) => {
        const { enumName, domain, raw, ...rest } = c as unknown as {
          enumName: string | null
          domain: { lo: number; hi: number }
        } & Record<string, unknown>
        void domain
        // `raw` 与其余元素同样**必须剥离**（见 `variants` 的说明：元素级 `raw`
        // 会让每轮往返嵌套一层）。它这里曾漏掉，实测 `channels` 每轮 +200 B。
        // D10：剥离 `raw` **不等于**丢扩展键 —— 以源节点为底，typed（含上面
        // 两条改名/改形）覆盖（见 `withExtensionKeys`）。
        return withExtensionKeys((raw ?? {}) as Readonly<Record<string, unknown>>, {
          ...rest,
          enum: enumName,
          domain: { min: c.min, max: c.max },
        } as Readonly<Record<string, unknown>>)
      }),
    ),
    runstates: Object.freeze(
      decl.runstates.map((r) => {
        const { raw, ...rest } = r as unknown as Record<string, unknown>
        // D10：`runstates[].materialSwap` 等扩展键保留（实测 2/1/1 条）。
        return withExtensionKeys((raw ?? {}) as Readonly<Record<string, unknown>>, rest as Readonly<Record<string, unknown>>)
      }),
    ),
    // ## 元素级 `raw` **必须剥离**（本批实测抓出的一个**迭代增长**缺陷）
    //
    // 类型化元素（变体/规则/运行态/骨架阶）各自带一个 `raw`（解析时的原始节点）。
    // 第一版把它们 `{...element}` 原样带出 ⇒ `raw` 出现在**产物**里。
    // 后果不是"多几个字节"，而是**每轮往返都嵌套一层**：
    //
    // 实测（`multiblock-ebf-2ch`）：原始 143208 B ⇒ 第 1 轮投影 **512552 B**
    // （`variant[0].raw.raw…`），第 2 轮**装配直接失败**（`InvalidValue`）。
    // 那不是"格式冗余"，是"保存两次就坏掉"。
    //
    // 剥离是**无损**的：元素的全部**有名字段**都已在类型化面上（`key`/`totalTier`/
    // `values`/`runstate`… 见 `MultiblockVariantDecl` 等），`raw` 只是解析期
    // 的中间引用。而**真正**需要扩展键保真的地方是 `declRaw`（`multiblock` 节级）
    // 与 `fidelityFields`（产物根级）—— 它们**不在**元素内部。
    variants: Object.freeze(
      decl.variants.map((v) => {
        const { raw, ...rest } = v as unknown as Record<string, unknown>
        // D10：以**源节点**为底（见 `withExtensionKeys` 的说明）——
        // `variants[].height` 这类"解析器未提升为有名字段"的键由此保留。
        return withExtensionKeys((raw ?? {}) as Readonly<Record<string, unknown>>, rest as Readonly<Record<string, unknown>>)
      }),
    ),
    rules: Object.freeze(
      decl.rules.map((r) => {
        const { raw, guard, ...rest } = r as unknown as {
          raw?: unknown
          guard?: { readonly clauses?: readonly Record<string, unknown>[] }
        } & Record<string, unknown>
        // ## 守卫子句的 `raw` 也要剥离（本批实测抓出的**第二层**嵌套）
        //
        // `guard.clauses[]` 同样各带一个 `raw`（`MultiblockGuardClause.raw`）。
        // 顶层剥离够不到它 —— 实测 `multiblock-lsc-overlap` 的
        // `guard.clauses[0].raw` **每轮往返嵌套一层**（+47 B/轮），
        // 即"保存两次就长出多余的 raw 壳"。
        //
        // 与顶层同理：子句的全部有名字段（`channel`/`value`/`min`/`max`/`not`）
        // 都已在类型化面上，`raw` 只是解析期引用 ⇒ 剥离无损。
        const out: Record<string, unknown> = { ...rest }
        if (guard !== undefined && guard !== null) {
          const clauses = guard.clauses
          if (Array.isArray(clauses)) {
            out.guard = Object.freeze({
              ...guard,
              clauses: Object.freeze(
                clauses.map((c) => {
                  const { raw: clauseRaw, ...clauseRest } = c as Record<string, unknown>
                  void clauseRaw
                  return Object.freeze({ ...clauseRest })
                }),
              ),
            })
          } else {
            out.guard = guard
          }
        }
        // D10：规则的**扩展键**同样以源节点保真（`guard` 由上面的处理覆盖 —— typed 赢）。
        return withExtensionKeys((raw ?? {}) as Readonly<Record<string, unknown>>, out)
      }),
    ),
    // 骨架阶**不含** `decl.backbone.raw`（其原始节点由 `declRaw` 保真 —— 两者不重复承载）。
    backbone: Object.freeze({
      kind: decl.backbone.kind,
      sizeChannel: decl.backbone.sizeChannel,
      sizeSteps: Object.freeze(
        decl.backbone.sizeSteps.map((s) => {
          const { raw, ...rest } = s as unknown as Record<string, unknown>
          // D10：`sizeSteps[].{channel,layers,w,hh,d,roles}` 这类扩展键必须保留
          // （它们是骨架阶的**尺寸语义**，丢了则骨架重建不出来）。
          return withExtensionKeys((raw ?? {}) as Readonly<Record<string, unknown>>, rest as Readonly<Record<string, unknown>>)
        }),
      ),
    }),
    couplings: Object.freeze(
      decl.couplings.map((c) => {
        const { raw, ...rest } = c as unknown as Record<string, unknown>
        return withExtensionKeys((raw ?? {}) as Readonly<Record<string, unknown>>, rest as Readonly<Record<string, unknown>>)
      }),
    ),
    couplingMode: decl.couplingMode,
    notes: Object.freeze(
      decl.notes.map((n) => {
        const { raw, ...rest } = n as unknown as Record<string, unknown>
        // D10：`notes[].source` 等扩展键保留。
        return withExtensionKeys((raw ?? {}) as Readonly<Record<string, unknown>>, rest as Readonly<Record<string, unknown>>)
      }),
    ),
    paletteSource: decl.paletteSource,
    geometryEncoding: decl.geometryEncoding,
    opsLegend: Object.freeze({ ...decl.opsLegend }),
  }
  if (decl.sourceClass !== undefined) out.sourceClass = decl.sourceClass
  if (decl.scopeOverlapNote !== undefined) out.scopeOverlapNote = decl.scopeOverlapNote
  return out
}

/**
 * 取内层 body 的 `multiblock` 节原文（**单个节点**，不是整个 body）。
 *
 * ## 为什么是"单个节点"（本批退役 `source` 的判据）
 *
 * R-WK-06 裁决要求退役的是 **`MultiblockContent.source`（整个内层 body 的原始 JSON 回显）**。
 * 本函数取的是 `source.multiblock` 这**一个节点**，用途被严格限定为：
 *
 *  - **内容身份输入**（`runtime/presentationAdapter#structureDigestOf` 的 `multiblock` 维）：
 *    那里要的是"装配依据的声明变了没有"，而整节摘要正是这个事实；
 *  - **类型化承载未覆盖的扩展键**（`viewerSemantics`/`notes` 的族特有字段）：
 *    它们在文件里真实存在，投影时若不写回就是静默丢语义（§12 第 3 段）。
 *
 * ## 与回显的可判定区别
 *
 * 回显的形态是「投影时把 `source` 逐键摊平回产物根」—— 那使 `source` 成为
 * **渲染与保存的事实来源**（删掉它渲染就崩）。本函数之后，投影侧**从类型化字段
 * 重建**声明（`kernelProjection#projectMultiblockDeclaration`），
 * 而那些类型化字段是装配期从**同一份** `decl` 派生的。
 *
 * 判别实验：把 `declRaw` 从产物里删掉，投影仍产出可被生产解析器读回的声明
 * （`kernelProjection.test.ts` 的"声明往返逐键一致"逐键断言）——
 * 若它是回显，删掉即崩。
 *
 * 缺失或形态不对时返回冻结的空对象（**显式**，而不是 `undefined` 让调用方猜）。
 */
function declRawOf(source: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const raw = source.multiblock
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return Object.freeze({})
  return Object.freeze({ ...(raw as Record<string, unknown>) })
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
  /**
   * 契约内层 body 的 `multiblock` 节**原文**。
   *
   * ## ⚠️ 本批（#289 P10d）退役了 `source`（原始 JSON 回显），保留本条目的理由
   *
   * R-WK-06 裁决第 3 条逐字要求「`MultiblockContent.source` 的原始 JSON 回显在
   * #289 同批退役（#249 §12「不能将原始 JSON 重新塞进核心」）」。**已执行**：
   * `source` 字段本身已删除。
   *
   * 而 `decl.raw`（单个 `multiblock` 节点）**保留**，因为它是**类型化承载尚未覆盖**
   * 那部分声明（`viewerSemantics`/`notes` 的扩展键/`opsLegend` 之外的未知键）的
   * 唯一通路，且它的消费者是 `runtime/presentationAdapter` 的**内容身份摘要**
   * （`structureDigestOf({multiblock: doc.multiblock?.decl.raw})`）—— 那里需要
   * "装配依据的声明变了没有"这一事实，而**整节原文的摘要**正是它。
   *
   * ## 与"原始 JSON 回显"的界线（可判定）
   *
   * | 形态 | 判据 | 本批 |
   * |---|---|---|
   * | **回显**：装配产物携带整个内层 body，投影时**摊平回根** | `projectKernelDocument` 从 `source` 逐键复制 | **已删** |
   * | **声明原文**：装配产物携带单个 `multiblock` 节，投影时由**类型化字段重建** | 投影从 `channels/runstates/variants/rules/backbone/frames` 重建同名键 | 保留 |
   *
   * 判据是可执行的：投影侧若仍从 `raw` 摊平，下面的 `projectMultiblockDeclaration`
   * 就不需要存在。它存在，且它的产物被逐键断言等于原声明
   * （见 `__tests__/kernelProjection.test.ts` 的"声明往返逐键一致"）。
   */
  readonly declRaw: Readonly<Record<string, unknown>>
  /**
   * 投影所需的**类型化声明面**（形状与 `kernelProjection#KernelDeclarationProjection` 一致）。
   *
   * ## 为什么由装配产物一并给出（而不是让投影自己去场景里翻）
   *
   * 投影要重建内层 body，需要三样东西：声明字段、**帧声明**、**并集调色板 + 几何资产**。
   * 后两样在场景里也能翻到（`structure:multiblock` 对象的载荷），但"翻"意味着
   * 投影要按**对象 id 约定**去找 —— 那是把装配的命名约定泄漏给投影层。
   *
   * ⇒ 装配产物**显式**给出这三样，投影只做"重建"，不做"查找"。
   * 这也是"零回显"可判定的原因：`projectMultiblockBody` 的每个输出键都能追溯到
   * 本字段的一个具名子字段（见那里的逐键来源表）。
   */
  readonly projection: MultiblockProjectionFace
}

/** 装配产物里承载的**投影面**（字段语义见 `kernelProjection#KernelDeclarationProjection`）。 */
export interface MultiblockProjectionFace {
  /**
   * **类型化的声明字段**（形状与 `kernelProjection#KernelTypedDeclaration` 一致）。
   *
   * 见那里对"为什么它必须存在"的说明：第一版的投影面**缺**它，导致投影只能从
   * `declRaw` 回落声明字段（即"声明仍靠原始 JSON"），被零回显判别实验判红。
   */
  readonly declaration: ReturnType<typeof typedDeclarationOf>
  /** 并集调色板（契约 §6；`[0]` 恒为 air）。 */
  readonly blockPalette: readonly BlockPaletteEntry[]
  /** 几何资产目录（`assetId` → 资产）。 */
  readonly assets: Readonly<Record<string, BlockGeometryAsset>>
  /** 帧声明（变体/运行态/骨架阶/规则引用）。 */
  readonly frames: readonly {
    readonly index: number
    readonly variant: string
    readonly runstate: string
    readonly stepIndex: number
    readonly rules: readonly (string | Readonly<{ id: string; order?: number }>)[]
    readonly label?: string
    readonly durationMs?: number
  }[]
  /** 契约/payload 的 `schemaVersion`（`null` = 文件未声明）。 */
  readonly schemaVersion: number | null
  /** `multiblockCount`（契约 §2.3：必须 `=== 1`）。 */
  readonly multiblockCount: number
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
  /**
   * **内容承载规模**（诊断/证据面；#289 P10d）。
   *
   * ## 为什么它必须存在（而不是"调试时才打印"）
   *
   * 本批的核心断言是"几何/部件/说明**真的进了内核**"。而这件事在切换前
   * **恒为 0**（几何只在 `MultiblockContent.source` 的回显里，部件/说明根本不进内核）——
   * 于是"承载是否落地"需要一个**可机械读出的数字**，而不是靠读代码推断。
   *
   * 三个计数各自对应一个承载面：
   *  - `geometryAssets`：唯一几何资产数（0 = 该文档没有方块几何进了内核）；
   *  - `geometryEntries`：被逐格引用的资产数（> `geometryAssets` 即发生了**共享**）；
   *  - `contentCells`：带逐格内容（部件/说明）的格数。
   */
  readonly contentStats: AssemblyContentStats
}

/** 内容承载规模（见 {@link AssembledDocument.contentStats}）。 */
export interface AssemblyContentStats {
  readonly geometryAssets: number
  readonly geometryEntries: number
  readonly contentCells: number
}

// ─────────────────────────────────────────────────────────────────────────────
// 类型化映射表（**唯一**的旧→新字段对应点）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **元素级扩展键保真**：以**源节点**为底、类型化字段覆盖（typed 赢）。
 *
 * ## 本函数替代的旧机制（#301 P10f D2 修，登记 D10）
 *
 * 旧实现是 `const { raw, ...rest } = element; return {...rest}` —— 即
 * "**丢掉 `raw`，只留类型化字段**"。而下面的注释当时断言：
 *
 * > 元素的全部**有名字段**都已在类型化面上（`key`/`totalTier`/`values`/`runstate`…）
 *
 * **该断言实测为假**：解析器的 `parseVariant` 只把 `key`/`totalTier`/`values`/
 * `runstate` 提升为有名字段，而文件里**真实存在**的其它键只留在 `raw` 里。
 * 实测（三份多方块夹具）：
 *
 * | 元素 | 文件里存在、旧实现**丢掉**的键 |
 * |---|---|
 * | `variants[].height` | **432 / 108 / 12 条全部**（该夹具的语义就是"总 Tier 决定柱高"） |
 * | `runstates[].materialSwap` | 2 / 1 / 1 条 |
 * | `notes[].source` | 3 / 1 / 1 条 |
 * | `couplings[].{id,rawB,requires,source}` | （lsc）1 条 |
 * | `backbone.sizeSteps[].{channel,layers,w,hh,d,roles}` | 全部骨架阶 |
 *
 * ⇒ 旧实现让**保存一次就丢**这些字段（#171「能力不回退」的硬底线）。
 *
 * ## 为什么是"源为底、typed 覆盖"而不是"typed 为底、补扩展键"
 *
 * 后者的补法需要枚举"哪些键是扩展键"—— 那正是**第二份会漂移的清单**。
 * 前者不需要枚举：源节点里**除 `raw` 之外的每一个键**都在产物里，
 * 而类型化字段（解析器校验过的那些）**覆盖**同名键 ⇒
 * "编辑了内核内容但导出还是旧的"仍不可能（映射表判据 1）。
 *
 * ## 迭代幂等（`projectionFidelity` 的判据面）
 *
 * `raw` 自身的键被剥掉 ⇒ 往返**不嵌套**（旧的迭代增长缺陷的成因）；
 * 而扩展键在第二轮成为源节点的一部分、原样带出 ⇒ 第 2 轮起逐轮相同。
 */
function withExtensionKeys(
  source: Readonly<Record<string, unknown>>,
  typed: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const { raw: nested, ...rest } = source
  void nested
  return Object.freeze({ ...rest, ...typed })
}

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
  // **转发** `domain/cellPosition` 的实现（GF-7 的键格式唯一定义点，见那里的文件头）。
  // 本函数保留三名参数形态：它是 GF-7 的公开口径，既有调用点与测试都按它写。
  return cellPositionKey({ x, y, z })
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

/**
 * 旧 `Grid` → 内核 `blockGrid` 载荷的**全部内容**（#289 P10d）。
 *
 * ## 本函数替代什么
 *
 * P10c（#286）实测的缺口是「内核**只**承载 `name:meta` 字符串，
 * **新层没有方块几何的类型化落点**」。本函数就是那个落点：
 *
 * | 载荷字段 | 承载 | 来源 |
 * |---|---|---|
 * | `cells` | 逐格方块身份（GF-7 编码） | `Grid.forEach`（既有） |
 * | `geometry` | 几何资产目录（`assetId` → 资产） | `Grid._paletteCache` 的 `geometry`，**装配期**解码 |
 * | `cellGeometry` | 逐格 → `assetId` | `SlotBlock.paletteIndex` → 缓存条目 |
 * | `palette` | 类型化调色板条目（含呈现提示） | 同上 |
 * | `cellContent` | 逐格部件（+ 逐格说明，经 `tooltipContent`） | `Grid._cellParts` + 文档级叠加层 |
 *
 * ## 为什么几何是**网格级目录 + 逐格身份**（而不是逐格内联）
 *
 * 见 `domain/scene#ObjectDataPayload` 的 `geometry` 字段注释：逐格内联**不能共享**，
 * 而 A07「共享几何默认按对象独立编辑」的前提是先有共享。
 *
 * ## 逐格说明的合并（**同一键只出现一次，字段级合并**）
 *
 * 部件来自 `Grid`（逐格可得）、逐格说明来自文档级叠加层。两者可能命中同一格，
 * 故合并时以部件为底、说明覆盖 —— 而"缺席 ≠ 空"的语义逐字段保持
 * （`{...prev, ...value}` 只覆盖给出的字段）。
 */
export function gridPayload(
  grid: Grid,
  opts: {
    readonly tooltipContent?: Readonly<Record<string, CellContent>>
    readonly diag: (code: string, path: string, detail: string) => AssemblyDiagnostic
  },
): {
  readonly cells: Readonly<Record<string, string>>
  /**
   * **网格的声明尺寸**（#301 P10f D3，D-1）。
   *
   * ⚠️ **必须在这里抄下来**（本处曾是 D3 的一处真实缺陷：字段声明了、读面读了、
   * 纯函数判据绿了，而**装配从不填它** ⇒ 读面永远走"包围盒降级"路径）。
   * `Grid.width/height/depth` 正是**文件 `cellGrid` 的三个维度**
   *（`RuntimeDocument._fromV2CellGrid` 用 `cellGrid.length`/`[0].length`/`[0][0].length`
   * 构造 Grid）⇒ 抄它就是"把文件声明的事实带进内核"。
   *
   * 不抄的后果（L3 实测，`multiblock-frame-regression.spec.ts`）：稀疏网格的
   * 尾层/尾列被挖空时，包围盒推得的 `d/h/w` **小于**声明值 ⇒
   * `Context#kernelGrid` 给出偏小的 `height` ⇒ `structureRowToWorldY` 的拾取 Y 偏移。
   */
  readonly sizeColumn: number
  readonly sizeRow: number
  readonly sizeZSlice: number
  readonly geometry: Readonly<Record<string, BlockGeometryAsset>>
  readonly cellGeometry: Readonly<Record<string, string>>
  readonly cellPalette: Readonly<Record<string, string>>
  /** 逐格 → 文件槽位（legacy `paletteIndex`；#301 P10f D3 承载 —— 见 `domain/scene`）。 */
  readonly cellPaletteIndex: Readonly<Record<string, number>>
  readonly palette: readonly BlockPaletteEntry[]
  readonly cellContent: CellContentTable
  readonly assembled: AssembledPalette
} {
  const cells: Record<string, string> = {}
  grid.forEach((pos, block) => {
    cells[blockCellKey(pos.x, pos.y, pos.z)] = blockCellValue(block)
  })

  const assembled = assemblePaletteContent(grid, opts.diag)
  const tooltips = opts.tooltipContent ?? {}
  const content: Record<string, CellContent> = { ...assembled.cellContent }
  for (const [key, value] of Object.entries(tooltips)) {
    const prev = content[key]
    content[key] = prev === undefined ? value : Object.freeze({ ...prev, ...value })
  }

  return {
    cells: Object.freeze(cells),
    // 声明尺寸 = 旧 `Grid` 的维度 = **文件 `cellGrid` 的维度**（见返回类型上的长注释）。
    sizeColumn: grid.width,
    sizeRow: grid.height,
    sizeZSlice: grid.depth,
    geometry: assembled.assets,
    cellGeometry: assembled.cellGeometry,
    cellPalette: assembled.cellPalette,
    cellPaletteIndex: assembled.cellPaletteIndex,
    palette: assembled.palette,
    cellContent: normalizeCellContent(content),
    assembled,
  }
}

/**
 * 并集调色板（契约 §6「并集（根级唯一一份）」）。
 *
 * ## 为什么不能直接用逐格投影出的那张
 *
 * 声明的 `backbone.sizeSteps[].cellGrid` 用**并集调色板下标**，而逐格投影只发出
 * "实际被格引用"的条目 —— 两者**不必相同**（某阶骨架里出现的方块可能不在
 * 当前取值装配出的网格里）。用逐格那张会让骨架阶的下标指向越界。
 *
 * ## 来源与判据
 *
 * 优先取装配器读到的并集调色板（`doc.multiblock.blockPalette` 的缓存条目 ——
 * `context/multiblock/palette#buildPalette` 的 `entries` 就是并集），
 * 逐条**解码几何**成类型化条目。逐格那张仅作**补充**（把装配新增、并集里没有的
 * 条目并进来 —— 那不该发生，但发生时不静默丢）。
 *
 * 顺序 = 并集顺序（下标即身份，故**不排序**）：排序会让 `sizeSteps[].cellGrid`
 * 里的下标全部指错方块。这条与 `normalizePalette` 的排序口径**不冲突**：
 * 那个函数服务的是"按内容去重的呈现清单"，本函数服务的是"下标敏感的声明调色板"。
 */
function unionPaletteOf(doc: RuntimeDocument, cellPalette: readonly BlockPaletteEntry[]): readonly BlockPaletteEntry[] {
  const union = doc.multiblock?.blockPalette
  if (!Array.isArray(union) || union.length === 0) return cellPalette
  const out: BlockPaletteEntry[] = []
  for (let i = 0; i < union.length; i++) {
    const raw = union[i]
    if (raw === null || typeof raw !== 'object') {
      out.push(airLikeEntry())
      continue
    }
    const entry = raw as Record<string, unknown>
    const registryId = typeof entry.registryId === 'string' ? entry.registryId : 'air'
    const meta = typeof entry.meta === 'number' ? entry.meta : 0
    const dec = decodeBlockGeometry(entry.geometry as never)
    const asset = dec === null ? null : blockGeometryAsset(dec.quads)
    const typed: {
      assetId: string
      registryId: string
      meta: number
      renderMode: string
      geometry: BlockGeometryAsset | null
      occludesAdjacentFaces?: boolean
      facing?: BlockPaletteEntry['facing']
      nbt?: Readonly<Record<string, unknown>>
      thumbnail?: string
      tooltip?: readonly string[]
    } = {
      assetId: asset?.id ?? '',
      registryId,
      meta,
      renderMode: typeof entry.renderMode === 'string' ? entry.renderMode : 'BakedModel',
      geometry: asset,
    }
    if (typeof entry.occludesAdjacentFaces === 'boolean') typed.occludesAdjacentFaces = entry.occludesAdjacentFaces
    if (typeof entry.facing === 'string') typed.facing = entry.facing as BlockPaletteEntry['facing']
    if (entry.nbt !== undefined && entry.nbt !== null && typeof entry.nbt === 'object') typed.nbt = entry.nbt as Readonly<Record<string, unknown>>
    if (typeof entry.thumbnailPNG === 'string') typed.thumbnail = entry.thumbnailPNG
    if (Array.isArray(entry.tooltip)) typed.tooltip = Object.freeze(entry.tooltip.filter((x): x is string => typeof x === 'string'))
    out.push(Object.freeze(typed))
  }
  // 补充：逐格那张里有、并集里没有的条目（按 `(registryId, meta, assetId)` 判缺）。
  const seen = new Set(out.map((e) => `${e.registryId}\u0000${e.meta}\u0000${e.assetId}`))
  for (const e of cellPalette) {
    const k = `${e.registryId}\u0000${e.meta}\u0000${e.assetId}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(e)
  }
  return Object.freeze(out)
}

function airLikeEntry(): BlockPaletteEntry {
  return Object.freeze({ assetId: '', registryId: 'air', meta: 0, renderMode: 'BlockModel', geometry: null })
}

/**
 * 装配产物 → `blockGrid` 载荷（**唯一**的载荷构造点）。
 *
 * 抽成一个函数而不是在两处各拼一遍：帧为主与多方块两条路径的载荷**必须**同形
 * （否则 `projectKernelDocument` 要按形态分支读不同字段 —— 那就是两份判据）。
 *
 * ## 「缺省即无」的字段不写成空对象
 *
 * `geometry`/`cellGeometry`/`cellContent` 在**无内容**时不写入字段
 * （而不是写 `{}`）—— 使"这份网格没有几何资产"与"这份网格有几何资产但目录为空"
 * 可区分（与 `domain/cellContent` 判据 3 同一口径）。空几何与无几何是**两种能力状态**：
 * 前者是缺陷，后者是"几何由生产按身份现算"的正常路径。
 */
function blockGridPayload(payload: {
  readonly cells: Readonly<Record<string, string>>
  readonly sizeColumn: number
  readonly sizeRow: number
  readonly sizeZSlice: number
  readonly geometry: Readonly<Record<string, BlockGeometryAsset>>
  readonly cellGeometry: Readonly<Record<string, string>>
  readonly cellPalette: Readonly<Record<string, string>>
  readonly cellPaletteIndex: Readonly<Record<string, number>>
  readonly palette: readonly BlockPaletteEntry[]
  readonly cellContent: CellContentTable
}): ObjectDataPayload {
  const out: {
    kind: 'blockGrid'
    cells: Readonly<Record<string, string>>
    sizeColumn?: number
    sizeRow?: number
    sizeZSlice?: number
    cellContent?: CellContentTable
    geometry?: Readonly<Record<string, BlockGeometryAsset>>
    cellGeometry?: Readonly<Record<string, string>>
    cellPalette?: Readonly<Record<string, string>>
    cellPaletteIndex?: Readonly<Record<string, number>>
    palette?: readonly BlockPaletteEntry[]
  } = { kind: 'blockGrid', cells: payload.cells }
  // 声明尺寸**无条件**写出（`>= 0` 都是合法声明；"0 宽的网格"是真实状态，
  // 而"字段缺席"会让读面降级去猜 —— 两者必须可区分，见 `runtime/gridRead#resolveGridSize`）。
  out.sizeColumn = payload.sizeColumn
  out.sizeRow = payload.sizeRow
  out.sizeZSlice = payload.sizeZSlice
  if (Object.keys(payload.cellContent).length > 0) out.cellContent = payload.cellContent
  if (Object.keys(payload.geometry).length > 0) out.geometry = payload.geometry
  if (Object.keys(payload.cellGeometry).length > 0) out.cellGeometry = payload.cellGeometry
  if (Object.keys(payload.cellPalette).length > 0) out.cellPalette = payload.cellPalette
  // 文件槽位（legacy `paletteIndex`）：**独立于** `cellPalette` 的存在性判断 ——
  // 它是另一件事实（"在文件的 `blockPalette` 里排第几"），只是恰好与它同条件记录。
  if (Object.keys(payload.cellPaletteIndex).length > 0) {
    out.cellPaletteIndex = payload.cellPaletteIndex
  }
  // 调色板**不排序**：它的顺序是**文件的下标分区**（渲染侧同调色板剔除按条目判），
  // 排序会让"哪个格子用哪个条目"的对应关系失效。去重与顺序都由
  // `kernelPaletteAssembly` 按源顺序给出。
  if (payload.palette.length > 0) out.palette = payload.palette
  return Object.freeze(out)
}

/**
 * 装配一份**逐格说明叠加层**（文档级字段 → 内核逐格内容）。
 *
 * 帧为主文档的说明在文档根；多方块文档的说明在内层 body 的根
 * （`context/parsers/multiblockDocument.ts` 的 `tooltipPalette`）。
 * 两条路径最终都把 `tooltipPalette`/`cellTooltipGrid` 挂到 `RuntimeDocument`
 * 的**根级**字段上（`builtinParsers.ts:101-104` 的 #82 修复），故装配层只读一处。
 *
 * 行数取 `grid.height` 而**不是** `cellTooltipGrid.length`：说明网格与 `cellGrid`
 * 同形，按它自己的长度翻转会让"网格被截断"的文档里说明整体错位一行。
 */
function tooltipContentOf(doc: RuntimeDocument, grid: Grid): Readonly<Record<string, CellContent>> {
  return assembleTooltipContent({
    cellTooltipGrid: doc.cellTooltipGrid as readonly (readonly (readonly number[])[])[] | undefined,
    tooltipPalette: doc.tooltipPalette as readonly unknown[] | undefined,
    sizeRow: grid.height,
  })
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
  // ── 声明版本（R1-β① C5）──────────────────────────────────────────────────
  //
  // `format_version` 与 `gtnhVersion` 是**源文件声明**的两项版本元数据。
  // 它们原先由 `Context#documentMetadata` 恒取旧文档（`doc.formatVersion` /
  // 序列化根），理由记在 `legacy-render-source-document`。C5 按 #385 评论 7140
  // 把它移进内核元数据：产品需要它们（属性面板的"格式版本"、嵌入元信息提示的
  // "版本号"），而"文档声明的版本"本就属文档元数据这一业务职责。
  //
  // 缺省与旧解析器**逐字相同**：`format_version` 缺席 ⇒ `'2.0'`
  //（`context/runtimeDocument.ts:534` 的 `?? '2.0'`）；`gtnhVersion` 缺席 ⇒ `''`。
  const formatVersion = (root === undefined ? '' : readString(root.format_version)) || '2.0'
  const gtnhVersion =
    (root === undefined ? '' : readString(root.gtnhVersion)) || readString(meta.gtnhVersion)
  return documentMetadata({
    name,
    author,
    description,
    tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [],
    origin:
      origin && typeof origin === 'object'
        ? { x: readNumber(origin.x) ?? 0, y: readNumber(origin.y) ?? 0, z: readNumber(origin.z) ?? 0 }
        : { x: 0, y: 0, z: 0 },
    createdAtMs: declaredCreatedAtMs(meta, root),
    formatVersion,
    gtnhVersion,
  })
}

/**
 * `createdAtMs` 必须来自**源声明**，不得来自旧解析器的**伪造值**。
 *
 * ## 本批（#289 P10d D1）实测抓出的真实缺陷
 *
 * `RuntimeDocument.fromV2Plain` 在 `raw.meta` 缺席时**伪造**一份 meta，其中含
 * `created_at_ms: Date.now()`（`context/runtimeDocument.ts:389`）。而信封类文档的
 * `meta` 被解包器**摊平到 plain 根**（见 `metadataFromLegacy` 的说明），
 * 于是"文件没声明创建时间"变成"刚刚创建"。
 *
 * 后果不是显示问题，而是**装配不确定**：同一份文件两次装配得到**不同的内核内容**
 * （`documentMetadata` 进 `contentOf` 的内容身份）⇒ "同一份文件 ⇒ 同一份内容身份"
 * 这条不变量被破坏，缓存/脏标记/保真往返都建立在一个会变的数字上。
 *
 * 实测（`multiblock-tier-only`，文件里确实没有 `created_at_ms`）：
 * 两次 `assembleKernelDocument` 的 `content.metadata.createdAtMs` 相差数毫秒，
 * `contentOf(...)` 的内容版本**不相等**。
 *
 * ## 判据：**读源，不读伪造值**
 *
 *  - 有 `root`（无损源）：按源的**两种形态**取 —— 嵌套 `root.meta.created_at_ms`
 *    （Plain 文档）或根级 `root.created_at_ms`（信封 meta 摊平后的落点）；
 *    两处都没有 ⇒ `null`（文件**没有声明**，如实缺席）。
 *  - 无 `root`（直接调用/无无损源的降级路径）：只能用 `meta.created_at_ms`，
 *    它**可能**是伪造值 —— 这条降级由函数文档如实标注，不假装可靠。
 *
 * 刻意**不**在 `context/runtimeDocument.ts` 处修：那一层是**旧解析器**，
 * 改它会影响所有旧路径消费者（含 e2e 判据面），而本批的职责边界是装配层
 * 忠实读取"文件声明了什么"。伪造值仍在旧文档里（它的既有行为），
 * 但**不再进内核内容身份**。
 */
function declaredCreatedAtMs(
  meta: Readonly<Record<string, unknown>>,
  root: Readonly<Record<string, unknown>> | undefined,
): number | null {
  if (root === undefined) {
    // 无无损源：如实降级（该值可能是旧解析器的伪造值，见上）。
    return readNumber(meta.created_at_ms) ?? null
  }
  const nested = root.meta
  const nestedValue =
    nested !== null && typeof nested === 'object' && !Array.isArray(nested)
      ? readNumber((nested as Record<string, unknown>).created_at_ms)
      : undefined
  return nestedValue ?? readNumber(root.created_at_ms) ?? null
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
 * ⇒ 本函数把它装配成一个 `camera` 对象，**只**给出 `kind:'camera'`：
 * `payload` 的四个投影字段（`projection`/`fov`/`clipStart`/`clipEnd`）**一律省略**
 * —— 文件里**没有**声明任何投影参数，缺省即"未声明"（`domain/scene` 的相机载荷字段
 * 已按 **GF-21 乙** 可选化）。观察视角本体（`target`/`yawDeg`/…）仍放在**非类型化**的
 * `view`（`Readonly<Record<string, unknown>>`，见本函数返回类型与 `:1271` 的赋值）
 * —— 给它**类型化落点**是 GF-21 甲，**未**在本批兑现。
 *
 * ⚠️ **历史（GF-21，#385 评论 7025）**：本函数曾硬编码填 `projection:'perspective'`/
 * `fov:50`/`clipStart:0.1`/`clipEnd:1000`，而 `application/queries` 的相机读面把这些
 * 常量当**真实相机参数**交出 ⇒ "已被内核承载"看起来成立，实际是伪造。R1-β① C3
 * 按**乙**处置：删掉四个常量、改为省略；读面（`CameraProjection`）随之为可选字段，
 * **无声明值即缺席**，不再冒充。
 *
 * ⚠️ **更正（2026-10-13，调度者实读本函数全函数后改）**：本段原写的是
 * 「**不**伪造一个 `perspective/fov` 去冒充它」——**那与当时的代码相反，事实是确实伪造了**。
 * 缺口的真实大小因此被掩盖：观察视角至今**没有类型化落点**（这才是 GF-5 的原文）。
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
        // GF-21 乙：投影字段**省略**（文件里没有声明值）——不填任何常量。
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
 * 旧注解条目 → 内核**呈现几何参数**（#289 P10d；P10c 实测缺口的补点）。
 *
 * ## 本函数替代什么
 *
 * P10c（#286）实测：注入完整 box 注解 ⇒ 内核 payload 只剩
 * `{"kind":"annotation","shape":"box","text":"T\n\nD"}` —— **几何字段全丢**，
 * 于是内核通道下的注解渲染不出任何几何（`render/mesh/annotationMeshProvider`
 * 读 `min`/`max`/`renderStyle`/`color`/`frameThickness`/`overlay`/… 全部缺席）。
 *
 * ## 为什么逐字段**显式**搬运，而不是把整个旧对象塞进去
 *
 * 旧注解对象是 `Record<string, unknown>`（`RuntimeDocument.annotations: unknown[]`），
 * 直接塞进去就是 #249 §15 第 2 条要退役的"核心无 raw JSON/格式字段袋"。
 * ⇒ 本函数列一份**封闭字段清单**，只搬它认识的键（未知键由调用方进保真记录，
 * 与顶层字段同一处置）。
 *
 * ## 坐标**原样**搬运（不翻转、不居中）
 *
 * 旧注解的坐标系**按 shape 不同**（实测，`render/data/annotationTypes.ts` 的
 * `annotationIsOnLayer` 逐条注释）：
 *  - `box` 用**居中**坐标（`min.y + gridHeight/2` 才还原到世界 Y）；
 *  - `point`/`text` 用"格心世界"（`wy - h/2 + 0.5`）；
 *  - `line`/`face` 直接是 **RAW Y-up 世界坐标**。
 *
 * 三种坐标系混在同一个类型里是**既有的**形态事实。本批的目标是"几何字段别丢"
 * （否则切换渲染链注解全消失），而**不是**顺手统一坐标系 —— 那需要改动
 * `annotationMeshProvider` 的读法，属"重构渲染语义"，与「能力不回退 + 逐像素一致」
 * 的硬约束冲突。⇒ 原样搬运：**投影时逐字段写回**，于是往返无损、渲染零变化。
 * 该口径差异**如实登记为遗留缺口**（见汇报：注解坐标系三态待统一）。
 *
 * 未给出任何几何字段时返回 `null`（**不**写一个空对象：使"无几何参数"与
 * "有几何参数但全缺省"可区分）。
 */
export function annotationGeometryFromLegacy(a: Readonly<Record<string, unknown>>): AnnotationGeometry | null {
  const out: Record<string, unknown> = {}
  const vec = (v: unknown): { x: number; y: number; z: number } | undefined => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined
    const o = v as Record<string, unknown>
    const x = readNumber(o.x)
    const y = readNumber(o.y)
    const z = readNumber(o.z)
    return x === null || y === null || z === null ? undefined : { x, y, z }
  }
  const putVec = (key: string, v: unknown): void => {
    const p = vec(v)
    if (p !== undefined) out[key] = Object.freeze(p)
  }

  putVec('min', a.min)
  putVec('max', a.max)
  putVec('pos', a.pos)
  putVec('anchorPos', a.anchorPos)
  putVec('blockPos', a.blockPos)
  // `text` 注解的锚点字段名是 `anchorPos`，内核统一叫 `pos`（呈现层按 shape 读一个名字）。
  // 转换是**显式**的一处：不转换会让 text 注解的锚点静默丢失。
  if (out.pos === undefined && out.anchorPos !== undefined) {
    out.pos = out.anchorPos
    delete out.anchorPos
  }
  if (Array.isArray(a.points)) {
    const pts: { x: number; y: number; z: number }[] = []
    for (const p of a.points) {
      const v = vec(p)
      if (v !== undefined) pts.push(Object.freeze(v))
    }
    if (pts.length > 0) out.points = Object.freeze(pts)
  }
  const num = (key: string, src: unknown): void => {
    const n = readNumber(src)
    if (n !== null) out[key] = n
  }
  num('quadIndex', a.quadIndex)
  num('renderOpacity', a.renderOpacity)
  num('fillOpacity', a.fillOpacity)
  num('frameThickness', a.frameThickness)
  num('size', a.size)
  num('thickness', a.thickness)
  num('fontSize', a.fontSize)
  num('backgroundAlpha', a.backgroundAlpha)
  num('frameIndex', a.frameIndex)
  num('createdAt', a.created_at)
  num('updatedAt', a.updated_at)
  for (const key of ['color', 'renderStyle', 'icon', 'arrow', 'linkedAnnotationId'] as const) {
    if (typeof a[key] === 'string' && (a[key] as string) !== '') out[key] = a[key]
  }
  for (const key of ['overlay', 'locked', 'showPoints'] as const) {
    if (typeof a[key] === 'boolean') out[key] = a[key]
  }
  if (Object.keys(out).length === 0) return null
  return Object.freeze(out) as AnnotationGeometry
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
    // 合成规则：唯一实现在 `domain/scene#annotationTextOf`（R1-β① C3 把原先的
    // 内联副本收敛过去 —— 写面要用它的逆向，两处各写一份必然漂移）。
    const text = annotationTextOf(title, description)
    const geometry = annotationGeometryFromLegacy(a)
    const init: { kind: 'annotation'; shape: 'box' | 'point' | 'line' | 'text' | 'face'; text?: string; geometry?: AnnotationGeometry } = {
      kind: 'annotation',
      shape: shape as 'box' | 'point' | 'line' | 'text' | 'face',
    }
    if (text !== undefined) init.text = text
    if (geometry !== null) init.geometry = geometry
    const payload: ObjectDataPayload = Object.freeze(init)
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
        contentStats: EMPTY_CONTENT_STATS,
      }),
    )
  }

  const diagnostics: AssemblyDiagnostic[] = []
  let scene = emptyScene(sceneId)
  /** 几何资产身份集合（跨帧去重：两个帧对象共享同一份几何时只算一份）。 */
  const assetIds = new Set<string>()
  /** 逐格几何引用的总次数（> `assetIds.size` 即发生了共享）。 */
  let geometryEntryRefs = 0
  /** 带逐格内容的格数（跨帧累计）。 */
  let contentCellCount = 0

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
    // #289 P10d：帧网格也走**同一个** `gridPayload` —— 于是"帧为主 vs 多方块"
    // 的几何承载方式在结构上只有一处实现（不存在两条路径漂移的余地）。
    const payload = gridPayload(grid, {
      tooltipContent: tooltipContentOf(doc, grid),
      diag: diagnosticSink,
    })
    diagnostics.push(...payload.assembled.diagnostics)
    accumulateContentStats(payload, assetIds, (n) => { geometryEntryRefs += n }, (n) => { contentCellCount += n })
    const next = withObject(
      scene,
      sceneObject({ id: objectId, type: 'block', name: frame.label ?? objectId, dataId }),
      objectData(dataId, blockGridPayload(payload), 'document'),
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
  //
  // ## 多方块声明进**内容权威**（R2-1a 第 4 件）
  //
  // 值来自**类型化适配器**（`adapters/files/multiblockDeclaration`）对真实解析结果的输出——
  // 不是把旧载体（`RuntimeDocument.multiblock`，解析侧形状）换个存放位置：适配器把它转成
  // **内核承载**（`decl` 摊平、去 `raw`、逐层冻结、调色板保序）。契约 §3.3 要求
  // 「多方块声明作为**只读内容定义**，由类型化解析适配接入」，这里就是那个接入点。
  //
  // 为什么放在 ⑦ 而 ⑧ 才用装配面：⑧ 的 `multiblock`（`MultiblockContent`）是**投影面**
  // （读解析侧的 Map/`cellGrid`），与内容权威是**两个不同的输出**；本处只补内容权威这一半。
  const content = documentContent({
    metadata: metadataFromLegacy(doc.meta, raw),
    frameAxis: frameAxisFromLegacy(doc.frames),
    resources: normalizeResources(res.resources),
    multiblock: multiblockDeclarationContentOf(doc.multiblock),
  })

  // ── ⑧ 多方块：只读内容定义 + 装配网格 ──
  let multiblock: MultiblockContent | null = null
  if (doc.isMultiblock) {
    const decl = doc.multiblock?.decl ?? null
    const source = doc.multiblockSource
    if (decl !== null && source !== null) {
      const selection = input.multiblockSelection ?? initialSelection(doc)
      const outcome = tryAssembleSelection(source, selection)
      if (outcome === null) {
        diagnostics.push(
          diagnostic('multiblockAssemblyFailed', '$.multiblock', '多方块装配未产出结果（见 selection 与声明）'),
        )
      } else {
        const objectId = 'structure:multiblock'
        const dataId = `${objectId}:data`
        const payload = gridPayload(outcome.grid, {
          tooltipContent: tooltipContentOf(doc, outcome.grid),
          diag: diagnosticSink,
        })
        diagnostics.push(...payload.assembled.diagnostics)
        multiblock = Object.freeze({
          id: decl.id,
          displayName: decl.displayName,
          channels: Object.freeze([...decl.channels]),
          runstates: Object.freeze([...decl.runstates]),
          variants: Object.freeze([...decl.variants]),
          totalTierDomain: decl.totalTierDomain,
          declRaw: declRawOf(source),
          // 投影面：**并集**调色板（不是逐格投影出的那张）。
          //
          // 为什么必须是并集：声明的 `backbone.sizeSteps[].cellGrid` 用的是
          // **并集调色板下标**（契约 §6「并集（根级唯一一份）」），而逐格投影
          // 只发出"实际被格引用"的条目。用逐格那张会让骨架阶的下标越界
          // （`buildPalette` 的 `slots[i]` 变 null ⇒ 装配出的骨架缺方块）。
          projection: Object.freeze({
            declaration: typedDeclarationOf(decl),
            blockPalette: unionPaletteOf(doc, payload.palette),
            assets: payload.geometry,
            frames: (doc.multiblock?.frames ?? []).map((f) => {
              const frame: {
                index: number
                variant: string
                runstate: string
                stepIndex: number
                rules: readonly (string | Readonly<{ id: string; order?: number }>)[]
                label?: string
                durationMs?: number
              } = {
                index: f.index,
                variant: f.variant,
                runstate: f.runstate,
                stepIndex: f.stepIndex,
                rules: f.rules.map((r) => (typeof r === 'string' ? r : r.order === undefined ? { id: r.id } : { id: r.id, order: r.order })),
              }
              if (f.label !== undefined) frame.label = f.label
              if (f.durationMs !== undefined) frame.durationMs = f.durationMs
              return Object.freeze(frame)
            }),
            schemaVersion: typeof doc.multiblock?.schemaVersion === 'number' ? doc.multiblock.schemaVersion : null,
            multiblockCount: 1,
          }),
        })
        const next = withObject(
          scene,
          sceneObject({ id: objectId, type: 'block', name: multiblock.displayName || objectId, dataId }),
          objectData(dataId, blockGridPayload(payload), 'content'),
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
      contentStats: Object.freeze({
        geometryAssets: assetIds.size,
        geometryEntries: geometryEntryRefs,
        contentCells: contentCellCount,
      }),
    }),
  )
}

/** 空内容规模（空文档路径；显式零而不是"没算"）。 */
const EMPTY_CONTENT_STATS: AssemblyContentStats = Object.freeze({ geometryAssets: 0, geometryEntries: 0, contentCells: 0 })

/**
 * 累计一次网格装配的内容规模（供 {@link AssembledDocument.contentStats}）。
 *
 * `assetIds` 由调用方跨帧持有（**跨帧去重**）：两个帧对象引用同一份几何时只算一份资产 ——
 * 这正是"共享"在统计上的含义（`geometryEntries > geometryAssets` 即发生了共享）。
 */
function accumulateContentStats(
  payload: {
    readonly geometry: Readonly<Record<string, BlockGeometryAsset>>
    readonly cellGeometry: Readonly<Record<string, string>>
    readonly cellContent: CellContentTable
  },
  assetIds: Set<string>,
  addEntries: (n: number) => void,
  addCells: (n: number) => void,
): void {
  for (const id of Object.keys(payload.geometry)) assetIds.add(id)
  addEntries(Object.keys(payload.cellGeometry).length)
  addCells(Object.keys(payload.cellContent).length)
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
