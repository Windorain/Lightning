import type { BContext } from '@/workbench/context/bContext'
import type { bScreen, ScrArea, ARegion, Rect } from '../types/screen'
import { RegionType } from '../types/screen'

const HEADER_HEIGHT = 32
const FOOTER_HEIGHT = 24
const TOOLSHELF_WIDTH = 48
const PROPERTIES_WIDTH = 300

export function computeLayout(ctx: BContext, screen: bScreen): void {
  ctx.screen = screen
  for (const area of screen.areas) {
    layoutArea(area, screen.bounds)
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

export function boundsOf(ctx: BContext, id: string): Rect | null {
  for (const area of ctx.screen?.areas ?? []) {
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
