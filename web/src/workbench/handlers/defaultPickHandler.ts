import type { EventHandler } from '@/workbench/eventDispatcher'

/**
 * Pass-through handler at the end of the event chain.
 * Never consumes events — StructureViewport (click-to-select) and OrbitControls
 * handle them at the DOM level after our dispatch chain.
 *
 * Priority 40: lowest priority, effective no-op that prevents
 * eventDispatcher from crashing on empty handler lists.
 */
export function createDefaultPickHandler(): EventHandler {
  return {
    priority: 40,
    handle(_event: Event): { break: boolean } {
      return { break: false }
    },
  }
}
