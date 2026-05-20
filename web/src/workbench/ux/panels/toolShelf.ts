import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout, UILayoutItem } from '../types/layout'
import { toolIcon, type ToolIconId } from '@/workbench/icons/toolIcons'

const toolIconMap: Record<string, ToolIconId> = {
  select: 'select',
  move: 'move',
  'annotation-box': 'box',
  'annotation-point': 'point',
  'annotation-line': 'line',
  'annotation-text': 'text',
}

export const toolShelfPanel: PanelDeclaration = {
  id: 'tool-shelf',
  label: '工具',
  spaceType: SpaceType.VIEW_3D,
  regionType: RegionType.TOOLSHELF,

  poll(): boolean { return true },
  owner(ctx: BContext): unknown { return ctx.settings },
  layout(ctx: BContext): UILayout {
    const tools = [...ctx.toolRegistry.tools.values()]
    const activeToolId = ctx.toolRegistry.activeTool.value?.id ?? ''
    const items: UILayoutItem[] = tools.map(t => {
      const iconId = toolIconMap[t.id] ?? 'select'
      const isActive = t.id === activeToolId
      return {
        kind: 'operator' as const,
        id: 'OPERATOR_TOOL_SET',
        label: '',
        icon: toolIcon(iconId, isActive ? 'active' : 'inactive'),
        title: t.label,
        props: { toolId: t.id },
      }
    })
    return { kind: 'column', align: false, items }
  },
}
