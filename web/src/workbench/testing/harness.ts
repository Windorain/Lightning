/**
 * Test harness — 黑盒测试入口。
 *
 * 只做三件事：
 * 1. 搭 VM（createVM）
 * 2. 注入事件（L0/L1/L2/L3）
 * 3. 断言（读 VM 公开状态）
 */

import type { BContext } from '@/workbench/context/bContext'
import type { TestSpec, TestResult } from './testRunner'
import { runTestSpec } from './testRunner'
import { type BlockTuple } from './testScene'
import { createVM } from '@/workbench/context/vm'

import { createApp, h, type Component } from 'vue'
import { bContextKey } from '@/workbench/context/bContext'
import { logCenter } from '@/workbench/logging/LogCenter'
import type { CheckResult } from '@/workbench/logging/LogCenter'

// ---- 工具键映射 ----
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

const OP_ID_TO_FRIENDLY: Record<string, string> = {
  'OPERATOR_ADD_BLOCK': 'add-block',
  'OPERATOR_REPLACE': 'replace',
  'OPERATOR_FILL': 'fill',
}

// ---- Batch assertion collector ----
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

// ---- TestHarness ----
export interface TestHarness {
  ctx: BContext
  log: typeof logCenter
  pointerDown(x: number, y: number, opts?: { ctrl?: boolean; shift?: boolean }): void
  pointerMove(x: number, y: number, opts?: { ctrl?: boolean; shift?: boolean }): void
  pointerUp(x: number, y: number, opts?: { ctrl?: boolean; shift?: boolean }): void
  keyDown(key: string, opts?: { ctrl?: boolean; shift?: boolean }): void
  click(x: number, y: number, opts?: { ctrl?: boolean; shift?: boolean }): void
  drag(fromX: number, fromY: number, toX: number, toY: number, opts?: { steps?: number; ctrl?: boolean; shift?: boolean }): void
  activateTool(name: string): void
  selectBrush(brushId: string, opts?: { toolId?: string }): void
  clickBlock(pos: { x: number; y: number; z: number }, opts?: { ctrl?: boolean; shift?: boolean }): void
  clickOperator(opId: string, opts?: { index?: number }): void
  setRNAValue(rnaPath: string, value: unknown, owner?: unknown): void
  dragWorld(axis: 'x' | 'y' | 'z', amount: number, opts?: { steps?: number }): void
  assert(condition: boolean, message?: string): void
  assertSelectionSize(n: number): void
  assertSelectionContains(pos: { x: number; y: number; z: number }): void
  assertBlockAt(pos: { x: number; y: number; z: number }, id?: string): void
  assertBlockNotAt(pos: { x: number; y: number; z: number }): void
  assertBlockCount(n: number): void
  assertOperatorActive(id: string): void
  assertProjectBlockNull(pos: { x: number; y: number; z: number }): void
  assertRNAPath(path: string): any
  assertAnnotationBoxCount(n: number): void
  assertAnnotationBoxExists(id: string): void
  clickWorld(worldPos: { x: number; y: number; z: number }): void
  assertContextMenuOpen(): void
  assertContextMenuClosed(): void
  markDirty(): void
  getOperatorBounds(opId: string): Array<{ x: number; y: number; width: number; height: number }>
  clickContextMenuItem(label: string): void
  assertTheme(expected: 'dark' | 'light'): void
  assertLanguage(expected: 'zh' | 'en'): void
  assertDirty(expected: boolean): void
  newScene(): Promise<void>
  saveToFile(): Promise<void>
  syncPreview(): Promise<void>
  setWorkspaceMode(mode: string): void
  setFrameIndex(index: number): void
  collect(): CheckCollector
  run(spec: TestSpec): TestResult
  mount(comp: Component, props?: Record<string, unknown>): () => void
  unmountAll(): void
}

export function createTestHarness(opts?: {
  blocks?: BlockTuple[]
  settings?: Record<string, any>
  blockPalette?: Record<string, { name: string }>
}): TestHarness {
  const blocks = opts?.blocks ?? []

  // VM 接管一切：context 创建、BContext 组装、operator 注册、视口启动、场景加载
  const { bctx } = createVM({ blocks })

  // ---- Harness: 事件注入 + 断言 ----
  const mountedFns: Array<() => void> = []

  const harness: TestHarness = {
    ctx: bctx,
    log: logCenter,

    /* -- L0 -- */
    pointerDown(x, y, o = {}) {
      const event = new PointerEvent('pointerdown', {
        clientX: x, clientY: y, ctrlKey: o.ctrl, shiftKey: o.shift, button: 0,
      })
      Object.defineProperty(event, 'target', { value: bctx.domElement, writable: false })
      bctx.eventDispatcher.dispatch(event)
    },

    pointerMove(x, y, o = {}) {
      const event = new PointerEvent('pointermove', {
        clientX: x, clientY: y, ctrlKey: o.ctrl, shiftKey: o.shift, button: 0,
      })
      Object.defineProperty(event, 'target', { value: bctx.domElement, writable: false })
      bctx.eventDispatcher.dispatch(event)
    },

    pointerUp(x, y, o = {}) {
      const event = new PointerEvent('pointerup', {
        clientX: x, clientY: y, ctrlKey: o.ctrl, shiftKey: o.shift, button: 0,
      })
      Object.defineProperty(event, 'target', { value: bctx.domElement, writable: false })
      bctx.eventDispatcher.dispatch(event)
    },

    keyDown(key, o = {}) {
      bctx.eventDispatcher.dispatch(new KeyboardEvent('keydown', { key, ctrlKey: o.ctrl, shiftKey: o.shift }))
    },

    /* -- L1 -- */
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
        this.pointerMove(fromX + (toX - fromX) * t, fromY + (toY - fromY) * t, { ctrl, shift })
      }
      this.pointerUp(toX, toY, { ctrl, shift })
    },

    /* -- L2 -- */
    activateTool(name) {
      const binding = TOOL_KEY_BINDING[name]
      if (!binding) throw new Error(`activateTool: unknown tool "${name}"`)
      this.keyDown(binding.key, { ctrl: binding.ctrl, shift: binding.shift })
      bctx.ui.relayout()
    },

    selectBrush(brushId, opts2 = {}) {
      const doc2 = bctx.queries.getDocument()
      const palette = doc2?.block_palette
      if (palette && !palette[brushId]) {
        throw new Error(`selectBrush: '${brushId}' not in block_palette. Available: [${Object.keys(palette).join(', ')}]`)
      }
      const toolId = opts2.toolId ?? 'OPERATOR_ADD_BLOCK'
      const toolName = OP_ID_TO_FRIENDLY[toolId] ?? 'add-block'
      this.activateTool(toolName)
      bctx.ui.relayout()
      const rects = bctx.ui.boundsOfByOperatorMatchProps('OPERATOR_TOOL_SET', { brushId })
      if (rects.length === 0) {
        const allOps = bctx.ui.boundsOfByOperator('OPERATOR_TOOL_SET')
        throw new Error(`selectBrush: no palette button for '${brushId}'. Available: ${JSON.stringify(allOps)}`)
      }
      const r = rects[0]
      this.click(r.bounds.x + r.bounds.width / 2, r.bounds.y + r.bounds.height / 2)
    },

    clickBlock(pos, o = {}) {
      const def = bctx.definition as any
      const sizeX = def?.cellGrid?.[0]?.[0]?.length ?? 0
      const sizeY = def?.cellGrid?.[0]?.length ?? 0
      const sizeZ = def?.cellGrid?.length ?? 0
      const worldPos = {
        x: sizeX > 0 ? pos.x - sizeX / 2 + 0.5 : pos.x,
        y: sizeY > 0 ? sizeY / 2 - pos.y - 0.5 : pos.y,
        z: sizeZ > 0 ? pos.z - sizeZ / 2 + 0.5 : pos.z,
      }
      const p = bctx.queries.projectBlock(worldPos)
      if (!p) throw new Error(`clickBlock: block at (${pos.x},${pos.y},${pos.z}) not visible`)
      this.click(p.x, p.y, { ctrl: o.ctrl, shift: o.shift })
    },

    clickOperator(opId, o = {}) {
      const rects = bctx.ui.boundsOfByOperator(opId)
      const idx = o.index ?? 0
      if (idx >= rects.length) throw new Error(`clickOperator: ${opId} has only ${rects.length} instances`)
      const r = rects[idx]
      this.click(r.x + r.width / 2, r.y + r.height / 2)
    },

    setRNAValue(rnaPath, value, owner) {
      const desc = bctx.rna.resolve(rnaPath)
      if (!desc) throw new Error(`setRNAValue: RNA path "${rnaPath}" not resolved`)
      desc.set(owner ?? {}, value)
    },

    /* -- L3 -- */
    dragWorld(axis, amount, o = {}) {
      const gizmo = bctx.queries.getGizmoAnchor(axis)
      if (!gizmo) throw new Error(`dragWorld: gizmo anchor null for axis ${axis}`)
      const k = bctx.settings.dragSensitivity
      const steps = o.steps ?? 5
      let screenDx = 0, screenDy = 0
      if (axis === 'x') screenDx = amount / k
      else if (axis === 'y') screenDy = -amount / k
      else screenDx = -amount / k
      this.drag(gizmo.x, gizmo.y, gizmo.x + screenDx, gizmo.y + screenDy, { steps })
    },

    /* -- Assertions -- */
    assert(condition, message = 'assertion failed') {
      if (!condition) throw new Error(message)
    },

    assertSelectionSize(n) {
      const actual = bctx.selection.items.value.size
      if (actual !== n) throw new Error(`selection size: expected ${n}, got ${actual}`)
    },

    assertSelectionContains(pos) {
      const found = [...bctx.selection.items.value].some(
        s => s.pos.x === pos.x && s.pos.y === pos.y && s.pos.z === pos.z,
      )
      if (!found) throw new Error(`selection does not contain (${pos.x},${pos.y},${pos.z})`)
    },

    assertBlockAt(pos, id?) {
      const blocks = bctx.queries.getFrameBlocks()
      const found = blocks.find(b =>
        b.pos.x === pos.x && b.pos.y === pos.y && b.pos.z === pos.z &&
        (id === undefined || b.block_state_id === id),
      )
      if (!found) throw new Error(`block not found at (${pos.x},${pos.y},${pos.z}) id=${id ?? 'any'}`)
    },

    assertBlockNotAt(pos) {
      const blocks = bctx.queries.getFrameBlocks()
      if (blocks.some(b => b.pos.x === pos.x && b.pos.y === pos.y && b.pos.z === pos.z)) {
        throw new Error(`block should not exist at (${pos.x},${pos.y},${pos.z})`)
      }
    },

    assertBlockCount(n) {
      const actual = bctx.queries.getFrameBlocks().length
      if (actual !== n) throw new Error(`block count: expected ${n}, got ${actual}`)
    },

    assertOperatorActive(id) {
      const actual = bctx.toolRegistry.activeTool.value?.id
      if (actual !== id) throw new Error(`active operator: expected ${id}, got ${actual ?? 'null'}`)
    },

    assertProjectBlockNull(pos) {
      if (bctx.queries.projectBlock(pos) !== null) {
        throw new Error(`projectBlock should return null for (${pos.x},${pos.y},${pos.z})`)
      }
    },

    assertRNAPath(path) {
      const desc = bctx.rna.resolve(path)
      if (!desc) throw new Error(`RNA path "${path}" did not resolve`)
      return desc
    },

    assertAnnotationBoxCount(n) {
      if (bctx.queries.getAnnotationBoxes().length !== n) {
        throw new Error(`annotation box count: expected ${n}, got ${bctx.queries.getAnnotationBoxes().length}`)
      }
    },

    assertAnnotationBoxExists(id) {
      if (!bctx.queries.getAnnotationBox(id)) {
        throw new Error(`annotation box "${id}" not found`)
      }
    },

    clickWorld(worldPos) {
      const p = bctx.queries.projectBlock(worldPos)
      if (!p) throw new Error(`clickWorld: (${worldPos.x},${worldPos.y},${worldPos.z}) not visible`)
      this.click(p.x, p.y)
    },

    assertContextMenuOpen() {
      const cm = (bctx.wm as any).contextMenu
      if (!cm || !cm.open) throw new Error('context menu should be open')
    },

    assertContextMenuClosed() {
      const cm = (bctx.wm as any).contextMenu
      if (cm && cm.open) throw new Error('context menu should be closed')
    },

    clickContextMenuItem(label) {
      const wm = bctx.wm as any
      const cm = wm.contextMenu
      if (!cm || !cm.open) throw new Error('context menu not open')
      const item = cm.items.find((i: any) => i.label === label)
      if (!item) {
        const available = cm.items.map((i: any) => i.label).join(', ')
        throw new Error(`context menu item "${label}" not found. Available: ${available}`)
      }
      bctx.operators.exec(item.opId, item.props ?? {})
      if (wm.hideContextMenu) wm.hideContextMenu(cm)
    },

    assertTheme(expected) {
      if ((bctx.settings.theme ?? 'dark') !== expected) throw new Error(`theme: expected ${expected}`)
    },

    assertLanguage(expected) {
      if ((bctx.settings.language ?? 'zh') !== expected) throw new Error(`language: expected ${expected}`)
    },

    assertDirty(expected) {
      if (bctx.scene.dirty.value !== expected) throw new Error(`dirty: expected ${expected}`)
    },

    markDirty() { bctx.scene.markDirty() },

    getOperatorBounds(opId) { return bctx.ui.boundsOfByOperator(opId) },

    /* -- Scene lifecycle -- */
    async newScene() { this.clickOperator('OPERATOR_NEW_SCENE') },
    async saveToFile() { await bctx.scene.saveToFile() },
    async syncPreview() { await bctx.scene.syncPreview() },
    setWorkspaceMode(mode: string) { bctx.operators.exec('OPERATOR_SET_WORKSPACE_MODE', { mode }) },
    setFrameIndex(index: number) { bctx.operators.exec('OPERATOR_SET_FRAME_INDEX', { index }) },

    /* -- Batch -- */
    collect() { return createCollector(bctx) },

    /* -- Spec runner -- */
    run(spec) { return runTestSpec(bctx, spec) },

    /* -- Vue mount -- */
    mount(comp: Component, props = {}) {
      const container = document.createElement('div')
      container.dataset.testMount = String(mountedFns.length)
      document.body.appendChild(container)
      const app = createApp({ render() { return h(comp, props) } })
      app.provide(bContextKey, bctx)
      app.mount(container)
      const unmount = () => { app.unmount(); container.remove() }
      mountedFns.push(unmount)
      return unmount
    },

    unmountAll() {
      for (const fn of mountedFns) fn()
      mountedFns.length = 0
    },
  }

  return harness
}
