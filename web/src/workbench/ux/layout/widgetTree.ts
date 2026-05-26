import type { UILayout } from '../types/layout'
import { hasLayoutItems, isLayoutContainer } from '../types/layout'
import type { Rect } from '../types/screen'

export interface WidgetRect {
  layoutId: string
  kind: string
  bounds: Rect
  rnaPath?: string
  operatorId?: string
  props?: Record<string, unknown>
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
        const savedY = cursor.y
        cursor.y += BOX_HEADER_HEIGHT
        const boxBody = { x: cursor.x + BOX_PADDING, y: cursor.y, width: itemWidth - BOX_PADDING * 2, height: Math.max(0, container.height - (cursor.y - container.y) - BOX_PADDING) }
        const inner = computeWidgetRects(item, boxBody, layoutId)
        result.push(...inner)
        if (isRow) {
          cursor.y = savedY
          advance(cursor, itemWidth + ITEM_PADDING, isRow)
        } else {
          cursor.y += inner.reduce((h, r) => h + r.bounds.height + ITEM_PADDING, 0) + BOX_PADDING
        }
      } else {
        const savedY = cursor.y
        const inner = computeWidgetRects(item, { x: cursor.x, y: cursor.y, width: itemWidth, height: container.height - (cursor.y - container.y) }, layoutId)
        result.push(...inner)
        if (isRow) {
          cursor.y = savedY
          advance(cursor, itemWidth + ITEM_PADDING, isRow)
        } else {
          cursor.y += inner.reduce((h, r) => h + r.bounds.height + ITEM_PADDING, 0)
        }
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
          result.push({ layoutId, kind: 'operator', operatorId: item.id, props: item.props, bounds: { x: cursor.x, y: cursor.y, width: w, height: ITEM_HEIGHT } })
          advance(cursor, step, isRow)
          break
        case 'property':
          result.push({ layoutId, kind: 'property', rnaPath: item.rnaPath, bounds: { x: cursor.x, y: cursor.y, width: w, height: ITEM_HEIGHT } })
          advance(cursor, step, isRow)
          break
        case 'menu':
          result.push({ layoutId, kind: 'menu', bounds: { x: cursor.x, y: cursor.y, width: w, height: ITEM_HEIGHT } })
          // Recurse into menu items so they're discoverable in widget cache for testing
          for (let mi = 0; mi < item.items.length; mi++) {
            const sub = item.items[mi]
            if (sub.kind === 'operator') {
              const subId = `${layoutId}.m${mi}`
              result.push({
                layoutId: subId,
                kind: 'operator',
                operatorId: sub.id,
                props: sub.props,
                bounds: { x: cursor.x, y: cursor.y + (mi + 1) * (ITEM_HEIGHT + ITEM_PADDING), width: w, height: ITEM_HEIGHT },
              })
            }
          }
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

