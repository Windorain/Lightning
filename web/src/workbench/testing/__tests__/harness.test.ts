import { describe, it } from 'vitest'
import { createTestHarness } from '../harness'

describe('select', () => {
  it('click block selects it', () => {
    const h = createTestHarness({
      blocks: [
        { x: 3, y: 0, z: 5, id: 'stone' },
        { x: 0, y: 0, z: 0, id: 'dirt' },
      ],
    })

    h.clickBlock({ x: 3, y: 0, z: 5 })
    h.assertSelectionSize(1)
    h.assertSelectionContains({ x: 3, y: 0, z: 5 })
  })

  it('click empty space clears selection', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })

    h.clickBlock({ x: 3, y: 0, z: 5 })
    h.assertSelectionSize(1)

    h.click(0, 0)
    h.assertSelectionSize(0)
  })

  it('ctrl+click adds to multi-selection', () => {
    const h = createTestHarness({
      blocks: [
        { x: 3, y: 0, z: 5, id: 'stone' },
        { x: 0, y: 0, z: 0, id: 'dirt' },
      ],
    })

    h.clickBlock({ x: 3, y: 0, z: 5 })
    h.assertSelectionSize(1)

    h.clickBlock({ x: 0, y: 0, z: 0 }, { ctrl: true })
    h.assertSelectionSize(2)
    h.assertSelectionContains({ x: 3, y: 0, z: 5 })
    h.assertSelectionContains({ x: 0, y: 0, z: 0 })
  })

  it('click on each of multiple blocks selects the right one', () => {
    const h = createTestHarness({
      blocks: [
        { x: -1, y: 2, z: 3, id: 'oak' },
        { x: 5, y: -2, z: 0, id: 'birch' },
        { x: 0, y: 0, z: 10, id: 'spruce' },
      ],
    })

    for (const pos of [
      { x: -1, y: 2, z: 3 },
      { x: 5, y: -2, z: 0 },
      { x: 0, y: 0, z: 10 },
    ]) {
      h.clickBlock(pos)
      h.assertSelectionSize(1)
      h.assertSelectionContains(pos)
    }
  })

  it('block far outside view cannot be clicked', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })

    h.assertProjectBlockNull({ x: 1000, y: 1000, z: 1000 })
  })
})

describe('delete', () => {
  it('select then delete removes selected block', () => {
    const h = createTestHarness({
      blocks: [
        { x: 3, y: 0, z: 5, id: 'stone' },
        { x: 0, y: 0, z: 0, id: 'dirt' },
      ],
    })

    h.clickBlock({ x: 3, y: 0, z: 5 })
    h.assertBlockCount(2)

    h.activateTool('delete')
    h.assertOperatorActive('OPERATOR_DELETE')
    h.click(400, 300)

    h.assertSelectionSize(0)
    h.assertBlockCount(1)
    h.assertBlockAt({ x: 0, y: 0, z: 0 }, 'dirt')
    h.assertBlockNotAt({ x: 3, y: 0, z: 5 })
  })

  it('delete with nothing selected leaves scene unchanged', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })

    h.activateTool('delete')
    h.click(400, 300)
    h.assertBlockCount(1)
    h.assertSelectionSize(0)
  })
})

describe('move', () => {
  it('click + dragWorld moves block along Y', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })

    h.clickBlock({ x: 3, y: 0, z: 5 })
    h.assertSelectionSize(1)

    h.activateTool('move')
    h.assertOperatorActive('OPERATOR_MOVE')
    h.dragWorld('y', 1)

    h.assertBlockAt({ x: 3, y: 1, z: 5 }, 'stone')
    h.assertBlockCount(1)
  })

  it('dragWorld Y- moves toward -Y', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 5, z: 5, id: 'stone' }],
    })

    h.clickBlock({ x: 3, y: 5, z: 5 })
    h.activateTool('move')
    h.dragWorld('y', -1)

    h.assertBlockAt({ x: 3, y: 4, z: 5 }, 'stone')
  })

  it('dragWorld X+ moves toward +X', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })

    h.clickBlock({ x: 3, y: 0, z: 5 })
    h.activateTool('move')
    h.dragWorld('x', 1)

    h.assertBlockAt({ x: 4, y: 0, z: 5 }, 'stone')
  })

  it('dragWorld Z+ moves toward +Z', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })

    h.clickBlock({ x: 3, y: 0, z: 5 })
    h.activateTool('move')
    h.dragWorld('z', 1)

    h.assertBlockAt({ x: 3, y: 0, z: 6 }, 'stone')
  })

  it('click empty deselects in move mode', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })

    h.activateTool('move')
    h.clickBlock({ x: 3, y: 0, z: 5 })
    h.assertSelectionSize(1)

    h.click(0, 0)
    h.assertSelectionSize(0)
  })
})

describe('multi-selection', () => {
  it('ctrl+click two separated blocks selects both', () => {
    const h = createTestHarness({
      blocks: [
        { x: 0, y: 0, z: 5, id: 'a' },
        { x: 5, y: 0, z: 5, id: 'b' },
      ],
    })

    h.clickBlock({ x: 0, y: 0, z: 5 })
    h.clickBlock({ x: 5, y: 0, z: 5 }, { ctrl: true })

    h.assertSelectionSize(2)
    h.assertSelectionContains({ x: 0, y: 0, z: 5 })
    h.assertSelectionContains({ x: 5, y: 0, z: 5 })
  })

  it('click empty clears multi-selection', () => {
    const h = createTestHarness({
      blocks: [
        { x: 0, y: 0, z: 0, id: 'x' },
        { x: 5, y: 0, z: 0, id: 'y' },
      ],
    })

    h.clickBlock({ x: 0, y: 0, z: 0 })
    h.clickBlock({ x: 5, y: 0, z: 0 }, { ctrl: true })
    h.assertSelectionSize(2)

    h.click(799, 599)
    h.assertSelectionSize(0)
  })
})

describe('keyboard tool switching', () => {
  it('b→select, g→move, x→delete, back to select', () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'x' }],
    })

    h.activateTool('select')
    h.assertOperatorActive('OPERATOR_SELECT')

    h.activateTool('move')
    h.assertOperatorActive('OPERATOR_MOVE')

    h.activateTool('delete')
    h.assertOperatorActive('OPERATOR_DELETE')

    h.activateTool('select')
    h.assertOperatorActive('OPERATOR_SELECT')
  })
})

describe('block overlapping', () => {
  it('click on overlapping blocks picks nearer one', () => {
    const h = createTestHarness({
      blocks: [
        { x: 0, y: 0, z: 0, id: 'near' },
        { x: 0, y: 0, z: 2, id: 'far' },
      ],
    })

    h.clickBlock({ x: 0, y: 0, z: 0 })
    h.assertSelectionSize(1)
    h.assertSelectionContains({ x: 0, y: 0, z: 0 })
  })
})

describe('RNA registry', () => {
  it('resolves block.id type and label', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })

    const desc = h.assertRNAPath('block.id')
    h.assert(desc.type === 'string', 'block.id type should be string')
    h.assert(desc.label === '方块标识', 'block.id label should be 方块标识')
  })
})

describe('batch collect', () => {
  it('collect returns all check results without throwing', () => {
    const h = createTestHarness({
      blocks: [
        { x: 0, y: 0, z: 0, id: 'a' },
        { x: 1, y: 0, z: 0, id: 'b' },
      ],
    })

    h.clickBlock({ x: 0, y: 0, z: 0 })
    h.assertSelectionSize(1)

    const results = h.collect()
      .check('block count is 2', () => { try { h.assertBlockCount(2); return true } catch { return false } }, 2)
      .check('block count is 1', () => { try { h.assertBlockCount(1); return true } catch { return false } }, 1)
      .check('selection size is 1', () => { try { h.assertSelectionSize(1); return true } catch { return false } }, 1)
      .done()

    h.assert(results.length === 3, 'should return 3 results')
    h.assert(results[0].pass === true, 'block count 2 should pass')
    h.assert(results[1].pass === false, 'block count 1 should fail')
    h.assert(results[2].pass === true, 'selection size 1 should pass')
  })
})

describe('cross-tool workflow', () => {
  it('add-block → select → delete full cycle', () => {
    const h = createTestHarness({
      blocks: [
        { x: 0, y: 0, z: 0, id: 'seed-a' },
        { x: 2, y: 0, z: 2, id: 'seed-b' },
      ],
    })
    h.setBrush('placed')

    h.activateTool('add-block')
    h.clickBlock({ x: 0, y: 0, z: 0 })
    h.assertBlockCount(3)

    h.activateTool('select')
    h.clickBlock({ x: 0, y: 0, z: 0 })
    h.assertSelectionSize(1)

    h.activateTool('delete')
    h.click(400, 300)
    h.assertBlockCount(2)
    h.assertBlockAt({ x: 2, y: 0, z: 2 }, 'seed-b')
    h.assertBlockNotAt({ x: 0, y: 0, z: 0 })
  })
})
