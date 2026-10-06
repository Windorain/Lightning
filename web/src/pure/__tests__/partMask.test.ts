/**
 * B-1 — 部件级描边 mask 通道（issue #34）定向 + 回归断言。
 *
 * 覆盖：
 *  1. 纯决策（`pure/partMask.ts`）：格 + 部件定位 → 该部件 mask 几何；同格不同部件 ⇒ 不同几何；
 *     部件盒权威、退化盒（贴面/贴边）退化为其所辖 quads 的 AABB；
 *  2. 两个 fixture 的三条悬停路径（线缆 / 切换总线 / 存储总线）逐条断言 mask 顶点集合与部件盒一致；
 *  3. 整格通道（`partLocalId === undefined`）与 B-1 之前逐字节一致；
 *  4. 回归：满方块与单盒非满方块 —— 部件通道下 mask 顶点集合 = 整格通道的（逐项一致）；
 *  5. 既有语义不削弱：`SelectionOutlinePass` mask 接口（Mesh[]）不变、选择集 ≤ 500 保护不变。
 *
 * 反同义反复：期望值（盒坐标、顶点数、AABB）全部硬编码于本文件，不从被测实现里反读。
 */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'

import {
  resolvePartMaskGeometry,
  boxUnionForPart,
  aabbOfQuadsWithinBox,
  isDegenerateBox,
  boxUnionCentroid,
  type PartMaskGeometry,
} from '@/pure/partMask'
import type { BakedQuad, PartBox, PartRecord } from '@/render/schema/types'
import { SelectionHighlightProvider } from '@/render/mesh/selectionHighlightProvider'
import { RuntimeDocument } from '@/context/runtimeDocument'

import ae2Fixture from '../../../e2e/fixtures/parts-ae2-multibox.v2.json'
import singleboxFixture from '../../../e2e/fixtures/parts-singlebox-mix.v2.json'

type Json = Record<string, unknown>

// ---------------------------------------------------------------------------
// 手工四边面（局部坐标；与 fixture 的 baked quads 同空间）
// ---------------------------------------------------------------------------

function quad(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, n = 4): BakedQuad {
  const corners = [
    { x: x0, y: y0, z: z0 },
    { x: x1, y: y0, z: z0 },
    { x: x1, y: y1, z: z1 },
    { x: x0, y: y1, z: z1 },
  ].slice(0, n)
  return {
    materialIndex: 0,
    vertices: corners.map(c => ({ ...c, u: 0, v: 0 })),
  }
}

const box = (min: [number, number, number], max: [number, number, number], kind: 'visual' | 'collision' = 'visual'): PartBox =>
  ({ min, max, kind })

const part = (localId: string, boxes: PartBox[]): PartRecord => ({
  localId,
  typeKey: `test:${localId}`,
  boxes,
  displayName: localId,
  tooltip: [localId],
  items: [],
  source: { family: 'generic', fallback: true, boxProvenance: 'both', tier: 2 },
})

function meshPoints(mesh: THREE.Mesh): Array<[number, number, number]> {
  const pos = mesh.geometry.getAttribute('position')
  const out: Array<[number, number, number]> = []
  for (let i = 0; i < pos.count; i++) out.push([pos.getX(i), pos.getY(i), pos.getZ(i)])
  return out
}

function aabbOfPoints(points: Array<[number, number, number]>): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const p of points) {
    for (let a = 0; a < 3; a++) {
      if (p[a]! < min[a]!) min[a] = p[a]!
      if (p[a]! > max[a]!) max[a] = p[a]!
    }
  }
  return { min, max }
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000
}

function pointsKey(points: Array<[number, number, number]>): string {
  return points.map(p => p.map(round4).join(',')).sort().join('|')
}

// ---------------------------------------------------------------------------
// 1. 纯决策：格 + 部件定位 → mask 几何
// ---------------------------------------------------------------------------

describe('B-1 · resolvePartMaskGeometry（纯决策）', () => {
  const whole = [
    quad(0.375, 0.375, 0.625, 0.625, 0.625, 0.625), // 线缆 +z 端面
    quad(0.375, 0, 0.375, 0.625, 1, 0.625), // 跨多个部件盒的面
    quad(0.1875, 1, 0.1875, 0.8125, 1, 0.8125), // 存储总线顶面
  ]
  const cable = part('ae2:cable', [box([0.375, 0.375, 0.375], [0.625, 0.625, 0.625])])
  const storage = part('ae2:up', [box([0.1875, 0.9375, 0.1875], [0.8125, 1, 0.8125])])
  const parts = [cable, storage]

  it('整格通道（partLocalId 缺省）⇒ 全部 baked quads，与 B-1 之前一致', () => {
    const r = resolvePartMaskGeometry(parts, whole)
    expect(r).not.toBeNull()
    expect(r!.boxes).toBeUndefined()
    expect(r!.quads).toHaveLength(3)
    expect(r!.quads).toBe(whole) // 逐项同一引用 ⇒ 零拷贝、零改写
  })

  it('部件通道 ⇒ 该部件盒 union；不同部件 ⇒ 不同几何', () => {
    const a = resolvePartMaskGeometry(parts, whole, 'ae2:cable')!
    const b = resolvePartMaskGeometry(parts, whole, 'ae2:up')!
    expect(a.boxes).toEqual([box([0.375, 0.375, 0.375], [0.625, 0.625, 0.625])])
    expect(b.boxes).toEqual([box([0.1875, 0.9375, 0.1875], [0.8125, 1, 0.8125])])
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
  })

  it('部件无盒 ⇒ 回退整格（不产生空描边）', () => {
    const bare = part('ae2:bare', [])
    const r = resolvePartMaskGeometry([...parts, bare], whole, 'ae2:bare')!
    expect(r.boxes).toBeUndefined()
    expect(r.quads).toHaveLength(3)
  })

  it('localId 在该格不存在 ⇒ 回退整格（不劣化）', () => {
    const r = resolvePartMaskGeometry(parts, whole, 'ae2:missing')!
    expect(r.boxes).toBeUndefined()
    expect(r.quads).toHaveLength(3)
  })

  it('无部件数据 + 有部件定位 ⇒ 回退整格', () => {
    const r = resolvePartMaskGeometry(null, whole, 'ae2:cable')!
    expect(r.quads).toHaveLength(3)
  })

  it('该格无几何 ⇒ null（调用方走格中心 1×1×1 兜底）', () => {
    expect(resolvePartMaskGeometry(parts, null)).toBeNull()
    expect(resolvePartMaskGeometry(parts, [])).toBeNull()
    expect(resolvePartMaskGeometry(parts, null, 'ae2:cable')).toBeNull()
  })

  it('视觉盒优先于碰撞盒；视觉盒缺失时用碰撞盒（与 partHit 总语义一致）', () => {
    const mixed = part('t:mixed', [
      box([0.2, 0.2, 0.2], [0.8, 0.8, 0.8], 'visual'),
      box([0.1, 0.1, 0.1], [0.9, 0.9, 0.9], 'collision'),
    ])
    expect(boxUnionForPart(mixed)).toEqual([box([0.2, 0.2, 0.2], [0.8, 0.8, 0.8])])

    const collisionOnly = part('t:col', [box([0.25, 1, 0.25], [0.75, 1.5, 0.75], 'collision')])
    expect(boxUnionForPart(collisionOnly)).toEqual([box([0.25, 1, 0.25], [0.75, 1.5, 0.75], 'collision')])
  })

  it('盒越出 [0,1]³ 不裁剪（契约 §6.3：如实记录）', () => {
    const fence = part('t:fence', [box([0.375, 0, 0.375], [0.625, 1.5, 0.625])])
    expect(resolvePartMaskGeometry([fence], whole, 't:fence')!.boxes).toEqual([
      box([0.375, 0, 0.375], [0.625, 1.5, 0.625]),
    ])
  })

  it('退化盒（贴面）退化为其所辖 quads 的 AABB；无 quads 时保留退化盒', () => {
    const facePart = part('t:face', [box([0.375, 1, 0.375], [0.625, 1, 0.625])])
    expect(isDegenerateBox(facePart.boxes[0]!)).toBe(true)

    const faceQuad = quad(0.375, 1, 0.375, 0.625, 1, 0.625)
    expect(aabbOfQuadsWithinBox([faceQuad], facePart.boxes[0]!)).toEqual(
      box([0.375, 1, 0.375], [0.625, 1, 0.625]),
    )

    // 盒内无 quads ⇒ 保留退化盒本身（仍是该部件的位置）
    expect(resolvePartMaskGeometry([facePart], [quad(0, 0, 0, 1, 0, 1)], 't:face')!.boxes).toEqual([
      box([0.375, 1, 0.375], [0.625, 1, 0.625]),
    ])
  })

  it('aabbOfQuadsWithinBox 只收「全部顶点落盒内」的面（跨盒面不拉进来）', () => {
    const b = box([0, 0, 0], [0.5, 1, 1])
    expect(aabbOfQuadsWithinBox([quad(0, 0, 0, 0.5, 1, 1)], b)).toEqual(box([0, 0, 0], [0.5, 1, 1]))
    expect(aabbOfQuadsWithinBox([quad(0, 0, 0, 0.75, 1, 1)], b)).toBeNull()
  })

  it('体心随部件不同（诊断口径）', () => {
    const c1 = boxUnionCentroid(boxUnionForPart(cable))!
    const c2 = boxUnionCentroid(boxUnionForPart(storage))!
    expect(c1.y).toBeCloseTo(0.5)
    expect(c2.y).toBeGreaterThan(0.9)
  })
})

// ---------------------------------------------------------------------------
// 2. fixture 驱动的三条悬停路径（AE2 多盒格）
// ---------------------------------------------------------------------------

interface FixtureParts {
  parts: PartRecord[]
  wholeCell: BakedQuad[]
}

function ae2Cell(): FixtureParts {
  const doc = RuntimeDocument.fromV2Plain(ae2Fixture as unknown as Json)!
  const grid = doc.frame(0)!.grid!
  const parts = [...(grid.partsAt({ x: 0, y: 0, z: 0 }) ?? [])] as PartRecord[]
  const meta = grid.getPaletteCache().get('#1')!
  const wholeCell = (meta.geometry as { quads: BakedQuad[] }).quads
  return { parts, wholeCell }
}

function singleboxCells(): {
  lowerSlab: FixtureParts
  upperSlab: FixtureParts
  fence: FixtureParts
  stone: FixtureParts
} {
  const doc = RuntimeDocument.fromV2Plain(singleboxFixture as unknown as Json)!
  const grid = doc.frame(0)!.grid!
  const at = (x: number, paletteIndex: number): FixtureParts => ({
    parts: [...(grid.partsAt({ x, y: 0, z: 0 }) ?? [])] as PartRecord[],
    wholeCell: (grid.getPaletteCache().get(`#${paletteIndex}`)!.geometry as { quads: BakedQuad[] }).quads,
  })
  return {
    lowerSlab: at(0, 1),
    upperSlab: at(2, 2),
    fence: at(4, 4),
    stone: at(3, 3),
  }
}

describe('B-1 · AE2 同格三部件：mask 顶点集合不同且贴合各自部件盒', () => {
  const { parts, wholeCell } = ae2Cell()

  it('fixture 前置：三部件 + 四边面整体几何（线缆 3 面 + 存储总线顶面）', () => {
    expect(parts.map(p => p.localId)).toEqual(['ae2:UNKNOWN', 'ae2:NORTH', 'ae2:UP'])
    expect(wholeCell).toHaveLength(4)
  })

  it('整格通道 = 4 面（修复前的整格并集，根因点）', () => {
    const r = resolvePartMaskGeometry(parts, wholeCell)! as PartMaskGeometry
    expect(r.quads).toHaveLength(4)
    const wholeAabb = aabbOfPoints(r.quads!.flatMap(q => q.vertices.map(v => [v.x, v.y, v.z] as [number, number, number])))
    // 整格并集：x [0.1875, 0.8125]（存储总线顶面）、y [0.375, 1]、z [0.1875, 0.8125]
    expect(wholeAabb.min.map(round4)).toEqual([0.1875, 0.375, 0.1875])
    expect(wholeAabb.max.map(round4)).toEqual([0.8125, 1, 0.8125])
  })

  it('线缆（ae2:UNKNOWN）：盒 union = 三个视觉子盒；不再包含存储总线顶面（y=1）', () => {
    const r = resolvePartMaskGeometry(parts, wholeCell, 'ae2:UNKNOWN')!
    expect(r.boxes).toEqual([
      box([0.375, 0.375, 0.375], [0.625, 0.625, 0.625]),
      box([0.375, 0.625, 0.375], [0.625, 0.75, 0.625]),
      box([0.375, 0.375, 0.3125], [0.625, 0.625, 0.375]),
    ])
    const boxAabb = aabbOfPoints(r.boxes!.flatMap(b => [
      [b.min[0], b.min[1], b.min[2]], [b.max[0], b.max[1], b.max[2]],
    ] as Array<[number, number, number]>))
    expect(boxAabb.min.map(round4)).toEqual([0.375, 0.375, 0.3125])
    expect(boxAabb.max.map(round4)).toEqual([0.625, 0.75, 0.625])
    expect(boxAabb.max[1]).toBeLessThan(1) // 存储总线顶面（y=1）不在线缆 mask 内
  })

  it('NORTH 切换总线（ae2:NORTH）：单盒，z 收到 [0, 0.3125]', () => {
    const r = resolvePartMaskGeometry(parts, wholeCell, 'ae2:NORTH')!
    expect(r.boxes).toEqual([box([0.375, 0.375, 0], [0.625, 0.625, 0.3125])])
  })

  it('UP 存储总线（ae2:UP）：三个视觉子盒（顶面板 + 中段 + 颈）', () => {
    const r = resolvePartMaskGeometry(parts, wholeCell, 'ae2:UP')!
    expect(r.boxes).toEqual([
      box([0.1875, 0.9375, 0.1875], [0.8125, 1, 0.8125]),
      box([0.125, 0.875, 0.125], [0.875, 0.9375, 0.875]),
      box([0.3125, 0.75, 0.3125], [0.6875, 0.875, 0.6875]),
    ])
  })

  it('三部件两两不同（定向断言：同格不同部件 ⇒ mask 几何不同）', () => {
    const ids = ['ae2:UNKNOWN', 'ae2:NORTH', 'ae2:UP']
    const keys = ids.map(id => JSON.stringify(resolvePartMaskGeometry(parts, wholeCell, id)))
    expect(new Set(keys).size).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// 3. provider（Three.js 层）：顶点集合、部件与整格的差异、回归一致
// ---------------------------------------------------------------------------

function entity(pos: { x: number; y: number; z: number }, partLocalId?: string) {
  return {
    kind: 'block' as const,
    ref: { pos, block_state_id: 'test:block', partLocalId },
  }
}

function buildMeshes(
  pos: { x: number; y: number; z: number },
  partLocalId: string | undefined,
  data: FixtureParts,
): THREE.Mesh[] {
  const provider = new SelectionHighlightProvider()
  return provider.build(
    new Set([entity(pos, partLocalId)]),
    () => data.wholeCell,
    () => ({ x: 0, y: 0, z: 0 }),
    ref => resolvePartMaskGeometry(data.parts, data.wholeCell, ref.partLocalId),
  )
}

describe('B-1 · SelectionHighlightProvider：部件通道 vs 整格通道', () => {
  const { parts, wholeCell } = ae2Cell()

  it('整格通道产出一个 mesh，顶点数 = 4 面 × 4 顶点', () => {
    const meshes = buildMeshes({ x: 0, y: 0, z: 0 }, undefined, { parts, wholeCell })
    expect(meshes).toHaveLength(1)
    expect(meshPoints(meshes[0]!)).toHaveLength(16)
  })

  it('部件通道：线缆/切换总线/存储总线顶点集合两两不同，且贴合各自盒', () => {
    const cable = buildMeshes({ x: 0, y: 0, z: 0 }, 'ae2:UNKNOWN', { parts, wholeCell })
    const toggle = buildMeshes({ x: 0, y: 0, z: 0 }, 'ae2:NORTH', { parts, wholeCell })
    const storage = buildMeshes({ x: 0, y: 0, z: 0 }, 'ae2:UP', { parts, wholeCell })

    expect(cable).toHaveLength(1)
    expect(toggle).toHaveLength(1)
    expect(storage).toHaveLength(1)

    const kc = pointsKey(meshPoints(cable[0]!))
    const kt = pointsKey(meshPoints(toggle[0]!))
    const ks = pointsKey(meshPoints(storage[0]!))
    expect(new Set([kc, kt, ks]).size).toBe(3)

    // 盒几何 = 12 三角形 → 36 顶点位：线缆 3 盒 / 切换总线 1 盒 / 存储总线 3 盒
    expect(meshPoints(cable[0]!)).toHaveLength(72)
    expect(meshPoints(toggle[0]!)).toHaveLength(24)
    expect(meshPoints(storage[0]!)).toHaveLength(72)

    // 贴合：中心在 (0,0,0) ⇒ 世界坐标 = 格内局部 - 0.5；线缆 mask ⊂ 其视觉盒 union
    // （局部 x [0.375,0.625] / y [0.375,0.75] / z [0.3125,0.625]），且不含存储总线顶面（局部 y=1）
    const aabb = aabbOfPoints(meshPoints(cable[0]!))
    expect(aabb.min.map(v => round4(v + 0.5))).toEqual([0.375, 0.375, 0.3125])
    expect(aabb.max.map(v => round4(v + 0.5))).toEqual([0.625, 0.75, 0.625])
    expect(aabbOfPoints(meshPoints(storage[0]!)).max.map(v => round4(v + 0.5))).toEqual([0.875, 1, 0.875])
    expect(aabbOfPoints(meshPoints(toggle[0]!)).min.map(v => round4(v + 0.5))).toEqual([0.375, 0.375, 0])
  })

  it('部件定位缺失/未知 ⇒ 与整格通道逐字节一致（不劣化）', () => {
    const whole = buildMeshes({ x: 0, y: 0, z: 0 }, undefined, { parts, wholeCell })
    const missing = buildMeshes({ x: 0, y: 0, z: 0 }, 'ae2:missing', { parts, wholeCell })
    expect(pointsKey(meshPoints(missing[0]!))).toBe(pointsKey(meshPoints(whole[0]!)))
  })

  it('无部件数据文档（整格引用）⇒ 与 B-1 之前一致：全部 quads → 一个 mesh', () => {
    const wholeOnly: FixtureParts = { parts: [], wholeCell }
    const meshes = buildMeshes({ x: 0, y: 0, z: 0 }, undefined, wholeOnly)
    expect(meshes).toHaveLength(1)
    expect(meshPoints(meshes[0]!)).toHaveLength(16)
  })

  it('无几何 ⇒ 格中心 1×1×1 盒兜底（既有行为）', () => {
    const provider = new SelectionHighlightProvider()
    const meshes = provider.build(
      new Set([entity({ x: 1, y: 0, z: 2 })]),
      () => null,
      () => ({ x: 10, y: 20, z: 30 }),
      ref => resolvePartMaskGeometry([], null, ref.partLocalId),
    )
    expect(meshes).toHaveLength(1)
    const aabb = aabbOfPoints(meshPoints(meshes[0]!))
    expect(aabb.min).toEqual([9.5, 19.5, 29.5])
    expect(aabb.max).toEqual([10.5, 20.5, 30.5])
  })

  it('既有保护语义不削弱：选择集 > 500 ⇒ 空 mask（不做任何几何查询）', () => {
    const provider = new SelectionHighlightProvider()
    let queried = 0
    const many = new Set(Array.from({ length: 501 }, (_, i) => entity({ x: i, y: 0, z: 0 })))
    const meshes = provider.build(
      many,
      () => { queried++; return wholeCell },
      () => { queried++; return { x: 0, y: 0, z: 0 } },
      () => { queried++; return null },
    )
    expect(meshes).toEqual([])
    expect(queried).toBe(0)
  })

  it('边界：恰好 500 ⇒ 仍产出 mask（保护阈值语义不变）', () => {
    const provider = new SelectionHighlightProvider()
    const many = new Set(Array.from({ length: 500 }, (_, i) => entity({ x: i, y: 0, z: 0 })))
    const meshes = provider.build(many, () => wholeCell, () => ({ x: 0, y: 0, z: 0 }))
    expect(meshes).toHaveLength(500)
  })

  it('mask 接口语义不变：返回 THREE.Mesh[]，几何为普通 BufferGeometry（可由 OutlinePass 接管）', () => {
    const meshes = buildMeshes({ x: 0, y: 0, z: 0 }, 'ae2:NORTH', { parts, wholeCell })
    expect(meshes[0]).toBeInstanceOf(THREE.Mesh)
    expect(meshes[0]!.geometry.getAttribute('position').count).toBe(24)
    expect(meshes[0]!.geometry.getIndex()!.count).toBe(36)
    // 未预设材质 ⇒ 由 SelectionOutlinePass 统一赋白模（其语义未改）
    expect(meshes[0]!.material).toBeInstanceOf(THREE.MeshBasicMaterial)
  })

  it('格角平移：局部坐标 + (center - 0.5)（与 baked quads 世界偏移同一空间）', () => {
    const provider = new SelectionHighlightProvider()
    const entities = new Set([entity({ x: 3, y: 7, z: 5 }, 'ae2:NORTH')])
    const meshes = provider.build(
      entities,
      () => wholeCell,
      () => ({ x: 100, y: 200, z: 300 }),
      ref => resolvePartMaskGeometry(parts, wholeCell, ref.partLocalId),
    )
    // 切换总线盒局部 x/y [0.375,0.625]、z [0,0.3125] ⇒ 世界 x/y [99.875,100.125]、
    // y [199.875,200.125]、z [299.5,299.8125]
    const aabb = aabbOfPoints(meshPoints(meshes[0]!))
    expect(aabb.min.map(round4)).toEqual([99.875, 199.875, 299.5])
    expect(aabb.max.map(round4)).toEqual([100.125, 200.125, 299.8125])
  })
})

// ---------------------------------------------------------------------------
// 4. 回归：满方块 / 单盒非满方块 —— 部件通道与整格通道逐项一致
// ---------------------------------------------------------------------------

describe('B-1 · 回归断言（满方块 + 单盒非满方块）', () => {
  const cells = singleboxCells()

  it('fixture 前置：四格单盒部件 + 一格满方块（无部件）', () => {
    expect(cells.lowerSlab.parts.map(p => p.localId)).toEqual(['generic:0'])
    expect(cells.upperSlab.parts.map(p => p.localId)).toEqual(['generic:0'])
    expect(cells.fence.parts.map(p => p.localId)).toEqual(['generic:0'])
    expect(cells.stone.parts).toEqual([])
  })

  it('满方块（无部件格）：整格通道 = 部件通道回退，顶点集合完全相同', () => {
    const stone = cells.stone
    const quads = resolvePartMaskGeometry(stone.parts, stone.wholeCell)!
    expect(quads.boxes).toBeUndefined()
    const meshes = buildMeshes({ x: 3, y: 0, z: 0 }, undefined, stone)
    // 石头 fixture 几何为两块单面（+z 面 / +y 顶面）——与 B-1 之前逐字节一致
    expect(meshPoints(meshes[0]!)).toHaveLength(8)
  })

  it('AE2 满方块对照格（palette 2 = 石头）：整格通道与修复前一致', () => {
    const doc = RuntimeDocument.fromV2Plain(ae2Fixture as unknown as Json)!
    const grid = doc.frame(0)!.grid!
    const stoneQuads = (grid.getPaletteCache().get('#2')!.geometry as { quads: BakedQuad[] }).quads
    const r = resolvePartMaskGeometry(null, stoneQuads)!
    expect(r.quads).toHaveLength(2)
    expect(r.quads).toBe(stoneQuads)
  })

  it('单盒非满方块（下半 slab / 上半 slab / 栅栏）：部件通道 = 整格通道的包围盒（逐项一致）', () => {
    for (const [name, cell] of [
      ['lowerSlab', cells.lowerSlab],
      ['upperSlab', cells.upperSlab],
      ['fence', cells.fence],
    ] as const) {
      const whole = resolvePartMaskGeometry(cell.parts, cell.wholeCell)!
      const partGeom = resolvePartMaskGeometry(cell.parts, cell.wholeCell, 'generic:0')!

      // 1) 整格四边面全部落于该部件盒内（该格只有一个部件 ⇒ 盒是几何的权威子集）
      const boxes = boxUnionForPart(cell.parts[0]!)
      for (const q of whole.quads!) {
        const inside = boxes.some(b => {
          const a = aabbOfQuadsWithinBox([q], b)
          return a !== null
        })
        expect(inside, `${name}: 四边面须落于部件盒内`).toBe(true)
      }

      // 2) 部件盒是整格几何的紧/等包围盒（正交视角投影轮廓一致 ⇒ 描边不回归）
      const qp = whole.quads!.flatMap(q => q.vertices.map(v => [v.x, v.y, v.z] as [number, number, number]))
      const quadAabb = aabbOfPoints(qp)
      const boxAabb = aabbOfPoints(boxes.flatMap(b => [
        [b.min[0], b.min[1], b.min[2]], [b.max[0], b.max[1], b.max[2]],
      ] as Array<[number, number, number]>))
      for (let a = 0; a < 3; a++) {
        expect(round4(boxAabb.min[a]!), `${name}: 盒 min[${a}] 与几何一致`).toBe(round4(quadAabb.min[a]!))
        expect(round4(boxAabb.max[a]!), `${name}: 盒 max[${a}] 与几何一致`).toBe(round4(quadAabb.max[a]!))
      }

      // 3) 两条通道都能产出 mesh（不出现空描边）
      expect(buildMeshes({ x: 0, y: 0, z: 0 }, undefined, cell)).toHaveLength(1)
      expect(buildMeshes({ x: 0, y: 0, z: 0 }, 'generic:0', cell)).toHaveLength(1)

      // 4) 盒 channel 落到 boxes 分支、整格落到 quads 分支（通道选择的直接证据）
      expect(partGeom.boxes).toHaveLength(1)
      expect(whole.boxes).toBeUndefined()
    }
  })

  it('满方块部件（盒 = [0,1]³）与整格 20 面几何一致：部件通道产出的 8 角 = 单位立方体角', () => {
    const cube = [
      box([0, 0, 0], [1, 0, 1]), box([0, 1, 0], [1, 1, 1]),
      box([0, 0, 0], [0, 0, 1]), box([1, 0, 0], [1, 1, 1]),
      box([0, 0, 0], [1, 0, 0]), box([0, 1, 0], [1, 1, 0]),
    ]
    const fullPart = part('generic:full', cube)
    const quads = cube.map(b => quad(b.min[0] === b.max[0] ? b.min[0] : b.min[0], b.min[1], b.min[2], b.max[0], b.max[1], b.max[2]))
    const r = resolvePartMaskGeometry([fullPart], quads, 'generic:full')!
    expect(r.boxes).toEqual(cube)
    const meshes = buildMeshes({ x: 0, y: 0, z: 0 }, 'generic:full', { parts: [fullPart], wholeCell: quads })
    const aabb = aabbOfPoints(meshPoints(meshes[0]!))
    expect(aabb.min).toEqual([-0.5, -0.5, -0.5])
    expect(aabb.max).toEqual([0.5, 0.5, 0.5])
  })
})
