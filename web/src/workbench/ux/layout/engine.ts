import type { BContext } from '@/workbench/context/bContext'
import type { bScreen, ScrArea, ARegion, Rect } from '../types/screen'
import { RegionType } from '../types/screen'
import { computeWidgetRects, type WidgetRect } from './widgetTree'

export const HEADER_HEIGHT = 32
export const FOOTER_HEIGHT = 24
export const TOOLSHELF_WIDTH = 48
export const PROPERTIES_WIDTH = 300

/** Layout-id → WidgetRect cache, populated by computeLayout via computeWidgetRects */
const widgetCache = new Map<string, WidgetRect>()

export function clearWidgetCache(): void {
  widgetCache.clear()
}

export function computeLayout(ctx: BContext, screen: bScreen): void {
  ctx.screen = screen
  clearWidgetCache()

  for (const area of screen.areas) {
    layoutArea(area, screen.bounds)
  }

  // Popup regions — stack from top
  for (const popup of screen.popupRegions) {
    if (!popup.visible) continue
    popup.bounds = { x: 0, y: 0, width: screen.bounds.width, height: screen.bounds.height }
  }

  // Compute widget rects for each panel and cache by layoutId + panel.id
  for (const area of screen.areas) {
    for (const region of area.regions) {
      for (const panel of region.panels) {
        if (!panel.poll(ctx)) continue
        const layout = panel.layout(ctx)
        const rects = computeWidgetRects(layout, region.bounds, panel.id)
        for (const r of rects) {
          widgetCache.set(r.layoutId, r)
        }
        // Also cache by panel id for coarse-grained lookup
        if (!widgetCache.has(panel.id)) {
          widgetCache.set(panel.id, { layoutId: panel.id, kind: 'panel', bounds: { ...region.bounds } })
        }
      }
    }
  }
}

function layoutArea(area: ScrArea, screenBounds: { width: number; height: number }): void {
  const header = area.regions.find(r => r.type === RegionType.HEADER)
  const footer = area.regions.find(r => r.type === RegionType.FOOTER)
  const toolshelf = area.regions.find(r => r.type === RegionType.TOOLSHELF)
  const properties = area.regions.find(r => r.type === RegionType.PROPERTIES)
  const main = area.regions.find(r => r.type === RegionType.MAIN)

  let top = 0
  let bottom = screenBounds.height
  let left = 0
  let right = screenBounds.width

  if (header && header.visible && !header.collapsed) {
    header.bounds = { x: left, y: top, width: right - left, height: HEADER_HEIGHT }
    top += HEADER_HEIGHT
  }

  if (footer && footer.visible && !footer.collapsed) {
    const h = FOOTER_HEIGHT
    footer.bounds = { x: left, y: bottom - h, width: right - left, height: h }
    bottom -= h
  }

  if (toolshelf && toolshelf.visible && !toolshelf.collapsed) {
    toolshelf.bounds = { x: left, y: top, width: TOOLSHELF_WIDTH, height: bottom - top }
    left += TOOLSHELF_WIDTH
  }

  if (properties && properties.visible && !properties.collapsed) {
    properties.bounds = { x: right - PROPERTIES_WIDTH, y: top, width: PROPERTIES_WIDTH, height: bottom - top }
    right -= PROPERTIES_WIDTH
  }

  if (main && main.visible && !main.collapsed) {
    main.bounds = { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
  }
}

export function regionAt(
  screen: bScreen,
  x: number,
  y: number,
): { area: ScrArea; region: ARegion } | null {
  for (const popup of screen.popupRegions) {
    if (popup.visible && !popup.collapsed && rectContains(popup.bounds, x, y)) {
      return { area: null as unknown as ScrArea, region: popup }
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

/** Get the computed bounds for a widget or panel by its id (layoutId or panel id). */
export function boundsOf(_ctx: BContext, id: string): Rect | null {
  const cached = widgetCache.get(id)
  if (cached) return { ...cached.bounds }

  // Fallback: search region panels
  for (const area of _ctx.screen?.areas ?? []) {
    for (const region of area.regions) {
      for (const panel of region.panels) {
        if (panel.id === id) {
          return { ...region.bounds }
        }
      }
    }
  }
  return null
}

export function relayout(ctx: BContext): void {
  if (ctx.screen) computeLayout(ctx, ctx.screen)
}

function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height
}
