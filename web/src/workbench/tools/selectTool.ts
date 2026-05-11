import type { Tool } from '@/workbench/toolRegistry'
import type { ThreeToolContext } from './_base'

export const selectTool: Tool = {
  id: 'select',
  label: 'Select',
  icon: '▲',
  cursor: 'default',

  onPointerDown(ctx: ThreeToolContext, event: PointerEvent): void {
    ctx._selectStart = { x: event.clientX, y: event.clientY }
    ctx._boxSelecting = event.shiftKey
  },

  onPointerUp(ctx: ThreeToolContext, event: PointerEvent): void {
    const start = ctx._selectStart
    if (!start) return

    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    const dist = Math.sqrt(dx * dx + dy * dy)

    if (dist < 3) {
      // Single click
      const picked = ctx.pickVoxel(event)
      if (picked) {
        if (event.ctrlKey || event.metaKey) {
          ctx.selection.add([picked])
        } else {
          ctx.selection.select(picked)
        }
      } else {
        if (!event.ctrlKey && !event.metaKey) {
          ctx.selection.clear()
        }
      }
    }
    ctx._selectStart = null
    ctx._boxSelecting = false
  },

  onKeyDown(ctx: ThreeToolContext, event: KeyboardEvent): void {
    if (event.key === 'a' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      const all = ctx.getFrameBlocks()
      if (ctx.selection.items.value.size === all.length) {
        ctx.selection.clear()
      } else {
        ctx.selection.selectBox(
          { x: -Infinity, y: -Infinity, z: -Infinity },
          { x: Infinity, y: Infinity, z: Infinity },
          all,
        )
      }
    }
  },
}
