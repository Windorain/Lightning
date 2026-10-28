/**
 * **D3 · 网格读面（R5）与声明尺寸（D-1）的判据**。
 *
 * ## 本文件必须证明的三件事（各自对应一条会静默违反的约束）
 *
 * | # | 判据 | 违反的后果（**静默**） |
 * |---|---|---|
 * | ① | **声明尺寸优先**：`sizeColumn/sizeRow/sizeZSlice` 在场时用它，**不**用 `cells` 包围盒 | 尾层/尾列全空 ⇒ `height` 偏小 ⇒ `gridHeight()` 进 `structureRowToWorldY` ⇒ **拾取与悬停的 Y 坐标整体偏移** |
 * | ② | **空网格 ≠ 1×1×1**：降级推导的 `max` 初值必须让空网格得 `0×0×0` | `0 宽的网格` 与 `没有网格` 不可区分（与 `cellContent` 判据 3 同口径） |
 * | ③ | **两种来源同形状**：内核 `blockGrid` 与旧 `Grid` 经本读面给出的 `name`/`meta`/`parts`/`paletteIndex`/几何逐格相同 | 迁移即行为变更（15 处消费点看到不同的网格） |
 *
 * ## D-1 的**注入式负对照**（本文件的核心）
 *
 * ① 的判据必须能证明"没有声明尺寸就会出错"，否则它只是"恰好绿"。
 * 故 ① 组里有**同一份 `cells`、只差声明字段**的两侧对照：去掉声明 ⇒ 尺寸变小
 * （这就是 D-1 要防的那个偏移）。判据若恒真，这一组会同时绿 —— 那正是负对照的作用。
 */
import { describe, expect, it } from 'vitest'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID, KernelSession } from '@/runtime/kernelSession'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import {
  gridViewOfLegacy,
  gridViewOfPayload,
  kernelGridOf,
  resolveGridSize,
  type LegacyGridLike,
} from '@/runtime/gridRead'
import { Grid } from '@/context/grid'
import { cellContent, cellContentKey } from '@/domain/cellContent'
import { blockPaletteEntryKey } from '@/domain/blockGeometry'
import { createDocument, withScene } from '@/domain/document'
import { objectData, sceneObject } from '@/domain/scene'
import { cellPositionKey } from '@/domain/cellPosition'
import { structureRowToWorldY } from '@/pure/vec'
import type { Document } from '@/domain/document'
import type { Scene } from '@/domain/scene'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具构造（显式、最小；**不**用 mock 框架 —— 本仓既有口径）
// ─────────────────────────────────────────────────────────────────────────────

/** 一格方块：有损编码身份（`cells` 的**文件格式**取值形如 `minecraft:<name>:<meta>`）。 */
function gf7(name: string, meta = 0): string {
  return `minecraft:${name}:${meta}`
}

/**
 * 造一份只含**一个 `blockGrid` 对象**的内核文档。
 *
 * `frameIndex` 取 0 即可（单帧）。
 */
function docWithObjects(
  entries: readonly { readonly id: string; readonly type: string; readonly payload: unknown }[],
  docId = 'd1',
): Document {
  const base = createDocument(docId, { sceneId: `${docId}-scene` })
  const objects: Record<string, ReturnType<typeof sceneObject>> = {}
  const data: Record<string, ReturnType<typeof objectData>> = {}
  const order: string[] = []
  for (const e of entries) {
    const dataId = `${e.id}:data`
    objects[e.id] = sceneObject({ id: e.id, type: e.type as never, name: e.id, dataId })
    data[dataId] = objectData(dataId, e.payload as never, 'document')
    order.push(e.id)
  }
  const scene: Scene = Object.freeze({
    ...base.scene,
    order: Object.freeze(order),
    objects: Object.freeze(objects),
    data: Object.freeze(data),
  })
  return withScene(base, scene).doc
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 声明尺寸优先（D-1）—— 含注入式负对照
// ─────────────────────────────────────────────────────────────────────────────

describe('D3/R5 ① 尺寸：声明优先，包围盒只是缺省降级（D-1(甲)）', () => {
  /**
   * **尾层全空**的形态：`cells` 只到 `y = 1`，而文件声明 `sizeRow = 8`。
   *
   * 这正是 D-1 要防的形态：真实多方块/结构文件里顶层常有一整层空气，
   * 而 `cells` 是**稀疏**键表（空格不写键）⇒ 包围盒推得的 `height` 比声明的小。
   */
  const tailEmptyCells = {
    '0,0,0': gf7('stone', 0),
    '1,0,0': gf7('stone', 0),
    '0,1,0': gf7('dirt', 0),
  }

  it('声明在场 ⇒ `height` = 声明值（8），**不**是包围盒的 2', () => {
    const size = resolveGridSize({ cells: tailEmptyCells, sizeColumn: 4, sizeRow: 8, sizeZSlice: 3 })
    expect(size, '声明尺寸必须压过包围盒推导').toEqual({ width: 4, height: 8, depth: 3 })
  })

  it('**注入式负对照**：同一份 cells **去掉声明** ⇒ 尺寸退化为包围盒（2×2×1）', () => {
    const size = resolveGridSize({ cells: tailEmptyCells })
    expect(
      size,
      '去掉声明后必须得到偏小的尺寸 —— 这正是 D-1 要防的"拾取 Y 整体偏移"的成因；' +
        '若这里仍得到 8，说明判据没测到声明字段（判据空转）',
    ).toEqual({ width: 2, height: 2, depth: 1 })
  })

  it('两者的 `cells` **逐字相同**（证明差别只来自声明字段，不是夹具不同）', () => {
    const a = resolveGridSize({ cells: tailEmptyCells, sizeColumn: 4, sizeRow: 8, sizeZSlice: 3 })
    const b = resolveGridSize({ cells: tailEmptyCells })
    expect(a.height).not.toBe(b.height)
    expect(Object.keys(tailEmptyCells)).toHaveLength(3)
  })

  it('声明非法（负数/非整数/缺一项）⇒ 如实降级为包围盒，**不**猜', () => {
    for (const bad of [
      { sizeColumn: -1, sizeRow: 8, sizeZSlice: 3 },
      { sizeColumn: 4, sizeRow: 1.5, sizeZSlice: 3 },
      { sizeColumn: 4, sizeRow: 8 },
      { sizeColumn: 4, sizeRow: 8, sizeZSlice: Number.NaN },
    ]) {
      const size = resolveGridSize({ cells: tailEmptyCells, ...bad } as never)
      expect(size, `非法声明 ${JSON.stringify(bad)} 必须降级`).toEqual({ width: 2, height: 2, depth: 1 })
    }
  })

  it('② **空网格 ⇒ `0×0×0`**（不是 `1×1×1`；"0 宽的网格"与"没有网格"必须可区分）', () => {
    expect(resolveGridSize({ cells: {} })).toEqual({ width: 0, height: 0, depth: 0 })
    // 声明为 0 也是合法声明（显式"零尺寸网格"），与"未声明"同形但都不得变成 1。
    expect(resolveGridSize({ cells: {}, sizeColumn: 0, sizeRow: 0, sizeZSlice: 0 })).toEqual({
      width: 0,
      height: 0,
      depth: 0,
    })
  })

  it('`height` 进 `structureRowToWorldY` 的**可观测后果**（为什么这不是风格问题）', async () => {
    const { structureRowToWorldY } = await import('@/pure/vec')
    const declared = resolveGridSize({ cells: tailEmptyCells, sizeColumn: 4, sizeRow: 8, sizeZSlice: 3 })
    const derived = resolveGridSize({ cells: tailEmptyCells })
    // 同一个"行号 1"，两种高度给出**不同**的世界 Y ⇒ 拾取会指向别的格。
    expect(structureRowToWorldY(1, declared.height)).not.toBe(structureRowToWorldY(1, derived.height))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ③ 逐格同义：内核载荷 vs 旧 Grid（**同一份内容**）
// ─────────────────────────────────────────────────────────────────────────────

/** 一份内容（三种：有部件 / 无部件 / 空名）—— 两侧用**同一份**数据喂。 */
const SAME = {
  cells: {
    '0,0,0': gf7('stone', 0),
    '1,0,0': gf7('dirt', 3),
    '0,1,0': gf7('air', 0),
  },
  size: { sizeColumn: 2, sizeRow: 2, sizeZSlice: 1 },
  paletteIndex: { '0,0,0': 0, '1,0,0': 1, '0,1,0': 2 },
}

/**
 * 旧 `Grid`（**生产类**）：用 `setBlock` 建同一份内容。
 *
 * ⚠️ 用真 `Grid`（不是结构替身）：`paletteIndex`/`getPaletteCache` 的**键形**
 * （`'#' + idx`）是 legacy 分支的适配对象，替身会把那段适配测空。
 */
function legacyGridOfSame(): Grid {
  const g = new Grid(2, 2, 1)
  g.setBlock({ x: 0, y: 0, z: 0 }, { name: 'stone', meta: 0, paletteIndex: 0 })
  g.setBlock({ x: 1, y: 0, z: 0 }, { name: 'dirt', meta: 3, paletteIndex: 1 })
  g.setBlock({ x: 0, y: 1, z: 0 }, { name: 'air', meta: 0, paletteIndex: 2 })
  const cache = g.getPaletteCache()
  // ⚠️ `encoding` **必须**在（`decodeBakedGeometry` 按它分派；缺失 ⇒ 抛"未知编码"
  // ⇒ 读面的 `catch` 给 `null`）。第一版夹具漏了它 ⇒ 判据把"夹具不合法"
  // 误读成"读面不同义" —— 记此以免后人重踩。
  cache.set('#0', { registryId: 'minecraft:stone', meta: 0, geometry: { encoding: 'bakedQuadsJsonV1', quads: [] } } as never)
  cache.set('#1', { registryId: 'minecraft:dirt', meta: 3, geometry: { encoding: 'bakedQuadsJsonV1', quads: [{ i: 1 }] } } as never)
  cache.set('#2', { registryId: 'minecraft:air', meta: 0 } as never)
  return g
}

describe('D3/R5 ③ 两种来源同形状（内核 `blockGrid` vs 旧 `Grid`）', () => {
  it('尺寸逐字相同', () => {
    const k = gridViewOfPayload({ cells: SAME.cells, ...SAME.size })
    const l = gridViewOfLegacy(legacyGridOfSame() as unknown as LegacyGridLike)
    expect({ w: k.width, h: k.height, d: k.depth }).toEqual({ w: l.width, h: l.height, d: l.depth })
    expect({ w: k.width, h: k.height, d: k.depth }).toEqual({ w: 2, h: 2, d: 1 })
  })

  it('逐格 `name`/`meta`/`paletteIndex` 相同（这是 15 处消费点真正读的三件事）', () => {
    const k = gridViewOfPayload({ cells: SAME.cells, ...SAME.size })
    const l = gridViewOfLegacy(legacyGridOfSame() as unknown as LegacyGridLike)
    for (const pos of [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
    ]) {
      const kc = k.at(pos)
      const lc = l.at(pos)
      expect(kc, `内核侧 ${cellPositionKey(pos)} 必须有格`).not.toBeNull()
      expect(lc, `legacy 侧 ${cellPositionKey(pos)} 必须有格`).not.toBeNull()
      expect(
        { name: kc!.name, meta: kc!.meta },
        `${cellPositionKey(pos)} 的方块身份必须同义`,
      ).toEqual({ name: lc!.name, meta: lc!.meta })
    }
  })

  it('`count`/`blocks`/`forEach` 的格集合相同（顺序不做断言 —— 两侧都按写入序）', () => {
    const k = gridViewOfPayload({ cells: SAME.cells, ...SAME.size })
    const l = gridViewOfLegacy(legacyGridOfSame() as unknown as LegacyGridLike)
    const keyOf = (c: { pos: { x: number; y: number; z: number } }): string => cellPositionKey(c.pos)
    expect(k.count()).toBe(l.count())
    expect([...k.blocks()].map(keyOf).sort()).toEqual([...l.blocks()].map(keyOf).sort())
    const seen: string[] = []
    k.forEach((c) => seen.push(keyOf(c)))
    expect(seen.sort()).toEqual([...l.blocks()].map(keyOf).sort())
  })

  it('`partsAt` 同义：内核 `cellContent.parts` 与旧 `Grid.setParts` 给出同一列表', () => {
    const part = {
      localId: 'ae2:p0',
      typeKey: 'k',
      boxes: [{ min: [0, 0, 0], max: [0.5, 0.5, 0.5], kind: 'visual' }],
      displayName: 'P',
      tooltip: ['t'],
      items: [],
      source: { family: 'ae2', fallback: false, boxProvenance: 'visual-only', tier: 1 },
    } as never
    const k = gridViewOfPayload({
      cells: SAME.cells,
      ...SAME.size,
      cellContent: { [cellContentKey(0, 0, 0)]: cellContent({ parts: [part] }) },
    })
    const l = gridViewOfLegacy(
      (() => {
        const g = legacyGridOfSame()
        g.setParts({ x: 0, y: 0, z: 0 }, [part as never])
        return g
      })() as unknown as LegacyGridLike,
    )
    expect(k.partsAt({ x: 0, y: 0, z: 0 })).toEqual(l.partsAt({ x: 0, y: 0, z: 0 }))
    // 反空洞真：无部件格两侧都必须是 `null`（不是 `[]` —— 本工程"缺席 ≠ 空"口径）。
    expect(k.partsAt({ x: 1, y: 0, z: 0 })).toBeNull()
    expect(l.partsAt({ x: 1, y: 0, z: 0 })).toBeNull()
  })

  /** 一份与 `legacyGridOfSame` 的 `PaletteCache` **逐条目对应**的类型化调色板。 */
  const typedPaletteOf = () => [
    { registryId: 'minecraft:stone', meta: 0, assetId: '', renderMode: 'BakedModel', occludesAdjacentFaces: false, geometry: { quads: [] } },
    { registryId: 'minecraft:dirt', meta: 3, assetId: '', renderMode: 'BakedModel', occludesAdjacentFaces: false, geometry: { quads: [1] } },
  ]

  it('`paletteEntryOf` 同义：两侧都给出**条目身份**（registryId）与几何', () => {
    const typed = typedPaletteOf()
    const k = gridViewOfPayload({
      cells: SAME.cells,
      ...SAME.size,
      // ⚠️ `cellPalette` 的取值是 `blockPaletteEntryKey` 的产物（**9 段**、`\u0000` 分隔），
      // 不是手写的 "name|meta" —— 用生产函数生成，判据才测的是**同一条编码**。
      cellPalette: {
        '0,0,0': blockPaletteEntryKey(typed[0] as never),
        '1,0,0': blockPaletteEntryKey(typed[1] as never),
      },
      palette: typed,
      // ⚠️ 几何在**两种来源**上承载方式不同（这正是本读面存在的理由）：
      //  内核 = `cellGeometry`（逐格 assetId）+ `geometry`（资产目录，多格共享一份）
      //  legacy = 每个调色板条目自带 `geometry`（见 `legacyGridOfSame` 的 cache）
      // ⇒ 两侧各按自己的形态给出同一份几何，判据比较的是**读面归一后的结果**。
      cellGeometry: { '1,0,0': 'geo:dirt' },
      geometry: { 'geo:dirt': { encoding: 'bakedQuadsJsonV1', quads: [{ i: 1 }] } } as never,
    })
    const l = gridViewOfLegacy(legacyGridOfSame() as unknown as LegacyGridLike)
    for (const pos of [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
    ]) {
      // **反空洞真**：两侧都必须**命中**（第一版只比 `?.registryId` ⇒
      // 两边同为 `undefined` 时也"相等"，判据空转 —— 记此以免后人重踩）。
      expect(k.paletteEntryOf(pos), `内核侧 ${cellPositionKey(pos)} 必须命中条目`).not.toBeNull()
      expect(l.paletteEntryOf(pos), `legacy 侧 ${cellPositionKey(pos)} 必须命中条目`).not.toBeNull()
      expect(k.paletteEntryOf(pos)?.registryId).toBe(l.paletteEntryOf(pos)?.registryId)
    }
    expect(k.geometryOf({ x: 1, y: 0, z: 0 }), '内核侧必须解出四边形').not.toBeNull()
    expect(k.geometryOf({ x: 1, y: 0, z: 0 })).toEqual(l.geometryOf({ x: 1, y: 0, z: 0 }))
  })

  it('**负对照**：`cellPalette` 的内容键换成 `registryId` ⇒ 命不中（证明上一条不是恒真）', () => {
    const typed = typedPaletteOf()
    const k = gridViewOfPayload({
      cells: SAME.cells,
      ...SAME.size,
      cellPalette: { '0,0,0': 'minecraft:stone', '1,0,0': 'minecraft:dirt' },
      palette: typed,
    })
    expect(
      k.paletteEntryOf({ x: 0, y: 0, z: 0 }),
      '用 registryId 冒充内容键必须命不中 —— 否则 D9 那类"同 registryId 不同 meta"的错配会静默通过',
    ).toBeNull()
  })

  it('`paletteIndex` 是**文件槽位**（承载值），不是 `palette` 数组位置', () => {
    const typed = typedPaletteOf()
    // 造一个"文件槽位与数组位置**故意错开**"的形态：槽位 7 的条目在数组第 0 位。
    const k = gridViewOfPayload({
      cells: SAME.cells,
      ...SAME.size,
      cellPalette: { '0,0,0': blockPaletteEntryKey(typed[0] as never) },
      cellPaletteIndex: { '0,0,0': 7 },
      palette: [typed[0], typed[1]],
    })
    expect(
      k.at({ x: 0, y: 0, z: 0 })?.paletteIndex,
      '槽位必须原样透出（复算会得到 0，而 legacy 给的是 7 ⇒ 行为变更）',
    ).toBe(7)
    // 而**条目**仍按内容键精确命中（两件事、两个入口）。
    expect(k.paletteEntryOf({ x: 0, y: 0, z: 0 })?.registryId).toBe('minecraft:stone')
  })

  it('`centerWorld` **逐字同式**（网格居中于原点，方块中心 +0.5）', () => {
    const k = gridViewOfPayload({ cells: SAME.cells, ...SAME.size })
    const l = gridViewOfLegacy(legacyGridOfSame() as unknown as LegacyGridLike)
    for (const pos of [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 0 },
    ]) {
      expect(k.centerWorld(pos)).toEqual(l.centerWorld(pos))
    }
  })

  it('⚠️ `tooltipAt` 在 legacy 分支**如实返回 `undefined`**（侧表不在网格上）', () => {
    const l = gridViewOfLegacy(legacyGridOfSame() as unknown as LegacyGridLike)
    expect(
      l.tooltipAt({ x: 0, y: 0, z: 0 }),
      'legacy 的逐格说明在文档根的 tooltipPalette/cellTooltipGrid 旁表里，网格读面**无从**回答；' +
        '返回一个空串会是"假装知道"（D8 的形态）',
    ).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ② `kernelGridOf`：按出现序取帧（不依赖 `frame-<i>` 命名约定）
// ─────────────────────────────────────────────────────────────────────────────

describe('D3/R5 ② `kernelGridOf` 取帧规则（按 `scene.order` 出现序）', () => {
  function docWithTwoGrids(): Document {
    return docWithObjects(
      [
        { id: 'zzz-first-object', type: 'block', payload: { kind: 'blockGrid', cells: { '0,0,0': gf7('stone', 0) } } },
        { id: 'aaa-second-object', type: 'block', payload: { kind: 'blockGrid', cells: { '0,0,0': gf7('dirt', 0) } } },
      ],
      'd2',
    )
  }

  it('第 0 帧 = `scene.order` 的第一个（**不是** id 字典序的第一个）', () => {
    const doc = docWithTwoGrids()
    expect(kernelGridOf(doc, 0)?.at({ x: 0, y: 0, z: 0 })?.name).toBe('stone')
    expect(kernelGridOf(doc, 1)?.at({ x: 0, y: 0, z: 0 })?.name).toBe('dirt')
  })

  it('越界/负数/非整数 ⇒ `null`（如实降级，**不**伪造空网格）', () => {
    const doc = docWithTwoGrids()
    for (const i of [2, -1, 1.5, Number.NaN]) {
      expect(kernelGridOf(doc, i), `frameIndex=${i}`).toBeNull()
    }
  })

  it('`undefined` 文档 ⇒ `null`', () => {
    expect(kernelGridOf(undefined, 0)).toBeNull()
  })

  it('**反空洞真**：夹具确实有两个 block 对象（否则上面第 0/1 帧的区分是空转）', () => {
    const doc = docWithTwoGrids()
    expect(doc.scene.order).toHaveLength(2)
    expect(Object.values(doc.scene.objects).filter((o) => o.type === 'block')).toHaveLength(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ④ 装配成功分流（读面在 `Context` 上的分派 —— 纯函数层的可见部分）
// ─────────────────────────────────────────────────────────────────────────────

describe('D3/R5 ④ 内核分支**不**在"该帧无网格"时回落 legacy（与 D8 同口径）', () => {
  it('内核装配成功但第 0 帧无 `blockGrid` ⇒ `null`（"确实没有"是权威答案，不是"回落"）', () => {
    // 这份文档是 `annotation` 载荷（不是 blockGrid）⇒ 出现序里没有 block 对象。
    const doc = docWithObjects([{ id: 'anno:0', type: 'annotation', payload: { kind: 'annotation', shape: 'box' } }], 'd3')
    expect(kernelGridOf(doc, 0), '没有 blockGrid 载荷 ⇒ null（不是一份空网格）').toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ **接线判定**：生产装配**必须真的填** `sizeColumn/sizeRow/sizeZSlice`
//    （打回修复段 —— L3 擒获的回归正是这一处漏接线）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ## 本组是"测试没测到生产路径"的**补判据**（真实事故，务必备留）
 *
 * D3 首次交付时：① 组（纯函数 `resolveGridSize`）**全绿** —— 因为我喂的载荷
 * **已经带了**声明字段。而**生产装配从未填过它**：
 * `kernelAssembly#gridPayload` 声明了这三个字段却从不赋值
 * ⇒ `resolveGridSize` 在**每一条真实路径**上都走"包围盒降级"
 * ⇒ D-1 修的东西**没有生效**。
 *
 * 后果由 **L3** 独立擒获（`multiblock-frame-regression.spec.ts`：
 * 3 帧文档的 frame1/frame2 的 `h`/`d`/`w` 与文件声明不符 ⇒ 双 project 确定性红）。
 * L0/L1/L2 全绿 —— 因为**没有任何判据穿过生产装配看一眼载荷长什么样**。
 *
 * ⇒ 本组的两条纪律（与 D2 报告里 `gridInputOf` 漏传 `cellPalette` 那次同族）：
 *  1. **接线必须有判据**：断言装配产物里**确实有**这三个字段（不是断言读面会用它）；
 *  2. **判据的输入必须来自生产**：走 `V2PlainParser` → `adoptLoadedDocument`，
 *     而不是手工拼一个"已经带字段"的载荷。
 *
 * 本组用的夹具是**稀疏尾层**形态（尾切片/尾列/顶行全空）——
 * 正是"声明 vs 包围盒"会分叉的那种网格；并**显式断言两者确实不同**
 *（否则本组是空转：声明 == 包围盒时它无法区分修好与没修）。
 */
describe('D3/R5 ⑤ **接线判定**：装配真的填了声明尺寸（走生产解析 + 装配）', () => {
  /**
   * 稀疏尾层网格：**声明** 6 宽 × 5 高 × 4 深，而只有 `(z=1, 世界 y=3, x=1)` 一格有方块。
   *
   * 文件 `cellGrid` 的 row 0 = 顶部 ⇒ 世界 `y = h - 1 - row`。
   * 只放 `row = 1` ⇒ 世界 `y = 3`；包围盒推导会得 `w=2, h=4, d=2`
   *（`maxX=1, maxY=3, maxZ=1`），**远小于**声明值。
   */
  const SPARSE = {
    d: 4,
    h: 5,
    w: 6,
    cell: { z: 1, row: 1, x: 1 },
  }
  /**
   * 文件行号 → 世界 y（**用生产函数**换算）。
   *
   * ⚠️ 我第一版在这里手写 `h - row`，把"行号算成了 y" ⇒ 夹具落在**另一格**
   *（世界 y=4 而不是 3）⇒ 负对照的期望高度随之错一位，被本组自己的断言抓出。
   * 这正是"翻转只有一处定义"（`structureRowToWorldY`）的实用价值：手写必错一次。
   */
  const WORLD_Y = structureRowToWorldY(SPARSE.cell.row, SPARSE.h)

  function sparsePlain(): Record<string, unknown> {
    const empty = (): number[][] => Array.from({ length: SPARSE.h }, () => new Array<number>(SPARSE.w).fill(0))
    const grid: number[][][] = Array.from({ length: SPARSE.d }, empty)
    grid[SPARSE.cell.z]![SPARSE.cell.row]![SPARSE.cell.x] = 1
    return {
      format_version: '2.0',
      id: 'sparse-tail',
      meta: { name: 'sparse', author: '', description: '', tags: [], origin: { x: 0, y: 0, z: 0 } },
      frames: [{ index: 0, label: null, durationMs: 100, structure: { geometryPhase: 'baked', cellGrid: grid, blockPalette: [{ registryId: 'air', meta: 0 }, { registryId: 'minecraft:stone', meta: 0 }] } }],
      annotations: [],
      labels: [],
    }
  }

  /** 走**生产**解析 + **生产**装配（装配成功），返回会话。 */
  async function adoptedSession(): Promise<{ session: KernelSession; dispose: () => void }> {
    const registry = createParserRegistry()
    registry.register(V2PlainParser)
    registry.register(createEnvelopeParser(registry))
    registry.register(WorldParser)
    registry.register(StructureDataParser)
    // `detectAndParse` 是**生产**入口（`parse` 只是单解析器的内部协议）。
    const parsed = await registry.detectAndParse(sparsePlain())
    expect(parsed.document, '夹具必须可被生产解析器解析').not.toBeNull()
    const session = new KernelSession({
      documentId: KERNEL_DOCUMENT_ID,
      contextId: KERNEL_CONTEXT_ID,
      capabilities: [],
    })
    const ok = adoptLoadedDocument(
      { kernel: session, log: { info: () => {}, warn: () => {} } },
      parsed.document!,
      sparsePlain(),
      'sparse-tail',
    )
    expect(ok, '前置：装配必须成功（GF-16 = true）').toBe(true)
    return { session, dispose: () => session.dispose() }
  }

  /** 装配产物里那个 `blockGrid` 载荷的**原始字段**（不经读面 —— 本组要看的正是载荷）。 */
  function rawPayloadOf(session: KernelSession): Record<string, unknown> {
    const doc = session.document()!
    for (const id of doc.scene.order) {
      const obj = doc.scene.objects[id]
      if (obj === undefined || obj.type !== 'block') continue
      const p = doc.scene.data[obj.dataId]?.payload as Record<string, unknown> | undefined
      if (p?.kind === 'blockGrid') return p
    }
    throw new Error('装配产物里没有 blockGrid 载荷')
  }

  it('① **载荷确实带** `sizeColumn/sizeRow/sizeZSlice`（接线判据本体）', async () => {
    const { session, dispose } = await adoptedSession()
    try {
      const p = rawPayloadOf(session)
      expect(p.sizeColumn, '装配必须写出宽（声明尺寸）').toBe(SPARSE.w)
      expect(p.sizeRow, '装配必须写出高（声明尺寸）').toBe(SPARSE.h)
      expect(p.sizeZSlice, '装配必须写出深（声明尺寸）').toBe(SPARSE.d)
    } finally {
      dispose()
    }
  })

  it('② 读面据此给出**声明尺寸**（而不是包围盒降级值）', async () => {
    const { session, dispose } = await adoptedSession()
    try {
      const g = kernelGridOf(session.document(), 0)!
      expect({ w: g.width, h: g.height, d: g.depth }).toEqual({ w: SPARSE.w, h: SPARSE.h, d: SPARSE.d })
    } finally {
      dispose()
    }
  })

  it('③ **反空洞真**：本夹具的包围盒值**确实小于**声明值（否则本组无法区分修好与没修）', async () => {
    const { session, dispose } = await adoptedSession()
    try {
      const p = rawPayloadOf(session)
      const cells = p.cells as Record<string, string>
      const keys = Object.keys(cells)
      expect(keys, '夹具必须只有一格方块').toHaveLength(1)
      const [x, y, z] = keys[0]!.split(',').map(Number)
      const bounds = { w: x! + 1, h: y! + 1, d: z! + 1 }
      expect(
        bounds,
        '包围盒必须**小于**声明（w=2/h=4/d=2 vs 6/5/4）—— 否则"声明优先"这条判据在本夹具上是空转',
      ).toEqual({ w: SPARSE.cell.x + 1, h: WORLD_Y + 1, d: SPARSE.cell.z + 1 })
      expect(bounds.w).toBeLessThan(SPARSE.w)
      expect(bounds.d).toBeLessThan(SPARSE.d)
    } finally {
      dispose()
    }
  })

  it('④ **负对照**：把载荷的三个字段**去掉**（回放到修复前的形态）⇒ 读面给出包围盒值', () => {
    const doc = createDocument('neg', { sceneId: 'neg' })
    const obj = sceneObject({ id: 'b', type: 'block', name: 'b', dataId: 'b:data' })
    // ⚠️ 刻意**不**写 sizeColumn/sizeRow/sizeZSlice —— 这就是修复前装配产出的形状。
    const data = objectData('b:data', {
      kind: 'blockGrid',
      cells: { [`${SPARSE.cell.x},${WORLD_Y},${SPARSE.cell.z}`]: gf7('stone', 0) },
    } as never, 'document')
    const scene: Scene = { ...doc.scene, order: ['b'], objects: { b: obj }, data: { 'b:data': data } }
    const g = kernelGridOf(withScene(doc, scene).doc, 0)!
    expect(
      { w: g.width, h: g.height, d: g.depth },
      '无声明字段 ⇒ 降级为包围盒（这正是 L3 判红时的读数口径）',
    ).toEqual({ w: SPARSE.cell.x + 1, h: WORLD_Y + 1, d: SPARSE.cell.z + 1 })
    expect(g.width, '负对照必须与正路径**不同**，否则本组无区分力').not.toBe(SPARSE.w)
  })

  it('⑤ 声明尺寸进 `structureRowToWorldY`：与**旧 Grid**（= 文件声明）逐点同值', async () => {
    const { session, dispose } = await adoptedSession()
    try {
      const sdoc = session.document()
      const kernel = kernelGridOf(sdoc, 0)!
      // 旧 Grid 的维度就是文件声明（`_fromV2CellGrid` 用 `cellGrid` 三维构造）
      // ⇒ 本判据比较的是"读面 == 文件声明"这条**唯一**口径。
      const legacyH = SPARSE.h
      expect(kernel.height).toBe(legacyH)
      // 世界中心：网格居中于原点 ⇒ 与 legacy `Grid.centerWorld` 同式；
      // 用 height 的差异验证"若 height 偏小，中心就偏移"。
      const center = kernel.centerWorld({ x: 0, y: 0, z: 0 })
      const boundsH = WORLD_Y + 1
      expect(center.y, '声明高度下的 y 中心').toBe(0 - SPARSE.h / 2 + 0.5)
      expect(center.y, '包围盒高度会给出**不同**的中心（可观测偏移）').not.toBe(0 - boundsH / 2 + 0.5)
    } finally {
      dispose()
    }
  })
})
