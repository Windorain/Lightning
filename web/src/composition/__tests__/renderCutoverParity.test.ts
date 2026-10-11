/**
 * **P10d（#289）· 渲染链切换前后逐格/逐三角形一致**（#289 执行范围第 4 条）。
 *
 * ## 本文件证的是什么（以及为什么它必须是这个形状）
 *
 * #289 的硬约束是「**能力不回退**：渲染结果**逐格一致**」。而本批把"几何从哪来"
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

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { projectGridCells, projectToRuntimeDocument } from '@/composition/kernelProjection'
import { createParserRegistry } from '@/context/parserRegistry'
import { assembleSelection, type MultiblockInnerDocument } from '@/context/multiblock'
import { readEnvelopeLayers } from '@/render/data/compactSceneDocument'
import { fixturePath, readJson } from '@/context/__tests__/multiblockFixtureIo.mjs'
import { unwrap } from '@/domain/errors'
import { buildMultiblockRenderView } from '@/shared/viewport/multiblockChannelUi'
import { resolveRenderBundle } from '@/render/data/bundleResolve'
import type { StructureDefinition } from '@/render/schema/types'
import {
  collectStructureGeometryPiecesPure,
  type BakedQuadGeometryPiece,
} from '@/render/mesh/structureGeometryCore'

// ─────────────────────────────────────────────────────────────────────────────
// 真实信封夹具（帧为主；`web/e2e/fixtures/`）
// ─────────────────────────────────────────────────────────────────────────────

const ENVELOPE_FIXTURE = path.join(process.cwd(), 'e2e', 'fixtures', 'structuredata-exported-envelope.json')

/** 读真实信封的内层 body（base64 或 base64(gzip)，与生产解包同口径）。 */
function readEnvelopeInner(): Record<string, unknown> {
  // 读入口归一化行尾（铁律 6；`crlf-hygiene` 闸门要求）。
  // 本文件读的是夹具 JSON 而非源码，归一化不改 JSON 语义 ——
  // 但保持"每个读入口都显式声明行尾口径"这条纪律，闸门才有意义。
  const env = JSON.parse(fs.readFileSync(ENVELOPE_FIXTURE, 'utf8').replace(/\r\n/g, '\n')) as { payload: string }
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
 * 就是内层 body 本身 —— 这正是 P10c 实测"几何今天能渲染只因原始 JSON 回显"的形态。
 */
function beforeDefinition(inner: Record<string, unknown>): StructureDefinition {
  return inner as unknown as StructureDefinition
}

/**
 * **before（多方块形态）**：**切换前**的渲染链真实输入（`StructureDefinition`）。
 *
 * ## 为什么多方块的 before 不能直接取内层 body
 *
 * 多方块文档的 `frame.grid` 恒为 `null`（网格是**装配产物**，契约设计如此）。
 * 故切换前的渲染几何**不是**文件里现成的，而是：
 *
 * ```
 * 内层 body ──assembleSelection──▶ Grid ──serialize()（首帧 structure 展开）──▶ resolveRenderBundle ──▶ StructureDefinition
 * ```
 *
 * 这正是 `context/__tests__/multiblockChannelRender.test.ts:174-178` 建立的既有路径，
 * 也是 `drwMeshPipeline` 切换前真正吃的东西。⇒ before 必须走同一条路，
 * 否则比较的不是"切换前后的渲染输入"而是"两个不同的东西"（那会让对齐失去意义）。
 */
async function beforeMultiblockDefinition(name: string): Promise<StructureDefinition> {
  const envelope = readJson(fixturePath(name)) as Record<string, unknown>
  const parsed = await createParserRegistry().detectAndParse(envelope)
  const doc = parsed.document!
  const inner = doc.multiblockSource as MultiblockInnerDocument
  const outcome = assembleSelection(inner, {})
  const view = buildMultiblockRenderView(doc, outcome, 0)
  const { definition } = resolveRenderBundle({ document: view.serialize() }, 0)
  // `materialPalette` 在多方块形态下挂在**根级**（契约 §6），而 `resolveRenderBundle`
  // 只在 World 分支注入它 —— 单文件 V2 形态靠"首帧 structure 展开"。
  // 故这里按生产的实际形状补齐：几何收集读 `materialPalette[mi]`（`structureGeometryCore:331`）。
  if (!Array.isArray((definition as { materialPalette?: unknown }).materialPalette)) {
    ;(definition as { materialPalette?: unknown }).materialPalette = doc.materialPalette ?? []
  }
  return definition
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
  const parsed = await createParserRegistry().detectAndParse(envelope)
  const layers = await readEnvelopeLayers(envelope as never)
  const assembled = unwrap(assembleKernelDocument({ doc: parsed.document!, plainRoot: layers.plain }))
  const mb = assembled.multiblock!
  const { doc } = projectToRuntimeDocument({
    scene: assembled.scene,
    content: assembled.content,
    multiblockDeclaration: {
      id: mb.id,
      displayName: mb.displayName,
      declRaw: mb.declRaw,
      blockPalette: mb.projection.blockPalette,
      assets: mb.projection.assets,
      frames: mb.projection.frames,
      schemaVersion: mb.projection.schemaVersion,
      multiblockCount: mb.projection.multiblockCount,
    },
  })
  // `projectToRuntimeDocument` 走 `fromV2Plain`，其 `serialize()` 做"首帧 structure
  // 展开到顶层" —— 与 before 侧 `buildMultiblockRenderView(...).serialize()` **同一个**形态。
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
  const parsed = await createParserRegistry().detectAndParse(envelope)
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

describe('P10d · 多方块夹具：切换前后逐格/逐三角形一致', () => {
  for (const name of MULTIBLOCK_FIXTURES) {
    it(`${name}：装配 → 投影后的几何与切换前渲染输入**逐位相同**`, async () => {
      const before = await beforeMultiblockDefinition(name)
      const after = await afterDefinition(name)

      const fa = fingerprint(before)
      const fb = fingerprint(after)
      const diff = firstDifference(fa, fb)
      expect(diff, `${name} 切换前后几何必须逐位相同（首个差异：${diff ?? '无'}）`).toBeNull()
      // 反空洞真：这条断言只有在"真的有三角形"时才有意义。
      expect(fa.triangleCount, `${name} 应有真实三角形（否则"一致"是 0 = 0 的空洞真）`).toBeGreaterThan(0)
      console.log(`[P10d] ${name}: pieces=${fa.pieceCount} triangles=${fa.triangleCount} diff=${diff ?? 'none'}`)
    })

    it(`${name}：投影产物的几何**全部**来自内核类型化资产（零回显）`, async () => {
      const stats = await assertGeometryFromTypedAssets(name)
      console.log(`[P10d] ${name}: 投影调色板条目=${stats.entries} 其中带几何=${stats.withGeometry}`)
    })
  }
})

describe('P10d · 真实信封（帧为主）：33 个重名条目仍逐位一致', () => {
  it('原始几何 vs 类型化资产重编码：逐格/逐三角形相同且**三角形数非 0**', async () => {
    const inner = readEnvelopeInner()
    const before = beforeDefinition(inner)

    // after 侧：走**内核类型化**路径，再投影回旧格式。
    //
    // 这一步刻意**不**经"装配 → 投影"的完整链（那需要把真实信封做成 V2Plain 文档），
    // 而只走本批新增的**几何承载**那一段：`decodeBlockGeometry` → `blockGeometryAsset`
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
      `[P10d] structuredata-exported-envelope: palette=${(inner.blockPalette as unknown[]).length} ` +
        `pieces=${fa.pieceCount} triangles=${fa.triangleCount} diff=${diff ?? 'none'}`,
    )
  })

  it('**负对照**：按 `name:meta` 合并调色板 ⇒ 三角形数**必然**变化（证明上面的"一致"不是恒真）', async () => {
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
      `[P10d/负对照] name:meta 合并：palette ${bp.length} → ${merged.length}，` +
        `三角形 ${fa.triangleCount} → ${fb.triangleCount}`,
    )
    expect(fb.triangleCount, '按 name:meta 合并必须改变三角形数（否则"逐位一致"是恒真的）').not.toBe(fa.triangleCount)
  })
})
