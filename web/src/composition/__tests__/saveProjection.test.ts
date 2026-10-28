/**
 * **判据：保存/导出改吃内核投影**。
 *
 * ## 要证明什么
 *
 * | # | 判据 | 防什么 |
 * |---|---|---|
 * | ① | **键面双向不对称**：`onlyLegacy` 必须为空（空值缺席须逐项机器核验）；`onlyKernel` 必须在**显式允许集**里 | 数据丢失（数据不回退的硬底线）／污染静默通过 |
 * | ② | **字面量键逐字相等**（`id`/`format_version`/`annotations`/`labels`/`meta` 除 `created_at_ms`） | 内容身份被改写 |
 * | ③ | **语义面**：两侧产物各自喂回**生产解析器**，帧数/帧声明/形态/注解/标签相等 | "形状变了但读不回来" |
 * | ④ | **逐格说明文本**两侧相等 | 说明池重压缩时丢文案 |
 * | ⑤ | **材质表按 `locator`** 的语义字段与 **blob 内容**相等 | 调色板置换时材质错位 |
 * | ⑥ | **叶子差异逐条登记**（未登记 ⇒ 判红；登记未被用到 ⇒ 判红） | "忽略"式放行（将来任何键都能溜过） |
 * | ⑦ | **装配边界防污染**：误传信封根被幂等归一化 | 信封结构键写回 Plain 根 + 真字段丢 |
 * | ⑧ | **D9**：调色板命名空间回真实值（且同尾段不同命名空间不瞎猜） | 方块身份被改写 |
 * | ⑨ | **D10**：多方块元素级扩展键保真（`variants[].height` 等） | 保存一次就丢字段 |
 * | ⑩ | **装配面三态**（未采集／多帧／卸载清空） | 串档、把"未采集"当"零帧" |
 * | ⑪ | `plainForSave` 的 `source` 分流可观测 | 回落静默发生 |
 *
 * ## ⚠️ 口径的三条纪律（本文件的设计依据）
 *
 * 1. **双向不对称**：`onlyLegacy` 非空**就是**数据丢失；`onlyKernel` 允许非空，
 *    但**必须逐项登记**在显式允许集里 —— **不许"忽略"**（忽略 = 将来任何键都能溜过）。
 *    空值缺席（如源里 `"tooltipPalette": []`）只允许登记为"legacy 值确为空"，
 *    由判据**逐项断言**（见 `isEmptyValue`），非空即判红。
 * 2. **两边都报**：比较器**不短路** —— 键面、叶子面、语义面一次性算完，
 *    失败信息里同时给出两侧差异（旧版把键集断言放在值比对之前，于是值级差异
 *    **一次都没跑过**）。
 * 3. **负对照必须真能判红**：每条"允许"都配一条注入式反例（见各组的「负对照」），
 *    以及比较器自身的注入反例（⑥ 组）——"声称一致 ≠ 判据把守"。
 *
 * ## ⚠️ 为什么夹具输入必须是 `plainRootOf(raw)`（实测抓出的**判据 bug**）
 *
 * 第一版判据把**信封根**当装配源传给 `adoptLoadedDocument`。生产 12 个调用点
 * **全部**传 `plainRootOf(raw)`（`workbench/document/pipeline.ts:64`、
 * `docLifecycleOperators`×3、`sdeOperators`×2 …）。误传信封根的后果实测是
 * **一边污染一边丢失**：信封结构键（`payload` = 整份 base64 正文！）被当成
 * "未知顶层字段"收进保真记录并写回 Plain 产物根，而真正的 plain 键
 * （`mode`/`cellGrid`…）根本没进保真记录 ⇒ 保存一次就丢。
 * ⇒ 判据必须与生产**同口径**，并要求装配边界**幂等**兜住误用（⑦ 组）。
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { ref, type Ref } from 'vue'
import { readJson, fixturePath } from '@/context/__tests__/multiblockFixtureIo.mjs'
import { realFixtureText, withRealFixture } from '../../../e2e/real-fixture-vitest'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { ALL_CAPABILITIES } from '@/application/commands'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID, KernelSession } from '@/runtime/kernelSession'
import { Context } from '@/runtime/context'
import { createDocument, withContent, withDocumentContent } from '@/domain/document'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { projectKernelSaveView } from '@/composition/saveProjection'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { projectGridCells } from '@/composition/kernelProjection'
import { blockPaletteEntryKey, type BlockPaletteEntry } from '@/domain/blockGeometry'
import { plainRootOf } from '@/adapters/plainRoot'
import { TOOLTIP_GRID_NONE } from '@/render/schema/types'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import { makeAdoptedKernelReadHost, makeKernelReadHost } from '@/runtime/__tests__/kernelReadTestHost'

type Plain = Record<string, unknown>

function productionParsers() {
  const p = createParserRegistry()
  p.register(V2PlainParser)
  p.register(createEnvelopeParser(p))
  p.register(WorldParser)
  p.register(StructureDataParser)
  return p
}

const NOOP_LOG = { info: () => {}, warn: () => {} }

/** **仓外** StructureData 真实信封原文（`realFixtureText` 惰性解析，CRLF→LF）。 */
function envelopeRaw(): Plain {
  return JSON.parse(realFixtureText('structureDataExportedEnvelope')) as Plain
}

function rawOf(name: string): Plain {
  if (name === 'envelope') return envelopeRaw()
  return readJson(fixturePath(name)) as Plain
}

/** 四份夹具：帧为主（真实信封）+ 三方块（总 Tier 单通道／双通道／作用域相交）。 */
const FIXTURES = ['envelope', 'multiblock-tier-only', 'multiblock-ebf-2ch', 'multiblock-lsc-overlap'] as const
type FixtureName = (typeof FIXTURES)[number]

/**
 * 逐夹具注册：**仓内**多方块真夹具（tier / ebf / lsc）始终运行；
 * `envelope` 是**仓外**真实信封，缺件时只有该条目显式 skip（不整文件 exclude）。
 */
function fixtureIt(name: FixtureName, title: string, fn: () => void | Promise<void>): void {
  if (name === 'envelope') withRealFixture('structureDataExportedEnvelope', title, fn)
  else it(title, fn)
}

/** 装载一份真实夹具（**生产口径**：`adoptLoadedDocument` + `plainRootOf(raw)`）。 */
async function loaded(name: FixtureName): Promise<{
  session: KernelSession
  legacy: { serialize: () => Plain }
  raw: Plain
  plainRoot: Plain
}> {
  const raw = rawOf(name)
  const parsed = await productionParsers().detectAndParse(raw)
  // ⚠️ `=== null` 判据不够：初版漏了 `await` 时 `parsed` 是 Promise，
  // `parsed.document` 是 `undefined` ⇒ 守卫**没拦住**，缺陷以
  // `Cannot read properties of undefined (reading 'isMultiblock')` 的形式
  // 在下游四层之外爆出（难定位）。⇒ 判"**非文档即失败**"，而不是只判 `null`。
  if (parsed.document === null || parsed.document === undefined) throw new Error(`夹具 ${name} 解析失败`)
  const session = new KernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: ALL_CAPABILITIES,
  })
  const plainRoot = plainRootOf(raw) as Plain
  // 走**生产装配路径**（不是手搓会话）—— 这样装配面/保真字段都由真代码填。
  const ok = adoptLoadedDocument({ kernel: session, log: NOOP_LOG }, parsed.document as never, plainRoot, name)
  if (!ok) throw new Error(`夹具 ${name} 装配失败`)
  return { session, legacy: parsed.document as never, raw, plainRoot }
}

// ─────────────────────────────────────────────────────────────────────────────
// 比较器（判据专用；纯函数，且**不短路** —— 一次算完键面 + 叶子面）
// ─────────────────────────────────────────────────────────────────────────────

/** 键序无关的规范化（`undefined` 视为缺席 —— JSON 语义如此）。 */
function canon(v: unknown): string {
  return JSON.stringify(sortDeep(v))
}
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = sortDeep(o[k])
    return out
  }
  return v
}

/** 展平成"叶子路径 → 规范化值"（空数组/空对象也各占一个叶子 —— 否则"存在但为空"不可见）。 */
function flatten(v: unknown, p: string, out: Map<string, string>): void {
  if (Array.isArray(v)) {
    if (v.length === 0) {
      out.set(p, '[]')
      return
    }
    for (let i = 0; i < v.length; i++) flatten(v[i], `${p}[${i}]`, out)
    return
  }
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>).filter((k) => (v as Plain)[k] !== undefined)
    if (keys.length === 0) {
      out.set(p, '{}')
      return
    }
    for (const k of keys) flatten((v as Plain)[k], p === '' ? k : `${p}.${k}`, out)
    return
  }
  out.set(p, JSON.stringify(v))
}

type Dir = 'kernel-only' | 'legacy-only' | 'conflict'
/** 登记的**允许方向**：`any` = 两个方向都可能（如"`null` 与缺席"）。 */
type RuleDir = Dir | 'any'
interface LeafDiff {
  readonly path: string
  readonly dir: Dir
  readonly kernel?: string
  readonly legacy?: string
}
interface Comparison {
  readonly onlyKernel: readonly string[]
  readonly onlyLegacy: readonly string[]
  readonly leaves: readonly LeafDiff[]
}

/**
 * **产物比较器**。
 *
 * 两个面**一次算完**（不短路）：顶层键面（双向）与共有键的叶子面。
 * 叶子路径里的数组下标在登记匹配时被归一成 `[*]`（同一规则覆盖全部条目）。
 */
function compareSaveArtifacts(kernel: Plain, legacy: Plain): Comparison {
  const onlyKernel = Object.keys(kernel)
    .filter((k) => legacy[k] === undefined)
    .sort()
  const onlyLegacy = Object.keys(legacy)
    .filter((k) => kernel[k] === undefined)
    .sort()
  const leaves: LeafDiff[] = []
  for (const key of Object.keys(legacy).sort()) {
    if (kernel[key] === undefined) continue
    const a = new Map<string, string>()
    const b = new Map<string, string>()
    flatten(kernel[key], key, a)
    flatten(legacy[key], key, b)
    for (const [p, av] of a) {
      const bv = b.get(p)
      if (bv === undefined) leaves.push({ path: p, dir: 'kernel-only', kernel: av })
      else if (av !== bv) leaves.push({ path: p, dir: 'conflict', kernel: av, legacy: bv })
    }
    for (const [p, bv] of b) if (!a.has(p)) leaves.push({ path: p, dir: 'legacy-only', legacy: bv })
  }
  return { onlyKernel, onlyLegacy, leaves }
}

/** 叶子路径的登记匹配形（下标归一成 `[*]`）。 */
function rulePath(p: string): string {
  return p.replace(/\[\d+\]/g, '[*]')
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 键面：显式允许集（不许"忽略"）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **`onlyKernel` 显式允许集**（逐夹具精确等值）。
 *
 * 空集也是**显式登记**：多方块那三份夹具的 `onlyKernel` 必须是空的 ——
 * 因为它们源里的未知顶层字段（`mode`/`fixtureFile`/…）在 legacy `_extra` 里
 * 也有（两边都写回），而真实信封的 `mode`/`scanBounds`/`source`/`documentFormat`
 * 是**旧解析器丢掉的**（`fromV2Plain` 的 `known` 列了它们却不读、也不收 `_extra`）
 * ⇒ 内核**更完整**，这是 G-6(c) 的正当交付。
 */
const KERNEL_ONLY_ALLOWED: Readonly<Record<FixtureName, readonly string[]>> = Object.freeze({
  envelope: Object.freeze(['documentFormat', 'mode', 'scanBounds', 'source']),
  'multiblock-tier-only': Object.freeze([]),
  'multiblock-ebf-2ch': Object.freeze([]),
  'multiblock-lsc-overlap': Object.freeze([]),
})

/**
 * **`onlyLegacy` 允许集**（逐夹具）：键 + "值确为空"的机器核验。
 *
 * ⚠️ 这不是"忽略"：`onlyLegacy` 非空**就是**数据丢失（数据不回退的硬底线）。
 * 唯一被允许的形态是**空值缺席** —— 源里 `"tooltipPalette": []`（空池），
 * legacy `serialize()` 因 `if (this.tooltipPalette)` 把它原样写出，而内核投影
 * **刻意**不写（`projectionFidelity.test.ts` 的 D1+ 判据：「无说明 ⇒ 不得写出池」，
 * 「缺席 ≠ 空池」）。⇒ 两侧判据在此**直接冲突**，处置是：允许登记，
 * 但判据**逐项断言 legacy 值确为空**（非空即判红，见下方 `isEmptyValue` 与负对照）。
 */
const LEGACY_ONLY_ALLOWED: Readonly<Record<FixtureName, readonly string[]>> = Object.freeze({
  envelope: Object.freeze([]),
  'multiblock-tier-only': Object.freeze(['tooltipPalette']),
  'multiblock-ebf-2ch': Object.freeze(['tooltipPalette']),
  'multiblock-lsc-overlap': Object.freeze(['tooltipPalette']),
})

/** "空值"的判定（`[]`/`{}`/`''`/`null` —— 携带零信息）。 */
function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true
  if (typeof v === 'string') return v.length === 0
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.keys(v as object).length === 0
  return false
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ 叶子差异：登记表（每条配一个具名保留判据；另有"登记必须被用到"的反向检查）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 叶子差异**登记表**。
 *
 * - `dir`：该差异的方向（与实际方向不符 ⇒ 不匹配 ⇒ 判红）；
 * - `check`：**具名保留判据**的 id —— 每条在下面 `PRESERVATION_CHECKS` 里实现，
 *   且必须真的有断言（不是散文）。
 *
 * ⚠️ 本表的作用**不是**"让判据变绿"，而是把"哪些形状差异被接受、依据是什么"
 * 变成可机械核对的事实。未登记的叶子差异一律判红（负对照见 ⑥ 组）。
 */
interface LeafRule {
  readonly id: string
  readonly path: string
  readonly dir: RuleDir
  readonly why: string
  readonly check: string
}

const LEAF_RULES: readonly LeafRule[] = Object.freeze([
  {
    id: 'frame-null-vs-absent',
    path: 'frames[*].label',
    dir: 'any',
    why: 'legacy `serialize()` 在 `label === undefined` 时**不写**该键，投影写 `label: null`。JSON 层二者不同，但 JSON 语义层等价（`JSON.stringify(undefined)` 丢键、解析器两条路径都 `?? 0`/`?? null`）。',
    check: 'null-vs-absent',
  },
  {
    id: 'frame-duration-null-vs-absent',
    path: 'frames[*].durationMs',
    dir: 'any',
    why: '同上：`durationMs` 的 `null` 与缺席在解析器读法（`durationMs ?? 0`）下等价。',
    check: 'null-vs-absent',
  },
  {
    id: 'air-entry-empty-geometry',
    path: 'blockPalette[*].geometry',
    dir: 'legacy-only',
    why: 'legacy 的空气条目带 `geometry: {encoding, quads: []}`（**零个四边形**）。内核空气条目不写 `geometry`（`airPaletteEntry()`），呈现侧据此走"按身份现算"。⚠️ 仅当 legacy 值确为**零四边形**时合法。',
    check: 'empty-geometry',
  },
  {
    id: 'material-palette-permutation',
    path: 'materialPalette',
    dir: 'any',
    why:
      '内核按**首次引用顺序**重排材质表；blob 表的**表示**由文档形态决定'
      + '（`composition/kernelProjection.ts:1405-1408`：多方块 ⇒ 数组，帧为主 ⇒ 槽位键对象），'
      + '且两条路径的**下标空间不同**（投影 = 按调色板槽位展开，实测 62 键；legacy `serialize()` = 按内容去重，实测 57 条）。'
      + '⚠️ 仅"同 `locator` 的语义字段逐条相同 + 每条经各自 `textureBlobIndex` 取到的字节相同"时合法（见 ⑤ 组；'
      + '下标空间的实测登记见 `render/data/__tests__/isoExportTextureChain.test.ts` A 组）。',
    check: 'palette-permutation',
  },
  {
    id: 'material-palette-kind-additive',
    path: 'materialPalette[*].kind',
    dir: 'kernel-only',
    why: '源文件的多方块材质条目**未声明** `kind`，解析器按条目形状补 `static16`（类型化面已有该字段）。加性补全，不覆盖任何源值。',
    check: 'additive-typed',
  },
  {
    id: 'texture-blobs-shape',
    path: 'textureBlobs',
    dir: 'any',
    why:
      '帧为主文档的 `textureBlobs` 有**两种契约形态**（由**生产者**决定，不是实现选择）：'
      + '① **投影产物**（`plainForSave().plain`，内核侧）= 槽位键对象 `{"0": b64, …}`，键 = 调色板槽位'
      + '（实测 **62 键**，按槽位**展开**，共享贴图复制多份）；'
      + '② **legacy `serialize()`** = 数组 `[b64, …]`（实测 **57 条**，按内容**去重**；多方块文档亦逐字要求数组，'
      + '`docs/contracts/format-multiblock-doc.md` §3）。'
      + '⚠️ 更正：本条目此前把**对象形态**写成「`serialize()` 的既有形态」——'
      + '**与实测相反**（`serialize().textureBlobs` 是数组 57 条，对象 62 键才是投影产物）。'
      + '⚠️ 保留条件：两种表示的下标空间**不同**（展开池 0..61 vs 去重池 0..56），'
      + '故只能逐条经各自的 `textureBlobIndex` 对账，或对**字节集合**对账；位置对账必然假红。'
      + '实测与判据见 `render/data/__tests__/isoExportTextureChain.test.ts` A 组。',
    check: 'blob-shape',
  },
  {
    id: 'tooltip-grid-widen',
    path: 'cellTooltipGrid',
    dir: 'any',
    why: '说明网格的**宽度**由"确有逐格说明的格"决定，故尾列（全 `-1` 哨兵）被裁掉（实测 19 → 16 列，被裁的 3 列 legacy 侧也全是 `-1`）。⚠️ 仅当"逐格文案相同"时合法（见 ④ 组）。',
    check: 'tooltip-text',
  },
  {
    id: 'tooltip-palette-pool',
    path: 'tooltipPalette',
    dir: 'any',
    why: '说明池是**内容去重**的结果（同文案共享下标）⇒ 池的长度与顺序与源不同，但逐格文案相同。⚠️ 仅当"逐格文案相同"时合法（见 ④ 组）。',
    check: 'tooltip-text',
  },
  {
    id: 'meta-created-at-absent',
    path: 'meta.created_at_ms',
    dir: 'legacy-only',
    why: '源文件**未声明** `created_at_ms`，legacy `fromV2Plain` 在 `meta` 缺席时**伪造** `Date.now()`（`runtimeDocument.ts:389`）⇒ 该值是伪造值，不是源信息。内核如实**缺席**（`kernelAssembly#declaredCreatedAtMs` 已文档化）。⚠️ 仅当"源确实未声明"时合法（见 `createdAtAbsence`）。',
    check: 'created-at-absence',
  },
  {
    id: 'meta-faithful',
    path: 'meta.name',
    dir: 'conflict',
    why: '真实信封/多方块夹具的展示名在**根级 `label`**（与 `author`/`description` 同），而 `fromV2Plain` 把它们列进 `known` 却**不读**、也不收 `_extra` ⇒ 旧解析器读出的 `meta` 是空的。内核从无损源读回真值（`plainRoot.ts` 文件头实测登记）⇒ 内核**更忠实**。⚠️ 仅当"内核值 === 源声明值"时合法（见 `metadataFaithful`）。',
    check: 'metadata-faithful',
  },
  {
    id: 'meta-author-faithful',
    path: 'meta.author',
    dir: 'conflict',
    why: '同 `meta.name`：源在**根级 `author`** 声明了作者，而旧解析器把根级 `author` 列进 `known` 却从不读、也不收 `_extra` ⇒ 读出来是空串。⚠️ 仅当"内核值 === 源声明值且旧值为空"时合法（见 `metadataFaithful`）。',
    check: 'metadata-faithful',
  },
  {
    id: 'meta-description-faithful',
    path: 'meta.description',
    dir: 'conflict',
    why: '同 `meta.name`：源在**根级 `description`** 声明了描述，而旧解析器把根级 `description` 列进 `known` 却从不读、也不收 `_extra` ⇒ 读出来是空串。⚠️ 仅当"内核值 === 源声明值且旧值为空"时合法（见 `metadataFaithful`）。',
    check: 'metadata-faithful',
  },
  {
    id: 'mb-channel-slider-additive',
    path: 'multiblock.channels[*].slider',
    dir: 'kernel-only',
    why: '源文件的通道条目**未声明** `slider`，解析器按 `kind` 补 `true`（类型化面已有该字段）。加性补全。',
    check: 'additive-typed',
  },
  {
    id: 'mb-channel-domain-min-additive',
    path: 'multiblock.channels[*].domain.min',
    dir: 'kernel-only',
    why: '源文件的 `domain` 只声明 `{max}`，解析器把有效下界（`min`）补进区间的类型化形态。⚠️ 解析器读的是 `domain.max`，故 `min` 不影响读回（见 ③ 组语义面）。',
    check: 'additive-typed',
  },
])

function matchRule(path: string, dir: Dir): LeafRule | undefined {
  const p = rulePath(path)
  // 规则路径是**前缀**语义（`frames[*].label` 精确；`materialPalette` 覆盖其全部叶子）。
  // ⚠️ 取**最长**匹配（`materialPalette[*].kind` 必须赢过 `materialPalette`），
  // 否则"加性补全"这类更细的登记会被宽规则吞掉，反向腐烂检查也就查不出它没被用到。
  const candidates = LEAF_RULES.filter((r) => {
    if (r.dir !== 'any' && r.dir !== dir) return false
    return p === r.path || p.startsWith(`${r.path}.`) || p.startsWith(`${r.path}[`)
  })
  candidates.sort((a, b) => b.path.length - a.path.length)
  return candidates[0]
}

// ─────────────────────────────────────────────────────────────────────────────
// 具名保留判据（每条都是真断言；由下面的组调用）
// ─────────────────────────────────────────────────────────────────────────────

/** 说明网格 → `Map<'z,row,col', 文案>`（哨兵 ⇒ 缺席）。 */
function tooltipTexts(doc: Plain): Map<string, string> {
  const out = new Map<string, string>()
  const grid = doc.cellTooltipGrid as number[][][] | undefined
  const palette = (doc.tooltipPalette ?? []) as unknown[]
  if (!Array.isArray(grid)) return out
  for (let z = 0; z < grid.length; z++) {
    const slice = grid[z] ?? []
    for (let row = 0; row < slice.length; row++) {
      const line = slice[row] ?? []
      for (let col = 0; col < line.length; col++) {
        const idx = line[col] ?? TOOLTIP_GRID_NONE
        if (idx === TOOLTIP_GRID_NONE) continue
        out.set(`${z},${row},${col}`, String(palette[idx] ?? ''))
      }
    }
  }
  return out
}

/** ④ 逐格说明文本：两侧必须**逐格相同**（含"网格范围"这一层：legacy 有说明的格内核必须有）。 */
function checkTooltipTexts(kernel: Plain, legacy: Plain): {
  compared: number
  legacyCells: number
  kernelCells: number
  mismatch: string[]
  gridWidths: [number, number]
} {
  const a = tooltipTexts(kernel)
  const b = tooltipTexts(legacy)
  const keys = new Set([...a.keys(), ...b.keys()])
  const mismatch: string[] = []
  for (const k of keys) {
    if (a.get(k) !== b.get(k)) mismatch.push(`[${k}] kernel=${JSON.stringify(a.get(k))} legacy=${JSON.stringify(b.get(k))}`)
  }
  const w = (d: Plain): number => ((d.cellTooltipGrid as number[][][] | undefined)?.[0]?.[0]?.length ?? 0)
  return {
    compared: keys.size,
    legacyCells: b.size,
    kernelCells: a.size,
    mismatch,
    gridWidths: [w(kernel), w(legacy)],
  }
}

/** blob 表取值（两种形态统一按"下标"取）。 */
function blobAt(doc: Plain, i: number | undefined): string {
  if (i === undefined) return ''
  const tb = doc.textureBlobs
  if (Array.isArray(tb)) return String(tb[i] ?? '')
  return String((tb as Plain | undefined)?.[String(i)] ?? '')
}

/** ⑤ 材质表：按 `locator` 的语义字段 + blob 内容逐条相同（含索引重映射的反空洞真）。 */
function checkMaterials(kernel: Plain, legacy: Plain): {
  matched: number
  blobMismatch: string[]
  semMismatch: string[]
  indexRemapped: number
} {
  const kmp = (kernel.materialPalette ?? []) as Plain[]
  const lmp = (legacy.materialPalette ?? []) as Plain[]
  const lByLoc = new Map<string, Plain>()
  for (const e of lmp) lByLoc.set(String(e.locator ?? ''), e)
  const SEM = ['kind', 'blend', 'atlas', 'linear', 'useMipmaps', 'animation'] as const
  const pick = (e: Plain, keys: readonly string[]): Plain => {
    const o: Plain = {}
    for (const k of keys) if (e[k] !== undefined) o[k] = e[k]
    return o
  }
  const blobMismatch: string[] = []
  const semMismatch: string[] = []
  let matched = 0
  let indexRemapped = 0
  for (const ke of kmp) {
    const loc = String(ke.locator ?? '')
    if (loc === '') continue
    const le = lByLoc.get(loc)
    if (le === undefined) {
      semMismatch.push(`${loc}: legacy 侧无同 locator 条目`)
      continue
    }
    matched += 1
    const kb = blobAt(kernel, ke.textureBlobIndex as number | undefined)
    const lb = blobAt(legacy, le.textureBlobIndex as number | undefined)
    if (createHash('sha256').update(kb).digest('hex') !== createHash('sha256').update(lb).digest('hex')) {
      blobMismatch.push(`${loc}: blob 内容不同`)
    }
    if (ke.textureBlobIndex !== le.textureBlobIndex) indexRemapped += 1
    // `kind` 是**加性**补全（源未声明）⇒ 单独登记；其余语义字段必须逐条相同。
    const nonKind = SEM.filter((k) => k !== 'kind')
    if (canon(pick(ke, nonKind)) !== canon(pick(le, nonKind))) {
      semMismatch.push(`${loc}: kernel=${canon(pick(ke, nonKind))} legacy=${canon(pick(le, nonKind))}`)
    }
  }
  return { matched, blobMismatch, semMismatch, indexRemapped }
}

/** ③ 语义面：两侧产物各自喂回**生产解析器**后的读面。 */
interface SemanticFace {
  readonly frameCount: number
  readonly isMultiblock: boolean
  readonly frames: readonly string[]
  readonly annotations: string
  readonly labels: string
  readonly channels: string
  readonly variants: string
  readonly rules: string
}
async function semanticFaceOf(plain: Plain): Promise<SemanticFace | null> {
  const parsed = await productionParsers().detectAndParse(plain)
  const doc = parsed.document
  if (doc === null || doc === undefined) return null
  const frames: string[] = []
  // 帧声明用**类型化面**（`RuntimeDocument.multiblockFrames`）而不是帧对象里的 `raw`
  // —— `raw` 是解析期引用（本工程既有纪律：元素级 `raw` 不承载语义，
  // `kernelAssembly` 的剥离正是为此）。用 `raw` 比较会把"解析器回显"当成语义。
  const declFrames = new Map(doc.multiblockFrames.map((f) => [f.index, f]))
  for (let i = 0; i < doc.frameCount; i++) {
    const f = doc.frame(i)
    if (f === null) {
      frames.push('(null)')
      continue
    }
    const decl = declFrames.get(f.index)
    frames.push(
      canon({
        index: f.index,
        label: f.label ?? null,
        durationMs: f.durationMs ?? null,
        hasGrid: f.grid !== null,
        // 多方块帧的变体存储原语（契约 §5.3）：类型化字段
        variant: decl?.variant ?? null,
        runstate: decl?.runstate ?? null,
        stepIndex: decl?.stepIndex ?? null,
        rules: (decl?.rules ?? []).map((r) => `${r.id}@${r.order}`).join('|'),
      }),
    )
  }
  return {
    frameCount: doc.frameCount,
    isMultiblock: doc.isMultiblock,
    frames,
    annotations: canon(doc.annotations),
    labels: canon(doc.labels),
    // ⚠️ 声明读面**剥掉解析器的 `raw` 回显**（见上：它不承载语义）。
    channels: canon(stripRaw(doc.multiblockChannels)),
    variants: canon(stripRaw(doc.multiblockVariants)),
    rules: canon(stripRaw(doc.multiblockRules)),
  }
}

/** 递归剥掉解析期 `raw` 引用（不承载语义；元素级 `raw` 是"解析器的中间态"）。 */
function stripRaw(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripRaw)
  if (v !== null && typeof v === 'object') {
    const o = v as Plain
    const out: Plain = {}
    for (const k of Object.keys(o)) {
      if (k === 'raw') continue
      // `undefined` 值的键在 JSON 语义里 = 缺席 ⇒ 一律丢（否则 `canon` 已丢，这里保持一致）
      if (o[k] === undefined) continue
      out[k] = stripRaw(o[k])
    }
    return out
  }
  return v
}

// ─────────────────────────────────────────────────────────────────────────────

describe('① 等价：键面**双向不对称**（真实夹具 / 生产口径输入）', () => {
  for (const name of FIXTURES) {
    fixtureIt(name, `**键面**（${name}）：\`onlyLegacy\` 必须为空（空值缺席须机器核验），\`onlyKernel\` 必须在显式允许集里`, async () => {
      const { session, legacy, plainRoot } = await loaded(name)
      try {
        const projected = projectKernelSaveView(session)
        expect(projected.ok, '前提：该夹具必须装配成功').toBe(true)
        if (!projected.ok) return
        const fromKernel = projected.plain as Plain
        const fromLegacy = legacy.serialize() as Plain
        const { onlyKernel, onlyLegacy } = compareSaveArtifacts(fromKernel, fromLegacy)

        // ── ① ‑1 `onlyLegacy` ⊆ 登记的"空值缺席"允许集，且**逐项断言 legacy 值确为空** ──
        const allowedLegacy = LEGACY_ONLY_ALLOWED[name]
        const unexpectedLegacy = onlyLegacy.filter((k) => !allowedLegacy.includes(k))
        expect(
          { onlyLegacy, unexpectedLegacy },
          `**数据丢失**：以下键 legacy 有而内核产物没有（非空即丢失，硬底线）：${unexpectedLegacy.join(',') || '(无)'}`,
        ).toEqual({ onlyLegacy: allowedLegacy, unexpectedLegacy: [] })
        // 空值缺席的**逐项核验**：值必须确为空（`[]`/`{}`/`''`/`null`）。
        for (const k of allowedLegacy) {
          expect(
            isEmptyValue(fromLegacy[k]),
            `登记为"空值缺席"的键 ${k} 实测 **非空**（值 ${JSON.stringify(fromLegacy[k])?.slice(0, 120)}）⇒ 那是真的数据丢失，不是形状差异`,
          ).toBe(true)
        }

        // ── ① ‑2 `onlyKernel` 必须精确等于登记的允许集，且值**逐字来自源 plain 根** ──
        expect(
          onlyKernel,
          `仅内核有的顶层键必须**精确**等于登记的允许集（多一个 = 有未登记的差异溜过）`,
        ).toEqual(KERNEL_ONLY_ALLOWED[name])
        // G-6(c) 的正面证据：这些键就是"源里本适配器解释不了的顶层字段"，值逐字照抄。
        for (const k of onlyKernel) {
          expect(plainRoot[k], `登记为"内核更完整"的键 ${k} 必须真的在源 plain 根里`).toBeDefined()
          expect(canon(fromKernel[k]), `键 ${k} 的产物值必须**逐字**等于源值`).toBe(canon(plainRoot[k]))
        }
        // 且保真记录**就是**这些键（不漏不溢）—— 覆盖面比 onlyKernel 更宽（含 legacy 也有的键）。
        const fidelity = session.fidelityFieldMapOf()
        expect(fidelity, '前提：所有夹具都经过装配 ⇒ 保真记录必须已采集（`null` = 未采集）').not.toBeNull()
        for (const [k, v] of Object.entries(fidelity ?? {})) {
          expect(plainRoot[k], `保真记录里的键 ${k} 必须在源 plain 根里（否则是污染）`).toBeDefined()
          expect(canon(v), `保真记录里的 ${k} 值必须逐字等于源值`).toBe(canon(plainRoot[k]))
        }
      } finally {
        session.dispose()
      }
    })
  }

  it('**负对照**：空值缺席的核验**真能判红**（非空即数据丢失）', () => {
    // 判据本身：`isEmptyValue` 对非空值必须为 false（否则"空值缺席"会变成"什么都放行"）
    expect(isEmptyValue([]), '空数组 = 零信息').toBe(true)
    expect(isEmptyValue({}), '空对象 = 零信息').toBe(true)
    expect(isEmptyValue('')).toBe(true)
    expect(isEmptyValue(null)).toBe(true)
    expect(isEmptyValue(['x']), '**非空数组必须判红**').toBe(false)
    expect(isEmptyValue({ a: 1 }), '**非空对象必须判红**').toBe(false)
    expect(isEmptyValue('x')).toBe(false)
    expect(isEmptyValue(0), '数字 0 是信息（不是"空"）').toBe(false)
    // 端到端：把一份"空池"改成"非空池" ⇒ 同一条判据必然判红
    const asLegacy = (pool: unknown[]): Plain => ({ tooltipPalette: pool })
    const judge = (legacy: Plain, allowed: readonly string[]): string[] =>
      allowed.filter((k) => !isEmptyValue(legacy[k]))
    expect(judge(asLegacy([]), ['tooltipPalette']), '空池 ⇒ 不判红').toEqual([])
    expect(judge(asLegacy(['丢了']), ['tooltipPalette']), '**非空池 ⇒ 必须判红**').toEqual(['tooltipPalette'])
  })
})

describe('② 等价：字面量键**逐字相等**', () => {
  /** 登记为"内核更忠实"的元数据键（旧解析器把它们列进 `known` 却不读，见 `plainRoot.ts` 文件头）。 */
  const FAITHFUL_META = ['name', 'author', 'description'] as const

  for (const name of FIXTURES) {
    fixtureIt(name, `**字面量**（${name}）：\`id\`/\`format_version\`/\`annotations\`/\`labels\`/\`meta\`（除 \`created_at_ms\`）逐字相等`, async () => {
      const { session, legacy, plainRoot } = await loaded(name)
      try {
        const projected = projectKernelSaveView(session)
        expect(projected.ok).toBe(true)
        if (!projected.ok) return
        const K = projected.plain as Plain
        const L = legacy.serialize() as Plain
        for (const k of ['id', 'format_version', 'annotations', 'labels'] as const) {
          expect(canon(K[k]), `字面量键 ${k} 必须逐字相等`).toBe(canon(L[k]))
        }
        const km = { ...(K.meta as Plain) }
        const lm = { ...(L.meta as Plain) }
        delete km.created_at_ms
        delete lm.created_at_ms
        // 登记为"内核更忠实"的三个键由下面的**指向性**核验负责，此处不参与严格相等
        // （严格相等会把"内核更完整"误判成缺陷 —— 那正是本判据口径要防的方向误判）。
        const kmStrict = { ...km }
        const lmStrict = { ...lm }
        for (const k of FAITHFUL_META) {
          delete kmStrict[k]
          delete lmStrict[k]
        }
        expect(canon(kmStrict), '`meta`（除 `created_at_ms` 与已登记的忠实键）必须逐字相等').toBe(canon(lmStrict))

        // ## 登记项的**指向性**核验（不是"放行"，是"证明方向"）
        //
        // 源在**根级**声明了展示名/作者/描述（真实信封另有 `meta.*`），而旧解析器
        // 把这七个根级键列进 `known` 却**从不读**、也不收 `_extra` ⇒ 读出来是空的。
        // ⇒ 判据必须证明：① 内核值 = **源声明值**；② 旧值是空（= 旧解析器的损失），
        // 或两侧本来就相同。任何"内核值既不等源、也不等 legacy"的情形都判红。
        const rootMeta = (plainRoot.meta ?? {}) as Plain
        for (const k of FAITHFUL_META) {
          // `name` 的源声明落点是**根级 `label`**（真实产物的展示名键；见 `kernelProjection`
          // 的映射表 `DocumentContent.metadata → meta.{…} + 根 label`）。
          const declared = k === 'name' ? (plainRoot.label ?? rootMeta.name) : (plainRoot[k] ?? rootMeta[k])
          if (typeof declared === 'string' && declared.length > 0) {
            const legacyValue = String(lm[k] ?? '')
            if (legacyValue === declared) {
              expect(canon(km[k]), `源声明了 ${k}，两侧都应等于源值`).toBe(canon(declared))
            } else {
              expect(canon(km[k]), `源声明了 ${k} ⇒ 内核必须携带源值（旧值 "${legacyValue.slice(0, 40)}" 是旧解析器的有损读出）`).toBe(
                canon(declared),
              )
              expect(legacyValue, `登记为"内核更忠实"的前提是**旧值为空**（旧解析器丢了这个键）`).toBe('')
            }
          } else {
            expect(canon(km[k]), `源未声明 ${k} ⇒ 两侧必须相等（不得由内核凭空发明）`).toBe(canon(lm[k]))
          }
        }
      } finally {
        session.dispose()
      }
    })
  }
})

describe('③ 等价：语义面（两侧产物各自喂回**生产解析器**）', () => {
  for (const name of FIXTURES) {
    fixtureIt(name, `**语义面**（${name}）：帧数/帧声明/形态/注解/标签/多方块声明相等`, async () => {
      const { session, legacy } = await loaded(name)
      try {
        const projected = projectKernelSaveView(session)
        expect(projected.ok).toBe(true)
        if (!projected.ok) return
        const a = await semanticFaceOf(projected.plain as Plain)
        const b = await semanticFaceOf(legacy.serialize() as Plain)
        expect(a, '内核产物必须能被生产解析器读回（读不回 = 非法形状）').not.toBeNull()
        expect(b, '前提：legacy 产物可被读回').not.toBeNull()
        if (a === null || b === null) return
        // 一次性报出**全部**语义面差异（不短路）。
        expect(
          { frameCount: [a.frameCount, b.frameCount], isMultiblock: [a.isMultiblock, b.isMultiblock] },
          '帧数与形态必须相等',
        ).toEqual({ frameCount: [b.frameCount, b.frameCount], isMultiblock: [b.isMultiblock, b.isMultiblock] })
        expect(a.frames, '逐帧声明（下标/标称/时长/有无网格/变体原语）必须相等').toEqual(b.frames)
        expect(a.annotations, '注解读面必须相等').toBe(b.annotations)
        expect(a.labels, '标签读面必须相等').toBe(b.labels)
        expect(a.channels, '多方块通道声明必须相等').toBe(b.channels)
        expect(a.variants, '多方块变体声明必须相等').toBe(b.variants)
        expect(a.rules, '多方块规则表必须相等').toBe(b.rules)
        // 反空洞真：本组不能是"两边都读不回来"的空洞真
        expect(a.frameCount, '夹具必须有帧（否则比较是空洞真）').toBeGreaterThan(0)
      } finally {
        session.dispose()
      }
    })
  }
})

describe('④ 等价：逐格说明文本（池重压缩 / **同形**网格下的**语义**相等）', () => {
  for (const name of FIXTURES) {
    fixtureIt(name, `**逐格说明**（${name}）：两侧逐格文案相同；legacy 有说明的格内核不得缺`, async () => {
      const { session, legacy } = await loaded(name)
      try {
        const projected = projectKernelSaveView(session)
        expect(projected.ok).toBe(true)
        if (!projected.ok) return
        const K = projected.plain as Plain
        const L = legacy.serialize() as Plain
        const r = checkTooltipTexts(K, L)
        expect(r.mismatch, `逐格说明文案必须相同：\n${r.mismatch.slice(0, 10).join('\n')}`).toEqual([])
        expect(r.kernelCells, '内核产物里带说明的格数必须与 legacy 相同（丢格 = 丢文案）').toBe(r.legacyCells)
        if (r.legacyCells > 0) {
          // 反空洞真（**改判**）：说明网格的形状由**载荷声明**决定，不是说明格包围盒
          // （`adapters/tooltipPool` 判据 2）⇒ 两侧宽度必须**相等**。
          // ⚠️ 此前的实现这里是 `not.toBe`（"宽度差必须真实存在"）——那条断言记录的是当时的
          // 缺陷（envelope 实测包围盒宽 16 < 声明 19）。修好后若保留它，就等于**保住缺陷**；
          // 改为相等后判别力仍在：读面/投影若退回"按包围盒推形状"，这里立刻判红。
          expect(r.gridWidths[0], '说明网格必须与方块网格同形（宽度 = 声明；M1 P3 修）').toBe(r.gridWidths[1])
          expect(r.compared, '必须真的比过格（否则"相等"是空转）').toBeGreaterThan(0)
        }
        console.log(`[D2/④] ${name}: 说明格 ${r.legacyCells}，网格宽度 kernel=${r.gridWidths[0]} legacy=${r.gridWidths[1]}`)
      } finally {
        session.dispose()
      }
    })
  }
})

describe('⑤ 等价：材质表按 `locator` 的语义字段 + blob 内容', () => {
  for (const name of FIXTURES) {
    fixtureIt(name, `**材质表**（${name}）：同 \`locator\` 的语义字段与 blob 内容逐条相同`, async () => {
      const { session, legacy } = await loaded(name)
      try {
        const projected = projectKernelSaveView(session)
        expect(projected.ok).toBe(true)
        if (!projected.ok) return
        const K = projected.plain as Plain
        const L = legacy.serialize() as Plain
        const r = checkMaterials(K, L)
        expect(r.semMismatch, `同 locator 的语义字段必须相同：\n${r.semMismatch.slice(0, 8).join('\n')}`).toEqual([])
        expect(r.blobMismatch, `同 locator 的 blob 内容必须相同（否则是材质错位）：\n${r.blobMismatch.slice(0, 8).join('\n')}`).toEqual([])
        // 反空洞真：材质表非空且真的比对过
        expect(r.matched, '必须真的比对了材质条目（否则"一致"是空洞真）').toBeGreaterThan(0)
        const kmp = (K.materialPalette ?? []) as unknown[]
        expect(r.matched, '内核材质条目（有 locator 者）必须全部匹配上 legacy').toBe(kmp.length)
        console.log(`[D2/⑤] ${name}: 材质 ${r.matched} 条，blob 索引重映射 ${r.indexRemapped} 条`)
      } finally {
        session.dispose()
      }
    })
  }
})

describe('⑥ 叶子差异**逐条登记**（未登记 ⇒ 判红；登记未被用到 ⇒ 判红）', () => {
  const usedRules = new Set<string>()

  for (const name of FIXTURES) {
    fixtureIt(name, `**叶子登记**（${name}）：每个叶子差异都必须匹配一条登记规则`, async () => {
      const { session, legacy } = await loaded(name)
      try {
        const projected = projectKernelSaveView(session)
        expect(projected.ok).toBe(true)
        if (!projected.ok) return
        const cmp = compareSaveArtifacts(projected.plain as Plain, legacy.serialize() as Plain)
        const unregistered: string[] = []
        for (const leaf of cmp.leaves) {
          const rule = matchRule(leaf.path, leaf.dir)
          if (rule === undefined) {
            unregistered.push(
              `${leaf.path} [${leaf.dir}] kernel=${leaf.kernel ?? '-'} legacy=${leaf.legacy ?? '-'}`,
            )
            continue
          }
          usedRules.add(rule.id)
        }
        expect(
          unregistered,
          `以下叶子差异**没有**登记（不许忽略：要么修，要么登记并写明依据 + 配具名保留判据）：\n${unregistered.slice(0, 20).join('\n')}`,
        ).toEqual([])
      } finally {
        session.dispose()
      }
    })
  }

  withRealFixture(
    'structureDataExportedEnvelope',
    '**反向腐烂检查**：登记表里每一条都必须**真的被用到**（防止"登记了但早已不成立"）',
    () => {
    const unused = LEAF_RULES.map((r) => r.id).filter((id) => !usedRules.has(id))
    expect(
      unused,
      `以下登记条目在四份夹具上**一次都没被用到** ⇒ 要么该差异已消失（应删除登记），要么夹具覆盖不足：\n${unused.join('\n')}`,
    ).toEqual([])
    // 反空洞真：登记表本身非空，且每条都有具名的保留判据 id
    expect(LEAF_RULES.length, '登记表非空').toBeGreaterThan(0)
    for (const r of LEAF_RULES) {
      expect(r.why.length, `${r.id} 必须写明依据（≥40 字）`).toBeGreaterThan(40)
      expect(r.check.length, `${r.id} 必须配具名保留判据`).toBeGreaterThan(3)
    }
    },
  )

  it('**负对照**：比较器**真能判红**（未登记差异 / 数据丢失 / 值改写，三种注入）', () => {
    const base: Plain = { id: 'd', frames: [{ index: 0, label: 'a' }], tooltipPalette: ['t'] }
    const same: Plain = { id: 'd', frames: [{ index: 0, label: 'a' }], tooltipPalette: ['t'] }
    // ① 相同 ⇒ 无差异
    expect(compareSaveArtifacts(base, same).leaves).toEqual([])
    expect(compareSaveArtifacts(base, same).onlyLegacy).toEqual([])
    // ② **丢一个键**（数据丢失方向）⇒ onlyLegacy 非空
    const lostKey: Plain = { id: 'd', frames: [{ index: 0, label: 'a' }] }
    expect(compareSaveArtifacts(lostKey, base).onlyLegacy, '内核丢了 legacy 有的键 ⇒ 必须报出来').toEqual([
      'tooltipPalette',
    ])
    expect(compareSaveArtifacts(lostKey, base).onlyKernel).toEqual([])
    // ③ **丢一个字段**（叶子级数据丢失）⇒ legacy-only 叶子
    const lostLeaf: Plain = { id: 'd', frames: [{ index: 0 }], tooltipPalette: ['t'] }
    const r3 = compareSaveArtifacts(lostLeaf, base)
    expect(r3.leaves.map((l) => `${l.path}:${l.dir}`)).toEqual(['frames[0].label:legacy-only'])
    // ④ **值被改写** ⇒ conflict 叶子，且**未登记**（这条路径必须能判红）
    const rewritten: Plain = { id: 'd', frames: [{ index: 0, label: 'B' }], tooltipPalette: ['t'] }
    const r4 = compareSaveArtifacts(rewritten, base)
    expect(r4.leaves.map((l) => `${l.path}:${l.dir}`)).toEqual(['frames[0].label:conflict'])
    // 且 `matchRule` 对本组注入的路径**判不出来**（⇒ 未登记 ⇒ 上面的 ⑥ 主判据会判红）
    expect(matchRule('id', 'conflict'), '`id` 被改写不得有登记规则兜着').toBeUndefined()
    // ⑤ **方向不符也不匹配**：`multiblock.channels[*].slider` 只登记为 `kernel-only`
    //（"加性补全"只能往内核多的方向发生）⇒ `legacy-only` 不匹配。
    expect(matchRule('multiblock.channels[0].slider', 'legacy-only'), '方向必须匹配').toBeUndefined()
    expect(matchRule('multiblock.channels[0].slider', 'kernel-only'), '同路径同方向必须匹配').toBeDefined()
    expect(matchRule('frames[0].label', 'kernel-only'), '`null` 与缺席两个方向都合法').toBeDefined()
    expect(matchRule('frames[0].label', 'legacy-only')).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑦ 装配边界：误传信封根必须被**幂等归一化**（防污染 + 防丢失）
// ─────────────────────────────────────────────────────────────────────────────

describe('⑦ 装配边界：误传信封根被幂等归一化（防污染 + 防丢失）', () => {
  withRealFixture(
    'structureDataExportedEnvelope',
    '**边界幂等**：`plainRoot` 传信封根与传 `plainRootOf(raw)` 得到同一份保真记录',
    async () => {
    for (const name of ['envelope', 'multiblock-tier-only'] as const) {
      const raw = rawOf(name)
      const parsed = await productionParsers().detectAndParse(raw)
      const doc = parsed.document as never
      const viaRaw = new KernelSession({ documentId: KERNEL_DOCUMENT_ID, contextId: KERNEL_CONTEXT_ID, capabilities: [] })
      const viaPlain = new KernelSession({ documentId: KERNEL_DOCUMENT_ID, contextId: KERNEL_CONTEXT_ID, capabilities: [] })
      try {
        // 误用（生产 12 个调用点都不会这么传，但边界必须能兜住）
        expect(adoptLoadedDocument({ kernel: viaRaw, log: NOOP_LOG }, doc, raw, `${name}#raw`)).toBe(true)
        // 正确口径
        expect(
          adoptLoadedDocument({ kernel: viaPlain, log: NOOP_LOG }, doc, plainRootOf(raw), `${name}#plain`),
        ).toBe(true)
        expect(canon(viaRaw.fidelityFieldMapOf()), `${name}：两条入口的保真记录必须一致（幂等归一化）`).toBe(
          canon(viaPlain.fidelityFieldMapOf()),
        )
        // 反空洞真：归一化**真的做了事** —— 否则本组与"两边都错"无法区分
        expect(viaPlain.fidelityFieldMapOf(), '前提：本夹具确有保真字段').not.toEqual({})
        // 污染面：信封结构键**不得**出现在保真记录里（它们不是文档字段）
        for (const k of ['payload', 'payloadEncoding', 'payloadNote']) {
          expect(
            (viaRaw.fidelityFieldMapOf() ?? {})[k],
            `信封结构键 ${k} 不得被当作"未知顶层字段"（否则整份 base64 正文会被写回 Plain 产物根）`,
          ).toBeUndefined()
        }
        // 丢失面：源里的真字段**必须**在保真记录里（旧行为把它们丢了）
        for (const k of Object.keys(viaPlain.fidelityFieldMapOf() ?? {})) {
          expect(plainRootOf(raw)?.[k], `保真键 ${k} 必须来自源 plain 根`).toBeDefined()
        }
      } finally {
        viaRaw.dispose()
        viaPlain.dispose()
      }
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    '**负对照**：绕过边界（直接喂 raw 给装配）⇒ 必然**污染 + 丢失**（证明边界承重）',
    async () => {
    const raw = rawOf('envelope')
    const parsed = await productionParsers().detectAndParse(raw)
    // 直接调装配（**绕过** `adoptLoadedDocument` 的归一化）
    const assembled = assembleKernelDocument({ doc: parsed.document as never, plainRoot: raw })
    expect(assembled.ok).toBe(true)
    if (!assembled.ok) return
    const keys = Object.keys(assembled.value.unknownFields)
    // ① 污染：信封结构键进了"未知顶层字段"
    expect(keys, '**注入反例**：绕过边界时 `payload`/`payloadEncoding` 必然被当成未知顶层字段').toContain('payload')
    expect(keys).toContain('payloadEncoding')
    // ② 丢失：源里真正的 plain 字段不在保真记录里
    expect(keys, '**同时**真字段 `mode` 被漏掉（因为它不在信封根上）').not.toContain('mode')
    // 而正确口径下正好相反 —— 两条对照证明归一化是承重的，不是恒等变换
    const plain = plainRootOf(raw) as Plain
    const okAssembled = assembleKernelDocument({ doc: parsed.document as never, plainRoot: plain })
    expect(okAssembled.ok).toBe(true)
    if (!okAssembled.ok) return
    expect(Object.keys(okAssembled.value.unknownFields)).toContain('mode')
    expect(Object.keys(okAssembled.value.unknownFields)).not.toContain('payload')
    },
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑧ D9：调色板命名空间必须回**真实**值（且同尾段不同命名空间不得瞎猜）
// ─────────────────────────────────────────────────────────────────────────────

describe('⑧ D9：调色板命名空间回真实值', () => {
  for (const name of FIXTURES) {
    fixtureIt(name, `**命名空间**（${name}）：产物调色板的 \`registryId\` 与 legacy **逐条相同**（真实命名空间未被改写）`, async () => {
      const { session, legacy } = await loaded(name)
      try {
        const projected = projectKernelSaveView(session)
        expect(projected.ok).toBe(true)
        if (!projected.ok) return
        const K = projected.plain as Plain
        const L = legacy.serialize() as Plain
        const ridsOf = (doc: Plain): string[] => {
          const bp = doc.blockPalette as Plain[] | undefined
          return (bp ?? []).map((e) => String(e.registryId))
        }
        expect(ridsOf(K), '顶层调色板的 registryId 序列必须逐条相同').toEqual(ridsOf(L))
        // 帧内调色板同理（帧为主的网格写在 `frames[].structure`）
        const frameRids = (doc: Plain): string[][] =>
          ((doc.frames ?? []) as Plain[]).map((f) =>
            (((f.structure ?? {}) as Plain).blockPalette as Plain[] | undefined)?.map((e) => String(e.registryId)) ?? [],
          )
        expect(frameRids(K), '帧内调色板的 registryId 序列必须逐条相同').toEqual(frameRids(L))
        // 反空洞真：命名空间化的条目**确实存在**，且旧行为下**确实会**被改写
        const namespaced = ridsOf(L).filter((r) => !r.startsWith('minecraft:') && r !== 'air')
        if (namespaced.length > 0) {
          const rewritten = ridsOf(L).filter((r) => r.startsWith('minecraft:') && r !== 'minecraft:air')
          expect(
            rewritten.some((r) => !ridsOf(K).includes(r)) || namespaced.every((r) => ridsOf(K).includes(r)),
            '非 minecraft 命名空间必须原样保留',
          ).toBe(true)
        }
      } finally {
        session.dispose()
      }
    })
  }

  it('**边界与负对照**：内容键/几何身份精确命中才采信真命名空间；名称尾段兜底**不得瞎猜**', () => {
    // 两条同尾段不同命名空间的条目（`aaa:foo@0` 与 `bbb:foo@0`）——
    // 旧行为会把单元值里的 `minecraft:foo` 写进产物（丢命名空间）；
    // 错误"修法"会拿尾段兜底命中的首条 ⇒ 把 `bbb:foo` 的格子写成 `aaa:foo`（**错**命名空间）。
    const entries: BlockPaletteEntry[] = [
      { assetId: '', registryId: 'aaa:foo', meta: 0, renderMode: 'BlockModel', geometry: null },
      { assetId: '', registryId: 'bbb:foo', meta: 0, renderMode: 'BlockModel', geometry: null },
    ]
    const cells = { '0,0,0': 'minecraft:foo:0' }
    // ① 无 `cellPalette`、无 assetId ⇒ **兜底路径不得采信**（宁可"有损但一致"）
    const guessed = projectGridCells({ cells, palette: entries })
    expect(
      String(guessed.blockPalette[1]?.registryId),
      '名称尾段兜底时不得采信类型化条目的命名空间（两个命名空间同尾段 ⇒ 猜就是引入错误身份）',
    ).toBe('minecraft:foo')
    // ② 有 `cellPalette`（内容键精确命中 `bbb:foo`）⇒ 必须回**真**值
    const exact = projectGridCells({
      cells,
      palette: entries,
      cellPalette: { '0,0,0': blockPaletteEntryKey(entries[1]!) },
    })
    expect(String(exact.blockPalette[1]?.registryId), '内容键精确命中时必须回真命名空间').toBe('bbb:foo')
    // ③ 两个命名空间同尾段 ⇒ 判据**确实**能区分（否则 ① ② 是同一个值，本组空转）
    expect(String(guessed.blockPalette[1]?.registryId)).not.toBe(String(exact.blockPalette[1]?.registryId))
  })

  it('**几何身份不唯一时不得采信**（实测 `multiblock-ebf-2ch`：机壳与控制器共享同一 `assetId`）', async () => {
    // 真夹具实测：`gregtech:gt.blockcasings@11` 与 `gregtech:gt.blockmachines@1000`
    // 的烘焙四边形逐位相同 ⇒ 同一个 `assetId`。此时"按几何身份取命名空间"
    // 只能拿到**首条**⇒ 会把控制器写成机壳（正确的 meta + 错误的命名空间）。
    const { session } = await loaded('multiblock-ebf-2ch')
    try {
      const assembled = assembleKernelDocument({
        doc: (await productionParsers().detectAndParse(rawOf('multiblock-ebf-2ch'))).document as never,
        plainRoot: plainRootOf(rawOf('multiblock-ebf-2ch')),
      })
      expect(assembled.ok).toBe(true)
      if (!assembled.ok) return
      const payload = assembled.value.scene.data['structure:multiblock:data']!.payload
      if (payload.kind !== 'blockGrid') throw new Error('非 blockGrid 载荷')
      expect(payload.palette, '前提：装配产物必须带类型化调色板').toBeDefined()
      const typedPalette = payload.palette ?? []
      // ① 前提：确实存在"两个不同 registryId 共享同一 assetId"
      const byAsset = new Map<string, Set<string>>()
      for (const e of typedPalette) {
        if (e.assetId === '') continue
        const set = byAsset.get(e.assetId) ?? new Set<string>()
        set.add(e.registryId)
        byAsset.set(e.assetId, set)
      }
      const ambiguous = [...byAsset.entries()].filter(([, s]) => s.size > 1)
      expect(ambiguous.length, '前提：本夹具确有"几何身份不唯一"的条目（否则本组空转）').toBeGreaterThan(0)
      const asset = ambiguous[0]![0]
      const cellKey = Object.keys(payload.cellGeometry ?? {}).find((k) => payload.cellGeometry?.[k] === asset)
      expect(cellKey, '前提：该几何确实被某格引用').toBeDefined()
      const expectedRid = typedPalette.find((e) => blockPaletteEntryKey(e) === payload.cellPalette?.[cellKey!])?.registryId
      // ② 生产入口（带 `cellPalette`）⇒ 必须回**该格自己**的命名空间
      const exact = projectGridCells({
        cells: payload.cells,
        geometry: payload.geometry,
        cellGeometry: payload.cellGeometry,
        cellPalette: payload.cellPalette,
        palette: payload.palette,
        cellContent: payload.cellContent,
      })
      const depthRow = exact.cellGrid[0]!.length - 1
      const pos = cellKey!.split(',').map(Number)
      const idx = exact.cellGrid[pos[2]!]![depthRow - pos[1]!]![pos[0]!]
      expect(String(exact.blockPalette[idx!]!.registryId), '带内容键时必须回该格自己的命名空间').toBe(expectedRid)
      // ③ **负对照**：**不**带 `cellPalette`（几何身份兜底）⇒ 不得采信几何身份
      //（宁可保留有损形态，也不引入"错误的命名空间 + 正确的 meta"）
      const guessed = projectGridCells({
        cells: payload.cells,
        geometry: payload.geometry,
        cellGeometry: payload.cellGeometry,
        palette: payload.palette,
        cellContent: payload.cellContent,
      })
      const gIdx = guessed.cellGrid[pos[2]!]![depthRow - pos[1]!]![pos[0]!]
      const gRid = String(guessed.blockPalette[gIdx!]!.registryId)
      expect(gRid, '无内容键时不得按几何身份猜命名空间（几何身份不唯一）').toMatch(/^minecraft:/)
      expect(gRid, '且不得等于"首条同几何条目"的命名空间').not.toBe(expectedRid)
    } finally {
      session.dispose()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑨ D10：多方块元素级扩展键保真
// ─────────────────────────────────────────────────────────────────────────────

describe('⑨ D10：多方块元素级扩展键保真（保存一次不再丢）', () => {
  /** 类型化**有名字段**（其余键都是"只活在源节点里"的扩展键）。 */
  const NAMED = {
    variants: ['key', 'totalTier', 'values', 'runstate'],
    runstates: ['id', 'name', 'kind'],
    notes: ['id', 'text'],
  } as const

  for (const name of ['multiblock-tier-only', 'multiblock-ebf-2ch', 'multiblock-lsc-overlap'] as const) {
    it(`**元素扩展键**（${name}）：\`variants[].height\` 等逐条保留且与源**逐字相同**`, async () => {
      const { session, legacy, plainRoot } = await loaded(name)
      try {
        const source = plainRoot.multiblock as Plain
        const projected = projectKernelSaveView(session)
        expect(projected.ok).toBe(true)
        if (!projected.ok) return
        const mb = (projected.plain as Plain).multiblock as Plain
        // ① 源里存在、旧实现会丢的键：逐条与源相同
        const srcVariants = source.variants as Plain[]
        const outVariants = mb.variants as Plain[]
        expect(outVariants.length, '变体条数必须与源相同').toBe(srcVariants.length)
        for (let i = 0; i < srcVariants.length; i++) {
          for (const k of Object.keys(srcVariants[i]!)) {
            if (k === 'raw') continue
            expect(
              canon(outVariants[i]?.[k]),
              `variants[${i}].${k} 必须保留（源里有就该在产物里）`,
            ).toBe(canon(srcVariants[i]![k]))
          }
        }
        const extKeys = (arr: Plain[] | undefined, named: readonly string[]): string[] => {
          const s = new Set<string>()
          for (const e of arr ?? []) for (const k of Object.keys(e)) if (!named.includes(k) && k !== 'raw') s.add(k)
          return [...s].sort()
        }
        for (const [field, named] of [
          ['variants', NAMED.variants],
          ['runstates', NAMED.runstates],
          ['notes', NAMED.notes],
        ] as const) {
          const srcExt = extKeys(source[field] as Plain[], named)
          const outExt = extKeys(mb[field] as Plain[], named)
          expect(outExt, `${field} 的扩展键集必须与源相同（旧的"只留类型化字段"会清空它）`).toEqual(srcExt)
        }
        // 骨架阶同理（`sizeSteps[].{channel,layers,w,hh,d,roles}`）
        const srcSteps = ((source.backbone ?? {}) as Plain).sizeSteps as Plain[] | undefined
        const outSteps = ((mb.backbone ?? {}) as Plain).sizeSteps as Plain[] | undefined
        if (Array.isArray(srcSteps) && srcSteps.length > 0) {
          expect(outSteps?.[0], '骨架阶必须保留').toBeDefined()
          for (const k of Object.keys(srcSteps[0]!)) {
            if (k === 'raw' || k === 'cellGrid') continue
            expect(canon(outSteps?.[0]?.[k]), `sizeSteps[0].${k} 必须保留`).toBe(canon(srcSteps[0]![k]))
          }
        }
        // ② 与 legacy 一致（legacy 是从源原样透传的）
        expect(canon(mb.variants), '变体条目必须与 legacy **逐字**相同').toBe(
          canon((legacy.serialize() as Plain).multiblock && ((legacy.serialize() as Plain).multiblock as Plain).variants),
        )
      } finally {
        session.dispose()
      }
    })
  }

  it('**负对照**：旧的"只留类型化有名字段"实现**必然**丢扩展键（证明本组不空转）', async () => {
    const { session } = await loaded('multiblock-tier-only')
    try {
      const projected = projectKernelSaveView(session)
      expect(projected.ok).toBe(true)
      if (!projected.ok) return
      const variants = ((projected.plain as Plain).multiblock as Plain).variants as Plain[]
      // 现行（修好后）：有 `height`
      expect(Object.keys(variants[0]!), '修好后必须带 `height`').toContain('height')
      // 旧实现形态：`{...rest}`（只留类型化有名字段）⇒ `height` 消失
      const oldShape = Object.fromEntries(
        Object.entries(variants[0]!).filter(([k]) => (NAMED.variants as readonly string[]).includes(k)),
      )
      expect(Object.keys(oldShape), '**注入反例**：旧形态下 `height` 必然缺席 ⇒ 保存一次就丢').not.toContain('height')
      expect(Object.keys(oldShape).sort()).toEqual(['key', 'runstate', 'totalTier', 'values'])
    } finally {
      session.dispose()
    }
  })

  it('**迭代幂等**：扩展键保留**不**引入往返膨胀（`projectionFidelity` 的判据面）', async () => {
    const { session } = await loaded('multiblock-lsc-overlap')
    try {
      const p1 = projectKernelSaveView(session)
      expect(p1.ok).toBe(true)
      if (!p1.ok) return
      const bytes1 = JSON.stringify(p1.plain).length
      // 第二轮：把产物当新源，重新装配 + 投影
      const reparsed = await productionParsers().detectAndParse(p1.plain as Plain)
      expect(reparsed.document, '产物必须可读回').not.toBeNull()
      const s2 = new KernelSession({ documentId: KERNEL_DOCUMENT_ID, contextId: KERNEL_CONTEXT_ID, capabilities: [] })
      try {
        expect(
          adoptLoadedDocument({ kernel: s2, log: NOOP_LOG }, reparsed.document as never, plainRootOf(p1.plain), 'round2'),
        ).toBe(true)
        const p2 = projectKernelSaveView(s2)
        expect(p2.ok).toBe(true)
        if (!p2.ok) return
        const bytes2 = JSON.stringify(p2.plain).length
        // 收敛判据：第 2 轮不得"嵌套增长"（旧的元素级 `raw` 泄漏是每轮 +N 层）
        expect(bytes2, `往返必须收敛（第 1 轮 ${bytes1} B → 第 2 轮 ${bytes2} B）`).toBe(bytes1)
        expect(canon(p2.plain), '第 2 轮产物必须与第 1 轮**逐字**相同（幂等）').toBe(canon(p1.plain))
      } finally {
        s2.dispose()
      }
    } finally {
      session.dispose()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑩ 装配面三态（未采集 / 多帧 / 卸载清空）
// ─────────────────────────────────────────────────────────────────────────────

describe('⑩ 装配面三态（未采集／多帧／卸载清空）', () => {
  it('**未采集**：新会话的装配面是 `null`（不是"零帧"）', () => {
    const s = new KernelSession({ documentId: KERNEL_DOCUMENT_ID, contextId: KERNEL_CONTEXT_ID, capabilities: [] })
    try {
      expect(s.assemblyFaceOf(), '`null` = 未采集（与"零帧"是不同的语义）').toBeNull()
      expect(s.fidelityFieldMapOf(), '保真字段同理：`null` = 未采集').toBeNull()
    } finally {
      s.dispose()
    }
  })

  withRealFixture(
    'structureDataExportedEnvelope',
    '**多帧**：装配后装配面 = 装配产物的帧对象映射（逐项相同）',
    async () => {
    const { session, raw } = await loaded('envelope')
    try {
      const parsed = await productionParsers().detectAndParse(raw)
      const assembled = assembleKernelDocument({
        doc: parsed.document as never,
        plainRoot: plainRootOf(raw),
      })
      expect(assembled.ok).toBe(true)
      if (!assembled.ok) return
      const face = session.assemblyFaceOf()
      expect(face, '装配成功后装配面必须已采集').not.toBeNull()
      expect(face?.frameObjects, '帧对象映射必须与装配产物逐项相同').toEqual([...assembled.value.frameObjects])
      expect(face?.frameObjects.length, '真实信封必须多帧（否则本组是常数比较）').toBeGreaterThan(0)
      expect(face?.multiblock, '帧为主文档的多方块投影面必须是 `null`').toBeNull()
    } finally {
      session.dispose()
    }
    },
  )

  it('**卸载清空**：`markUnloaded` 后装配面与保真字段都回到"未采集"（防串档）', async () => {
    const { session } = await loaded('multiblock-tier-only')
    try {
      expect(session.assemblyFaceOf(), '前提：卸载前已采集').not.toBeNull()
      const hadFidelity = session.fidelityFieldMapOf()
      expect(hadFidelity, '前提：卸载前已采集保真字段').not.toBeNull()
      expect(Object.keys(hadFidelity ?? {}).length, '前提：保真字段非空').toBeGreaterThan(0)
      session.markUnloaded()
      expect(session.assemblyFaceOf(), '卸载后装配面必须回到 `null`（否则换文档会拿旧帧映射重建 = 串档）').toBeNull()
      expect(session.fidelityFieldMapOf(), '卸载后保真字段必须回到 `null`（否则旧文档的未知字段会写进新产物）').toBeNull()
      expect(session.hasAdoptedContent(), '卸载后 GF-16 必须为假').toBe(false)
    } finally {
      session.dispose()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑪ `plainForSave` 的 `source` 分流（回落必须**可观测**）
// ─────────────────────────────────────────────────────────────────────────────

describe('⑪ `plainForSave` 的 `source` 分流（唯一分流点 + 可观测）', () => {
  withRealFixture(
    'structureDataExportedEnvelope',
    '**内核权威 ⇒ `source: "kernel"`**，且产物 = 内核投影',
    async () => {
    const { session, legacy, raw } = await loaded('envelope')
    try {
      const host = makeAdoptedKernelReadHost(legacy as unknown as RuntimeDocument, plainRootOf(raw))
      try {
        const r = host.ctx.plainForSave()
        expect(r.source, '装配成功时必须以内核为权威').toBe('kernel')
        expect(r.plain, '内核权威时必须有产物').not.toBeNull()
        // 与直接投影同源（同一实现，不是第二份拼装）
        const direct = projectKernelSaveView(host.session)
        expect(direct.ok).toBe(true)
        if (direct.ok) expect(canon(r.plain)).toBe(canon(direct.plain))
      } finally {
        host.dispose()
      }
    } finally {
      session.dispose()
    }
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    '**无会话 ⇒ 不再回落**：`plain: null` + `reason: "no-session"`（R1-β① C5 断言翻转）',
    async () => {
    const { session, legacy } = await loaded('envelope')
    try {
      const host = makeKernelReadHost(legacy as unknown as RuntimeDocument)
      const r = host.ctx.plainForSave()
      // 负对照（区分力所在）：旧文档这一刻**确实**有内容 —— 故下面的 `null`
      // 不是"本来就没东西可存"，而是"不再拿另一条权威顶上"。
      const legacyPlain = legacy.serialize() as Plain
      expect(Object.keys(legacyPlain).length, '负对照前提：旧文档有内容').toBeGreaterThan(0)
      expect(r.source, '保存权威唯一（`source: "legacy"` 分支已于 C5 删除）').toBe('kernel')
      expect(r.plain, '无会话 ⇒ 无内容可存（**不**静默改写成另一份产物）').toBeNull()
      expect(r.reason, '成因必须**可判定**，不是一句空话').toBe('no-session')
      host.dispose()
    } finally {
      session.dispose()
    }
    },
  )

  it('**有会话但未装配 ⇒ `plain: null` + `reason: "not-adopted"`**（断言翻转）', async () => {
    // 真 `Context` 实例（只注入读面所需的两件），跑的是**生产** `plainForSave`。
    const { doc } = await legacyDocForTest()
    const fresh = new KernelSession({ documentId: KERNEL_DOCUMENT_ID, contextId: KERNEL_CONTEXT_ID, capabilities: [] })
    const docRef = ref(doc) as unknown as Ref<RuntimeDocument | null>
    const ctx = Object.create(Context.prototype) as Context
    Object.assign(ctx as unknown as Record<string, unknown>, { main: { doc: docRef }, kernel: fresh })
    try {
      expect(fresh.hasAdoptedContent(), '前提：未装配').toBe(false)
      const r = ctx.plainForSave()
      expect(r.source).toBe('kernel')
      expect(r.plain, '未装配 ⇒ 无内容可存（原实现在此回落旧文档产物）').toBeNull()
      expect(r.reason).toBe('not-adopted')
      // 负对照（区分力）：旧文档在这一刻**确实**能产出产物 ⇒ 上面那条 `null` 有区分力。
      expect(Object.keys(doc.serialize() as Plain).length, '负对照前提：旧文档有内容').toBeGreaterThan(0)
    } finally {
      fresh.dispose()
    }
  })

  it('**无会话且无旧文档 ⇒ `plain: null`**（不伪造空产物）', () => {
    const host = makeKernelReadHost(null)
    const r = host.ctx.plainForSave()
    expect(r.source).toBe('kernel')
    expect(r.reason).toBe('no-session')
    expect(r.plain, '无内容可存 ⇒ `null`（而不是一份"看起来能用"的空产物）').toBeNull()
    host.dispose()
  })

  /**
   * **负对照：旁路若被恢复，本组判红**（R1-β① C5）。
   *
   * 上面三条证明的是"新形态成立"；本条证明的是"**留了旁路能被抓住**"——
   * 一个只证明"新路径能用"的判据无法区分"删干净了"与"悄悄回落到旧载体"。
   *
   * 口径：`Context#plainForSave` 的实现区里**不得**再出现旧权威的两件标志物
   * （`main.doc.value` 取值 + `'legacy'` 来源字面量）。实测过该判据的区分力：
   * 把回落分支加回去 ⇒ 两条 `not.toContain` 立刻判红。
   *
   * ⚠️ CRLF：本仓 `core.autocrlf=true`，源码文本判据先归一化。
   */
  it('**负对照**：`plainForSave` 的实现区不得再含旧权威取值与 `legacy` 来源', () => {
    const src = fs
      .readFileSync(path.join(process.cwd(), 'src', 'runtime', 'context.ts'), 'utf8')
      .replace(/\r\n/g, '\n')
    const start = src.indexOf('plainForSave():')
    expect(start, '`plainForSave` 必须在案').toBeGreaterThan(-1)
    // 实现区的结束锚 = **本方法后面的下一个类成员 JSDoc**（`\n  /**`，恰两个空格）。
    //
    // ⚠️ R2/S3 修锚：原锚是 `\n  private kernelAdoptedFrames`，于是切片**跨过了
    // 中间新增的多个读面**（`kernelSourceRoot`/`kernelMultiblockBody`/
    // `kernelMultiblockDeclaration`…）。它们各自可以有**合法的**响应式读取
    // （`void this.main.doc.value` 是 `Context` 读面的既有形态），从而让本条
    // 误判成"plainForSave 又取旧载体"。改成"下一个成员即止"后，本判据扫的
    // **确实只是 `plainForSave` 自己**（判据变精确，不是变弱）。
    const end = src.indexOf('\n  /**', start)
    expect(end, '必须能切出本方法的实现区（否则判据会扫全局而失去区分力）').toBeGreaterThan(start)
    const body = src.slice(start, end)
    expect(body, '不得再取旧载体（回落分支的取值点）').not.toContain('this.main.doc.value')
    expect(body, '不得再以 legacy 为来源').not.toContain("source: 'legacy'")
    expect(body, '必须给出可判定的成因').toContain('reason: view.reason')
  })

  it('**`kernelSaveView` 与 `plainForSave` 同源**（前者是后者的判定入口，不是第二份实现）', async () => {
    const { session, legacy, raw } = await loaded('multiblock-tier-only')
    try {
      const host = makeAdoptedKernelReadHost(legacy as unknown as RuntimeDocument, plainRootOf(raw))
      try {
        const view = host.ctx.kernelSaveView()
        expect(view.ok).toBe(true)
        if (!view.ok) return
        expect(canon(host.ctx.plainForSave().plain)).toBe(canon(view.plain))
      } finally {
        host.dispose()
      }
    } finally {
      session.dispose()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 保留：全保真注解（实测的能力回退风险）+ 如实降级
// ─────────────────────────────────────────────────────────────────────────────

describe('⑫ 全保真：注解字段经投影**不丢**（实测的能力回退风险）', () => {
  it('**注入式**：内核里有 `locked`/`created_at` 时，投影产物必须带上它们', () => {
    const session = new KernelSession({
      documentId: KERNEL_DOCUMENT_ID,
      contextId: KERNEL_CONTEXT_ID,
      capabilities: ALL_CAPABILITIES,
    })
    try {
      const base = createDocument(KERNEL_DOCUMENT_ID, { sceneId: 'annot-scene' })
      // 一个带**全字段**几何的注解对象。
      const obj = {
        id: 'annotation:ann-1',
        type: 'annotation' as const,
        name: 'ann-1',
        visible: true,
        dataId: 'annotation:ann-1:data',
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      }
      const data = {
        id: 'annotation:ann-1:data',
        source: 'document' as const,
        payload: {
          kind: 'annotation' as const,
          shape: 'box',
          text: 'T\n\nD',
          geometry: {
            min: { x: 0, y: 0, z: 0 },
            max: { x: 1, y: 1, z: 1 },
            color: '#ff0000',
            renderStyle: 'solid',
            locked: true,
            frameIndex: 2,
            createdAt: 111,
            updatedAt: 222,
          },
        },
      }
      const scene = { id: 'annot-scene', objects: { [obj.id]: obj }, data: { [data.id]: data }, collections: {}, order: [obj.id] }
      const withSceneDoc = withContent(base, scene as never, base.animation)
      const adopted = withDocumentContent(withSceneDoc.doc, withSceneDoc.doc.content).doc
      session.adoptDocument(adopted, adopted.content)
      // 装配面：本用例手工造会话 ⇒ 显式给出帧映射（否则投影按 scene.order 推导，
      // 而这里有注解对象 ⇒ 会把注解当帧！⇒ 必须显式给）。
      session.setAssemblyFace({ frameObjects: [], multiblock: null })

      const projected = projectKernelSaveView(session)
      expect(projected.ok, '投影必须成功').toBe(true)
      if (!projected.ok) return
      const rows = (projected.plain as Plain).annotations as Plain[]
      expect(rows.length, '必须投出 1 条注解').toBe(1)
      const row = rows[0]!
      // 渲染态投影**只会**给这 5 个字段；下面每一个"额外"字段都是全保真的证据。
      expect(row.id).toBe('ann-1')
      expect(row.type).toBe('box')
      expect(row.visible).toBe(true)
      expect(row.title).toBe('T')
      expect(row.description).toBe('D')
      expect(row.locked, '`locked` = "锁定即只读"的判定依据，丢了会**静默可写**').toBe(true)
      expect(row.frameIndex, '`frameIndex` 丢了会让注解跑到错误的帧上').toBe(2)
      expect(row.created_at, '蛇形命名是**格式约定**（正向映射的另一半）').toBe(111)
      expect(row.updated_at).toBe(222)
      expect(row.color).toBe('#ff0000')
      expect(row.renderStyle).toBe('solid')
      expect(row.min).toEqual({ x: 0, y: 0, z: 0 })
      expect(row.max).toEqual({ x: 1, y: 1, z: 1 })
    } finally {
      session.dispose()
    }
  })
})

describe('⑬ 如实降级（不伪造产物）', () => {
  it('**无会话 ⇒ `ok: false`**（调用方回落 legacy；不返回空产物）', () => {
    const r = projectKernelSaveView(null)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('no-session')
  })

  it('**未装配 ⇒ `ok: false`**（内核不是权威）', () => {
    const s = new KernelSession({
      documentId: KERNEL_DOCUMENT_ID,
      contextId: KERNEL_CONTEXT_ID,
      capabilities: ALL_CAPABILITIES,
    })
    try {
      const r = projectKernelSaveView(s)
      expect(r.ok, '未装配必须如实失败 —— 返回空产物会让用户存下**空文件**').toBe(false)
      if (r.ok) return
      expect(r.reason).toBe('not-adopted')
    } finally {
      s.dispose()
    }
  })
})

/** 一份最小的**合法**旧文档（⑪ 的"有会话但未装配"用例只需一个能 `serialize()` 的实例）。 */
async function legacyDocForTest(): Promise<{ doc: RuntimeDocument }> {
  const raw: Plain = {
    format_version: '2.0',
    id: 'plain-doc',
    meta: { name: 'P', author: '', description: '', tags: [], origin: { x: 0, y: 0, z: 0 } },
    frames: [],
    annotations: [],
    labels: [],
  }
  // 走**生产解析器**入口（不手搓 `RuntimeDocument` 实例 —— 那会绕开解析判据）。
  const parsed = await productionParsers().detectAndParse(raw)
  if (parsed.document === null || parsed.document === undefined) throw new Error('测试用最小文档解析失败')
  return { doc: parsed.document as unknown as RuntimeDocument }
}

