/**
 * **#87 半透明材质的邻面剔除必须按「方块状态」判，不能按「调色板槽位」判**。
 *
 * ## 缺陷（用户裁决）
 *
 * ACC（`GoodGenerator:antimatterContainmentCasing`，CTM 连通玻璃外壳）在 web 视口里：
 * 成对相邻的两块**共享面被画出来**（白框线）、多层玻璃看起来互相穿透；游戏侧该面从不渲染。
 *
 * ## 根因（代码级）
 *
 * `render/mesh/structureGeometryCore` 判"邻格是不是同一方块"时用的是 **palette 下标相等**
 * （旧实现 `nidx === paletteIndex`）。而 palette 槽位是**渲染变体**：同一方块状态因渲染期
 * 差异（CTM 连通解析…）会被导出成**多个条目**。实测这份真实导出里成对的两格是
 * `blockPalette[2]` 与 `blockPalette[3]`（同 `registryId`、同 meta 0、无 facing/nbt），
 * 于是"同一方块"被判成"不同方块" ⇒ 共享面留在几何里。
 *
 * 游戏侧的判据是**方块身份**而不是渲染变体：GT `BlockFrame#shouldSideBeRendered` 判
 * `getBlock(...) instanceof BlockFrame`（运行期 5.09.54.194 的 jar 已 javap 双核：
 * `iconst_0 ireturn` 分支 + `iconst_1 ireturn` 的 `getRenderBlockPass`）。
 *
 * ## 判据分组
 *
 * | 组 | 判据 |
 * |---|---|
 * | ① | **生产装配**（真实信封 → 内核 → 投影 → 生产几何核心）：成对 ACC 的共享面**零四边形**，两侧各自的面集合精确，孤立 ACC 六面完整（防过度剔除） |
 * | ② | **负对照**：同一份装配关掉剔除 ⇒ 共享面**确实在导出件里**（2 层 × 2 侧 = 4 片）—— 证明剔除正是它们消失的原因，并固定"捕获侧多录"这个事实 |
 * | ③ | **语义边界**（纯）：同状态不同槽位 ⇒ 剔；meta / facing / nbt / registryId 任一不同 ⇒ **不剔**（防判据过宽） |
 * | ④ | **混合模式送达消费点**（生产装配）：ACC 两组材质的 `blend` 是 `translucent`，且 `materialPassStateOf` 给出"混合 + 不写深度" |
 *
 * ## 为什么①必须走生产装配
 *
 * 手写载荷喂"已带 blend / 已分好条目"的数据会恒绿：真实缺陷恰恰发生在**装配把同一方块的
 * 两格分成两个条目**这一环。故①的输入是 `e2e/fixtures/gg-antimatter-casing-ctm-glass.json`
 * （#87 验收轮的**真实游戏导出件**，14 207 B、sha256 `28621a6a…cf5fe7e`，与
 * `temp/pb-refresh-acceptance/` 的证据链同源）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { plainRootOf } from '@/adapters/plainRoot'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { kernelPresentationInputs } from '@/composition/kernelPresentationInputs'
import { projectGridCells } from '@/composition/kernelProjection'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import { materialPassStateOf } from '@/domain/materialPass'
import { TIME_ZERO } from '@/presentation/evaluationKey'
import { structureRowToWorldY } from '@/render/data/grid'
import { collectStructureGeometryPiecesPure, type BakedQuadGeometryPiece } from '@/render/mesh/structureGeometryCore'
import type { BakedQuad, BlockPaletteEntry, FaceName, StructureDefinition } from '@/render/schema/types'

const FIXTURE = 'gg-antimatter-casing-ctm-glass.json'
const ACC = 'GoodGenerator:antimatterContainmentCasing'

function productionParsers() {
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  return parsers
}

interface Dims {
  readonly sizeColumn: number
  readonly sizeRow: number
  readonly sizeZSlice: number
}

/** 真实信封 → 内核装配 → 投影（与 `composition/kernelPresentationInputs` 同一重建口径）。 */
async function productionAssembly() {
  const raw = JSON.parse(
    // 铁律 6：读入口归一化行尾（本仓 core.autocrlf=true ⇒ 新鲜检出是 CRLF）。
    fs.readFileSync(path.join(process.cwd(), 'e2e', 'fixtures', FIXTURE), 'utf8').replace(/\r\n/g, '\n'),
  ) as Record<string, unknown>
  const parsed = await productionParsers().detectAndParse(raw)
  expect(parsed.document, '真实信封必须能被生产解析器解析').not.toBeNull()
  const r = assembleKernelDocument({ doc: parsed.document!, plainRoot: plainRootOf(raw) })
  if (!r.ok) throw new Error(`装配失败：${r.error.code}`)
  const payload = Object.values(r.value.scene.data)
    .map((d) => d.payload)
    .find((p) => p.kind === 'blockGrid')
  if (payload === undefined || payload.kind !== 'blockGrid') throw new Error('无 blockGrid 载荷')
  const projected = projectGridCells({
    cells: payload.cells,
    sizeColumn: payload.sizeColumn,
    sizeRow: payload.sizeRow,
    sizeZSlice: payload.sizeZSlice,
    geometry: payload.geometry,
    cellGeometry: payload.cellGeometry,
    cellPalette: payload.cellPalette,
    palette: payload.palette,
    cellContent: payload.cellContent,
  })
  const definition = {
    geometryPhase: 'baked',
    cellGrid: projected.cellGrid,
    blockPalette: projected.blockPalette,
    // 几何收集逐四边形读 `materialPalette[q.materialIndex]` —— 缺它当场抛。
    materialPalette: r.value.content.resources.map((res) => ({ kind: res.kind, blend: res.blend })),
  } as unknown as StructureDefinition
  const dims: Dims = {
    // 声明尺寸优先；投射产物缺席时回落到网格实际尺寸（判据只用来定位格，不改变几何）。
    sizeColumn: payload.sizeColumn ?? projected.cellGrid[0]?.[0]?.length ?? 1,
    sizeRow: payload.sizeRow ?? projected.cellGrid[0]?.length ?? 1,
    sizeZSlice: payload.sizeZSlice ?? projected.cellGrid.length,
  }
  return { scene: r.value.scene, content: r.value.content, definition, dims }
}

/** 四边形的**外向世界面**（按位置算，不读 quad 本身；与生产 `outwardWorldFaceFromBakedQuadPure` 同口径）。 */
function outwardFaceOfPiece(piece: BakedQuadGeometryPiece, dims: Dims): FaceName {
  const p = piece.positions
  const e1 = [p[3]! - p[0]!, p[4]! - p[1]!, p[5]! - p[2]!]
  const e2 = [p[6]! - p[0]!, p[7]! - p[1]!, p[8]! - p[2]!]
  let n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]
  const cx = (p[0]! + p[3]! + p[6]!) / 3
  const cy = (p[1]! + p[4]! + p[7]!) / 3
  const cz = (p[2]! + p[5]! + p[8]!) / 3
  const ccx = piece.col - dims.sizeColumn / 2 + 0.5
  const ccy = structureRowToWorldY(piece.row, dims.sizeRow) - dims.sizeRow / 2 + 0.5
  const ccz = piece.zSlice - dims.sizeZSlice / 2 + 0.5
  if (n[0]! * (cx - ccx) + n[1]! * (cy - ccy) + n[2]! * (cz - ccz) < 0) n = [-n[0]!, -n[1]!, -n[2]!]
  const ax = Math.abs(n[0]!)
  const ay = Math.abs(n[1]!)
  const az = Math.abs(n[2]!)
  if (ax >= ay && ax >= az) return n[0]! > 0 ? '+x' : '-x'
  if (ay >= az) return n[1]! > 0 ? '+y' : '-y'
  return n[2]! > 0 ? '+z' : '-z'
}

function facesByCell(pieces: readonly BakedQuadGeometryPiece[], dims: Dims): Map<string, FaceName[]> {
  const out = new Map<string, FaceName[]>()
  for (const piece of pieces) {
    const key = `${piece.zSlice}/${piece.row}/${piece.col}`
    const list = out.get(key) ?? []
    list.push(outwardFaceOfPiece(piece, dims))
    out.set(key, list)
  }
  return out
}

/** 找到成对相邻（沿 +x）的两格 ACC。 */
function accPairOf(definition: StructureDefinition): { left: [number, number, number]; right: [number, number, number] } {
  const grid = definition.cellGrid
  for (let z = 0; z < grid.length; z++) {
    for (let row = 0; row < grid[z]!.length; row++) {
      for (let col = 0; col + 1 < grid[z]![row]!.length; col++) {
        const left = grid[z]![row]![col]!
        const right = grid[z]![row]![col + 1]!
        if (definition.blockPalette[left]?.registryId !== ACC) continue
        if (definition.blockPalette[right]?.registryId !== ACC) continue
        return { left: [z, row, col], right: [z, row, col + 1] }
      }
    }
  }
  throw new Error('夹具里没有成对相邻的 ACC —— 判据无法建立（不是断言失败）')
}

describe('#87 · 成对 ACC 的共享面必须按方块状态剔除（生产装配）', () => {
  it('① 共享面零四边形；两侧其余面完整；孤立 ACC 六面完整', async () => {
    const { definition, dims } = await productionAssembly()
    const pair = accPairOf(definition)
    const pieces = collectStructureGeometryPiecesPure(definition).pieces
    const byCell = facesByCell(pieces, dims)
    const keyOfCell = (c: [number, number, number]) => `${c[0]}/${c[1]}/${c[2]}`
    const leftFaces = byCell.get(keyOfCell(pair.left)) ?? []
    const rightFaces = byCell.get(keyOfCell(pair.right)) ?? []

    // 前提（反恒绿）：两块在**调色板槽位**上确实不同 —— 旧判据（槽位相等）在结构上不可能剔除它们。
    const leftIdx = definition.cellGrid[pair.left[0]]![pair.left[1]]![pair.left[2]]!
    const rightIdx = definition.cellGrid[pair.right[0]]![pair.right[1]]![pair.right[2]]!
    expect(leftIdx, '前提：成对的两格必须是**不同**调色板条目（否则本条与槽位判据不可区分）').not.toBe(rightIdx)
    expect(
      definition.blockPalette[leftIdx]!.registryId + '|' + definition.blockPalette[rightIdx]!.registryId,
      '前提：两格是同一方块身份',
    ).toBe(`${ACC}|${ACC}`)

    expect(leftFaces, '左格的 +x 面朝向共享面 ⇒ 不得渲染').not.toContain('+x')
    expect(rightFaces, '右格的 -x 面朝向共享面 ⇒ 不得渲染').not.toContain('-x')
    // 其余面必须还在（否则"剔除"退化成"整块不画"）
    expect(new Set(leftFaces), '左格其余五面必须完整').toEqual(new Set(['-x', '+y', '-y', '+z', '-z']))
    expect(new Set(rightFaces), '右格其余五面必须完整').toEqual(new Set(['+x', '+y', '-y', '+z', '-z']))

    // 孤立 ACC（同一方块、无 ACC 邻居）六面必须全在 —— 防"按身份剔除"过宽
    const accCellKeys = new Set<string>()
    for (let z = 0; z < definition.cellGrid.length; z++)
      for (let row = 0; row < definition.cellGrid[z]!.length; row++)
        for (let col = 0; col < definition.cellGrid[z]![row]!.length; col++) {
          const idx = definition.cellGrid[z]![row]![col]!
          if (definition.blockPalette[idx]?.registryId === ACC) accCellKeys.add(`${z}/${row}/${col}`)
        }
    expect(accCellKeys.size, '夹具有 3 格 ACC（成对 2 + 孤立 1）').toBe(3)
    const isolated = [...accCellKeys].filter((k) => k !== keyOfCell(pair.left) && k !== keyOfCell(pair.right))
    expect(isolated.length, '恰好一格孤立 ACC').toBe(1)
    expect(new Set(byCell.get(isolated[0]!) ?? []), '孤立 ACC 六面必须完整').toEqual(
      new Set(['+x', '-x', '+y', '-y', '+z', '-z']),
    )
  })

  it('② 负对照：关掉剔除 ⇒ 共享面确实在导出件里（2 层 × 2 侧 = 4 片）', async () => {
    const { definition, dims } = await productionAssembly()
    const pair = accPairOf(definition)
    const all = collectStructureGeometryPiecesPure(definition, { cullOccludedQuads: false }).pieces
    const culled = collectStructureGeometryPiecesPure(definition).pieces
    const byCell = facesByCell(all, dims)
    const keyOfCell = (c: [number, number, number]) => `${c[0]}/${c[1]}/${c[2]}`
    const leftShared = (byCell.get(keyOfCell(pair.left)) ?? []).filter((f) => f === '+x')
    const rightShared = (byCell.get(keyOfCell(pair.right)) ?? []).filter((f) => f === '-x')
    expect(leftShared.length, '导出件里左格朝共享面的四边形（每面两层 ⇒ 2 片）').toBe(2)
    expect(rightShared.length, '导出件里右格朝共享面的四边形（每面两层 ⇒ 2 片）').toBe(2)
    // 剔除总量 = 成对共享面 4 片 + magneticFlux↔gravityStabilization 的**不透明**邻面 2 片
    // （后者由 shouldCullQuadFacingOpaqueNeighbor 那条规则负责，与本判据无关）。
    expect(all.length - culled.length, '剔除总量（4 同状态共享面 + 2 不透明邻面）').toBe(6)
  })

  it('④ 混合模式送达消费点：ACC 材质 blend=translucent，且该状态**不写深度**', async () => {
    const { scene, content } = await productionAssembly()
    const { inputs } = kernelPresentationInputs({
      layerWorldY: null,
      scene,
      content,
      key: { documentVersion: 1, scene: scene.id, time: TIME_ZERO, parameterVersion: 0, contentResourceVersions: {} },
    })
    const accMaterials = inputs.primitives.filter(
      (p) => content.resources[Number(p.material.id.slice('material:'.length))]?.ref.url.includes('antimatterglass'),
    )
    expect(accMaterials.length, 'ACC 的两张 CTM 贴图各是一个材质图元').toBe(2)
    for (const p of accMaterials) {
      expect(p.material.blend, `${p.material.id} 的混合模式必须来自调色板`).toBe('translucent')
      expect(materialPassStateOf(p.material.blend), '混合 pass 不写深度（MC pass 1 语义）').toEqual({
        transparent: true,
        alphaTest: 0,
        depthWrite: false,
      })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ③ 语义边界（纯；用最小定义钉住"哪种差异才允许剔除"）
// ─────────────────────────────────────────────────────────────────────────────

/** 单位立方体的六个整面（顶点序取自真实导出件的孤立 ACC 条目，UV 无关）。 */
const CUBE_FACES: readonly (readonly number[])[] = [
  [0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 1],
  [1, 1, 1, 1, 1, 0, 0, 1, 0, 0, 1, 1],
  [0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0],
  [0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1, 1],
  [0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1],
]

function cubeQuads(materialIndex: number): BakedQuad[] {
  return CUBE_FACES.map((v) => ({
    materialIndex,
    vertices: [0, 1, 2, 3].map((i) => ({
      x: v[i * 3]!,
      y: v[i * 3 + 1]!,
      z: v[i * 3 + 2]!,
      u: 0,
      v: 0,
      color: -1,
    })),
  }))
}

function entry(over: Partial<BlockPaletteEntry> & { registryId: string; meta: number }): BlockPaletteEntry {
  return {
    renderMode: 'BakedModel',
    geometry: { encoding: 'bakedQuadsJsonV1', quads: cubeQuads(0) },
    occludesAdjacentFaces: false,
    ...over,
  } as BlockPaletteEntry
}

/** 两个相邻格（沿 +x）的定义。 */
function pairDefinition(a: BlockPaletteEntry, b: BlockPaletteEntry): StructureDefinition {
  return {
    geometryPhase: 'baked',
    cellGrid: [[[0, 1]]],
    blockPalette: [a, b],
    materialPalette: [{ kind: 'static16', blend: 'translucent' }],
  } as unknown as StructureDefinition
}

function pieceCountOf(a: BlockPaletteEntry, b: BlockPaletteEntry): number {
  return collectStructureGeometryPiecesPure(pairDefinition(a, b)).pieces.length
}

describe('#87 · 剔除判据的语义边界（纯）', () => {
  it('同 registryId + 同 meta、**槽位不同** ⇒ 剔除共享面（12 → 10）', () => {
    const a = entry({ registryId: 'test:glass', meta: 0 })
    const b = entry({ registryId: 'test:glass', meta: 0 })
    expect(a).not.toBe(b)
    expect(pieceCountOf(a, b), '同状态的两格：两个朝向共享面的面被剔除（12 → 10）').toBe(10)
  })

  it('**负对照**：meta 不同 ⇒ 不剔除（禁止跨 meta 合面）', () => {
    expect(pieceCountOf(entry({ registryId: 'test:glass', meta: 0 }), entry({ registryId: 'test:glass', meta: 1 }))).toBe(12)
  })

  it('**负对照**：facing 不同 ⇒ 不剔除', () => {
    expect(
      pieceCountOf(
        entry({ registryId: 'test:glass', meta: 0, facing: '+x' }),
        entry({ registryId: 'test:glass', meta: 0, facing: '-x' }),
      ),
    ).toBe(12)
  })

  it('**负对照**：nbt 不同 ⇒ 不剔除（位置特异 NBT 的真实产物不得被合并）', () => {
    expect(
      pieceCountOf(
        entry({ registryId: 'test:glass', meta: 0, nbt: { x: 1 } }),
        entry({ registryId: 'test:glass', meta: 0, nbt: { x: 2 } }),
      ),
    ).toBe(12)
  })

  it('**负对照**：registryId 不同 ⇒ 不剔除', () => {
    expect(pieceCountOf(entry({ registryId: 'test:a', meta: 0 }), entry({ registryId: 'test:b', meta: 0 }))).toBe(12)
  })

  it('**负对照**：邻格不透明（occludesAdjacentFaces）⇒ 不由同状态规则剔除', () => {
    expect(
      pieceCountOf(
        entry({ registryId: 'test:glass', meta: 0 }),
        entry({ registryId: 'test:glass', meta: 0, occludesAdjacentFaces: true }),
      ),
    ).toBe(12)
  })

  it('单独一格 ⇒ 六面全在（6 片）', () => {
    const def = {
      geometryPhase: 'baked',
      cellGrid: [[[0]]],
      blockPalette: [entry({ registryId: 'test:glass', meta: 0 })],
      materialPalette: [{ kind: 'static16', blend: 'translucent' }],
    } as unknown as StructureDefinition
    expect(collectStructureGeometryPiecesPure(def).pieces.length).toBe(6)
  })
})
