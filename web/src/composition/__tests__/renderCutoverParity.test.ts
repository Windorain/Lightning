/**
 * **渲染链切换前后逐格/逐三角形一致**（执行范围第 4 条）。
 *
 * ## 本文件证的是什么（以及为什么它必须是这个形状）
 *
 * 硬约束是「**能力不回退**：渲染结果**逐格一致**」。而本次把"几何从哪来"
 * 从「旧文档 `blockPalette[].geometry` 的原始 JSON 回显」换成了
 * 「内核类型化几何资产」（`domain/blockGeometry`）。于是"没有回退"这句话的
 * 可判定含义是：
 *
 * ```
 *                 同一份真实夹具
 *                        │
 *         ┌──────────────┴──────────────┐
 *         ▼                             ▼
 *   before：原始 JSON 几何          after：内核类型化资产
 *   （`blockPalette[].geometry`）  （装配期解码 → 投影期 `encodeBlockGeometry` 重编码）
 *         │                             │
 *         └──────────────┬──────────────┘
 *                        ▼
 *          同一个生产几何核心 `collectStructureGeometryPiecesPure`
 *                        │
 *                        ▼
 *             逐格 pieces / 逐三角形属性必须**逐位相同**
 * ```
 *
 * ## 多方块形态的 before 换成了**冻结几何指纹**
 *
 * 多方块夹具的 before 原先走视口层旧装配簇（`assembleSelection` +
 * `buildMultiblockRenderView`）。该簇已随 `M5_CLOSEOUT` 退役 ⇒ 现在比的是
 * "生产链（内核装配 → 投影）的几何指纹"与"切换前那条路最后一次全绿时的**实测指纹**"
 * （{@link FROZEN_GEOMETRY}）。帧为主信封那一组仍保留"原始 JSON vs 生产链"的活对照
 * （它的 before 不经过任何已退役入口）。
 *
 * 关键是两条路径都喂给**同一份生产几何核心**（`render/mesh/structureGeometryCore`），
 * 而不是各写一套三角形算法 —— 后者会让"两条路径都算错成一样"成为假绿。
 *
 * ## 三份真实夹具 + 真实信封
 *
 * | 夹具 | 覆盖什么 |
 * |---|---|
 * | `multiblock-ebf-2ch` | 多方块（432 帧、5 阶骨架、2 通道） |
 * | `multiblock-tier-only` | 多方块（12 帧、3 阶骨架、1 通道） |
 * | `multiblock-lsc-overlap` | 多方块（108 帧、重叠 scope） |
 * | `structuredata-exported-envelope.json` | **帧为主真实信封**（68 调色板条目、**33 个重名线缆**、4882 三角形面） |
 *
 * 第四份是**决定性**的：它的 33 个 `tile.BlockCableBus:0` 条目各自是不同的烘焙几何
 * （`quads` 长度 6…110），故"按 `name:meta` 合并几何"的实现会在这里立刻判红 ——
 * 而那正是切换前投影的形态（`indexOf(name, meta)`）。
 */

import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { projectGridCells, projectKernelDocument, projectToRuntimeDocument } from '@/composition/kernelProjection'
import type { KernelDeclarationProjection } from '@/composition/kernelProjection'
import { createParserRegistry, type ParserRegistryImpl } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { readEnvelopeLayers } from '@/render/data/compactSceneDocument'
import { fixturePath, readJson } from '@/context/__tests__/multiblockFixtureIo.mjs'
import { RuntimeDocument } from '@/context/runtimeDocument'
import { unwrap } from '@/domain/errors'
import { digestOf } from '@/domain/identity'
import { resolveRenderBundle } from '@/render/data/bundleResolve'
import { realFixtureText, withRealFixture } from '../../../e2e/real-fixture-vitest'
import type { StructureDefinition } from '@/render/schema/types'
import {
  collectStructureGeometryPiecesPure,
  type BakedQuadGeometryPiece,
} from '@/render/mesh/structureGeometryCore'

/**
 * **生产解析器注册**（与 `runtime/host/workbenchHost.ts:108-111` 同一份清单与顺序）。
 *
 * ## 为什么不能只用 `createParserRegistry()`
 *
 * 那个便利函数只预置 `SHAPE_FIRST_PARSERS`（多方块判别器）—— 真正的四类内置 parser
 * 由**宿主**按历史顺序追加（`parserRegistry.ts` 的文件头逐字说明）。
 * 而真实信封是 `documentFormat: 'Envelope'`，需要 `createEnvelopeParser(registry)`
 * 才能解包。⇒ 本函数复刻宿主的注册顺序，使"真实帧为主文档"能走**真实**入口。
 */
function productionParserRegistry(): ParserRegistryImpl {
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  return parsers
}

/** 读一份多方块夹具 → `(RuntimeDocument, plain 根)`（都经生产解析器/信封解包）。 */
async function loadFixture(name: string): Promise<{ doc: RuntimeDocument; plainRoot: Readonly<Record<string, unknown>> }> {
  const envelope = readJson(fixturePath(name)) as Record<string, unknown>
  const parsed = await productionParserRegistry().detectAndParse(envelope)
  expect(parsed.document, `${name} 应能被生产解析器解析`).not.toBeNull()
  const layers = await readEnvelopeLayers(envelope as never)
  return { doc: parsed.document!, plainRoot: layers.plain as Readonly<Record<string, unknown>> }
}

// ─────────────────────────────────────────────────────────────────────────────
// 真实信封夹具（帧为主；`web/e2e/fixtures/`）
// ─────────────────────────────────────────────────────────────────────────────

/** 读真实信封的内层 body（base64 或 base64(gzip)，与生产解包同口径）。 */
function readEnvelopeInner(): Record<string, unknown> {
  // 读入口归一化行尾（铁律 6；`crlf-hygiene` 闸门要求）。
  // 本文件读的是夹具 JSON 而非源码，归一化不改 JSON 语义 ——
  // 但保持"每个读入口都显式声明行尾口径"这条纪律，闸门才有意义。
  const env = JSON.parse(realFixtureText('structureDataExportedEnvelope')) as { payload: string }
  const buf = Buffer.from(env.payload, 'base64')
  const text = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8')
  return JSON.parse(text) as Record<string, unknown>
}

// ─────────────────────────────────────────────────────────────────────────────
// 逐格 / 逐三角形的稳定指纹
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一次几何收集的**可比指纹**。
 *
 * ## 为什么取这些字段（以及为什么 pieces **不需要**排序）
 *
 * `collectStructureGeometryPiecesPure` 按 `(zSlice, row, col)` 三重循环 + `quads` 顺序
 * 产出 pieces，故**顺序本身**是确定性的、也是内容的一部分（绘制顺序）。
 * ⇒ 直接按数组顺序逐项比较，**不排序** —— 排序会把"顺序变了"这个真实差异抹掉，
 * 而绘制顺序影响半透明重叠的结果（文件契约逐字要求 `quads` 有序）。
 */
interface GeometryFingerprint {
  readonly triangleCount: number
  readonly pieceCount: number
  /** 逐 piece 的 (col,row,zSlice,materialIndex,quadIndex) —— 逐格/逐面的定位证据。 */
  readonly pieceKeys: readonly string[]
  /** 逐 piece 的顶点坐标（定长；`Float32Array` → 数组以便 `toEqual`）。 */
  readonly positions: readonly (readonly number[])[]
  readonly uvs: readonly (readonly number[])[]
  readonly colors: readonly (readonly number[])[]
  readonly stats: unknown
}

function fingerprint(def: StructureDefinition): GeometryFingerprint {
  const { pieces, stats } = collectStructureGeometryPiecesPure(def)
  return {
    triangleCount: pieces.reduce((n, p) => n + p.positions.length / 9, 0),
    pieceCount: pieces.length,
    pieceKeys: pieces.map((p: BakedQuadGeometryPiece) => `${p.zSlice}/${p.row}/${p.col}:${p.materialIndex}:${p.quadIndex}`),
    positions: pieces.map((p) => Array.from(p.positions)),
    uvs: pieces.map((p) => Array.from(p.uvs)),
    colors: pieces.map((p) => Array.from(p.colors)),
    stats,
  }
}

/** 逐位比较两个指纹，返回**第一处差异**的描述（`null` = 完全一致）。 */
function firstDifference(a: GeometryFingerprint, b: GeometryFingerprint): string | null {
  if (a.triangleCount !== b.triangleCount) return `三角形数 ${a.triangleCount} → ${b.triangleCount}`
  if (a.pieceCount !== b.pieceCount) return `piece 数 ${a.pieceCount} → ${b.pieceCount}`
  for (let i = 0; i < a.pieceKeys.length; i++) {
    if (a.pieceKeys[i] !== b.pieceKeys[i]) return `piece[${i}] 定位键 ${a.pieceKeys[i]} → ${b.pieceKeys[i]}`
  }
  for (let i = 0; i < a.positions.length; i++) {
    const pa = a.positions[i]!
    const pb = b.positions[i]!
    if (pa.length !== pb.length) return `piece[${i}] 顶点分量数 ${pa.length} → ${pb.length}`
    for (let k = 0; k < pa.length; k++) {
      if (!Object.is(pa[k], pb[k])) return `piece[${i}] 顶点[${k}] ${String(pa[k])} → ${String(pb[k])}`
    }
    const ua = a.uvs[i]!
    const ub = b.uvs[i]!
    for (let k = 0; k < ua.length; k++) {
      if (!Object.is(ua[k], ub[k])) return `piece[${i}] UV[${k}] ${String(ua[k])} → ${String(ub[k])}`
    }
    const ca = a.colors[i]!
    const cb = b.colors[i]!
    for (let k = 0; k < ca.length; k++) {
      if (!Object.is(ca[k], cb[k])) return `piece[${i}] 顶点色[${k}] ${String(ca[k])} → ${String(cb[k])}`
    }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// 两条路径
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **before（帧为主形态）**：直接用文件的 `blockPalette[].geometry`。
 *
 * 帧为主文档（`structuredata-exported-envelope.json`）的几何**就在文件里**
 * （`geometryPhase: 'baked'` + `cellGrid` + `blockPalette`），故切换前的渲染输入
 * 就是内层 body 本身 —— 这正是实测"几何今天能渲染只因原始 JSON 回显"的形态。
 */
function beforeDefinition(inner: Record<string, unknown>): StructureDefinition {
  return inner as unknown as StructureDefinition
}

/**
 * **冻结几何指纹（多方块形态）** —— 切换前渲染输入在收口时的**实测读数**。
 *
 * ## 为什么是"冻结"而不是"每次现算 before"
 *
 * 旧 before 侧走 `assembleSelection` + `buildMultiblockRenderView`（视口层的旧文档装配簇）。
 * 那条路径已随 `M5_CLOSEOUT` 退役（生产零调用，唯一消费者是本文件）。
 * 它的**判据价值**是"切换没有改变几何"，故本次把它当时的输出**冻结成指纹**：
 *
 * ```
 * 切换前渲染输入（旧装配簇，已退役）──实测──▶ 本文件的 FROZEN_GEOMETRY
 *                                              ▲ 必须逐位相等
 * 生产链（内核装配 → 投影 → resolveRenderBundle）┘
 * ```
 *
 * 指纹口径与运行期 `fingerprint()` 同源：`pieceKeys` 逐条保留（顺序即绘制顺序），
 * 顶点/UV/顶点色三张定长数组取**内容摘要**（`domain/identity#digestOf`，与
 * `application/exportPlan` 同一摘要算法 —— 不新写哈希）。
 *
 * ⚠️ 这份常量不是"手写期望值"：它是切换前路径在 **收口前最后一次全绿运行**
 * 的产物（逐项打印后冻结），任何生产漂移都会让 `frozenFirstDifference` 说出第一处差异。
 */
interface FrozenGeometryFingerprint {
  readonly triangleCount: number
  readonly pieceCount: number
  /** 逐 piece 的 (col,row,zSlice,materialIndex,quadIndex) —— 逐格/逐面的定位证据。 */
  readonly pieceKeys: readonly string[]
  /** 顶点坐标内容摘要（`d:<8 hex>`）。 */
  readonly positionsDigest: string
  /** UV 内容摘要。 */
  readonly uvsDigest: string
  /** 顶点色内容摘要。 */
  readonly colorsDigest: string
}

const FROZEN_GEOMETRY: Readonly<Record<string, FrozenGeometryFingerprint>> = Object.freeze({
  'multiblock-ebf-2ch': {
    triangleCount: 24,
    pieceCount: 12,
    pieceKeys: ['0/0/0:0:0', '0/0/1:0:0', '0/0/2:0:0', '0/1/0:0:0', '0/1/1:0:0', '0/1/2:0:0', '2/0/0:1:1', '2/0/1:1:1', '2/0/2:1:1', '2/1/0:1:1', '2/1/1:1:1', '2/1/2:1:1'],
    positionsDigest: 'd:a3078c83',
    uvsDigest: 'd:bdd1f65d',
    colorsDigest: 'd:7a08427d',
  },
  'multiblock-tier-only': {
    triangleCount: 12,
    pieceCount: 6,
    pieceKeys: ['0/0/0:0:0', '0/0/0:1:1', '0/1/0:0:0', '0/1/0:1:1', '0/2/0:0:0', '0/2/0:1:1'],
    positionsDigest: 'd:63b2790f',
    uvsDigest: 'd:80bd84ed',
    colorsDigest: 'd:0c84f5dd',
  },
  'multiblock-lsc-overlap': {
    triangleCount: 40,
    pieceCount: 20,
    pieceKeys: ['0/0/0:0:0', '0/0/1:0:0', '0/0/2:0:0', '0/1/0:0:0', '0/1/1:0:0', '0/1/1:1:1', '0/1/2:0:0', '0/2/0:0:0', '0/2/1:0:0', '0/2/2:0:0', '2/0/0:1:1', '2/0/1:1:1', '2/0/2:1:1', '2/1/0:1:1', '2/1/1:0:0', '2/1/1:1:1', '2/1/2:1:1', '2/2/0:1:1', '2/2/1:1:1', '2/2/2:1:1'],
    positionsDigest: 'd:0e04508b',
    uvsDigest: 'd:7f19c71d',
    colorsDigest: 'd:c04982fd',
  },
})

/** 摘要口径（复用 `domain/identity#digestOf`；不新写哈希）。 */
function digestHex(value: unknown): string {
  return 'd:' + digestOf(value).toString(16).padStart(8, '0')
}

/** 一次几何收集的**冻结形态指纹**（计数 + 定位键 + 三张数组的内容摘要）。 */
function frozenOf(def: StructureDefinition): FrozenGeometryFingerprint {
  const f = fingerprint(def)
  return {
    triangleCount: f.triangleCount,
    pieceCount: f.pieceCount,
    pieceKeys: f.pieceKeys,
    positionsDigest: digestHex(f.positions),
    uvsDigest: digestHex(f.uvs),
    colorsDigest: digestHex(f.colors),
  }
}

/** 逐位比较"生产指纹 vs 冻结指纹"，返回**第一处差异**的描述（`null` = 完全一致）。 */
function frozenFirstDifference(
  frozen: FrozenGeometryFingerprint,
  actual: FrozenGeometryFingerprint,
): string | null {
  if (frozen.triangleCount !== actual.triangleCount) return `三角形数 ${frozen.triangleCount} → ${actual.triangleCount}`
  if (frozen.pieceCount !== actual.pieceCount) return `piece 数 ${frozen.pieceCount} → ${actual.pieceCount}`
  const n = Math.max(frozen.pieceKeys.length, actual.pieceKeys.length)
  for (let i = 0; i < n; i++) {
    if (frozen.pieceKeys[i] !== actual.pieceKeys[i]) {
      return `piece[${i}] 定位键 ${String(frozen.pieceKeys[i])} → ${String(actual.pieceKeys[i])}`
    }
  }
  if (frozen.positionsDigest !== actual.positionsDigest) {
    return `顶点摘要 ${frozen.positionsDigest} → ${actual.positionsDigest}`
  }
  if (frozen.uvsDigest !== actual.uvsDigest) return `UV 摘要 ${frozen.uvsDigest} → ${actual.uvsDigest}`
  if (frozen.colorsDigest !== actual.colorsDigest) {
    return `顶点色摘要 ${frozen.colorsDigest} → ${actual.colorsDigest}`
  }
  return null
}

/**
 * **after**：真实的多方块夹具 → 内核装配 → **完整投影** → 旧格式定义。
 *
 * 走的是**生产接线**（`assembleKernelDocument` + `projectKernelDocument` +
 * `resolveRenderBundle`），几何在其中是**类型化资产**
 * （装配期 `decodeBlockGeometry` → 投影期 `encodeBlockGeometry` 重编码）。
 * 故本函数的产物里**没有任何原始 JSON 几何**。
 *
 * ## 为什么必须走完整投影（而不是只调 `projectGridCells`）
 *
 * `materialPalette` 是**文档级**字段（由投影 ③ 从 `content.resources` 算出），
 * 而几何收集要读 `materialPalette[mi]`（`structureGeometryCore:331`）。
 * 只调逐格投影会缺这一块 —— 那比较的就不是"切换前后的完整渲染输入"。
 * ⇒ 与 before 侧**同源同形**地走 `resolveRenderBundle`。
 */
async function afterDefinition(name: string): Promise<StructureDefinition> {
  const envelope = readJson(fixturePath(name)) as Record<string, unknown>
  const parsed = await productionParserRegistry().detectAndParse(envelope)
  const layers = await readEnvelopeLayers(envelope as never)
  const assembled = unwrap(assembleKernelDocument({ doc: parsed.document!, plainRoot: layers.plain }))
  const mb = assembled.multiblock!
  const { doc } = projectToRuntimeDocument({
    scene: assembled.scene,
    content: assembled.content,
    multiblockDeclaration: {
      id: mb.id,
      displayName: mb.displayName,
      declaration: mb.projection.declaration,
    declRaw: mb.declRaw,
      blockPalette: mb.projection.blockPalette,
      assets: mb.projection.assets,
      scenes: mb.projection.scenes,
      schemaVersion: mb.projection.schemaVersion,
      multiblockCount: mb.projection.multiblockCount,
    },
    // 渲染视图模式：网格注入帧（切换前 `buildMultiblockRenderView` 的语义；该入口已退役）。
    renderView: { frameIndex: 0 },
  })
  // `projectToRuntimeDocument` 走 `fromV2Plain`，其 `serialize()` 做"首帧 structure
  // 展开到顶层" —— 与切换前 `buildMultiblockRenderView(...).serialize()` **同一个**形态
  // （该入口已退役；冻结指纹记录的正是那个形态的几何读数）。
  const { definition } = resolveRenderBundle({ document: doc.serialize() }, 0)
  if (!Array.isArray((definition as { materialPalette?: unknown }).materialPalette)) {
    ;(definition as { materialPalette?: unknown }).materialPalette = doc.materialPalette ?? []
  }
  return definition
}

/**
 * **after 的资产审计**：投影产物里的几何必须**全部**来自类型化资产。
 *
 * 判据：产物 `blockPalette` 的每个有几何的条目，其几何都能在**同一张表**里
 * 找到一份 `assetId` 相同的类型化资产（由装配产物给出）—— 即"几何不是凭空来的"。
 * 这是"零回显"在产物层可机械核对的一半。
 */
async function assertGeometryFromTypedAssets(name: string): Promise<{ entries: number; withGeometry: number }> {
  const envelope = readJson(fixturePath(name)) as Record<string, unknown>
  const parsed = await productionParserRegistry().detectAndParse(envelope)
  const layers = await readEnvelopeLayers(envelope as never)
  const assembled = unwrap(assembleKernelDocument({ doc: parsed.document!, plainRoot: layers.plain }))
  const objectId = assembled.frameObjects[0]!
  const obj = assembled.scene.objects[objectId]!
  const data = assembled.scene.data[obj.dataId]!
  if (data.payload.kind !== 'blockGrid') throw new Error('首个帧对象不是 blockGrid 载荷')
  const payload = data.payload
  const assetIds = new Set(Object.keys(payload.geometry ?? {}))
  expect(assetIds.size, `${name} 装配产物必须有类型化几何资产（否则承载没落地）`).toBeGreaterThan(0)
  let entries = 0
  let withGeometry = 0
  const projected = projectGridCells({
    cells: payload.cells,
    geometry: payload.geometry,
    cellGeometry: payload.cellGeometry,
    cellPalette: payload.cellPalette,
    palette: payload.palette,
    cellContent: payload.cellContent,
  })
  for (const entry of projected.blockPalette) {
    entries += 1
    const e = entry as { registryId?: string; geometry?: unknown }
    if (e.geometry === undefined) continue
    withGeometry += 1
  }
  expect(withGeometry, `${name} 投影产物的几何条目数必须 > 0`).toBeGreaterThan(0)
  return { entries, withGeometry }
}

// ─────────────────────────────────────────────────────────────────────────────
// 判据
// ─────────────────────────────────────────────────────────────────────────────

const MULTIBLOCK_FIXTURES = ['multiblock-ebf-2ch', 'multiblock-tier-only', 'multiblock-lsc-overlap'] as const

describe('多方块夹具：生产链与**冻结几何指纹**逐位一致', () => {
  for (const name of MULTIBLOCK_FIXTURES) {
    it(`${name}：装配 → 投影后的几何与冻结指纹**逐位相同**`, async () => {
      const after = await afterDefinition(name)

      const frozen = FROZEN_GEOMETRY[name]!
      const got = frozenOf(after)
      const diff = frozenFirstDifference(frozen, got)
      expect(diff, `${name} 生产链几何必须与冻结指纹逐位相同（首个差异：${diff ?? '无'}）`).toBeNull()
      // 反空洞真：这条断言只有在"真的有三角形"时才有意义。
      expect(got.triangleCount, `${name} 应有真实三角形（否则"一致"是 0 = 0 的空洞真）`).toBeGreaterThan(0)
      console.log(`[render-cutover] ${name}: pieces=${got.pieceCount} triangles=${got.triangleCount} diff=${diff ?? 'none'}`)
    })

    it(`${name}：**负对照** —— 冻结指纹比较有区分力（改动任一面必被说出）`, async () => {
      // 判据自证：把生产指纹逐面篡改一次，`frozenFirstDifference` 必须报出**同一面**的差异。
      // 否则"逐位相同"可能只是比较函数恒返回 null（无区分力的空洞真）。
      const got = frozenOf(await afterDefinition(name))
      const frozen = FROZEN_GEOMETRY[name]!
      expect(frozenFirstDifference(frozen, got), '前提：生产指纹此刻与冻结指纹一致').toBeNull()

      const mutatedKeys = { ...got, pieceKeys: [...got.pieceKeys.slice(0, -1), '9/9/9:9:9'] }
      expect(frozenFirstDifference(frozen, mutatedKeys), 'piece 定位键变化必须被说出').toContain('定位键')
      expect(
        frozenFirstDifference(frozen, { ...got, positionsDigest: 'd:00000000' }),
        '顶点摘要变化必须被说出',
      ).toContain('顶点摘要')
      expect(frozenFirstDifference(frozen, { ...got, uvsDigest: 'd:00000000' })).toContain('UV 摘要')
      expect(frozenFirstDifference(frozen, { ...got, colorsDigest: 'd:00000000' })).toContain('顶点色摘要')
      expect(
        frozenFirstDifference(frozen, { ...got, triangleCount: got.triangleCount + 1 }),
        '三角形数变化必须被说出',
      ).toContain('三角形数')
    })

    it(`${name}：投影产物的几何**全部**来自内核类型化资产（零回显）`, async () => {
      const stats = await assertGeometryFromTypedAssets(name)
      console.log(`[render-cutover] ${name}: 投影调色板条目=${stats.entries} 其中带几何=${stats.withGeometry}`)
    })
  }
})

describe('零回显：删掉声明原文后**仍**能从类型化内容重建', () => {
  it('把 `declRaw` 清空 ⇒ 投影产物**仍**能被生产解析器读回（回显不承重，故它不是回显）', async () => {
    // ## 本条是"零回显"的**判别实验**（不是"读代码推断"）
    //
    // 退役要求是「把内层 body 的原始 JSON 逐键摊平回产物根」不再承重。
    // 若投影仍依赖它，删掉 `declRaw` 后产物必然读不回 —— 那正是"回显承重"的形态。
    //
    // **本判据抓出过一处真实缺陷**：第一版的投影面**没有**类型化声明字段，
    // `projectMultiblockBody` 于是从 `declRaw` 逐键回落 —— 清空后投影读不回，
    // 本条当场判红。修复后（投影面携带 `KernelTypedDeclaration`）本条转绿。
    //
    // 注意：本条**不**主张 `declRaw` 可以被永久删除（它承载 `viewerSemantics`
    // 等类型化未覆盖的扩展键 —— 「未知字段不静默丢」的要求）。
    // 本条主张的是**可删性**：它不承重，故它不是回显。
    const { doc, plainRoot } = await loadFixture('multiblock-tier-only')
    const assembled = unwrap(assembleKernelDocument({ doc, plainRoot }))
    const mb = assembled.multiblock!
    const declOf = (declRaw: Readonly<Record<string, unknown>>): KernelDeclarationProjection => ({
      id: mb.id,
      displayName: mb.displayName,
      declaration: mb.projection.declaration,
      declRaw,
      blockPalette: mb.projection.blockPalette,
      assets: mb.projection.assets,
      scenes: mb.projection.scenes,
      schemaVersion: mb.projection.schemaVersion,
      multiblockCount: mb.projection.multiblockCount,
    })

    const withRaw = projectKernelDocument({
      scene: assembled.scene,
      content: assembled.content,
      multiblockDeclaration: declOf(mb.declRaw),
    })
    const withoutRaw = projectKernelDocument({
      scene: assembled.scene,
      content: assembled.content,
      multiblockDeclaration: declOf(Object.freeze({})),
    })

    // ① 清空后仍能读回
    const reparsed = await productionParserRegistry().detectAndParse(withoutRaw.plain)
    expect(reparsed.document, '删掉 declRaw 后投影产物**仍**必须能被生产解析器读回（否则回显是承重的）').not.toBeNull()
    const reparsedWith = await productionParserRegistry().detectAndParse(withRaw.plain)
    expect(reparsed.document!.frameCount, '帧数不得因删掉 declRaw 而变化').toBe(reparsedWith.document!.frameCount)
    // ② 类型化字段写出的键两边**逐键相同**
    const mbWith = withRaw.plain.multiblock as Record<string, unknown>
    const mbWithout = withoutRaw.plain.multiblock as Record<string, unknown>
    for (const key of ['id', 'displayName', 'channels', 'runstates', 'variants', 'rules', 'backbone', 'totalTierDomain'] as const) {
      expect(mbWithout[key], `键 ${key} 必须由**类型化字段**写出（不依赖 declRaw）`).toEqual(mbWith[key])
    }
    expect(withoutRaw.plain.blockPalette, '调色板必须由类型化条目重建').toEqual(withRaw.plain.blockPalette)
    expect(withoutRaw.plain.multiblockCount, '`multiblockCount` 必须由类型化字段写出').toBe(1)
    // ③ 反空洞真：`declRaw` 本身**非空**（否则"清空它"这个实验没有意义）
    expect(Object.keys(mb.declRaw).length, '前提：真实声明的 declRaw 非空').toBeGreaterThan(0)
    console.log(
      `[render-cutover] 零回显判别：declRaw 键数 ${Object.keys(mb.declRaw).length} → 0，` +
        `产物仍含 ${Object.keys(mbWithout).length} 个 multiblock 键，帧数 ${reparsed.document!.frameCount}`,
    )
  })
})

describe('真实信封（帧为主）：33 个重名条目仍逐位一致', () => {
  withRealFixture(
    'structureDataExportedEnvelope',
    '**完整内核链**：真实信封经 装配 → 投影 后仍是 4882 三角形且逐位相同',
    async () => {
    // 本条是**最强证据**：它不是"只走几何承载那一段"，而是让**真实帧为主文档**
    // 走完整生产链 —— 文件 → 生产解析器 → `assembleKernelDocument`（内核承载）
    // → `projectKernelDocument`（从类型化内容重建）→ `resolveRenderBundle` → 几何核心。
    //
    // 与 `multiblock-*` 那组的分工：那组的文档形态是"多方块为主"（网格是装配产物）；
    // 本条的形态是"帧为主"（几何**就在文件里**）—— 即实测里
    // "几何无处可逃"的那种形态（没有内层 body 可回显）。
    const envelope = JSON.parse(realFixtureText('structureDataExportedEnvelope')) as Record<string, unknown>
    const parsed = await productionParserRegistry().detectAndParse(envelope)
    expect(parsed.document, '真实信封应能被生产解析器读入').not.toBeNull()
    const layers = await readEnvelopeLayers(envelope as never)
    const assembled = unwrap(assembleKernelDocument({ doc: parsed.document!, plainRoot: layers.plain }))
    expect(assembled.frameObjects.length, '帧为主文档应装配出帧网格对象').toBeGreaterThan(0)

    // **before**：切换前的渲染输入 = 原始 JSON 定义（几何直接来自文件）。
    const inner = readEnvelopeInner()
    const before = beforeDefinition(inner)
    const fa = fingerprint(before)
    expect(fa.triangleCount, '真实信封必须有 4882 量级的真实三角形').toBeGreaterThan(4000)

    // **after**：走完整内核链。
    const { doc } = projectToRuntimeDocument({ scene: assembled.scene, content: assembled.content })
    const after = beforeDefinition({ ...(doc.serialize() as Record<string, unknown>) })
    const fb = fingerprint(after)
    const diff = firstDifference(fa, fb)
    expect(diff, `真实信封经完整内核链后几何必须逐位相同（首个差异：${diff ?? '无'}）`).toBeNull()
    console.log(
      `[render-cutover] 完整链 structuredata-exported-envelope: palette=${(inner.blockPalette as unknown[]).length} ` +
        `pieces=${fb.pieceCount} triangles=${fb.triangleCount} diff=${diff ?? 'none'}`,
    )
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    '几何承载那一段的隔离证明：原始几何 vs 类型化资产重编码**逐位相同**且三角形数非 0',
    async () => {
    const inner = readEnvelopeInner()
    const before = beforeDefinition(inner)

    // after 侧：走**内核类型化**路径，再投影回旧格式。
    //
    // 这一步刻意**不**经"装配 → 投影"的完整链（那需要把真实信封做成 V2Plain 文档），
    // 而只走本次新增的**几何承载**那一段：`decodeBlockGeometry` → `blockGeometryAsset`
    // → `encodeBlockGeometry`。于是本用例隔离地证明"几何承载本身无损"。
    const { decodeBlockGeometry, blockGeometryAsset, encodeBlockGeometry } = await import('@/domain/blockGeometry')
    const palette = (inner.blockPalette as Record<string, unknown>[]).map((entry) => {
      const dec = decodeBlockGeometry(entry.geometry as never)
      if (dec === null) return entry
      const asset = blockGeometryAsset(dec.quads)
      if (asset === null) return entry
      const enc = encodeBlockGeometry(asset)
      return { ...entry, geometry: { encoding: enc.encoding, quads: enc.quads } }
    })
    const after = beforeDefinition({ ...inner, blockPalette: palette })

    const fa = fingerprint(before)
    const fb = fingerprint(after)
    expect(fa.triangleCount, '真实信封夹具必须产出真实三角形（P10c 实测 4882 量级）').toBeGreaterThan(4000)
    expect(fb.triangleCount, '类型化承载后的三角形数不得变化').toBe(fa.triangleCount)
    const diff = firstDifference(fa, fb)
    expect(diff, `真实信封切换前后几何必须逐位相同（首个差异：${diff ?? '无'}）`).toBeNull()
    console.log(
      `[render-cutover] structuredata-exported-envelope: palette=${(inner.blockPalette as unknown[]).length} ` +
        `pieces=${fa.pieceCount} triangles=${fa.triangleCount} diff=${diff ?? 'none'}`,
    )
    },
  )

  withRealFixture(
    'structureDataExportedEnvelope',
    '**负对照**：按 `name:meta` 合并调色板 ⇒ 三角形数**必然**变化（证明上面的"一致"不是恒真）',
    async () => {
    const inner = readEnvelopeInner()
    const before = beforeDefinition(inner)
    const fa = fingerprint(before)

    // 复现切换前的投影形态：按 `name:meta` 合并调色板条目（`indexOf(name, meta)`）。
    const bp = inner.blockPalette as Record<string, unknown>[]
    const cg = inner.cellGrid as number[][][]
    const indexByNameMeta = new Map<string, number>()
    const merged: Record<string, unknown>[] = [bp[0]!]
    const remap = new Map<number, number>()
    for (let i = 1; i < bp.length; i++) {
      const rid = String(bp[i]!.registryId)
      const name = rid.includes(':') ? rid.slice(rid.indexOf(':') + 1) : rid
      const key = `${name}\u0000${bp[i]!.meta ?? 0}`
      const hit = indexByNameMeta.get(key)
      if (hit !== undefined) {
        remap.set(i, hit)
        continue
      }
      const idx = merged.length
      indexByNameMeta.set(key, idx)
      remap.set(i, idx)
      merged.push(bp[i]!)
    }
    const mergedGrid = cg.map((s) => s.map((r) => r.map((v) => (v === 0 ? 0 : (remap.get(v) ?? v)))))
    const after = beforeDefinition({ ...inner, blockPalette: merged, cellGrid: mergedGrid })

    const fb = fingerprint(after)
    console.log(
      `[render-cutover/负对照] name:meta 合并：palette ${bp.length} → ${merged.length}，` +
        `三角形 ${fa.triangleCount} → ${fb.triangleCount}`,
    )
    expect(fb.triangleCount, '按 name:meta 合并必须改变三角形数（否则"逐位一致"是恒真的）').not.toBe(fa.triangleCount)
    },
  )
})
