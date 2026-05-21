import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout, UILayoutItem } from '../types/layout'

export const blockStatsPanel: PanelDeclaration = {
  id: 'block-stats-panel',
  label: '方块统计',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,

  poll(): boolean { return true },

  layout(ctx: BContext): UILayout {
    const doc = ctx.doc.value as Record<string, any> | null
    const palette = doc?.block_palette as Record<string, any> | undefined
    const items: UILayoutItem[] = []
    if (palette) {
      for (const [id, entry] of Object.entries(palette)) {
        const label = (entry as any)?.localized_name ?? id
        items.push({ kind: 'label' as const, text: `${label}: ${id}` })
      }
    } else {
      items.push({ kind: 'label' as const, text: '(无数据)' })
    }
    return { kind: 'column', align: false, items }
  },
}
