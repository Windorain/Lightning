import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout } from '../types/layout'

export const annotationPanel: PanelDeclaration = {
  id: 'annotation-panel',
  label: '注解',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,

  poll(ctx: BContext): boolean {
    return ctx.toolRegistry.activeTool.value?.id === 'annotation'
  },

  layout(_ctx: BContext): UILayout {
    return {
      kind: 'column', align: false, items: [
        { kind: 'label', text: '注解编辑器' },
        { kind: 'separator' },
        { kind: 'property', rnaPath: 'block.tooltip', label: '文本', widget: 'text' },
        { kind: 'operator', id: 'OPERATOR_TOOLTIP_EDIT', label: '编辑 Tooltip' },
      ],
    }
  },
}
