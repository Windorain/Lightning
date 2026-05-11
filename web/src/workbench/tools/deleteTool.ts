import type { Tool } from '@/workbench/toolRegistry'
import type { ThreeToolContext } from './_base'

export const deleteTool: Tool = {
  id: 'delete',
  label: 'Delete',
  icon: '✕',
  cursor: 'not-allowed',
  defaultKey: 'x',

  onActivate(ctx: ThreeToolContext): void {
    const targets = [...ctx.selection.items.value]
    if (targets.length === 0) return
    ctx.executeDelete(targets)
    ctx.selection.clear()
    ctx.toolRegistry.activate('select', ctx)
  },
}
