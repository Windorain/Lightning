import type { RegionEventHandler } from '@/events/handlerTypes'

import { HANDLER_TYPE } from '@/events/handlerTypes'

import type { Context } from '@/runtime/context'

import { pickEntityAtClient } from '@/context/queries'

import { pickPartForScenePick } from '@/context/queries'

import { createHoverPickScheduler } from '@/runtime/hover'

import { pickTargetKey } from '@/runtime/hover'

import type { ViewportHoverState } from '@/runtime/hover'

import { applyRegionHoverPick } from '@/runtime/hover'

import type { PartTooltipInfo } from '@/pure/tooltipResolution'



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

    // P2.2：格命中后细化为部件命中（无部件格 / 未命中部件盒 ⇒ null，宿主行为不变）
    const partHit = picked?.kind === 'block' ? pickPartForScenePick(ctx, picked) : null

    const partInfo: PartTooltipInfo | null = partHit
      ? {
          localId: partHit.part.localId,
          displayName: partHit.part.displayName,
          tooltip: [...partHit.part.tooltip],
        }
      : null

    // 拾取键含部件身份：同格不同部件 ⇒ 不同键（悬停目标随部件切换）
    const key = pickTargetKey(picked) + (partInfo ? `#part:${partInfo.localId}` : '')



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

          part: partInfo,

        })

      }

      return

    }

    lastPickKey = key

    applyRegionHoverPick(hover, picked, lastClientX, lastClientY, partInfo)

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



      if (
        event.type === 'pointerup'
        && (event.pointerType === 'touch' || event.pointerType === 'pen')
      ) {
        lastClientX = event.clientX
        lastClientY = event.clientY
        scheduler.schedule()
        return { break: false }
      }

      if (event.type !== 'pointermove') return { break: false }

      if (event.pointerType === 'touch' || event.pointerType === 'pen') {
        return { break: false }
      }

      lastClientX = event.clientX
      lastClientY = event.clientY
      scheduler.schedule()
      return { break: false }

    },

  }

}

