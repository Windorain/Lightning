/**
 * B-5（#38）— 物品选中集 → **视口 mask** 的集成断言（`runtime/embedItemOutline.ts`）。
 *
 * 这一条测试打的是**从归属数据到真正喂给 `SelectionOutlinePass` 的 mask 几何**的整条链
 * （真 `RuntimeDocument` + 真 `context/queries` 通道 + 真 `SelectionHighlightProvider`），
 * 即 #38 的「部件级优先、整格兜底」「并集」「截断不静默失效」「证伪」四条硬约束在**渲染侧
 * 的可观测结果**——不是只测纯计划（那在 `pure/__tests__/itemOutlinePlan.test.ts`）。
 *
 * ctx 只取 `getDoc()` / `getCurrentFrameIndex()`，与 `context/__tests__/partMaskChannel.test.ts`
 * 同口径的最小手工实例（无替身：RuntimeDocument 是真解析产物）。
 */
import { describe, expect, it } from 'vitest'
import { ref, shallowRef, type ShallowRef } from 'vue'
import * as THREE from 'three'
import { RuntimeDocument } from '@/context/runtimeDocument'
import { currentFrameKey, getBlockGeometry, getPartMaskGeometry, gridCenterWorld } from '@/context/queries'
import { buildItemHitIndexFromIndex, type ItemIndex } from '@/pure/itemIndex'
import { createEmbedItemOutlineMasks } from '@/runtime/embedItemOutline'
import type { Context } from '@/runtime/context'
import type { StructureDefinition } from '@/render/schema/types'

import ae2Fixture from '../../../e2e/fixtures/parts-ae2-multibox.v2.json'

type Json = Record<string, unknown>

function ctxFor(doc: RuntimeDocument): Context {
  return {
    getDoc: () => ref(doc),
    getCurrentFrameIndex: () => ref(0),
  } as unknown as Context
}

/** 运行时定义形态（同生产）：文档根字段 + 首帧 structure 展开到同一对象 */
function runtimeDefOf(fixture: unknown): StructureDefinition {
  const root = fixture as Record<string, unknown>
  const frames = root.frames as Array<{ structure: unknown }>
  const { frames: _f, annotations: _a, labels: _l, ...rest } = root
  return { ...rest, ...(frames[0]!.structure as Record<string, unknown>) } as unknown as StructureDefinition
}

/** mask mesh 的世界空间 AABB（读数用；不做任何归一化假设） */
function meshAabb(mesh: THREE.Mesh): { min: number[]; max: number[] } {
  const attr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < attr.count; i++) {
    for (let a = 0; a < 3; a++) {
      const v = attr.getComponent(i, a)
      if (v < min[a]!) min[a] = v
      if (v > max[a]!) max[a] = v
    }
  }
  return { min, max }
}

/** 4 位小数比较（几何为落盘的 1/16 网格常量与 0.5 平移，误差应为 0） */
function round4(v: number[]): number[] {
  return v.map((n) => Math.round(n * 10000) / 10000)
}

function aabbSorter(
  a: { min: number[]; max: number[] },
  b: { min: number[]; max: number[] },
): number {
  return a.min[0]! - b.min[0]! || a.min[1]! - b.min[1]! || a.min[2]! - b.min[2]!
}

function collectAabbs(meshes: readonly THREE.Mesh[]): Array<{ min: number[]; max: number[] }> {
  return meshes
    .map((m) => { const b = meshAabb(m); return { min: round4(b.min), max: round4(b.max) } })
    .sort(aabbSorter)
}

/**
 * 硬编码索引（不从 fixture 反读期望）：
 *  - `...ItemMultiPart:80` = NORTH 切换总线（part 命中，盒 z∈[0, 0.3125]）；
 *  - `...ItemMultiPart:220` = UP 存储总线（part 命中，三个视觉盒）；
 *  - `minecraft:stone:0` = 宿主级（host 命中，整格兜底）；
 *  - `minecraft:torch:0` = 显式"没有对应方块"。
 */
const AE2_ITEM_INDEX: ItemIndex = {
  'appliedenergistics2:item.ItemMultiPart:80': {
    display: 'ME Toggle Bus', tooltip: ['ME Toggle Bus'], source: 'part',
    attribution: [{ source: 'part', frame: 0, grid: [0, 0, 0], localId: 'ae2:NORTH' }],
  },
  'appliedenergistics2:item.ItemMultiPart:220': {
    display: 'ME Storage Bus', tooltip: ['ME Storage Bus'], source: 'part',
    attribution: [{ source: 'part', frame: 0, grid: [0, 0, 0], localId: 'ae2:UP' }],
  },
  'minecraft:stone:0': {
    display: 'Stone', tooltip: ['Stone'], source: 'host',
    attribution: [{ source: 'host', frame: 0, grid: [0, 0, 1] }],
  },
  'minecraft:torch:0': {
    display: 'Torch', tooltip: ['Torch'], source: 'none', attribution: [],
  },
}

const TOGGLE = 'appliedenergistics2:item.ItemMultiPart:80'
const STORAGE = 'appliedenergistics2:item.ItemMultiPart:220'
const STONE = 'minecraft:stone:0'
const TORCH = 'minecraft:torch:0'

interface Harness {
  masks: ShallowRef<THREE.Mesh[]>
  plan: ReturnType<typeof createEmbedItemOutlineMasks>['plan']
  rebuild: (keys: ReadonlySet<string> | null) => void
  setIndex: (raw: ItemIndex) => void
  setDefinition: (def: StructureDefinition | null) => void
}

function harnessFor(fixture: unknown, rawIndex: ItemIndex, max?: number): Harness {
  const def = runtimeDefOf(fixture)
  const ctx = ctxFor(RuntimeDocument.fromV2Plain(fixture as unknown as Json)!)
  const definitionRef = shallowRef<StructureDefinition | null>(def)
  const masks = shallowRef<THREE.Mesh[]>([])
  let index = buildItemHitIndexFromIndex(rawIndex)
  const api = createEmbedItemOutlineMasks({
    definitionRef,
    masksRef: masks,
    indexRef: () => index,
    frameRef: () => currentFrameKey(ctx),
    getBlockGeometry: (pos) => getBlockGeometry(ctx, pos),
    gridCenterWorld: (pos) => gridCenterWorld(ctx, pos),
    getPartMaskGeometry: (blockRef) => getPartMaskGeometry(ctx, blockRef),
    max,
  })
  return {
    masks,
    plan: api.plan,
    rebuild: api.rebuildItemSelectionMasks,
    setIndex: (raw) => { index = buildItemHitIndexFromIndex(raw) },
    setDefinition: (d) => { definitionRef.value = d },
  }
}

// AE2 fixture：2 格宽 × 1 高 × 1 深；格 (x=0) = 线缆总线（3 部件），格 (x=1) = 石头。
// 世界坐标：格中心 = (x − 1 + 0.5, y, z)，格角 = 格中心 − 0.5。

describe('B-5 mask：部件级优先（part 命中走 B-1 部件盒通道）', () => {
  it('NORTH 切换总线 ⇒ mask 恰为其视觉盒（不框整格，也不带上线缆/存储总线）', () => {
    const h = harnessFor(ae2Fixture, AE2_ITEM_INDEX)
    h.rebuild(new Set([TOGGLE]))
    expect(h.masks.value).toHaveLength(1)
    // 格角 = (−1, −0.5, −0.5)；盒 [0.375,0.375,0]–[0.625,0.625,0.3125]
    expect(collectAabbs(h.masks.value)).toEqual([
      { min: [-0.625, -0.125, -0.5], max: [-0.375, 0.125, -0.1875] },
    ])
    expect(h.plan.value.totalHits).toBe(1)
    expect(h.plan.value.truncated).toBe(false)
  })

  it('存储总线（三视觉盒 union）⇒ 与切换总线 mask 不同；两者并集 = 两块', () => {
    const h = harnessFor(ae2Fixture, AE2_ITEM_INDEX)
    h.rebuild(new Set([TOGGLE]))
    const toggle = collectAabbs(h.masks.value)
    h.rebuild(new Set([STORAGE]))
    const storage = collectAabbs(h.masks.value)
    expect(storage).not.toEqual(toggle)
    // 盒 union 的 AABB：局部 [0.125,0.75,0.125]–[0.875,1,0.875] ⇒ 世界 +(−1,−0.5,−0.5)
    expect(storage).toEqual([
      { min: [-0.875, 0.25, -0.375], max: [-0.125, 0.5, 0.375] },
    ])

    h.rebuild(new Set([TOGGLE, STORAGE]))
    expect(h.plan.value.totalHits).toBe(2)
    expect(h.masks.value).toHaveLength(2)
    expect(collectAabbs(h.masks.value)).toEqual([...toggle, ...storage].sort(aabbSorter))
  })

  it('host 命中 ⇒ 整格兜底（不带 partLocalId），与部件通道产出不同', () => {
    const h = harnessFor(ae2Fixture, AE2_ITEM_INDEX)
    h.rebuild(new Set([STONE]))
    expect(h.masks.value).toHaveLength(1)
    // 石头格（x=1 ⇒ 格角 (0,−0.5,−0.5)）的两块四边面局部 AABB = [0,0,0]–[1,1,1]
    expect(collectAabbs(h.masks.value)).toEqual([
      { min: [0, -0.5, -0.5], max: [1, 0.5, 0.5] },
    ])
  })
})

describe('B-5 mask：无对应 / 并集 / 清空', () => {
  it('无对应物品可选中但**不高亮**：mask 为空、计划报 1 项无对应', () => {
    const h = harnessFor(ae2Fixture, AE2_ITEM_INDEX)
    h.rebuild(new Set([TORCH]))
    expect(h.masks.value).toEqual([])
    expect(h.plan.value.selectedCount).toBe(1)
    expect(h.plan.value.unresolvedCount).toBe(1)
  })

  it('混选（有对应 + 无对应）⇒ 只亮有对应项，无对应项逐项可辨认（计数可读）', () => {
    const h = harnessFor(ae2Fixture, AE2_ITEM_INDEX)
    h.rebuild(new Set([TOGGLE, TORCH]))
    expect(h.masks.value).toHaveLength(1)
    expect(h.plan.value.selectedCount).toBe(2)
    expect(h.plan.value.unresolvedCount).toBe(1)
    expect(h.plan.value.totalHits).toBe(1)
  })

  it('空集 / null ⇒ 清空 mask 与计划（不做任何残留）', () => {
    const h = harnessFor(ae2Fixture, AE2_ITEM_INDEX)
    h.rebuild(new Set([TOGGLE]))
    expect(h.masks.value).toHaveLength(1)
    h.rebuild(new Set())
    expect(h.masks.value).toEqual([])
    expect(h.plan.value.selectedCount).toBe(0)
    h.rebuild(new Set([TOGGLE]))
    h.rebuild(null)
    expect(h.masks.value).toEqual([])
    expect(h.plan.value.hits).toEqual([])
  })

  it('无定义（尚未加载）⇒ 空 mask，不抛', () => {
    const h = harnessFor(ae2Fixture, AE2_ITEM_INDEX)
    h.setDefinition(null)
    h.rebuild(new Set([TOGGLE]))
    expect(h.masks.value).toEqual([])
  })
})

describe('B-5 mask：命中截断（≤500 口径，截断而非静默失效）', () => {
  /** N 格一行的石头结构（每格都有几何 ⇒ 每条 host 命中都能产出 1 块 mask） */
  function rowFixture(cells: number): Json {
    const quad = {
      materialIndex: 0,
      vertices: [
        { x: 0, y: 0, z: 1, u: 0, v: 0 }, { x: 1, y: 0, z: 1, u: 1, v: 0 },
        { x: 1, y: 1, z: 1, u: 1, v: 1 }, { x: 0, y: 1, z: 1, u: 0, v: 1 },
      ],
    }
    const paletteEntry = (registryId: string, quads: unknown[]) => ({
      registryId, meta: 0, renderMode: 'BakedQuads',
      geometry: { encoding: 'bakedQuadsJsonV1', quads }, occludesAdjacentFaces: false, tooltip: [],
    })
    return {
      format_version: '2.0', id: 'row',
      frames: [{
        index: 0,
        structure: {
          geometryPhase: 'baked',
          cellGrid: [[Array.from({ length: cells }, () => 1)]],
          blockPalette: [paletteEntry('air', []), paletteEntry('minecraft:stone', [quad])],
        },
      }],
      materialPalette: [], textureBlobs: [], annotations: [], labels: [],
    }
  }

  it('命中 6 条、上限 4 ⇒ 亮 4 块 + `truncated` 可读（不是"整批失效"）', () => {
    const cells = 6
    const raw: ItemIndex = {
      'minecraft:stone:0': {
        display: 'Stone', tooltip: ['Stone'], source: 'host',
        attribution: Array.from({ length: cells }, (_, i) => ({
          source: 'host' as const, frame: 0, grid: [0, 0, i] as [number, number, number],
        })),
      },
    }
    const h = harnessFor(rowFixture(cells), raw, 4)
    h.rebuild(new Set(['minecraft:stone:0']))
    expect(h.plan.value.totalHits).toBe(6)
    expect(h.plan.value.shownHits).toBe(4)
    expect(h.plan.value.truncated).toBe(true)
    expect(h.masks.value, '截断后仍确实产出 mask（不得静默失效）').toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------
// 证伪（#38 硬要求）：篡改归属数据 ⇒ 高亮集合（mask）必须变化
// ---------------------------------------------------------------------------

describe('B-5 证伪：篡改归属 ⇒ mask 集合必须变化', () => {
  it('part 命中的 localId 换到同格另一部件 ⇒ mask AABB 变化', () => {
    const h = harnessFor(ae2Fixture, AE2_ITEM_INDEX)
    h.rebuild(new Set([TOGGLE]))
    const before = collectAabbs(h.masks.value)
    expect(before).toEqual([{ min: [-0.625, -0.125, -0.5], max: [-0.375, 0.125, -0.1875] }])

    h.setIndex({
      ...AE2_ITEM_INDEX,
      [TOGGLE]: {
        display: 'ME Toggle Bus', tooltip: [], source: 'part',
        attribution: [{ source: 'part', frame: 0, grid: [0, 0, 0], localId: 'ae2:UP' }],
      },
    })
    h.rebuild(new Set([TOGGLE]))
    const after = collectAabbs(h.masks.value)
    expect(after).not.toEqual(before)
    expect(after).toEqual([{ min: [-0.875, 0.25, -0.375], max: [-0.125, 0.5, 0.375] }])
  })

  it('part 命中改到相邻格 ⇒ mask 整体变化（位置随归属数据变化）', () => {
    const h = harnessFor(ae2Fixture, AE2_ITEM_INDEX)
    h.rebuild(new Set([TOGGLE]))
    const before = collectAabbs(h.masks.value)

    h.setIndex({
      ...AE2_ITEM_INDEX,
      [TOGGLE]: {
        display: 'ME Toggle Bus', tooltip: [], source: 'part',
        // 相邻格（石头格）无该部件 ⇒ 部件通道回退整格；无论回退与否，mask 都不等于原部件盒
        attribution: [{ source: 'part', frame: 0, grid: [0, 0, 1], localId: 'ae2:NORTH' }],
      },
    })
    h.rebuild(new Set([TOGGLE]))
    const after = collectAabbs(h.masks.value)
    expect(after).not.toEqual(before)
    // 石头格（x=1）整格兜底：[0,0,0]–[1,1,1] 局部 ⇒ 世界 +（0,−0.5,−0.5）
    expect(after).toEqual([{ min: [0, -0.5, -0.5], max: [1, 0.5, 0.5] }])
  })

  it('归属清空 ⇒ mask 集合归零（"没有对应方块"的最强形态）', () => {
    const h = harnessFor(ae2Fixture, AE2_ITEM_INDEX)
    h.rebuild(new Set([TOGGLE]))
    expect(h.masks.value).toHaveLength(1)

    h.setIndex({
      ...AE2_ITEM_INDEX,
      [TOGGLE]: { display: 'ME Toggle Bus', tooltip: [], source: 'none', attribution: [] },
    })
    h.rebuild(new Set([TOGGLE]))
    expect(h.masks.value).toEqual([])
    expect(h.plan.value.unresolvedCount).toBe(1)
  })

  it('篡改帧号 ⇒ 当前帧无 mask（`offFrameCount` 接手，不静默）', () => {
    const h = harnessFor(ae2Fixture, AE2_ITEM_INDEX)
    h.setIndex({
      ...AE2_ITEM_INDEX,
      [TOGGLE]: {
        display: 'ME Toggle Bus', tooltip: [], source: 'part',
        attribution: [{ source: 'part', frame: 9, grid: [0, 0, 0], localId: 'ae2:NORTH' }],
      },
    })
    h.rebuild(new Set([TOGGLE]))
    expect(h.masks.value).toEqual([])
    expect(h.plan.value.offFrameCount).toBe(1)
    expect(h.plan.value.unresolvedCount).toBe(0)
  })
})
