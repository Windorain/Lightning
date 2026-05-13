import type { UILayout, UILayoutItem } from '../types/layout'
import { hasLayoutItems } from '../types/layout'
import type { Rect } from '../types/screen'

export interface WidgetRect {
  layoutId: string
  kind: string
  bounds: Rect
  rnaPath?: string
  operatorId?: string
}

const ITEM_HEIGHT = 28
const ITEM_PADDING = 2
const BOX_HEADER_HEIGHT = 24
const BOX_PADDING = 8
const SEPARATOR_HEIGHT = 12

export function computeWidgetRects(
  layout: UILayout,
  container: Rect,
  prefix = '',
): WidgetRect[] {
  // UISplit is handled by the caller (UIRenderer splits it into left/right)
  if (!hasLayoutItems(layout)) return []

  const result: WidgetRect[] = []
  const cursor = { x: container.x + ITEM_PADDING, y: container.y + ITEM_PADDING }
  const availWidth = container.width - ITEM_PADDING * 2
  const isRow = layout.kind === 'row'

  const leafCount = layout.items.filter(i => !isLayoutContainer(i)).length
  const columnPad = isRow && leafCount > 0 ? ITEM_PADDING * (leafCount - 1) : 0
  const itemWidth = isRow && leafCount > 0 ? Math.floor((availWidth - columnPad) / leafCount) : availWidth

  for (let i = 0; i < layout.items.length; i++) {
    const item = layout.items[i]
    const layoutId = prefix ? `${prefix}.item-${i}` : `item-${i}`

    if (isLayoutContainer(item)) {
      if (item.kind === 'box') {
        result.push({ layoutId, kind: 'box-label', bounds: { x: cursor.x, y: cursor.y, width: itemWidth, height: BOX_HEADER_HEIGHT } })
        advance(cursor, BOX_HEADER_HEIGHT, isRow)
        const boxBody = { x: cursor.x + BOX_PADDING, y: cursor.y, width: itemWidth - BOX_PADDING * 2, height: Math.max(0, container.height - (cursor.y - container.y) - BOX_PADDING) }
        const inner = computeWidgetRects(item, boxBody, layoutId)
        result.push(...inner)
        advance(cursor, inner.reduce((h, r) => h + r.bounds.height + ITEM_PADDING, 0) + BOX_PADDING, isRow)
      } else {
        const inner = computeWidgetRects(item, { x: cursor.x, y: cursor.y, width: itemWidth, height: container.height - (cursor.y - container.y) }, layoutId)
        result.push(...inner)
        advance(cursor, inner.reduce((h, r) => h + r.bounds.height + ITEM_PADDING, 0), isRow)
      }
    } else {
      const w = isRow ? itemWidth : availWidth
      const step = isRow ? itemWidth + ITEM_PADDING : ITEM_HEIGHT + ITEM_PADDING
      switch (item.kind) {
        case 'separator':
          result.push({ layoutId, kind: 'separator', bounds: { x: cursor.x, y: cursor.y, width: w, height: SEPARATOR_HEIGHT } })
          advance(cursor, step, isRow)
          break
        case 'label':
          result.push({ layoutId, kind: 'label', bounds: { x: cursor.x, y: cursor.y, width: w, height: ITEM_HEIGHT } })
          advance(cursor, step, isRow)
          break
        case 'operator':
          result.push({ layoutId, kind: 'operator', operatorId: item.id, bounds: { x: cursor.x, y: cursor.y, width: w, height: ITEM_HEIGHT } })
          advance(cursor, step, isRow)
          break
        case 'property':
          result.push({ layoutId, kind: 'property', rnaPath: item.rnaPath, bounds: { x: cursor.x, y: cursor.y, width: w, height: ITEM_HEIGHT } })
          advance(cursor, step, isRow)
          break
        case 'menu':
          result.push({ layoutId, kind: 'menu', bounds: { x: cursor.x, y: cursor.y, width: w, height: ITEM_HEIGHT } })
          advance(cursor, step, isRow)
          break
      }
    }
  }

  return result
}

function advance(cursor: { x: number; y: number }, distance: number, isRow: boolean): void {
  if (isRow) {
    cursor.x += distance
  } else {
    cursor.y += distance
  }
}

function isLayoutContainer(item: UILayoutItem): item is UILayout {
  if (typeof item !== 'object' || item === null) return false
  const k = (item as { kind?: string }).kind
  return k !== undefined && ['row', 'column', 'box', 'split', 'panel', 'scroll'].includes(k)
}
