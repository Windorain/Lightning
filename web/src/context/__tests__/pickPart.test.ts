/**
 * P2.2 — pickPartForScenePick（context/queries.ts）集成测试。
 *
 * 命中链接入验证：pickVoxel 命中格后，世界命中点 → 格内局部坐标 → 部件盒命中。
 *  - fixture 同格三部件：各投影点命中各自部件（不同 localId ⇒ 不同悬停目标）
 *  - 满方块格 / 无部件格 ⇒ null（宿主格既有行为不劣化）
 *  - 格内未命中任何部件盒 ⇒ null（回退宿主）
 *  - 栅栏越界盒（maxY=1.5）经碰撞盒回退命中
 *
 * ctx 仅取 getDoc()/getFrameIndex()，测试用最小手工实例（非渲染路径替身）。
 */
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { pickPartForScenePick } from '@/context/queries'
import { RuntimeDocument } from '@/context/runtimeDocument'
import type { Context } from '@/runtime/context'
import type { ScenePickBlock } from '@/render/interaction/scenePick'
import { voxelCenterWorld } from '@/pure/vec'

import ae2Fixture from '../../../e2e/fixtures/parts-ae2-multibox.v2.json'
import singleboxFixture from '../../../e2e/fixtures/parts-singlebox-mix.v2.json'

type Json = Record<string, unknown>

function ctxFor(doc: RuntimeDocument): Context {
  return {
    getDoc: () => ref(doc),
    getFrameIndex: () => 0,
  } as unknown as Context
}

/** 由格内局部坐标构造 pick 结果的世界命中点（与网格世界偏移互逆，见 pure/partHit.ts） */
function pickAt(
  column: number,
  row: number,
  zSlice: number,
  size: { w: number; h: number; d: number },
  local: { x: number; y: number; z: number },
): ScenePickBlock {
  const center = voxelCenterWorld(column, row, zSlice, size.w, size.h, size.d)
  return {
    kind: 'block',
    distance: 1,
    blockId: 'test:block',
    column,
    row,
    zSlice,
    point: { x: center.x + local.x - 0.5, y: center.y + local.y - 0.5, z: center.z + local.z - 0.5 },
  }
}

describe('pickPartForScenePick — AE2 同格三部件', () => {
  const doc = RuntimeDocument.fromV2Plain(ae2Fixture as unknown as Json)!
  const ctx = ctxFor(doc)
  // fixture 网格 2×1×1：部件格 column=0, row=0, zSlice=0；满方块石头 column=1
  const size = { w: 2, h: 1, d: 1 }

  it('中心线缆 / NORTH 切换总线 / UP 存储总线各自投影点命中各自部件', () => {
    expect(
      pickPartForScenePick(ctx, pickAt(0, 0, 0, size, { x: 0.5, y: 0.5, z: 0.5 }))?.part.localId,
    ).toBe('ae2:UNKNOWN')
    expect(
      pickPartForScenePick(ctx, pickAt(0, 0, 0, size, { x: 0.5, y: 0.5, z: 0.15 }))?.part.localId,
    ).toBe('ae2:NORTH')
    expect(
      pickPartForScenePick(ctx, pickAt(0, 0, 0, size, { x: 0.5, y: 0.98, z: 0.5 }))?.part.localId,
    ).toBe('ae2:UP')
  })

  it('命中返回格内局部坐标（供调试/归属呈现）', () => {
    const hit = pickPartForScenePick(ctx, pickAt(0, 0, 0, size, { x: 0.5, y: 0.5, z: 0.5 }))
    expect(hit?.localPoint.x).toBeCloseTo(0.5)
    expect(hit?.localPoint.y).toBeCloseTo(0.5)
    expect(hit?.localPoint.z).toBeCloseTo(0.5)
  })

  it('格内但未命中任何部件盒 ⇒ null（悬停目标 = 宿主格，既有行为）', () => {
    expect(pickPartForScenePick(ctx, pickAt(0, 0, 0, size, { x: 0.1, y: 0.1, z: 0.9 }))).toBeNull()
  })

  it('满方块格（石头）⇒ null（无部件，行为与今天一致）', () => {
    expect(pickPartForScenePick(ctx, pickAt(1, 0, 0, size, { x: 0.5, y: 0.5, z: 0.5 }))).toBeNull()
  })

  it('pick 无 point（旧调用路径）⇒ null', () => {
    const noPoint = { ...pickAt(0, 0, 0, size, { x: 0.5, y: 0.5, z: 0.5 }) }
    delete noPoint.point
    expect(pickPartForScenePick(ctx, noPoint)).toBeNull()
  })
})

describe('pickPartForScenePick — 单盒混存 fixture', () => {
  const doc = RuntimeDocument.fromV2Plain(singleboxFixture as unknown as Json)!
  const ctx = ctxFor(doc)
  // 网格 5×1×1：[下半 slab, 下半 slab, 上半 slab, 石头, 栅栏]
  const size = { w: 5, h: 1, d: 1 }

  it('下半 slab：y=0.25 命中；y=0.75 不命中（回退宿主）', () => {
    expect(
      pickPartForScenePick(ctx, pickAt(0, 0, 0, size, { x: 0.5, y: 0.25, z: 0.5 }))?.part.typeKey,
    ).toBe('minecraft:stone_slab:0')
    expect(pickPartForScenePick(ctx, pickAt(0, 0, 0, size, { x: 0.5, y: 0.75, z: 0.5 }))).toBeNull()
  })

  it('上半 slab：y=0.75 命中（同 typeKey、盒不同）', () => {
    expect(
      pickPartForScenePick(ctx, pickAt(2, 0, 0, size, { x: 0.5, y: 0.75, z: 0.5 }))?.part.localId,
    ).toBe('generic:0')
  })

  it('栅栏：y=1.2 越界点经碰撞盒回退命中（契约 §6.3）', () => {
    const hit = pickPartForScenePick(ctx, pickAt(4, 0, 0, size, { x: 0.5, y: 1.2, z: 0.5 }))
    expect(hit?.part.typeKey).toBe('minecraft:fence:0')
    expect(hit?.localPoint.y).toBeCloseTo(1.2)
  })

  it('满方块对照格（石头）⇒ null', () => {
    expect(pickPartForScenePick(ctx, pickAt(3, 0, 0, size, { x: 0.5, y: 0.5, z: 0.5 }))).toBeNull()
  })
})
