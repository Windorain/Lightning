import * as THREE from 'three'
import { blockRegistryKeyForPalette } from '@/render/data/blockRegistryResolve'
import { structureRowToWorldY } from '@/pure/vec'
import type { BakedQuad, StructureDefinition } from '@/render/schema/types'

function buildBlockMaskMesh(quads: BakedQuad[], cx: number, cy: number, cz: number): THREE.Mesh | null {
  const corner = { x: cx - 0.5, y: cy - 0.5, z: cz - 0.5 }
  const verts: number[] = []
  const indices: number[] = []
  let vi = 0
  for (const q of quads) {
    if (q.vertices.length < 4) continue
    const v0 = vi, v1 = vi + 1, v2 = vi + 2, v3 = vi + 3
    indices.push(v0, v1, v2, v0, v2, v3)
    for (const v of q.vertices) {
      verts.push(v.x + corner.x, v.y + corner.y, v.z + corner.z)
    }
    vi += 4
  }
  if (verts.length === 0) return null
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  return new THREE.Mesh(geo)
}

/** 结构内所有匹配 registryId 的体素 → outline 遮罩 mesh（渲染层，可读 cellGrid） */
export function buildOutlineMasksForRegistryId(
  def: StructureDefinition,
  registryId: string,
): THREE.Mesh[] {
  const { cellGrid, blockPalette } = def
  const sizeZ = cellGrid.length
  const sizeRow = cellGrid[0]?.length ?? 0
  const sizeCol = cellGrid[0]?.[0]?.length ?? 0
  if (sizeZ === 0 || sizeRow === 0 || sizeCol === 0) return []

  const masks: THREE.Mesh[] = []
  for (let z = 0; z < sizeZ; z++) {
    for (let row = 0; row < sizeRow; row++) {
      const sliceRow = cellGrid[z]?.[row]
      if (!sliceRow) continue
      for (let col = 0; col < sizeCol; col++) {
        const idx = sliceRow[col]
        if (idx === undefined || idx < 0) continue
        const entry = blockPalette[idx]
        if (!entry || blockRegistryKeyForPalette(entry.registryId, entry.meta) !== registryId) continue
        const voxelY = structureRowToWorldY(row, sizeRow)
        const cx = col - sizeCol / 2 + 0.5
        const cy = voxelY - sizeRow / 2 + 0.5
        const cz = z - sizeZ / 2 + 0.5
        const quads = entry.geometry?.quads
        if (quads?.length && quads.some(q => q.vertices.length >= 4)) {
          const mesh = buildBlockMaskMesh(quads, cx, cy, cz)
          if (mesh) masks.push(mesh)
        } else {
          const geo = new THREE.BoxGeometry(1, 1, 1)
          geo.translate(cx, cy, cz)
          masks.push(new THREE.Mesh(geo))
        }
      }
    }
  }
  return masks
}

export function disposeOutlineMaskMeshes(meshes: THREE.Mesh[]): void {
  for (const m of meshes) {
    m.geometry?.dispose()
    ;(m.material as THREE.Material)?.dispose()
  }
}
