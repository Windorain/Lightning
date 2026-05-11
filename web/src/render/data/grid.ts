/**
 * 体素层（无 Three）：StructureDefinition → VoxelVolume。
 * `def.cellGrid[zSlice][row][column]`；row 0 = 结构顶（最高 Y）；世界 Y 见 `structureRowToWorldY`。
 */

import type { StructureDefinition, VoxelState, VoxelVolume } from '../schema/types'
import { AIR_VOXEL, voxelStateFromBlockPaletteEntry } from '../schema/types'

export interface VoxelCell {
  column: number
  row: number
  zSlice: number
}

export function findFirstVoxelWithBlockId(volume: VoxelVolume, registryId: string): VoxelCell | null {
  const { sizeColumn, sizeRow, sizeZSlice } = volume
  for (let z = 0; z < sizeZSlice; z++) {
    for (let row = 0; row < sizeRow; row++) {
      for (let col = 0; col < sizeColumn; col++) {
        const v = volume.get(col, row, z)
        if (v.registryId === registryId) return { column: col, row, zSlice: z }
      }
    }
  }
  return null
}

export function buildVoxelVolume(def: StructureDefinition): VoxelVolume {
  const { cellGrid, blockPalette } = def
  const sizeZSlice = cellGrid.length
  const sizeRow = cellGrid[0]?.length ?? 0
  const sizeColumn = cellGrid[0]?.[0]?.length ?? 0

  return {
    sizeColumn,
    sizeRow,
    sizeZSlice,
    get(column: number, row: number, zSlice: number): VoxelState {
      if (column < 0 || row < 0 || zSlice < 0 || column >= sizeColumn || row >= sizeRow || zSlice >= sizeZSlice) {
        return AIR_VOXEL
      }
      const idx = cellGrid[zSlice]?.[row]?.[column]
      if (idx === undefined || idx < 0 || idx >= blockPalette.length) return AIR_VOXEL
      return voxelStateFromBlockPaletteEntry(blockPalette[idx])
    },
  }
}

export function structureRowToWorldY(row: number, sizeRow: number): number {
  return sizeRow - 1 - row
}
