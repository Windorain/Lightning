import type { Context } from '@/runtime/context'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '@/runtime/screenTypes'
import type { UILayout, UILayoutItem } from '../types/layout'
import type { BlockRef } from '@/context/selection'
import { getBlockPaletteEntry } from '@/context/queries'
function singleBlockLayout(ctx: Context, item: BlockRef): UILayoutItem[] {
  const paletteEntry = getBlockPaletteEntry(ctx, item.pos)
  const items: UILayoutItem[] = []

  items.push(
    { kind: 'box', label: '标识', items: [
      { kind: 'property', rnaPath: 'block.id', label: '方块' },
    ]},
    { kind: 'separator' },
    { kind: 'box', label: '位置', items: [
      { kind: 'property', rnaPath: 'block.pos', label: '坐标', widget: 'vector' },
    ]},
  )

  if (paletteEntry) {
    if (paletteEntry.renderMode) {
      items.push({ kind: 'label', text: `渲染模式: ${paletteEntry.renderMode}` })
    }
    if (paletteEntry.tooltip && paletteEntry.tooltip.length > 0) {
      items.push(
        { kind: 'separator' },
        { kind: 'box', label: 'Tooltip', items: [
          { kind: 'widget', widget: 'tooltip-preview', props: { lines: paletteEntry.tooltip } },
        ]},
      )
    }
    if (paletteEntry.nbt && Object.keys(paletteEntry.nbt).length > 0) {
      const jsonText = '\n' + JSON.stringify(paletteEntry.nbt, null, 2)
      items.push(
        { kind: 'separator' },
        { kind: 'box', label: 'NBT', items: [
          { kind: 'scroll', items: [
            { kind: 'label', text: jsonText },
          ]},
        ]},
      )
    }
    if (paletteEntry.facing) {
      items.push({ kind: 'label', text: `朝向: ${paletteEntry.facing}` })
    }
  }

  return items
}

function multiBlockLayout(items: BlockRef[]): UILayoutItem[] {
  const typeCounts = new Map<string, number>()
  for (const b of items) {
    typeCounts.set(b.block_state_id, (typeCounts.get(b.block_state_id) ?? 0) + 1)
  }
  const result: UILayoutItem[] = [
    { kind: 'label', text: `已选 ${items.length} 个方块` },
    { kind: 'label', text: `${typeCounts.size} 种类型` },
    { kind: 'separator' },
  ]
  for (const [id, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    result.push({ kind: 'label', text: `${id}  ×${count}` })
  }
  return result
}

export const blockInspectorPanel: PanelDeclaration = {
  id: 'block-inspector',
  label: '方块检查器',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,
  workspaces: ['preview'],

  poll(ctx: Context): boolean {
    return ctx.getSelection().items.value.size >= 1
  },

  owner(ctx: Context): unknown {
    const items = [...ctx.getSelection().items.value].filter(e => e.kind === 'block')
    if (items.length !== 1) return null
    const item = items[0]!.ref
    const g = ctx.getDoc().value?.frame(0)?.grid
    ;(item as BlockRef)._gridSize = g ? { w: g.width, h: g.height, d: g.depth } : null
    return item
  },

  layout(ctx: Context): UILayout {
    const items = [...ctx.getSelection().items.value].filter(e => e.kind === 'block').map(e => e.ref)
    if (items.length === 0) {
      return { kind: 'column', align: false, items: [{ kind: 'label', text: '(无选中)' }] }
    }
    if (items.length === 1) {
      return { kind: 'column', align: false, items: singleBlockLayout(ctx, items[0]!) }
    }
    return { kind: 'column', align: false, items: multiBlockLayout(items) }
  },
}
