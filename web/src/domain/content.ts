/**
 * `domain/content` —— **文档内容的类型化承载**。
 *
 * ## 本模块解决什么（它替代的旧机制）
 *
 * 实测结论：内核 `Document` 只承载 `scene`（对象/对象数据）与 `animation`
 * （轨道），而旧 `RuntimeDocument` 还承载 `meta` / `frames` / `textureBlobs` /
 * `materialPalette` / `multiblock` —— 于是**没有任何生产代码能把一份旧场景文件装配成
 * 内核 `Scene`**，`presentationAdapter.structurePrimitive` 零调用者。
 *
 * 契约对 `Document` 的定义是**四项**：
 *
 * > 「`Document` 是独立保存与撤销的内容单元，包含**场景、对象、对象数据、动画及资源引用**。」
 *
 * 其中「场景/对象/对象数据」由 `domain/scene` 承载、「动画」由 `domain/animation` 承载
 * （轨道 + 发布默认值），**「资源引用」当时没有类型化落点** —— 本模块补上它，
 * 并同时补上两条契约明文要求但同样缺失的类型化内容：
 *
 * | 本模块的类型 | 替代旧形态 | 依据 |
 * |---|---|---|
 * | {@link ContentResource} | `RuntimeDocument.textureBlobs` + `materialPalette`（两个 `unknown[]`） | 「资源引用」；「资源引用包含稳定资源 ID 和内容版本/哈希，URL 仅为获取位置」 |
 * | {@link DocumentMetadata} | `RuntimeDocument.meta`（`Record<string, unknown>` 字段袋） | 「核心无 raw JSON/格式字段袋」 |
 * | {@link FrameAxis} | `RuntimeDocument.frames[].durationMs`（散在帧对象上） | 「保存字段使用类型化结构，不以 `unknown[]` 或无界字段袋替代模型设计」 |
 * | {@link DocumentContent.multiblock} | `RuntimeDocument.multiblock`（`context/parsers/multiblockDocument.ts` 的解析类型） | 「多方块声明作为**只读内容定义**，由类型化解析适配接入」；形状复用 `domain/multiblockDocument#MultiblockDeclaration` |
 *
 * ## 三条设计判据（各自对应一个会被静默违反的约束）
 *
 * ### 1. 「资源引用」不是「资源字节」：`locator` 不参与身份
 *
 * 契约原文：「资源引用包含稳定资源 ID 和内容版本/哈希，**URL 仅为获取位置**」。
 * 故 {@link ContentResource} 的三元组里 `contentVersion` 参与内容身份、`locator` 不参与。
 * 这与 `adapters/files/projectFormat` 的 `ProjectAssetRef` 是**同一判据的两个落点**
 * （工程清单 vs 文档内容），不是两份实现：两者都只让 `(assetId, contentVersion)` 进身份。
 *
 * `payload` 是**内嵌字节**（Base64），它是旧产物把纹理内嵌在文档里的形态。它进身份
 * （字节变了内容就变了），但它**不**决定获取位置 —— 从内嵌切到外链时
 * `assetId`/`contentVersion` 不变 ⇒ 文档内容身份不变（这正是「URL 仅为获取位置」）。
 *
 * ### 2. 帧**时长轴**是文档声明，不是播放状态
 *
 * 旧形态把「每帧停留多久」写在 `RuntimeFrame.durationMs` 上，而播放调度器
 * （`drwMeshPipeline` 的 `setTimeout` 自续，已删除）按它自推帧下标。
 * 现在帧下标由 `EditContext.time` 经离散阶跃采样**派生**，于是 `durationMs` 唯一
 * 剩下的语义是「时间 → 帧」这条映射的**轴**（`KernelSession.frameIndex()` 的输入）。
 *
 * ⇒ 它归**文档内容**（所有权表「文档内容…随打开文档存活」），进内容身份：
 * 改一帧的时长 = 改了文档内容（可撤销、会变脏）。而**播放**（推进时间）只改
 * `EditContext.time`，**不**碰这里 —— 与 `domain/document` 对动画的同一处置。
 *
 * ### 3. 元数据是**具名字段**，不是字段袋
 *
 * `DocumentMetadata` 的每个字段都是具名的、有类型的。旧 `meta` 是
 * `Record<string, unknown>`：任何键都能进，于是「这份文件到底声明了什么」无法由类型回答，
 * 且未知键会**静默随文档往返**（要消除的正是这个形态）。
 *
 * 旧文件里 `meta` 的**未知键**走 `adapters/files/fidelityRecord`（带源格式/源版本的保真记录），
 * 而**已知键**在这里被类型化 —— 这个边界是刻意的：把已知键也塞进保真记录，会让
 * 「哪些字段真的没人懂」永远查不出来（见 `fidelityRecord` 文件头的同一判据）。
 *
 * ## 纯度
 *
 * 无 IO、无 DOM、无时钟、不 import 任何旧层（`domain/` 是纯核心）。
 */

import { digestOf } from './identity'
import { EMPTY_MULTIBLOCK_DECLARATION, type MultiblockDeclaration } from './multiblockDocument'
import { resourceCacheKey, type ResourceRef } from './materials'
import type { Vec3 } from './scene'

// ─────────────────────────────────────────────────────────────────────────────
// 资源引用（「资源引用」）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 混合模式（呈现契约的一部分）。
 *
 * 刻意**不** import `pure/materialTypes` 的 `MaterialBlendMode`：`pure/` 是旧层，
 * `domain/` 不得依赖它（`kernel-legacy-isolation` 闸门）。
 * 这个联合只有三个成员且是呈现契约的一部分，就地声明是**唯一来源**而不是重复。
 */
export type ResourceBlendMode = 'opaque' | 'cutout' | 'translucent'

/** 材质种类：`static16` = 单帧贴图；`animated` = 竖条多帧（按顺序播放）。 */
export type ResourceKind = 'static16' | 'animated'

/**
 * 纹理动画声明（对齐 Java `.mcmeta` 的 `animation` 段；数据来自 JSON）。
 *
 * 这里只有**声明**：`domain/materials` 的 `parseTextureSequence` 把它翻译成
 * 可采样的 `TextureSequence`，采样规则（半开区间/循环/钳制）在那里。
 * 本类型不定义任何播放语义 —— 「怎么播」是采样策略，不是文档内容。
 */
export interface TextureAnimationSpec {
  readonly defaultFrametimeTicks?: number
  readonly frameSequence?: readonly Readonly<{ index: number; timeTicks?: number }>[]
  readonly interpolate?: boolean
}

/**
 * 一条**资源引用**（文档内容的一部分）。
 *
 * ## 为什么身份部分**内嵌** `domain/materials#ResourceRef` 而不是重列三个字段
 *
 * 身份规则（「资源引用包含稳定资源 ID 和内容版本/哈希，**URL 仅为获取位置**」）
 * 已经有唯一权威：`domain/materials` 的 `ResourceRef` + `resourceCacheKey` +
 * `sameResourceContent`（同一内容判定的落点在那里）。
 *
 * 若本类型再列一遍 `assetId`/`contentVersion`/`locator`，就出现**两个**形状在
 * 各自声明同一条规则 —— 而 `ResourceRef` 的注释里逐字写明了为什么 URL 不能进缓存键。
 * 两处声明必然漂移，且漂移的后果正是判红的形态（按 URL 缓存）。
 * ⇒ 内嵌使「缓存键/同一内容判定」直接可用（`resourceCacheKey(content.ref)`），
 * 零适配、零第二份定义。
 *
 * ## 与 `ResourceRef` 的分工
 *
 * | 类型 | 回答什么 | 用在哪 |
 * |---|---|---|
 * | `ResourceRef` | 「去**哪**取、取到的是**哪一版**」 | 运行期资源状态机（`domain/materials` 的 `ResourceState`） |
 * | `ContentResource` | 「文档**声明**了什么资源、它长什么样」 | 文档内容（本字段）；呈现/导出读它 |
 *
 * 文档内容里**必须有**后者：旧产物把纹理字节与材质声明内嵌在文档里
 * （`textureBlobs` + `materialPalette`），故「文档声明」比「取回引用」多出
 * 字节、混合模式、动画声明等呈现事实。
 */
export interface ContentResource {
  /** 身份与取回引用（`assetId` / `contentVersion` / `url`；见 `domain/materials`）。 */
  readonly ref: ResourceRef
  readonly kind: ResourceKind
  /** 内嵌字节（Base64 PNG）。`null` = 外链资源（按 `ref.url` 取回）。 */
  readonly payload: string | null
  readonly blend: ResourceBlendMode | null
  readonly emissive: number | null
  readonly animation: TextureAnimationSpec | null
  /** 图集归属（`blocks` / `items` / `null`）；呈现提示，不参与身份。 */
  readonly atlas: string | null
  readonly linear: boolean | null
  readonly useMipmaps: boolean | null
}

/**
 * 造一条资源引用：`contentVersion` 由 `payload` **机械派生**。
 *
 * 为什么不由调用方传版本：调用方传就有传错的可能（改了字节却写旧版本），
 * 而后果是**静默复用旧 GPU 资源**（「旧资源不覆盖新版本」的反面）。
 * 派生使「字节变了版本必变」成为结构事实。
 *
 * 外链资源（`payload === null`）没有字节可摘要，故版本**必须**由调用方给出
 * （`url` 指向的内容版本由获取方保证）—— 此时 `payload` 为 `null` 是一个
 * **显式**事实，不是「忘了传字节」。
 */
export function contentResource(init: {
  assetId: string
  locator: string
  kind?: ResourceKind
  payload?: string | null
  /** 外链资源必填；内嵌资源给了也会被字节摘要覆盖（见上）。 */
  contentVersion?: string
  blend?: ResourceBlendMode | null
  emissive?: number | null
  animation?: TextureAnimationSpec | null
  atlas?: string | null
  linear?: boolean | null
  useMipmaps?: boolean | null
}): ContentResource {
  const payload = init.payload ?? null
  const derived = payload === null ? (init.contentVersion ?? '') : `sha:${digestOf(payload).toString(16)}`
  return Object.freeze({
    ref: Object.freeze({ assetId: init.assetId, contentVersion: derived, url: init.locator }),
    kind: init.kind ?? 'static16',
    payload,
    blend: init.blend ?? null,
    emissive: init.emissive ?? null,
    animation: init.animation ?? null,
    atlas: init.atlas ?? null,
    linear: init.linear ?? null,
    useMipmaps: init.useMipmaps ?? null,
  })
}

/**
 * 资源引用的**身份键**。
 *
 * 转发 `domain/materials#resourceCacheKey`（唯一权威），**不**另写一遍
 * `` `${assetId}@${contentVersion}` `` —— 那会是第二份身份算法。
 */
export function resourceIdentity(resource: ContentResource): string {
  return resourceCacheKey(resource.ref)
}

/** 清单摘要（身份用；`url`/`payload` 不参与 —— 见文件头判据 1）。 */
export function resourceManifestDigest(resources: readonly ContentResource[]): number {
  return digestOf([...resources].map(resourceIdentity).sort().join('\u0000'))
}

/**
 * 资源清单规范化：按身份去重 + **按身份里的槽位数值**排序（稳定、与输入顺序无关）。
 *
 * 同一 `assetId` 以**两个不同内容版本**出现时**不**合并（那会丢掉其中一个版本）——
 * 与 `adapters/files/projectFormat#normalizeAssets` 同一口径。
 *
 * ## ⚠️ 为什么排序键**必须**是槽位数值，不是整串字典序（实测修复）
 *
 * 身份键形如 `` `${assetId}\u0000${contentVersion}` ``（`domain/materials#resourceCacheKey`），
 * 旧实现直接对**整串**做 `localeCompare`。而 `assetId` 的常见形态是 `<kind>:<槽位>`（如
 * `material:7`）⇒ 字典序把槽位当**字母**比：`material:10` 排在 `material:2` **之前**。
 *
 * 后果不是"顺序难看"，而是**静默贴错图**：几何四边形的 `materialIndex` 指向的正是
 * 调色盘/资源表的**槽位**（`render/schema/types.ts:294`「BakedQuad.materialIndex 直接指向此数组」，
 * 契约在 `composition/kernelTextureResources.ts:182-190`），故位置 ≠ 槽位时
 * `materialPalette[q.materialIndex]` 与 `resources[materialIndex]` 一起绑错。
 * 生产装配实测（真信封 `structuredata-exported-envelope.json`，62 条材质）：
 * **位置 ≠ 槽位 61/62**，逐 quad **2051/2165** 绑到与文件不同的材质；4 条材质的
 * 多方块夹具恰好同序（单数字前缀）⇒ 这条 bug 在多方块-only 证据下不可见。
 *
 * ## 两条不变量的分工（修复后同时成立）
 *
 * 1. **与输入顺序无关**（`documentContent` 的注释依赖它：同一份清单两种排列 ⇒ 同一内容身份）：
 *    去重后按**身份键的全序**排序 —— 全序 ⇒ 排列无关，这条不因换键而改变；
 * 2. **下标即槽位**（`kernelTextureResources` 的绑定契约）：`<kind>:<n>` 按 `n` **数值**升序。
 *
 * ## 无法解析槽位的身份落在哪（**显式**口径，不是"碰巧"）
 *
 * `assetId` 不是 `<kind>:<十进制槽位>` 形态（无冒号 / 尾段非纯数字 / 冒号在首字符）时，
 * 该条排在同一 `kind` 的可解析条**之后**；两条都不可解析时，回**旧口径**
 * （整串 `localeCompare`）作稳定 tiebreak —— 保住既有非槽位 id 的相对顺序，
 * 把行为变化**限制在**槽位 id 上。槽位相等（同 `assetId` 两个内容版本）同样按旧口径
 * tiebreak，故"哪个版本在前"与修复前一致。
 */
export function normalizeResources(resources: readonly ContentResource[]): readonly ContentResource[] {
  const seen = new Map<string, ContentResource>()
  for (const r of resources) {
    const key = resourceIdentity(r)
    if (!seen.has(key)) seen.set(key, r)
  }
  return Object.freeze(
    [...seen.entries()].sort(([a], [b]) => compareResourceIdentities(a, b)).map(([, v]) => v),
  )
}

/**
 * 从资源**身份键**里解析槽位（`<kind>:<十进制槽位>` → `{kind, slot}`）；解析不出回 `null`。
 *
 * 身份键 = `` `${assetId}\u0000${contentVersion}` ``，故只取 NUL 之前的 `assetId` 段。
 */
function parseResourceSlot(identity: string): { readonly kind: string; readonly slot: number } | null {
  const nul = identity.indexOf('\u0000')
  const assetId = nul < 0 ? identity : identity.slice(0, nul)
  const colon = assetId.lastIndexOf(':')
  if (colon <= 0) return null
  const tail = assetId.slice(colon + 1)
  if (!/^\d+$/.test(tail)) return null
  const slot = Number(tail)
  return Number.isSafeInteger(slot) ? { kind: assetId.slice(0, colon), slot } : null
}

/**
 * 资源身份键的**全序**比较器（见 `normalizeResources` 的口径说明）。
 *
 * 可解析槽位的条先按 `kind`、再按**槽位数值**排序；不可解析的排在其后。
 * 两处 tiebreak（同槽位 / 都不可解析）都用整串 `localeCompare` —— 与修复前同口径。
 */
function compareResourceIdentities(a: string, b: string): number {
  const ka = parseResourceSlot(a)
  const kb = parseResourceSlot(b)
  if (ka !== null && kb !== null) {
    if (ka.kind !== kb.kind) return ka.kind < kb.kind ? -1 : 1
    if (ka.slot !== kb.slot) return ka.slot - kb.slot
    return a.localeCompare(b)
  }
  if (ka !== null) return -1
  if (kb !== null) return 1
  return a.localeCompare(b)
}

// ─────────────────────────────────────────────────────────────────────────────
// 文档元数据（具名字段，不是字段袋）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 文档元数据。
 *
 * 每个字段都对应旧 `meta` 的一个**已知键**（`name`/`author`/`created_at_ms`/
 * `description`/`tags`/`origin`）。旧 `meta` 的其余键**不**在这里 ——
 * 它们走适配器保真记录（见文件头判据 3）。
 *
 * `createdAtMs` 是 `number | null` 而不是 `number`：旧产物缺该键时**如实为 null**，
 * 不用 `Date.now()` 补一个假时间（那会让「这份文件什么时候建的」变成一个
 * 每次读取都不同的值 —— 同一份文件两次打开得到不同内容身份）。
 */
export interface DocumentMetadata {
  readonly name: string
  readonly author: string
  readonly description: string
  readonly tags: readonly string[]
  /** 场景原点（MC 世界坐标 → 场景坐标的平移量）。 */
  readonly origin: Vec3
  readonly createdAtMs: number | null
  /**
   * **文件格式版本**（源文件 `format_version` 声明；无声明 ⇒ `'2.0'` = 旧解析器默认）。
   *
   * ## 为什么它是内核元数据（补能力，不是"为消费形状塞字段"）
   *
   * 它曾经由 `Context#documentMetadata` **恒取旧文档**的声明（`doc.formatVersion`），
   * 理由是"外部格式的事实，内核不承载"（见 `composition/seams.ts` 的
   * `legacy-render-source-document`）。但**产品需要它**：属性面板显示"格式版本"、
   * 嵌入预览的元信息提示显示版本号 —— 这是**文档自身的元数据**这一业务职责，
   * 内核的 `DocumentMetadata` 就是它的正确归属。
   *
   * ⚠️ 与装配面的 `schemaVersion`（多方块**声明**的编号，真实夹具 = `1`）
   * **不是同一个编号**：用后者冒充前者会把属性面板的 `2.0` 变成 `1`（静默行为变更）。
   */
  readonly formatVersion: string
  /**
   * **声明里的 GTNH 版本**（源文件 `gtnhVersion` 声明；无声明 ⇒ `''`）。
   *
   * 与 {@link DocumentMetadata.formatVersion} 同族、同一理由：嵌入预览的元信息提示
   * 需要它（`embed/useEmbedTooltip` 的"版本号"一行），故由内核元数据承载，
   * 消费者不再回头读旧文档根。
   */
  readonly gtnhVersion: string
}

/** 空元数据（**显式**默认；新建文档与「文件没声明元数据」共用同一值）。 */
export const EMPTY_METADATA: DocumentMetadata = Object.freeze({
  name: '',
  author: '',
  description: '',
  tags: Object.freeze([]),
  origin: Object.freeze({ x: 0, y: 0, z: 0 }),
  createdAtMs: null,
  formatVersion: '2.0',
  gtnhVersion: '',
})

/** 造元数据（逐字段给出缺省，不静默丢弃已给的字段）。 */
export function documentMetadata(init: Partial<DocumentMetadata> = {}): DocumentMetadata {
  return Object.freeze({
    name: init.name ?? '',
    author: init.author ?? '',
    description: init.description ?? '',
    tags: Object.freeze([...(init.tags ?? [])]),
    origin: Object.freeze({ ...(init.origin ?? { x: 0, y: 0, z: 0 }) }),
    createdAtMs: init.createdAtMs ?? null,
    formatVersion: init.formatVersion ?? '2.0',
    gtnhVersion: init.gtnhVersion ?? '',
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 帧时长轴（时间 → 帧 的映射轴）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一帧的**声明**（时长轴的一项）。
 *
 * 注意它**没有** `grid`：旧 `RuntimeFrame` 同时承载「帧声明」与「帧网格」，而
 * 契约要求「不能用当前空间坐标替代对象身份」—— 网格内容归**对象**
 * （`ObjectData` 的 `blockGrid` 载荷），帧只承载**时间轴上的位置**。
 * 这正是「帧序列兼任动画 → 场景 + 通用动画轨道」在类型上的落点。
 */
export interface FrameDeclaration {
  /** 帧键（落盘在帧上的 `index` 字段；与数组下标可不同，见 `currentFrameKey`）。 */
  readonly index: number
  readonly label: string | null
  /** 停留时长（毫秒）；`null` = 文件未声明（**不**猜一个默认值）。 */
  readonly durationMs: number | null
}

/**
 * 帧时长轴（时间 → 帧 的唯一映射轴）。
 *
 * ## 为什么是独立类型而不是 `readonly FrameDeclaration[]`
 *
 * 两个理由，都是判据上的：
 *
 *  1. **空轴与「没读到轴」必须可区分**。`frames: []` 与「这份文档不是多帧文档」
 *     在旧形态下都是空数组 —— 而它们的正确处理不同（前者是 0 帧，后者是
 *     「时长轴不适用」）。用一个具名类型承载「这份文档声明了几帧」，
 *     使 `frameCount` 成为类型上的事实。
 *  2. **时长轴的读取点唯一**。`KernelSession.frameIndex()` 需要「每帧多久」，
 *     若调用方各自 `frames.map(f => f.durationMs ?? 0)`，那个 `?? 0` 回落
 *     就有 N 份实现 —— 而它**是**判据（「文件没声明时长」与「声明了 0ms」
 *     必须给出同一行为，且该行为只有一个定义点）。
 */
export interface FrameAxis {
  readonly frames: readonly FrameDeclaration[]
}

export const EMPTY_FRAME_AXIS: FrameAxis = Object.freeze({ frames: Object.freeze([]) })

export function frameAxis(frames: readonly FrameDeclaration[] = []): FrameAxis {
  return Object.freeze({ frames: Object.freeze(frames.map((f) => Object.freeze({ ...f }))) })
}

/** 帧数（0 = 无时长轴）。 */
export function frameCount(axis: FrameAxis): number {
  return axis.frames.length
}

/**
 * 每帧时长（毫秒；缺项按 `0` 处理）。
 *
 * `0` 而不是「猜一个 50ms」：文件**没声明**时长与文件**声明了 0ms** 在行为上必须
 * 一致（都由 `domain/materials#stripTimeline` 的回落决定），而「猜一个 50」
 * 会让两者无法区分 —— 这与 `composition/useKernelFrameLoop` 的既有口径逐字相同。
 */
export function frameDurationsMs(axis: FrameAxis): readonly number[] {
  return Object.freeze(axis.frames.map((f) => (typeof f.durationMs === 'number' && Number.isFinite(f.durationMs) && f.durationMs > 0 ? f.durationMs : 0)))
}

// ─────────────────────────────────────────────────────────────────────────────
// 内容身份输入（唯一计算点）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 文档**内容身份**的输入（除 `scene`/`animation` 外的三块）。
 *
 * 与 `domain/document#contentOf` 的分工：那里拼装 `{scene, animation}`，
 * 这里提供另外三块，由 `contentOf` 一并摘要。**唯一计算点仍是 `digestOf`** ——
 * 本模块不自己算摘要，只提供**被摘要的值**（否则「什么算内容变化」会出现第二套判据，
 * 正是要消除的形态）。
 */
export interface DocumentContent {
  readonly metadata: DocumentMetadata
  readonly frameAxis: FrameAxis
  readonly resources: readonly ContentResource[]
  /**
   * **多方块声明**。
   *
   * ## 为什么它必须在这里（迁移阻塞点）
   *
   * `shared/viewport/useKernelChannels.ts:199` 是 `Context#legacyRenderSource()` 的
   * **唯一**生产消费者，它要的是「多方块声明的内层 body」——用来按当前通道取值
   * **重新装配**并构造渲染视图文档。此前内核内容里没有任何落点承载它，于是那次读
   * 只能走旧读面。本字段即那个落点。
   *
   * ## 为什么**非空**且有显式空值
   *
   * 类型是 `MultiblockDeclaration`（复用 `domain/multiblockDocument`，不另立形状），
   * 而"本内核文档没有多方块节点"由 {@link EMPTY_MULTIBLOCK_DECLARATION} 表示 ——
   * 一个**确定**的冻结值，故同一语义不会因构造路径不同而得到两种摘要
   * （`canonicalize` 键序稳定；见 `domain/identity`）。
   *
   * ## 为什么进内容身份
   *
   * 声明**是**内容：`contentOf` 把它一并摘要 ⇒ 换一份声明（或从"无"变成"有"）
   * 必然改变 `contentDigest` ⇒ 推进 `documentVersion`、变脏、可撤销。这与
   * 同一判据一致 —— 反过来，"声明没变"时摘要也不得变（`documentContent` 的
   * 缺省值与真实空声明是同一个值）。
   */
  readonly multiblock: MultiblockDeclaration
}

export const EMPTY_CONTENT: DocumentContent = Object.freeze({
  metadata: EMPTY_METADATA,
  frameAxis: EMPTY_FRAME_AXIS,
  resources: Object.freeze([]),
  multiblock: EMPTY_MULTIBLOCK_DECLARATION,
})

/** 造一份内容（`resources` 走规范化，故「同一份清单两种顺序」内容身份相同）。 */
export function documentContent(init: Partial<DocumentContent> = {}): DocumentContent {
  return Object.freeze({
    metadata: init.metadata ?? EMPTY_METADATA,
    frameAxis: init.frameAxis ?? EMPTY_FRAME_AXIS,
    resources: normalizeResources(init.resources ?? []),
    multiblock: init.multiblock ?? EMPTY_MULTIBLOCK_DECLARATION,
  })
}
