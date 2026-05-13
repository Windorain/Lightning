import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout } from '../types/layout'

export const batchEditPanel: PanelDeclaration = {
  id: 'batch-edit-panel',
  label: '批量编辑',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,

  poll(ctx: BContext): boolean {
    return ctx.toolRegistry.activeTool.value?.id === 'OPERATOR_SELECT'
      && ctx.selection.items.value.size > 1
  },

  layout(ctx: BContext): UILayout {
    const count = ctx.selection.items.value.size
    return {
      kind: 'column', align: false, items: [
        { kind: 'label', text: `已选择 ${count} 个方块` },
        { kind: 'separator' },
        { kind: 'operator', id: 'OPERATOR_DELETE', label: '删除选中' },
      ],
    }
  },
}
