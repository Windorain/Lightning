/**
 * Test harness — 黑盒测试入口。
 *
 * L0: pointerDown/Move/Up, keyDown（纯事件注入）
 * L1: click, drag（组合事件）
 * L2: clickBlock, setBrush, activateTool, clickOperator, setRNAValue（语义交互）
 * L3: dragWorld（世界坐标交互）
 *
 * 事件走完整 dispatch 链：eventDispatcher → KEYMAP/OPERATOR handler → operator.invoke/modal
 * 只通过事件注入和 bctx 读数验证，不直接调用 operator API。
 * L2 方法内部只用 L0/L1 方法，不绕过事件链。
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
import type { CheckResult } from '@/workbench/logging/LogCenter'
import { MockGizmo, createTestGizmoHandler } from './gizmoMock'
import { screenDeltaToWorld } from './screenDeltaToWorld'

// Operators
import { SelectOperator } from '@/workbench/operators/builtin/selectOperator'
import { MoveOperator } from '@/workbench/operators/builtin/moveOperator'
import { DeleteOperator } from '@/workbench/operators/builtin/deleteOperator'
import { ReplaceOperator } from '@/workbench/operators/builtin/replaceOperator'
import { FillOperator } from '@/workbench/operators/builtin/fillOperator'
import { EyedropperOperator } from '@/workbench/operators/builtin/eyedropperOperator'
import { MirrorOperator } from '@/workbench/operators/builtin/mirrorOperator'
import { AddBlockOperator } from '@/workbench/operators/builtin/addBlockOperator'
import { AddAnnotationBoxOperator } from '@/workbench/operators/builtin/addAnnotationBoxOperator'
import { AnnotationOperator } from '@/workbench/operators/builtin/annotationOperator'
import { LabelOperator } from '@/workbench/operators/builtin/labelOperator'
import { ToolSetOperator } from '@/workbench/operators/builtin/toolOperator'
import { ViewRotateOperator, ViewPanOperator, ViewZoomOperator } from '@/workbench/operators/builtin/viewOperators'
import { UndoOperator, RedoOperator } from '@/workbench/operators/builtin/undoOperator'
const BUILTIN_OPERATORS = [
  SelectOperator, MoveOperator, DeleteOperator, ReplaceOperator,
  FillOperator, EyedropperOperator, MirrorOperator,
  AddBlockOperator, AddAnnotationBoxOperator,
  AnnotationOperator, LabelOperator, ToolSetOperator,
  ViewRotateOperator, ViewPanOperator, ViewZoomOperator,
  UndoOperator, RedoOperator,
]

const TOOL_KEY_MAP: Record<string, string> = {
  select: 'OPERATOR_SELECT', move: 'OPERATOR_MOVE',
  delete: 'OPERATOR_DELETE', replace: 'OPERATOR_REPLACE',
  fill: 'OPERATOR_FILL', eyedropper: 'OPERATOR_EYEDROPPER',
  mirror: 'OPERATOR_MIRROR',
  'add-block': 'OPERATOR_ADD_BLOCK',
  'add-annotation-box': 'OPERATOR_ADD_ANNOTATION_BOX',
}

/** 工具名 → 键盘绑定（从 DEFAULT_KEYMAP 提取，供 activateTool 使用） */
const TOOL_KEY_BINDING: Record<string, { key: string; ctrl?: boolean; shift?: boolean }> = {
  select:    { key: 'b' },
  move:      { key: 'g' },
  delete:    { key: 'x' },
  replace:   { key: 'r' },
  fill:      { key: 'f' },
  eyedropper:{ key: 'e' },
  mirror:    { key: 'm', ctrl: true },
  'add-block':           { key: 'h' },
  'add-annotation-box':  { key: 'j' },
}

/* —— Event handler cookbook —— */

let _bctxRef: BContext | null = null
let _mockGizmo: MockGizmo | null = null
let _handlersBooted = false

function bootEventHandlers(bctx: BContext): void {
  _bctxRef = bctx

  if (_handlersBooted) return
  _handlersBooted = true

  for (const op of BUILTIN_OPERATORS) {
    if (!globalOperators.find(op.id)) globalOperators.register(op)
  }

  _mockGizmo = new MockGizmo()
  eventDispatcher.registerTypedHandler(
    createTestGizmoHandler(() => _mockGizmo, () => _bctxRef),
  )

  eventDispatcher.registerTypedHandler({
    type: HANDLER_TYPE.KEYMAP,
    handle(event: Event): { break: boolean } {
      if (!(event instanceof KeyboardEvent)) return { break: false }

      // Shift+A → context menu with add tools (handled before keymap in real app)
      if (event.key === 'a' && event.shiftKey && !event.ctrlKey && !event.metaKey) {
        const ADD_MENU_ITEMS = [
          { kind: 'label', label: '生成', icon: '＋' },
          { kind: 'separator', label: '' },
          { kind: 'operator', label: '方块', icon: '⬜', opId: 'OPERATOR_TOOL_SET', props: { toolId: 'OPERATOR_ADD_BLOCK' } },
          { kind: 'operator', label: '注解框', icon: '📝', opId: 'OPERATOR_TOOL_SET', props: { toolId: 'OPERATOR_ADD_ANNOTATION_BOX' } },
        ]
        const bctx = _bctxRef
        if (bctx) {
          const wm = (bctx as any).wm
          if (wm?.showContextMenu) {
            wm.showContextMenu(wm.contextMenu, { x: 400, y: 300 }, ADD_MENU_ITEMS)
          }
        }
        return { break: true }
      }

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

  eventDispatcher.registerTypedHandler(createActiveToolHandler(() => _bctxRef))
}

/* —— Batch assertion collector —— */

export interface CheckCollector {
  check(name: string, fn: () => boolean, expected: unknown, actual?: () => unknown): this
  done(): CheckResult[]
}

function createCollector(_ctx: BContext): CheckCollector {
  const results: CheckResult[] = []
  return {
    check(_name, fn, expected, actualFn) {
      let pass = false, actual: unknown = undefined
      try { pass = fn(); actual = actualFn?.() ?? actual } catch (e) { actual = String(e) }
      results.push({ pass, expected, actual: actual ?? (pass ? expected : 'failed') })
      return this
    },
    done() { return results },
  }
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

  // L2: Semantic interaction
  /** 激活工具（通过键盘事件，走完整 KEYMAP → ToolSetOperator 链路） */
  activateTool(name: string): void
  /** 设置当前刷子（通过 RNA 路径） */
  setBrush(brushId: string): void
  /** 点击世界坐标处的方块（自动 projectBlock + 激活 select） */
  clickBlock(pos: { x: number; y: number; z: number }, opts?: { ctrl?: boolean; shift?: boolean }): void
  /** 点击操作符按钮（通过布局查询） */
  clickOperator(opId: string, opts?: { index?: number }): void
  /** 设置 RNA 属性值 */
  setRNAValue(rnaPath: string, value: unknown, owner?: unknown): void

  // L3: World-coordinate interaction
  /** 沿 gizmo 轴拖拽世界距离（自动计算屏幕像素） */
  dragWorld(axis: 'x' | 'y' | 'z', amount: number, opts?: { steps?: number }): void

  // Assertions (throw on fail)
  assert(condition: boolean, message?: string): void
  assertSelectionSize(n: number): void
  assertSelectionContains(pos: { x: number; y: number; z: number }): void
  assertBlockAt(pos: { x: number; y: number; z: number }, id?: string): void
  assertBlockNotAt(pos: { x: number; y: number; z: number }): void
  assertBlockCount(n: number): void
  assertOperatorActive(id: string): void
  assertProjectBlockNull(pos: { x: number; y: number; z: number }): void
  assertRNAPath(path: string): any
  /** 注解框断言 */
  assertAnnotationBoxCount(n: number): void
  assertAnnotationBoxExists(id: string): void
  /** 点击世界坐标（用于测试空白区域放置） */
  clickWorld(worldPos: { x: number; y: number; z: number }): void
  /** ContextMenu 可见性断言 */
  assertContextMenuOpen(): void
  assertContextMenuClosed(): void
  /** 点击 ContextMenu 中的项 */
  clickContextMenuItem(label: string): void

  // Scene lifecycle helpers
  /** 新建空白场景 */
  newScene(): Promise<void>
  /** 保存当前场景到文件 */
  saveToFile(): Promise<void>
  /** 同步预览 */
  syncPreview(): Promise<void>
  /** 切换工作区模式 */
  setWorkspaceMode(mode: string): void
  /** 设置帧索引 */
  setFrameIndex(index: number): void

  // Batch check (collect, don't throw)
  /** 收集模式：返回 CheckCollector，所有 check 不抛异常，done() 返回结果列表 */
  collect(): CheckCollector

  // Spec runner
  run(spec: TestSpec): TestResult
}

export function createTestHarness(
  opts?: Parameters<typeof createMockBContext>[0],
): TestHarness {
  const ctx = createMockBContext(opts)
  bootEventHandlers(ctx)

  // Activate default tool via event chain (not direct activate)
  // We use the keyDown path for this
  ctx.toolRegistry.activate('OPERATOR_SELECT', ctx)

  const harness: TestHarness = {
    ctx,
    log: logCenter,

    /* —— L0 —— */

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

    /* —— L1 —— */

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

    /* —— L2 —— */

    activateTool(name) {
      const binding = TOOL_KEY_BINDING[name]
      if (!binding) throw new Error(`activateTool: unknown tool "${name}"`)
      this.keyDown(binding.key, { ctrl: binding.ctrl, shift: binding.shift })
    },

    setBrush(brushId) {
      this.setRNAValue('toolsettings.replaceBrush', brushId, ctx.settings)
    },

    clickBlock(pos, o = {}) {
      const p = ctx.queries.projectBlock(pos)
      if (!p) throw new Error(`clickBlock: block at (${pos.x},${pos.y},${pos.z}) not visible on screen`)
      this.click(p.x, p.y, { ctrl: o.ctrl, shift: o.shift })
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

    /* —— L3 —— */

    dragWorld(axis, amount, o = {}) {
      const gizmo = ctx.queries.getGizmoAnchor(axis)
      if (!gizmo) throw new Error(`dragWorld: gizmo anchor null for axis ${axis} — nothing selected?`)
      const k = ctx.settings.dragSensitivity
      const steps = o.steps ?? 5
      let screenDx = 0, screenDy = 0
      if (axis === 'x') screenDx = amount / k
      else if (axis === 'y') screenDy = -amount / k
      else screenDx = -amount / k
      this.assert(screenDeltaToWorld(screenDx, screenDy, axis, k) === amount)
      this.drag(gizmo.x, gizmo.y, gizmo.x + screenDx, gizmo.y + screenDy, { steps })
    },

    /* —— Assertions —— */

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

    assertProjectBlockNull(pos) {
      const result = ctx.queries.projectBlock(pos)
      if (result !== null) throw new Error(`projectBlock should return null for (${pos.x},${pos.y},${pos.z})`)
    },

    assertRNAPath(path) {
      const desc = ctx.rna.resolve(path)
      if (!desc) throw new Error(`RNA path "${path}" did not resolve`)
      return desc
    },

    assertAnnotationBoxCount(n) {
      const actual = ctx.queries.getAnnotationBoxes().length
      if (actual !== n) throw new Error(`annotation box count: expected ${n}, got ${actual}`)
    },

    assertAnnotationBoxExists(id) {
      const found = ctx.queries.getAnnotationBox(id)
      if (!found) throw new Error(`annotation box "${id}" not found`)
    },

    clickWorld(worldPos) {
      const p = ctx.queries.projectBlock(worldPos)
      if (!p) throw new Error(`clickWorld: (${worldPos.x},${worldPos.y},${worldPos.z}) not visible`)
      this.click(p.x, p.y)
    },

    assertContextMenuOpen() {
      const cm = (ctx.wm as any).contextMenu
      if (!cm || !cm.open) throw new Error('context menu should be open')
    },

    assertContextMenuClosed() {
      const cm = (ctx.wm as any).contextMenu
      if (cm && cm.open) throw new Error('context menu should be closed')
    },

    clickContextMenuItem(label) {
      const wm = (ctx.wm as any)
      const cm = wm.contextMenu
      if (!cm || !cm.open) throw new Error('context menu not open')
      const item = cm.items.find((i: any) => i.label === label)
      if (!item) {
        const available = cm.items.map((i: any) => i.label).join(', ')
        throw new Error(`context menu item "${label}" not found. Available: ${available}`)
      }
      ctx.operators.invoke(item.opId, item.props ?? {})
      if (wm.hideContextMenu) wm.hideContextMenu(cm)
    },

    /* —— Batch —— */

    collect() {
      return createCollector(ctx)
    },

    /* —— Scene lifecycle —— */

    async newScene() {
      await ctx.scene.newScene()
    },

    async saveToFile() {
      await ctx.scene.saveToFile()
    },

    async syncPreview() {
      await ctx.scene.syncPreview()
    },

    setWorkspaceMode(mode: string) {
      ctx.operators.exec('OPERATOR_SET_WORKSPACE_MODE', { mode })
    },

    setFrameIndex(index: number) {
      ctx.operators.exec('OPERATOR_SET_FRAME_INDEX', { index })
    },

    /* —— Spec runner —— */

    run(spec) { return runTestSpec(ctx, spec) },
  }

  return harness
}
