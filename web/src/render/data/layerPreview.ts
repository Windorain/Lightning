/**
 * 分层预览：在 VoxelVolume 读路径上投影，非当前 Y 层视为空气（与 simpleMesh / 拾取 / 统计一致）。
 * 世界 Y 与结构行 row 的关系见 `grid.structureRowToWorldY`。
 */

import type { VoxelState, VoxelVolume } from '../schema/types'
import { AIR_VOXEL } from '../schema/types'
import { blockRegistryKeyForPalette } from './blockRegistryResolve'
import { structureRowToWorldY } from './grid'

export type LayerPreviewMode = 'all' | { worldY: number }

/**
 * 分层模式下，仅当 `structureRowToWorldY(row, sizeRow) === mode.worldY` 时返回真实体素；
 * 否则返回空气态。
 */
export function effectiveVoxelState(
  volume: VoxelVolume,
  column: number,
  row: number,
  zSlice: number,
  sizeRow: number,
  mode: LayerPreviewMode,
): VoxelState {
  if (mode === 'all') {
    return volume.get(column, row, zSlice)
  }
  const wy = structureRowToWorldY(row, sizeRow)
  if (wy !== mode.worldY) return AIR_VOXEL
  return volume.get(column, row, zSlice)
}

/**
 * 与 `effectiveVoxelState` 等价，返回 **block_registry 键**（`registryId` 或 `registryId@meta`），与拾取/tooltip/侧栏一致。
 */
export function effectiveBlockId(
  volume: VoxelVolume,
  column: number,
  row: number,
  zSlice: number,
  sizeRow: number,
  mode: LayerPreviewMode,
): string {
  const st = effectiveVoxelState(volume, column, row, zSlice, sizeRow, mode)
  return blockRegistryKeyForPalette(st.registryId, st.meta)
}
