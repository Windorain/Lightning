import { describe, it, expect } from 'vitest'
import { computeLayout, regionAt, boundsOf } from '../layout/engine'
import { SpaceType, RegionType, type bScreen, type ScrArea, type ARegion } from '../types/screen'
import type { PanelDeclaration } from '../types/panel'
import type { UILayout } from '../types/layout'
import type { BContext } from '@/workbench/context/bContext'

function mockBctx(): BContext {
  return {
    selection: { items: { value: new Set() } },
    scene: { scene: { value: {} } },
  } as unknown as BContext
}

function dummyPanel(id: string, items: UILayout['items']): PanelDeclaration {
  return {
    id, label: id, spaceType: SpaceType.PROPERTIES, regionType: RegionType.MAIN,
    poll: () => true,
    layout: () => ({ kind: 'column', align: false, items: items as any[] }),
  }
}

function makeScreen(areas: ScrArea[]): bScreen {
  return { id: 'test-screen', areas, popupRegions: [], bounds: { width: 1400, height: 800 } }
}

describe('computeLayout', () => {
  it('assigns bounds to a single full-screen area', () => {
    const area: ScrArea = {
      id: 'a1', spaceType: SpaceType.VIEW_3D, splitDir: 'none', parentArea: null,
      regions: [
        { id: 'r1', type: RegionType.MAIN, panels: [], visible: true, collapsed: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, handlers: [] },
      ],
    }
    const screen = makeScreen([area])
    const ctx = mockBctx()

    computeLayout(ctx, screen)

    expect(area.regions[0].bounds).toEqual({ x: 0, y: 0, width: 1400, height: 800 })
  })

  it('partitions area into HEADER (top 32px), MAIN (rest), FOOTER (bottom 24px)', () => {
    const area: ScrArea = {
      id: 'a1', spaceType: SpaceType.VIEW_3D, splitDir: 'none', parentArea: null,
      regions: [
        { id: 'r-header', type: RegionType.HEADER, panels: [], visible: true, collapsed: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, handlers: [] },
        { id: 'r-main', type: RegionType.MAIN, panels: [], visible: true, collapsed: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, handlers: [] },
        { id: 'r-footer', type: RegionType.FOOTER, panels: [], visible: true, collapsed: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, handlers: [] },
      ],
    }
    const screen = makeScreen([area])
    const ctx = mockBctx()

    computeLayout(ctx, screen)

    expect(area.regions.find(r => r.type === RegionType.HEADER)!.bounds)
      .toEqual({ x: 0, y: 0, width: 1400, height: 32 })
    expect(area.regions.find(r => r.type === RegionType.MAIN)!.bounds)
      .toEqual({ x: 0, y: 32, width: 1400, height: 744 })
    expect(area.regions.find(r => r.type === RegionType.FOOTER)!.bounds)
      .toEqual({ x: 0, y: 776, width: 1400, height: 24 })
  })

  it('partitions area with TOOLSHELF (left 48px), MAIN (rest), PROPERTIES (right 300px)', () => {
    const area: ScrArea = {
      id: 'a1', spaceType: SpaceType.VIEW_3D, splitDir: 'none', parentArea: null,
      regions: [
        { id: 'r-toolshelf', type: RegionType.TOOLSHELF, panels: [], visible: true, collapsed: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, handlers: [] },
        { id: 'r-main', type: RegionType.MAIN, panels: [], visible: true, collapsed: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, handlers: [] },
        { id: 'r-properties', type: RegionType.PROPERTIES, panels: [], visible: true, collapsed: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, handlers: [] },
      ],
    }
    const screen = makeScreen([area])
    const ctx = mockBctx()

    computeLayout(ctx, screen)

    expect(area.regions.find(r => r.type === RegionType.TOOLSHELF)!.bounds)
      .toEqual({ x: 0, y: 0, width: 48, height: 800 })
    expect(area.regions.find(r => r.type === RegionType.MAIN)!.bounds)
      .toEqual({ x: 48, y: 0, width: 1052, height: 800 })
    expect(area.regions.find(r => r.type === RegionType.PROPERTIES)!.bounds)
      .toEqual({ x: 1100, y: 0, width: 300, height: 800 })
  })

  it('collapsed regions get zero size', () => {
    const area: ScrArea = {
      id: 'a1', spaceType: SpaceType.VIEW_3D, splitDir: 'none', parentArea: null,
      regions: [
        { id: 'r-toolshelf', type: RegionType.TOOLSHELF, panels: [], visible: true, collapsed: true, bounds: { x: 0, y: 0, width: 0, height: 0 }, handlers: [] },
        { id: 'r-main', type: RegionType.MAIN, panels: [], visible: true, collapsed: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, handlers: [] },
      ],
    }
    const screen = makeScreen([area])
    const ctx = mockBctx()

    computeLayout(ctx, screen)

    expect(area.regions.find(r => r.type === RegionType.TOOLSHELF)!.bounds.width).toBe(0)
    expect(area.regions.find(r => r.type === RegionType.MAIN)!.bounds)
      .toEqual({ x: 0, y: 0, width: 1400, height: 800 })
  })
})

describe('regionAt', () => {
  it('returns the correct area and region for a given point', () => {
    const area: ScrArea = {
      id: 'a1', spaceType: SpaceType.VIEW_3D, splitDir: 'none', parentArea: null,
      regions: [
        { id: 'r-header', type: RegionType.HEADER, panels: [], visible: true, collapsed: false, bounds: { x: 0, y: 0, width: 1400, height: 32 }, handlers: [] },
        { id: 'r-main', type: RegionType.MAIN, panels: [], visible: true, collapsed: false, bounds: { x: 0, y: 32, width: 1400, height: 768 }, handlers: [] },
      ],
    }
    const screen = makeScreen([area])

    const header = regionAt(screen, 100, 16)
    expect(header?.region.type).toBe(RegionType.HEADER)

    const main = regionAt(screen, 700, 400)
    expect(main?.region.type).toBe(RegionType.MAIN)
  })

  it('returns null for coordinates outside all regions', () => {
    const area: ScrArea = {
      id: 'a1', spaceType: SpaceType.VIEW_3D, splitDir: 'none', parentArea: null,
      regions: [
        { id: 'r-main', type: RegionType.MAIN, panels: [], visible: true, collapsed: false, bounds: { x: 0, y: 0, width: 500, height: 400 }, handlers: [] },
      ],
    }
    const screen = makeScreen([area])

    expect(regionAt(screen, 600, 100)).toBeNull()
  })
})

describe('boundsOf', () => {
  it('finds widget bounds by panel id', () => {
    const panel = dummyPanel('test-panel', [
      { kind: 'operator', id: 'OP_FOO', label: 'Foo' },
    ])
    const area: ScrArea = {
      id: 'a1', spaceType: SpaceType.PROPERTIES, splitDir: 'none', parentArea: null,
      regions: [
        { id: 'r-main', type: RegionType.MAIN, panels: [panel], visible: true, collapsed: false, bounds: { x: 0, y: 0, width: 300, height: 500 }, handlers: [] },
      ],
    }
    const screen = makeScreen([area])
    const ctx = mockBctx()

    computeLayout(ctx, screen)

    const b = boundsOf(ctx, 'test-panel')
    expect(b).not.toBeNull()
    expect(b!.width).toBeGreaterThan(0)
    expect(b!.height).toBeGreaterThan(0)
  })
})
