import { describe, it } from 'vitest'
import { createTestHarness } from '@/workbench/testing/harness'

describe('add block operator', () => {
  it('click block face → new block placed adjacent with current brush', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 3, id: 'stone' }],
    })
    h.selectBrush('stone')

    h.activateTool('add-block')
    h.assertOperatorActive('OPERATOR_ADD_BLOCK')

    h.clickBlock({ x: 3, y: 0, z: 3 })

    h.assertBlockCount(2)
    h.assertBlockAt({ x: 3, y: 1, z: 3 }, 'stone')
  })

  it('click empty space → block placed on ground plane', () => {
    const h = createTestHarness({
      blocks: [],
      blockPalette: { dirt: { name: 'dirt' } },
    })
    h.selectBrush('dirt')

    h.activateTool('add-block')
    h.click(400, 300)

    h.assertBlockCount(1)
  })

  it('tool stays active after placement for continued use', () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'seed' }],
    })
    h.selectBrush('seed')

    h.activateTool('add-block')
    h.clickBlock({ x: 0, y: 0, z: 0 })
    h.assertBlockCount(2)

    h.assertOperatorActive('OPERATOR_ADD_BLOCK')

    h.clickBlock({ x: 0, y: 0, z: 0 })
    h.assertBlockCount(3)
  })

  it('click without brush → no block placed', () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'seed' }],
    })

    h.activateTool('add-block')
    h.assertBlockCount(1)

    h.clickBlock({ x: 0, y: 0, z: 0 })
    h.assertBlockCount(1)
  })
})
