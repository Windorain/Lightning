/**
 * 悬停气泡：Vue 状态 + 由 `cellTooltipGrid` 与 `tooltipPalette` 解析的说明文案（无 `registryId` 回退）。
 */

import { ref, type Ref } from 'vue'

export { resolvePreviewTooltipText } from '@/pure/tooltipResolution'

import type { TooltipHoverSource, VoxelWithTooltip, PreviewTooltipHover } from '@/pure/tooltipResolution'
export type { TooltipHoverSource, VoxelWithTooltip, PreviewTooltipHover }

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
