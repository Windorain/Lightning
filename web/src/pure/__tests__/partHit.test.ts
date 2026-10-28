/**
 * 部件命中判定纯函数测试（pure/partHit.ts）。
 *
 * 覆盖（任务自检清单）：
 *  - fixture 同格三部件：各自投影点命中各自部件（互不混淆）
 *  - 越界盒命中（栅栏碰撞盒 maxY=1.5，契约 §6.3 容忍）
 *  - 无部件格 / 未命中任何盒 ⇒ null（调用方回退宿主）
 *  - 重叠盒规则：最小命中盒体积者胜；并列取列表序前者
 *  - 视觉盒优先、碰撞盒回退（格级两趟语义）
 *  - blockLocalPointFromWorldPoint 与网格世界偏移互逆
 *
 * fixture：`e2e/fixtures/parts-ae2-multibox.v2.json`、`parts-singlebox-mix.v2.json`
 */
import { describe, it, expect } from 'vitest'
import {
  blockLocalPointFromWorldPoint,
  partBoxVolume,
  pickPartAtLocalPoint,
  pointInPartBox,
  PART_HIT_EPSILON,
} from '@/pure/partHit'
import type { PartBox, PartRecord } from '@/pure/partTypes'
import { voxelCenterWorld } from '@/pure/vec'

import ae2Fixture from '../../../e2e/fixtures/parts-ae2-multibox.v2.json'
import singleboxFixture from '../../../e2e/fixtures/parts-singlebox-mix.v2.json'

type Json = Record<string, unknown>

/** 直接读 fixture 根级 partLists（测试侧纯数据，非运行时编辑路径） */
function partListsOf(fixture: unknown): PartRecord[][] {
  const f = fixture as Json
  const frames = f.frames as Json[]
  const structure = frames[0]!.structure as Json
  return structure.partLists as unknown as PartRecord[][]
}

const ae2Parts = partListsOf(ae2Fixture)[0]!
const singleboxLists = partListsOf(singleboxFixture)
const fencePart = singleboxLists[2]![0]!

function syntheticPart(localId: string, boxes: PartBox[]): PartRecord {
  return {
    localId,
    typeKey: `test:${localId}`,
    boxes,
    displayName: localId,
    tooltip: [localId],
    items: [],
    source: { family: 'generic', fallback: true, boxProvenance: 'both', tier: 2 },
  }
}

describe('pointInPartBox', () => {
  const box: PartBox = { min: [0.375, 0.375, 0.375], max: [0.625, 0.625, 0.625], kind: 'visual' }

  it('盒内 / 边界（含端点与容差） / 盒外', () => {
    expect(pointInPartBox({ x: 0.5, y: 0.5, z: 0.5 }, box)).toBe(true)
    // 边界端点
    expect(pointInPartBox({ x: 0.375, y: 0.625, z: 0.5 }, box)).toBe(true)
    // 容差内浮点抖动
    expect(pointInPartBox({ x: 0.625 + PART_HIT_EPSILON / 2, y: 0.5, z: 0.5 }, box)).toBe(true)
    // 盒外
    expect(pointInPartBox({ x: 0.7, y: 0.5, z: 0.5 }, box)).toBe(false)
    expect(pointInPartBox({ x: 0.5, y: 0.5, z: 0.5 }, { ...box, min: [0.5, 0.5, 0.5], max: [0.5, 0.5, 0.5] })).toBe(true) // 退化盒
  })

  it('越界盒不裁剪（契约 §6.3）：栅栏碰撞盒 maxY=1.5', () => {
    const fenceCollision = fencePart.boxes.find((b) => b.kind === 'collision')!
    expect(fenceCollision.max[1]).toBeGreaterThan(1)
    expect(pointInPartBox({ x: 0.5, y: 1.2, z: 0.5 }, fenceCollision)).toBe(true)
    expect(partBoxVolume(fenceCollision)).toBeCloseTo(0.25 * 1.5 * 0.25)
  })
})

describe('pickPartAtLocalPoint — fixture 同格三部件', () => {
  it('中心线缆核 (0.5,0.5,0.5) ⇒ ae2:UNKNOWN', () => {
    expect(pickPartAtLocalPoint(ae2Parts, { x: 0.5, y: 0.5, z: 0.5 })?.localId).toBe('ae2:UNKNOWN')
  })

  it('NORTH 切换总线 (0.5,0.5,0.15) ⇒ ae2:NORTH', () => {
    expect(pickPartAtLocalPoint(ae2Parts, { x: 0.5, y: 0.5, z: 0.15 })?.localId).toBe('ae2:NORTH')
  })

  it('UP 存储总线顶板 (0.5,0.98,0.5) 与颈部 (0.5,0.8,0.5) ⇒ ae2:UP', () => {
    expect(pickPartAtLocalPoint(ae2Parts, { x: 0.5, y: 0.98, z: 0.5 })?.localId).toBe('ae2:UP')
    expect(pickPartAtLocalPoint(ae2Parts, { x: 0.5, y: 0.8, z: 0.5 })?.localId).toBe('ae2:UP')
  })

  it('三部件投影点互不相同 ⇒ 命中判定区分部件不只到格', () => {
    const hits = [
      { x: 0.5, y: 0.5, z: 0.5 },
      { x: 0.5, y: 0.5, z: 0.15 },
      { x: 0.5, y: 0.98, z: 0.5 },
    ].map((p) => pickPartAtLocalPoint(ae2Parts, p)?.localId)
    expect(new Set(hits).size).toBe(3)
  })

  it('格内但未命中任何部件盒 ⇒ null（回退宿主格）', () => {
    expect(pickPartAtLocalPoint(ae2Parts, { x: 0.1, y: 0.1, z: 0.9 })).toBeNull()
  })

  it('无部件格 ⇒ null', () => {
    expect(pickPartAtLocalPoint(null, { x: 0.5, y: 0.5, z: 0.5 })).toBeNull()
    expect(pickPartAtLocalPoint(undefined, { x: 0.5, y: 0.5, z: 0.5 })).toBeNull()
    expect(pickPartAtLocalPoint([], { x: 0.5, y: 0.5, z: 0.5 })).toBeNull()
  })
})

describe('pickPartAtLocalPoint — 视觉盒优先 / 碰撞盒回退', () => {
  it('栅栏：y=0.5 走视觉盒；y=1.2 越界仅碰撞盒命中（回退趟）', () => {
    const parts = [fencePart]
    expect(pickPartAtLocalPoint(parts, { x: 0.5, y: 0.5, z: 0.5 })?.localId).toBe('generic:0')
    expect(pickPartAtLocalPoint(parts, { x: 0.5, y: 1.2, z: 0.5 })?.localId).toBe('generic:0')
    // 视觉盒不含 y=1.2：证明第二趟（collision）起作用
    const visual = fencePart.boxes.find((b) => b.kind === 'visual')!
    expect(pointInPartBox({ x: 0.5, y: 1.2, z: 0.5 }, visual)).toBe(false)
  })

  it('格级两趟语义：A 视觉盒命中 ⇒ B 的碰撞盒（更大）不遮挡 A', () => {
    const a = syntheticPart('a', [
      { min: [0.4, 0.4, 0.4], max: [0.6, 0.6, 0.6], kind: 'visual' },
      { min: [0.4, 0.4, 0.4], max: [0.6, 0.6, 0.6], kind: 'collision' },
    ])
    const b = syntheticPart('b', [
      // B 无视觉盒（collision-only 来源），碰撞盒罩住整格
      { min: [0, 0, 0], max: [1, 1, 1], kind: 'collision' },
    ])
    expect(pickPartAtLocalPoint([b, a], { x: 0.5, y: 0.5, z: 0.5 })?.localId).toBe('a')
  })

  it('全部部件视觉盒均无命中 ⇒ 碰撞盒趟兜底（collision-only 部件可命中）', () => {
    const b = syntheticPart('b', [{ min: [0, 0, 0], max: [1, 1, 1], kind: 'collision' }])
    expect(pickPartAtLocalPoint([b], { x: 0.5, y: 0.5, z: 0.5 })?.localId).toBe('b')
  })
})

describe('pickPartAtLocalPoint — 重叠盒规则（拍板：最小命中盒体积者胜，并列取列表序前）', () => {
  const small = syntheticPart('small', [
    { min: [0.4, 0.4, 0.4], max: [0.6, 0.6, 0.6], kind: 'visual' }, // 0.008
  ])
  const big = syntheticPart('big', [
    { min: [0, 0, 0], max: [1, 1, 1], kind: 'visual' }, // 1.0
  ])

  it('重叠时取最小盒所在部件（与列表顺序无关）', () => {
    const p = { x: 0.5, y: 0.5, z: 0.5 }
    expect(pickPartAtLocalPoint([small, big], p)?.localId).toBe('small')
    expect(pickPartAtLocalPoint([big, small], p)?.localId).toBe('small')
  })

  it('体积并列 ⇒ 部件列表序靠前者（确定性）', () => {
    const p1 = syntheticPart('p1', [{ min: [0, 0, 0], max: [1, 1, 1], kind: 'visual' }])
    const p2 = syntheticPart('p2', [{ min: [0, 0, 0], max: [1, 1, 1], kind: 'visual' }])
    expect(pickPartAtLocalPoint([p1, p2], { x: 0.5, y: 0.5, z: 0.5 })?.localId).toBe('p1')
    expect(pickPartAtLocalPoint([p2, p1], { x: 0.5, y: 0.5, z: 0.5 })?.localId).toBe('p2')
  })

  it('多盒部件：任一盒命中即中；部件得分取其最小命中盒', () => {
    const multi = syntheticPart('multi', [
      { min: [0, 0, 0], max: [1, 1, 1], kind: 'visual' }, // 大盒
      { min: [0.4, 0.4, 0.4], max: [0.6, 0.6, 0.6], kind: 'visual' }, // 小盒
    ])
    const other = syntheticPart('other', [
      { min: [0.3, 0.3, 0.3], max: [0.7, 0.7, 0.7], kind: 'visual' }, // 中等 0.064
    ])
    const p = { x: 0.5, y: 0.5, z: 0.5 }
    // multi 的最小命中盒 0.008 < other 的 0.064 ⇒ multi 胜
    expect(pickPartAtLocalPoint([other, multi], p)?.localId).toBe('multi')
    // 只命中大盒的点（0.1,0.1,0.1）：other 不含该点 ⇒ multi
    expect(pickPartAtLocalPoint([other, multi], { x: 0.1, y: 0.1, z: 0.1 })?.localId).toBe('multi')
  })
})

describe('blockLocalPointFromWorldPoint', () => {
  it('与网格世界偏移互逆：体素中心 ⇒ 局部 (0.5,0.5,0.5)', () => {
    const size = { sizeColumn: 4, sizeRow: 3, sizeZSlice: 2 }
    for (const [column, row, zSlice] of [[0, 0, 0], [3, 2, 1], [1, 0, 1]] as const) {
      const center = voxelCenterWorld(column, row, zSlice, size.sizeColumn, size.sizeRow, size.sizeZSlice)
      const local = blockLocalPointFromWorldPoint(center, { column, row, zSlice }, size)
      expect(local.x).toBeCloseTo(0.5)
      expect(local.y).toBeCloseTo(0.5)
      expect(local.z).toBeCloseTo(0.5)
    }
  })

  it('与烘焙四边形世界偏移一致（structureGeometryUVs L31–34）', () => {
    // 顶点 (0,0,0) 的世界位置 = (col - w/2, worldY - h/2, z - d/2) ⇒ 逆变换应回到 (0,0,0)
    const size = { sizeColumn: 2, sizeRow: 1, sizeZSlice: 1 }
    const local = blockLocalPointFromWorldPoint(
      { x: 0 - 1, y: 0 - 0.5, z: 0 - 0.5 },
      { column: 0, row: 0, zSlice: 0 },
      size,
    )
    expect(local).toEqual({ x: 0, y: 0, z: 0 })
  })
})
