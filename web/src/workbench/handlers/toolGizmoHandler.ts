// web/src/workbench/handlers/toolGizmoHandler.ts
import type { RegionEventHandler } from '@/workbench/events/handlerTypes'
import { HANDLER_TYPE } from '@/workbench/events/handlerTypes'
import type { BContext } from '@/workbench/context/bContext'

/**
 * Gizmo handler — reads activeGizmo from ToolRegistry.
 * Routes pointermove/pointerdown/pointerup to the active gizmo.
 * Does NOT consume events — keymap handler processes them next.
 */
export function createToolGizmoHandler(
  _regionId: string,
  getBctx: () => BContext | null,
  getToolCtx: () => import('@/workbench/tools/tool').ToolContext | null,
): RegionEventHandler {
  return {
    type: HANDLER_TYPE.GIZMO,
    handle(event: Event): { break: boolean } {
      const bctx = getBctx()
      if (!bctx) return { break: false }

      const gizmo = bctx.toolRegistry.activeGizmo.value
      if (!gizmo) return { break: false }

      const ctx = getToolCtx()
      if (!ctx) return { break: false }

      const pe = event as PointerEvent

      // Only left-click (button 0) triggers gizmo interaction.
      // Middle/right button reserved for view manipulation, context menu.
      if (pe.type === 'pointerdown' && pe.button !== 0) return { break: false }

      switch (event.type) {
        case 'pointermove':
          gizmo.onPointerMove?.(ctx, pe)
          break
        case 'pointerdown':
          gizmo.onPointerDown?.(ctx, pe)
          break
        case 'pointerup':
          gizmo.onPointerUp?.(ctx, pe)
          break
      }

      return { break: false }
    },
  }
}
