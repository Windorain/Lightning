import { ref } from 'vue'
import type { Tool } from '@/workbench/toolRegistry'
import type { ThreeToolContext } from './_base'

const mirrorAxis = ref<'x' | 'y' | 'z'>('x')

export function getMirrorAxis(): string { return mirrorAxis.value }
export function setMirrorAxis(a: 'x' | 'y' | 'z'): void { mirrorAxis.value = a }

export const mirrorTool: Tool = {
  id: 'mirror',
  label: 'Mirror',
  icon: '⇔',
  cursor: 'crosshair',
  defaultKey: 'Ctrl+m',

  onActivate(ctx: ThreeToolContext): void {
    const targets = [...ctx.selection.items.value]
    if (targets.length === 0) return
    ctx.executeMirror(targets, mirrorAxis.value)
    ctx.toolRegistry.activate('select')
  },
}
