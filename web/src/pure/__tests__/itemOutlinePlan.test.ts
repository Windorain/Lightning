/**
 * B-5（#38）— 物品点选高亮的**命中计划**断言（`pure/itemOutlinePlan.ts`）。
 *
 * 覆盖 #38「完成定义」的四条硬约束：
 *  1. 高亮 = 所有选中物品归属的**并集**（跨选中项同一命中去重）；
 *  2. **部件级优先、整格兜底**（part 命中带 partLocalId；host 命中不带）；
 *  3. **无对应**（无条目 / attribution 为空）⇒ 不高亮且计入 `unresolvedCount`；
 *  4. **≤ 500 口径 + 截断**（截断而非静默失效；`offFrameCount` 与"无对应"分开计）。
 *
 * 另含 #38 要求的**证伪**：篡改归属数据 ⇒ 计划必须变化（定向断言，见最后一段）。
 */
import { describe, expect, it } from 'vitest'
import { buildItemHitIndexFromIndex, type ItemIndex } from '@/pure/itemIndex'
import {
  EMPTY_ITEM_OUTLINE_PLAN,
  OUTLINE_MASK_LIMIT,
  itemHitBlockRefs,
  planItemOutlineHits,
} from '@/pure/itemOutlinePlan'
import type { StructureDefinition } from '@/render/schema/types'

/** 2 格宽 × 1 高 × 1 深：格(0,0,0)=palette1（有几何）、格(1,0,0)=palette2（有几何） */
function twoCellDef(): StructureDefinition {
  const paletteEntry = (registryId: string) => ({
    registryId, meta: 0, renderMode: 'BakedQuads' as const,
    geometry: { encoding: 'bakedQuadsJsonV1' as const, quads: [] },
    occludesAdjacentFaces: false, tooltip: [],
  })
  return {
    geometryPhase: 'baked', id: 'two-cell',
    blockPalette: [paletteEntry('air'), paletteEntry('minecraft:stone'), paletteEntry('minecraft:dirt')],
    materialPalette: [],
    cellGrid: [[[1, 2]]],
  } as unknown as StructureDefinition
}

/** 硬编码索引（不从 fixture 反读）：part / host / 无对应 三种条目 + 另一帧条目 */
const RAW_INDEX: ItemIndex = {
  'k:part': {
    display: 'Part Thing', tooltip: ['Part Thing'], source: 'part',
    attribution: [{ source: 'part', frame: 0, grid: [0, 0, 0], localId: 'p:0' }],
  },
  'k:host': {
    display: 'Host Thing', tooltip: ['Host Thing'], source: 'host',
    attribution: [
      { source: 'host', frame: 0, grid: [0, 0, 1] },
      { source: 'host', frame: 0, grid: [0, 0, 0] },
    ],
  },
  'k:shared': {
    display: 'Shared', tooltip: [], source: 'part',
    // 与 k:part 同一条命中（并集去重断言） + 自身独有的一条
    attribution: [
      { source: 'part', frame: 0, grid: [0, 0, 0], localId: 'p:0' },
      { source: 'part', frame: 0, grid: [0, 0, 1], localId: 'p:1' },
    ],
  },
  'k:none': {
    display: 'No Block', tooltip: ['No Block'], source: 'none', attribution: [],
  },
  'k:otherframe': {
    display: 'Other Frame', tooltip: ['Other Frame'], source: 'host',
    attribution: [{ source: 'host', frame: 7, grid: [0, 0, 0] }],
  },
}

const INDEX = buildItemHitIndexFromIndex(RAW_INDEX)

describe('B-5 命中计划：并集 / 权威度 / 截断', () => {
  it('并集：两个选中项的同一条命中去重，只算一处', () => {
    const p = planItemOutlineHits(INDEX, ['k:part', 'k:shared'], { frame: 0 })
    expect(p.selectedCount).toBe(2)
    expect(p.totalHits, 'k:part 1 + k:shared 2 − 重复 1 = 2').toBe(2)
    expect(p.hits.map((h) => `${h.source}|${h.grid[2]}|${h.localId ?? ''}`)).toEqual([
      'part|0|p:0',   // 字典序 k:part 在前；其唯一条目
      'part|1|p:1',   // k:shared 独有条目
    ])
    expect(p.truncated).toBe(false)
    expect(p.shownHits).toBe(2)
  })

  it('截断：命中总数超上限 ⇒ 保留前 N 条 + `truncated`（不是静默失效）', () => {
    const p = planItemOutlineHits(INDEX, ['k:part', 'k:host', 'k:shared'], { frame: 0, max: 2 })
    expect(p.totalHits).toBe(4) // part 1 + host 2 + shared 独有 1（共享那条去重）
    expect(p.shownHits).toBe(2)
    expect(p.truncated).toBe(true)
    expect(p.hits).toHaveLength(2)
  })

  it('缺省上限 = `OUTLINE_MASK_LIMIT`（与既有 ≤500 口径同值）', () => {
    expect(OUTLINE_MASK_LIMIT).toBe(500)
    const distinct: ItemIndex = {
      k: {
        display: 'k', tooltip: ['k'], source: 'host',
        attribution: Array.from({ length: OUTLINE_MASK_LIMIT + 3 }, (_, i) => ({
          source: 'host' as const, frame: 0, grid: [i, 0, 0] as [number, number, number],
        })),
      },
    }
    const p = planItemOutlineHits(buildItemHitIndexFromIndex(distinct), ['k'], { frame: 0 })
    expect(p.totalHits).toBe(OUTLINE_MASK_LIMIT + 3)
    expect(p.shownHits).toBe(OUTLINE_MASK_LIMIT)
    expect(p.truncated).toBe(true)
  })

  it('空选择 ⇒ 共享空计划（调用方无需各自造零值）', () => {
    expect(planItemOutlineHits(INDEX, [], { frame: 0 })).toBe(EMPTY_ITEM_OUTLINE_PLAN)
  })
})

describe('B-5 命中计划：无对应 / 跨帧 分别可辨认', () => {
  it('无条目 与 attribution 为空 同义计入 `unresolvedCount`（都意味着点了不会亮）', () => {
    const p = planItemOutlineHits(INDEX, ['k:none', 'k:missing', 'k:part'], { frame: 0 })
    expect(p.selectedCount).toBe(3)
    expect(p.unresolvedCount).toBe(2)
    expect(p.offFrameCount).toBe(0)
    expect(p.totalHits).toBe(1)
  })

  it('有归属但都不在当前帧 ⇒ `offFrameCount`，与"没有对应方块"不同义', () => {
    const p = planItemOutlineHits(INDEX, ['k:otherframe'], { frame: 0 })
    expect(p.unresolvedCount, '有归属 ⇒ 不算无对应').toBe(0)
    expect(p.offFrameCount).toBe(1)
    expect(p.totalHits).toBe(0)
    expect(p.hits).toEqual([])

    const onFrame = planItemOutlineHits(INDEX, ['k:otherframe'], { frame: 7 })
    expect(onFrame.offFrameCount).toBe(0)
    expect(onFrame.totalHits).toBe(1)
  })
})

describe('B-5 命中计划：下标换算与部件级优先', () => {
  const def = twoCellDef()

  it('part 命中 ⇒ 带 partLocalId（B-1 部件通道）；host 命中 ⇒ 不带（整格兜底）', () => {
    const refs = itemHitBlockRefs(def, [
      { source: 'part', frame: 0, grid: [0, 0, 0], localId: 'p:0' },
      { source: 'host', frame: 0, grid: [0, 0, 1] },
    ])
    expect(refs).toEqual([
      { pos: { x: 0, y: 0, z: 0 }, block_state_id: 'minecraft:stone', partLocalId: 'p:0' },
      { pos: { x: 1, y: 0, z: 0 }, block_state_id: 'minecraft:dirt' },
    ])
  })

  it('grid = [zSlice, row, column]（row 0 = 顶部 ⇒ y 翻转）；palette 决定 block_state_id', () => {
    const refs = itemHitBlockRefs(def, [
      { source: 'host', frame: 0, grid: [0, 0, 0] },
      { source: 'host', frame: 0, grid: [0, 0, 1] },
    ])
    expect(refs.map((r) => r.pos)).toEqual([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }])
    expect(refs.map((r) => r.block_state_id)).toEqual(['minecraft:stone', 'minecraft:dirt'])
  })

  it('归属指向不存在的格（越界 / 空 / 调色板无效）⇒ 丢该条，不画幻影 mask', () => {
    expect(itemHitBlockRefs(def, [
      { source: 'host', frame: 0, grid: [9, 0, 0] },
      { source: 'host', frame: 0, grid: [0, 9, 0] },
      { source: 'host', frame: 0, grid: [0, 0, 9] },
      { source: 'host', frame: 0, grid: [0, 0, 0] },
    ])).toEqual([{ pos: { x: 0, y: 0, z: 0 }, block_state_id: 'minecraft:stone' }])
  })
})

// ---------------------------------------------------------------------------
// 证伪（#38 硬要求）：篡改归属数据 ⇒ 计划 / 格引用必须变化
// ---------------------------------------------------------------------------

describe('B-5 证伪：篡改归属数据，高亮集合必须变化', () => {
  const def = twoCellDef()

  it('把 part 命中的格从 (0,0,0) 改到 (0,0,1) ⇒ BlockRef 位置改变', () => {
    const before = itemHitBlockRefs(def, planItemOutlineHits(INDEX, ['k:part'], { frame: 0 }).hits)
    expect(before.map((r) => r.pos)).toEqual([{ x: 0, y: 0, z: 0 }])

    const tampered = buildItemHitIndexFromIndex({
      'k:part': {
        display: 'Part Thing', tooltip: ['Part Thing'], source: 'part',
        attribution: [{ source: 'part', frame: 0, grid: [0, 0, 1], localId: 'p:0' }],
      },
    })
    const after = itemHitBlockRefs(def, planItemOutlineHits(tampered, ['k:part'], { frame: 0 }).hits)
    expect(after.map((r) => r.pos)).toEqual([{ x: 1, y: 0, z: 0 }])
    expect(after).not.toEqual(before)
  })

  it('把 localId 换成同格另一部件 ⇒ 部件级 mask 目标改变（partLocalId 变化）', () => {
    const tampered = buildItemHitIndexFromIndex({
      'k:part': {
        display: 'Part Thing', tooltip: [], source: 'part',
        attribution: [{ source: 'part', frame: 0, grid: [0, 0, 0], localId: 'p:9' }],
      },
    })
    const after = itemHitBlockRefs(def, planItemOutlineHits(tampered, ['k:part'], { frame: 0 }).hits)
    expect(after[0]!.partLocalId).toBe('p:9')
  })

  it('把 part 命中降级为 host 命中 ⇒ partLocalId 消失（部件级 → 整格兜底）', () => {
    const tampered = buildItemHitIndexFromIndex({
      'k:part': {
        display: 'Part Thing', tooltip: [], source: 'host',
        attribution: [{ source: 'host', frame: 0, grid: [0, 0, 0] }],
      },
    })
    const after = itemHitBlockRefs(def, planItemOutlineHits(tampered, ['k:part'], { frame: 0 }).hits)
    expect(after[0]).not.toHaveProperty('partLocalId')
  })

  it('清空 attribution ⇒ 命中集合归零、该选中项转为"无对应"', () => {
    const tampered = buildItemHitIndexFromIndex({
      'k:part': { display: 'Part Thing', tooltip: [], source: 'part', attribution: [] },
    })
    const p = planItemOutlineHits(tampered, ['k:part'], { frame: 0 })
    expect(p.totalHits).toBe(0)
    expect(p.hits).toEqual([])
    expect(p.unresolvedCount).toBe(1)
  })

  it('篡改帧号 ⇒ 当前帧不再命中（`offFrameCount` 接手）', () => {
    const tampered = buildItemHitIndexFromIndex({
      'k:part': {
        display: 'Part Thing', tooltip: [], source: 'part',
        attribution: [{ source: 'part', frame: 3, grid: [0, 0, 0], localId: 'p:0' }],
      },
    })
    const p = planItemOutlineHits(tampered, ['k:part'], { frame: 0 })
    expect(p.totalHits).toBe(0)
    expect(p.offFrameCount).toBe(1)
  })
})
