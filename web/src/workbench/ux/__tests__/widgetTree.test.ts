import { describe, it, expect } from 'vitest'
import { computeWidgetRects } from '../layout/widgetTree'
import type { UILayout } from '../types/layout'

describe('computeWidgetRects', () => {
  it('lays out a column of items top-to-bottom', () => {
    const layout: UILayout = {
      kind: 'column', align: false, items: [
        { kind: 'operator', id: 'OP_A', label: 'A' },
        { kind: 'operator', id: 'OP_B', label: 'B' },
        { kind: 'operator', id: 'OP_C', label: 'C' },
      ],
    }
    const rects = computeWidgetRects(layout, { x: 0, y: 0, width: 200, height: 300 })

    expect(rects).toHaveLength(3)
    expect(rects[0].bounds.y).toBe(2)
    expect(rects[0].bounds.height).toBeGreaterThan(0)
    expect(rects[1].bounds.y).toBeGreaterThanOrEqual(rects[0].bounds.y + rects[0].bounds.height)
    expect(rects[2].bounds.y).toBeGreaterThanOrEqual(rects[1].bounds.y + rects[1].bounds.height)
    const lastBottom = rects[2].bounds.y + rects[2].bounds.height
    expect(lastBottom).toBeLessThanOrEqual(300)
  })

  it('lays out a row of items left-to-right', () => {
    const layout: UILayout = {
      kind: 'row', align: false, items: [
        { kind: 'operator', id: 'OP_X', label: 'X' },
        { kind: 'operator', id: 'OP_Y', label: 'Y' },
      ],
    }
    const rects = computeWidgetRects(layout, { x: 0, y: 0, width: 200, height: 50 })

    expect(rects).toHaveLength(2)
    expect(rects[0].bounds.x).toBe(2)
    expect(rects[1].bounds.x).toBeGreaterThanOrEqual(rects[0].bounds.x + rects[0].bounds.width)
  })

  it('lays out nested box containers', () => {
    const layout: UILayout = {
      kind: 'column', align: false, items: [
        { kind: 'label', text: 'Top' },
        {
          kind: 'box', label: 'Group', items: [
            { kind: 'operator', id: 'OP_INNER', label: 'Inner' },
          ],
        },
      ],
    }
    const rects = computeWidgetRects(layout, { x: 0, y: 0, width: 300, height: 400 })

    expect(rects.length).toBeGreaterThanOrEqual(2)
  })

  it('assigns incremental layoutIds to each widget', () => {
    const layout: UILayout = {
      kind: 'row', align: false, items: [
        { kind: 'operator', id: 'OP_1', label: '1' },
        { kind: 'separator' },
        { kind: 'operator', id: 'OP_2', label: '2' },
      ],
    }
    const rects = computeWidgetRects(layout, { x: 0, y: 0, width: 300, height: 50 }, 'test-panel')

    expect(rects[0].layoutId).toBe('test-panel.item-0')
    expect(rects[1].layoutId).toBeDefined()
    expect(rects[2].layoutId).toBe('test-panel.item-2')
  })

  it('handles empty layout', () => {
    const layout: UILayout = {
      kind: 'column', align: false, items: [],
    }
    const rects = computeWidgetRects(layout, { x: 0, y: 0, width: 200, height: 300 })
    expect(rects).toHaveLength(0)
  })
})
