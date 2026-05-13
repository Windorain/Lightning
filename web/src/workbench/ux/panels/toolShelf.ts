import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout } from '../types/layout'

export const toolShelfPanel: PanelDeclaration = {
  id: 'tool-shelf',
  label: '工具',
  spaceType: SpaceType.VIEW_3D,
  regionType: RegionType.TOOLSHELF,

  poll(): boolean { return true },

  layout(ctx: BContext): UILayout {
    const tools = ctx.operators.all()
    const items: any[] = tools.map(t => ({
      kind: 'operator' as const,
      id: 'OPERATOR_TOOL_SET',
      label: t.label,
      props: { toolId: t.id },
    }))
    return { kind: 'column', align: false, items }
  },
}
