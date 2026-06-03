/**
 * 纯函数：由格点、当帧体素体与 tooltipPalette 解析悬停文本。
 * 无 Vue / Three.js / DOM 依赖。
 */

import { TOOLTIP_GRID_NONE, type StructureDefinition } from '@/render/schema/types'

// ---- 纯类型定义（无框架依赖） ----

export type TooltipHoverSource = 'viewport' | 'sidebar'

export interface VoxelWithTooltip {
  column: number
  row: number
  zSlice: number
}

export interface PreviewTooltipHover {
  blockId: string
  clientX: number
  clientY: number
  source: TooltipHoverSource
  /** viewport 悬停时提供，与 `cellGrid[z][r][c]` 一致；侧栏不填，不显示 ToolTip */
  voxel?: VoxelWithTooltip
}

// ---- 纯函数 ----

/**
 * 由格点、当帧体素体与 `tooltipPalette` 得悬停文本；无有效映射或空文案则 `''`（不读 blockPalette / registryId）。
 */
export function resolvePreviewTooltipText(
  def: StructureDefinition,
  tooltipPalette: readonly string[],
  h: PreviewTooltipHover | null,
): string {
  if (!h) return ''
  if (h.source === 'sidebar') return ''
  const voxel = h.voxel
  if (!voxel) return ''
  if (tooltipPalette.length === 0) return ''

  const g = def.cellTooltipGrid
  if (g == null) return ''

  const { zSlice, row, column } = voxel
  const cell = g[zSlice]?.[row]?.[column]
  if (cell === undefined || cell === null) return ''
  if (typeof cell !== 'number' || !Number.isFinite(cell)) return ''
  if (cell < 0 || cell === TOOLTIP_GRID_NONE) return ''
  return tooltipPalette[cell] ?? ''
}
