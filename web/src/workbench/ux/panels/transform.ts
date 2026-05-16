import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout } from '../types/layout'
import type { BlockRef } from '@/workbench/selectionContext'

export const transformPanel: PanelDeclaration = {
  id: 'transform-panel',
  label: '变换',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,

  poll(ctx: BContext): boolean {
    return ctx.toolRegistry.activeTool.value?.id === 'OPERATOR_MOVE'
  },
  owner(ctx: BContext): unknown {
    const item = [...ctx.selection.items.value][0]
    if (!item) return null
    const g = ctx.scene.scene.value?.frame(0)?.grid
    ;(item as BlockRef)._gridSize = g ? { w: g.width, h: g.height, d: g.depth } : null
    return item
  },
  layout(ctx: BContext): UILayout {
    const sel = [...ctx.selection.items.value]
    if (sel.length === 0) {
      return { kind: 'column', align: false, items: [{ kind: 'label', text: '未选择方块' }] }
    }
    return {
      kind: 'column', align: false, items: [
        { kind: 'box', label: '位置', items: [
          { kind: 'property', rnaPath: 'block.pos', label: '坐标', widget: 'vector' },
        ]},
      ],
    }
  },
}
