import type { RegionEventHandler } from '@/events/handlerTypes'
import { HANDLER_TYPE } from '@/events/handlerTypes'
import type { Context } from '@/runtime/context'
import type { BlockRef } from '@/context/selection'
import { pickEntityAtClient } from '@/context/queries'
import { structureRowToWorldY } from '@/pure/vec'
import type { ViewportHoverState } from '@/runtime/viewportHover'
import { createHoverPickScheduler } from '@/runtime/hoverPickSchedule'
import { blockRefKey, pickTargetKey } from '@/runtime/hoverPickKeys'
function toBlockRef(ctx: Context, picked: {
  blockId: string
  column: number
  row: number
  zSlice: number
}): BlockRef {
  const doc = ctx.getDoc().value
  const rf = doc?.frame(ctx.getCurrentFrameIndex().value ?? 0)
  const h = rf?.grid?.height ?? 0
  const worldY = h > 0 ? structureRowToWorldY(picked.row, h) : picked.row
  return {
    pos: { x: picked.column, y: worldY, z: picked.zSlice },
    block_state_id: picked.blockId,
  }
}

/**
 * HOVER handler — pointermove 合并为每帧一次拾取；目标未变时跳过写入/描边重建。
 */
function applyWorkbenchHover(
  ctx: Context,
  picked: ReturnType<typeof pickEntityAtClient>,
  last: { blockKey: string; annotationId: string },
): void {
  const hoveredBlock = ctx.getHoveredBlock()
  const hoveredAnnotation = ctx.getHoveredAnnotationId()

  if (picked?.kind === 'block') {
    const block = toBlockRef(ctx, picked)
    const bk = blockRefKey(block)
    if (last.annotationId !== '') {
      last.annotationId = ''
      hoveredAnnotation.value = null
    }
    if (bk !== last.blockKey) {
      last.blockKey = bk
      hoveredBlock.value = block
    }
    return
  }

  if (picked?.kind === 'annotation') {
    const aid = picked.annotationId
    if (last.blockKey !== '') {
      last.blockKey = ''
      hoveredBlock.value = null
    }
    if (aid !== last.annotationId) {
      last.annotationId = aid
      hoveredAnnotation.value = aid
    }
    return
  }

  if (last.blockKey !== '') {
    last.blockKey = ''
    hoveredBlock.value = null
  }
  if (last.annotationId !== '') {
    last.annotationId = ''
    hoveredAnnotation.value = null
  }
}

export function createHoverHandler(
  regionId: string,
  getCtx: () => Context,
): RegionEventHandler {
  let lastPickKey = ''
  const lastWorkbenchHover = { blockKey: '', annotationId: '' }
  let lastClientX = 0
  let lastClientY = 0

  const applyPick = (): void => {
    const ctx = getCtx()
    const embedHover = ctx.region(regionId)?.state.hover as ViewportHoverState | undefined

    const picked = pickEntityAtClient(ctx, lastClientX, lastClientY, regionId)

    const key = pickTargetKey(picked)
    if (key === lastPickKey) {
      if (embedHover && picked?.kind === 'annotation') {
        embedHover.setAnnotation({
          annotationId: picked.annotationId,
          clientX: lastClientX,
          clientY: lastClientY,
        })
      } else if (embedHover && picked?.kind === 'block') {
        embedHover.setViewportBlock({
          blockId: picked.blockId,
          clientX: lastClientX,
          clientY: lastClientY,
          voxel: { column: picked.column, row: picked.row, zSlice: picked.zSlice },
        })
      }
      return
    }
    lastPickKey = key

    if (embedHover) {
      if (picked?.kind === 'block') {
        embedHover.setViewportBlock({
          blockId: picked.blockId,
          clientX: lastClientX,
          clientY: lastClientY,
          voxel: { column: picked.column, row: picked.row, zSlice: picked.zSlice },
        })
      } else if (picked?.kind === 'annotation') {
        embedHover.setAnnotation({
          annotationId: picked.annotationId,
          clientX: lastClientX,
          clientY: lastClientY,
        })
      } else {
        embedHover.clearViewport()
      }
      return
    }

    applyWorkbenchHover(ctx, picked, lastWorkbenchHover)
  }

  const scheduler = createHoverPickScheduler(applyPick)

  return {
    type: HANDLER_TYPE.HOVER,
    handle(event: Event): { break: boolean } {
      if (!(event instanceof PointerEvent)) return { break: false }

      if (event.type === 'pointerleave') {
        scheduler.cancel()
        lastPickKey = ''
        lastWorkbenchHover.blockKey = ''
        lastWorkbenchHover.annotationId = ''
        const ctx = getCtx()
        const embedHover = ctx.region(regionId)?.state.hover as ViewportHoverState | undefined
        if (embedHover) embedHover.clearViewport()
        else applyWorkbenchHover(ctx, null, lastWorkbenchHover)
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
