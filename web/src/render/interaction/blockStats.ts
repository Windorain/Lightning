/**
 * 结构体素 → 按 block_registry 键计数（与 `blockRegistryKeyForPalette` 一致，非仅 registryId），供侧栏等只读展示。
 * 与 `simpleMesh` 一致：`LayerPreviewMode` 下切片外体素视为空气。
 */

import { blockRegistryKeyForPalette } from '../data/blockRegistryResolve'
import { buildVoxelVolume } from '../data/grid'
import { effectiveVoxelState, type LayerPreviewMode } from '../data/layerPreview'
import { isAirState } from '../schema/types'
import type { StructureDefinition } from '../schema/types'

/** `blockId` 与 `StructureDefinition.blocks` / `BlockIconCache` 键一致：`registryId` 或 `registryId@meta` */
export interface BlockStatRow {
  blockId: string
  count: number
}

/** 遍历体素体积，统计每种非空气方块出现次数（与 `effectiveVoxelState` 语义一致） */
export function countBlocksById(
  def: StructureDefinition,
  layerPreview: LayerPreviewMode = 'all',
): Map<string, number> {
  const volume = buildVoxelVolume(def)
  const { sizeColumn, sizeRow, sizeZSlice } = volume
  const counts = new Map<string, number>()

  for (let zSlice = 0; zSlice < sizeZSlice; zSlice++) {
    for (let row = 0; row < sizeRow; row++) {
      for (let col = 0; col < sizeColumn; col++) {
        const st = effectiveVoxelState(volume, col, row, zSlice, sizeRow, layerPreview)
        if (isAirState(st)) continue
        const id = blockRegistryKeyForPalette(st.registryId, st.meta)
        counts.set(id, (counts.get(id) ?? 0) + 1)
      }
    }
  }
  return counts
}

/**
 * 生成侧栏行：按 blockId 字典序排序，仅含 count > 0。
 */
export function buildBlockStatsEntries(
  def: StructureDefinition,
  layerPreview: LayerPreviewMode = 'all',
): BlockStatRow[] {
  const counts = countBlocksById(def, layerPreview)
  const rows: BlockStatRow[] = []
  for (const [blockId, count] of counts) {
    if (count > 0) rows.push({ blockId, count })
  }
  rows.sort((a, b) => a.blockId.localeCompare(b.blockId))
  return rows
}
