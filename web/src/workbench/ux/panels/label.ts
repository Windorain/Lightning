import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout } from '../types/layout'

export const labelPanel: PanelDeclaration = {
  id: 'label-panel',
  label: '标签',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,

  poll(ctx: BContext): boolean {
    return ctx.toolRegistry.activeTool.value?.id === 'OPERATOR_LABEL'
  },

  layout(_ctx: BContext): UILayout {
    return {
      kind: 'column', align: false, items: [
        { kind: 'label', text: '标签编辑器' },
        { kind: 'separator' },
        { kind: 'property', rnaPath: 'block.tooltip', label: '标签文本', widget: 'text' },
      ],
    }
  },
}
