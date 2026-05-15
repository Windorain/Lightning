/**
 * Test runner — JSON Spec 运行器。
 *
 * 不再包含任何 mock（createMockBContext / createMockQueries 已删除）。
 * VM 搭建由 harness.ts 调用 createWorkbenchContext 完成。
 * 本文件只保留 TestSpec 定义和执行器。
 */

import type { BContext } from '@/workbench/context/bContext'
import { eventDispatcher } from '@/workbench/eventDispatcher'
import { logCenter } from '@/workbench/logging/LogCenter'

/* —— TestSpec (semantic actions, event-driven) —— */

const TOOL_KEY_BINDING: Record<string, { key: string; ctrl?: boolean; shift?: boolean }> = {
  select:    { key: 'b' },
  move:      { key: 'g' },
  delete:    { key: 'x' },
  replace:   { key: 'r' },
  fill:      { key: 'f' },
  eyedropper:{ key: 'e' },
  mirror:    { key: 'm', ctrl: true },
  generate:  { key: 'a', shift: true },
  'add-block':           { key: 'h' },
  'add-annotation-box':  { key: 'j' },
}

export type TestAction =
  | { action: 'activate-tool'; tool: string }
  | { action: 'click-at'; x: number; y: number; ctrl?: boolean; shift?: boolean }
  | { action: 'click-block'; x: number; y: number; z: number }
  | { action: 'select-brush'; brush: string; toolId?: string }
  | { action: 'drag-world'; axis: 'x' | 'y' | 'z'; amount: number; steps?: number }
  | { action: 'keydown'; key: string; ctrl?: boolean; shift?: boolean }
  | { action: 'assert-block-count'; n: number }
  | { action: 'assert-selection-size'; n: number }
  | { action: 'assert-operator-active'; id: string }
  | { action: 'assert-block-at'; x: number; y: number; z: number; id?: string }
  | { action: 'assert-block-not-at'; x: number; y: number; z: number }
  | { action: 'assert-theme'; expected: 'dark' | 'light' }
  | { action: 'assert-language'; expected: 'zh' | 'en' }
  | { action: 'assert-dirty'; expected: boolean }

export interface TestSpec {
  name: string
  setup?: { blocks?: Array<{ x: number; y: number; z: number; id: string }> }
  steps: TestAction[]
}

export interface TestStepResult {
  index: number
  action: TestAction
  passed: boolean
  error?: string
  detail?: unknown
}

export interface TestResult {
  name: string
  passed: boolean
  steps: TestStepResult[]
  duration: number
}

/* —— Runner —— */

export function runTestSpec(bctx: BContext, spec: TestSpec): TestResult {
  const start = performance.now()
  const steps: TestStepResult[] = []

  bctx.log.clear()
  bctx.selection.clear()

  for (let i = 0; i < spec.steps.length; i++) {
    const action = spec.steps[i]
    try {
      const result = executeAction(bctx, action)
      steps.push({ index: i, action, passed: result.passed, detail: result.detail, error: result.error })
    } catch (e) {
      steps.push({ index: i, action, passed: false, error: String(e) })
      break
    }
  }

  const passed = steps.every(s => s.passed)
  return { name: spec.name, passed, steps, duration: performance.now() - start }
}

function executeAction(bctx: BContext, action: TestAction): { passed: boolean; detail?: unknown; error?: string } {
  switch (action.action) {
    case 'activate-tool': {
      const binding = TOOL_KEY_BINDING[action.tool]
      if (!binding) return { passed: false, error: `unknown tool: ${action.tool}` }
      const event = new KeyboardEvent('keydown', {
        key: binding.key, ctrlKey: binding.ctrl ?? false, shiftKey: binding.shift ?? false,
      })
      bctx.eventDispatcher.dispatch(event)
      bctx.ui.relayout()
      const active = bctx.toolRegistry.activeTool.value?.id ?? null
      const expectedOpId = `OPERATOR_${action.tool.toUpperCase()}`
      return { passed: active === expectedOpId, detail: { active, expected: expectedOpId } }
    }

    case 'click-at': {
      const down = new PointerEvent('pointerdown', {
        clientX: action.x, clientY: action.y,
        ctrlKey: action.ctrl ?? false, shiftKey: action.shift ?? false, button: 0,
      })
      const up = new PointerEvent('pointerup', {
        clientX: action.x, clientY: action.y,
        ctrlKey: action.ctrl ?? false, shiftKey: action.shift ?? false, button: 0,
      })
      bctx.eventDispatcher.dispatch(down)
      bctx.eventDispatcher.dispatch(up)
      return { passed: true, detail: { x: action.x, y: action.y } }
    }

    case 'click-block': {
      const selBinding = TOOL_KEY_BINDING.select
      bctx.eventDispatcher.dispatch(new KeyboardEvent('keydown', { key: selBinding.key }))
      const p = bctx.queries.projectBlock({ x: action.x, y: action.y, z: action.z })
      if (!p) return { passed: false, error: `block at (${action.x},${action.y},${action.z}) not visible` }
      bctx.eventDispatcher.dispatch(new PointerEvent('pointerdown', {
        clientX: p.x, clientY: p.y, button: 0,
      }))
      bctx.eventDispatcher.dispatch(new PointerEvent('pointerup', {
        clientX: p.x, clientY: p.y, button: 0,
      }))
      return { passed: true, detail: { projectedTo: p } }
    }

    case 'select-brush': {
      const doc = (bctx as any).queries.getDocument?.() ?? null
      const palette = doc?.block_palette
      if (palette && !palette[action.brush]) {
        return {
          passed: false,
          error: `select-brush: '${action.brush}' not in block_palette. Available: [${Object.keys(palette).join(', ')}]`,
        }
      }
      const bind = TOOL_KEY_BINDING['add-block']
      if (!bind) return { passed: false, error: 'select-brush: no key binding for add-block' }
      bctx.eventDispatcher.dispatch(new KeyboardEvent('keydown', {
        key: bind.key, ctrlKey: bind.ctrl ?? false, shiftKey: bind.shift ?? false,
      }))
      bctx.ui.relayout()
      const rects = bctx.ui.boundsOfByOperatorMatchProps('OPERATOR_TOOL_SET', { brushId: action.brush })
      if (rects.length === 0) {
        return { passed: false, error: `select-brush: no palette button for '${action.brush}'` }
      }
      const r = rects[0]
      bctx.eventDispatcher.dispatch(new PointerEvent('pointerdown', {
        clientX: r.bounds.x + r.bounds.width / 2, clientY: r.bounds.y + r.bounds.height / 2, button: 0,
      }))
      bctx.eventDispatcher.dispatch(new PointerEvent('pointerup', {
        clientX: r.bounds.x + r.bounds.width / 2, clientY: r.bounds.y + r.bounds.height / 2, button: 0,
      }))
      return { passed: true, detail: { brush: action.brush } }
    }

    case 'drag-world': {
      const gizmo = bctx.queries.getGizmoAnchor(action.axis)
      if (!gizmo) return { passed: false, error: `gizmo anchor null for axis ${action.axis}` }
      const k = bctx.settings.dragSensitivity
      const steps = action.steps ?? 5
      let screenDx = 0, screenDy = 0
      if (action.axis === 'x') screenDx = action.amount / k
      else if (action.axis === 'y') screenDy = -action.amount / k
      else screenDx = -action.amount / k

      bctx.eventDispatcher.dispatch(new PointerEvent('pointerdown', {
        clientX: gizmo.x, clientY: gizmo.y, button: 0,
      }))
      for (let i = 1; i < steps; i++) {
        const t = i / steps
        bctx.eventDispatcher.dispatch(new PointerEvent('pointermove', {
          clientX: gizmo.x + screenDx * t, clientY: gizmo.y + screenDy * t, button: 0,
        }))
      }
      bctx.eventDispatcher.dispatch(new PointerEvent('pointerup', {
        clientX: gizmo.x + screenDx, clientY: gizmo.y + screenDy, button: 0,
      }))
      return { passed: true, detail: { axis: action.axis, amount: action.amount } }
    }

    case 'keydown': {
      bctx.eventDispatcher.dispatch(new KeyboardEvent('keydown', {
        key: action.key, ctrlKey: action.ctrl ?? false, shiftKey: action.shift ?? false,
      }))
      return { passed: true, detail: { key: action.key } }
    }

    case 'assert-block-count': {
      const actual = bctx.queries.getFrameBlocks().length
      return { passed: actual === action.n, detail: { expected: action.n, actual },
        error: actual !== action.n ? `block count: expected ${action.n}, got ${actual}` : undefined }
    }
    case 'assert-selection-size': {
      const actual = bctx.selection.items.value.size
      return { passed: actual === action.n, detail: { expected: action.n, actual },
        error: actual !== action.n ? `selection size: expected ${action.n}, got ${actual}` : undefined }
    }
    case 'assert-operator-active': {
      const actual = bctx.toolRegistry.activeTool.value?.id ?? null
      return { passed: actual === action.id, detail: { expected: action.id, actual },
        error: actual !== action.id ? `operator: expected ${action.id}, got ${actual}` : undefined }
    }
    case 'assert-block-at': {
      const blocks = bctx.queries.getFrameBlocks()
      const found = blocks.find(b =>
        b.pos.x === action.x && b.pos.y === action.y && b.pos.z === action.z &&
        (action.id === undefined || b.block_state_id === action.id),
      )
      return { passed: !!found, detail: { pos: { x: action.x, y: action.y, z: action.z }, id: action.id },
        error: found ? undefined : `block not found at (${action.x},${action.y},${action.z})` }
    }
    case 'assert-block-not-at': {
      const blocks = bctx.queries.getFrameBlocks()
      const found = blocks.some(b =>
        b.pos.x === action.x && b.pos.y === action.y && b.pos.z === action.z,
      )
      return { passed: !found, detail: { pos: { x: action.x, y: action.y, z: action.z } },
        error: found ? `block should not exist at (${action.x},${action.y},${action.z})` : undefined }
    }
    case 'assert-theme': {
      const actual = bctx.settings.theme ?? 'dark'
      return { passed: actual === action.expected, detail: { expected: action.expected, actual },
        error: actual !== action.expected ? `theme: expected ${action.expected}, got ${actual}` : undefined }
    }
    case 'assert-language': {
      const actual = bctx.settings.language ?? 'zh'
      return { passed: actual === action.expected, detail: { expected: action.expected, actual },
        error: actual !== action.expected ? `language: expected ${action.expected}, got ${actual}` : undefined }
    }
    case 'assert-dirty': {
      const actual = bctx.scene.dirty.value
      return { passed: actual === action.expected, detail: { expected: action.expected, actual },
        error: actual !== action.expected ? `dirty: expected ${action.expected}, got ${actual}` : undefined }
    }
  }
}

/* —— 暴露到 window —— */

export function installTestRunner(bctx: BContext): void {
  if (typeof window === 'undefined') return
  ;(window as any).__test__ = {
    run(spec: TestSpec): TestResult { return runTestSpec(bctx, spec) },
    runJSON(json: string): TestResult { return runTestSpec(bctx, JSON.parse(json) as TestSpec) },
  }
}
