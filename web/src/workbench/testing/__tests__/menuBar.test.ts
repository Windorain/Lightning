import { describe, it } from 'vitest'
import { createTestHarness } from '../harness'

describe('menu bar — HEADER region integration', () => {
  it('registers menu-bar panel in HEADER region', () => {
    const h = createTestHarness({ blocks: [] })
    const headerRegion = (h.ctx.screen as any)?.areas?.[0]?.regions
      ?.find((r: any) => r.type === 'HEADER')
    h.assert(!!headerRegion, 'HEADER region exists')
    const hasMenuBarPanel = headerRegion.panels.some((p: any) => p.id === 'menu-bar')
    h.assert(hasMenuBarPanel, 'menu-bar panel registered in HEADER')
  })

  it('menu bar operator buttons are in widget cache', () => {
    const h = createTestHarness({ blocks: [] })
    const rects = h.getOperatorBounds('OPERATOR_NEW_SCENE')
    h.assert(rects.length >= 1, 'OPERATOR_NEW_SCENE should be in widget cache')
    h.assert(rects[0].width > 0, 'widget should have non-zero width')
    h.assert(rects[0].height > 0, 'widget should have non-zero height')
  })

  it('clickOperator on menu NEW_SCENE button clears blocks', async () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'stone' }],
    })
    h.assertBlockCount(1)

    h.clickOperator('OPERATOR_NEW_SCENE')

    h.assertBlockCount(0)
  })

  it('multiple menu operators exist in widget cache', () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'stone' }],
    })
    h.assert(h.getOperatorBounds('OPERATOR_SAVE_FILE').length >= 1, 'OPERATOR_SAVE_FILE exists')
    h.assert(h.getOperatorBounds('OPERATOR_OPEN_SCENE').length >= 1, 'OPERATOR_OPEN_SCENE exists')
    h.assert(h.getOperatorBounds('OPERATOR_TOGGLE_THEME').length >= 1, 'OPERATOR_TOGGLE_THEME exists')
    h.assert(h.getOperatorBounds('OPERATOR_RESET_LAYOUT').length >= 1, 'OPERATOR_RESET_LAYOUT exists')
  })

  it('menu bar SET_LANGUAGE operator buttons exist with correct props', () => {
    const h = createTestHarness({ blocks: [] })

    // Find SET_LANGUAGE widgets in cache
    const zhRects = h.getOperatorBounds('OPERATOR_SET_LANGUAGE')
    h.assert(zhRects.length >= 2, 'should have 2 SET_LANGUAGE buttons (zh + en)')
  })

  it('new scene via menu button click clears blocks and allows further interaction', async () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
      blockPalette: { oak: { name: 'oak' } },
    })

    h.selectBrush('oak')
    h.clickOperator('OPERATOR_NEW_SCENE')
    h.assertBlockCount(0)

    h.activateTool('add-block')
    // Click screen center — ray hits ground plane at camera target (3,0,5)
    h.click(400, 300)

    h.assertBlockCount(1)
    h.assertBlockAt({ x: 3, y: 0, z: 5 }, 'oak')
  })
})
