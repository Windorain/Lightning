/**
 * Test harness — 黑盒测试入口。
 *
 * L0: pointerDown/Move/Up, keyDown（纯事件注入）
 * L1: click, drag（组合事件）
 * L2: clickOperator, setRNAValue（语义交互）
 *
 * 事件走完整 dispatch 链：eventDispatcher → KEYMAP/OPERATOR handler → operator.invoke/modal
 * 只通过事件注入和 bctx 读数验证，不直接调用 operator API。
 */
import type { BContext } from '@/workbench/context/bContext'
import type { TestSpec, TestResult } from './testRunner'
import { createMockBContext, runTestSpec } from './testRunner'
import { eventDispatcher } from '@/workbench/eventDispatcher'
import { HANDLER_TYPE } from '@/workbench/events/eventTypes'
import { createActiveToolHandler } from '@/workbench/handlers/activeToolHandler'
import { DEFAULT_KEYMAP, matchBinding } from '@/workbench/keymap'
import { globalOperators } from '@/workbench/operators/operatorRegistry'
import { logCenter } from '@/workbench/logging/LogCenter'
import { MockGizmo, createTestGizmoHandler } from './gizmoMock'

// Operators
import { SelectOperator } from '@/workbench/operators/builtin/selectOperator'
import { MoveOperator } from '@/workbench/operators/builtin/moveOperator'
import { DeleteOperator } from '@/workbench/operators/builtin/deleteOperator'
import { ReplaceOperator } from '@/workbench/operators/builtin/replaceOperator'
import { FillOperator } from '@/workbench/operators/builtin/fillOperator'
import { EyedropperOperator } from '@/workbench/operators/builtin/eyedropperOperator'
import { MirrorOperator } from '@/workbench/operators/builtin/mirrorOperator'
import { GenerateOperator } from '@/workbench/operators/builtin/generateOperator'
import { AnnotationOperator } from '@/workbench/operators/builtin/annotationOperator'
import { LabelOperator } from '@/workbench/operators/builtin/labelOperator'
import { ToolSetOperator } from '@/workbench/operators/builtin/toolOperator'
import { ViewRotateOperator, ViewPanOperator, ViewZoomOperator } from '@/workbench/operators/builtin/viewOperators'
import { UndoOperator, RedoOperator } from '@/workbench/operators/builtin/undoOperator'
const BUILTIN_OPERATORS = [
  SelectOperator, MoveOperator, DeleteOperator, ReplaceOperator,
  FillOperator, EyedropperOperator, MirrorOperator, GenerateOperator,
  AnnotationOperator, LabelOperator, ToolSetOperator,
  ViewRotateOperator, ViewPanOperator, ViewZoomOperator,
  UndoOperator, RedoOperator,
]

const TOOL_KEY_MAP: Record<string, string> = {
  select: 'OPERATOR_SELECT', move: 'OPERATOR_MOVE',
  delete: 'OPERATOR_DELETE', replace: 'OPERATOR_REPLACE',
  fill: 'OPERATOR_FILL', eyedropper: 'OPERATOR_EYEDROPPER',
  mirror: 'OPERATOR_MIRROR', generate: 'OPERATOR_GENERATE',
}

/* —— Event handler cookbook —— */

// 可变 bctx 引用，避免多个 harness 实例间 handler 闭包捕获旧值
let _bctxRef: BContext | null = null
let _mockGizmo: MockGizmo | null = null
let _handlersBooted = false

function bootEventHandlers(bctx: BContext): void {
  _bctxRef = bctx

  if (_handlersBooted) return
  _handlersBooted = true

  // Register all builtin operators (idempotent)
  for (const op of BUILTIN_OPERATORS) {
    if (!globalOperators.find(op.id)) globalOperators.register(op)
  }

  // GIZMO: pointerdown on gizmo handle → enter drag modal
  _mockGizmo = new MockGizmo()
  eventDispatcher.registerTypedHandler(
    createTestGizmoHandler(() => _mockGizmo, () => _bctxRef),
  )

  // KEYMAP: keyboard → tool activation
  eventDispatcher.registerTypedHandler({
    type: HANDLER_TYPE.KEYMAP,
    handle(event: Event): { break: boolean } {
      if (!(event instanceof KeyboardEvent)) return { break: false }
      for (const binding of DEFAULT_KEYMAP) {
        if (!matchBinding(binding, event)) continue
        if (binding.toolId) {
          const opId = TOOL_KEY_MAP[binding.toolId] ?? `OPERATOR_${binding.toolId.toUpperCase()}`
          _bctxRef?.operators.exec('OPERATOR_TOOL_SET', { toolId: opId })
          return { break: true }
        }
        if (binding.action === 'undo') { _bctxRef?.operators.exec('OPERATOR_UNDO'); return { break: true } }
        if (binding.action === 'redo') { _bctxRef?.operators.exec('OPERATOR_REDO'); return { break: true } }
      }
      return { break: false }
    },
  })

  // OPERATOR: pointer events → active operator
  eventDispatcher.registerTypedHandler(createActiveToolHandler(() => _bctxRef))
}

/* —— Harness —— */

export interface TestHarness {
  ctx: BContext
  log: typeof logCenter

  // L0: Event injection
  pointerDown(x: number, y: number, opts?: { ctrl?: boolean; shift?: boolean }): void
  pointerMove(x: number, y: number, opts?: { ctrl?: boolean; shift?: boolean }): void
  pointerUp(x: number, y: number, opts?: { ctrl?: boolean; shift?: boolean }): void
  keyDown(key: string, opts?: { ctrl?: boolean; shift?: boolean }): void

  // L1: Composed flows
  click(x: number, y: number, opts?: { ctrl?: boolean; shift?: boolean }): void
  drag(fromX: number, fromY: number, toX: number, toY: number, opts?: { steps?: number; ctrl?: boolean; shift?: boolean }): void

  // L2: Semantic interaction (resolve by layout then interact)
  clickOperator(opId: string, opts?: { index?: number }): void
  setRNAValue(rnaPath: string, value: unknown, owner?: unknown): void

  // L3: World-coordinate interaction
  /** 沿 gizmo 轴拖拽世界距离（自动计算屏幕像素） */
  dragWorld(axis: 'x' | 'y' | 'z', amount: number, opts?: { steps?: number }): void

  // Assertions
  assert(condition: boolean, message?: string): void
  assertSelectionSize(n: number): void
  assertSelectionContains(pos: { x: number; y: number; z: number }): void
  assertBlockAt(pos: { x: number; y: number; z: number }, id?: string): void
  assertBlockNotAt(pos: { x: number; y: number; z: number }): void
  assertBlockCount(n: number): void
  assertOperatorActive(id: string): void

  // Spec runner
  run(spec: TestSpec): TestResult
}

export function createTestHarness(
  opts?: Parameters<typeof createMockBContext>[0],
): TestHarness {
  const ctx = createMockBContext(opts)
  bootEventHandlers(ctx)

  // Activate default tool
  ctx.toolRegistry.activate('OPERATOR_SELECT', ctx)

  return {
    ctx,
    log: logCenter,

    pointerDown(x, y, o = {}) {
      const event = new PointerEvent('pointerdown', {
        clientX: x, clientY: y, ctrlKey: o.ctrl, shiftKey: o.shift, button: 0,
      })
      ctx.eventDispatcher.dispatch(event)
    },

    pointerMove(x, y, o = {}) {
      const event = new PointerEvent('pointermove', {
        clientX: x, clientY: y, ctrlKey: o.ctrl, shiftKey: o.shift, button: 0,
      })
      ctx.eventDispatcher.dispatch(event)
    },

    pointerUp(x, y, o = {}) {
      const event = new PointerEvent('pointerup', {
        clientX: x, clientY: y, ctrlKey: o.ctrl, shiftKey: o.shift, button: 0,
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
      const { ctrl, shift } = o
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

    clickOperator(opId, o = {}) {
      const rects = ctx.ui.boundsOfByOperator(opId)
      const idx = o.index ?? 0
      if (idx >= rects.length) {
        throw new Error(`clickOperator: ${opId} has only ${rects.length} instances, requested index ${idx}`)
      }
      const r = rects[idx]
      this.click(r.x + r.width / 2, r.y + r.height / 2)
    },

    setRNAValue(rnaPath, value, owner) {
      const desc = ctx.rna.resolve(rnaPath)
      if (!desc) throw new Error(`setRNAValue: RNA path "${rnaPath}" not resolved`)
      desc.set(owner ?? {}, value)
    },

    dragWorld(axis, amount, o = {}) {
      const gizmo = ctx.queries.getGizmoAnchor(axis)
      if (!gizmo) throw new Error(`dragWorld: gizmo anchor null for axis ${axis} — nothing selected?`)
      // 计算世界位移对应的屏幕像素
      // computeDelta 映射: X→dx*k, Y→-dy*k, Z→-dx*k
      // 反解: X: screenDx=amount/k, Y: screenDy=-amount/k, Z: screenDx=-amount/k
      const k = ctx.settings.dragSensitivity
      const steps = o.steps ?? 5
      let toX = gizmo.x
      let toY = gizmo.y
      if (axis === 'x') toX += amount / k
      else if (axis === 'y') toY -= amount / k
      else toX -= amount / k
      this.drag(gizmo.x, gizmo.y, toX, toY, { steps })
    },

    // Assertions

    assert(condition, message = 'assertion failed') {
      if (!condition) throw new Error(message)
    },

    assertSelectionSize(n) {
      const actual = ctx.selection.items.value.size
      if (actual !== n) throw new Error(`selection size: expected ${n}, got ${actual}`)
    },

    assertSelectionContains(pos) {
      const found = [...ctx.selection.items.value].some(
        s => s.pos.x === pos.x && s.pos.y === pos.y && s.pos.z === pos.z,
      )
      if (!found) throw new Error(`selection does not contain (${pos.x},${pos.y},${pos.z})`)
    },

    assertBlockAt(pos, id?) {
      const blocks = ctx.queries.getFrameBlocks()
      const found = blocks.find(b =>
        b.pos.x === pos.x && b.pos.y === pos.y && b.pos.z === pos.z &&
        (id === undefined || b.block_state_id === id),
      )
      if (!found) throw new Error(`block not found at (${pos.x},${pos.y},${pos.z}) id=${id ?? 'any'}`)
    },

    assertBlockNotAt(pos) {
      const blocks = ctx.queries.getFrameBlocks()
      const found = blocks.some(b =>
        b.pos.x === pos.x && b.pos.y === pos.y && b.pos.z === pos.z,
      )
      if (found) throw new Error(`block should not exist at (${pos.x},${pos.y},${pos.z})`)
    },

    assertBlockCount(n) {
      const actual = ctx.queries.getFrameBlocks().length
      if (actual !== n) throw new Error(`block count: expected ${n}, got ${actual}`)
    },

    assertOperatorActive(id) {
      const actual = ctx.toolRegistry.activeTool.value?.id
      if (actual !== id) throw new Error(`active operator: expected ${id}, got ${actual ?? 'null'}`)
    },

    run(spec) { return runTestSpec(ctx, spec) },
  }
}
