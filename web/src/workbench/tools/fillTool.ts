import { ref } from 'vue'
import type { Tool } from '@/workbench/toolRegistry'
import type { ThreeToolContext } from './_base'

const fillType = ref<string | null>(null)

export function getFillType(): string | null { return fillType.value }
export function setFillType(id: string | null): void { fillType.value = id }

export const fillTool: Tool = {
  id: 'fill',
  label: 'Fill',
  icon: '▣',
  cursor: 'crosshair',
  defaultKey: 'f',

  onPointerDown(ctx: ThreeToolContext, event: PointerEvent): void {
    ctx._fillStart = { x: event.clientX, y: event.clientY }
  },

  onPointerUp(ctx: ThreeToolContext, event: PointerEvent): void {
    const target = fillType.value
    if (!target || !ctx._fillStart) return
    const dx = Math.abs(event.clientX - ctx._fillStart.x)
    const dy = Math.abs(event.clientY - ctx._fillStart.y)

    if (dx < 4 && dy < 4) {
      const picked = ctx.pickVoxel(event)
      if (picked) {
        ctx.executeReplace([{ pos: picked.pos, oldBlockStateId: picked.block_state_id, newBlockStateId: target }])
      }
    } else {
      const blocks = [...ctx.selection.items.value]
      if (blocks.length > 0) {
        const replacements = blocks.map(b => ({
          pos: b.pos, oldBlockStateId: b.block_state_id, newBlockStateId: target,
        }))
        ctx.executeReplace(replacements)
      }
    }
  },
}
