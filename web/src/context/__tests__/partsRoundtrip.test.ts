/**
 * P2.1 — 部件（非满方块）数据解析与运行时模型测试。
 *
 * 契约：`docs/contracts/format-parts-contract.md`（§2 文件表达、§3 PartRecord schema、§12 编辑语义）
 * fixture：
 *  - `e2e/fixtures/parts-ae2-multibox.v2.json`（AE2 三部件格 + 满方块）
 *  - `e2e/fixtures/parts-singlebox-mix.v2.json`（slab×2 共享 partLists + 上半 slab + 石头对照 + 栅栏越界盒）
 * 回归基线：`e2e/fixtures/minimal-v2.json` / `structuredata-exported-envelope.json`（无 parts 进出不产生 cellPartsGrid）
 */
import { describe, it, expect } from 'vitest'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import { RuntimeDocument } from '@/context/runtimeDocument'
import { PARTS_GRID_NONE } from '@/pure/partTypes'
import type { PartRecord } from '@/pure/partTypes'

import ae2Fixture from '../../../e2e/fixtures/parts-ae2-multibox.v2.json'
import singleboxFixture from '../../../e2e/fixtures/parts-singlebox-mix.v2.json'
import minimalV2 from '../../../e2e/fixtures/minimal-v2.json'
import structureDataEnvelope from '../../../e2e/fixtures/structuredata-exported-envelope.json'

/** 与 `workbenchHost.ts` / `embedHost.ts` 的注册顺序一致。 */
function productionRegistry() {
  const registry = createParserRegistry()
  registry.register(V2PlainParser)
  registry.register(createEnvelopeParser(registry))
  registry.register(WorldParser)
  registry.register(StructureDataParser)
  return registry
}

type Json = Record<string, unknown>

function structureOf(doc: RuntimeDocument): Json {
  const frames = doc.serialize().frames as Json[]
  return frames[0]!.structure as Json
}

/** 五要素 + 来源四元组齐全性断言（契约 §3） */
function expectPartRecordComplete(p: PartRecord): void {
  expect(typeof p.localId).toBe('string')
  expect(p.localId.length).toBeGreaterThan(0)
  expect(typeof p.typeKey).toBe('string')
  expect(p.typeKey.length).toBeGreaterThan(0)
  expect(typeof p.displayName).toBe('string')
  expect(Array.isArray(p.tooltip)).toBe(true)
  expect(Array.isArray(p.boxes)).toBe(true)
  expect(p.boxes.length).toBeGreaterThan(0)
  for (const b of p.boxes) {
    expect(b.min).toHaveLength(3)
    expect(b.max).toHaveLength(3)
    expect(['visual', 'collision']).toContain(b.kind)
  }
  expect(Array.isArray(p.items)).toBe(true) // items: [] 是显式"无"，不是缺
  for (const it of p.items) {
    expect(typeof it.registry).toBe('string')
    expect(typeof it.damage).toBe('number')
    expect(typeof it.count).toBe('number')
  }
  expect(typeof p.source.family).toBe('string')
  expect(typeof p.source.fallback).toBe('boolean')
  expect(typeof p.source.boxProvenance).toBe('string')
  expect(typeof p.source.tier).toBe('number')
}

// ---------------------------------------------------------------------------
// 1. 解析：fixture → 运行时模型
// ---------------------------------------------------------------------------
describe('P2.1 部件解析', () => {
  it('AE2 多部件格：一部件格三部件齐全，满方块格无部件', () => {
    const doc = RuntimeDocument.fromV2Plain(ae2Fixture as unknown as Json)!
    expect(doc).not.toBeNull()
    const grid = doc.frames[0]!.grid!
    expect(grid.width).toBe(2)
    expect(grid.height).toBe(1)
    expect(grid.depth).toBe(1)

    // 多部件格（x=0）：中心线缆 + NORTH 切换总线 + UP 存储总线
    const parts = doc.partsAt(0, { x: 0, y: 0, z: 0 })
    expect(parts).not.toBeNull()
    expect(parts).toHaveLength(3)
    expect(parts!.map(p => p.localId)).toEqual(['ae2:UNKNOWN', 'ae2:NORTH', 'ae2:UP'])
    for (const p of parts!) expectPartRecordComplete(p)
    // typeKey 含 damage（计数键粒度）
    expect(parts![2]!.typeKey).toBe('appliedenergistics2:item.ItemMultiPart:220')
    // 视觉/碰撞双盒（契约 §6.4）
    const kinds = new Set(parts![2]!.boxes.map(b => b.kind))
    expect(kinds).toEqual(new Set(['visual', 'collision']))
    // 来源四元组：族权威 tier 1
    expect(parts![0]!.source).toEqual({ family: 'ae2', fallback: false, boxProvenance: 'both', tier: 1 })

    // 满方块格（x=1 石头）：必须无部件（契约 §2）
    expect(doc.partsAt(0, { x: 1, y: 0, z: 0 })).toBeNull()
    // 越界查询容错
    expect(doc.partsAt(0, { x: 9, y: 9, z: 9 })).toBeNull()
    expect(doc.partsAt(7, { x: 0, y: 0, z: 0 })).toBeNull()
  })

  it('单盒混存：共享 partLists、上下半 slab 同 typeKey、栅栏越界盒如实保留', () => {
    const doc = RuntimeDocument.fromV2Plain(singleboxFixture as unknown as Json)!
    const grid = doc.frames[0]!.grid!
    expect(grid.width).toBe(5)

    const lowerA = doc.partsAt(0, { x: 0, y: 0, z: 0 })!
    const lowerB = doc.partsAt(0, { x: 1, y: 0, z: 0 })!
    const upper = doc.partsAt(0, { x: 2, y: 0, z: 0 })!
    const stone = doc.partsAt(0, { x: 3, y: 0, z: 0 })
    const fence = doc.partsAt(0, { x: 4, y: 0, z: 0 })!

    // 两个下半 slab 内容一致（共享 partLists 下标的解析侧表现）
    expect(lowerA).toEqual(lowerB)
    // 上/下半 slab 同 drop 身份计数键（契约 §5 generic 行）
    expect(lowerA[0]!.typeKey).toBe('minecraft:stone_slab:0')
    expect(upper[0]!.typeKey).toBe('minecraft:stone_slab:0')
    // 但盒不同（下半 0–0.5 / 上半 0.5–1）⇒ 不共享
    expect(lowerA[0]!.boxes[0]!.min[1]).toBe(0)
    expect(upper[0]!.boxes[0]!.min[1]).toBe(0.5)
    // 满方块对照：石头无部件
    expect(stone).toBeNull()
    // 栅栏：越界盒如实记录不裁剪（契约 §6.3：碰撞盒 maxY = 1.5）
    const fenceCollision = fence[0]!.boxes.find(b => b.kind === 'collision')!
    expect(fenceCollision.max[1]).toBe(1.5)
    // 通用盒档来源标记
    expect(fence[0]!.source).toEqual({ family: 'generic', fallback: true, boxProvenance: 'both', tier: 2 })
    for (const list of [lowerA, upper, fence]) for (const p of list) expectPartRecordComplete(p)
  })

  it('statsTemplate 文档根字段经 _extra 兜底 round-trip（契约 §9）', () => {
    const doc = RuntimeDocument.fromV2Plain(ae2Fixture as unknown as Json)!
    const out = doc.serialize()
    expect(out.statsTemplate).toEqual((ae2Fixture as unknown as Json).statsTemplate)
  })
})

// ---------------------------------------------------------------------------
// 2. 序列化：_gridToV2 写出 cellPartsGrid/partLists（含去重）+ round-trip 无损
// ---------------------------------------------------------------------------
describe('P2.1 部件序列化与 round-trip', () => {
  it.each([
    ['parts-ae2-multibox', ae2Fixture],
    ['parts-singlebox-mix', singleboxFixture],
  ])('%s：解析→序列化→再解析，部件逐字段一致', (_name, fixture) => {
    const raw = fixture as unknown as Json
    const doc = RuntimeDocument.fromV2Plain(raw)!
    const st = structureOf(doc)

    // 序列化写出与 fixture 原结构逐字段一致（含 partLists 下标去重共享）
    const rawSt = (raw.frames as Json[])[0]!.structure as Json
    expect(st.cellPartsGrid).toEqual(rawSt.cellPartsGrid)
    expect(st.partLists).toEqual(rawSt.partLists)

    // 再解析：网格与部件逐字段一致
    const again = RuntimeDocument.fromV2Plain(doc.serialize() as Json)!
    const rawGrid = rawSt.cellGrid as number[][][]
    const depth = rawGrid.length
    const height = rawGrid[0]!.length
    const width = rawGrid[0]![0]!.length
    for (let z = 0; z < depth; z++) {
      for (let row = 0; row < height; row++) {
        const y = height - 1 - row
        for (let x = 0; x < width; x++) {
          const pIdx = (rawSt.cellPartsGrid as number[][][])[z]![row]![x]!
          const got = again.partsAt(0, { x, y, z })
          if (pIdx === PARTS_GRID_NONE) {
            expect(got).toBeNull()
          } else {
            expect(got).toEqual((rawSt.partLists as PartRecord[][])[pIdx]!)
          }
        }
      }
    }
    // 二次序列化结构稳定（幂等）
    expect(structureOf(again).cellPartsGrid).toEqual(st.cellPartsGrid)
    expect(structureOf(again).partLists).toEqual(st.partLists)
  })

  it('clone 深拷贝部件：改原件不影响克隆', () => {
    const doc = RuntimeDocument.fromV2Plain(ae2Fixture as unknown as Json)!
    const cloned = doc.clone()
    expect(cloned.partsAt(0, { x: 0, y: 0, z: 0 })).toEqual(doc.partsAt(0, { x: 0, y: 0, z: 0 }))
    // 删除原件宿主 ⇒ 克隆不受影响
    doc.frames[0]!.grid!.removeBlock({ x: 0, y: 0, z: 0 })
    expect(doc.partsAt(0, { x: 0, y: 0, z: 0 })).toBeNull()
    expect(cloned.partsAt(0, { x: 0, y: 0, z: 0 })).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3. 编辑语义（契约 §12：不重算；删宿主⇒部件删；移动⇒部件随宿主）
// ---------------------------------------------------------------------------
describe('P2.1 部件编辑语义', () => {
  it('删除宿主方块 ⇒ 其部件随之删除；全部删光 ⇒ 序列化不再产出 cellPartsGrid', () => {
    const doc = RuntimeDocument.fromV2Plain(ae2Fixture as unknown as Json)!
    const grid = doc.frames[0]!.grid!
    expect(grid.removeBlock({ x: 0, y: 0, z: 0 })).toBe(true)
    expect(doc.partsAt(0, { x: 0, y: 0, z: 0 })).toBeNull()

    // 单盒 fixture：逐格删除，直至无部件 ⇒ 序列化输出无 cellPartsGrid/partLists
    const doc2 = RuntimeDocument.fromV2Plain(singleboxFixture as unknown as Json)!
    const grid2 = doc2.frames[0]!.grid!
    for (const x of [0, 1, 2, 4]) grid2.removeBlock({ x, y: 0, z: 0 })
    const st = structureOf(doc2)
    expect('cellPartsGrid' in st).toBe(false)
    expect('partLists' in st).toBe(false)
    const out = doc2.serialize()
    expect('cellPartsGrid' in out).toBe(false)
  })

  it('二次解析后编辑：根级展开副本不残留过期部件快照', () => {
    // serialize() 会把首帧 structure 展开到文档根；再解析时根级 cellPartsGrid/partLists
    // 属派生数据（不进 _extra），编辑后重序列化必须反映最新网格状态。
    const doc = RuntimeDocument.fromV2Plain(ae2Fixture as unknown as Json)!
    const again = RuntimeDocument.fromV2Plain(doc.serialize() as Json)!
    expect(again.partsAt(0, { x: 0, y: 0, z: 0 })).toHaveLength(3)
    again.frames[0]!.grid!.removeBlock({ x: 0, y: 0, z: 0 })
    const out = again.serialize()
    expect('cellPartsGrid' in out).toBe(false)
    expect('partLists' in out).toBe(false)
    expect(JSON.stringify(out)).not.toContain('cellPartsGrid')
  })

  it('移动方块 ⇒ 部件随宿主移动（盒过期如实呈现，不重算）', () => {
    const doc = RuntimeDocument.fromV2Plain(singleboxFixture as unknown as Json)!
    const grid = doc.frames[0]!.grid!
    const before = doc.partsAt(0, { x: 4, y: 0, z: 0 })
    // 栅栏 (4,0,0) → (4,1,0)
    expect(grid.moveBlock({ x: 4, y: 0, z: 0 }, { x: 4, y: 1, z: 0 })).toBe(true)
    expect(doc.partsAt(0, { x: 4, y: 0, z: 0 })).toBeNull()
    const after = doc.partsAt(0, { x: 4, y: 1, z: 0 })
    expect(after).toEqual(before) // 盒快照原样随迁（含越界 maxY=1.5），不重算

    // 序列化后部件落在 cellGrid 顶部 row（y=1 ⇒ row 0）
    const st = structureOf(doc)
    const partsGrid = st.cellPartsGrid as number[][][]
    expect(partsGrid[0]).toHaveLength(2) // 高度扩到 2
    expect(partsGrid[0]![0]).toEqual([PARTS_GRID_NONE, PARTS_GRID_NONE, PARTS_GRID_NONE, PARTS_GRID_NONE, 2])
    expect(partsGrid[0]![1]).toEqual([0, 0, 1, PARTS_GRID_NONE, PARTS_GRID_NONE])
  })

  it('覆盖宿主（setBlock）⇒ 旧部件失效；新建/手绘方块无部件数据', () => {
    const doc = RuntimeDocument.fromV2Plain(ae2Fixture as unknown as Json)!
    const grid = doc.frames[0]!.grid!
    expect(grid.setBlock({ x: 0, y: 0, z: 0 }, { name: 'dirt', meta: 0 })).toBe(true)
    expect(doc.partsAt(0, { x: 0, y: 0, z: 0 })).toBeNull()
    // 手绘方块序列化不带部件占位字段（parts:[] 占位已落地为格级模型）
    const st = structureOf(doc)
    const palette = st.blockPalette as Json[]
    const dirt = palette.find(e => e.registryId === 'minecraft:dirt')!
    expect('parts' in dirt).toBe(false)
    expect('cellPartsGrid' in st).toBe(false) // 已无部件 ⇒ 不产出
  })
})

// ---------------------------------------------------------------------------
// 4. 向后兼容（硬约束：无部件字段的旧文件解析行为不变，序列化不产出 cellPartsGrid）
// ---------------------------------------------------------------------------
describe('P2.1 旧文件行为不变', () => {
  it('StructureData（裸 baked）解析链透传 cellPartsGrid/partLists；World 帧 structure 整体透传', async () => {
    const rawSt = ((ae2Fixture as unknown as Json).frames as Json[])[0]!.structure as Json
    // 裸 StructureData baked 文档（部件字段挂在结构根上）
    const bare = {
      geometryPhase: 'baked',
      id: 'bare-parts',
      cellGrid: rawSt.cellGrid,
      blockPalette: rawSt.blockPalette,
      cellPartsGrid: rawSt.cellPartsGrid,
      partLists: rawSt.partLists,
    }
    const bareResult = await productionRegistry().detectAndParse(bare)
    expect(bareResult.parser?.formatName).toBe('StructureData')
    expect(bareResult.document!.partsAt(0, { x: 0, y: 0, z: 0 })).toHaveLength(3)
    // World 多帧（frame.structure 字段批发透传，无需改动）
    const world = { id: 'w', frames: [{ index: 0, structure: rawSt }] }
    const worldResult = await productionRegistry().detectAndParse(world)
    expect(worldResult.parser?.formatName).toBe('World')
    expect(worldResult.document!.partsAt(0, { x: 0, y: 0, z: 0 })).toHaveLength(3)
    // 旧行为：无部件键 ⇒ StructureData 解析结果不含部件
    const bareOld = { geometryPhase: 'baked', id: 'bare-old', cellGrid: rawSt.cellGrid, blockPalette: rawSt.blockPalette }
    const oldResult = await productionRegistry().detectAndParse(bareOld)
    expect(oldResult.document!.frames[0]!.grid!.hasAnyParts()).toBe(false)
  })

  it('minimal-v2.json（V2Plain）：无 parts 进出不产生 cellPartsGrid', async () => {
    const result = await productionRegistry().detectAndParse(minimalV2)
    expect(result.parser?.formatName).toBe('V2Plain')
    const doc = result.document!
    const grid = doc.frames[0]!.grid!
    expect(grid).not.toBeNull()
    grid.forEach(pos => {
      expect(doc.partsAt(0, pos)).toBeNull()
    })
    const out = doc.serialize()
    const text = JSON.stringify(out)
    expect(text).not.toContain('cellPartsGrid')
    expect(text).not.toContain('partLists')
  })

  it('structuredata-exported-envelope.json（Envelope）：无 parts 进出不产生 cellPartsGrid', async () => {
    const result = await productionRegistry().detectAndParse(structureDataEnvelope)
    expect(result.error, result.error).toBeUndefined()
    expect(result.parser?.formatName).toBe('Envelope')
    const doc = result.document!
    expect(doc.frames[0]!.grid!.hasAnyParts()).toBe(false)
    const text = JSON.stringify(doc.serialize())
    expect(text).not.toContain('cellPartsGrid')
    expect(text).not.toContain('partLists')
  })
})
