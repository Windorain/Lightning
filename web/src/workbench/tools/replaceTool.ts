import { ref } from 'vue'
import type { Tool } from '@/workbench/toolRegistry'
import type { ThreeToolContext } from './_base'

const brushType = ref<string | null>(null)

export function getReplaceBrush(): string | null { return brushType.value }
export function setReplaceBrush(id: string | null): void { brushType.value = id }

export const replaceTool: Tool = {
  id: 'replace',
  label: 'Replace',
  icon: '🖌',
  cursor: 'crosshair',
  defaultKey: 'r',

  onPointerUp(ctx: ThreeToolContext, event: PointerEvent): void {
    const target = brushType.value
    if (!target) return
    const picked = ctx.pickVoxel(event)
    if (!picked) return
    ctx.executeReplace([{ pos: picked.pos, oldBlockStateId: picked.block_state_id, newBlockStateId: target }])
  },
}
