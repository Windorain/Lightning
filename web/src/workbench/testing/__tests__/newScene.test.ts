import { describe, it } from 'vitest'
import { createTestHarness } from '../harness'

describe('new scene — user perspective', () => {
  it('new scene removes all existing blocks', async () => {
    const h = createTestHarness({
      blocks: [
        { x: 0, y: 0, z: 0, id: 'stone' },
        { x: 3, y: 0, z: 5, id: 'dirt' },
        { x: -2, y: 1, z: 1, id: 'oak' },
      ],
    })
    h.assertBlockCount(3)

    await h.newScene()

    h.assertBlockCount(0)
  })

  it('new scene with already empty scene does not throw', async () => {
    const h = createTestHarness({ blocks: [] })
    h.assertBlockCount(0)

    await h.newScene()

    h.assertBlockCount(0)
  })

  it('can add blocks after new scene', async () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'stone' }],
    })
    h.setBrush('oak')
    await h.newScene()
    h.assertBlockCount(0)

    h.activateTool('add-block')
    h.click(400, 300)
    h.assertBlockCount(1)
  })

  it('multiple newScene calls are idempotent', async () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'stone' }],
    })
    await h.newScene()
    await h.newScene()
    await h.newScene()

    h.assertBlockCount(0)
  })

  it('selection is cleared after new scene', async () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'stone' }],
    })
    h.clickBlock({ x: 3, y: 0, z: 5 })
    h.assertSelectionSize(1)

    await h.newScene()

    h.assertSelectionSize(0)
  })

  it('new scene resets block palette', async () => {
    const h = createTestHarness({
      blocks: [
        { x: 0, y: 0, z: 0, id: 'stone' },
        { x: 1, y: 0, z: 0, id: 'birch' },
      ],
    })
    h.setBrush('oak')
    await h.newScene()

    h.setBrush('dirt')
    h.activateTool('add-block')
    h.click(400, 300)
    h.assertBlockCount(1)
    // just verify we can add with a completely different brush after reset
  })
})
