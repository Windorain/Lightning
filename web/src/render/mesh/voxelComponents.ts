/**
 * 体素 6-邻接连通域标记（纯函数）。
 * 索引：`z * (sizeRow * sizeColumn) + row * sizeColumn + col`（与 cellGrid[z][row][col] 一致）。
 */

import { buildVoxelVolume } from '../data/grid'
import { effectiveVoxelState, type LayerPreviewMode } from '../data/layerPreview'
import type { StructureDefinition } from '../schema/types'
import { isAirState } from '../schema/types'

export const AIR_COMPONENT = -1
const UNVISITED_NON_AIR = -2

export function voxelLinearIndex(
  col: number,
  row: number,
  zSlice: number,
  sizeColumn: number,
  sizeRow: number,
): number {
  return zSlice * (sizeRow * sizeColumn) + row * sizeColumn + col
}

/**
 * 对非空气体素做 6-邻接连通域标记；空气为 {@link AIR_COMPONENT}。
 */
export function labelVoxelComponents(
  def: StructureDefinition,
  layerPreview: LayerPreviewMode = 'all',
): { labels: Int32Array; componentCount: number } {
  const volume = buildVoxelVolume(def)
  const { sizeColumn, sizeRow, sizeZSlice } = volume
  const n = sizeColumn * sizeRow * sizeZSlice
  const labels = new Int32Array(n)
  for (let z = 0; z < sizeZSlice; z++) {
    for (let row = 0; row < sizeRow; row++) {
      for (let col = 0; col < sizeColumn; col++) {
        const ix = voxelLinearIndex(col, row, z, sizeColumn, sizeRow)
        const state = effectiveVoxelState(volume, col, row, z, sizeRow, layerPreview)
        labels[ix] = isAirState(state) ? AIR_COMPONENT : UNVISITED_NON_AIR
      }
    }
  }

  let compCounter = 0

  const neighbors = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ] as const

  for (let z = 0; z < sizeZSlice; z++) {
    for (let row = 0; row < sizeRow; row++) {
      for (let col = 0; col < sizeColumn; col++) {
        const ix = voxelLinearIndex(col, row, z, sizeColumn, sizeRow)
        if (labels[ix] !== UNVISITED_NON_AIR) continue

        const id = compCounter++
        const stack: number[] = [ix]
        labels[ix] = id
        while (stack.length > 0) {
          const cur = stack.pop()!
          const cz = Math.floor(cur / (sizeRow * sizeColumn))
          const rem = cur - cz * (sizeRow * sizeColumn)
          const crow = Math.floor(rem / sizeColumn)
          const ccol = rem - crow * sizeColumn

          for (const [dc, dr, dz] of neighbors) {
            const ncol = ccol + dc
            const nrow = crow + dr
            const nz = cz + dz
            if (ncol < 0 || nrow < 0 || nz < 0 || ncol >= sizeColumn || nrow >= sizeRow || nz >= sizeZSlice) {
              continue
            }
            const nix = voxelLinearIndex(ncol, nrow, nz, sizeColumn, sizeRow)
            if (labels[nix] !== UNVISITED_NON_AIR) continue
            labels[nix] = id
            stack.push(nix)
          }
        }
      }
    }
  }

  return { labels, componentCount: compCounter }
}
