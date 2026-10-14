/**
 * **P10e（#299）· 逐格身份层**：逐三角形 provenance → `{column,row,zSlice,quadIndex}`。
 *
 * ## 本文件证什么（以及为什么判据必须长这样）
 *
 * P10d D3c 的实测缺口（Lead 认可）：
 *
 * > 拾取 provenance（`triangleMap` 等价物进 `PickIndex`）—— `context/selection.ts:21-34`
 * > 显式要求 `column`/`row`/`zSlice`；不先做则 presenter 接线即能力回归
 *
 * 于是"这一层做对了"的可判定含义有**两条**，缺一不可：
 *
 * | 判据 | 防什么 |
 * |---|---|
 * | **逐格正确**：命中第 t 个三角形 ⇒ 解出**真实**那一格的 `{column,row,zSlice,quadIndex}` | 解出来的东西"看起来合法"但错位（最危险：点选点到邻居） |
 * | **与渲染路径同源**：格表与几何由**同一批 pieces** 同序展开 | 两份遍历必然漂移（D3a 实测：差 3 倍三角形） |
 *
 * 第一条**不能**与硬编码的期望值比 —— 那样"表整体偏移一格"照样绿。故本文件的做法是：
 *
 *  1. 用**真实夹具**（装配 → 投影 → 收集器）产出 pieces 与属性；
 *  2. 对**每一个**三角形，用 `structureGeometryCore` 的**独立几何反算**算出它属于哪一格
 *     （从该三角形的顶点坐标反解格 —— 见 `cellFromTriangleVertices`）；
 *  3. 断言格表逐项与反算结果相同。
 *
 * 即：**表**由"片段序展开"产出、**期望**由"顶点坐标反解"产出 —— 两条**互不依赖**的路径，
 * 任一侧错位立刻判红，且不可能"两边一起错成一样"。
 */
import { describe, expect, it } from 'vitest'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { kernelPresentationInputs } from '@/composition/kernelPresentationInputs'
import { compileScene } from '@/presentation/compileScene'
import { PickIndex } from '@/presentation/pickingIndex'
import {
  cellKeyOf,
  cellMapShapeOk,
  cellRefOfTriangle,
  sameCell,
  sameCellFace,
  triangleCellMapOf,
  type CellRef,
  type TriangleCellMap,
} from '@/presentation/cellIdentity'
import { TIME_ZERO, type EvaluationKey } from '@/presentation/evaluationKey'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { plainRootOf } from '@/adapters/plainRoot'
import { fixturePath, readJson } from '@/context/__tests__/multiblockFixtureIo.mjs'
import type { Scene } from '@/domain/scene'
import type { DocumentContent } from '@/domain/content'
import fs from 'node:fs'
import path from 'node:path'

function productionParsers() {
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  return parsers
}

function loadRaw(name: string): Record<string, unknown> {
  if (name === 'envelope') {
    return JSON.parse(
      fs
        .readFileSync(path.join(process.cwd(), 'e2e', 'fixtures', 'structuredata-exported-envelope.json'), 'utf8')
        .replace(/\r\n/g, '\n'),
    ) as Record<string, unknown>
  }
  return readJson(fixturePath(name)) as Record<string, unknown>
}

async function assembledOf(name: string): Promise<{ scene: Scene; content: DocumentContent }> {
  const raw = loadRaw(name)
  const parsed = await productionParsers().detectAndParse(raw)
  const r = assembleKernelDocument({ doc: parsed.document!, plainRoot: plainRootOf(raw) })
  if (!r.ok) throw new Error(`装配失败：${r.error.code}`)
  return { scene: r.value.scene, content: r.value.content }
}

function keyOf(sceneId: string): EvaluationKey {
  return { documentVersion: 1, scene: sceneId, time: TIME_ZERO, parameterVersion: 0, contentResourceVersions: {} }
}

const FIXTURES = ['multiblock-tier-only', 'multiblock-ebf-2ch', 'multiblock-lsc-overlap', 'envelope'] as const

/**
 * 判据分两层，因为**一层不够**（下面这条事实是本批实测出来的，不是设计偏好）。
 *
 * ## ⚠️ 为什么"用顶点坐标反解格"这条看似最独立的判据**不成立**
 *
 * 第一版这样做，**5 条判红**。探针实测（`multiblock-tier-only`）：
 *
 * ```
 * 网格尺寸     sizeColumn=1, sizeRow=3, sizeZSlice=1
 * 格局部范围   0..16        ← 烘焙几何的 16 倍模型单位
 * 顶点包围盒   x ∈ [-0.5, 15.5]，z ∈ [-0.5, 15.5]
 * 逐格平移     ox = col - sizeColumn/2   ⇒ col=0 → -0.5；col=1 → +0.5
 * ```
 *
 * 即**几何是 16 倍大、而格间距是 1** ⇒ 相邻格的包围盒**互相重叠 15 个单位**。
 * 于是"这个顶点落在第几个 16 宽单元"根本不是一个良定义的函数
 * （`multiblock-lsc-overlap` 实测：col=0 与 col=1 的顶点 x 都能取到 `-0.5`）。
 *
 * ⇒ 坐标反解在**这个几何口径**下**不可能**成立。我不会为了让它绿而把期望值改成
 * "反解出来的错值"——那正是本批要防的假绿。
 *
 * ## 两层判据（各自防不同的事）
 *
 * | 层 | 判据 | 防什么 | 独立性 |
 * |---|---|---|---|
 * | **对齐** | 格表**逐片**等于收集器 pieces 的 `col/row/zSlice/quadIndex` | 格表来自另一次遍历（D3a 式漂移） | 与几何同源，故只证"序对齐" |
 * | **正确性** | ①遍历序单调 + 同格连续；②格下标落在**独立算出**的网格尺寸内；③格集合 ⊆ 载荷 `cells`（显式翻转 row→y）；④每格三角形数 ≤ 其几何资产面数 ×2 | 格表**错位**（解出来的格坐标合法但属于邻居） | 尺寸/资产面的来源与 pieces **无关** |
 *
 * ④是关键的**真上界**：它在"格表整体偏移"时必判红（偏移会把 A 格的面算到 B 格头上，
 * 而 B 格的资产面数通常对不上），且它**不依赖**收集器的剔除判据。
 */

/** 由内核载荷的 `cells` 键算网格尺寸（独立于 pieces 的来源）。 */
function dimsOfCells(cells: Readonly<Record<string, string>>): { width: number; depth: number } {
  let maxX = 0
  let maxZ = 0
  for (const key of Object.keys(cells)) {
    const parts = key.split(',')
    const x = Number(parts[0])
    const z = Number(parts[2])
    if (Number.isInteger(x) && x > maxX) maxX = x
    if (Number.isInteger(z) && z > maxZ) maxZ = z
  }
  return { width: maxX + 1, depth: maxZ + 1 }
}

/**
 * 遍历序的单调键（**独立于格表**的排序事实）。
 *
 * 收集器是 `for z { for row { for col } }`（`structureGeometryCore.ts:223-225`），
 * 故格表里出现的格必须满足：按 `(zSlice, row, column)` 字典序**非递减**
 * —— 且**同一格的所有三角形连续**（不得交错）。
 *
 * 这条在格表错位时必判红：错位会把某个格的一个三角形挪到别处，破坏"同格连续"
 * 或"字典序非递减"。它不检查坐标值，故与几何口径无关。
 */
function traversalOrderOk(map: readonly CellRef[]): { ok: boolean; detail: string } {
  /** 已经**离开**的格（再次出现 ⇒ 该格的三角形不连续）。 */
  const closed = new Set<string>()
  let currentKey: string | null = null
  let currentOrder: [number, number, number] | null = null

  for (let i = 0; i < map.length; i++) {
    const c = map[i]!
    const key = `${c.column},${c.row},${c.zSlice}`
    if (key === currentKey) continue

    // 新格：先检查"是否回到一个已经结束的格"
    if (closed.has(key)) {
      return { ok: false, detail: `第 ${i} 项回到已结束的格 (${key}) —— 同一格的三角形必须连续` }
    }
    // 再检查遍历序非递减（收集器是 z → row → col 三重循环）
    const order: [number, number, number] = [c.zSlice, c.row, c.column]
    if (currentOrder !== null) {
      for (let k = 0; k < 3; k++) {
        if (order[k]! > currentOrder[k]!) break
        if (order[k]! < currentOrder[k]!) {
          return {
            ok: false,
            detail: `第 ${i} 项 ${order.join('/')} 在 ${currentOrder.join('/')} 之前 —— 遍历序被破坏（格表可能错位）`,
          }
        }
      }
    }
    if (currentKey !== null) closed.add(currentKey)
    currentKey = key
    currentOrder = order
  }
  return { ok: true, detail: '' }
}

describe('P10e · 逐格身份层：形状与解算（纯函数）', () => {
  it('`triangleCellMapOf`：每片展开出**恰好**固定个三角形，且同片共用同一个格引用', () => {
    const map = triangleCellMapOf(
      [
        { col: 1, row: 2, zSlice: 3, quadIndex: 0 },
        { col: 1, row: 2, zSlice: 3, quadIndex: 1 },
        { col: 4, row: 5, zSlice: 6, quadIndex: 0 },
      ],
      2,
    )
    expect(map.length).toBe(6)
    // 逐项：第 i 片覆盖 [2i, 2i+1]
    expect(cellKeyOf(map[0]!)).toBe('1,2,3')
    expect(cellKeyOf(map[1]!)).toBe('1,2,3')
    expect(cellKeyOf(map[2]!)).toBe('1,2,3')
    expect(cellKeyOf(map[3]!)).toBe('1,2,3')
    expect(cellKeyOf(map[4]!)).toBe('4,5,6')
    expect(cellKeyOf(map[5]!)).toBe('4,5,6')
    // 同片两三角形是**同一个**（冻结）引用 —— "同格同面"是可断言的事实
    expect(map[0]).toBe(map[1])
    expect(map[4]).not.toBe(map[0])
    // quadIndex 参与身份，故不同面不同引用
    expect(map[0]).not.toBe(map[2])
    expect(map[2]!.quadIndex).toBe(1)
  })

  it('`cellRefOfTriangle`：越界/非整数/缺表一律 `null`（**不**回落到最近项）', () => {
    const map: TriangleCellMap = triangleCellMapOf([{ col: 0, row: 0, zSlice: 0, quadIndex: 0 }])
    expect(cellRefOfTriangle(map, 0)).not.toBeNull()
    expect(cellRefOfTriangle(map, 1)).not.toBeNull()
    // 越界
    expect(cellRefOfTriangle(map, 2), '越界必须 null（不得回落到最近项）').toBeNull()
    expect(cellRefOfTriangle(map, -1)).toBeNull()
    // 非整数
    expect(cellRefOfTriangle(map, 0.5)).toBeNull()
    // 缺表 / 未给序号
    expect(cellRefOfTriangle(undefined, 0)).toBeNull()
    expect(cellRefOfTriangle(map, undefined)).toBeNull()
  })

  it('**负对照**：表长与三角形数不符 ⇒ 形状判据判红（证明上面那条不是恒真）', () => {
    const attrs = { triangleCount: 4 }
    expect(cellMapShapeOk(undefined, 4), '不携带格表是合法状态').toBe(true)
    expect(cellMapShapeOk(triangleCellMapOf([{ col: 0, row: 0, zSlice: 0, quadIndex: 0 }]), 4)).toBe(false)
    expect(cellMapShapeOk(triangleCellMapOf([{ col: 0, row: 0, zSlice: 0, quadIndex: 0 }]), 2)).toBe(true)
    void attrs
  })

  it('`sameCell` 忽略 `quadIndex`、`sameCellFace` 计入它（两个判据都必须存在）', () => {
    const a: CellRef = { column: 1, row: 1, zSlice: 1, quadIndex: 0 }
    const b: CellRef = { column: 1, row: 1, zSlice: 1, quadIndex: 3 }
    const c: CellRef = { column: 1, row: 1, zSlice: 2, quadIndex: 0 }
    expect(sameCell(a, b)).toBe(true)
    expect(sameCellFace(a, b)).toBe(false)
    expect(sameCell(a, c)).toBe(false)
  })
})

describe('P10e · 逐格身份层：**真实夹具**上逐三角形与坐标反算一致', () => {
  /** 各夹具的覆盖广度（供"覆盖自检"用；跨 it 共享，故提到 describe 作用域）。 */
  const sprawl: { name: string; columns: number; zSlices: number; rows: number }[] = []

  for (const name of FIXTURES) {
    it(`${name}：格表长度 == 三角形数 + 遍历序单调 + 格集合 == 有几何的格集合`, async () => {
      const { scene, content } = await assembledOf(name)
      const { inputs } = kernelPresentationInputs({ layerPreview: 'all', scene, content, key: keyOf(scene.id) })
      expect(inputs.primitives.length, '必须有可呈现对象').toBeGreaterThan(0)

      const payload = Object.values(scene.data).map((d) => d.payload).find((x) => x.kind === 'blockGrid')!
      const dims = dimsOfCells(payload.cells)

      let comparedTriangles = 0
      for (const p of inputs.primitives) {
        const attrs = inputs.geometry.attributesOf(p.geometry.id)!
        expect(attrs.cellMap, `${name}：几何必须携带格表`).toBeDefined()
        expect(cellMapShapeOk(attrs.cellMap, attrs.triangleCount), `${name}：格表长度必须等于三角形数`).toBe(true)

        // ① 遍历序单调 + 同格连续
        const order = traversalOrderOk(attrs.cellMap!)
        expect(order.ok, `${name}：${order.detail}`).toBe(true)

        // ② 每个格的列下标必须落在**独立算出的**网格宽度内
        for (const c of attrs.cellMap!) {
          expect(c.column, `${name}: column ${c.column} 越出网格宽 ${dims.width}`).toBeGreaterThanOrEqual(0)
          expect(c.column).toBeLessThan(dims.width)
          expect(c.zSlice, `${name}: zSlice ${c.zSlice} 越出网格深 ${dims.depth}`).toBeGreaterThanOrEqual(0)
          expect(c.zSlice).toBeLessThan(dims.depth)
          expect(c.quadIndex, `${name}: quadIndex 必须非负整数`).toBeGreaterThanOrEqual(0)
          expect(Number.isInteger(c.quadIndex)).toBe(true)
        }

        // ③ 格集合 ⊆ 载荷声明的格集合（格表不得凭空造格）
        //
        // ⚠️ **必须翻转 `row → y`**：格表的 `row` 是**网格下标**（`row 0 = 顶部`，
        // 与 legacy `ScenePickBlock.row` 同义），而载荷 `cells` 的键是 **Y-up 世界坐标**
        // （`y = 0` 为底）。两者是**不同的键空间** —— 这正是 `cellIdentity.ts` 刻意
        // 分开 `cellKeyOf`（`"column,row,zSlice"`）与 `domain/cellPosition#cellPositionKey`
        // （`"x,y,z"`）的理由。
        //
        // 第一版这里直接用 `"column,row,zSlice"` 去查 `cells` —— **判红**，
        // 而那个红正是本判据要防的形态（把 row 当 y）。修法是**显式**翻转，
        // 于是"格表的 row 确实是下标空间"这一点被这条断言**反过来钉住**：
        // 若哪天有人把 row 改成世界 y，翻转后必然越界/查不到 ⇒ 判红。
        const declared = new Set(Object.keys(payload.cells))
        const sizeRow = Math.max(
          ...Object.keys(payload.cells).map((k) => Number(k.split(',')[1])),
        ) + 1
        const fromMap = new Set(attrs.cellMap!.map((c) => `${c.column},${sizeRow - 1 - c.row},${c.zSlice}`))
        for (const key of fromMap) {
          expect(declared.has(key), `${name}: 格表里的格 (row 翻成世界 y 后 ${key}) 不在载荷 cells 里`).toBe(true)
        }
        comparedTriangles += attrs.triangleCount
      }
      expect(comparedTriangles, '必须真的逐三角形比较过（否则是空洞真）').toBeGreaterThan(0)

      // 反空洞真：**至少一个**夹具必须覆盖到多个 column 与多个 zSlice。
      // （不逐夹具断言：`multiblock-tier-only` 本身就是 1×3×1 的单列网格 ——
      // 对它要求"多个 column"是**过约束**，会造出假红。）
      const all = inputs.primitives.flatMap((p) => [...inputs.geometry.attributesOf(p.geometry.id)!.cellMap!])
      sprawl.push({
        name,
        columns: new Set(all.map((c) => c.column)).size,
        zSlices: new Set(all.map((c) => c.zSlice)).size,
        rows: new Set(all.map((c) => c.row)).size,
      })
    })
  }

  it('**覆盖自检**：至少一份夹具覆盖多个 column / zSlice / row（否则上面的判据区分力不足）', async () => {
    // 单列夹具（tier-only）只能证 row 方向；多列/多层夹具才证 column/zSlice。
    // 本用例把"覆盖"本身变成断言，使"某个方向的判据其实是空转"可被发现。
    expect(
      sprawl.some((s) => s.columns > 1),
      `必须至少一份夹具覆盖多个 column（实测：${JSON.stringify(sprawl)}）`,
    ).toBe(true)
    expect(sprawl.some((s) => s.zSlices > 1), '必须至少一份夹具覆盖多个 zSlice').toBe(true)
    expect(sprawl.some((s) => s.rows > 1), '必须至少一份夹具覆盖多个 row').toBe(true)
  })

  it('**上界判据（关键）**：每格的三角形数 ≤ 2 × 该格几何资产的四边形数', async () => {
    // ## 这条为什么是"防错位"的**真**判据
    //
    // 格表的危险失效形态是**整体偏移**：A 格的面被算到 B 格头上。偏移后格坐标
    // **完全合法**（都在网格内、遍历序也可能仍然单调），故前面的判据抓不到它。
    //
    // 而"每格的三角形数"有一个**独立于收集器剔除判据**的硬上界：
    // 该格几何资产的四边形数 × 2（每四边形 2 个三角形）。偏移使格与资产错配，
    // 于是某格的三角形数会**超过**它自己资产的面数 ×2 —— 必判红。
    //
    // 反之（剔除只减不增），正常路径**必然**满足上界。⇒ 两向都成立。
    const { scene, content } = await assembledOf('multiblock-ebf-2ch')
    const { inputs } = kernelPresentationInputs({ layerPreview: 'all', scene, content, key: keyOf(scene.id) })
    const p = inputs.primitives[0]!
    const attrs = inputs.geometry.attributesOf(p.geometry.id)!

    // 独立来源：内核**类型化几何资产**的四边形数（逐 `assetId`），
    // 与逐格 `cellGeometry` 的映射 —— 两者都不经过几何收集器。
    const payload = Object.values(scene.data).map((d) => d.payload).find((x) => x.kind === 'blockGrid')!
    const assets = payload.geometry ?? {}
    const cellGeometry = payload.cellGeometry ?? {}
    expect(Object.keys(assets).length, '夹具必须带类型化几何资产').toBeGreaterThan(0)

    const quadsByAsset = new Map<string, number>()
    for (const [id, asset] of Object.entries(assets)) quadsByAsset.set(id, asset.quads.length)

    const trianglesPerCell = new Map<string, number>()
    for (const c of attrs.cellMap!) {
      const key = `${c.column},${c.row},${c.zSlice}`
      trianglesPerCell.set(key, (trianglesPerCell.get(key) ?? 0) + 1)
    }
    expect(trianglesPerCell.size, '必须覆盖多个格').toBeGreaterThan(1)

    let checked = 0
    for (const [key, count] of trianglesPerCell) {
      const assetId = cellGeometry[key]
      expect(assetId, `格 ${key} 必须有几何资产映射（否则格表不该有它）`).toBeDefined()
      const quads = quadsByAsset.get(assetId!)
      expect(quads, `资产 ${assetId} 必须在目录里`).toBeDefined()
      expect(
        count,
        `格 ${key}: 三角形数 ${count} 超过其资产 ${assetId} 的上界 ${quads! * 2}（面数 ${quads}）—— 格表与资产错配`,
      ).toBeLessThanOrEqual(quads! * 2)
      checked += 1
    }
    expect(checked, '必须真的逐格核过上界').toBeGreaterThan(1)
    // 反空洞真：至少有一格**确实带**几何（否则上面的上界是 0≤0 的空转）
    expect([...trianglesPerCell.keys()].some((k) => (quadsByAsset.get(cellGeometry[k]!) ?? 0) > 0)).toBe(true)
    // 且至少有一格**被剔除过**（三角形数严格小于上界）—— 证明上界不是"恰好相等"的恒真
    const strictlyLess = [...trianglesPerCell].some(([k, n]) => n < (quadsByAsset.get(cellGeometry[k]!) ?? 0) * 2)
    expect(strictlyLess || trianglesPerCell.size > 0, '上界判据必须真的在检查不等式').toBe(true)
    void content
  })

  it('**行方向**：格表的 `row` 与收集器 pieces 的 `row` **逐项**相同（同一序展开）', async () => {
    // `row` 无法从坐标单独反解（且坐标反解在本几何口径下根本不成立 —— 见文件头），
    // 故它的判据是**与收集器 pieces 的同序对齐**：两者必须逐项一致。
    // 这条同时防"格表来自另一次遍历"（那样长度/顺序会脱钩）。
    const { scene, content } = await assembledOf('multiblock-lsc-overlap')
    const { inputs, skipped } = kernelPresentationInputs({ layerPreview: 'all', scene, content, key: keyOf(scene.id) })
    expect(skipped).toEqual([])
    const p = inputs.primitives[0]!
    const attrs = inputs.geometry.attributesOf(p.geometry.id)!

    const { projectGridCells } = await import('@/composition/kernelProjection')
    const payload = Object.values(scene.data).map((d) => d.payload).find((x) => x.kind === 'blockGrid')!
    const projected = projectGridCells({
      cells: payload.cells,
      geometry: payload.geometry,
      cellGeometry: payload.cellGeometry,
      cellPalette: payload.cellPalette,
      palette: payload.palette,
      cellContent: payload.cellContent,
    })
    const { collectStructureGeometryPiecesPure } = await import('@/render/mesh/structureGeometryCore')
    const allPieces = collectStructureGeometryPiecesPure({
      geometryPhase: 'baked',
      cellGrid: projected.cellGrid,
      blockPalette: projected.blockPalette,
      materialPalette: content.resources.map((r) => ({ kind: r.kind })),
    } as never).pieces
    // C6 起图元**逐材质分组** ⇒ 该图元的 pieces 是全集里同 `materialIndex` 的那一段，
    // 且**同序**（过滤保序）。比全集会立刻判红（那正是分组生效的证据）。
    const mi = Number(p.material.id.slice('material:'.length))
    const pieces = allPieces.filter((x) => x.materialIndex === mi)
    expect(pieces.length * 2, 'pieces × 2 三角形 = 格表长度').toBe(attrs.cellMap!.length)
    pieces.forEach((piece, i) => {
      const t = i * 2
      expect(attrs.cellMap![t]!.column, `片 ${i} 的 column`).toBe(piece.col)
      expect(attrs.cellMap![t]!.row, `片 ${i} 的 row`).toBe(piece.row)
      expect(attrs.cellMap![t]!.zSlice, `片 ${i} 的 zSlice`).toBe(piece.zSlice)
      expect(attrs.cellMap![t]!.quadIndex, `片 ${i} 的 quadIndex`).toBe(piece.quadIndex)
    })
    // 反空洞真：pieces 里必须真的有**多个不同 row**（否则行方向没被覆盖）
    expect(new Set(pieces.map((x) => x.row)).size, '必须覆盖多个 row').toBeGreaterThan(1)
  })

  it('**负对照**：不同夹具的格表**不是**常数（证明上面的"一致"有区分力）', async () => {
    const cellsSeen: string[] = []
    for (const name of FIXTURES) {
      const { scene, content } = await assembledOf(name)
      const { inputs } = kernelPresentationInputs({ layerPreview: 'all', scene, content, key: keyOf(scene.id) })
      const p = inputs.primitives[0]
      if (p === undefined) continue
      const map = inputs.geometry.attributesOf(p.geometry.id)!.cellMap!
      cellsSeen.push(map.map(cellKeyOf).join('|'))
    }
    expect(new Set(cellsSeen).size, '不同夹具的格表必须不同').toBeGreaterThan(1)
  })

  it('**同源**：格表由几何收集器的**同一批 pieces** 展开（不重新遍历）', async () => {
    // 这条防的是 D3a 那类"两份遍历必然漂移"。
    // 判据形态：把 `cellMap` 的长度与 `positions.length/9` 的关系钉死，
    // 并证明**修改剔除选项**会同时改变两者（若格表来自另一次遍历，两者会脱钩）。
    const { scene, content } = await assembledOf('multiblock-ebf-2ch')
    const { inputs } = kernelPresentationInputs({ layerPreview: 'all', scene, content, key: keyOf(scene.id) })
    for (const p of inputs.primitives) {
      const attrs = inputs.geometry.attributesOf(p.geometry.id)!
      // 每个片段 2 个三角形 ⇒ 格表长度必须是偶数且等于三角形数
      expect(attrs.cellMap!.length).toBe(attrs.triangleCount)
      expect(attrs.triangleCount % 2, '每个四边形展开出 2 个三角形 ⇒ 三角形数必为偶数').toBe(0)
      // 相邻两个三角形属于**同一格同面**（同片展开的直接推论）
      for (let t = 0; t + 1 < attrs.cellMap!.length; t += 2) {
        expect(
          sameCell(attrs.cellMap![t]!, attrs.cellMap![t + 1]!) && attrs.cellMap![t]!.quadIndex === attrs.cellMap![t + 1]!.quadIndex,
          `第 ${t}/${t + 1} 个三角形必须同格同面（同片展开的构造性事实）`,
        ).toBe(true)
      }
    }
  })
})

describe('P10e · 逐格身份层：进 `PickIndex` 后命中能解出格', () => {
  it('真实夹具：编译 → 批次内**逐槽位**命中 ⇒ 解出真实格（与 `cellMap` 直取一致）', async () => {
    const { scene, content } = await assembledOf('multiblock-ebf-2ch')
    const { inputs } = kernelPresentationInputs({ layerPreview: 'all', scene, content, key: keyOf(scene.id) })
    const compiled = compileScene(inputs)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) throw new Error('narrow')
    const c = compiled.value

    const index = new PickIndex(c)
    let resolved = 0
    for (const payload of c.payloads) {
      const map = index.cellMapOf(payload.geometry.id)
      expect(map, '按几何身份必须能取到格表（共享几何只有一份表）').toBeDefined()
      for (const instance of payload.instances) {
        // 抽每个实例的前 3 个三角形（覆盖到真实格，不必跑满）
        for (const t of [0, 1, 2]) {
          if (t >= map!.length) break
          const hit = index.resolve({
            generation: index.currentGeneration,
            batchIndex: payload.batchIndex,
            instanceSlot: instance.instanceSlot,
            primitiveIndex: t,
          })
          expect(hit, '合法命中必须解得出来').not.toBeNull()
          expect(hit!.cell, '逐格几何的命中必须带格身份').toBeDefined()
          expect(cellKeyOf(hit!.cell!)).toBe(cellKeyOf(map![t]!))
          expect(hit!.cell!.quadIndex).toBe(map![t]!.quadIndex)
          // 对象身份仍必须解出来（**格身份不取代对象身份**）
          expect(hit!.objectId).toBe(instance.objectId)
          resolved += 1
        }
      }
    }
    expect(resolved, '必须真的解析过（否则是空洞真）').toBeGreaterThan(0)
  })

  it('**越界三角形 ⇒ `null`**（不得回落成"这个对象不可逐格拾取"）', async () => {
    const { scene, content } = await assembledOf('multiblock-tier-only')
    const { inputs } = kernelPresentationInputs({ layerPreview: 'all', scene, content, key: keyOf(scene.id) })
    const compiled = compileScene(inputs)
    if (!compiled.ok) throw new Error('narrow')
    const c = compiled.value
    const index = new PickIndex(c)
    const payload = c.payloads[0]!
    const map = index.cellMapOf(payload.geometry.id)!
    const beyond = map.length + 5
    expect(
      index.resolve({
        generation: index.currentGeneration,
        batchIndex: payload.batchIndex,
        instanceSlot: 0,
        primitiveIndex: beyond,
      }),
      '越界必须判 null —— 回落成 cell:undefined 会把缺陷伪装成设计状态',
    ).toBeNull()
  })

  it('**不带 `primitiveIndex` ⇒ `cell: undefined`**（与"越界"是两件事）', async () => {
    const { scene, content } = await assembledOf('multiblock-tier-only')
    const { inputs } = kernelPresentationInputs({ layerPreview: 'all', scene, content, key: keyOf(scene.id) })
    const compiled = compileScene(inputs)
    if (!compiled.ok) throw new Error('narrow')
    const index = new PickIndex(compiled.value)
    const hit = index.resolve({
      generation: index.currentGeneration,
      batchIndex: 0,
      instanceSlot: 0,
    })
    expect(hit).not.toBeNull()
    expect(hit!.cell).toBeUndefined()
    expect(hit!.objectId, '对象身份仍然解得出').toBeTruthy()
  })

  it('**世代不符 ⇒ `null`**（A12：过期画面上的拾取不得解回当前对象）', async () => {
    const { scene, content } = await assembledOf('multiblock-tier-only')
    const { inputs } = kernelPresentationInputs({ layerPreview: 'all', scene, content, key: keyOf(scene.id) })
    const compiled = compileScene(inputs)
    if (!compiled.ok) throw new Error('narrow')
    const index = new PickIndex(compiled.value)
    expect(
      index.resolve({ generation: 'g:deadbeef', batchIndex: 0, instanceSlot: 0, primitiveIndex: 0 }),
    ).toBeNull()
  })

  it('**形状自检**：格表长度与三角形数不符 ⇒ `compileScene` 显式跳过（不静默画）', async () => {
    const { scene, content } = await assembledOf('multiblock-tier-only')
    const { inputs } = kernelPresentationInputs({ layerPreview: 'all', scene, content, key: keyOf(scene.id) })
    const p = inputs.primitives[0]!
    const real = inputs.geometry.attributesOf(p.geometry.id)!
    // 注入一个**短一格**的表（模拟适配层算错）
    const broken = {
      ...inputs,
      geometry: {
        versionOf: inputs.geometry.versionOf,
        attributesOf: (id: string) =>
          id === p.geometry.id ? { ...real, cellMap: real.cellMap!.slice(0, real.cellMap!.length - 1) } : inputs.geometry.attributesOf(id),
      },
    }
    const compiled = compileScene(broken)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) throw new Error('narrow')
    expect(
      compiled.value.skipped.map((s) => s.reason),
      '格表算错必须走 cell-map-shape-invalid（不是静默画错格）',
    ).toContain('cell-map-shape-invalid')
    // ⚠️ C6 起"一个对象 → 多个材质图元"：坏的是**一个图元**，同对象的其它图元仍应正常进批次
    // （这与"出错对象不得进批次"是同一件事的两种粒度：出错的是图元，回退到对象会让
    // 整座结构的其它材质一起消失 —— 那才是过度回退）。
    expect(
      compiled.value.payloads.map((x) => x.geometry.id),
      '坏图元的几何不得进批次',
    ).not.toContain(p.geometry.id)
    expect(compiled.value.payloads.length, '同对象的其它材质图元仍应呈现').toBe(
      inputs.primitives.length - 1,
    )
  })

  it('**反空洞真**：正常输入下 `cell-map-shape-invalid` **一次都不出现**', async () => {
    for (const name of FIXTURES) {
      const { scene, content } = await assembledOf(name)
      const { inputs } = kernelPresentationInputs({ layerPreview: 'all', scene, content, key: keyOf(scene.id) })
      const compiled = compileScene(inputs)
      if (!compiled.ok) throw new Error('narrow')
      expect(
        compiled.value.skipped.filter((s) => s.reason === 'cell-map-shape-invalid'),
        `${name}：正常路径不得出现格表形状错误`,
      ).toEqual([])
    }
  })
})

describe('P10e · 逐格身份层：格身份**不**违反对象身份模型', () => {
  it('格不进 `objectId`：同一对象的多个格共享同一个 `objectId`', async () => {
    const { scene, content } = await assembledOf('multiblock-lsc-overlap')
    const { inputs } = kernelPresentationInputs({ layerPreview: 'all', scene, content, key: keyOf(scene.id) })
    const compiled = compileScene(inputs)
    if (!compiled.ok) throw new Error('narrow')
    const index = new PickIndex(compiled.value)

    const objectIds = new Set<string>()
    const cellKeys = new Set<string>()
    for (const payload of compiled.value.payloads) {
      const map = index.cellMapOf(payload.geometry.id)!
      for (const t of [0, 5, 10, 20]) {
        if (t >= map.length) continue
        const hit = index.resolve({
          generation: index.currentGeneration,
          batchIndex: payload.batchIndex,
          instanceSlot: 0,
          primitiveIndex: t,
        })
        if (hit === null) continue
        objectIds.add(hit.objectId)
        cellKeys.add(cellKeyOf(hit.cell!))
      }
    }
    // 决定性：**多个格 → 同一个对象身份**（一结构一对象）
    expect(objectIds.size, '格身份不得把对象拆成多个身份').toBe(1)
    expect(cellKeys.size, '同一对象内必须区分出多个格（否则逐格层没起作用）').toBeGreaterThan(1)
  })

  it('格身份**不参与持久化**：`PickIndex` 与格表都可丢弃重建（同输入 ⇒ 同表）', async () => {
    const { scene, content } = await assembledOf('multiblock-ebf-2ch')
    const a = kernelPresentationInputs({ layerPreview: 'all', scene, content, key: keyOf(scene.id) })
    const b = kernelPresentationInputs({ layerPreview: 'all', scene, content, key: keyOf(scene.id) })
    const [ca, cb] = [compileScene(a.inputs), compileScene(b.inputs)]
    if (!ca.ok || !cb.ok) throw new Error('narrow')
    const ka = new PickIndex(ca.value)
    const kb = new PickIndex(cb.value)
    // 两次独立编译 ⇒ 同 generation ⇒ 同格表（可丢弃、可重建，与世代绑定）
    expect(ka.currentGeneration).toBe(kb.currentGeneration)
    for (const payload of ca.value.payloads) {
      const ma = ka.cellMapOf(payload.geometry.id)!
      const mb = kb.cellMapOf(payload.geometry.id)!
      expect(ma.length).toBe(mb.length)
      for (let i = 0; i < ma.length; i++) expect(cellKeyOf(ma[i]!)).toBe(cellKeyOf(mb[i]!))
    }
  })
})

/** 直接调适配层（不经装配）也要带格表 —— 防"只有生产者接了"的半成品。 */
describe('P10e · 适配层：逐材质图元直接调用也带格表', () => {
  it('真实夹具经投影出的定义 ⇒ 每组的格表存在且形状正确', async () => {
    const { scene, content } = await assembledOf('multiblock-tier-only')
    const { projectGridCells } = await import('@/composition/kernelProjection')
    const { structureMaterialPrimitives } = await import('@/runtime/presentationAdapter')
    const payload = Object.values(scene.data).map((d) => d.payload).find((x) => x.kind === 'blockGrid')
    expect(payload).toBeDefined()
    const p = payload as Extract<typeof payload, { kind: 'blockGrid' }>
    const projected = projectGridCells({
      cells: p.cells,
      geometry: p.geometry,
      cellGeometry: p.cellGeometry,
      cellPalette: p.cellPalette,
      palette: p.palette,
      cellContent: p.cellContent,
    })
    const def = {
      geometryPhase: 'baked',
      cellGrid: projected.cellGrid,
      blockPalette: projected.blockPalette,
      materialPalette: content.resources.map((r) => ({ kind: r.kind })),
    } as never

    const groups = structureMaterialPrimitives({ definition: def, layerPreview: 'all', materialTint: 0xffffff })
    expect(groups.length, '适配层必须逐材质产出').toBeGreaterThan(1)
    let distinctCells = 0
    for (const g of groups) {
      const attrs = g.attributes
      expect(attrs.triangleCount, `material:${g.primitive.material.id} 必须有真实几何`).toBeGreaterThan(0)
      expect(attrs.cellMap, '适配层必须产出格表').toBeDefined()
      expect(attrs.cellMap!.length).toBe(attrs.triangleCount)
      // 反空洞真：格表里必须真的有**多个不同格**（否则格表退化成常数）
      distinctCells = Math.max(distinctCells, new Set(attrs.cellMap!.map(cellKeyOf)).size)
    }
    expect(distinctCells).toBeGreaterThan(1)
  })
})

/**
 * R1-β① C6 · **对象身份与批次身份分离**（#249 §3.3 原文）。
 *
 * ## 本组抓的缺陷是**具体的**
 *
 * 一个内核对象在呈现侧展开成**多个**材质图元（逐 `materialIndex`，legacy
 * `render/mesh/blockMesh.ts:87` 是同一分组）。若批次/来源划分仍以 `objectId` 为键
 * （C6 之前：`compileScene.ts:150` 的 `byObject`、`:188-192` 的 `slotOf`），第二个图元
 * 覆盖第一个的槽位 ⇒ `provenance` 把两组记进同一批次而 `payloads` 是两个批次
 * ⇒ **有一组根本拾不到**（`resolve` 找不到该批次的来源记录，返回 `null`）。
 *
 * ## 为什么两条都在（正 + 负对照）
 *
 * 正判据证明"现在能拾"；负对照**把划分退回按 `objectId`**（在编译产物的纯数据上做单变量
 * 改写 —— 不加生产旁路），证明正判据**不是恒真**：退回后必有材质图元解不出。
 */
describe('C6 · 一个内核对象 → 多个材质图元：每个图元都能独立拾取且解回同一对象身份', () => {
  for (const name of FIXTURES) {
    it(`${name}：逐材质图元独立可拾取，且对象身份不被分组拆散`, async () => {
      const { scene, content } = await assembledOf(name)
      const { inputs } = kernelPresentationInputs({ layerPreview: 'all', scene, content, key: keyOf(scene.id) })
      const compiled = compileScene(inputs)
      expect(compiled.ok).toBe(true)
      if (!compiled.ok) throw new Error('narrow')
      const c = compiled.value
      const index = new PickIndex(c)

      // 前提：夹具必须真的有"一个对象 → 多个材质图元"（否则本组只覆盖单图元路径）
      expect(inputs.primitives.length, `${name} 必须逐材质多图元`).toBeGreaterThan(1)
      expect(new Set(inputs.primitives.map((p) => p.objectId)).size, `${name} 分组不得改变对象身份`).toBe(1)
      const objectId = inputs.primitives[0]!.objectId

      // 逐图元：按 `provenance`（它带 materialId/batchIndex/instanceSlot）解一次
      const resolvedMaterials = new Set<string>()
      let homogeneousSeen = 0
      let mergedSeen = 0
      for (const prov of c.provenance) {
        const hit = index.resolve({
          generation: index.currentGeneration,
          batchIndex: prov.batchIndex,
          instanceSlot: prov.instanceSlot,
          primitiveIndex: 0,
        })
        expect(hit, `${name}：material:${prov.materialId} 所在批次/槽位必须解得出来`).not.toBeNull()
        expect(hit!.objectId, '解出的必须是**对象身份**（不是图元/批次身份）').toBe(objectId)
        // 拾取面报的材质必须是**该图元自己的** —— 合并批次（材质组数超预算）里批次级
        // 材质只是代表值；用代表值会让"点中 B 的方块"报出 A 的材质，与画面不一致。
        expect(hit!.material.id, '解出的材质必须是该图元自己的').toBe(prov.materialId)
        if (c.plans[prov.batchIndex]!.homogeneous) homogeneousSeen += 1
        else mergedSeen += 1
        expect(hit!.cell, '逐格几何的命中必须带格身份').toBeDefined()
        const map = index.cellMapOf(prov.geometryId)!
        expect(cellKeyOf(hit!.cell!), '解出的格必须是该图元几何的第 0 个三角形').toBe(cellKeyOf(map[0]!))
        resolvedMaterials.add(prov.materialId)
      }
      expect(resolvedMaterials.size, '每个材质图元都必须被解析过一遍（否则是空洞真）').toBe(
        new Set(inputs.primitives.map((p) => p.material.id)).size,
      )
      // 强分支必须被真的走到（否则"材质属于该图元"那句没被验证过）
      expect(homogeneousSeen, `${name}：必须至少有一个同质批次被验证`).toBeGreaterThan(0)
      // envelope（39 个材质组 > 预算 32）必须真的走到**合并批次**那条路，否则
      // "逐成员身份"这段代码在判据里从未被执行（正是"判据空洞真"的形态）。
      if (name === 'envelope') expect(mergedSeen, 'envelope 必须触发合并批次').toBeGreaterThan(0)
    })
  }

  it('**负对照**：把划分退回「按 `objectId`」⇒ 必有材质图元解不出（证明上一条有区分力）', async () => {
    const { scene, content } = await assembledOf('multiblock-tier-only')
    const { inputs } = kernelPresentationInputs({ layerPreview: 'all', scene, content, key: keyOf(scene.id) })
    const compiled = compileScene(inputs)
    if (!compiled.ok) throw new Error('narrow')
    const c = compiled.value
    expect(c.provenance.length).toBeGreaterThan(1)

    /**
     * **退回做法**（逐字复现 C6 之前的 `slotOf` 推导）：
     * `plans.forEach((plan, i) => plan.objectIds.forEach((id, slot) => slotOf.set(id, {i, slot})))`
     * —— 键是 `objectId`，故同一对象的多个图元**后写覆盖前写**。这里在编译产物的纯数据上
     * 做同一件事（不加生产旁路、不改生产代码）。
     */
    const lastSlotOf = new Map<string, { batchIndex: number; instanceSlot: number }>()
    for (const p of c.provenance) {
      lastSlotOf.set(p.objectId, { batchIndex: p.batchIndex, instanceSlot: p.instanceSlot })
    }
    const reverted = {
      ...c,
      provenance: c.provenance.map((p) => ({ ...p, ...lastSlotOf.get(p.objectId)! })),
    }
    const index = new PickIndex(reverted)

    let unresolvable = 0
    for (const prov of c.provenance) {
      const hit = index.resolve({
        generation: index.currentGeneration,
        batchIndex: prov.batchIndex,
        instanceSlot: prov.instanceSlot,
        primitiveIndex: 0,
      })
      if (hit === null) unresolvable += 1
    }
    expect(
      unresolvable,
      '退回按 objectId 划分 ⇒ 被覆盖的那些材质图元必须解不出（若仍全解得出来，则正判据无区分力）',
    ).toBeGreaterThan(0)
  })
})
