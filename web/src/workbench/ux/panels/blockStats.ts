import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout, UILayoutItem } from '../types/layout'

export const blockStatsPanel: PanelDeclaration = {
  id: 'block-stats-panel',
  label: '方块统计',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,
  workspaces: ['preview'],

  poll(): boolean { return true },

  layout(ctx: BContext): UILayout {
    const stats = ctx.queries.getBlockTypeStats()
    const entries = Object.entries(stats)
    const items: UILayoutItem[] = []

    if (entries.length > 0) {
      entries.sort((a, b) => b[1].count - a[1].count)
      items.push({ kind: 'label' as const, text: `共 ${entries.length} 种方块` })
      for (const [id, stat] of entries) {
        items.push({
          kind: 'operator' as const,
          id: 'OPERATOR_SELECT_BY_TYPE',
          label: `${id}  ×${stat.count}`,
          props: { blockStateId: id },
        })
      }
    } else {
      items.push({ kind: 'label' as const, text: '(无数据)' })
    }
    return { kind: 'column', align: false, items }
  },
}
