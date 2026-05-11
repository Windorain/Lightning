import type { Tool } from '@/workbench/toolRegistry'
import type { ThreeToolContext } from './_base'

export const moveTool: Tool = {
  id: 'move',
  label: 'Move',
  icon: '↕',
  cursor: 'move',
  defaultKey: 'g',

  onPointerDown(ctx: ThreeToolContext, event: PointerEvent): void {
    ctx._moveStart = { x: event.clientX, y: event.clientY }
    ctx._moveInitialPositions = [...ctx.selection.items.value].map(b => ({ ...b.pos }))
  },

  onPointerMove(ctx: ThreeToolContext, event: PointerEvent): void {
    if (!ctx._moveStart) return
    const dx = Math.round((event.clientX - ctx._moveStart.x) / 20)
    const dy = Math.round((event.clientY - ctx._moveStart.y) / 20)
    ctx._moveDelta = { x: dx, y: 0, z: -dy }
  },

  onPointerUp(ctx: ThreeToolContext, _event: PointerEvent): void {
    if (!ctx._moveDelta || !ctx._moveInitialPositions) return
    const { x, y, z } = ctx._moveDelta
    if (x === 0 && y === 0 && z === 0) return
    ctx.executeMove(ctx._moveInitialPositions, { x, y, z })
    ctx._moveStart = null
    ctx._moveDelta = null
    ctx._moveInitialPositions = null
  },
}
