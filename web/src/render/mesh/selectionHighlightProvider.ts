// web/src/render/mesh/selectionHighlightProvider.ts
import * as THREE from 'three'
import type { SelectedEntity } from '@/workbench/selectionContext'
import type { BakedQuad } from '../schema/types'

export class SelectionHighlightProvider {
  build(
    entities: Set<SelectedEntity>,
    getBlockGeometry: (pos: { x: number; y: number; z: number }) => BakedQuad[] | null,
    gridCenterWorld: (pos: { x: number; y: number; z: number }) => { x: number; y: number; z: number } | null,
  ): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = []

    if (entities.size === 0 || entities.size > 500) return meshes

    for (const entity of entities) {
      if (entity.kind !== 'block') continue

      const center = gridCenterWorld(entity.ref.pos)
      if (!center) continue

      const quads = getBlockGeometry(entity.ref.pos)
      const hasValidQuads = quads && quads.length > 0 && quads.some(q => q.vertices.length >= 4)

      if (!hasValidQuads) {
        const geo = new THREE.BoxGeometry(1, 1, 1)
        geo.translate(center.x, center.y, center.z)
        meshes.push(new THREE.Mesh(geo))
        continue
      }

      const verts: number[] = []
      const indices: number[] = []
      const corner = { x: center.x - 0.5, y: center.y - 0.5, z: center.z - 0.5 }
      let vi = 0

      for (const q of quads!) {
        if (q.vertices.length < 4) continue
        const v0 = vi, v1 = vi + 1, v2 = vi + 2, v3 = vi + 3
        indices.push(v0, v1, v2, v0, v2, v3)
        for (const v of q.vertices) {
          verts.push(v.x + corner.x, v.y + corner.y, v.z + corner.z)
        }
        vi += 4
      }

      if (verts.length === 0) continue

      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
      geo.setIndex(indices)
      geo.computeVertexNormals()

      meshes.push(new THREE.Mesh(geo))
    }

    return meshes
  }

  dispose(): void {
    // Caller owns the returned meshes
  }
}
