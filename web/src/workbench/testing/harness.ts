/**
 * Test harness — 黑盒测试入口。
 *
 * 入口挂载：mount WorkbenchRoot.vue → VM 自己跑。
 * 测试只做：注入 DOM 事件 + 观测公开状态。
 */

import type { BContext } from '@/workbench/context/bContext'
import type { TestSpec, TestResult } from './testRunner'
import { runTestSpec } from './testRunner'
import { buildTestSceneDocument, blocksToCellGrid, type BlockTuple } from './testScene'

import { createApp, h, type Component } from 'vue'
import { bContextKey } from '@/workbench/context/bContext'
import { logCenter } from '@/workbench/logging/LogCenter'
import type { CheckResult } from '@/workbench/logging/LogCenter'
import { eventDispatcher } from '@/workbench/eventDispatcher'
import { createToolGizmoHandler } from '@/workbench/handlers/toolGizmoHandler'
import { createActiveToolHandler } from '@/workbench/handlers/activeToolHandler'
import { createUIHandler } from '@/workbench/handlers/uiHandler'
import { HANDLER_TYPE } from '@/workbench/events/eventTypes'
import { DEFAULT_KEYMAP, matchBinding } from '@/workbench/keymap'
import * as THREE from 'three'

// 工具键映射（与 WorkbenchRoot 一致）
const TOOL_KEY_MAP: Record<string, string> = {
  select: 'OPERATOR_SELECT', move: 'OPERATOR_MOVE',
  delete: 'OPERATOR_DELETE', replace: 'OPERATOR_REPLACE',
  fill: 'OPERATOR_FILL', eyedropper: 'OPERATOR_EYEDROPPER',
  mirror: 'OPERATOR_MIRROR',
  'add-block': 'OPERATOR_ADD_BLOCK',
  'add-annotation-box': 'OPERATOR_ADD_ANNOTATION_BOX',
}

import WorkbenchRoot from '@/workbench/WorkbenchRoot.vue'

// ---- 视口初始化（模拟 StructureViewport 的 onViewportReady） ----
function createTestCamera(): THREE.OrthographicCamera {
  const aspect = 800 / 600
  const frustumSize = 20
  const camera = new THREE.OrthographicCamera(
    -frustumSize * aspect / 2, frustumSize * aspect / 2,
    frustumSize / 2, -frustumSize / 2, 0.1, 500,
  )
  camera.position.set(5, 20, 5)
  camera.up.set(0, 1, 0)
  camera.lookAt(0, 0, 0)
  return camera
}

function populateContentGroup(cellGrid: number[][][]): THREE.Group {
  const g = new THREE.Group()
  const sizeZ = cellGrid.length
  const sizeY = cellGrid[0]?.length ?? 0
  const sizeX = cellGrid[0]?.[0]?.length ?? 0
  if (sizeX > 0 && sizeY > 0 && sizeZ > 0) {
    const geo = new THREE.BoxGeometry(1, 1, 1)
    const mat = new THREE.MeshBasicMaterial()
    for (let z = 0; z < sizeZ; z++) {
      const slice = cellGrid[z]; if (!slice) continue
      for (let y = 0; y < sizeY; y++) {
        const row = slice[y]; if (!row) continue
        for (let x = 0; x < sizeX; x++) {
          if (row[x] === 0) continue
          const mesh = new THREE.Mesh(geo, mat)
          mesh.position.set(x - sizeX / 2 + 0.5, sizeY / 2 - y - 0.5, z - sizeZ / 2 + 0.5)
          g.add(mesh)
        }
      }
    }
  }
  g.updateMatrixWorld()
  return g
}

let _canvas: HTMLElement | null = null

function ensureCanvas(): HTMLElement {
  if (!_canvas) {
    _canvas = document.createElement('canvas')
    _canvas.getBoundingClientRect = (() => {
      const r = { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }
      return () => ({ ...r, toJSON() { return {} } })
    })() as any
    document.body.appendChild(_canvas)
  }
  return _canvas
}

// ---- 工具键 ----
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

// ---- Collector ----
export interface CheckCollector {
  check(name: string, fn: () => boolean, expected: unknown, actual?: () => unknown): this
  done(): CheckResult[]
}

function createCollector(): CheckCollector {
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
  canvas: HTMLElement | null
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

let _appMounted = false
let _handlersBooted = false
let _bctx: BContext | null = null

export function createTestHarness(opts?: {
  blocks?: BlockTuple[]
  document?: Record<string, any>
  settings?: Record<string, any>
  blockPalette?: Record<string, { name: string }>
}): TestHarness {
  const blocks = opts?.blocks ?? []

  // 1. 入口挂载（首次），后续复用 VM
  if (!_appMounted) {
    _appMounted = true
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp(WorkbenchRoot)
    app.mount(container)

    // WorkbenchRoot 在 setup 中写入 window.__vm__
    _bctx = (window as any).__vm__ as BContext
    if (!_bctx) throw new Error('WorkbenchRoot mount failed: window.__vm__ not set')
  }

  const bctx = _bctx!

  // 2. 视口初始化 + 事件监听（等同 WorkbenchViewport.onViewportReady）
  //    生产路径：StructureViewport 创建 canvas → onViewportReady 注册 listener
  //    测试路径：自建 canvas → 注册相同 listener
  const camera = createTestCamera()
  const { cellGrid, blockPalette } = blocksToCellGrid(blocks)
  const contentGroup = populateContentGroup(cellGrid)
  const canvas = ensureCanvas()

  const vp = bctx.viewport
  vp.camera.value = camera
  vp.contentGroup.value = contentGroup
  vp.domElement.value = canvas
  vp.definition.value = { cellGrid, blockPalette } as any
  vp.layerPreview.value = 'all'
  vp.controls.value = null

  // 3. 注册事件链（等同 WorkbenchViewport.onViewportReady 的 handler 注册）
  if (!_handlersBooted) {
    _handlersBooted = true
    let gizmoRef: any = null

    // Canvas → eventDispatcher
    canvas.addEventListener('pointerdown', (e: any) => {
      const result = eventDispatcher.dispatch(e)
      if (result.break) e.stopImmediatePropagation?.()
    }, { capture: true } as any)
    canvas.addEventListener('pointermove', (e: any) => {
      eventDispatcher.dispatch(e)
    }, { capture: true } as any)
    canvas.addEventListener('pointerup', (e: any) => {
      const result = eventDispatcher.dispatch(e)
      if (result.break) e.stopImmediatePropagation?.()
    }, { capture: true } as any)

    // Dispatcher handlers
    const getBctx = () => bctx
    eventDispatcher.registerTypedHandler(
      createToolGizmoHandler(
        () => getBctx().toolRegistry.activeTool.value?.id ?? '',
        () => gizmoRef,
        () => getBctx(),
        () => getBctx().viewport.camera.value,
        () => getBctx().viewport.controls.value,
      ),
    )
    eventDispatcher.registerTypedHandler(createUIHandler(() => bctx))
    eventDispatcher.registerTypedHandler({
      type: HANDLER_TYPE.KEYMAP,
      handle(event: Event): { break: boolean } {
        if (!(event instanceof KeyboardEvent)) return { break: false }
        if (event.key === 'a' && event.shiftKey && !event.ctrlKey && !event.metaKey) {
          const wm = (bctx as any).wm
          if (wm?.showContextMenu) {
            wm.showContextMenu(wm.contextMenu, { x: 400, y: 300 }, [
              { kind: 'label', label: '生成', icon: '＋' },
              { kind: 'separator', label: '' },
              { kind: 'operator', label: '方块', icon: '⬜', opId: 'OPERATOR_TOOL_SET', props: { toolId: 'OPERATOR_ADD_BLOCK' } },
              { kind: 'operator', label: '注解框', icon: '📝', opId: 'OPERATOR_TOOL_SET', props: { toolId: 'OPERATOR_ADD_ANNOTATION_BOX' } },
            ])
          }
          return { break: true }
        }
        for (const binding of DEFAULT_KEYMAP) {
          if (!matchBinding(binding, event)) continue
          if (binding.toolId) {
            const opId = TOOL_KEY_MAP[binding.toolId] ?? `OPERATOR_${binding.toolId.toUpperCase()}`
            bctx.operators.exec('OPERATOR_TOOL_SET', { toolId: opId })
            return { break: true }
          }
          if (binding.action === 'undo') { bctx.operators.exec('OPERATOR_UNDO'); return { break: true } }
          if (binding.action === 'redo') { bctx.operators.exec('OPERATOR_REDO'); return { break: true } }
        }
        return { break: false }
      },
    })
    eventDispatcher.registerTypedHandler(createActiveToolHandler(() => bctx))
  }

  // 清除上次测试残留的 modal 栈
  const ed = eventDispatcher as any
  while (ed._modalStack?.length > 0) ed._modalStack.pop()

  // 4. 加载场景
  const doc = opts?.document ?? buildTestSceneDocument(blocks)
  bctx.scene.loadFromData(doc)

  // 4. 重置 selection（跨测试清理）
  bctx.selection.clear()

  const mountedFns: Array<() => void> = []

  const harness: TestHarness = {
    ctx: bctx,
    canvas,
    log: logCenter,

    /* -- L0: DOM 事件注入 -- */
    pointerDown(x, y, o = {}) {
      canvas.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: x, clientY: y, ctrlKey: o.ctrl, shiftKey: o.shift, button: 0,
      } as PointerEventInit))
    },

    pointerMove(x, y, o = {}) {
      canvas.dispatchEvent(new PointerEvent('pointermove', {
        clientX: x, clientY: y, ctrlKey: o.ctrl, shiftKey: o.shift, button: 0,
      } as PointerEventInit))
    },

    pointerUp(x, y, o = {}) {
      canvas.dispatchEvent(new PointerEvent('pointerup', {
        clientX: x, clientY: y, ctrlKey: o.ctrl, shiftKey: o.shift, button: 0,
      } as PointerEventInit))
    },

    keyDown(key, o = {}) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: o.ctrl, shiftKey: o.shift }))
    },

    /* -- L1 -- */
    click(x, y, o = {}) { this.pointerDown(x, y, o); this.pointerUp(x, y, o) },

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
      if (rects.length === 0) throw new Error(`selectBrush: no palette button for '${brushId}'`)
      const r = rects[0]
      this.click(r.bounds.x + r.bounds.width / 2, r.bounds.y + r.bounds.height / 2)
    },

    clickBlock(pos, o = {}) {
      const def = bctx.viewport.definition.value as any
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
    assert(condition, message = 'assertion failed') { if (!condition) throw new Error(message) },

    assertSelectionSize(n) {
      const actual = bctx.selection.items.value.size
      if (actual !== n) throw new Error(`selection size: expected ${n}, got ${actual}`)
    },

    assertSelectionContains(pos) {
      if (![...bctx.selection.items.value].some(s => s.pos.x === pos.x && s.pos.y === pos.y && s.pos.z === pos.z)) {
        throw new Error(`selection does not contain (${pos.x},${pos.y},${pos.z})`)
      }
    },

    assertBlockAt(pos, id?) {
      const found = bctx.queries.getFrameBlocks().find(b =>
        b.pos.x === pos.x && b.pos.y === pos.y && b.pos.z === pos.z &&
        (id === undefined || b.block_state_id === id))
      if (!found) throw new Error(`block not found at (${pos.x},${pos.y},${pos.z}) id=${id ?? 'any'}`)
    },

    assertBlockNotAt(pos) {
      if (bctx.queries.getFrameBlocks().some(b => b.pos.x === pos.x && b.pos.y === pos.y && b.pos.z === pos.z)) {
        throw new Error(`block should not exist at (${pos.x},${pos.y},${pos.z})`)
      }
    },

    assertBlockCount(n) {
      const actual = bctx.queries.getFrameBlocks().length
      if (actual !== n) throw new Error(`block count: expected ${n}, got ${actual}`)
    },

    assertOperatorActive(id) {
      if ((bctx.toolRegistry.activeTool.value?.id ?? null) !== id)
        throw new Error(`active operator: expected ${id}, got ${bctx.toolRegistry.activeTool.value?.id ?? 'null'}`)
    },

    assertProjectBlockNull(pos) {
      if (bctx.queries.projectBlock(pos) !== null)
        throw new Error(`projectBlock should return null for (${pos.x},${pos.y},${pos.z})`)
    },

    assertRNAPath(path) { return bctx.rna.resolve(path) ?? (() => { throw new Error(`not resolved: ${path}`) })() },

    assertAnnotationBoxCount(n) {
      const actual = bctx.queries.getAnnotationBoxes().length
      if (actual !== n) throw new Error(`annotation box count: expected ${n}, got ${actual}`)
    },

    assertAnnotationBoxExists(id) {
      if (!bctx.queries.getAnnotationBox(id)) throw new Error(`annotation box "${id}" not found`)
    },

    clickWorld(worldPos) {
      const p = bctx.queries.projectBlock(worldPos)
      if (!p) throw new Error(`clickWorld: (${worldPos.x},${worldPos.y},${worldPos.z}) not visible`)
      this.click(p.x, p.y)
    },

    assertContextMenuOpen() {
      const cm = (bctx.wm as any).contextMenu
      if (!cm?.open) throw new Error('context menu should be open')
    },

    assertContextMenuClosed() {
      if ((bctx.wm as any).contextMenu?.open) throw new Error('context menu should be closed')
    },

    clickContextMenuItem(label) {
      const wm = bctx.wm as any
      const cm = wm.contextMenu
      if (!cm?.open) throw new Error('context menu not open')
      const item = cm.items.find((i: any) => i.label === label)
      if (!item) throw new Error(`item "${label}" not found`)
      bctx.operators.exec(item.opId, item.props ?? {})
      if (wm.hideContextMenu) wm.hideContextMenu(cm)
    },

    assertTheme(expected) { if ((bctx.settings.theme ?? 'dark') !== expected) throw new Error(`theme: expected ${expected}`) },
    assertLanguage(expected) { if ((bctx.settings.language ?? 'zh') !== expected) throw new Error(`language: expected ${expected}`) },
    assertDirty(expected) { if (bctx.scene.dirty.value !== expected) throw new Error(`dirty: expected ${expected}`) },

    markDirty() { bctx.scene.markDirty() },
    getOperatorBounds(opId) { return bctx.ui.boundsOfByOperator(opId) },

    async newScene() { this.clickOperator('OPERATOR_NEW_SCENE') },
    async saveToFile() { await bctx.scene.saveToFile() },
    async syncPreview() { await bctx.scene.syncPreview() },
    setWorkspaceMode(mode: string) { bctx.operators.exec('OPERATOR_SET_WORKSPACE_MODE', { mode }) },
    setFrameIndex(index: number) { bctx.operators.exec('OPERATOR_SET_FRAME_INDEX', { index }) },

    collect() { return createCollector() },
    run(spec) { return runTestSpec(bctx, spec) },

    mount(comp: Component, props = {}) {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const app = createApp({ render() { return h(comp, props) } })
      app.provide(bContextKey, bctx)
      app.mount(container)
      const unmount = () => { app.unmount(); container.remove() }
      mountedFns.push(unmount)
      return unmount
    },
    unmountAll() { for (const fn of mountedFns) fn(); mountedFns.length = 0 },
  }

  return harness
}
