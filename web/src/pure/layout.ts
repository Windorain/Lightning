/**
 * pure/layout.ts — Pure layout computation utilities.
 * No side effects: no Vue refs, no DOM, no I/O, no mutation of arguments.
 */

// ---------------------------------------------------------------------------
// Minimal data types
// ---------------------------------------------------------------------------

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WidgetRect {
  layoutId: string
  kind: string
  bounds: Rect
  rnaPath?: string
  operatorId?: string
  props?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ITEM_HEIGHT = 28
const ITEM_PADDING = 2
const BOX_HEADER_HEIGHT = 24
const BOX_PADDING = 8
const SEPARATOR_HEIGHT = 12

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasLayoutItems(layout: { kind: string; items?: unknown[] }): boolean {
  return layout.kind !== 'split'
}

function isLayoutContainer(
  item: { kind?: string },
): boolean {
  if (typeof item !== 'object' || item === null) return false
  return ['row', 'column', 'box', 'split', 'panel', 'scroll'].includes(
    (item as { kind?: string }).kind as string,
  )
}

function advance(cursor: { x: number; y: number }, distance: number, isRow: boolean): void {
  if (isRow) {
    cursor.x += distance
  } else {
    cursor.y += distance
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Compute widget rects from a declarative layout tree */
export function computeWidgetRects(
  layout: { kind: string; items?: unknown[]; label?: string },
  container: Rect,
  prefix = '',
): WidgetRect[] {
  if (!hasLayoutItems(layout)) return []

  const result: WidgetRect[] = []
  const cursor = { x: container.x + ITEM_PADDING, y: container.y + ITEM_PADDING }
  const availWidth = container.width - ITEM_PADDING * 2
  const isRow = layout.kind === 'row'
  const items = layout.items ?? []

  const leafCount = items.filter(i => !isLayoutContainer(i as { kind?: string })).length
  const columnPad = isRow && leafCount > 0 ? ITEM_PADDING * (leafCount - 1) : 0
  const itemWidth =
    isRow && leafCount > 0 ? Math.floor((availWidth - columnPad) / leafCount) : availWidth

  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>
    const layoutId = prefix ? `${prefix}.item-${i}` : `item-${i}`

    if (isLayoutContainer(item as { kind?: string })) {
      if (item.kind === 'box') {
        result.push({
          layoutId,
          kind: 'box-label',
          bounds: {
            x: cursor.x,
            y: cursor.y,
            width: itemWidth,
            height: BOX_HEADER_HEIGHT,
          },
        })
        const savedY = cursor.y
        cursor.y += BOX_HEADER_HEIGHT
        const boxBody = {
          x: cursor.x + BOX_PADDING,
          y: cursor.y,
          width: itemWidth - BOX_PADDING * 2,
          height: Math.max(
            0,
            container.height - (cursor.y - container.y) - BOX_PADDING,
          ),
        }
        const inner = computeWidgetRects(
          item as { kind: string; items?: unknown[] },
          boxBody,
          layoutId,
        )
        result.push(...inner)
        if (isRow) {
          cursor.y = savedY
          advance(cursor, itemWidth + ITEM_PADDING, isRow)
        } else {
          cursor.y +=
            inner.reduce((h, r) => h + r.bounds.height + ITEM_PADDING, 0) +
            BOX_PADDING
        }
      } else {
        const savedY = cursor.y
        const inner = computeWidgetRects(
          item as { kind: string; items?: unknown[] },
          {
            x: cursor.x,
            y: cursor.y,
            width: itemWidth,
            height: container.height - (cursor.y - container.y),
          },
          layoutId,
        )
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
          result.push({
            layoutId,
            kind: 'separator',
            bounds: { x: cursor.x, y: cursor.y, width: w, height: SEPARATOR_HEIGHT },
          })
          advance(cursor, step, isRow)
          break
        case 'label':
          result.push({
            layoutId,
            kind: 'label',
            bounds: { x: cursor.x, y: cursor.y, width: w, height: ITEM_HEIGHT },
          })
          advance(cursor, step, isRow)
          break
        case 'operator':
          result.push({
            layoutId,
            kind: 'operator',
            operatorId: item.id as string,
            props: item.props as Record<string, unknown> | undefined,
            bounds: { x: cursor.x, y: cursor.y, width: w, height: ITEM_HEIGHT },
          })
          advance(cursor, step, isRow)
          break
        case 'property':
          result.push({
            layoutId,
            kind: 'property',
            rnaPath: item.rnaPath as string,
            bounds: { x: cursor.x, y: cursor.y, width: w, height: ITEM_HEIGHT },
          })
          advance(cursor, step, isRow)
          break
        case 'menu': {
          result.push({
            layoutId,
            kind: 'menu',
            bounds: { x: cursor.x, y: cursor.y, width: w, height: ITEM_HEIGHT },
          })
          const menuItems = (item.items as unknown[]) ?? []
          for (let mi = 0; mi < menuItems.length; mi++) {
            const sub = menuItems[mi] as Record<string, unknown>
            if (sub.kind === 'operator') {
              const subId = `${layoutId}.m${mi}`
              result.push({
                layoutId: subId,
                kind: 'operator',
                operatorId: sub.id as string,
                props: sub.props as Record<string, unknown> | undefined,
                bounds: {
                  x: cursor.x,
                  y: cursor.y + (mi + 1) * (ITEM_HEIGHT + ITEM_PADDING),
                  width: w,
                  height: ITEM_HEIGHT,
                },
              })
            }
          }
          advance(cursor, step, isRow)
          break
        }
      }
    }
  }

  return result
}

/** Check if a rect contains a point */
export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height
}

/** Find the area+region at the given screen coordinates */
export function regionAt(
  screen: {
    areas: { regions: { bounds: Rect; visible: boolean; collapsed: boolean }[] }[]
    popupRegions: { bounds: Rect; visible: boolean; collapsed: boolean }[]
  },
  x: number,
  y: number,
): {
  area: { regions: { bounds: Rect; visible: boolean; collapsed: boolean }[] }
  region: { bounds: Rect; visible: boolean; collapsed: boolean }
} | null {
  for (const popup of screen.popupRegions) {
    if (popup.visible && !popup.collapsed && rectContains(popup.bounds, x, y)) {
      return {
        area: null as unknown as { regions: { bounds: Rect; visible: boolean; collapsed: boolean }[] },
        region: popup,
      }
    }
  }
  for (const area of screen.areas) {
    for (const region of area.regions) {
      if (region.visible && !region.collapsed && rectContains(region.bounds, x, y)) {
        return { area, region }
      }
    }
  }
  return null
}

/** Infer the UI widget type from a property descriptor */
export function widgetFor(prop: {
  uiWidget?: string
  type: string
  enumItems?: unknown[]
  min?: unknown
  max?: unknown
}): string {
  if (prop.uiWidget) return prop.uiWidget
  switch (prop.type) {
    case 'string':
      return prop.enumItems && prop.enumItems.length > 0 ? 'dropdown' : 'text'
    case 'number':
      return prop.min != null && prop.max != null ? 'slider' : 'number'
    case 'boolean':
      return 'checkbox'
    case 'color':
      return 'color'
    case 'enum':
      return 'dropdown'
    case 'vector3':
      return 'vector'
    default:
      return 'text'
  }
}
