import { describe, it, expect } from 'vitest'
import { createTestHarness } from '../harness'

/* —— helper —— */
function selectBlock(h: ReturnType<typeof createTestHarness>, pos: { x: number; y: number; z: number }) {
  h.keyDown('b')
  const p = h.ctx.queries.projectBlock(pos)
  h.click(p!.x, p!.y)
}

describe('select operator', () => {
  it('click at projected block position selects that block', () => {
    const h = createTestHarness({
      blocks: [
        { x: 3, y: 0, z: 5, id: 'stone' },
        { x: 0, y: 0, z: 0, id: 'dirt' },
      ],
    })

    h.keyDown('b')
    h.assertOperatorActive('OPERATOR_SELECT')

    selectBlock(h, { x: 3, y: 0, z: 5 })
    h.assertSelectionSize(1)
    h.assertSelectionContains({ x: 3, y: 0, z: 5 })
  })

  it('click empty space clears selection', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })

    selectBlock(h, { x: 3, y: 0, z: 5 })
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

    h.keyDown('b')
    selectBlock(h, { x: 3, y: 0, z: 5 })
    h.assertSelectionSize(1)

    // Ctrl+click second block
    const p2 = h.ctx.queries.projectBlock({ x: 0, y: 0, z: 0 })
    h.click(p2!.x, p2!.y, { ctrl: true })
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

    h.keyDown('b')

    for (const pos of [
      { x: -1, y: 2, z: 3 },
      { x: 5, y: -2, z: 0 },
      { x: 0, y: 0, z: 10 },
    ]) {
      h.ctx.selection.clear()
      selectBlock(h, pos)
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

    selectBlock(h, { x: 3, y: 0, z: 5 })
    h.assertBlockCount(2)

    h.keyDown('x')
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

    h.keyDown('x')
    h.click(400, 300)
    h.assertBlockCount(1)
    h.assertSelectionSize(0)
  })
})

describe('move operator — select path', () => {
  it('keyDown g activates move, click selects block', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })

    h.keyDown('g')
    h.assertOperatorActive('OPERATOR_MOVE')

    selectBlock(h, { x: 3, y: 0, z: 5 })
    h.assertSelectionSize(1)
    h.assertBlockAt({ x: 3, y: 0, z: 5 })
  })

  it('move tool click empty clears selection', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })

    h.keyDown('g')
    selectBlock(h, { x: 3, y: 0, z: 5 })
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

    h.keyDown('b')
    selectBlock(h, { x: 3, y: 0, z: 5 })
    h.assertSelectionSize(1)

    h.keyDown('g')
    h.assertOperatorActive('OPERATOR_MOVE')
    h.dragWorld('y', 1)

    h.assertBlockAt({ x: 3, y: 1, z: 5 }, 'stone')
    h.assertBlockCount(1)
  })

  it('dragWorld axis Y -1 → block moves toward -Y', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 5, z: 5, id: 'stone' }],
    })

    h.keyDown('b')
    selectBlock(h, { x: 3, y: 5, z: 5 })

    h.keyDown('g')
    h.dragWorld('y', -1)

    h.assertBlockAt({ x: 3, y: 4, z: 5 }, 'stone')
  })

  it('dragWorld axis X +1 → block moves toward +X', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })

    h.keyDown('b')
    selectBlock(h, { x: 3, y: 0, z: 5 })

    h.keyDown('g')
    h.dragWorld('x', 1)

    h.assertBlockAt({ x: 4, y: 0, z: 5 }, 'stone')
  })

  it('dragWorld axis Z +1 → block moves toward +Z', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })

    h.keyDown('b')
    selectBlock(h, { x: 3, y: 0, z: 5 })

    h.keyDown('g')
    h.dragWorld('z', 1)

    h.assertBlockAt({ x: 3, y: 0, z: 6 }, 'stone')
  })

  it('gizmo anchor null when nothing selected', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })

    h.keyDown('g')
    const anchor = h.ctx.queries.getGizmoAnchor('y')
    h.assert(anchor === null, 'gizmo anchor should be null when nothing selected')
  })
})

describe('generate operator', () => {
  it('activate generate with brush, click block → new block placed', () => {
    const h = createTestHarness({
      blocks: [{ x: 2, y: 0, z: 2, id: 'seed' }],
    })
    h.setRNAValue('toolsettings.replaceBrush', 'stone', h.ctx.settings)

    h.keyDown('a', { shift: true })
    h.assertOperatorActive('OPERATOR_GENERATE')

    // click with generate tool active → places brush block
    const p = h.ctx.queries.projectBlock({ x: 2, y: 0, z: 2 })
    h.click(p!.x, p!.y)
    h.assertBlockCount(2)
  })

  it('generate places block when clicking empty space', () => {
    const h = createTestHarness({
      blocks: [],
    })
    h.setRNAValue('toolsettings.replaceBrush', 'stone', h.ctx.settings)

    h.keyDown('a', { shift: true })
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
    h.setRNAValue('toolsettings.replaceBrush', 'placed', h.ctx.settings)

    // Generate at seed-a position
    h.keyDown('a', { shift: true })
    const p = h.ctx.queries.projectBlock({ x: 0, y: 0, z: 0 })
    h.click(p!.x, p!.y)
    h.assertBlockCount(3)

    // Select at that position
    selectBlock(h, { x: 0, y: 0, z: 0 })
    h.assertSelectionSize(1)

    // Delete — removes all blocks at position (0,0,0)
    h.keyDown('x')
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

    selectBlock(h, { x: 0, y: 0, z: 5 })

    const p = h.ctx.queries.projectBlock({ x: 5, y: 0, z: 5 })
    h.click(p!.x, p!.y, { ctrl: true })

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

    selectBlock(h, { x: 0, y: 0, z: 0 })
    const p = h.ctx.queries.projectBlock({ x: 5, y: 0, z: 0 })
    h.click(p!.x, p!.y, { ctrl: true })
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

    selectBlock(h, { x: 0, y: 0, z: 0 })
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

    h.keyDown('b')
    h.assertOperatorActive('OPERATOR_SELECT')

    h.keyDown('g')
    h.assertOperatorActive('OPERATOR_MOVE')

    h.keyDown('x')
    h.assertOperatorActive('OPERATOR_DELETE')

    h.keyDown('b')
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
    expect(() => h.keyDown('b')).not.toThrow()
    expect(() => h.keyDown('g')).not.toThrow()
    expect(() => h.keyDown('x')).not.toThrow()
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
