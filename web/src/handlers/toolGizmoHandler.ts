// web/src/handlers/toolGizmoHandler.ts
import type { RegionEventHandler } from '@/events/handlerTypes'
import { HANDLER_TYPE } from '@/events/handlerTypes'
import type { Context } from '@/runtime/context'

/**
 * Gizmo handler — reads activeGizmo from ToolRegistry.
 * Routes pointermove/pointerdown/pointerup to the active gizmo.
 * Does NOT consume events — keymap handler processes them next.
 */
export function createToolGizmoHandler(
  _regionId: string,
  getCtx: () => Context | null,
  getToolCtx: () => import('@/workbench/tools/tool').ToolContext | null,
): RegionEventHandler {
  return {
    type: HANDLER_TYPE.GIZMO,
    handle(event: Event): { break: boolean } {
      const appCtx = getCtx()
      if (!appCtx) return { break: false }

      const gizmo = appCtx.getToolRegistry().activeGizmo.value
      if (!gizmo) return { break: false }

      const toolCtx = getToolCtx()
      if (!toolCtx) return { break: false }

      const pe = event as PointerEvent

      // Only left-click (button 0) triggers gizmo interaction.
      // Middle/right button reserved for view manipulation, context menu.
      if (pe.type === 'pointerdown' && pe.button !== 0) return { break: false }

      switch (event.type) {
        case 'pointermove':
          gizmo.onPointerMove?.(toolCtx, pe)
          break
        case 'pointerdown':
          gizmo.onPointerDown?.(toolCtx, pe)
          break
        case 'pointerup':
          gizmo.onPointerUp?.(toolCtx, pe)
          break
      }

      return { break: false }
    },
  }
}
