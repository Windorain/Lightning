import type { RegionEventHandler } from '@/events/handlerTypes'
import { HANDLER_TYPE } from '@/events/handlerTypes'
import type { Context } from '@/runtime/context'
import { pickAtPointer } from '@/render/interaction/scenePick'
import { structureRowToWorldY } from '@/pure/vec'
import type { BlockRef } from '@/context/selection'

export interface EmbedHoverSink {
  setViewportBlock(payload: {
    blockId: string
    voxel: { column: number; row: number; zSlice: number }
    clientX: number
    clientY: number
  } | null): void
  setAnnotation(payload: { annotationId: string; clientX: number; clientY: number } | null): void
}

/**
 * HOVER handler — pointermove/leave 拾取，更新 hover 状态（不 break，穿透 GIZMO/KEYMAP）。
 */
export function createHoverHandler(
  regionId: string,
  getCtx: () => Context,
  embedSink?: EmbedHoverSink,
): RegionEventHandler {
  function clearWorkbenchHover(ctx: Context): void {
    if (ctx.workbench) ctx.workbench.hoveredBlock.value = null
  }

  function setWorkbenchBlock(ctx: Context, _pe: PointerEvent, picked: {
    blockId: string
    column: number
    row: number
    zSlice: number
  }): void {
    if (!ctx.workbench) return
    const doc = ctx.doc.value
    const rf = doc?.frame(ctx.currentFrameIndex.value ?? 0)
    const h = rf?.grid?.height ?? 0
    const worldY = h > 0 ? structureRowToWorldY(picked.row, h) : picked.row
    const ref: BlockRef = {
      pos: { x: picked.column, y: worldY, z: picked.zSlice },
      block_state_id: picked.blockId,
    }
    ctx.workbench.hoveredBlock.value = ref
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
          clearWorkbenchHover(ctx)
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
          setWorkbenchBlock(ctx, event, picked)
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
          clearWorkbenchHover(ctx)
        }
      } else {
        if (embedSink) {
          embedSink.setViewportBlock(null)
          embedSink.setAnnotation(null)
        } else {
          clearWorkbenchHover(ctx)
        }
      }

      return { break: false }
    },
  }
}
