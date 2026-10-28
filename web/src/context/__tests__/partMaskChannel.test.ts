/**
 * B-1 — 「格 + 部件定位 → 该部件 mask」通道（context/queries.ts）集成测试。
 *
 * 验证 hover 描边与点选高亮共用的那条通道：`getPartMaskGeometry(ctx, ref)`。
 *  - `ref.partLocalId` 缺省 ⇒ 整格几何（B-1 之前行为，无部件格 / 框选等路径不变）；
 *  - 给出且该格有部件 ⇒ 该部件盒 union（AE2 同格三部件各自不同）；
 *  - 未知 localId / 无部件数据 / 无几何 ⇒ 回退整格 / null（不劣化）。
 *
 * ctx 只取 getDoc()/getFrameIndex()，与 `pickPart.test.ts` 同口径的最小手工实例。
 */
import { describe, it, expect } from 'vitest'
// `ref` 随手工替身一起移除（改走 `makeKernelReadHost` 的真 `Context`）。
import { getBlockGeometry, getPartMaskGeometry, getPartsAt } from '@/context/queries'
import { RuntimeDocument } from '@/context/runtimeDocument'
import type { Context } from '@/runtime/context'
// 手工替身换成**真 `Context`**（见 `pickPart.test.ts` 的同款说明）。
import { makeKernelReadHost } from '@/runtime/__tests__/kernelReadTestHost'
import type { BlockRef } from '@/render/schema/types'

import ae2Fixture from '../../../e2e/fixtures/parts-ae2-multibox.v2.json'
import singleboxFixture from '../../../e2e/fixtures/parts-singlebox-mix.v2.json'

type Json = Record<string, unknown>

function ctxFor(doc: RuntimeDocument): Context {
  // `getDoc()` 已终删 ⇒ 用**真 `Context`**（生产读面本体）。
  // ⚠️ 这是**正确的摩擦**：生产读面变了，替身必须同步 —— 若替身缺 `kernelGrid`，
  // 会以 `is not a function` 判红，而不是静默读到空网格（后者会让判据空转）。
  const ctx = makeKernelReadHost(doc).ctx
  // `getFrameIndex` 是**时间面**（不属本组读面）⇒ 手工补一位（本组只用帧 0）。
  return Object.assign(ctx, { getFrameIndex: () => 0 }) as Context
}

/** fixture 网格 2×1×1：部件格 (0,0,0)，石头格 (1,0,0) */
function blockRef(x: number, y: number, z: number, partLocalId?: string): BlockRef {
  return {
    pos: { x, y, z },
    block_state_id: 'appliedenergistics2:tile.BlockCableBus',
    partLocalId,
  }
}

describe('getPartMaskGeometry — AE2 同格三部件', () => {
  const ctx = ctxFor(RuntimeDocument.fromV2Plain(ae2Fixture as unknown as Json)!)

  it('整格通道：返回该格全部 4 个 baked quads（引用即 palette 几何，零拷贝）', () => {
    const r = getPartMaskGeometry(ctx, blockRef(0, 0, 0))!
    expect(r.boxes).toBeUndefined()
    expect(r.quads).toHaveLength(4)
    expect(r.quads).toBe(getBlockGeometry(ctx, { x: 0, y: 0, z: 0 }))
  })

  it('格 + 部件定位 ⇒ 该部件盒（三个部件各自不同，且都收敛到各自盒内）', () => {
    const cable = getPartMaskGeometry(ctx, blockRef(0, 0, 0, 'ae2:UNKNOWN'))!
    const toggle = getPartMaskGeometry(ctx, blockRef(0, 0, 0, 'ae2:NORTH'))!
    const storage = getPartMaskGeometry(ctx, blockRef(0, 0, 0, 'ae2:UP'))!

    expect(cable.boxes).toHaveLength(3)
    expect(toggle.boxes).toEqual([
      { min: [0.375, 0.375, 0], max: [0.625, 0.625, 0.3125], kind: 'visual' },
    ])
    expect(storage.boxes).toHaveLength(3)

    const keys = [cable, toggle, storage].map(g => JSON.stringify(g))
    expect(new Set(keys).size, '同格不同部件 ⇒ 不同 mask 几何').toBe(3)

    // 线缆 mask 不覆盖存储总线顶面（y=1）——修复前整格并集的典型“包住空气”
    const cableMaxY = Math.max(...cable.boxes!.map(b => b.max[1]))
    expect(cableMaxY).toBeLessThan(1)
  })

  it('未知 localId / 该格无部件（石头格）⇒ 回退整格，不产生空描边', () => {
    const unknown = getPartMaskGeometry(ctx, blockRef(0, 0, 0, 'ae2:nope'))!
    expect(unknown.boxes).toBeUndefined()
    expect(unknown.quads).toHaveLength(4)

    // 石头格无部件数据 ⇒ 即使给了 partLocalId 也回退整格几何
    const stone = getPartMaskGeometry(ctx, blockRef(1, 0, 0, 'ae2:NORTH'))!
    expect(stone.boxes).toBeUndefined()
    expect(stone.quads).toHaveLength(2)
    expect(stone.quads).toBe(getBlockGeometry(ctx, { x: 1, y: 0, z: 0 }))
  })

  it('getPartsAt：部件格非空、石头格 null（契约 §2 cellPartsGrid 的 -1 语义）', () => {
    expect(getPartsAt(ctx, { x: 0, y: 0, z: 0 })!.map(p => p.localId)).toEqual([
      'ae2:UNKNOWN', 'ae2:NORTH', 'ae2:UP',
    ])
    expect(getPartsAt(ctx, { x: 1, y: 0, z: 0 })).toBeNull()
    expect(getPartsAt(ctx, { x: 9, y: 9, z: 9 }), '越界 ⇒ null').toBeNull()
  })

  it('无几何（越界格）⇒ null（调用方走格中心 1×1×1 兜底）', () => {
    expect(getPartMaskGeometry(ctx, blockRef(9, 9, 9))).toBeNull()
    expect(getPartMaskGeometry(ctx, blockRef(9, 9, 9, 'ae2:UNKNOWN'))).toBeNull()
  })

  it('契约 §6.3：栅栏式越界盒（maxY > 1）在 mask 中如实保留、不裁剪', () => {
    const ctx2 = ctxFor(RuntimeDocument.fromV2Plain(singleboxFixture as unknown as Json)!)
    const fence = getPartMaskGeometry(ctx2, blockRef(4, 0, 0, 'generic:0'))!
    // 视觉盒 = [0.375,0,0.375]-[0.625,1,0.625]（碰撞盒 maxY=1.5 不参与 mask：视觉盒优先）
    expect(fence.boxes).toEqual([
      { min: [0.375, 0, 0.375], max: [0.625, 1, 0.625], kind: 'visual' },
    ])
  })

  it('单盒非满方块（下半 slab）：mask 盒 = 该格几何的包围盒（回归逐项一致）', () => {
    const ctx2 = ctxFor(RuntimeDocument.fromV2Plain(singleboxFixture as unknown as Json)!)
    const whole = getPartMaskGeometry(ctx2, blockRef(0, 0, 0))!
    const part = getPartMaskGeometry(ctx2, blockRef(0, 0, 0, 'generic:0'))!
    expect(part.boxes).toEqual([
      { min: [0, 0, 0], max: [1, 0.5, 1], kind: 'visual' },
    ])
    // 整格几何的 AABB = 盒（下半 slab 的两块四边面：顶面 y=0.5 + +z 面）
    const xs = whole.quads!.flatMap(q => q.vertices.map(v => [v.x, v.y, v.z]))
    const min = [0, 1, 2].map(i => Math.min(...xs.map(p => p[i]!)))
    const max = [0, 1, 2].map(i => Math.max(...xs.map(p => p[i]!)))
    expect(min).toEqual([0, 0, 0])
    expect(max).toEqual([1, 0.5, 1])
  })
})
