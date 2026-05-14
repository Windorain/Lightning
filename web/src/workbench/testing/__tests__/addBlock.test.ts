import { describe, it } from 'vitest'
import { createTestHarness } from '@/workbench/testing/harness'

describe('add block operator', () => {
  it('click top face → block placed above', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 3, id: 'stone' }],
    })
    h.setBrush('oak')

    h.activateTool('add-block')
    h.assertOperatorActive('OPERATOR_ADD_BLOCK')

    h.clickBlock({ x: 3, y: 0, z: 3 })

    h.assertBlockCount(2)
    h.assertBlockAt({ x: 3, y: 1, z: 3 }, 'oak')
  })

  it('click side face → block placed adjacent on that side', () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'stone' }],
    })
    h.setBrush('planks')

    h.activateTool('add-block')
    h.clickBlock({ x: 0, y: 0, z: 0 })

    h.assertBlockCount(2)
    const blocks = h.ctx.queries.getFrameBlocks()
    const hasNew = blocks.some(b =>
      (b.pos.x !== 0 || b.pos.y !== 0 || b.pos.z !== 0) && b.block_state_id === 'planks'
    )
    h.assert(hasNew, 'new block should be at adjacent position, not overlapping')
  })

  it('click empty space → block placed on ground (y=0)', () => {
    const h = createTestHarness({ blocks: [] })
    h.setBrush('dirt')

    h.activateTool('add-block')
    h.assertOperatorActive('OPERATOR_ADD_BLOCK')

    h.click(400, 300)

    h.assertBlockCount(1)
    const blocks = h.ctx.queries.getFrameBlocks()
    h.assert(blocks[0].pos.y === 0, 'block should be on ground (y=0)')
    h.assert(Number.isInteger(blocks[0].pos.x), 'x should be integer')
    h.assert(Number.isInteger(blocks[0].pos.z), 'z should be integer')
    h.assert(blocks[0].block_state_id === 'dirt', 'block should have brush id')
  })

  it('after placing, tool stays active for continued placement', () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'seed' }],
    })
    h.setBrush('stone')

    h.activateTool('add-block')
    h.clickBlock({ x: 0, y: 0, z: 0 })
    h.assertBlockCount(2)

    h.assertOperatorActive('OPERATOR_ADD_BLOCK')

    h.clickBlock({ x: 0, y: 0, z: 0 })
    h.assertBlockCount(3)
  })

  it('click without brush → cancelled, no block placed', () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'seed' }],
    })

    h.activateTool('add-block')
    const before = h.ctx.queries.getFrameBlocks().length
    h.clickBlock({ x: 0, y: 0, z: 0 })
    h.assertBlockCount(before)
  })
})
