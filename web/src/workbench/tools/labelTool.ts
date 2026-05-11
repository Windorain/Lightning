import type { Tool } from '@/workbench/toolRegistry'
import type { ThreeToolContext } from './_base'

export const labelTool: Tool = {
  id: 'label',
  label: 'Label',
  icon: 'T',
  cursor: 'text',

  onPointerUp(ctx: ThreeToolContext, event: PointerEvent): void {
    const picked = ctx.pickVoxel(event)
    if (!picked) return
    ctx._labelPosition = { x: picked.pos.x + 0.5, y: picked.pos.y + 1, z: picked.pos.z + 0.5 }
    ctx._showLabelEditor = true
  },
}
