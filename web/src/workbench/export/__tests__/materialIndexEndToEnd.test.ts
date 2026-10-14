/**
 * **材质索引空间 · 导出侧端到端判据**（真实信封夹具 → 生产链 → 导出产物）。
 *
 * ## 为什么需要它（本判据补的那一格）
 *
 * 材质索引空间曾有一个**静默贴错图**的缺陷：`domain/content.ts#normalizeResources` 用**整串**
 * `localeCompare` 排序资源身份（`` `${assetId}\u0000${contentVersion}` ``）⇒ `material:10` 排在
 * `material:2` **之前** ⇒ 真信封 62 条材质里 **61/62 位置 ≠ 槽位**、逐 quad **2051/2165 绑错材质**。
 * 缺陷已修（`450c91af` + `13ffd0df`），但既有判据
 * （`src/composition/__tests__/materialIndexAlignment.test.ts`）证明的是**内核算术面**：
 * `content.resources` → 调色板身份序列 ↔ 几何 `materialIndex`。**导出产物**这一格此前只有
 * "代码证明 + 上游实测前提"（导出读 `def.materialPalette[p.materialIndex]`、
 * `bundleMeshAssembly.ts:94/:507` 的 `matOrder` 按数值排序）——本判据把它变成**端到端实测**。
 *
 * ## 口径（输入全部来自生产链，无手写载荷）
 *
 * | 环节 | 生产实现 |
 * |---|---|
 * | 夹具 | `web/e2e/fixtures/structuredata-exported-envelope.json`（62 材质 / 2165 quad（**资产去重**口径）/ 导出 gather 2843 条 **实例**） |
 * | 解析 | `createParserRegistry()` + `V2PlainParser`/`createEnvelopeParser`/`WorldParser`/`StructureDataParser`，`detectAndParse` |
 * | 装配 | `plainRootOf(readEnvelopeLayers(raw).plain)` → `adoptLoadedDocument(..., doc, plainRoot, name)`（与生产 12 个调用点同口径） |
 * | 导出输入 | `projectKernelSaveView(session).plain` —— **正是** `operators/builtin/exportOperators.ts` 的 `ctx.plainForSave().plain` |
 * | 导出执行 | `loadStructureOrWorld(plain)` → `buildStructureBundleZip(def, plain, { mode: 'block' })` → 解 zip 读 `structure.obj` / `structure.mtl` / `textures/*.png` |
 *
 * ## 为什么需要浏览器原语替身（且它为什么**不**削弱判据）
 *
 * 导出链末端 `rasterizeVoxelAtlasToPngBlob`（`workbench/textureAtlasRaster.ts`）与
 * `compositeCoplanarCluster`（`workbench/coplanarTextureComposite.ts`）走 `document.createElement('canvas')`
 * / `Image` / `createImageBitmap`（node 环境没有）。替身**只**实现这四个原语的**可观测行为**
 * （`Image` 从 data URL 解真 PNG IHDR 拿尺寸；canvas 记录每次 `drawImage` 的
 * `dest` 矩形与**源**；`toBlob` 交出 jszip 可读的字节），**不**提供任何材质/几何/打包决策。
 * 判据的期望值全部来自**文件槽位真值**（`serialize().materialPalette` / `textureBlobs`）与
 * **生产 gather**（`collectStructureGeometryPiecesPure` + 生产聚类），替身只记录
 * "生产自己画了什么" ⇒ 断言是「产物逐 quad 的贴图来源 ＝ 文件槽位材质的贴图」。
 *
 * ## 逐段覆盖（本判据的"哪一段由哪条断言覆盖"，不许"整体对得上"带过）
 *
 * | 段 | 生产点 | 覆盖断言 |
 * |---|---|---|
 * | **A 调色板索引空间** | `kernelProjection.ts:1321-1409`（`resources` → `materialPalette` + `textureBlobs`） | 段A：`plain.materialPalette[i]` 的 `locator` ＝ 文件槽位 `i` 的 `locator`（62/62，mismatch 0）；且 `textureBlobIndex` ＝ 槽位 |
 * | **B 几何分组** | `structureGeometryCore.ts#collectStructureGeometryPiecesPure` + `bundleMeshAssembly.ts:94/:278-284`（体素分组、`matOrder` 数值排序） | 段B：**逐 piece**（2843）断言 `def.materialPalette[piece.materialIndex]` 的身份 ＝ 文件槽位身份（mismatch 0）＋ 每条 piece 的 `textureBlobIndex` 闭合 |
 * | **C 图集打包 + 逐 quad 绑定** | `bundleMeshAssembly.ts:156-232`（`sortedBlobs`/`blobIndexToTileId`/`packTextureGridByTileId`/`remapUvsByTileId`）+ `rasterizeVoxelAtlasToPngBlob` | 段C：**逐 quad**（OBJ 每个 piece 的 6 个 `vt`）→ 落到生产**自己**画的那张 tile（记录的 `dest` 矩形）→ 该 tile 的**源** ＝ 文件槽位材质的 blob 载荷（mismatch 0）；多件共面簇的 quad 必须落到 `merged` 合成 tile |
 * | **C′ `matOrder` 的观测后果** | `representativePaletteEntryForBlob`（选区代表条目 → tile 尺寸/代表 blend） | 由段C 覆盖：tile 的**源载荷**与尺寸都来自该代表条目 ⇒ 选错代表条目会当场改变 tile 源（段C 的负对照实测如此） |
 * | **D MTL/图集接线** | `bundleMeshAssembly.ts:300-334/351`（`map_Kd` ↔ `textures/*.png`） | 段D：有 atlas 的对象 ⇔ MTL 有 `map_Kd`，且 `map_Kd` 数量 ＝ zip 里 `textures/*.png` 数量 |
 *
 * ## 负对照（必须能红）
 *
 * 同一判据喂一份**按旧键重排调色板**的 plain：旧键 ＝ `materialIndexAlignment.test.ts:171-178`
 * 的同一实现（`resourceIdentity` 整串 `localeCompare`），置换从**真资源**上算出
 * （不是手写顺序），只把位置换掉、条目自身字段（`locator`/`textureBlobIndex`）不动
 * ⇒ 段A/段B/段C 必须同时判红（修复前 61/62 与 2051/2165 的形态）。
 *
 * ## 实测读数（正/负对照，同一判据本尊）
 *
 * （读数随本判据一同落在 Gitea #387，见文件末尾注释。）
 */
import { beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { plainRootOf } from '@/adapters/plainRoot'
import { ALL_CAPABILITIES } from '@/application/commands'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { projectKernelSaveView } from '@/composition/saveProjection'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  StructureDataParser,
  V2PlainParser,
  WorldParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import { resourceIdentity, type ContentResource } from '@/domain/content'
import { clusterCoplanarOverlappingPiecesInVoxel } from '@/pure/coplanarOverlapCluster'
import { readEnvelopeLayers } from '@/render/data/compactSceneDocument'
import { loadStructureOrWorld } from '@/render/data/bundleResolve'
import {
  collectStructureGeometryPiecesPure,
  type BakedQuadGeometryPiece,
} from '@/render/mesh/structureGeometryCore'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID, KernelSession } from '@/runtime/kernelSession'
import { buildStructureBundleZip } from '@/workbench/export/bundleMeshAssembly'

// ─────────────────────────────────────────────────────────────────────────────
// 一、浏览器原语替身（只实现导出链真正用到的四个原语）
// ─────────────────────────────────────────────────────────────────────────────

/** 生产里会创建 canvas 的函数名（**最内层**帧决定这块画布是谁的）。 */
const FRAME_NAMES = [
  'rasterizeVoxelAtlasToPngBlob',
  'rasterizeAtlasToPngBlob',
  'compositeCoplanarCluster',
  'textureBlobToFirstFramePngBlob',
] as const

interface TileDraw {
  /** atlas 像素空间的 `dest` 矩形（= 该 tile 在图集里的位置）。 */
  x: number
  y: number
  w: number
  h: number
  /** 源：blob tile 存 Image 的 data URL；合成 tile 存字面量 `merged`。 */
  src: string
}

interface CanvasRecord {
  seq: number
  frame: string
  width: number
  height: number
  tiles: TileDraw[]
  getContext(kind?: string): unknown
  toBlob(cb: (b: Blob | null) => void): void
}

const canvasRecords: CanvasRecord[] = []
let canvasSeq = 0

function innermostFrame(): string {
  for (const line of (new Error().stack ?? '').split('\n')) {
    for (const name of FRAME_NAMES) if (line.includes(name)) return name
  }
  return 'other'
}

/** 从 PNG 字节解 IHDR 尺寸（真夹具的 blob 是 16×16 的 PNG）。 */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (dv.getUint32(0) !== 0x89504e47) return null
  return { width: dv.getUint32(16), height: dv.getUint32(20) }
}

function base64OfDataUrl(url: string): string {
  const i = url.indexOf('base64,')
  return i < 0 ? url : url.slice(i + 7)
}

class StubImage {
  crossOrigin = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = 0
  naturalHeight = 0
  width = 0
  height = 0
  __src = ''
  set src(v: string) {
    this.__src = v
    const size = pngSize(Buffer.from(base64OfDataUrl(v), 'base64'))
    if (size === null) {
      queueMicrotask(() => this.onerror?.())
      return
    }
    this.naturalWidth = size.width
    this.naturalHeight = size.height
    this.width = size.width
    this.height = size.height
    queueMicrotask(() => this.onload?.())
  }
  get src(): string {
    return this.__src
  }
}

function makeCtx(canvas: CanvasRecord): unknown {
  return {
    canvas,
    clearRect() {},
    createImageData(w: number, h: number) {
      return { data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h }
    },
    putImageData() {},
    getImageData(_x: number, _y: number, w: number, h: number) {
      return { data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h }
    },
    drawImage(src: unknown, ...args: number[]) {
      const s = src as { __src?: string; __bitmap?: boolean }
      let dest: { x: number; y: number; w: number; h: number }
      if (args.length >= 8) dest = { x: args[4]!, y: args[5]!, w: args[6]!, h: args[7]! }
      else if (args.length === 4) dest = { x: args[0]!, y: args[1]!, w: args[2]!, h: args[3]! }
      else dest = { x: args[0] ?? 0, y: args[1] ?? 0, w: 0, h: 0 }
      canvas.tiles.push({
        ...dest,
        src:
          typeof s.__src === 'string' && s.__src.length > 0
            ? s.__src
            : s.__bitmap === true
              ? 'merged'
              : 'unknown',
      })
    },
  }
}

/** 安装替身（幂等）。 */
function installBrowserDouble(): void {
  const g = globalThis as unknown as Record<string, unknown>
  g.Image = StubImage
  g.createImageBitmap = async (b: { __stubSize?: { width: number; height: number } }) => ({
    width: b.__stubSize?.width ?? 16,
    height: b.__stubSize?.height ?? 16,
    __bitmap: true,
  })
  g.document = {
    createElement(tag: string) {
      if (tag !== 'canvas') throw new Error(`替身只实现 canvas，收到 createElement(${tag})`)
      const rec: CanvasRecord = {
        seq: canvasSeq++,
        frame: innermostFrame(),
        width: 0,
        height: 0,
        tiles: [],
        getContext: () => makeCtx(rec),
        toBlob(cb: (b: Blob | null) => void) {
          // 注释：node 的 Blob 不被 jszip 读取（无 FileReader ⇒ support.blob=false），
          // 故交出 jszip 可读的 Uint8Array，同时按 Blob 形状回调。
          const bytes = new Uint8Array([0])
          Object.defineProperty(bytes, '__stubSize', {
            value: { width: rec.width, height: rec.height },
          })
          cb(bytes as unknown as Blob)
        },
      }
      canvasRecords.push(rec)
      return rec
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 二、生产链：夹具 → 导出输入 plain（= ExportObjOperator 的输入）
// ─────────────────────────────────────────────────────────────────────────────

interface Plain {
  [k: string]: unknown
}

const NOOP_LOG = { info: () => {}, warn: () => {} }

/** `e2e/fixtures/` 下的真夹具（`core.autocrlf=true` ⇒ 读入先归一化 CRLF，铁律 6）。 */
function readFixture(fileName: string): Record<string, unknown> {
  const p = path.join(process.cwd(), 'e2e', 'fixtures', fileName)
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')) as Record<string, unknown>
}

function productionRegistry() {
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  return parsers
}

interface Truth {
  /** 文件槽位真值：`serialize().materialPalette[i]` ＝ 几何 `materialIndex === i` 的材质。 */
  palette: readonly unknown[]
  /** 文件槽位真值：`serialize().textureBlobs`（数组，`textureBlobIndex` 索引此表）。 */
  blobs: readonly string[]
}

interface ExportInput {
  plain: Plain
  truth: Truth
  resources: readonly ContentResource[]
}

async function loadExportInput(): Promise<ExportInput> {
  const raw = readFixture('structuredata-exported-envelope.json')
  const layers = await readEnvelopeLayers(raw as never)
  const plainRoot = plainRootOf(layers.plain as Record<string, unknown>)
  const parsed = await productionRegistry().detectAndParse(raw)
  if (parsed.document === null) throw new Error('真信封夹具解析失败')
  const doc = parsed.document
  const session = new KernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: ALL_CAPABILITIES,
  })
  const adopted = adoptLoadedDocument(
    { kernel: session, log: NOOP_LOG },
    doc as never,
    plainRoot,
    'structuredata-exported-envelope.json',
  )
  if (!adopted) throw new Error('adoptLoadedDocument 失败（夹具未进内核会话）')
  const view = projectKernelSaveView(session)
  if (!view.ok) throw new Error(`projectKernelSaveView 失败：${view.reason}`)
  const assembled = assembleKernelDocument({ doc: doc as never, plainRoot })
  if (!assembled.ok) throw new Error('assembleKernelDocument 失败')
  const serialized = (doc as unknown as { serialize(): Plain }).serialize()
  return {
    plain: view.plain as Plain,
    truth: {
      palette: serialized.materialPalette as unknown[],
      blobs: serialized.textureBlobs as string[],
    },
    resources: assembled.value.content.resources,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 三、导出运行 + 产物解析
// ─────────────────────────────────────────────────────────────────────────────

interface ExportedRun {
  plain: Plain
  def: ReturnType<typeof loadStructureOrWorld>
  pieces: BakedQuadGeometryPiece[]
  objText: string
  mtlText: string
  texturePaths: string[]
  atlases: CanvasRecord[]
}

async function runExport(plain: Plain): Promise<ExportedRun> {
  const mark = canvasRecords.length
  const def = loadStructureOrWorld(plain, undefined)
  const zipBlob = await buildStructureBundleZip(def, plain, { mode: 'block' })
  const zip = await JSZip.loadAsync(await zipBlob.arrayBuffer())
  const objFile = zip.file('structure.obj')
  const mtlFile = zip.file('structure.mtl')
  if (objFile === null || mtlFile === null) throw new Error('导出产物缺 structure.obj / structure.mtl')
  const texturePaths = Object.keys(zip.files).filter(
    (n) => n.startsWith('textures/') && n.endsWith('.png'),
  )
  const atlases = canvasRecords
    .slice(mark)
    .filter((c) => c.frame === 'rasterizeVoxelAtlasToPngBlob')
  const { pieces } = collectStructureGeometryPiecesPure(def, { cullOccludedQuads: false })
  return {
    plain,
    def,
    pieces,
    objText: await objFile.async('string'),
    mtlText: await mtlFile.async('string'),
    texturePaths,
    atlases,
  }
}

interface ObjTriangle {
  v: number[]
  vt: number[]
}

interface ObjObject {
  name: string
  material: string
  triangles: ObjTriangle[]
}

interface ParsedObj {
  objects: ObjObject[]
  verts: number[][]
  uvs: number[][]
}

function parseObj(text: string): ParsedObj {
  const verts: number[][] = []
  const uvs: number[][] = []
  const objects: ObjObject[] = []
  let cur: ObjObject | null = null
  let material = ''
  for (const rawLine of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    if (line.startsWith('o ')) {
      cur = { name: line.slice(2).trim(), material, triangles: [] }
      objects.push(cur)
      continue
    }
    if (line.startsWith('usemtl ')) {
      material = line.slice(7).trim()
      if (cur !== null) cur.material = material
      continue
    }
    if (line.startsWith('v ')) {
      verts.push(line.slice(2).trim().split(/\s+/).map(Number))
      continue
    }
    if (line.startsWith('vt ')) {
      uvs.push(line.slice(3).trim().split(/\s+/).map(Number))
      continue
    }
    if (line.startsWith('f ')) {
      const parts = line.slice(2).trim().split(/\s+/)
      const v = parts.map((t) => Number(t.split('/')[0]))
      const vt = parts.map((t) => Number(t.split('/')[1] ?? t.split('/')[0]))
      if (cur !== null) cur.triangles.push({ v, vt })
    }
  }
  return { objects, verts, uvs }
}

function coordKey(p: readonly number[] | undefined): string {
  return p === undefined
    ? 'NaN'
    : `${(p[0] ?? 0).toFixed(4)},${(p[1] ?? 0).toFixed(4)},${(p[2] ?? 0).toFixed(4)}`
}

/** piece 的位置键：6 个顶点（2 个三角形）的位置**无序**集合。 */
function piecePositionKey(positions: Float32Array): string {
  const out: string[] = []
  for (let i = 0; i + 2 < positions.length; i += 3) {
    out.push(coordKey([positions[i]!, positions[i + 1]!, positions[i + 2]!]))
  }
  return out.sort().join('|')
}

function locatorOf(entry: unknown): string {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return ''
  const v = (entry as Record<string, unknown>).locator
  return typeof v === 'string' ? v : ''
}

function blobIndexOf(entry: unknown): number {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return -1
  const v = (entry as Record<string, unknown>).textureBlobIndex
  return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : -1
}

/**
 * **负对照的置换**：旧键（整串 `localeCompare`）产出的调色板顺序（以**文件槽位**表示）。
 *
 * 与 `src/composition/__tests__/materialIndexAlignment.test.ts:171-178` 的 `oldKeyOrder` 同一实现
 * （去重后按 `resourceIdentity` 整串 `localeCompare` 排序），置换从**真资源**上算出。
 */
function preFixSlotOrder(resources: readonly ContentResource[]): number[] {
  const seen = new Map<string, ContentResource>()
  for (const r of resources) {
    const key = resourceIdentity(r)
    if (!seen.has(key)) seen.set(key, r)
  }
  return [...seen.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, r]) => Number(r.ref.assetId.split(':')[1]))
}

// ─────────────────────────────────────────────────────────────────────────────
// 四、逐段分析
// ─────────────────────────────────────────────────────────────────────────────

type TileSourceKind = 'none' | 'merged' | 'payload' | 'unknown'

interface TileHit {
  kind: TileSourceKind
  payload: string
}

const NONE: TileHit = { kind: 'none', payload: '' }
const MERGED: TileHit = { kind: 'merged', payload: '' }
const UNKNOWN: TileHit = { kind: 'unknown', payload: '' }

function tileOf(
  uvs: readonly number[][],
  atlasW: number,
  atlasH: number,
  tiles: readonly TileDraw[],
): TileHit {
  if (atlasW <= 0 || atlasH <= 0) return NONE
  let su = 0
  let sv = 0
  for (const p of uvs) {
    su += p[0] ?? 0
    sv += 1 - (p[1] ?? 0) // OBJ 的 vt 做了 v 翻转（objExportSerialize.ts:103/`flipVCoordForObjInterop`）
  }
  const u = su / uvs.length
  const v = sv / uvs.length
  for (const t of tiles) {
    const u0 = t.x / atlasW
    const v0 = t.y / atlasH
    const u1 = (t.x + t.w) / atlasW
    const v1 = (t.y + t.h) / atlasH
    if (u >= u0 - 1e-6 && u <= u1 + 1e-6 && v >= v0 - 1e-6 && v <= v1 + 1e-6) {
      if (t.src.startsWith('data:')) return { kind: 'payload', payload: base64OfDataUrl(t.src) }
      if (t.src === 'merged') return MERGED
      return UNKNOWN
    }
  }
  return NONE
}

interface SegmentA {
  slots: number
  locatorMismatch: number
  blobIndexMismatch: number
  /** 逐槽位：`plain.textureBlobs[槽位]` 的字节 ≠ 文件槽位材质的字节（身份键）的条数。 */
  blobByteMismatch: number
  textureBlobsShape: 'array' | 'object' | 'absent'
  /** 文件里没有内嵌字节的槽位数（该槽位的 quad 本就无 tile 可贴）。 */
  slotsWithoutBytes: number
  /** 共享同一份字节的槽位数（62 槽位 / 57 条去重字节 ⇒ 5 条共享）。 */
  sharedByteSlots: number
}

interface SegmentB {
  pieces: number
  mismatch: number
  /** 逐 piece：材质取到的 blob 字节表里**确实有**该条字节的条数（索引空间闭合）。 */
  blobTableUnclosed: number
  samples: string[]
}

interface SegmentC {
  atlasCount: number
  textureCount: number
  objTriangles: number
  objVerts: number
  /** 单件簇（期望 ＝ 该槽位的 blob tile）的 quad 数 / 绑错数。 */
  blobQuads: number
  blobMismatch: number
  /** 多件共面簇（期望 ＝ merged 合成 tile）的 quad 数 / 绑错数。 */
  mergedQuads: number
  mergedMismatch: number
  /** 该槽位本无内嵌字节（期望"无 tile"）的 quad 数。 */
  noBlobQuads: number
  /** 位置键在期望序列里对不上（判据自身前提被破坏）。 */
  unplaced: number
  /** OBJ 对象的 piece 条数与生产期望不等（判据自身前提被破坏）。 */
  objectShapeMismatch: number
  samples: string[]
}

interface Analysis {
  a: SegmentA
  b: SegmentB
  c: SegmentC
}

function analyze(run: ExportedRun, truth: Truth): Analysis {
  // ── 段A：调色板索引空间（plain.materialPalette ↔ 文件槽位） ──
  const pal = (run.plain.materialPalette ?? []) as readonly unknown[]
  const tb = run.plain.textureBlobs
  const tbOf = (slot: number): string | undefined => {
    if (Array.isArray(tb)) return (tb as unknown[])[slot] as string | undefined
    if (tb !== null && typeof tb === 'object') {
      return (tb as Record<string, unknown>)[String(slot)] as string | undefined
    }
    return undefined
  }
  let locatorMismatch = 0
  let blobIndexMismatch = 0
  let blobByteMismatch = 0
  let slotsWithoutBytes = 0
  const slots = Math.min(pal.length, truth.palette.length)
  const distinctByteIndexes = new Set<number>()
  for (let i = 0; i < slots; i++) {
    if (locatorOf(pal[i]) !== locatorOf(truth.palette[i])) locatorMismatch += 1
    if (blobIndexOf(pal[i]) !== i) blobIndexMismatch += 1
    const truthBlobIndex = blobIndexOf(truth.palette[i])
    const truthBytes = truthBlobIndex >= 0 ? truth.blobs[truthBlobIndex] : undefined
    if (typeof truthBytes !== 'string' || truthBytes.length === 0) {
      slotsWithoutBytes += 1
      continue
    }
    distinctByteIndexes.add(truthBlobIndex)
    if (tbOf(i) !== truthBytes) blobByteMismatch += 1
  }
  const a: SegmentA = {
    slots,
    locatorMismatch,
    blobIndexMismatch,
    blobByteMismatch,
    slotsWithoutBytes,
    sharedByteSlots: slots - distinctByteIndexes.size,
    textureBlobsShape: Array.isArray(tb)
      ? 'array'
      : tb !== null && typeof tb === 'object'
        ? 'object'
        : 'absent',
  }

  // ── 段B：逐 piece 的材质身份（导出读 def.materialPalette[piece.materialIndex]） ──
  let bMismatch = 0
  let unclosed = 0
  const bSamples: string[] = []
  const tbBytes = (bi: number): string | undefined => {
    if (Array.isArray(tb)) return (tb as unknown[])[bi] as string | undefined
    if (tb !== null && typeof tb === 'object') {
      return (tb as Record<string, unknown>)[String(bi)] as string | undefined
    }
    return undefined
  }
  for (const p of run.pieces) {
    const entry = run.def.materialPalette[p.materialIndex]
    const got = locatorOf(entry)
    const want = locatorOf(truth.palette[p.materialIndex])
    if (got !== want) {
      bMismatch += 1
      if (bSamples.length < 5) {
        bSamples.push(`slot=${p.materialIndex} def=${got || '<缺>'} 文件=${want || '<缺>'}`)
      }
    }
    // 闭合性：该 piece 材质声明的 blob 位置必须有字节 —— 且字节就是**文件槽位**的字节。
    const bi = blobIndexOf(entry)
    const truthBi = blobIndexOf(truth.palette[p.materialIndex])
    const wantBytes = truthBi >= 0 ? truth.blobs[truthBi] : undefined
    const gotBytes = bi >= 0 ? tbBytes(bi) : undefined
    if (typeof wantBytes === 'string' && wantBytes.length > 0 && gotBytes !== wantBytes) unclosed += 1
  }
  const b: SegmentB = {
    pieces: run.pieces.length,
    mismatch: bMismatch,
    blobTableUnclosed: unclosed,
    samples: bSamples,
  }

  // ── 段C：逐 quad 的产物绑定 ──
  const parsed = parseObj(run.objText)
  const atlasByName = new Map<string, CanvasRecord>()
  for (let i = 0; i < run.texturePaths.length; i++) {
    atlasByName.set(path.basename(run.texturePaths[i]!, '.png'), run.atlases[i] ?? ({} as CanvasRecord))
  }
  // 期望序列：生产 gather 的 pieces 按**体素**分组 → 生产聚类（cluster 顺序 = 生产 `remapped` 顺序）。
  // 归位用**下标**、校验用**位置键**：共面重叠的 quad 位置键会重合（本夹具实测 424 条），
  // 只有"生产顺序"能把它们区分开；位置键则自证"归位确实对上了生产序列"。
  const expectByVoxel = new Map<string, Array<{ slot: number; clusterSize: number; key: string }>>()
  const byVoxel = new Map<string, BakedQuadGeometryPiece[]>()
  for (const p of run.pieces) {
    const k = `${p.col},${p.row},${p.zSlice}`
    const arr = byVoxel.get(k)
    if (arr === undefined) byVoxel.set(k, [p])
    else arr.push(p)
  }
  for (const [voxelKey, voxelPieces] of byVoxel) {
    const seq: Array<{ slot: number; clusterSize: number; key: string }> = []
    for (const cluster of clusterCoplanarOverlappingPiecesInVoxel(voxelPieces)) {
      for (const p of cluster) {
        seq.push({
          slot: p.materialIndex,
          clusterSize: cluster.length,
          key: piecePositionKey(p.positions),
        })
      }
    }
    expectByVoxel.set(voxelKey, seq)
  }

  let blobQuads = 0
  let blobMismatch = 0
  let mergedQuads = 0
  let mergedMismatch = 0
  let noBlobQuads = 0
  let unplaced = 0
  let objectShapeMismatch = 0
  let objVerts = 0
  const cSamples: string[] = []
  for (const obj of parsed.objects) {
    objVerts += obj.triangles.length * 3
    const voxelKey = obj.name.replace(/^block_/, '').split('_').join(',')
    const seq = expectByVoxel.get(voxelKey)
    const atlas = atlasByName.get(obj.name)
    const pairs = Math.floor(obj.triangles.length / 2)
    if (seq === undefined || seq.length !== pairs) {
      objectShapeMismatch += 1
      continue
    }
    for (let k = 0; k < pairs; k++) {
      const t1 = obj.triangles[2 * k]!
      const t2 = obj.triangles[2 * k + 1]!
      const posKey = [...t1.v, ...t2.v]
        .map((idx) => coordKey(parsed.verts[idx - 1]))
        .sort()
        .join('|')
      const expected = seq[k]!
      if (expected.key !== posKey) {
        unplaced += 1
        if (cSamples.length < 5) cSamples.push(`${obj.name} 第 ${k} 条 piece 的位置与生产序列不符`)
        continue
      }
      const { slot, clusterSize } = expected
      const hit =
        atlas === undefined
          ? NONE
          : tileOf(
              [...t1.vt, ...t2.vt].map((i) => parsed.uvs[i - 1] ?? []),
              atlas.width,
              atlas.height,
              atlas.tiles,
            )
      const truthBlobIndex = blobIndexOf(truth.palette[slot])
      const expectedPayload = truthBlobIndex >= 0 ? truth.blobs[truthBlobIndex] : undefined
      if (clusterSize > 1) {
        mergedQuads += 1
        if (hit.kind !== 'merged') {
          mergedMismatch += 1
          if (cSamples.length < 5) {
            cSamples.push(`${obj.name} slot=${slot} 多件簇期望 merged，实得 ${hit.kind}`)
          }
        }
      } else if (typeof expectedPayload === 'string' && expectedPayload.length > 0) {
        blobQuads += 1
        if (hit.kind !== 'payload' || hit.payload !== expectedPayload) {
          blobMismatch += 1
          if (cSamples.length < 5) {
            cSamples.push(
              `${obj.name} slot=${slot} 期望 blob#${truthBlobIndex}(${expectedPayload.slice(0, 12)}…)，实得 ${hit.kind}(${hit.payload.slice(0, 12)}…)`,
            )
          }
        }
      } else {
        noBlobQuads += 1
      }
    }
  }
  const c: SegmentC = {
    atlasCount: run.atlases.length,
    textureCount: run.texturePaths.length,
    objTriangles: parsed.objects.reduce((s, o) => s + o.triangles.length, 0),
    objVerts,
    blobQuads,
    blobMismatch,
    mergedQuads,
    mergedMismatch,
    noBlobQuads,
    unplaced,
    objectShapeMismatch,
    samples: cSamples,
  }
  return { a, b, c }
}

// ─────────────────────────────────────────────────────────────────────────────
// 五、判据
// ─────────────────────────────────────────────────────────────────────────────

let positive: { input: ExportInput; run: ExportedRun; analysis: Analysis }
let negative: { run: ExportedRun; analysis: Analysis; perm: number[] }

beforeAll(async () => {
  installBrowserDouble()
  const input = await loadExportInput()
  // 夹具前提（"有源可判"，防判据空转）
  expect(input.truth.palette.length, '真信封必须声明 62 条材质').toBe(62)
  expect(input.truth.blobs.length, '真信封必须带 57 条内嵌纹理').toBe(57)
  expect(input.resources.length, '内核资源条数必须与文件材质条数一致').toBe(62)

  const positiveRun = await runExport(input.plain)
  const positiveAnalysis = analyze(positiveRun, input.truth)

  // 负对照：只把调色板按旧键顺序重排，其余一切与正判据相同。
  const perm = preFixSlotOrder(input.resources)
  const negPalette = perm.map((slot) => (input.plain.materialPalette as unknown[])[slot])
  const negPlain: Plain = { ...input.plain, materialPalette: negPalette }
  const negativeRun = await runExport(negPlain)
  const negativeAnalysis = analyze(negativeRun, input.truth)

  positive = { input, run: positiveRun, analysis: positiveAnalysis }
  negative = { run: negativeRun, analysis: negativeAnalysis, perm }

  // 读数落 stdout（证据随附件上传；判据本尊的断言在各 it 里）
  console.log(
    `[materialIndexEndToEnd] ${JSON.stringify({
      fixture: {
        materials: input.truth.palette.length,
        blobs: input.truth.blobs.length,
        pieces: positiveRun.pieces.length,
      },
      positive: positiveAnalysis,
      negative: {
        permDisplacedSlots: perm.filter((s, i) => s !== i).length,
        ...negativeAnalysis,
      },
    })}`,
  )
}, 600_000)

describe('材质索引空间 · 导出侧端到端（真信封 → 生产链 → 导出产物）', () => {
  it('段A：导出输入 plain 的调色板索引空间 ＝ 文件槽位（mismatch 0）', () => {
    const { a } = positive.analysis
    expect(a.slots, '调色板条数').toBe(62)
    expect(a.locatorMismatch, 'plain.materialPalette[i].locator ≠ 文件槽位 i 的条数').toBe(0)
    expect(a.blobIndexMismatch, 'plain.materialPalette[i].textureBlobIndex ≠ i 的条数').toBe(0)
    expect(a.slotsWithoutBytes, '文件 62 条材质全部有内嵌字节').toBe(0)
    expect(a.sharedByteSlots, '62 槽位 / 57 条去重字节 ⇒ 5 条槽位共享同一份字节（文件事实）').toBe(5)
    expect(a.blobByteMismatch, 'plain.textureBlobs 逐槽位字节 ≠ 文件槽位材质字节的条数').toBe(0)
    // 记录（不判红）：`textureBlobs` 的形态 —— 它决定 `extractTextureBlobs` 能不能读到字节。
    expect(['array', 'object']).toContain(a.textureBlobsShape)
  })

  it('段B：逐 piece 断言 def.materialPalette[piece.materialIndex] ＝ 文件槽位材质（2843 条，mismatch 0）', () => {
    const { b } = positive.analysis
    expect(b.pieces, '导出 gather 的实例口径 piece 数').toBe(2843)
    expect(b.mismatch, `逐 piece 绑错材质条数（样例：${b.samples.join('；')}）`).toBe(0)
    expect(b.blobTableUnclosed, 'piece 材质声明的 blob 字节 ≠ 文件槽位材质的字节').toBe(0)
  })

  it('段C：导出产物逐 quad 的贴图来源 ＝ 文件槽位材质的 blob 载荷（mismatch 0）', () => {
    const { c } = positive.analysis
    expect(c.objectShapeMismatch, '判据自身前提：OBJ 对象的 piece 条数须与生产序列一致').toBe(0)
    expect(c.unplaced, '判据自身前提：每条 OBJ quad 的位置须对上生产序列').toBe(0)
    expect(c.atlasCount, '每个 textures/*.png 必须有一块生产自建的 atlas 画布').toBe(c.textureCount)
    expect(c.objVerts, 'OBJ 顶点数 ＝ 逐 piece 6 顶点（2 三角形）').toBe(positive.run.pieces.length * 6)
    expect(c.blobQuads, '单件簇 quad 数（期望绑到该槽位 blob tile）').toBeGreaterThan(0)
    expect(c.blobMismatch, `单件簇绑错贴图条数（样例：${c.samples.join('；')}）`).toBe(0)
    expect(c.mergedQuads, '多件共面簇 quad 数（期望绑到 merged 合成 tile）').toBeGreaterThan(0)
    expect(c.mergedMismatch, `多件簇未落到 merged 合成 tile 的条数（样例：${c.samples.join('；')}）`).toBe(0)
    // 三段覆盖率必须闭合：blob 簇 + merged 簇 + 文件无字节的槽位 = 全部 piece。
    expect(c.blobQuads + c.mergedQuads + c.noBlobQuads).toBe(positive.run.pieces.length)
  })

  it('段D：MTL 的 map_Kd ↔ zip 内 textures/*.png 一一对应', () => {
    const mapKd = positive.run.mtlText
      .split('\n')
      .filter((l) => l.startsWith('map_Kd '))
      .map((l) => l.slice('map_Kd '.length).trim())
    expect(mapKd.length, 'map_Kd 条数 ＝ 图集文件数').toBe(positive.run.texturePaths.length)
    expect(new Set(mapKd).size, 'map_Kd 不得重复').toBe(mapKd.length)
    expect([...mapKd].sort()).toEqual([...positive.run.texturePaths].sort())
  })

  it('负对照：调色板退回旧键（整串 localeCompare）⇒ 同一条判据判红', () => {
    const { a, b, c } = negative.analysis
    // ① 置换真的是"旧键顺序"（修复前 61/62 位置 ≠ 槽位）—— 否则负对照没喂到载荷上。
    expect(negative.perm.filter((s, i) => s !== i).length, '旧键置换的错位条数').toBe(61)
    // ② 段A：位置 ≠ 槽位（同一读数，导出侧本尊）
    expect(a.locatorMismatch, '旧键下 plain.materialPalette 位置 ≠ 文件槽位').toBeGreaterThan(0)
    // ③ 段B：逐 piece 绑错材质（修复前形态）
    expect(
      b.mismatch,
      `旧键下逐 piece 绑错材质条数（样例：${b.samples.join('；')}）`,
    ).toBeGreaterThan(0)
    // ④ 段C：产物里的贴图真的错（不是"顺序变了但画出来一样"）
    expect(
      c.blobMismatch,
      `旧键下产物绑错贴图条数（样例：${c.samples.join('；')}）`,
    ).toBeGreaterThan(0)
  })
})
