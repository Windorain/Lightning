import type { Tool } from '@/workbench/toolRegistry'
import type { ThreeToolContext } from './_base'
import { setReplaceBrush } from './replaceTool'
import { setFillType } from './fillTool'

export const eyedropperTool: Tool = {
  id: 'eyedropper',
  label: 'Eyedropper',
  icon: '💉',
  cursor: 'crosshair',
  defaultKey: 'e',

  onPointerUp(ctx: ThreeToolContext, event: PointerEvent): void {
    const picked = ctx.pickVoxel(event)
    if (!picked) return
    setReplaceBrush(picked.block_state_id)
    setFillType(picked.block_state_id)
    ctx.toolRegistry.activate('select')
  },
}
