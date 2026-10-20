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
 * | ④ | **alpha 类别与 pass 状态送达消费点**（生产装配 + **真实 PNG 解码**）：ACC 两组材质的 `blend` 是 `translucent`、其 `TextureBinding` 带 `alphaClass='binary'`，且 `materialPassStateOf` 给出 **cutout 等价状态**（alphaTest 0.5 + 写深度）；负对照：同装配去掉类别 ⇒ 回到"混合 + 不写深度" |
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
import pako from 'pako'
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
import { textureBindingsOf, textureResourcesOf, type TextureDecoder } from '@/composition/kernelTextureResources'
import { compileScene } from '@/presentation/compileScene'
import { BatchedPresenter } from '@/presentation/presenter'
import type { TextureBinding, TexturePixels } from '@/presentation/textureBinding'
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

// ─────────────────────────────────────────────────────────────────────────────
// 真实 PNG 解码（**生产解码器端口的测试侧实现**；不是合成像素）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **真实 PNG → RGBA8**。
 *
 * ## 为什么测试里要自带一个解码器（以及为什么它不算"手搓载荷"）
 *
 * 生产解码器是 `adapters/textureDecode#createDomTextureDecoder`（`createImageBitmap` + canvas），
 * 在 vitest（Node）里没有 DOM。`TextureDecoder` 是**端口**，这正是它被设计成端口的原因
 * （见 `composition/kernelTextureResources` 的说明）。已有生产判据
 * （`composition/__tests__/textureUnificationProduction.test.ts`）注入的是**按载荷长度编造的**
 * 像素 —— 那对"状态机/接线"够用，但**对 alpha 分类没有说服力**：分类看的正是真实 alpha 分布。
 *
 * ⇒ 本文件注入一个**真的把夹具字节解成 RGBA** 的解码器（支持导出件实际用到的
 * colorType 2/3/4/6 与 bitDepth 4/8、非隔行）。于是：
 *  - 被断言的不是"手工喂给分类函数的 binary"，而是**真实 PNG 的 alpha 通道**；
 *  - 分类发生在**生产代码**里（`kernelTextureResources#decodeOne`），测试只提供像素来源。
 */
function decodePngRgba(payload: string): TexturePixels | null {
  const bytes = Buffer.from(payload.replace(/^data:image\/png;base64,/, ''), 'base64')
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (bytes.length < 8) return null
  for (let i = 0; i < signature.length; i += 1) if (bytes[i] !== signature[i]) return null

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let palette: Buffer | null = null
  let transparency: Buffer | null = null
  const idat: Buffer[] = []
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8).toString('latin1')
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]!
      colorType = data[9]!
      interlace = data[12]!
    } else if (type === 'PLTE') {
      palette = Buffer.from(data)
    } else if (type === 'tRNS') {
      transparency = Buffer.from(data)
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }

  if (interlace !== 0) throw new Error('夹具 PNG 为隔行扫描 —— 本解码器只支持 interlace=0（宁可判红也不静默错解）')
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0
  const isPalette = colorType === 3
  if (isPalette) {
    if (palette === null) throw new Error('调色板 PNG 缺 PLTE')
    if (bitDepth !== 4 && bitDepth !== 8) throw new Error('调色板 PNG 的 bitDepth 只支持 4/8，实得 ' + bitDepth)
  } else if (channels === 0 || bitDepth !== 8) {
    throw new Error('不支持的 PNG 形态：colorType=' + colorType + ' bitDepth=' + bitDepth)
  }

  const raw = pako.inflate(new Uint8Array(Buffer.concat(idat)))
  const bitsPerPixel = isPalette ? bitDepth : channels * 8
  const stride = Math.ceil((width * bitsPerPixel) / 8)
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8))
  const rgba = new Uint8Array(width * height * 4)
  const prev = new Uint8Array(stride)
  let p = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[p]!
    p += 1
    const line = raw.subarray(p, p + stride)
    p += stride
    const cur = new Uint8Array(stride)
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? cur[x - bpp]! : 0
      const b = prev[x]!
      const c = x >= bpp ? prev[x - bpp]! : 0
      const value = line[x]!
      if (filter === 0) cur[x] = value
      else if (filter === 1) cur[x] = (value + a) & 0xff
      else if (filter === 2) cur[x] = (value + b) & 0xff
      else if (filter === 3) cur[x] = (value + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        cur[x] = (value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      } else throw new Error('未知 PNG 行过滤器: ' + filter)
    }
    for (let x = 0; x < width; x += 1) {
      const di = (y * width + x) * 4
      if (isPalette) {
        const bitIndex = x * bitDepth
        const byte = cur[bitIndex >> 3]!
        const shift = 8 - bitDepth - (bitIndex & 7)
        const index = (byte >> shift) & ((1 << bitDepth) - 1)
        rgba[di] = palette![index * 3] ?? 0
        rgba[di + 1] = palette![index * 3 + 1] ?? 0
        rgba[di + 2] = palette![index * 3 + 2] ?? 0
        rgba[di + 3] = transparency !== null && index < transparency.length ? transparency[index]! : 255
      } else {
        const si = x * channels
        rgba[di] = cur[si]!
        rgba[di + 1] = channels === 1 ? cur[si]! : cur[si + 1]!
        rgba[di + 2] = channels === 1 ? cur[si]! : channels === 2 ? cur[si]! : cur[si + 2]!
        rgba[di + 3] = channels >= 2 ? cur[si + channels - 1]! : 255
      }
    }
    prev.set(cur)
  }
  return { width, height, rgba }
}

function realPngDecoder(): TextureDecoder {
  return {
    async decode(payload: string): Promise<TexturePixels | null> {
      return payload === '' ? null : decodePngRgba(payload)
    },
  }
}

/** alpha 直方图（值 → 像素数；用来把"二值"钉在**真实像素**上，而不是只信分类结论）。 */
function alphaHistogram(pixels: TexturePixels): Map<number, number> {
  const hist = new Map<number, number>()
  for (let i = 3; i < pixels.rgba.length; i += 4) {
    const a = pixels.rgba[i]!
    hist.set(a, (hist.get(a) ?? 0) + 1)
  }
  return hist
}

interface MaterialLike {
  readonly transparent: boolean
  readonly alphaTest: number
  readonly depthWrite: boolean
}

/** 挂载树上的全部材质（**去重**：同一材质可被多个批次共享）。 */
function mountedMaterials(root: { traverse(cb: (o: object) => void): void }): MaterialLike[] {
  const seen = new Set<MaterialLike>()
  root.traverse((o) => {
    const holder = o as { material?: MaterialLike | MaterialLike[] }
    const mat = holder.material
    if (mat === undefined) return
    if (Array.isArray(mat)) for (const m of mat) seen.add(m)
    else seen.add(mat)
  })
  return [...seen]
}

/** 去掉 `alphaClass` 的绑定形状（**负对照**用：等价于"贴图还没解码"的绑定）。 */
function withoutAlphaClass(binding: TextureBinding): TextureBinding {
  const copy = { ...binding } as Record<string, unknown>
  delete copy.alphaClass
  return copy as unknown as TextureBinding
}

/** cutout 等价状态（**字面量**，不从被测模块取：否则把被测值当期望值 = 恒绿）。 */
const CUTOUT_EQUIVALENT = Object.freeze({ transparent: true, alphaTest: 0.5, depthWrite: true })
/** 真半透明的画家路径（修复前形态）。 */
const BLEND_PATH = Object.freeze({ transparent: true, alphaTest: 0, depthWrite: false })

/** ACC 的两张贴图（CTM 变体）在 `materialPalette` 里对应两个材质槽。 */
function accMaterialIdsOf(
  inputs: { readonly primitives: readonly { readonly material: { readonly id: string; readonly blend: string } }[] },
  content: { readonly resources: readonly { readonly ref: { readonly url: string } }[] },
): Set<string> {
  const out = new Set<string>()
  for (const p of inputs.primitives) {
    const index = Number(p.material.id.slice('material:'.length))
    const url = content.resources[index]?.ref.url ?? ''
    if (url.includes('antimatterglass')) out.add(p.material.id)
  }
  return out
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

  /**
   * ④ **alpha 类别与 pass 状态送达消费点**（生产装配 + **真实 PNG 解码**）。
   *
   * ## 这条判据抓什么（用户验收的缺陷形态）
   *
   * ACC 声明 `blend=translucent`，但它的 CTM 贴图是**二值 alpha**（实测直方图 {0,255}）
   * ⇒ 游戏侧 Angelica 把材质降级成 CUTOUT_MIPPED（alphaTest + 写深度）
   * （`AngelicaChunkBuildContext.java:105-106`）。web 若照着声明画"混合 + 不写深度"，
   * 两块玻璃之间**没有深度裁决** ⇒ 远处玻璃盖住近处玻璃的白边（#87 的像素级证据）。
   *
   * ## 为什么必须走生产装配 + 真实像素
   *
   * 手工把 `'binary'` 喂给 `materialPassStateOf` 会恒绿：真正的风险在生产链**根本不填**
   * 这个类别（`decodeOne` 没分类 / 绑定没复制 / 消费点没读）。故本条的输入链是
   * `真实信封 → 生产 parser → kernelPresentationInputs → textureResourcesOf（真实 PNG 解码 +
   * decodeOne 内分类）→ textureBindingsOf → BatchedPresenter（真实 createMaterial）`。
   *
   * ## 判据分组
   *
   * | # | 断言 | 抓什么 |
   * |---|---|---|
   * | ④-a | ACC 两张贴图 `ready` 且 alpha 直方图**只有 0 与 255** | 前提：类别不是猜的 |
   * | ④-b | `TextureResource#alphaClass === 'binary'` | 分类**在生产解码链里**真的发生 |
   * | ④-c | `TextureBinding#alphaClass === 'binary'`（ACC 每个材质） | 绑定真的复制了类别 |
   * | ④-d | `materialPassStateOf(blend, binding.alphaClass)` = cutout 等价（含与 `'cutout'` 逐字段相等） | 政策真的按类别分叉 |
   * | ④-e | **挂载材质**（`createMaterial` 的产物）逐一是 cutout 等价状态，数量 = ACC 材质数 | 消费点真的读了类别（不是只到绑定层） |
   * | ④-f | **负对照**：同装配但绑定去掉类别（= 解码前形态）⇒ 挂载材质回到"混合 + 不写深度" | ④-e 有区分力（不是恒真） |
   */
  it('④ ACC 的 alpha 类别是 binary，且 pass 状态 = cutout 等价（真实 PNG 解码 → 生产装配 → 挂载材质）', async () => {
    const { scene, content } = await productionAssembly()
    const { inputs } = kernelPresentationInputs({
      layerWorldY: null,
      scene,
      content,
      key: { documentVersion: 1, scene: scene.id, time: TIME_ZERO, parameterVersion: 0, contentResourceVersions: {} },
    })
    const accIds = accMaterialIdsOf(inputs, content)
    expect(accIds.size, 'ACC 的两张 CTM 贴图各是一个材质').toBe(2)
    for (const p of inputs.primitives) {
      if (!accIds.has(p.material.id)) continue
      expect(p.material.blend, p.material.id + ' 的混合模式必须来自调色板').toBe('translucent')
    }

    // ── ④-a/b：真实 PNG 解码 → 生产 `decodeOne` 内的分类 ──
    const resources = await textureResourcesOf(content.resources, realPngDecoder())
    const accIndexes = content.resources
      .map((r, index) => ({ url: r.ref.url, index }))
      .filter(({ url }) => url.includes('antimatterglass'))
      .map(({ index }) => index)
    expect(accIndexes.length, '生产资源表里必须恰好两条 ACC 贴图').toBe(2)
    for (const index of accIndexes) {
      const resource = resources[index]!
      expect(resource.state, '真实 PNG 必须解码成功（否则本条无从谈起）').toBe('ready')
      expect(resource.pixels, 'ready ⇒ 必须有像素').not.toBeNull()
      const hist = alphaHistogram(resource.pixels!)
      const values = [...hist.keys()].sort((a, b) => a - b)
      expect(values, 'ACC 贴图是二值 alpha（{0,255}）——分类的前提').toEqual([0, 255])
      expect(resource.alphaClass, '生产解码链必须把这张图分类为 binary').toBe('binary')
    }

    // ── ④-c/d：绑定真的带上了类别，政策真的按类别分叉 ──
    const bindings = textureBindingsOf({ materials: inputs.primitives.map((p) => p.material), resources })
    const bindingById = new Map(bindings.map((b) => [b.materialId, b]))
    for (const id of accIds) {
      const binding = bindingById.get(id)
      expect(binding, id + ' 必须有绑定').toBeDefined()
      expect(binding!.alphaClass, id + ' 的绑定必须带 alphaClass=binary').toBe('binary')
      const state = materialPassStateOf('translucent', binding!.alphaClass)
      expect(state, '二值 translucent ⇒ cutout 等价状态（alphaTest + 写深度）').toEqual(CUTOUT_EQUIVALENT)
      // "等价"逐字成立：与 cutout 声明的状态**逐字段相等**（同一个状态值）。
      expect(state).toEqual(materialPassStateOf('cutout'))
    }

    // ── ④-e：消费点 —— 真实挂载材质（只取 ACC 图元，使"每个挂载材质都是 ACC"成立）──
    const accPrimitives = inputs.primitives.filter((p) => accIds.has(p.material.id))
    const compiled = compileScene({ ...inputs, primitives: accPrimitives })
    expect(compiled.ok, '生产输入必须可编译').toBe(true)
    if (!compiled.ok) throw new Error('narrow')
    const presenter = new BatchedPresenter({
      scope: 'test:87-acc-alpha',
      textureBindings: new Map(bindings.map((b) => [b.materialId, b])),
    })
    try {
      presenter.apply(compiled.value)
      const materials = mountedMaterials(presenter.object3d)
      expect(materials.length, '挂载材质数必须等于 ACC 材质数（否则本条没覆盖到创建路径）').toBe(accIds.size)
      for (const material of materials) {
        expect(
          { transparent: material.transparent, alphaTest: material.alphaTest, depthWrite: material.depthWrite },
          'ACC 的挂载材质必须是 cutout 等价状态（近处白框不得被远处斜角盖住）',
        ).toEqual(CUTOUT_EQUIVALENT)
      }
    } finally {
      presenter.dispose()
    }

    // ── ④-f：负对照 —— 去掉类别（= 贴图还没解码时的绑定形状）⇒ 回到画家路径 ──
    const unknownBindings = new Map(bindings.map((b) => [b.materialId, withoutAlphaClass(b)]))
    const unknownPresenter = new BatchedPresenter({
      scope: 'test:87-acc-unknown',
      textureBindings: unknownBindings,
    })
    try {
      unknownPresenter.apply(compiled.value)
      const materials = mountedMaterials(unknownPresenter.object3d)
      expect(materials.length, '负对照同样必须挂载 ACC 材质').toBe(accIds.size)
      for (const material of materials) {
        expect(
          { transparent: material.transparent, alphaTest: material.alphaTest, depthWrite: material.depthWrite },
          '未知类别 ⇒ 修复前的画家路径（证明 ④-e 不是恒真）',
        ).toEqual(BLEND_PATH)
      }
    } finally {
      unknownPresenter.dispose()
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
