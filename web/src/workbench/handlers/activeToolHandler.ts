import type { EventHandler } from '@/workbench/eventDispatcher'
import type { ThreeToolContext } from '@/workbench/tools/_base'
import type { ToolRegistry } from '@/workbench/toolRegistry'

/**
 * Create an event handler that forwards pointer events to the active tool.
 * Priority 25: runs after gizmo handler (15) but before default pick (40).
 */
export function createActiveToolHandler(
  getToolRegistry: () => ToolRegistry,
  getToolCtx: () => ThreeToolContext | null,
): EventHandler {
  return {
    priority: 25,
    handle(event: Event): { break: boolean } {
      const toolCtx = getToolCtx()
      if (!toolCtx) return { break: false }
      const tool = getToolRegistry().activeTool.value
      if (!tool) return { break: false }

      switch (event.type) {
        case 'pointerdown':
          tool.onPointerDown?.(toolCtx, event as PointerEvent)
          break
        case 'pointermove':
          tool.onPointerMove?.(toolCtx, event as PointerEvent)
          break
        case 'pointerup':
          tool.onPointerUp?.(toolCtx, event as PointerEvent)
          break
        default:
          return { break: false }
      }
      // Tools always consume pointer events (prevent default viewport pick)
      return { break: true }
    },
  }
}
