import type { RegionEventHandler } from '@/events/handlerTypes'
import { HANDLER_TYPE } from '@/events/handlerTypes'
import type { Context } from '@/runtime/context'
import { pickEntityAtClient } from '@/context/queries'
import { createHoverPickScheduler } from '@/runtime/hover'
import { pickTargetKey } from '@/runtime/hover'
import type { ViewportHoverState } from '@/runtime/hover'
import { applyRegionHoverPick } from '@/runtime/hover'

/**
 * HOVER handler — pointermove 合并为每帧一次拾取；目标未变时仅更新光标坐标。
 */
export function createHoverHandler(
  regionId: string,
  getCtx: () => Context,
): RegionEventHandler {
  let lastPickKey = ''
  let lastClientX = 0
  let lastClientY = 0

  const applyPick = (): void => {
    const ctx = getCtx()
    const hover = ctx.region(regionId)?.state.hover as ViewportHoverState | undefined
    if (!hover) return

    const picked = pickEntityAtClient(ctx, lastClientX, lastClientY, regionId)
    const key = pickTargetKey(picked)

    if (key === lastPickKey) {
      if (picked?.kind === 'annotation') {
        hover.setAnnotation({
          annotationId: picked.annotationId,
          clientX: lastClientX,
          clientY: lastClientY,
        })
      } else if (picked?.kind === 'block') {
        hover.setViewportBlock({
          blockId: picked.blockId,
          clientX: lastClientX,
          clientY: lastClientY,
          voxel: { column: picked.column, row: picked.row, zSlice: picked.zSlice },
        })
      }
      return
    }
    lastPickKey = key
    applyRegionHoverPick(hover, picked, lastClientX, lastClientY)
  }

  const scheduler = createHoverPickScheduler(applyPick)

  return {
    type: HANDLER_TYPE.HOVER,
    handle(event: Event): { break: boolean } {
      if (!(event instanceof PointerEvent)) return { break: false }

      if (event.type === 'pointerleave') {
        scheduler.cancel()
        lastPickKey = ''
        const hover = getCtx().region(regionId)?.state.hover as ViewportHoverState | undefined
        hover?.clearViewport()
        return { break: false }
      }

      if (event.type !== 'pointermove') return { break: false }

      lastClientX = event.clientX
      lastClientY = event.clientY
      scheduler.schedule()
      return { break: false }
    },
  }
}
