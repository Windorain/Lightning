import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout } from '../types/layout'

export const blockInspectorPanel: PanelDeclaration = {
  id: 'block-inspector',
  label: '方块检查器',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,

  poll(ctx: BContext): boolean {
    return ctx.selection.items.value.size === 1
  },

  layout(_ctx: BContext): UILayout {
    return {
      kind: 'column', align: false, items: [
        { kind: 'box', label: '标识', items: [
          { kind: 'property', rnaPath: 'block.id', label: '方块' },
          { kind: 'property', rnaPath: 'block.tooltip', label: 'Tooltip', widget: 'text' },
        ]},
        { kind: 'separator' },
        { kind: 'box', label: '位置', items: [
          { kind: 'property', rnaPath: 'block.pos', label: '坐标', widget: 'vector' },
        ]},
        { kind: 'separator' },
        { kind: 'row', align: true, items: [
          { kind: 'operator', id: 'OPERATOR_TOOLTIP_EDIT', label: '编辑' },
          { kind: 'operator', id: 'OPERATOR_DELETE', label: '删除' },
        ]},
      ],
    }
  },
}
