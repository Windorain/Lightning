import { describe, it } from 'vitest'
import { createTestHarness } from '../harness'

describe('scene lifecycle operators', () => {
  it('new scene clears existing blocks', async () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'stone' }],
    })
    h.assertBlockCount(1)

    await h.newScene()

    h.assertBlockCount(0)
  })

  it('save to file does not throw when scene is empty', async () => {
    const h = createTestHarness({ blocks: [] })
    await h.saveToFile()
  })

  it('sync preview does not throw with loaded scene', async () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'stone' }],
    })
    await h.syncPreview()
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
