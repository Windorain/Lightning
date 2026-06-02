/**
 * useEmbedSelectionMasks — 嵌入视口的选区遮罩几何体构建。
 *
 * - buildBlockMaskMesh: 根据 BakedQuad 构建单个方块的遮罩 Mesh
 * - rebuildSelectionMasks: 遍历整个 cellGrid，为指定 blockId 重建所有遮罩
 * - flushHighlight: 合并选区遮罩 + 悬浮高亮，推入 outlinePass
 */
import { computed, type Ref, type ShallowRef } from 'vue'
import * as THREE from 'three'
import { blockRegistryKeyForPalette } from '@/render/data/blockRegistryResolve'
import { structureRowToWorldY } from '@/pure/vec'
import type { BakedQuad, StructureDefinition } from '@/render/schema/types'
import type { EmbedHover } from '@/embed/embedHover'
import type { SelectionOutlinePass } from '@/render/postprocessing/SelectionOutlinePass'

export function useEmbedSelectionMasks(deps: {
  definitionRef: ShallowRef<StructureDefinition | null>
  hoverRef: Ref<EmbedHover | null>
  highlightOnHoverRef: Ref<boolean>
  outlinePass: SelectionOutlinePass
}) {
  const hoveredVoxel = computed(() => {
    const h = deps.hoverRef.value
    if (!deps.highlightOnHoverRef.value) return null
    if (h?.kind === 'block' && h.source === 'viewport') return h.voxel
    return null
  })

  function buildBlockMaskMesh(
    quads: BakedQuad[],
    cx: number, cy: number, cz: number,
  ): THREE.Mesh | null {
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
    return new THREE.Mesh(geo)
  }

  let _selectionMasks: THREE.Mesh[] = []

  function rebuildSelectionMasks(blockId: string | null): void {
    _selectionMasks = []
    if (!blockId) return

    const def = deps.definitionRef.value
    if (!def) return

    const { cellGrid, blockPalette } = def
    const sizeZ = cellGrid.length
    const sizeRow = cellGrid[0]?.length ?? 0
    const sizeCol = cellGrid[0]?.[0]?.length ?? 0
    if (sizeZ === 0 || sizeRow === 0 || sizeCol === 0) return

    for (let z = 0; z < sizeZ; z++) {
      for (let row = 0; row < sizeRow; row++) {
        const sliceRow = cellGrid[z]?.[row]
        if (!sliceRow) continue
        for (let col = 0; col < sizeCol; col++) {
          const idx = sliceRow[col]
          if (idx === undefined || idx < 0) continue
          const entry = blockPalette[idx]
          if (!entry) continue
          if (blockRegistryKeyForPalette(entry.registryId, entry.meta) !== blockId) continue

          const voxelY = structureRowToWorldY(row, sizeRow)
          const cx = col - sizeCol / 2 + 0.5
          const cy = voxelY - sizeRow / 2 + 0.5
          const cz = z - sizeZ / 2 + 0.5

          const quads = entry.geometry?.quads
          if (quads && quads.length > 0 && quads.some(q => q.vertices.length >= 4)) {
            const mesh = buildBlockMaskMesh(quads, cx, cy, cz)
            if (mesh) _selectionMasks.push(mesh)
          } else {
            const geo = new THREE.BoxGeometry(1, 1, 1)
            geo.translate(cx, cy, cz)
            _selectionMasks.push(new THREE.Mesh(geo))
          }
        }
      }
    }
  }

  function flushHighlight(): void {
    const masks = [..._selectionMasks]

    const hov = hoveredVoxel.value
    if (hov && deps.highlightOnHoverRef.value) {
      const def = deps.definitionRef.value
      if (def) {
        const { cellGrid, blockPalette } = def
        const sizeZ = cellGrid.length
        const sizeRow = cellGrid[0]?.length ?? 0
        const sizeCol = cellGrid[0]?.[0]?.length ?? 0
        const idx = cellGrid[hov.zSlice]?.[hov.row]?.[hov.column]
        if (idx !== undefined && idx >= 0 && idx < blockPalette.length) {
          const entry = blockPalette[idx]
          if (entry) {
            const cx = hov.column - sizeCol / 2 + 0.5
            const cy = (sizeRow - 1 - hov.row) - sizeRow / 2 + 0.5
            const cz = hov.zSlice - sizeZ / 2 + 0.5

            const quads = entry.geometry?.quads
            if (quads && quads.length > 0 && quads.some(q => q.vertices.length >= 4)) {
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
    }

    deps.outlinePass.setMaskMeshes(masks)
  }

  return { rebuildSelectionMasks, flushHighlight }
}
