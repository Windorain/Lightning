import { describe, it } from 'vitest'
import { createTestHarness } from '../harness'

describe('undo / redo', () => {
  it('delete then undo restores block', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })
    h.clickBlock({ x: 3, y: 0, z: 5 })
    h.assertSelectionSize(1)

    h.activateTool('delete')
    h.click(400, 300)
    h.assertBlockCount(0)

    h.keyDown('z', { ctrl: true })
    h.assertBlockCount(1)
    h.assertBlockAt({ x: 3, y: 0, z: 5 }, 'stone')
  })

  it('undo then redo restores deleted state', () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'dirt' }],
    })
    h.clickBlock({ x: 0, y: 0, z: 0 })
    h.activateTool('delete')
    h.click(400, 300)
    h.assertBlockCount(0)

    h.keyDown('z', { ctrl: true })
    h.assertBlockCount(1)

    h.keyDown('z', { ctrl: true, shift: true })
    h.assertBlockCount(0)
  })
})
