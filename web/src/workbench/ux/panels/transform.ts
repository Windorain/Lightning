import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout } from '../types/layout'

export const transformPanel: PanelDeclaration = {
  id: 'transform-panel',
  label: '变换',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,

  poll(ctx: BContext): boolean {
    return ctx.toolRegistry.activeTool.value?.id === 'move'
      && ctx.selection.items.value.size > 0
  },

  layout(ctx: BContext): UILayout {
    const sel = [...ctx.selection.items.value]
    if (sel.length === 0) {
      return { kind: 'column', align: false, items: [{ kind: 'label', text: '未选择方块' }] }
    }

    // Build a label showing selected count and first position
    const first = sel[0]
    const posLabel = sel.length === 1
      ? `(${first.pos.x}, ${first.pos.y}, ${first.pos.z})`
      : `${sel.length} 个方块已选`

    return {
      kind: 'column', align: false, items: [
        { kind: 'label', text: posLabel },
        { kind: 'separator' },
        { kind: 'operator', id: 'OPERATOR_MOVE', label: '移动 (G)', props: {} },
      ],
    }
  },
}
