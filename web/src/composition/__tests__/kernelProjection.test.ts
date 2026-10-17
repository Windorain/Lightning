/**
 * **P10b（#282）· 内核文档 → 旧格式投影（G-3 反向编码器）** 验收。
 *
 * ## 本文件证明什么
 *
 * 正向装配（`kernelAssembly`）把旧文件读进内核；本文件证明**反向**这一半 ——
 * 且证明的是**往返**（round-trip）而非"能吐出一份 JSON"：
 *
 * ```
 * 旧文件 ──装配──▶ 内核(Scene+DocumentContent) ──投影──▶ 旧格式 ──再解析──▶ 旧文档
 *                      │                                                      │
 *                      └──────────── 内容身份应相等 ─────────────────────────┘
 * ```
 *
 * ## 三条判据（各自对应一个会被静默违反的约束）
 *
 * | 判据 | 违反的后果 |
 * |---|---|---|
 * | 逐格往返：`cellGrid`/`blockPalette` 语义一致 | 坐标翻转错一处 ⇒ 结构镜像/上下颠倒（A26 负对照） |
 * | 元数据/资源/时长轴往返 | "编辑了内核但导出还是旧的"（投影变成回放缓存） |
 * | 投影**读内核**而非回放输入 | 上面那条的成因；用"改内核后产物必须变"直接证伪 |
 *
 * ## 为什么必须用真实夹具
 *
 * 合成的最小 JSON 恰好满足投影层的假设（P9 `plainCodec` 文件头记录过同一陷阱）。
 * 三份真实多方块夹具带真实的 432/108/12 帧与内嵌纹理，是本文件的判据面。
 */

import { describe, expect, it } from 'vitest'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { parseBlockCellKey, parseBlockCellValue, projectGridCells, projectKernelDocument } from '@/composition/kernelProjection'
import { createParserRegistry } from '@/context/parserRegistry'
import { readEnvelopeLayers } from '@/render/data/compactSceneDocument'
import { fixturePath, readJson } from '@/context/__tests__/multiblockFixtureIo.mjs'
import { RuntimeDocument } from '@/context/runtimeDocument'
import { unwrap } from '@/domain/errors'
import { documentContent, documentMetadata, frameAxis } from '@/domain/content'
import { withDocumentContent, createDocument } from '@/domain/document'
import type { AssembledDocument } from '@/composition/kernelAssembly'
import type { GridProjectionInput, KernelDeclarationProjection } from '@/composition/kernelProjection'
import type { BlockGeometryAsset, BlockPaletteEntry } from '@/domain/blockGeometry'
import type { CellContentTable } from '@/domain/cellContent'

const FIXTURES = ['multiblock-ebf-2ch', 'multiblock-lsc-overlap', 'multiblock-tier-only'] as const

/**
 * 装配产物 → 投影入参（**测试侧的适配**）。
 *
 * 生产接线（`docLifecycleOperators`）做同一件事；这里重复一次是刻意的：
 * 它让测试**显式**声明"投影依赖产物的哪些字段"，于是"投影偷偷读了别的字段"
 * 会在类型上立刻可见（`KernelDeclarationProjection` 是收窄的投影面）。
 */
function declarationOf(assembled: AssembledDocument): KernelDeclarationProjection | null {
  const mb = assembled.multiblock
  if (mb === null) return null
  return {
    id: mb.id,
    displayName: mb.displayName,
    declaration: mb.projection.declaration,
    declRaw: mb.declRaw,
    blockPalette: mb.projection.blockPalette,
    assets: mb.projection.assets,
    frames: mb.projection.frames,
    schemaVersion: mb.projection.schemaVersion,
    multiblockCount: mb.projection.multiblockCount,
  }
}

/**
 * `blockGrid` 载荷 → 投影入参（测试侧；与生产 `kernelProjection#gridProjectionInputOf` **同一字段集**）。
 *
 * ## ⚠️ 必须带 `cellPalette`（#301 P10f D2 的 D9 修复后暴露）
 *
 * 本助手原先漏了 `cellPalette`（载荷里**有**这个字段，生产入口也**传**它）。
 * 后果长期不可见：D9 之前无 `cellPalette` 时投影写出的是 GF-7 的有损形态
 * `minecraft:<name>`，与带 `cellPalette` 的精确结果**恰好同形** ⇒ 漏传没有差异。
 * D9 让命名空间回真值后两者分叉，且**漏传时不得采信几何身份**（实测
 * `multiblock-ebf-2ch` 的 `gt.blockcasings@11` 与 `gt.blockmachines@1000`
 * 共享同一 `assetId`）⇒ 漏传的助手会把 EBF 控制器写成机壳。
 * ⇒ 助手必须与生产入口同字段集，否则它测的不是生产路径。
 *
 * ## ⚠️ 同理必须带声明尺寸三字段（#262 P11-A）
 *
 * `gridProjectionInputOf` 自 P11-A 起透传 `sizeColumn/sizeRow/sizeZSlice`
 * （投影维度由**文件声明**决定，见 `kernelProjection#projectGridCells`）。
 * 本助手若漏传，就会在稀疏载荷上测出与生产**不同**的维度 —— 又是一次
 * "助手与生产不同字段集"（上一条已经踩过一次）。
 */
function gridInputOf(payload: {
  readonly cells: Readonly<Record<string, string>>
  readonly sizeColumn?: number
  readonly sizeRow?: number
  readonly sizeZSlice?: number
  readonly geometry?: Readonly<Record<string, BlockGeometryAsset>>
  readonly cellGeometry?: Readonly<Record<string, string>>
  readonly cellPalette?: Readonly<Record<string, string>>
  readonly palette?: readonly BlockPaletteEntry[]
  readonly cellContent?: CellContentTable
}): GridProjectionInput {
  const out: {
    cells: Readonly<Record<string, string>>
    sizeColumn?: number
    sizeRow?: number
    sizeZSlice?: number
    geometry?: Readonly<Record<string, BlockGeometryAsset>>
    cellGeometry?: Readonly<Record<string, string>>
    cellPalette?: Readonly<Record<string, string>>
    palette?: readonly BlockPaletteEntry[]
    cellContent?: CellContentTable
  } = { cells: payload.cells }
  if (payload.sizeColumn !== undefined) out.sizeColumn = payload.sizeColumn
  if (payload.sizeRow !== undefined) out.sizeRow = payload.sizeRow
  if (payload.sizeZSlice !== undefined) out.sizeZSlice = payload.sizeZSlice
  if (payload.geometry !== undefined) out.geometry = payload.geometry
  if (payload.cellGeometry !== undefined) out.cellGeometry = payload.cellGeometry
  if (payload.cellPalette !== undefined) out.cellPalette = payload.cellPalette
  if (payload.palette !== undefined) out.palette = payload.palette
  if (payload.cellContent !== undefined) out.cellContent = payload.cellContent
  return out
}

async function loadFixture(name: string) {
  const envelope = readJson(fixturePath(name)) as Record<string, unknown>
  const result = await createParserRegistry().detectAndParse(envelope)
  expect(result.document, `${name} 应能被生产解析器解析`).not.toBeNull()
  const layers = await readEnvelopeLayers(envelope as never)
  return { doc: result.document!, plainRoot: layers.plain }
}

describe('P10b/G-3 · 单元键值对偶（投影的最底层）', () => {
  it('`blockCellKey` 与 `parseBlockCellKey` 互为逆', () => {
    for (const p of [
      { x: 0, y: 0, z: 0 },
      { x: 3, y: 7, z: 11 },
    ]) {
      expect(parseBlockCellKey(`${p.x},${p.y},${p.z}`)).toEqual(p)
    }
  })

  it('`parseBlockCellKey` 对非法输入返回 null（不抛、不猜）', () => {
    for (const bad of ['', '1', '1,2', '1,2,3,4', 'a,b,c', '1.5,2,3', '1,2,']) {
      expect(parseBlockCellKey(bad), `${bad} 应判非法`).toBeNull()
    }
  })

  it('`parseBlockCellValue` 接受两种历史形态，拒绝多段', () => {
    expect(parseBlockCellValue('minecraft:stone:3')).toEqual({ name: 'stone', meta: 3 })
    expect(parseBlockCellValue('stone')).toEqual({ name: 'stone', meta: 0 })
    expect(parseBlockCellValue('stone:0')).toEqual({ name: 'stone', meta: 0 })
    // 多段 ⇒ 无法判定哪一段是 meta ⇒ 判非法（不猜）
    expect(parseBlockCellValue('a:b:c')).toBeNull()
    expect(parseBlockCellValue('minecraft:')).toBeNull()
    expect(parseBlockCellValue('')).toBeNull()
  })
})

describe('P10b/G-3 · 逐格往返（真实夹具）', () => {
  for (const name of FIXTURES) {
    it(`${name}：装配 → 投影 → 逐格语义一致`, async () => {
      const { doc, plainRoot } = await loadFixture(name)
      const assembled = unwrap(assembleKernelDocument({ doc, plainRoot }))

      // 取装配出的多方块网格对象
      const mbData = assembled.scene.data['structure:multiblock:data']
      expect(mbData, `${name} 应有多方块网格数据`).toBeDefined()
      expect(mbData!.payload.kind).toBe('blockGrid')
      if (mbData!.payload.kind !== 'blockGrid') return

      // 投影回旧 (cellGrid, blockPalette)
      const projected = projectGridCells(gridInputOf(mbData!.payload))
      expect(projected.invalidCells, `${name} 投影不应有非法单元`).toBe(0)
      expect(projected.cellGrid.length, `${name} 投影应有网格`).toBeGreaterThan(0)

      // ── 逐格比对：投影出的网格 → 装回内核 cells → 应与原 cells **逐位相同** ──
      // 这是往返判据的**强**形态：不比对中间表示，而是比对"语义等价的内核值"。
      //
      // 用**键→值映射**相等（不是键集合、也不是值集合）：只有映射相等才能同时
      // 抓住"坐标漂移"（翻转错）与"方块错位"（调色板错）。集合比较对翻转不敏感
      // —— 见负对照组的实测说明。
      const roundTripped = cellsFromLegacy(projected.cellGrid, projected.blockPalette)
      expect(roundTripped, `${name} 往返后的键→值映射必须与原装配逐位相同`).toEqual(mbData!.payload.cells)
    })
  }
})

describe('P10b/G-3 · 投影读内核而非回放输入（防"投影=缓存"）', () => {
  it('改内核元数据 ⇒ 投影产物必须跟着变', async () => {
    const { doc, plainRoot } = await loadFixture('multiblock-tier-only')
    const assembled = unwrap(assembleKernelDocument({ doc, plainRoot }))
    const before = projectKernelDocument({
      scene: assembled.scene,
      content: assembled.content,
      multiblockDeclaration: declarationOf(assembled),
    })
    // 在内核里改元数据（这才是"内核为权威"）
    const next = withDocumentContent(
      createDocument('doc-1', { sceneId: assembled.scene.id, content: assembled.content }),
      documentContent({
        metadata: documentMetadata({ name: '改过的名字', author: '新作者' }),
        frameAxis: assembled.content.frameAxis,
        resources: assembled.content.resources,
      }),
    )
    const after = projectKernelDocument({
      scene: next.doc.scene,
      content: next.doc.content,
      multiblockDeclaration: declarationOf(assembled),
    })
    expect(before.plain.label, '前提：改前产物里的展示名是原值').not.toBe('改过的名字')
    expect(after.plain.label, '改内核元数据后，投影产物必须变（否则投影只是回放缓存）').toBe('改过的名字')
    expect((after.plain.meta as Record<string, unknown>).author).toBe('新作者')
  })

  it('改内核资源 ⇒ 投影产物的 textureBlobs/materialPalette 必须跟着变', async () => {
    const { doc, plainRoot } = await loadFixture('multiblock-ebf-2ch')
    const assembled = unwrap(assembleKernelDocument({ doc, plainRoot }))
    const projected = projectKernelDocument({
      scene: assembled.scene,
      content: assembled.content,
      multiblockDeclaration: declarationOf(assembled),
    })
    // 真实夹具内嵌纹理 ⇒ 产物必须有 textureBlobs 且条数与内核资源数一致
    const blobs = projected.plain.textureBlobs as Record<string, string> | undefined
    expect(blobs, 'ebf-2ch 投影产物应带 textureBlobs').toBeDefined()
    const embedded = assembled.content.resources.filter((r) => r.payload !== null)
    expect(Object.keys(blobs!).length, '内嵌资源条数应与内核一致').toBe(embedded.length)
    const palette = projected.plain.materialPalette as unknown[]
    expect(palette.length, '材质调色板条数应与内核资源数一致').toBe(assembled.content.resources.length)
  })

  it('多方块场景清单**不读**内核帧时长轴（场景不是时间轴）', async () => {
    const { doc, plainRoot } = await loadFixture('multiblock-tier-only')
    const assembled = unwrap(assembleKernelDocument({ doc, plainRoot }))
    // M5-1：生产装配对多方块文档给出**空帧轴**（帧清单 = 变体配置集合，不是时间轴）。
    expect(assembled.content.frameAxis.frames.length, '前提：多方块文档的帧轴为空').toBe(0)
    // 即便有人把一条 777ms 的"帧"塞进内核帧轴，场景清单也不得跟着变 ——
    // 场景的 label/durationMs 是**声明**事实，不是时间轴事实。
    const bogus = frameAxis([{ index: 0, label: 'bogus-frame', durationMs: 777 }])
    const projected = projectKernelDocument({
      scene: assembled.scene,
      content: documentContent({ metadata: assembled.content.metadata, frameAxis: bogus, resources: assembled.content.resources }),
      multiblockDeclaration: declarationOf(assembled),
    })
    const outFrames = projected.plain.frames as Record<string, unknown>[]
    expect(outFrames.length, '全部声明场景仍必须产出（不因空帧轴而丢）').toBe(
      assembled.multiblock!.projection.frames.length,
    )
    expect(outFrames[0]!.durationMs, '场景时长来自声明，不来自时间轴').not.toBe(777)
    expect(outFrames[0]!.label, '场景标签来自声明，不来自时间轴').not.toBe('bogus-frame')
  })
})

describe('P10b/G-3 · 形态由内容机械决定（不由调用方声明）', () => {
  it('有 multiblockDeclaration ⇒ 产物是多方块形态；无 ⇒ 帧为主形态', async () => {
    const { doc, plainRoot } = await loadFixture('multiblock-tier-only')
    const assembled = unwrap(assembleKernelDocument({ doc, plainRoot }))

    const asMultiblock = projectKernelDocument({
      scene: assembled.scene,
      content: assembled.content,
      multiblockDeclaration: declarationOf(assembled),
    })
    expect(asMultiblock.plain.documentShape, '有内层 body ⇒ 必须是多方块形态').toBe('multiblock')
    expect(asMultiblock.plain.multiblock, '多方块声明必须随产物写出').toBeTruthy()

    const asFrames = projectKernelDocument({
      scene: assembled.scene,
      content: assembled.content,
      multiblockDeclaration: null,
    })
    expect(asFrames.plain.documentShape, '无内层 body ⇒ 不得声明多方块形态').toBeUndefined()
  })

  it('投影产物能被**生产解析器**读回（形态合法性的机械判据）', async () => {
    for (const name of FIXTURES) {
      const { doc, plainRoot } = await loadFixture(name)
      const assembled = unwrap(assembleKernelDocument({ doc, plainRoot }))
      const projected = projectKernelDocument({
        scene: assembled.scene,
        content: assembled.content,
        multiblockDeclaration: declarationOf(assembled),
      })
      const reparsed = await createParserRegistry().detectAndParse(projected.plain)
      expect(reparsed.document, `${name} 投影产物必须能被生产解析器读回`).not.toBeNull()
      // ## 帧数的正确期望（#289 P10d D1 补充更正）
      //
      // 本条原先断言 `frameCount === assembled.frameObjects.length`
      // （即"帧数 = 内核里的 blockGrid 对象数"）。那编码的是**旧的丢失语义**：
      // 多方块的网格是**装配产物**（一个"当前取值"的网格 = 1 个对象），
      // 而它的 `frames` 是**变体存储原语**（432 个声明帧）。
      // 旧断言于是要求 432 → 1，把丢失**钉成了期望**。
      //
      // 实测（文件与旧 `serialize()`）：那 432 帧**一个都不带 `structure`**，
      // 旧产物也是 432 帧。故正确期望是：
      //  - **多方块**：帧数 = 声明帧数（变体存储），与旧产物一致；
      //  - **帧为主**：帧数 = 网格对象数（每帧一份 `structure`）。
      const expected = assembled.multiblock !== null
        ? assembled.multiblock.projection.frames.length
        : assembled.frameObjects.length
      expect(reparsed.document!.frameCount, `${name} 读回后的帧数应与该形态的语义一致`).toBe(expected)
      // 反空洞真：真实夹具的帧数必须 > 1（否则"帧数正确"是常数比较）
      expect(expected, `${name} 应有真实的多帧`).toBeGreaterThan(1)
    }
  })

  it('保真字段回写：未知顶层字段与 `meta.` 前缀项各归其位', async () => {
    const { doc, plainRoot } = await loadFixture('multiblock-tier-only')
    const assembled = unwrap(assembleKernelDocument({ doc, plainRoot }))
    const projected = projectKernelDocument({
      scene: assembled.scene,
      content: assembled.content,
      multiblockDeclaration: null,
      fidelityFields: { someFutureField: { nested: true }, 'meta.customKey': 'v' },
    })
    expect(projected.plain.someFutureField, '未知顶层字段应回写到根（§12 往返保留）').toEqual({ nested: true })
    expect((projected.plain.meta as Record<string, unknown>).customKey, '`meta.` 前缀项应回写到 meta 子树').toBe('v')
  })
})

describe('P10b/G-3 · 负对照（证明判据不是恒绿）', () => {
  it('负对照：翻转写反 ⇒ 逐格往返的**键→值映射**判红（集合比较不够强）', () => {
    // ## 为什么用**键→值映射**而不是键集合（本文件实测抓出的判据缺陷）
    //
    // 首版用「坐标集合相等」判往返。它对翻转**不敏感**：`{0,0}` 与 `{0,1}` 两格
    // 占满高度 2 的网格时，翻转后的 y 集合仍是 `{0,1}` —— 集合相同，翻转错误
    // 照样通过（实测：`good` 与 `wrong` 都得到 `{0,0,0, 0,1,0}`）。
    //
    // 真正的判据是**哪个方块在哪一格**：翻转后 `stone` 与 `dirt` 互换位置，
    // 映射必然不同。这也正是"结构上下颠倒"这个缺陷的可观测形态。
    const cells = { '0,0,0': 'minecraft:stone:0', '0,1,0': 'minecraft:dirt:0' }
    const good = projectGridCells({ cells })
    const height = good.cellGrid[0]?.length ?? 0
    expect(height, '前提：网格高度必须 ≥ 2，否则翻转写反测不出来').toBeGreaterThan(1)

    expect(cellsFromLegacy(good.cellGrid, good.blockPalette), '正确翻转 ⇒ 键→值映射与输入一致').toEqual(cells)

    // 写反的翻转（不取反 y）⇒ 方块与坐标的对应关系变了 ⇒ 映射不同。
    const wrongMap = cellsFromLegacyNoFlip(good.cellGrid, good.blockPalette)
    expect(wrongMap, '翻转写反 ⇒ 键→值映射必须不同（故上面的判据有意义）').not.toEqual(cells)
    // 而它**仍然**是同一批方块（证明差别确实只在坐标，不在内容）——
    // 这条让上一条的失败原因唯一：不是"方块丢了"，而是"位置错了"。
    expect(new Set(Object.values(wrongMap)), '翻转写反不改变方块集合，只改变它们的位置').toEqual(new Set(Object.values(cells)))
  })

  it('负对照：非法单元确实被计数而不是静默吞掉', () => {
    const projected = projectGridCells({ cells: { '0,0,0': 'minecraft:stone:0', 'bad': 'minecraft:dirt:0', '1,1,1': 'a:b:c' } })
    expect(projected.invalidCells, '两个非法单元必须被计数').toBe(2)
    // 且合法的那个仍然被投影（不因坏数据整份丢弃）
    const solid = projected.cellGrid.flat(2).filter((i) => i !== 0).length
    expect(solid, '合法单元仍应被投影').toBe(1)
  })

  it('负对照：投影产物不含内核字段袋（§15 第 2 条）', async () => {
    const { doc, plainRoot } = await loadFixture('multiblock-tier-only')
    const assembled = unwrap(assembleKernelDocument({ doc, plainRoot }))
    const projected = projectKernelDocument({
      scene: assembled.scene,
      content: assembled.content,
      multiblockDeclaration: null,
    })
    expect(
      Object.prototype.hasOwnProperty.call(projected.plain, '_extra'),
      '投影产物不得出现字段袋 `_extra`',
    ).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 测试内工具（与生产投影对偶的**独立**实现，用于"不比对中间表示"的强判据）
// ─────────────────────────────────────────────────────────────────────────────

/** 由旧 (cellGrid, blockPalette) 重建内核 cells（**测试侧独立实现**，正确翻转）。 */
function cellsFromLegacy(cellGrid: number[][][], blockPalette: Record<string, unknown>[]): Record<string, string> {
  return cellsFromLegacyWith(cellGrid, blockPalette, (row, height) => height - 1 - row)
}

/** 同上，但**故意不翻转** row→y（负对照用；见负对照组的说明）。 */
function cellsFromLegacyNoFlip(cellGrid: number[][][], blockPalette: Record<string, unknown>[]): Record<string, string> {
  return cellsFromLegacyWith(cellGrid, blockPalette, (row) => row)
}

/** 共用的重建实现（翻转策略作为参数 —— 两个调用点只差这一处）。 */
function cellsFromLegacyWith(
  cellGrid: number[][][],
  blockPalette: Record<string, unknown>[],
  toY: (row: number, height: number) => number,
): Record<string, string> {
  const out: Record<string, string> = {}
  const height = cellGrid[0]?.length ?? 0
  for (let z = 0; z < cellGrid.length; z++) {
    for (let row = 0; row < height; row++) {
      const y = toY(row, height)
      const rawRow = cellGrid[z]![row]!
      for (let x = 0; x < rawRow.length; x++) {
        const idx = rawRow[x]!
        if (idx === 0) continue
        const entry = blockPalette[idx]
        if (entry === undefined) continue
        const rid = entry.registryId as string
        // ## ⚠️ 必须与**生产**的"名字来源"同规则（#301 P10f D2 的 D9 修复后暴露）
        //
        // 生产侧 `context/runtimeDocument#_fromV2CellGrid` 由 `registryId` 取名字的规则是
        // **首个冒号之后的部分**（`rid.indexOf(':')` → `slice`），于是
        // `gregtech:gt.blockcasings` 的名字是 `gt.blockcasings`（与 `blockCellValue`
        // 的 GF-7 编码 `minecraft:<name>:<meta>` 配套）。
        //
        // 本助手原先写的是 `startsWith('minecraft:') ? slice : rid` —— 那在
        // "registryId 恒被改写成 `minecraft:<name>`"（D9 修复前的有损形态）时
        // 与生产规则**恰好重合**，故长期没暴露。D9 让命名空间回真值后两条规则分叉：
        // 后者会把 `gregtech:gt.blockcasings` 整个当成名字（⇒ 双前缀
        // `minecraft:gregtech:gt.blockcasings:11`）。⇒ 助手必须跟上生产规则。
        const colon = rid.indexOf(':')
        const name = colon >= 0 ? rid.slice(colon + 1) : rid
        if (name === 'air') continue
        out[`${x},${y},${z}`] = `minecraft:${name}:${(entry.meta as number) ?? 0}`
      }
    }
  }
  return out
}

/** 未使用占位：保持内核类型可达（下游类型推导用）。 */
export type { RuntimeDocument }
