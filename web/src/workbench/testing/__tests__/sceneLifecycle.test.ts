import { describe, it } from 'vitest'
import { createTestHarness } from '../harness'

describe('scene lifecycle — user perspective', () => {
  it('new scene removes all existing blocks', async () => {
    const h = createTestHarness({
      blocks: [
        { x: 0, y: 0, z: 0, id: 'stone' },
        { x: 3, y: 0, z: 5, id: 'dirt' },
      ],
    })
    h.assertBlockCount(2)

    await h.newScene()

    h.assertBlockCount(0)
  })

  it('new scene with already empty scene does not throw', async () => {
    const h = createTestHarness({ blocks: [] })
    await h.newScene()
    h.assertBlockCount(0)
  })

  it('new scene clears selection', async () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'stone' }],
    })
    h.clickBlock({ x: 0, y: 0, z: 0 })
    h.assertSelectionSize(1)

    await h.newScene()

    h.assertSelectionSize(0)
  })

  it('new scene resets dirty state', async () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'stone' }],
    })
    h.ctx.scene.markDirty()
    h.assertDirty(true)

    await h.newScene()

    h.assertDirty(false)
  })

  it('can add blocks after new scene', async () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'stone' }],
    })
    await h.newScene()
    h.assertBlockCount(0)

    h.setBrush('oak')
    h.activateTool('add-block')

    // Click screen center — ray hits ground plane at origin after new scene
    h.click(400, 300)

    h.assertBlockCount(1)
    h.assertBlockAt({ x: 0, y: 0, z: 0 }, 'oak')
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

  it('sync preview does not throw after new scene', async () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'stone' }],
    })
    await h.newScene()
    await h.syncPreview()
  })

  it('save to file does not throw on empty scene', async () => {
    const h = createTestHarness({ blocks: [] })
    await h.saveToFile()
  })

  it('setWorkspaceMode switches workspace mode', () => {
    const h = createTestHarness({ blocks: [] })
    h.setWorkspaceMode('sde')
  })

  it('setFrameIndex does not throw', () => {
    const h = createTestHarness({ blocks: [] })
    h.setFrameIndex(0)
  })
})
