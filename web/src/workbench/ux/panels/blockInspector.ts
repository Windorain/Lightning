import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout, UILayoutItem } from '../types/layout'
import type { BlockRef } from '@/workbench/selectionContext'

function singleBlockLayout(bctx: BContext, item: BlockRef): UILayoutItem[] {
  const paletteEntry = bctx.queries.getBlockPaletteEntry(item.pos)
  const items: UILayoutItem[] = []

  items.push(
    { kind: 'box', label: '标识', items: [
      { kind: 'property', rnaPath: 'block.id', label: '方块' },
      { kind: 'property', rnaPath: 'block.tooltip', label: 'Tooltip', widget: 'text' },
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
      const tipItems: UILayoutItem[] = paletteEntry.tooltip.map((t: string) =>
        ({ kind: 'label' as const, text: t })
      )
      items.push(
        { kind: 'separator' },
        { kind: 'box', label: 'Tooltip', items: tipItems },
      )
    }
    if (paletteEntry.nbt && Object.keys(paletteEntry.nbt).length > 0) {
      const nbtItems: UILayoutItem[] = Object.entries(paletteEntry.nbt).map(([key, val]) =>
        ({ kind: 'label' as const, text: `${key}: ${typeof val === 'object' ? JSON.stringify(val) : val}` })
      )
      items.push(
        { kind: 'separator' },
        { kind: 'box', label: 'NBT', items: nbtItems },
      )
    }
    if (paletteEntry.facing) {
      items.push({ kind: 'label', text: `朝向: ${paletteEntry.facing}` })
    }
  }

  items.push(
    { kind: 'separator' },
    { kind: 'row', align: true, items: [
      { kind: 'operator', id: 'OPERATOR_TOOLTIP_EDIT', label: '编辑' },
      { kind: 'operator', id: 'OPERATOR_DELETE', label: '删除' },
    ]},
  )

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
  result.push(
    { kind: 'separator' },
    { kind: 'row', align: true, items: [
      { kind: 'operator', id: 'OPERATOR_DELETE', label: '删除所选' },
    ]},
  )
  return result
}

export const blockInspectorPanel: PanelDeclaration = {
  id: 'block-inspector',
  label: '方块检查器',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,
  workspaces: ['preview'],

  poll(ctx: BContext): boolean {
    return ctx.selection.items.value.size >= 1
  },

  owner(ctx: BContext): unknown {
    const items = [...ctx.selection.items.value].filter(e => e.kind === 'block')
    if (items.length !== 1) return null
    const item = items[0]!.ref
    const g = ctx.doc.value?.frame(0)?.grid
    ;(item as BlockRef)._gridSize = g ? { w: g.width, h: g.height, d: g.depth } : null
    return item
  },

  layout(ctx: BContext): UILayout {
    const items = [...ctx.selection.items.value].filter(e => e.kind === 'block').map(e => e.ref)
    if (items.length === 0) {
      return { kind: 'column', align: false, items: [{ kind: 'label', text: '(无选中)' }] }
    }
    if (items.length === 1) {
      return { kind: 'column', align: false, items: singleBlockLayout(ctx, items[0]!) }
    }
    return { kind: 'column', align: false, items: multiBlockLayout(items) }
  },
}
