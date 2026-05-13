import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout, UILayoutItem } from '../types/layout'

export const toolShelfPanel: PanelDeclaration = {
  id: 'tool-shelf',
  label: '工具',
  spaceType: SpaceType.VIEW_3D,
  regionType: RegionType.TOOLSHELF,

  poll(): boolean { return true },
  owner(ctx: BContext): unknown { return ctx.settings },
  layout(ctx: BContext): UILayout {
    const tools = [...ctx.toolRegistry.tools.value.values()]
    const items: UILayoutItem[] = tools.map(t => ({
      kind: 'operator' as const,
      id: 'OPERATOR_TOOL_SET',
      label: t.icon,
      title: t.label,
      props: { toolId: t.id },
    }))
    items.push(
      { kind: 'separator' },
      { kind: 'property', rnaPath: 'toolsettings.snapEnabled', label: '', widget: 'checkbox' },
    )
    return { kind: 'column', align: false, items }
  },
}
