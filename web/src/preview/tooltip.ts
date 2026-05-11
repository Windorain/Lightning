/**
 * 悬停气泡：Vue 状态 + 由 `cellTooltipGrid` 与 `tooltipPalette` 解析的说明文案（无 `registryId` 回退）。
 */

import { ref, type Ref } from 'vue'

import { TOOLTIP_GRID_NONE, type StructureDefinition } from '@/render/schema/types'

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

function voxelsEqual(
  a: VoxelWithTooltip | undefined,
  b: VoxelWithTooltip | undefined,
): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  return a.column === b.column && a.row === b.row && a.zSlice === b.zSlice
}

export interface UsePreviewTooltip {
  hover: Ref<PreviewTooltipHover | null>
  setHover: (payload: PreviewTooltipHover) => void
  clearHover: (source?: TooltipHoverSource) => void
}

export function usePreviewTooltip(): UsePreviewTooltip {
  const hover = ref<PreviewTooltipHover | null>(null)

  function setHover(payload: PreviewTooltipHover): void {
    const h = hover.value
    if (h && h.blockId === payload.blockId && h.source === payload.source) {
      if (h.source === 'viewport') {
        if (voxelsEqual(h.voxel, payload.voxel)) {
          h.clientX = payload.clientX
          h.clientY = payload.clientY
          return
        }
      } else {
        h.clientX = payload.clientX
        h.clientY = payload.clientY
        return
      }
    }
    hover.value = { ...payload }
  }

  function clearHover(source?: TooltipHoverSource): void {
    const h = hover.value
    if (!h) return
    if (source === undefined || h.source === source) hover.value = null
  }

  return { hover, setHover, clearHover }
}

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
