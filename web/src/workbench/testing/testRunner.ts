/**
 * Direct test runner — 无浏览器模式。
 *
 * 测试用例是纯数据（TestSpec JSON），直接调用 operator.invoke/modal。
 * 通过 window.__test__ 暴露给 browser-test-loop / SDD。
 *
 * 运行方式：
 *   node dist/run.js debug-eval "runTest('select-click')"
 */
import type { BContext } from '@/workbench/context/bContext'
import { globalOperators } from '@/workbench/operators/operatorRegistry'
import { logCenter } from '@/workbench/logging/LogCenter'
import { eventDispatcher } from '@/workbench/eventDispatcher'

/* —— TestSpec —— */

export interface TestAction {
  action: 'activate-operator' | 'pointerdown' | 'pointermove' | 'pointerup' | 'keydown' | 'assert-selection' | 'assert-log' | 'sleep'
  id?: string
  x?: number
  y?: number
  key?: string
  ctrlKey?: boolean
  shiftKey?: boolean
  value?: unknown
  timeout?: number
}

export interface TestSpec {
  name: string
  setup?: { blocks?: Array<{ x: number; y: number; z: number; id: string }> }
  steps: TestAction[]
}

export interface TestResult {
  name: string
  passed: boolean
  steps: TestStepResult[]
  duration: number
}

export interface TestStepResult {
  index: number
  action: TestAction
  passed: boolean
  error?: string
  detail?: unknown
}

/* —— Runner —— */

export function runTestSpec(bctx: BContext, spec: TestSpec): TestResult {
  const start = performance.now()
  const steps: TestStepResult[] = []

  // Reset
  logCenter.clear()
  bctx.selection.clear()

  for (let i = 0; i < spec.steps.length; i++) {
    const action = spec.steps[i]
    try {
      const result = executeAction(bctx, action)
      steps.push({ index: i, action, passed: result.passed, detail: result.detail, error: result.error })
    } catch (e) {
      steps.push({ index: i, action, passed: false, error: String(e) })
      break // 失败即停
    }
  }

  const passed = steps.every(s => s.passed)
  return { name: spec.name, passed, steps, duration: performance.now() - start }
}

function executeAction(bctx: BContext, action: TestAction): { passed: boolean; detail?: unknown; error?: string } {
  switch (action.action) {

    case 'activate-operator': {
      if (!action.id) return { passed: false, error: 'missing id' }
      const op = globalOperators.find(action.id)
      if (!op) return { passed: false, error: `operator not found: ${action.id}` }
      bctx.toolRegistry.activate(action.id, bctx)
      const active = bctx.toolRegistry.activeTool.value
      return { passed: active?.id === action.id, detail: { active: active?.id } }
    }

    case 'pointerdown':
    case 'pointermove':
    case 'pointerup': {
      const activeId = bctx.toolRegistry.activeTool.value?.id
      if (!activeId) return { passed: false, error: 'no active operator' }
      const op = globalOperators.find(activeId)
      if (!op) return { passed: false, error: `operator not found: ${activeId}` }
      const event = new PointerEvent(action.action, {
        clientX: action.x ?? 0, clientY: action.y ?? 0,
        ctrlKey: action.ctrlKey, shiftKey: action.shiftKey, button: 0,
      })
      // 使用 operator.invoke 或 modal 取决于当前上下文
      if (action.action === 'pointerdown' && op.invoke) {
        const result = op.invoke(bctx, {}, event)
        return { passed: result !== 'CANCELLED', detail: { result } }
      }
      if (op.modal) {
        const result = op.modal(bctx, {}, event)
        return { passed: result !== 'CANCELLED', detail: { result } }
      }
      return { passed: false, error: 'operator has no modal handler' }
    }

    case 'keydown': {
      const event = new KeyboardEvent('keydown', {
        key: action.key, ctrlKey: action.ctrlKey, shiftKey: action.shiftKey,
      })
      const result = eventDispatcher.dispatch(event)
      return { passed: true, detail: { break: result.break } }
    }

    case 'assert-selection': {
      const size = bctx.selection.items.value.size
      const expected = (action.value as number) ?? 0
      return {
        passed: size === expected,
        detail: { expected, actual: size, items: [...bctx.selection.items.value].slice(0, 10) },
        error: size !== expected ? `selection: expected ${expected}, got ${size}` : undefined,
      }
    }

    case 'assert-log': {
      const contains = logCenter.contains(action.value as number)
      return { passed: contains, detail: { mask: action.value, recent: logCenter.recent(action.value as number, 5) } }
    }

    default:
      return { passed: false, error: `unknown action: ${(action as any).action}` }
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
