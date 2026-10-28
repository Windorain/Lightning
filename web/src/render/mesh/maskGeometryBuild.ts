/**
 * render/mesh/maskGeometryBuild.ts — mask 几何装配（Three.js 侧最小适配层）。
 *
 * mask 几何有两个来源：整格/退化盒通道的 baked quads，与部件通道的 AABB 盒 union。
 * 两者都归一到「位置数组 + 索引数组」再交给 Three.js，避免两处各写一遍 BufferGeometry 组装。
 */

import * as THREE from 'three'
import type { BakedQuad, PartBox } from '@/render/schema/types'

/** 顶点位置 + 索引累加器（一个 mask mesh = 一个累加器） */
export interface MaskGeometryAccumulator {
  positions: number[]
  indices: number[]
}

export function createMaskAccumulator(): MaskGeometryAccumulator {
  return { positions: [], indices: [] }
}

/** 追加 baked quad（4 顶点 → 2 三角形，1↔2↔3 / 1↔3↔4）。不足 4 顶点的面跳过。 */
export function appendQuadToMask(acc: MaskGeometryAccumulator, quad: BakedQuad): void {
  if (quad.vertices.length < 4) return
  const start = acc.positions.length / 3
  for (const v of quad.vertices) acc.positions.push(v.x, v.y, v.z)
  acc.indices.push(start, start + 1, start + 2, start, start + 2, start + 3)
}

/** 追加轴对齐盒（局部坐标，12 三角形） */
export function appendBoxToMask(acc: MaskGeometryAccumulator, box: PartBox): void {
  const [x0, y0, z0] = box.min
  const [x1, y1, z1] = box.max
  const corners: Array<[number, number, number]> = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ]
  const faces: Array<[number, number, number, number]> = [
    [0, 1, 2, 3], [4, 5, 6, 7],
    [0, 1, 5, 4], [2, 3, 7, 6],
    [0, 3, 7, 4], [1, 2, 6, 5],
  ]
  for (const [a, b, c, d] of faces) {
    const base = acc.positions.length / 3
    for (const i of [a, b, c, d]) {
      const p = corners[i]!
      acc.positions.push(p[0], p[1], p[2])
    }
    acc.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
}

/**
 * 累加器 → mask mesh（几何为**格内局部坐标**，调用方再整体平移到格角）。
 * 空累加器 ⇒ null（调用方跳过，不产生空 mesh）。
 */
export function buildMaskMesh(
  acc: MaskGeometryAccumulator,
  corner: { x: number; y: number; z: number },
): THREE.Mesh | null {
  if (acc.indices.length === 0) return null
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(acc.positions, 3))
  geo.setIndex(acc.indices)
  geo.computeVertexNormals()
  geo.translate(corner.x, corner.y, corner.z)
  return new THREE.Mesh(geo)
}

/** 整格几何 → mesh（`SelectionHighlightProvider` 的整格通道与退化回退共用） */
export function buildQuadsMaskMesh(
  quads: readonly BakedQuad[],
  corner: { x: number; y: number; z: number },
): THREE.Mesh | null {
  const acc = createMaskAccumulator()
  for (const q of quads) appendQuadToMask(acc, q)
  return buildMaskMesh(acc, corner)
}

/** 盒 union → mesh */
export function buildBoxesMaskMesh(
  boxes: readonly PartBox[],
  corner: { x: number; y: number; z: number },
): THREE.Mesh | null {
  const acc = createMaskAccumulator()
  for (const b of boxes) appendBoxToMask(acc, b)
  return buildMaskMesh(acc, corner)
}
