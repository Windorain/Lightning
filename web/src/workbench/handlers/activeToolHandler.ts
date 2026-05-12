import type { EventHandler } from '@/workbench/eventDispatcher'
import type { TypedEventHandler } from '@/workbench/events/eventTypes'
import { HANDLER_TYPE } from '@/workbench/events/eventTypes'
import type { ThreeToolContext } from '@/workbench/tools/_base'
import type { ToolRegistry } from '@/workbench/toolRegistry'
import type { BContext } from '@/workbench/context/bContext'

/**
 * Create an event handler that forwards pointer events to the active tool.
 * Priority 25 (legacy), HandlerType OPERATOR (typed).
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

      // MMB/RMB pass through to OrbitControls
      if ((event as PointerEvent).button !== 0) return { break: false }

      const pe = event as PointerEvent
      switch (event.type) {
        case 'pointerdown': tool.onPointerDown?.(toolCtx, pe); break
        case 'pointermove': tool.onPointerMove?.(toolCtx, pe); break
        case 'pointerup': tool.onPointerUp?.(toolCtx, pe); break
        default: return { break: false }
      }
      return { break: true }
    },
  }
}

/** Typed variant: forwards events to the active operator via globalOperators */
export function createTypedActiveOperatorHandler(
  getBctx: () => BContext | null,
): TypedEventHandler {
  return {
    type: HANDLER_TYPE.OPERATOR,
    handle(event: Event): { break: boolean } {
      const bctx = getBctx()
      if (!bctx) return { break: false }

      // MMB/RMB pass through
      if ((event as PointerEvent).button !== 0) return { break: false }

      const activeId = bctx.toolRegistry.activeTool.value?.id
      if (!activeId) return { break: false }

      // For now, old tools are still used — this path activates when operators take over
      return { break: false }
    },
  }
}
