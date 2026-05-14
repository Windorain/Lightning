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
import { createRNARegistry, blockRNA, toolSettingsRNA, sceneMetaRNA, wikiConfigRNA } from '@/workbench/ux/rna'
import { computeLayout, boundsOf, boundsOfByOperator, boundsOfByRNAPath, regionAt } from '@/workbench/ux/layout'
import type { bScreen } from '@/workbench/ux/types/screen'
import { ref } from 'vue'
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

  if (blockEntries.length > 0) {
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
  }

  const mockCtx = {
    scene: {
      scene: mockScene, dirty: mockDirty,
      markDirty() { mockDirty.value = true },
      markClean() { mockDirty.value = false },
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
      push(entry: any) { entry.execute?.(); this.entries.push(entry) },
      entries: [] as any[],
    } as any,
    toolRegistry: {
      activeTool: ref(null),
      activate(id: string) { (this.activeTool as any).value = { id } },
      deactivate() { (this.activeTool as any).value = null },
      rebuildTools() {},
      tools: ref(new Map()),
      getPreviousEditToolId() { return null },
    } as any,
    connection: {} as any,
    settings: mockSettings,
    camera: null, contentGroup: null, domElement: null,
    controlsRef: { enabled: true },
    definition: null, layerPreview: null,
    wm: { windows: [], activeWindow: null } as any,
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

  return mockCtx as BContext
}

/* —— TestSpec (backward compat) —— */

export interface TestAction {
  action: 'activate-operator' | 'pointerdown' | 'pointermove' | 'pointerup' | 'keydown' | 'assert-selection' | 'assert-log' | 'sleep'
  id?: string
  x?: number
  y?: number
  z?: number
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

/* —— Runner (backward compat) —— */

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
    case 'activate-operator': {
      if (!action.id) return { passed: false, error: 'missing id' }
      bctx.toolRegistry.activate(action.id, bctx)
      return { passed: bctx.toolRegistry.activeTool.value?.id === action.id, detail: { active: bctx.toolRegistry.activeTool.value?.id } }
    }

    case 'pointerdown':
    case 'pointermove':
    case 'pointerup': {
      const event = new PointerEvent(action.action, {
        clientX: action.x ?? 0, clientY: action.y ?? 0,
        ctrlKey: action.ctrlKey, shiftKey: action.shiftKey, button: 0,
      })
      const result = bctx.eventDispatcher.dispatch(event)
      return { passed: true, detail: { break: result.break } }
    }

    case 'keydown': {
      const event = new KeyboardEvent('keydown', {
        key: action.key, ctrlKey: action.ctrlKey, shiftKey: action.shiftKey,
      })
      const result = bctx.eventDispatcher.dispatch(event)
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
      return { passed: bctx.log.contains(action.value as number), detail: { mask: action.value, recent: bctx.log.recent(action.value as number, 5) } }
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
