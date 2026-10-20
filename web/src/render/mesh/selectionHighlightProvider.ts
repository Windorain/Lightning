// web/src/render/mesh/selectionHighlightProvider.ts
import * as THREE from 'three'
import type { BlockRef, SelectedEntity } from '../schema/types'
import type { PartMaskGeometry } from '@/pure/partMask'
import { OUTLINE_MASK_LIMIT } from '@/presentation/outlineBudget'
import { buildBoxesMaskMesh, buildQuadsMaskMesh } from './maskGeometryBuild'

/**
 * mask 几何源（B-1 通道入口）：给定格引用，产出该格**该部件**的 mask 几何决策。
 *
 * 返回值语义：
 *  - `null` ⇒ 该格无几何（与既有实现一致：退化为格中心 1×1×1 盒）；
 *  - `{ quads }` ⇒ 整格/退回几何（既有行为，无部件格与既有调用方不变）；
 *  - `{ boxes }` ⇒ 部件通道（部件盒 union）。
 *
 * 实现方由 `context/queries.ts#getPartMaskGeometry` 提供：它同时是
 * hover 描边（B-1）与点选高亮（B-5）的唯一入口 —— 两者只差传入的 `partLocalId`。
 */
export type MaskGeometrySource = (ref: BlockRef) => PartMaskGeometry | null

/** 格 + 部件 → 该部件 mask 几何（缺省实现：整格几何，忽略部件身份） */
export function wholeCellMaskGeometry(quads: import('../schema/types').BakedQuad[] | null | undefined): PartMaskGeometry | null {
  if (!quads || quads.length === 0) return null
  return { quads }
}

export class SelectionHighlightProvider {
  build(
    entities: Set<SelectedEntity>,
    getBlockGeometry: (pos: { x: number; y: number; z: number }) => import('../schema/types').BakedQuad[] | null,
    gridCenterWorld: (pos: { x: number; y: number; z: number }) => { x: number; y: number; z: number } | null,
    /** B-1：部件级 mask 几何源；缺省 ⇒ 整格几何（既有行为） */
    getPartMaskGeometry?: MaskGeometrySource,
  ): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = []

    if (entities.size === 0 || entities.size > OUTLINE_MASK_LIMIT) return meshes

    for (const entity of entities) {
      if (entity.kind !== 'block') continue

      const center = gridCenterWorld(entity.ref.pos)
      if (!center) continue

      const fallbackQuads = getBlockGeometry(entity.ref.pos)
      const resolved = getPartMaskGeometry
        ? (getPartMaskGeometry(entity.ref) ?? wholeCellMaskGeometry(fallbackQuads))
        : wholeCellMaskGeometry(fallbackQuads)


      const hasValidQuads = fallbackQuads && fallbackQuads.length > 0 && fallbackQuads.some(q => q.vertices.length >= 4)

      if (!resolved) {
        const geo = new THREE.BoxGeometry(1, 1, 1)
        geo.translate(center.x, center.y, center.z)
        meshes.push(new THREE.Mesh(geo))
        continue
      }

      // 格角 = 格中心 - 0.5（与 baked quads 的格内局部坐标同一空间）
      const corner = { x: center.x - 0.5, y: center.y - 0.5, z: center.z - 0.5 }

      if (resolved.boxes && resolved.boxes.length > 0) {
        const mesh = buildBoxesMaskMesh(resolved.boxes, corner)
        if (mesh) meshes.push(mesh)
        continue
      }

      if (!hasValidQuads) {
        // 整格几何不可用且部件通道无盒 ⇒ 退回格中心 1×1×1 盒（B-1 之前的兜底行为）
        const geo = new THREE.BoxGeometry(1, 1, 1)
        geo.translate(center.x, center.y, center.z)
        meshes.push(new THREE.Mesh(geo))
        continue
      }

      const mesh = buildQuadsMaskMesh(resolved.quads ?? [], corner)
      if (mesh) meshes.push(mesh)
    }

    return meshes
  }

  dispose(): void {
    // Caller owns the returned meshes
  }
}
