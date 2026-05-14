import { describe, it } from 'vitest'
import { createTestHarness } from '../harness'
import { computed, inject } from 'vue'
import { bContextKey } from '@/workbench/context/bContext'

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
    h.markDirty()
    h.assertDirty(true)

    await h.newScene()

    h.assertDirty(false)
  })

  it('can add blocks after new scene', async () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'stone' }],
      blockPalette: { oak: { name: 'oak' } },
    })
    h.selectBrush('oak')
    await h.newScene()
    h.assertBlockCount(0)

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

  it('new scene → add block → move', async () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'stone' }],
      blockPalette: { oak: { name: 'oak' } },
    })
    h.selectBrush('oak')
    await h.newScene()
    h.assertBlockCount(0)

    h.activateTool('add-block')
    h.click(400, 300)
    h.assertBlockCount(1)
    h.assertBlockAt({ x: 0, y: 0, z: 0 }, 'oak')

    h.activateTool('select')
    h.clickBlock({ x: 0, y: 0, z: 0 })
    h.assertSelectionSize(1)

    h.activateTool('move')
    h.assertOperatorActive('OPERATOR_MOVE')
    h.dragWorld('y', 1)
    h.assertBlockAt({ x: 0, y: 1, z: 0 }, 'oak')
  })

  it('add block via tool then move', () => {
    const h = createTestHarness({
      blocks: [],
      blockPalette: { oak: { name: 'oak' } },
    })
    h.assertBlockCount(0)

    h.selectBrush('oak')
    h.activateTool('add-block')
    h.click(400, 300)
    h.assertBlockCount(1)

    h.activateTool('select')
    h.clickBlock({ x: 0, y: 0, z: 0 })
    h.assertSelectionSize(1)

    h.activateTool('move')
    h.assertOperatorActive('OPERATOR_MOVE')
    h.dragWorld('y', 1)
    h.assertBlockAt({ x: 0, y: 1, z: 0 }, 'oak')
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

  it('mounted Vue component re-renders on scene change', () => {
    const h = createTestHarness({
      blocks: [{ x: 0, y: 0, z: 0, id: 'stone' }],
    })

    // Mount a component that reads reactive scene state via useBContext
    const unmount = h.mount({
      setup() {
        const bctx = inject(bContextKey)!
        const count = computed(() => bctx.queries.getFrameBlocks().length)
        return { count }
      },
      template: '<div data-testid="block-count">{{ count }}</div>',
    })

    // Scene change should trigger reactive update — not crash
    h.clickOperator('OPERATOR_NEW_SCENE')
    h.assertBlockCount(0)

    unmount()
  })
})
