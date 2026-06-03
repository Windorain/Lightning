import type { RegionEventHandler } from '@/events/handlerTypes'
import { HANDLER_TYPE } from '@/events/handlerTypes'
import type { Context } from '@/runtime/context'
import type { BlockRef } from '@/context/selection'
import { pickAtPointer } from '@/render/interaction/scenePick'
import { structureRowToWorldY } from '@/pure/vec'

export interface EmbedHoverSink {
  setViewportBlock(payload: {
    blockId: string
    voxel: { column: number; row: number; zSlice: number }
    clientX: number
    clientY: number
  } | null): void
  setAnnotation(payload: { annotationId: string; clientX: number; clientY: number } | null): void
}

function toBlockRef(ctx: Context, picked: {
  blockId: string
  column: number
  row: number
  zSlice: number
}): BlockRef {
  const doc = ctx.doc.value
  const rf = doc?.frame(ctx.currentFrameIndex.value ?? 0)
  const h = rf?.grid?.height ?? 0
  const worldY = h > 0 ? structureRowToWorldY(picked.row, h) : picked.row
  return {
    pos: { x: picked.column, y: worldY, z: picked.zSlice },
    block_state_id: picked.blockId,
  }
}

/**
 * HOVER handler — pointermove/leave 拾取，经 OPERATOR_SET_HOVERED_BLOCK 写状态（不 break）。
 */
export function createHoverHandler(
  regionId: string,
  getCtx: () => Context,
  embedSink?: EmbedHoverSink,
): RegionEventHandler {
  function setWorkbenchHover(ctx: Context, block: BlockRef | null): void {
    void ctx.operators.exec('OPERATOR_SET_HOVERED_BLOCK', { block })
  }

  return {
    type: HANDLER_TYPE.HOVER,
    handle(event: Event): { break: boolean } {
      if (!(event instanceof PointerEvent)) return { break: false }
      const ctx = getCtx()
      const slot = ctx.viewports.get(regionId) ?? ctx.viewport
      const camera = slot.camera.value
      const contentGroup = slot.contentGroup.value
      const domElement = slot.domElement.value
      const definition = slot.definition.value
      if (!camera || !contentGroup || !domElement || !definition) return { break: false }

      if (event.type === 'pointerleave') {
        if (embedSink) {
          embedSink.setViewportBlock(null)
          embedSink.setAnnotation(null)
        } else {
          setWorkbenchHover(ctx, null)
        }
        return { break: false }
      }

      if (event.type !== 'pointermove') return { break: false }

      const doc = ctx.doc.value
      const plain = doc?.serialize() as Record<string, unknown> | undefined
      const annotations = (plain?.annotations ?? []) as import('@/render/data/annotationTypes').Annotation[]

      const picked = pickAtPointer({
        clientX: event.clientX,
        clientY: event.clientY,
        domElement,
        camera,
        contentGroup,
        overlayGroup: slot.overlayGroup.value ?? undefined,
        def: definition,
        layerPreview: slot.layerPreview.value ?? 'all',
        annotations,
      })

      if (picked?.kind === 'block') {
        if (embedSink) {
          embedSink.setViewportBlock({
            blockId: picked.blockId,
            clientX: event.clientX,
            clientY: event.clientY,
            voxel: { column: picked.column, row: picked.row, zSlice: picked.zSlice },
          })
          embedSink.setAnnotation(null)
        } else {
          setWorkbenchHover(ctx, toBlockRef(ctx, picked))
        }
      } else if (picked?.kind === 'annotation') {
        if (embedSink) {
          embedSink.setViewportBlock(null)
          embedSink.setAnnotation({
            annotationId: picked.annotationId,
            clientX: event.clientX,
            clientY: event.clientY,
          })
        } else {
          setWorkbenchHover(ctx, null)
        }
      } else {
        if (embedSink) {
          embedSink.setViewportBlock(null)
          embedSink.setAnnotation(null)
        } else {
          setWorkbenchHover(ctx, null)
        }
      }

      return { break: false }
    },
  }
}
