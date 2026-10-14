/**
 * **P11-A 判据：保存投影的声明尺寸口径**（Gitea #262 登记项，comment 6316）。
 *
 * ## 缺陷（本批修的那一条）
 *
 * `composition/kernelProjection#projectGridCells` 按**内容包围盒**推导投影维度
 * （`maxX + 1` 等），`projectToLegacyGrid` 再从投影产物 `cellGrid` 取 `d/h/w`。
 * ⇒ 从文件加载的文档若**声明尺寸 > 内容包围盒**（稀疏尾层：尾切片/尾列/顶行全空），
 * 保存后 `cellGrid` **缩小** —— 文件声明的尺寸事实在保存时丢失，往返不忠实。
 *
 * 读面侧已由 #301 P10f D3 修复（`runtime/gridRead#resolveGridSize`「声明优先、
 * 缺省降级」+ `kernelAssembly#gridPayload` 把 `Grid.width/height/depth` 写进载荷三字段）。
 * **投影侧是同一事实的第二处消费方**：载荷已经带着声明，投影却仍按包围盒输出。
 *
 * ## 判据一览（各自证什么）
 *
 * | 组 | 判据 | 证什么 | 修前 |
 * |---|---|---|---|
 * | ① | 稀疏文档（声明 6×5×4、一格内容）经**生产**解析→装配→**生产**保存视图 ⇒ 产物 `cellGrid` = 6×5×4，逐格内容仍在原格，再解析回来尺寸不变 | 缺陷已修（本批主判据） | **红** |
 * | ② | 负对照：把载荷三字段**去掉**再投影 ⇒ 维度回落包围盒 2×4×2 | 判别子（"载荷带没带声明"）有区分力；判据不恒真 | 绿（对照） |
 * | ③ | 反空洞真：本夹具的包围盒**确实小于**声明（且声明值取自**源文件**，不是常数） | ①②③ 不空转 | 绿 |
 * | ④ | 既有等价：四份真实夹具「声明在场」与「声明缺席」的**保存产物逐字节相同** + 产物维度 == 源声明维度 | 不误伤"声明==包围盒"路径（#171 能力不回退） | 绿（必须） |
 * | ⑤ | 空网格 + 声明 ⇒ 维度按声明（全空气），并**可区分于**"字段缺席 ⇒ 无网格" | 与读面「空网格 ≠ 没有网格」同口径 | **红** |
 * | ⑥ | 畸形输入（声明 < 包围盒）⇒ 维度**不截断**（取包围盒，不丢格、不抛）+ 诊断计数 | 边界裁决：编码器不得丢内容 | 绿（新契约） |
 * | ⑦ | 接线判定：presenter 侧投影（`kernelPresentationInputs`）也按声明尺寸 ⇒ 与"带声明重算"逐位相同、与"无声明重算"**不同** | 同一事实的两处接线点同批接通（#301 D3 的教训：接线缺失 = 修了等于没修） | **红** |
 *
 * ## ⚠️ 三条纪律（本项目实测事故的直接产物）
 *
 * 1. **判据输入必须来自生产**（#301 D3 打回）：①/②/④/⑤/⑥/⑦ 的载荷一律由
 *    `detectAndParse` + `adoptLoadedDocument`（或 `assembleKernelDocument`）产出，
 *    **不**手工拼一份"已经带字段"的载荷（那样纯函数判据会恒绿，而生产可能从不填字段）。
 * 2. **负对照必须真能判红**：②⑦ 各配一条"去掉字段 ⇒ 结果不同"的断言；③④ 各配反空洞真。
 * 3. **CRLF 纪律**（铁律 6）：读文件先归一化行尾；字节级断言（sha256）先归一化再算。
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID, KernelSession } from '@/runtime/kernelSession'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { projectKernelSaveView } from '@/composition/saveProjection'
import { projectGridCells, projectKernelDocument } from '@/composition/kernelProjection'
import { kernelPresentationInputs } from '@/composition/kernelPresentationInputs'
import { TIME_ZERO, type EvaluationKey } from '@/presentation/evaluationKey'
import { collectStructureGeometryPiecesPure, mergeBakedQuadPiecesAttributes } from '@/render/mesh/structureGeometryCore'
import { plainRootOf } from '@/adapters/plainRoot'
import { readJson, fixturePath } from '@/context/__tests__/multiblockFixtureIo.mjs'
import { structureRowToWorldY } from '@/pure/vec'
import { withScene, type Document } from '@/domain/document'
import type { ObjectDataPayload, Scene } from '@/domain/scene'

type Plain = Record<string, unknown>

// ─────────────────────────────────────────────────────────────────────────────
// 生产口径的夹具装载（判据输入**只**来自生产解析 + 生产装配）
// ─────────────────────────────────────────────────────────────────────────────

function productionParsers() {
  const p = createParserRegistry()
  p.register(V2PlainParser)
  p.register(createEnvelopeParser(p))
  p.register(WorldParser)
  p.register(StructureDataParser)
  return p
}

const NOOP_LOG = { info: () => {}, warn: () => {} }

/** 读一份 JSON 夹具（铁律 6：读入口归一化行尾）。 */
function readPlainFile(abs: string): Plain {
  return JSON.parse(fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')) as Plain
}

function rawOf(name: string): Plain {
  if (name === 'envelope') {
    return readPlainFile(path.join(process.cwd(), 'e2e', 'fixtures', 'structuredata-exported-envelope.json'))
  }
  return readJson(fixturePath(name)) as Plain
}

/** 生产解析 + 生产装配（返回会话；调用方负责 `dispose`）。 */
async function adoptedSession(plain: Plain, label: string): Promise<KernelSession> {
  const parsed = await productionParsers().detectAndParse(plain)
  if (parsed.document === null || parsed.document === undefined) throw new Error(`${label} 生产解析失败`)
  const session = new KernelSession({ documentId: KERNEL_DOCUMENT_ID, contextId: KERNEL_CONTEXT_ID, capabilities: [] })
  const ok = adoptLoadedDocument({ kernel: session, log: NOOP_LOG }, parsed.document as never, plainRootOf(plain) as Plain, label)
  if (!ok) {
    session.dispose()
    throw new Error(`${label} 生产装配失败（GF-16 = false）`)
  }
  return session
}

/** 内核文档里**全部** `blockGrid` 载荷（出现序）。 */
function gridPayloads(doc: Document): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const id of doc.scene.order) {
    const obj = doc.scene.objects[id]
    if (obj === undefined || obj.type !== 'block') continue
    const p = doc.scene.data[obj.dataId]?.payload as Record<string, unknown> | undefined
    if (p?.kind === 'blockGrid') out.push(p)
  }
  return out
}

/**
 * 把内核文档里所有 `blockGrid` 载荷的**声明尺寸三字段去掉**（= 修前装配产出的形状）。
 *
 * 这是**负对照**的构造手段：同一份内核内容、同一条生产投影路径，唯一差别是
 * "载荷带没带声明"。走 `withScene` + `adoptDocument`（生产 API），不手搓会话状态。
 */
function withoutDeclaredSizes(doc: Document): Document {
  const data: Record<string, unknown> = {}
  for (const [id, d] of Object.entries(doc.scene.data)) {
    if (d.payload.kind !== 'blockGrid') {
      data[id] = d
      continue
    }
    const p = { ...(d.payload as unknown as Record<string, unknown>) }
    delete p.sizeColumn
    delete p.sizeRow
    delete p.sizeZSlice
    // 只换载荷（内容少一个"声明"字段，不改变逐格内容）；版本号不动 ——
    // 投影不读内容版本，本函数只服务"判别子在场/缺席"这一条对照。
    data[id] = { ...d, payload: p as unknown as ObjectDataPayload }
  }
  return withScene(doc, { ...doc.scene, data: Object.freeze(data) } as Scene).doc
}

// ─────────────────────────────────────────────────────────────────────────────
// 读数助手（判据侧独立复算，不复用投影的分支语义）
// ─────────────────────────────────────────────────────────────────────────────

/** `cellGrid` 的 `[d, h, w]`（`[z][row][col]`）。 */
function dimsOf(cellGrid: unknown): { d: number; h: number; w: number } {
  const g = cellGrid as number[][][] | undefined
  return { d: g?.length ?? 0, h: g?.[0]?.length ?? 0, w: g?.[0]?.[0]?.length ?? 0 }
}

/** 非空格（下标 ≠ `AIR_PALETTE_INDEX`）的 `[z, row, col]` 序列（判据侧独立数）。 */
function solidCellsOf(cellGrid: number[][][]): number[][] {
  const out: number[][] = []
  for (let z = 0; z < cellGrid.length; z++) {
    const slice = cellGrid[z]!
    for (let row = 0; row < slice.length; row++) {
      const r = slice[row]!
      for (let col = 0; col < r.length; col++) if (r[col] !== 0) out.push([z, row, col])
    }
  }
  return out
}

/** 载荷 `cells` 的键表 → 内容包围盒（**判据侧独立**推导，不从投影取）。 */
function boundsOfCells(cells: Readonly<Record<string, string>>): { w: number; h: number; d: number } {
  let maxX = -1
  let maxY = -1
  let maxZ = -1
  for (const key of Object.keys(cells)) {
    const [x, y, z] = key.split(',').map(Number)
    if (x === undefined || y === undefined || z === undefined) continue
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }
  return { w: maxX + 1, h: maxY + 1, d: maxZ + 1 }
}

/** 保存产物的**字节**（铁律 6：先归一化行尾再算）。 */
function artifactBytes(plain: Plain): string {
  return JSON.stringify(plain).replace(/\r\n/g, '\n')
}
/** 键序无关的规范化（`undefined` 视为缺席 —— JSON 语义如此）。 */
function canonOf(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonOf).join(',')}]`
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonOf(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 生产保存视图的产物（断言失败时给出可读原因，而不是 `undefined` 崩溃）。 */
function saveArtifactOf(session: KernelSession): Plain {
  const projected = projectKernelSaveView(session)
  expect(projected.ok, '前提：生产保存视图必须成功（GF-16 + 投影可读回）').toBe(true)
  if (!projected.ok) throw new Error(`保存视图失败：${projected.reason} ${projected.detail}`)
  return projected.plain as Plain
}

// ─────────────────────────────────────────────────────────────────────────────
// 夹具：声明 6×5×4、只有一格内容（稀疏尾层 —— 三个轴向上包围盒都更小）
// ─────────────────────────────────────────────────────────────────────────────

const DECLARED = { w: 6, h: 5, d: 4 } as const
/** 文件 `cellGrid` 的 row（row 0 = 顶部）；**世界 y 由生产函数换算**（见下）。 */
const CELL_ROW = 1
const CELL_X = 1
const CELL_Z = 1
/**
 * 文件 row → 世界 y（**用生产函数**换算，不手写 `h-1-row`）。
 *
 * #301 P10f D3 的实测教训：手写这个式子把"行号当世界 y"，夹具落在另一格，
 * 期望值随之错一位，被自己的断言抓出。翻转只有 `structureRowToWorldY` 一处定义。
 */
const WORLD_Y = structureRowToWorldY(CELL_ROW, DECLARED.h)

/** 声明 6×5×4、`cellGrid[1][1][1] = stone`（其余空气）的 V2Plain 文档。 */
function sparsePlain(): Plain {
  const empty = (): number[][] => Array.from({ length: DECLARED.h }, () => new Array<number>(DECLARED.w).fill(0))
  const grid: number[][][] = Array.from({ length: DECLARED.d }, empty)
  grid[CELL_Z]![CELL_ROW]![CELL_X] = 1
  return {
    format_version: '2.0',
    id: 'p11a-sparse-tail',
    // `created_at_ms` 显式给 0：使往返**字节可判**（否则解析期回落到 `Date.now()`）。
    meta: { name: 'sparse-tail', author: '', description: '', tags: [], origin: { x: 0, y: 0, z: 0 }, created_at_ms: 0 },
    frames: [
      {
        index: 0,
        label: 'frame-0',
        durationMs: 100,
        structure: {
          geometryPhase: 'baked',
          cellGrid: grid,
          blockPalette: [
            { registryId: 'air', meta: 0 },
            { registryId: 'minecraft:stone', meta: 0 },
          ],
        },
      },
    ],
    annotations: [],
    labels: [],
  }
}

/** 声明 6×5×4、**全空气**（一格内容都没有）的同形文档。 */
function emptyDeclaredPlain(): Plain {
  const p = sparsePlain()
  const grid = (((p.frames as Plain[])[0]!.structure as Plain).cellGrid as number[][][]).map((s) =>
    s.map((r) => r.map(() => 0)),
  )
  ;(((p.frames as Plain[])[0]!.structure as Plain).cellGrid as number[][][]) = grid
  return p
}

/**
 * **带真实几何**的稀疏文档（由真实导出信封派生）。
 *
 * 为什么需要它：合成夹具的 `blockPalette` 没有烘焙几何 ⇒ `kernelPresentationInputs`
 * 会以 `no-typed-geometry` **跳过**该对象（⑦ 组无从判定）。故把真实信封的
 * `cellGrid` 顶部 3 行挖空（**维度一字不改**）后在测试内存里派生一份
 * —— 与 e2e harness（`e2e/helpers/multiblock/frameDoc.ts`）同一手法：IO 由测试接管，
 * 不新增仓库文件、不改任何 src。
 */
function sparseRealGeometryPlain(): { plain: Plain; cellGrid: number[][][]; blockPalette: unknown[] } {
  const envelope = readPlainFile(path.join(process.cwd(), 'e2e', 'fixtures', 'structuredata-exported-envelope.json'))
  const inner = JSON.parse(zlib.gunzipSync(Buffer.from(envelope.payload as string, 'base64')).toString('utf8')) as Plain
  const full = inner.cellGrid as number[][][]
  // `cellGrid[z][row][col]`，**row 0 = 顶部**（世界 y 最大）⇒ 挖空前 3 **行**
  // （不是前 3 个 z 切片 —— 那会挖掉深度方向的尾切片，与"高度方向稀疏"不是一件事）。
  const sparse = full.map((slice) => slice.map((r, row) => (row < 3 ? r.map(() => 0) : r)))
  const plain: Plain = {
    format_version: '2.0',
    id: 'p11a-sparse-real-geometry',
    meta: { name: 'sparse-real-geometry', author: '', description: '', tags: [], origin: { x: 0, y: 0, z: 0 }, created_at_ms: 0 },
    frames: [
      { index: 0, label: 'frame-0', durationMs: 100, structure: { geometryPhase: 'baked', cellGrid: sparse, blockPalette: inner.blockPalette } },
    ],
    annotations: [],
    labels: [],
    materialPalette: inner.materialPalette,
    textureBlobs: inner.textureBlobs,
    tooltipPalette: inner.tooltipPalette,
  }
  return { plain, cellGrid: sparse, blockPalette: inner.blockPalette as unknown[] }
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 主判据：稀疏尾层文档的**往返忠实**
// ─────────────────────────────────────────────────────────────────────────────

describe('P11-A ① 稀疏尾层往返忠实（声明 6×5×4 / 一格内容）', () => {
  it('生产保存产物的 `cellGrid` 维度 = **声明**尺寸 6×5×4（不是包围盒 2×4×2）', async () => {
    const session = await adoptedSession(sparsePlain(), 'p11a-sparse')
    try {
      const artifact = saveArtifactOf(session)
      expect(
        { 根: dimsOf(artifact.cellGrid), 帧: dimsOf(((artifact.frames as Plain[])[0]!.structure as Plain).cellGrid) },
        '声明 6×5×4（d/h/w = 4/5/6）必须在产物里活下来 —— 这正是本批修的那条',
      ).toEqual({ 根: { d: DECLARED.d, h: DECLARED.h, w: DECLARED.w }, 帧: { d: DECLARED.d, h: DECLARED.h, w: DECLARED.w } })
      // 内容仍在**原格**（维度扩张不得让格子漂移 —— 翻转仍只有一处定义）
      expect(solidCellsOf(artifact.cellGrid as number[][][]), '唯一的方块必须仍在 [z=1][row=1][col=1]').toEqual([
        [CELL_Z, CELL_ROW, CELL_X],
      ])
    } finally {
      session.dispose()
    }
  })

  it('产物**再解析回来**尺寸不变，且**第二轮**投影与第一轮逐字节相同（幂等）', async () => {
    const session = await adoptedSession(sparsePlain(), 'p11a-sparse')
    let first: Plain
    try {
      first = saveArtifactOf(session)
    } finally {
      session.dispose()
    }
    // 生产解析器读回产物（不是手工构造"期望"）
    const reparsed = await productionParsers().detectAndParse(first)
    expect(reparsed.document, '产物必须能被生产解析器读回').not.toBeNull()
    const grid = (reparsed.document as unknown as { frame: (i: number) => { grid: { width: number; height: number; depth: number } | null } }).frame(0).grid
    expect(
      { w: grid?.width, h: grid?.height, d: grid?.depth },
      '读回来的 Grid 维度 = 文件声明尺寸（`_fromV2CellGrid` 用 cellGrid 三维构造）',
    ).toEqual({ w: DECLARED.w, h: DECLARED.h, d: DECLARED.d })

    // 第二轮：产物当新源，重新装配 + 重新投影 ⇒ 必须收敛（不缩、不涨）
    const session2 = await adoptedSession(first, 'p11a-sparse-round2')
    try {
      const second = saveArtifactOf(session2)
      expect(dimsOf(second.cellGrid), '第二轮维度仍 = 声明尺寸（既不缩回包围盒，也不继续涨）').toEqual({
        d: DECLARED.d,
        h: DECLARED.h,
        w: DECLARED.w,
      })
      expect(solidCellsOf(second.cellGrid as number[][][]), '第二轮内容仍在原格').toEqual([[CELL_Z, CELL_ROW, CELL_X]])
      // ⚠️ 用**键序无关**的规范化比较：`RuntimeDocument.serialize()` 先把 `_extra` 摊平到产物根，
      // 而第二轮的解析会把第一轮产物里"首帧展开副本"（根级 `geometryPhase`/`cellGrid`/`blockPalette`）
      // 当成未知顶层键收进 `_extra` ⇒ **键序**在第二轮前移。那是 `serialize()` 的既有形态
      // （与本批的尺寸口径无关），故本判据钉的是**内容**幂等，不是键序。
      expect(canonOf(second), '第二轮内容必须与第一轮完全相同（往返收敛）').toBe(canonOf(first))
    } finally {
      session2.dispose()
    }
  })

  it('**带真实几何**的稀疏文档（真实信封挖空顶 3 行）同样保住声明尺寸', async () => {
    const { plain } = sparseRealGeometryPlain()
    const session = await adoptedSession(plain, 'p11a-sparse-real')
    try {
      const artifact = saveArtifactOf(session)
      const sourceDims = dimsOf(plain.frames ? (((plain.frames as Plain[])[0]!.structure as Plain).cellGrid) : undefined)
      expect(
        dimsOf(artifact.cellGrid),
        `真实几何的稀疏文档：产物维度必须 = 源文件声明（${sourceDims.w}×${sourceDims.h}×${sourceDims.d}）`,
      ).toEqual({ d: sourceDims.d, h: sourceDims.h, w: sourceDims.w })
    } finally {
      session.dispose()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ② 负对照：判别子（"载荷带没带声明"）必须有区分力
// ─────────────────────────────────────────────────────────────────────────────

describe('P11-A ② 负对照：剥掉声明三字段 ⇒ 维度回落包围盒', () => {
  it('同一份内核内容：带声明 ⇒ 6×5×4；剥掉三字段 ⇒ 2×4×2（两者必须**不同**）', async () => {
    const session = await adoptedSession(sparsePlain(), 'p11a-sparse')
    try {
      const withDecl = saveArtifactOf(session)
      const payload = gridPayloads(session.document()!)[0]!
      // 前提：生产装配**确实**填了三字段（否则本组退化成"两侧都是包围盒"）
      expect(
        { sizeColumn: payload.sizeColumn, sizeRow: payload.sizeRow, sizeZSlice: payload.sizeZSlice },
        '前提：装配产物必须带声明尺寸（#301 D3 打回的接线）',
      ).toEqual({ sizeColumn: DECLARED.w, sizeRow: DECLARED.h, sizeZSlice: DECLARED.d })

      session.adoptDocument(withoutDeclaredSizes(session.document()!), session.document()!.content)
      const withoutDecl = saveArtifactOf(session)

      const bounds = boundsOfCells(payload.cells as Record<string, string>)
      const pair = { 带声明: dimsOf(withDecl.cellGrid), 剥掉声明: dimsOf(withoutDecl.cellGrid) }
      expect(pair, '判别子必须真有区分力：带声明 = 声明尺寸；剥掉 = 包围盒').toEqual({
        带声明: { d: DECLARED.d, h: DECLARED.h, w: DECLARED.w },
        剥掉声明: { d: bounds.d, h: bounds.h, w: bounds.w },
      })
      expect(pair.带声明, '两侧若相同，本批的判据全部空转').not.toEqual(pair.剥掉声明)
    } finally {
      session.dispose()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ③ 反空洞真：夹具的包围盒**确实小于**声明（且声明取自源文件）
// ─────────────────────────────────────────────────────────────────────────────

describe('P11-A ③ 反空洞真', () => {
  it('源文件声明的三个维度都**严格大于**内容包围盒（否则 ①② 空转）', () => {
    const source = sparsePlain()
    const sourceGrid = ((source.frames as Plain[])[0]!.structure as Plain).cellGrid as number[][][]
    const sourceDims = dimsOf(sourceGrid)
    // 声明值取自**源文件**（不是本文件里的常数）
    expect(sourceDims, '源文件的 cellGrid 维度就是"声明尺寸"这一事实的定义点').toEqual({ d: DECLARED.d, h: DECLARED.h, w: DECLARED.w })
    const bounds = boundsOfCells({ [`${CELL_X},${WORLD_Y},${CELL_Z}`]: 'minecraft:stone:0' })
    expect(bounds, '包围盒由**内容**推得（判据侧独立复算）').toEqual({ d: CELL_Z + 1, h: WORLD_Y + 1, w: CELL_X + 1 })
    expect(bounds.d, '深：包围盒必须更小').toBeLessThan(sourceDims.d)
    expect(bounds.h, '高：包围盒必须更小').toBeLessThan(sourceDims.h)
    expect(bounds.w, '宽：包围盒必须更小').toBeLessThan(sourceDims.w)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ④ 既有等价：四份真实夹具的保存产物**字节不变**（不误伤声明==包围盒路径）
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURES = ['envelope', 'multiblock-tier-only', 'multiblock-ebf-2ch', 'multiblock-lsc-overlap'] as const

/**
 * ## 为什么"字节不变"的比较对象是"剥掉声明的同一份文档"（而不是冻结的哈希常数）
 *
 * 修前的实现**完全忽略**声明 ⇒ 修前产物 ≡ "剥掉声明"路径的产物。
 * 故「带声明产物 == 剥掉声明产物」**等价于**「产物与修前逐字节相同」，
 * 但它**自基线**（不需要把一个 2026 年的哈希值冻进测试，从而不会与
 * 将来其它批次的合法改动打架）。
 *
 * ## 为什么还要比"帧形态投影"的字节
 *
 * 实测：多方块夹具的**保存形态不带投影网格**（`serialize()` 只在帧有 `grid` 时
 * 展开根级 `cellGrid`，而多方块帧的网格由渲染视图注入）。若只比保存产物，
 * 三份多方块夹具的相等是**空洞**的。故额外比 `projectKernelDocument` 的帧形态
 * 产物 —— 那条路径上三份夹具的网格**确实**被投影。
 */
describe('P11-A ④ 既有等价：四份真实夹具「带声明」与「剥掉声明」的产物**逐字节相同**', () => {
  for (const name of FIXTURES) {
    it(`**保存产物字节**（${name}）`, async () => {
      const session = await adoptedSession(rawOf(name), name)
      try {
        const payloads = gridPayloads(session.document()!)
        expect(payloads.length, '前提：夹具必须有 blockGrid 载荷').toBeGreaterThan(0)
        // 反空洞真：本夹具的**声明 == 包围盒**（这正是"两条路径应当相同"的前提）
        for (const p of payloads) {
          const bounds = boundsOfCells(p.cells as Record<string, string>)
          expect(
            { 声明: { w: p.sizeColumn, h: p.sizeRow, d: p.sizeZSlice }, 包围盒: bounds },
            `${name}：本判据只在"声明 == 包围盒"的夹具上成立；若某份夹具出现稀疏尾层，本组必须改判（不是放宽）`,
          ).toEqual({ 声明: { w: bounds.w, h: bounds.h, d: bounds.d }, 包围盒: bounds })
        }
        const a = artifactBytes(saveArtifactOf(session))

        // 帧形态投影（生产函数）—— 这一路**不管**保存形态是否带网格
        const projectFrames = (s: KernelSession): string => {
          const doc = s.document()!
          const projected = projectKernelDocument({ scene: doc.scene, content: doc.content })
          const first = ((projected.plain as Plain).frames as Plain[])[0]!
          // 反空洞真：帧形态产物**确实带**被投影的网格（否则"字节相同"是两份空产物相等）
          expect(
            dimsOf((first.structure as Plain | undefined)?.cellGrid),
            `${name}：帧形态投影必须真的产出网格（否则本组对该夹具空洞）`,
          ).toEqual({ d: payloads[0]!.sizeZSlice, h: payloads[0]!.sizeRow, w: payloads[0]!.sizeColumn })
          return artifactBytes(projected.plain as Plain)
        }
        const framesA = projectFrames(session)

        session.adoptDocument(withoutDeclaredSizes(session.document()!), session.document()!.content)
        const b = artifactBytes(saveArtifactOf(session))
        const framesB = projectFrames(session)

        console.log(`[P11-A/④] ${name}: 保存产物 ${Buffer.byteLength(a, 'utf8')} B sha256=${sha256(a)}`)
        expect(sha256(b), '保存产物必须**逐字节**不变（修前的行为 ≡ 剥掉声明的行为）').toBe(sha256(a))
        expect(sha256(framesB), '帧形态投影产物必须**逐字节**不变').toBe(sha256(framesA))
      } finally {
        session.dispose()
      }
    })
  }

  it('**envelope**：产物维度就是源文件声明的维度（声明优先的可观测形态）', async () => {
    const session = await adoptedSession(rawOf('envelope'), 'envelope')
    try {
      const artifact = saveArtifactOf(session)
      const inner = JSON.parse(
        zlib.gunzipSync(Buffer.from((rawOf('envelope').payload as string) ?? '', 'base64')).toString('utf8'),
      ) as Plain
      const sourceDims = dimsOf(inner.cellGrid)
      expect(dimsOf(artifact.cellGrid), '根级 cellGrid（= 首帧展开）维度必须 = 源声明维度').toEqual(sourceDims)
    } finally {
      session.dispose()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ 空网格：声明的"空网格"与"没有网格"必须可区分（与读面同口径）
// ─────────────────────────────────────────────────────────────────────────────

describe('P11-A ⑤ 空网格保尺寸（"空网格 ≠ 没有网格"）', () => {
  it('声明 6×5×4 + 零内容 ⇒ 投影维度 = 6×5×4（全空气）；字段缺席 ⇒ 无网格', async () => {
    const session = await adoptedSession(emptyDeclaredPlain(), 'p11a-empty')
    try {
      const payload = gridPayloads(session.document()!)[0]!
      expect(payload.cells, '前提：本夹具确实没有任何内容').toEqual({})
      expect(
        { sizeColumn: payload.sizeColumn, sizeRow: payload.sizeRow, sizeZSlice: payload.sizeZSlice },
        '前提：装配仍须承载声明尺寸（空网格也是网格）',
      ).toEqual({ sizeColumn: DECLARED.w, sizeRow: DECLARED.h, sizeZSlice: DECLARED.d })

      const artifact = saveArtifactOf(session)
      expect(dimsOf(artifact.cellGrid), '声明的空网格必须按声明维度输出（不是 `[]`）').toEqual({
        d: DECLARED.d,
        h: DECLARED.h,
        w: DECLARED.w,
      })
      expect(solidCellsOf(artifact.cellGrid as number[][][]), '全空气').toEqual([])

      // 负对照：同一份内容**剥掉声明** ⇒ 没有任何尺寸事实 ⇒ "无网格"（`[]`）
      session.adoptDocument(withoutDeclaredSizes(session.document()!), session.document()!.content)
      const stripped = saveArtifactOf(session)
      expect(dimsOf(stripped.cellGrid), '无声明 + 无内容 ⇒ 无网格（不是 1×1×1，也不是 6×5×4）').toEqual({ d: 0, h: 0, w: 0 })
    } finally {
      session.dispose()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ 边界裁决：声明尺寸 **<** 内容包围盒（畸形输入）⇒ 扩张，不截断、不抛
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ## 裁决与理由（本批的已知边界，**必须**有判据）
 *
 * 畸形输入 = 载荷声明 `2×1×2` 而内容在 `(1,3,1)`（世界 y=3 ⇒ 声明的高 1 覆盖不到）。两种可能的口径：
 *
 * | 口径 | 后果 | 判定 |
 * |---|---|---|
 * | **截断到声明** | 声明之外的方块**静默消失**（保存一次丢内容 —— #171 硬底线）；且按声明建网格后写入越界格会**抛异常** | ❌ 否决 |
 * | **按内容扩张**（= 维度取 `max(声明, 包围盒)`） | 零丢失；产物比声明大；新一轮起稳定（新文件声明了更大的尺寸）；越界事实由 `cellsOutsideDeclaredSize` **显式**报出 | ✅ 采纳 |
 *
 * 依据：投影是**编码器**（不是读面）。读面遇到越界格"看不到"它没有任何损失
 * （文件还在），而编码器截断就是**改写用户数据**。故两侧在这里**有意不同**：
 * 判别子同构（"有没有声明"），越界时的处置按"有没有写入"分道。
 *
 * ## ⚠️ 本组的输入构造（为什么必须单点注入）
 *
 * 生产装配的 `cells` 由 `gridPayload` 从**有界** `Grid` 迭代产出 ⇒
 * "内容越界"这一畸形在**生产路径上不可达**（这正是它今天是"边界"而非"缺陷"的原因）。
 * 故本组的构造是：**生产装配产物**（`cells`/调色板/其余字段全来自生产）+
 * **单点注入**一个"比内容小的声明"（只有声明三字段被换掉，逐格内容一字不动）。
 * 注入的是**输入畸形**，不是期望值 —— 判据的期望维度仍由判据侧**独立复算**
 * （`max(声明, 包围盒)`），不从实现取。
 */
describe('P11-A ⑥ 畸形输入裁决：声明 < 包围盒 ⇒ 按内容扩张（不丢格、不抛）', () => {
  /** 只把载荷的**声明三字段**换小（内容一字不动）—— 畸形输入的注入点。 */
  function withSmallDeclaration(doc: Document, size: { w: number; h: number; d: number }): Document {
    const data: Record<string, unknown> = {}
    for (const [id, d] of Object.entries(doc.scene.data)) {
      if (d.payload.kind !== 'blockGrid') {
        data[id] = d
        continue
      }
      data[id] = {
        ...d,
        payload: { ...(d.payload as unknown as Record<string, unknown>), sizeColumn: size.w, sizeRow: size.h, sizeZSlice: size.d },
      }
    }
    return withScene(doc, { ...doc.scene, data: Object.freeze(data) } as Scene).doc
  }

  const SMALL = { w: 2, h: 1, d: 2 } as const

  it('声明 2×1×2 + 内容在 (1,3,1) ⇒ 维度 = max(声明, 包围盒)，内容一格不丢，且报越界诊断', async () => {
    const session = await adoptedSession(sparsePlain(), 'p11a-sparse')
    try {
      const payload = gridPayloads(session.document()!)[0]!
      const bounds = boundsOfCells(payload.cells as Record<string, string>)
      // 反空洞真：声明**确实**小于内容（否则本组空转）
      expect(
        { 注入声明: SMALL, 包围盒: bounds },
        '前提：注入的声明必须三个轴向上都覆盖不到内容',
      ).toEqual({ 注入声明: { w: 2, h: 1, d: 2 }, 包围盒: { w: 2, h: 4, d: 2 } })
      expect(bounds.h, '高度方向**严格**越界（声明 1 < 内容 4）').toBeGreaterThan(SMALL.h)

      session.adoptDocument(withSmallDeclaration(session.document()!, SMALL), session.document()!.content)
      const doc = session.document()!
      const artifact = projectKernelDocument({ scene: doc.scene, content: doc.content })
      const expected = { w: Math.max(SMALL.w, bounds.w), h: Math.max(SMALL.h, bounds.h), d: Math.max(SMALL.d, bounds.d) }
      // `projectKernelDocument` 把网格放在 `frames[].structure`（根级展开副本由
      // `saveProjection` 的 `serialize()` 负责 —— 本组只看投影本体）。
      const frameGrid = (((artifact.plain as Plain).frames as Plain[])[0]!.structure as Plain).cellGrid as number[][][]

      expect(
        dimsOf(frameGrid),
        '维度必须取 max(声明, 包围盒)：声明小 ⇒ 按**内容**（截断口径会在这里判红）',
      ).toEqual({ d: expected.d, h: expected.h, w: expected.w })
      expect(solidCellsOf(frameGrid), '内容一格不得丢（截断口径会在这里判红）').toHaveLength(
        Object.keys(payload.cells as Record<string, string>).length,
      )
      expect(
        artifact.diagnostics.map((d) => [d.code, d.count]),
        '越界事实必须**显式**报出（而不是让产物静默变大）',
      ).toContainEqual(['cellsOutsideDeclaredSize', 1])
    } finally {
      session.dispose()
    }
  })

  it('**负对照**：声明 ≥ 包围盒时**不得**报越界诊断（否则诊断恒真、失去信号）', async () => {
    const session = await adoptedSession(sparsePlain(), 'p11a-sparse')
    try {
      const doc = session.document()!
      const artifact = projectKernelDocument({ scene: doc.scene, content: doc.content })
      expect(
        artifact.diagnostics.filter((d) => d.code === 'cellsOutsideDeclaredSize'),
        '声明 6×5×4 覆盖内容 ⇒ 不得有越界诊断',
      ).toEqual([])
    } finally {
      session.dispose()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑦ 接线判定：presenter 侧（`kernelPresentationInputs`）也按声明尺寸投影
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ## 为什么这条必须存在（#301 P10f D3 的教训）
 *
 * D3 的缺陷不是"判据错"，而是"**判据的输入不来自生产**"：纯函数判据喂的手工载荷
 * **已经带了**字段，而生产装配**从不填**它 ⇒ 修了等于没修（L3 才擒获）。
 * 投影侧同理：`projectGridCells` 修好而**接线点**（`definitionOfPayload`）不传字段，
 * 则 presenter 的网格仍是包围盒维度 —— 与读面（`kernelGridOf` 用声明）**不一致**，
 * 表现为"渲染居中/拾取对不上"。
 *
 * 判据形式：presenter 产出的顶点必须与"**带声明**重算"逐位相同、与"**不带声明**
 * 重算"**不同** —— 后者就是判别的负对照（若接线没接上，前者必红、后者必绿）。
 */
describe('P11-A ⑦ 接线判定：presenter 侧投影（走生产装配）按声明尺寸', () => {
  function keyOf(sceneId: string): EvaluationKey {
    return { documentVersion: 1, scene: sceneId, time: TIME_ZERO, parameterVersion: 0, contentResourceVersions: {} }
  }

  function mergedPositionsOf(
    payload: Record<string, unknown>,
    content: Parameters<typeof kernelPresentationInputs>[0]['content'],
    withDeclaration: boolean,
    /**
     * 只取该 `materialIndex` 的四边形（C6 起生产图元**逐材质分组**；
     * 不筛就变成"拿一个组的顶点比全集"，必然判红）。
     */
    materialIndex?: number,
  ): Float32Array {
    const projected = projectGridCells({
      cells: payload.cells as Readonly<Record<string, string>>,
      geometry: payload.geometry as never,
      cellGeometry: payload.cellGeometry as never,
      cellPalette: payload.cellPalette as never,
      palette: payload.palette as never,
      cellContent: payload.cellContent as never,
      // 关键：声明三字段按需传入（负对照）—— 同一函数、同一份内容，唯一差别是判别子
      ...(withDeclaration
        ? {
            sizeColumn: payload.sizeColumn as number,
            sizeRow: payload.sizeRow as number,
            sizeZSlice: payload.sizeZSlice as number,
          }
        : {}),
    })
    const def = {
      geometryPhase: 'baked',
      cellGrid: projected.cellGrid,
      blockPalette: projected.blockPalette,
      materialPalette: content.resources.map((r) => ({ kind: r.kind })),
    } as never
    const pieces = collectStructureGeometryPiecesPure(def).pieces
    const merged = mergeBakedQuadPiecesAttributes(
      materialIndex === undefined
        ? pieces
        : pieces.filter((x) => x.materialIndex === materialIndex),
    )
    return merged.positions
  }

  function sameFloatBits(a: Float32Array, b: Float32Array): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }

  it('presenter 顶点 == "带声明"重算（逐位），且 **≠** "不带声明"重算', async () => {
    const { plain } = sparseRealGeometryPlain()
    const session = await adoptedSession(plain, 'p11a-sparse-real')
    try {
      const doc = session.document()!
      const payload = gridPayloads(doc)[0]!
      const bounds = boundsOfCells(payload.cells as Record<string, string>)
      const sourceDims = dimsOf(((plain.frames as Plain[])[0]!.structure as Plain).cellGrid)
      // 反空洞真：载荷声明 = 源文件声明，且包围盒在高度方向**确实**更小
      expect(
        { 声明: { w: payload.sizeColumn, h: payload.sizeRow, d: payload.sizeZSlice }, 包围盒: bounds },
        '前提：真实信封挖空顶 3 行后，高度方向的包围盒必须**小于**声明',
      ).toEqual({ 声明: { w: sourceDims.w, h: sourceDims.h, d: sourceDims.d }, 包围盒: bounds })
      expect(bounds.h, '高度：包围盒必须更小，否则本组无区分力').toBeLessThan(sourceDims.h)

      const produced = kernelPresentationInputs({ layerPreview: 'all', scene: doc.scene, content: doc.content, key: keyOf(doc.scene.id) })
      expect(produced.skipped, `presenter 不得跳过本夹具（实测：${JSON.stringify(produced.skipped)}）`).toEqual([])
      const primitive = produced.inputs.primitives[0]!
      const actual = produced.inputs.geometry.attributesOf(primitive.geometry.id)!.positions

      const mi = Number(primitive.material.id.slice('material:'.length))
      const declared = mergedPositionsOf(payload, doc.content, true)
      const stripped = mergedPositionsOf(payload, doc.content, false)
      expect(stripped.length, '两侧重算都必须真的产出顶点（否则"相同/不同"都是空洞真）').toBe(declared.length)
      expect(
        sameFloatBits(declared, stripped),
        '**判别子必须生效**：带声明与不带声明的重算必须**不同** —— 两者相同意味着声明被忽略（修前正是如此），本组随之失去区分力',
      ).toBe(false)
      expect(
        sameFloatBits(actual, mergedPositionsOf(payload, doc.content, true, mi)),
        'presenter 的顶点必须与该材质组的"带声明"重算逐位相同 ⇒ `definitionOfPayload` 真的把三字段传下去了',
      ).toBe(true)
    } finally {
      session.dispose()
    }
  })
})
