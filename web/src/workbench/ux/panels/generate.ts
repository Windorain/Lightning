import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout, UILayoutItem } from '../types/layout'

export const generatePanel: PanelDeclaration = {
  id: 'generate-panel',
  label: '生成',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,

  poll(ctx: BContext): boolean {
    const tool = ctx.toolRegistry.activeTool.value?.id
    return tool === 'OPERATOR_GENERATE' || tool === 'OPERATOR_REPLACE' || tool === 'OPERATOR_FILL'
  },
  owner(ctx: BContext): unknown { return ctx.settings },
  layout(ctx: BContext): UILayout {
    const doc = ctx.scene.scene.value as Record<string, any> | null
    const palette: string[] = doc?.block_palette ? Object.keys(doc.block_palette) : []

    const items: UILayoutItem[] = [
      { kind: 'property', rnaPath: 'toolsettings.generateType', label: '方块类型', widget: 'text' },
      { kind: 'separator' },
      { kind: 'label', text: '调色板' },
    ]

    if (palette.length === 0) {
      items.push({ kind: 'label', text: '(无方块)' })
    } else {
      for (const id of palette.slice(0, 20)) {
        items.push({
          kind: 'operator',
          id: 'OPERATOR_TOOL_SET',
          label: id,
          props: { toolId: 'OPERATOR_GENERATE', brushId: id },
        })
      }
    }

    return { kind: 'column', align: false, items }
  },
}
