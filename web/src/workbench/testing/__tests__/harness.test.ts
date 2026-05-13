import { describe, it, expect } from 'vitest'
import { createTestHarness } from '../harness'

describe('Select operator cycle', () => {
  it('creates a harness with mock scene data', () => {
    const h = createTestHarness({
      blocks: [
        { x: 3, y: 0, z: 5, id: 'minecraft:stone' },
        { x: 0, y: 0, z: 0, id: 'minecraft:dirt' },
      ],
    })

    expect(h.ctx).toBeDefined()
    expect(h.ctx.screen).toBeNull()
    expect(h.ctx.rna.resolve('block.id')).not.toBeNull()
  })

  it('injects pointer events without crashing', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'minecraft:stone' }],
    })

    // Event injection should not throw
    expect(() => h.pointerDown(100, 100)).not.toThrow()
    expect(() => h.pointerMove(110, 100)).not.toThrow()
    expect(() => h.pointerUp(110, 100)).not.toThrow()
  })

  it('injects keyboard events without crashing', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'minecraft:stone' }],
    })

    expect(() => h.keyDown('b')).not.toThrow()
    expect(() => h.keyDown('Escape')).not.toThrow()
  })

  it('click is pointerDown + pointerUp', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'minecraft:stone' }],
    })

    expect(() => h.click(100, 100)).not.toThrow()
  })

  it('drag injects sequence of pointer events', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'minecraft:stone' }],
    })

    expect(() => h.drag(100, 100, 200, 200, { steps: 3 })).not.toThrow()
  })

  it('assert throws on false condition', () => {
    const h = createTestHarness()

    expect(() => h.assert(true, 'ok')).not.toThrow()
    expect(() => h.assert(false, 'fail')).toThrow('fail')
  })

  it('RNA registry resolves block.id through mock', () => {
    const h = createTestHarness({
      blocks: [{ x: 3, y: 0, z: 5, id: 'minecraft:stone' }],
    })

    const desc = h.ctx.rna.resolve('block.id')
    expect(desc).not.toBeNull()
    expect(desc!.type).toBe('string')
    expect(desc!.label).toBe('方块标识')
  })
})
