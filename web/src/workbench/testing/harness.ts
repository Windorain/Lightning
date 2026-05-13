import type { BContext } from '@/workbench/context/bContext'
import type { TestSpec, TestResult } from './testRunner'
import { createMockBContext, runTestSpec } from './testRunner'

export interface TestHarness {
  ctx: BContext

  // Event injection (L0)
  pointerDown(x: number, y: number, opts?: { ctrl?: boolean; shift?: boolean }): void
  pointerMove(x: number, y: number, opts?: { ctrl?: boolean; shift?: boolean }): void
  pointerUp(x: number, y: number, opts?: { ctrl?: boolean; shift?: boolean }): void
  keyDown(key: string, opts?: { ctrl?: boolean; shift?: boolean }): void

  // Composed flows (L1)
  click(x: number, y: number, opts?: { ctrl?: boolean; shift?: boolean }): void
  drag(fromX: number, fromY: number, toX: number, toY: number, opts?: { steps?: number; ctrl?: boolean; shift?: boolean }): void

  // Assertions
  assert(condition: boolean, message?: string): void
  assertSelectionSize(n: number): void
  assertBlockAt(pos: { x: number; y: number; z: number }, id?: string): void

  // Spec runner
  run(spec: TestSpec): TestResult
}

export function createTestHarness(
  opts?: Parameters<typeof createMockBContext>[0],
): TestHarness {
  const ctx = createMockBContext(opts)

  return {
    ctx,

    pointerDown(x, y, o = {}) {
      const event = new PointerEvent('pointerdown', {
        clientX: x, clientY: y,
        ctrlKey: o.ctrl, shiftKey: o.shift, button: 0,
      })
      ctx.eventDispatcher.dispatch(event)
    },

    pointerMove(x, y, o = {}) {
      const event = new PointerEvent('pointermove', {
        clientX: x, clientY: y,
        ctrlKey: o.ctrl, shiftKey: o.shift, button: 0,
      })
      ctx.eventDispatcher.dispatch(event)
    },

    pointerUp(x, y, o = {}) {
      const event = new PointerEvent('pointerup', {
        clientX: x, clientY: y,
        ctrlKey: o.ctrl, shiftKey: o.shift, button: 0,
      })
      ctx.eventDispatcher.dispatch(event)
    },

    keyDown(key, o = {}) {
      const event = new KeyboardEvent('keydown', { key, ctrlKey: o.ctrl, shiftKey: o.shift })
      ctx.eventDispatcher.dispatch(event)
    },

    click(x, y, o = {}) {
      this.pointerDown(x, y, o)
      this.pointerUp(x, y, o)
    },

    drag(fromX, fromY, toX, toY, o = {}) {
      const steps = o.steps ?? 5
      const ctrl = o.ctrl, shift = o.shift
      this.pointerDown(fromX, fromY, { ctrl, shift })
      for (let i = 1; i < steps; i++) {
        const t = i / steps
        this.pointerMove(
          fromX + (toX - fromX) * t,
          fromY + (toY - fromY) * t,
          { ctrl, shift },
        )
      }
      this.pointerUp(toX, toY, { ctrl, shift })
    },

    assert(condition, message = 'assertion failed') {
      if (!condition) throw new Error(message)
    },

    assertSelectionSize(n) {
      const actual = ctx.selection.items.value.size
      if (actual !== n) {
        throw new Error(`selection: expected ${n}, got ${actual}`)
      }
    },

    assertBlockAt(pos, id?) {
      const blocks = ctx.queries.getFrameBlocks()
      const found = blocks.find(b =>
        b.pos.x === pos.x && b.pos.y === pos.y && b.pos.z === pos.z &&
        (id === undefined || b.block_state_id === id),
      )
      if (!found) {
        throw new Error(`block not found at (${pos.x},${pos.y},${pos.z}) id=${id ?? 'any'}`)
      }
    },

    run(spec) {
      return runTestSpec(ctx, spec)
    },
  }
}
