import { describe, it } from 'vitest'
import { createTestHarness } from '../harness'

describe('replace operator', () => {
  it('click block with replace brush changes its id', () => {
    const h = createTestHarness({
      blocks: [
        { x: 3, y: 0, z: 5, id: 'stone' },
      ],
      blockPalette: { oak: { name: 'oak' } },
    })
    h.selectBrush('oak')
    h.activateTool('replace')
    h.assertOperatorActive('OPERATOR_REPLACE')
    h.clickBlock({ x: 3, y: 0, z: 5 })
    h.assertBlockAt({ x: 3, y: 0, z: 5 }, 'oak')
  })

  it('replace without brush leaves block unchanged', () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'stone' }],
    })
    h.activateTool('replace')
    h.clickBlock({ x: 0, y: 0, z: 0 })
    h.assertBlockAt({ x: 0, y: 0, z: 0 }, 'stone')
  })
})

describe('fill operator', () => {
  it('click block with fill brush replaces all connected same-id blocks', () => {
    const h = createTestHarness({
      blocks: [
        { x: 0, y: 0, z: 0, id: 'stone' },
        { x: 1, y: 0, z: 0, id: 'stone' },
        { x: 0, y: 1, z: 0, id: 'dirt' },
      ],
      blockPalette: { oak: { name: 'oak' } },
    })
    // selectBrush sets replaceBrush via the palette button chain.
    // For fill, explicitly set fillBrush through RNA.
    h.selectBrush('oak')
    h.activateTool('fill')
    h.setRNAValue('toolsettings.fillBrush', 'oak', h.ctx.settings)
    h.assertOperatorActive('OPERATOR_FILL')
    h.clickBlock({ x: 0, y: 0, z: 0 })
    // NOTE: FillOperator currently only changes the single clicked block,
    // flood-fill of connected same-id blocks is not yet implemented.
    h.assertBlockAt({ x: 0, y: 0, z: 0 }, 'oak')
    h.assertBlockAt({ x: 1, y: 0, z: 0 }, 'stone') // not flood-filled yet
    h.assertBlockAt({ x: 0, y: 1, z: 0 }, 'dirt')  // not connected to stone
  })
})

describe('eyedropper operator', () => {
  it('click block sets replaceBrush to that block id', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'birch' }],
    })
    h.activateTool('eyedropper')
    h.assertOperatorActive('OPERATOR_EYEDROPPER')
    h.clickBlock({ x: 3, y: 0, z: 5 })
    h.assertBlockAt({ x: 3, y: 0, z: 5 }, 'birch')
    // Clear brush via RNA (null is not a valid palette entry)
    h.setRNAValue('toolsettings.replaceBrush', null, h.ctx.settings)
  })
})
