/**
 * Direct test runner — 无浏览器模式。
 *
 * 纯数学 pickVoxel / projectBlock / getGizmoAnchor，零 Three.js 依赖。
 * 只提供 mock context 工厂和兼容的 JSON spec 运行器。
 * 事件 handler 注册在 harness.ts 中完成。
 */

import type { BContext, BContextQueries, BContextSettings } from '@/workbench/context/bContext'
import type { V2WorldFrame } from '@/render/data/sceneDocumentV2'
import type { BlockRef } from '@/workbench/selectionContext'
import { documentLooksPreviewable, previewConfigFromDocument } from '@/preview/previewFromDocument'
import { createRNARegistry, blockRNA, toolSettingsRNA, sceneMetaRNA, wikiConfigRNA } from '@/workbench/ux/rna'
import { computeLayout, boundsOf, boundsOfByOperator, boundsOfByRNAPath, regionAt } from '@/workbench/ux/layout'
import { RegionType, SpaceType } from '@/workbench/ux/types/screen'
import type { bScreen } from '@/workbench/ux/types/screen'
import { menuBarPanel } from '@/workbench/ux/panels/menuBar'
import { ref, shallowRef } from 'vue'
import { globalOperators } from '@/workbench/operators/operatorRegistry'
import { eventDispatcher } from '@/workbench/eventDispatcher'
import { logCenter } from '@/workbench/logging/LogCenter'

import { screenToRay, worldToScreen, rayAABB, vec3, type CameraParams } from './rayMath'
import { createCameraForBlocks } from './cameraMocks'

/* —— Mock RNA —— */

function createMockRNA() {
  const rna = createRNARegistry()
  rna.register(blockRNA)
  rna.register(toolSettingsRNA)
  rna.register(sceneMetaRNA)
  rna.register(wikiConfigRNA)
  return rna
}

/* —— Mock Queries —— */

function blockAABB(pos: { x: number; y: number; z: number }) {
  return {
    min: vec3(pos.x - 0.5, pos.y - 0.5, pos.z - 0.5),
    max: vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5),
  }
}

function createMockQueries(
  camera: CameraParams,
  getBlocks: () => Array<{ pos: { x: number; y: number; z: number }; block_state_id: string }>,
  getFrame: () => V2WorldFrame | null,
  getDoc: () => Record<string, any> | null,
  getSelectionCenter: () => { x: number; y: number; z: number } | null,
): BContextQueries {
  return {
    pickVoxel(event: PointerEvent): BlockRef | null {
      const { origin, dir } = screenToRay(event.clientX, event.clientY, camera)
      const blocks = getBlocks()
      let bestT = Infinity
      let best: BlockRef | null = null
      for (const b of blocks) {
        const aabb = blockAABB(b.pos)
        const t = rayAABB(origin, dir, aabb.min, aabb.max)
        if (t !== null && t < bestT) {
          bestT = t
          best = { pos: { ...b.pos }, block_state_id: b.block_state_id }
        }
      }
      return best
    },

    getCurrentFrame(): V2WorldFrame | null { return getFrame() },

    getFrameBlocks(): BlockRef[] {
      return getBlocks().map(b => ({ pos: { ...b.pos }, block_state_id: b.block_state_id }))
    },

    getDocument(): Record<string, any> | null { return getDoc() },

    projectBlock(pos: { x: number; y: number; z: number }): { x: number; y: number } | null {
      return worldToScreen(vec3(pos.x, pos.y, pos.z), camera)
    },

    getGizmoAnchor(axis: 'x' | 'y' | 'z'): { x: number; y: number } | null {
      const center = getSelectionCenter()
      if (!center) return null
      const anchor = { x: center.x, y: center.y, z: center.z }
      if (axis === 'x') anchor.x += 1
      else if (axis === 'y') anchor.y += 1
      else anchor.z += 1
      return worldToScreen(vec3(anchor.x, anchor.y, anchor.z), camera)
    },

    axisAdd(origin, axis, delta) {
      return {
        x: origin.x + (axis === 'x' ? delta : 0),
        y: origin.y + (axis === 'y' ? delta : 0),
        z: origin.z + (axis === 'z' ? delta : 0),
      }
    },
    roundVec(v) { return { x: Math.round(v.x), y: Math.round(v.y), z: Math.round(v.z) } },

    getAnnotationBoxes() {
      const doc = getDoc()
      return (doc?.annotations as any[]) ?? []
    },

    getAnnotationBox(id: string) {
      const doc = getDoc()
      return (doc?.annotations as any[])?.find((a: any) => a.id === id) ?? null
    },

    pickSurface(event: PointerEvent) {
      const { origin, dir } = screenToRay(event.clientX, event.clientY, camera)
      const blocks = getBlocks()
      let bestT = Infinity
      let best: { pos: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number } } | null = null
      for (const b of blocks) {
        const aabb = blockAABB(b.pos)
        const t = rayAABB(origin, dir, aabb.min, aabb.max)
        if (t !== null && t < bestT) {
          bestT = t
          // Determine entry face from ray direction: the face where the ray
          // first enters the AABB. Compute entry t for each axis and take
          // the axis with the largest t (that axis "blocks" the ray last).
          // When t values tie (corner entry), prefer Y (top face) for intuitive placement.
          const t_x = dir.x !== 0 ? (dir.x > 0 ? aabb.min.x - origin.x : aabb.max.x - origin.x) / dir.x : -Infinity
          const t_y = dir.y !== 0 ? (dir.y > 0 ? aabb.min.y - origin.y : aabb.max.y - origin.y) / dir.y : -Infinity
          const t_z = dir.z !== 0 ? (dir.z > 0 ? aabb.min.z - origin.z : aabb.max.z - origin.z) / dir.z : -Infinity
          let nx = 0, ny = 0, nz = 0
          if (t_y >= t_x && t_y >= t_z) ny = dir.y > 0 ? -1 : 1
          else if (t_x >= t_z) nx = dir.x > 0 ? -1 : 1
          else nz = dir.z > 0 ? -1 : 1
          best = {
            pos: { x: b.pos.x + nx, y: b.pos.y + ny, z: b.pos.z + nz },
            normal: { x: nx, y: ny, z: nz },
          }
        }
      }
      return best
    },

    pickGround(event: PointerEvent) {
      const { origin, dir } = screenToRay(event.clientX, event.clientY, camera)
      if (Math.abs(dir.y) < 0.0001) return null
      const t = -origin.y / dir.y
      if (t <= 0) return null
      return {
        x: Math.round(origin.x + dir.x * t),
        y: 0,
        z: Math.round(origin.z + dir.z * t),
      }
    },

    pickWorldPoint(event: PointerEvent) {
      const surface = this.pickSurface(event)
      if (surface) return surface.pos
      const { origin, dir } = screenToRay(event.clientX, event.clientY, camera)
      if (Math.abs(dir.y) < 0.0001) return null
      const t = -origin.y / dir.y
      if (t <= 0) return null
      return {
        x: origin.x + dir.x * t,
        y: 0,
        z: origin.z + dir.z * t,
      }
    },
  }
}

/* —— Mock BContext —— */

export function createMockBContext(opts?: {
  blocks?: Array<{ x: number; y: number; z: number; id: string }>
  settings?: Partial<BContextSettings>
}): BContext {
  const selectionItems = ref<Set<BlockRef>>(new Set())
  const frameIndex = ref(0)
  const mockScene = ref<any>(null)
  const mockDirty = ref(false)

  const blockEntries = (opts?.blocks ?? []).map(b => ({
    pos: { x: b.x, y: b.y, z: b.z },
    block_state_id: b.id,
  }))

  {
    const frame: V2WorldFrame = {
      label: 'Frame 0', index: 0,
      blocks: blockEntries,
      entities: [],
    }
    mockScene.value = {
      format_version: '2.0',
      meta: { name: 'test', author: '', created_at_ms: 0, description: '', tags: [], origin: { x: 0, y: 0, z: 0 } },
      frames: [frame],
      block_palette: {},
      materials: { entries: [] },
    }
  }

  const camera = createCameraForBlocks(
    blockEntries.map(b => b.pos),
    { viewportWidth: 800, viewportHeight: 600 },
  )

  const getBlocks = () => {
    const doc = mockScene.value
    if (!doc?.frames?.length) return []
    return doc.frames[frameIndex.value ?? 0]?.blocks ?? []
  }
  const getFrame = () => {
    const doc = mockScene.value
    if (!doc?.frames?.length) return null
    return doc.frames[frameIndex.value ?? 0] ?? null
  }
  const getDoc = () => mockScene.value
  const getSelectionCenter = () => {
    const items = selectionItems.value
    if (items.size === 0) return null
    let sx = 0, sy = 0, sz = 0
    for (const item of items) { sx += item.pos.x; sy += item.pos.y; sz += item.pos.z }
    return { x: sx / items.size, y: sy / items.size, z: sz / items.size }
  }

  const mockSettings: BContextSettings = {
    replaceBrush: opts?.settings?.replaceBrush ?? null,
    fillBrush: opts?.settings?.fillBrush ?? null,
    generateType: opts?.settings?.generateType ?? null,
    dragSensitivity: opts?.settings?.dragSensitivity ?? 0.05,
    snapEnabled: opts?.settings?.snapEnabled ?? false,
    confirmDirty: () => false,
    theme: 'dark' as 'dark' | 'light',
    language: 'zh' as 'zh' | 'en',
  }

  const mockCtx = {
    scene: {
      scene: mockScene,
      dirty: mockDirty,
      sceneLoadEpoch: ref(0),
      previewWorldFrameIndex: ref(0),
      previewConfig: shallowRef(null),
      previewEpoch: ref(0),
      previewBusy: ref(false),
      previewError: ref(null),
      workspaceMode: ref('local-file') as any,
      localFileName: ref(null),

      markDirty() { mockDirty.value = true },
      markClean() { mockDirty.value = false },
      setPreviewWorldFrameIndex(index: number) { (this.previewWorldFrameIndex as any).value = index },
      setWorkspaceMode(mode: string) { (this.workspaceMode as any).value = mode },

      async newScene() {
        mockScene.value = {
          format_version: '2.0',
          meta: { name: 'new', author: '', created_at_ms: Date.now(), description: '', tags: [], origin: { x: 0, y: 0, z: 0 } },
          frames: [{ label: 'Frame 0', index: 0, blocks: [], entities: [] }],
          block_palette: {},
          materials: { entries: [] },
        }
        mockDirty.value = false
        await this.syncPreview()
      },
      async saveToFile() { /* mock: no-op */ },
      async loadSceneFromFile(_file: File) { /* mock: no-op */ },
      async loadBuiltinScene(_sceneId?: string) { /* mock: no-op */ },
      async loadFromData(_doc: unknown, _opts?: any) { /* mock: no-op */ },
      async syncPreview() {
        if (this.previewBusy.value) return
        this.previewBusy.value = true
        this.previewError.value = null
        try {
          const doc = mockScene.value
          if (!doc) {
            this.previewError.value = '无场景数据'
            this.previewConfig.value = null
            this.previewEpoch.value = 0
            return
          }
          if (!documentLooksPreviewable(doc)) {
            this.previewError.value = '当前文档缺少 textureBlobs 或非 geometryPhase=baked，无法内嵌预览（可继续编辑元数据并导出）。'
            return
          }
          const snapshot = { ...doc }
          const cfg = await previewConfigFromDocument(snapshot)
          this.previewConfig.value = cfg
          this.previewEpoch.value += 1
        } catch (e) {
          this.previewError.value = String(e)
        } finally {
          this.previewBusy.value = false
        }
      },
    } as any,
    selection: {
      items: selectionItems, frameIndex,
      select(voxel: BlockRef) { selectionItems.value = new Set([voxel]) },
      add(voxels: BlockRef[]) {
        const s = new Set(selectionItems.value)
        voxels.forEach(v => s.add(v))
        selectionItems.value = s
      },
      clear() { selectionItems.value = new Set() },
    } as any,
    editHistory: {
      canUndo: ref(false),
      canRedo: ref(false),
      _stack: [] as any[],
      _redoStack: [] as any[],

      clear() {
        this._stack = []
        this._redoStack = []
        this.canUndo.value = false
        this.canRedo.value = false
      },
      push(entry: any) {
        entry.execute?.()
        this._stack.push(entry)
        this._redoStack = []
        this.canUndo.value = this._stack.length > 0
        this.canRedo.value = false
      },
      undo() {
        const entry = this._stack.pop()
        if (entry) {
          entry.undo()
          this._redoStack.push(entry)
          this.canUndo.value = this._stack.length > 0
          this.canRedo.value = true
        }
      },
      redo() {
        const entry = this._redoStack.pop()
        if (entry) {
          entry.execute?.()
          this._stack.push(entry)
          this.canRedo.value = this._redoStack.length > 0
          this.canUndo.value = true
        }
      },
    } as any,
    toolRegistry: {
      activeTool: ref(null),
      activate(id: string) { (this.activeTool as any).value = { id } },
      deactivate() { (this.activeTool as any).value = null },
      rebuildTools() {},
      tools: ref(new Map()),
      getPreviousEditToolId() { return null },
    } as any,
    connection: {
      connected: ref(false),
      apiBase: ref(''),
      async testConnection() { /* mock: no-op */ },
      async refreshExportList() { /* mock: no-op */ },
      async fetchWorkspaceData() { return null },
      async fetchExportData(_name: string) { return {} },
      async pushToServer() { /* mock: no-op */ },
    } as any,
    settings: mockSettings,
    camera: null, contentGroup: null, domElement: null,
    controlsRef: { enabled: true },
    definition: null, layerPreview: null,
    wm: {
      windows: [], activeWindow: null,
      contextMenu: { open: false, position: { x: 0, y: 0 }, items: [] as any[] },
      showContextMenu(cm: any, pos: { x: number; y: number }, items: any[]) {
        cm.position = pos; cm.items = items; cm.open = true
      },
      hideContextMenu(cm: any) {
        cm.open = false; cm.items = []
      },
    } as any,
    screen: null as any, area: null as any, region: null as any,
    rna: createMockRNA(),
    ui: {
      computeLayout: (s: bScreen) => computeLayout(mockCtx as any, s),
      boundsOf: (id: string) => boundsOf(mockCtx as any, id),
      boundsOfByOperator: (opId: string) => boundsOfByOperator(opId),
      boundsOfByRNAPath: (rnaPath: string) => boundsOfByRNAPath(rnaPath),
      regionAt: (x: number, y: number) => regionAt(mockCtx.screen ?? null as any, x, y),
      relayout: () => { if (mockCtx.screen) computeLayout(mockCtx as any, mockCtx.screen) },
    } as any,
    operators: {
      exec: (id: string, props?: Record<string, unknown>) => globalOperators.exec(mockCtx as any, id, props),
      invoke: (id: string, props?: Record<string, unknown>, event?: Event) =>
        globalOperators.invoke(mockCtx as any, id, props, event as any),
      find: (id: string) => globalOperators.find(id),
      all: () => globalOperators.all(),
      register: (op: any) => globalOperators.register(op),
    } as any,
    eventDispatcher: eventDispatcher as any,
    log: logCenter as any,
    wikiConfig: {},
  }

  // Wire queries after ctx exists (needs getSelectionCenter closure)
  ;(mockCtx as any).queries = createMockQueries(camera, getBlocks, getFrame, getDoc, getSelectionCenter)

  // Set up minimal screen with menu panel for UI handler / clickOperator
  {
    const testScreen: bScreen = {
      id: 'test',
      bounds: { width: 800, height: 600 },
      areas: [{
        id: 'area-main',
        spaceType: SpaceType.VIEW_3D as any,
        splitDir: null,
        parentArea: null,
        regions: [{
          id: 'r-header',
          type: RegionType.HEADER,
          visible: true, collapsed: false,
          bounds: { x: 0, y: 0, width: 800, height: 32 },
          panels: [menuBarPanel],
          handlers: [],
        }],
      }],
      popupRegions: [],
    }
    computeLayout(mockCtx as any, testScreen)
  }

  return mockCtx as BContext
}

/* —— TestSpec (semantic actions, event-driven) —— */

/** 工具名 → 键盘绑定（与 harness.ts TOOL_KEY_BINDING 同源） */
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

/** 语义动作类型 — 所有动作走 L0 事件链，不直接调用 operator API */
export type TestAction =
  | { action: 'activate-tool'; tool: string }
  | { action: 'click-at'; x: number; y: number; ctrl?: boolean; shift?: boolean }
  | { action: 'click-block'; x: number; y: number; z: number }
  | { action: 'set-brush'; brush: string }
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
    /* —— Input (all through L0 events) —— */

    case 'activate-tool': {
      const binding = TOOL_KEY_BINDING[action.tool]
      if (!binding) return { passed: false, error: `unknown tool: ${action.tool}` }
      const event = new KeyboardEvent('keydown', {
        key: binding.key, ctrlKey: binding.ctrl ?? false, shiftKey: binding.shift ?? false,
      })
      bctx.eventDispatcher.dispatch(event)
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
      // First activate select tool
      const selBinding = TOOL_KEY_BINDING.select
      bctx.eventDispatcher.dispatch(new KeyboardEvent('keydown', { key: selBinding.key }))
      // Then project and click
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

    case 'set-brush': {
      const desc = bctx.rna.resolve('toolsettings.replaceBrush')
      if (!desc) return { passed: false, error: 'RNA path toolsettings.replaceBrush not resolved' }
      desc.set(bctx.settings, action.brush)
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

      // pointer down
      bctx.eventDispatcher.dispatch(new PointerEvent('pointerdown', {
        clientX: gizmo.x, clientY: gizmo.y, button: 0,
      }))
      // N moves
      for (let i = 1; i < steps; i++) {
        const t = i / steps
        bctx.eventDispatcher.dispatch(new PointerEvent('pointermove', {
          clientX: gizmo.x + screenDx * t, clientY: gizmo.y + screenDy * t, button: 0,
        }))
      }
      // pointer up at final position
      bctx.eventDispatcher.dispatch(new PointerEvent('pointerup', {
        clientX: gizmo.x + screenDx, clientY: gizmo.y + screenDy, button: 0,
      }))
      return { passed: true, detail: { axis: action.axis, amount: action.amount } }
    }

    case 'keydown': {
      const event = new KeyboardEvent('keydown', {
        key: action.key, ctrlKey: action.ctrl ?? false, shiftKey: action.shift ?? false,
      })
      bctx.eventDispatcher.dispatch(event)
      return { passed: true, detail: { key: action.key } }
    }

    /* —— Assertions —— */

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
