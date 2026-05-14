import { describe, it, expect } from 'vitest'
import { createTestHarness } from '../harness'

describe('select operator', () => {
  it('click at projected block position selects that block', () => {
    const h = createTestHarness({
      blocks: [
        { x: 3, y: 0, z: 5, id: 'stone' },
        { x: 0, y: 0, z: 0, id: 'dirt' },
      ],
    })

    h.activateTool('select')
    h.assertOperatorActive('OPERATOR_SELECT')

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

  it('projectBlock round-trip: click at projection selects correct block', () => {
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
      h.click(0, 0) // clear selection by clicking empty
      h.clickBlock(pos)
      h.assertSelectionSize(1)
      h.assertSelectionContains(pos)
    }
  })

  it('projectBlock returns null for block far outside view', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })

    h.assertProjectBlockNull({ x: 1000, y: 1000, z: 1000 })
  })
})

describe('delete operator', () => {
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

describe('move operator — select path', () => {
  it('g key activates move, clickBlock selects block', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })

    h.activateTool('move')
    h.assertOperatorActive('OPERATOR_MOVE')

    h.clickBlock({ x: 3, y: 0, z: 5 })
    h.assertSelectionSize(1)
    h.assertBlockAt({ x: 3, y: 0, z: 5 })
  })

  it('move tool click empty clears selection', () => {
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

describe('move operator — gizmo drag', () => {
  it('dragWorld axis Y +1 → block moves toward +Y', () => {
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

  it('dragWorld axis Y -1 → block moves toward -Y', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 5, z: 5, id: 'stone' }],
    })

    h.clickBlock({ x: 3, y: 5, z: 5 })
    h.activateTool('move')
    h.dragWorld('y', -1)

    h.assertBlockAt({ x: 3, y: 4, z: 5 }, 'stone')
  })

  it('dragWorld axis X +1 → block moves toward +X', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })

    h.clickBlock({ x: 3, y: 0, z: 5 })
    h.activateTool('move')
    h.dragWorld('x', 1)

    h.assertBlockAt({ x: 4, y: 0, z: 5 }, 'stone')
  })

  it('dragWorld axis Z +1 → block moves toward +Z', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })

    h.clickBlock({ x: 3, y: 0, z: 5 })
    h.activateTool('move')
    h.dragWorld('z', 1)

    h.assertBlockAt({ x: 3, y: 0, z: 6 }, 'stone')
  })

  it('gizmo anchor null when nothing selected', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })

    h.activateTool('move')
    const anchor = h.ctx.queries.getGizmoAnchor('y')
    h.assert(anchor === null, 'gizmo anchor should be null when nothing selected')
  })
})

describe('generate operator', () => {
  it('activate generate with brush, click block → new block placed', () => {
    const h = createTestHarness({
      blocks: [{ x: 2, y: 0, z: 2, id: 'seed' }],
    })
    h.setBrush('stone')

    h.activateTool('generate')
    h.assertOperatorActive('OPERATOR_GENERATE')

    h.clickBlock({ x: 2, y: 0, z: 2 })
    h.assertBlockCount(2)
  })

  it('generate places block when clicking empty space', () => {
    const h = createTestHarness({ blocks: [] })
    h.setBrush('stone')

    h.activateTool('generate')
    h.assertOperatorActive('OPERATOR_GENERATE')

    h.click(400, 300)
    h.assertBlockCount(1)
  })

  it('generate → select → delete full cycle', () => {
    const h = createTestHarness({
      blocks: [
        { x: 0, y: 0, z: 0, id: 'seed-a' },
        { x: 2, y: 0, z: 2, id: 'seed-b' },
      ],
    })
    h.setBrush('placed')

    h.activateTool('generate')
    h.clickBlock({ x: 0, y: 0, z: 0 })
    h.assertBlockCount(3)

    h.activateTool('select')
    h.clickBlock({ x: 0, y: 0, z: 0 })
    h.assertSelectionSize(1)

    h.activateTool('delete')
    h.click(400, 300)
    h.assertBlockCount(1)
    h.assertBlockAt({ x: 2, y: 0, z: 2 }, 'seed-b')
    h.assertBlockNotAt({ x: 0, y: 0, z: 0 })
  })
})

describe('multi-selection', () => {
  it('ctrl+click two separated blocks → both selected', () => {
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

  it('clear selection via operator after multi-select', () => {
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

describe('edge cases', () => {
  it('click on overlapping blocks picks nearer one (ray-AABB nearest t)', () => {
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

  it('assertBlockNotAt fails when block exists at position', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })

    expect(() => h.assertBlockNotAt({ x: 3, y: 0, z: 5 })).toThrow()
    expect(() => h.assertBlockNotAt({ x: 99, y: 0, z: 0 })).not.toThrow()
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

describe('event injection safety', () => {
  it('injects pointer and keyboard events without crashing', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })

    expect(() => h.pointerDown(100, 100)).not.toThrow()
    expect(() => h.pointerMove(110, 100)).not.toThrow()
    expect(() => h.pointerUp(110, 100)).not.toThrow()
    expect(() => h.click(100, 100)).not.toThrow()
    expect(() => h.drag(100, 100, 200, 200, { steps: 3 })).not.toThrow()
    expect(() => h.activateTool('select')).not.toThrow()
    expect(() => h.activateTool('move')).not.toThrow()
    expect(() => h.activateTool('delete')).not.toThrow()
  })

  it('assert throws on false condition', () => {
    const h = createTestHarness()
    expect(() => h.assert(true, 'ok')).not.toThrow()
    expect(() => h.assert(false, 'fail')).toThrow('fail')
  })

  it('assertBlockAt matches block by position and optionally id', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })

    expect(() => h.assertBlockAt({ x: 3, y: 0, z: 5 })).not.toThrow()
    expect(() => h.assertBlockAt({ x: 3, y: 0, z: 5 }, 'stone')).not.toThrow()
    expect(() => h.assertBlockAt({ x: 3, y: 0, z: 5 }, 'dirt')).toThrow()
    expect(() => h.assertBlockAt({ x: 99, y: 99, z: 99 })).toThrow()
  })
})

describe('RNA registry', () => {
  it('resolves block.id through mock', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })

    const desc = h.assertRNAPath('block.id')
    h.assert(desc.type === 'string', 'block.id type should be string')
    h.assert(desc.label === '方块标识', 'block.id label should be 方块标识')
  })
})

describe('semantic L2 actions', () => {
  it('activateTool dispatches key event through full chain', () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'x' }],
    })

    h.activateTool('select')
    h.assertOperatorActive('OPERATOR_SELECT')

    h.activateTool('generate')
    h.assertOperatorActive('OPERATOR_GENERATE')
  })

  it('setBrush sets brush via RNA path', () => {
    const h = createTestHarness({ blocks: [] })
    h.setBrush('oak')
    h.assert(h.ctx.settings.replaceBrush === 'oak', 'replaceBrush should be oak')
  })

  it('clickBlock selects block at world position', () => {
    const h = createTestHarness({
      blocks: [
        { x: 5, y: 0, z: 0, id: 'target' },
        { x: 0, y: 0, z: 5, id: 'other' },
      ],
    })

    h.clickBlock({ x: 5, y: 0, z: 0 })
    h.assertSelectionSize(1)
    h.assertSelectionContains({ x: 5, y: 0, z: 0 })
  })
})

describe('batch collect mode', () => {
  it('collect returns all check results without throwing', () => {
    const h = createTestHarness({
      blocks: [
        { x: 0, y: 0, z: 0, id: 'a' },
        { x: 1, y: 0, z: 0, id: 'b' },
      ],
    })

    h.clickBlock({ x: 0, y: 0, z: 0 })
    h.assertSelectionSize(1)

    // Batch collect — none throw, collects all results
    const results = h.collect()
      .check('selection size is 2', () => h.ctx.selection.items.value.size === 2, 2, () => h.ctx.selection.items.value.size)
      .check('block count is 2', () => h.ctx.queries.getFrameBlocks().length === 2, 2, () => h.ctx.queries.getFrameBlocks().length)
      .check('selection size is 1', () => h.ctx.selection.items.value.size === 1, 1, () => h.ctx.selection.items.value.size)
      .done()

    // First two fail, third passes
    expect(results).toHaveLength(3)
    expect(results[0].pass).toBe(false) // selection size expected 2, got 1
    expect(results[1].pass).toBe(true)  // block count is 2
    expect(results[2].pass).toBe(true)  // selection size is 1
  })
})
