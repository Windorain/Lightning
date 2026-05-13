/**
 * Direct test runner — 无浏览器模式。
 *
 * 测试用例是纯数据（TestSpec JSON），直接调用 operator.invoke/modal。
 * 通过 window.__test__ 暴露给 browser-test-loop / SDD。
 *
 * 运行方式：
 *   node dist/run.js debug-eval "runTest('select-click')"
 */
import type { BContext, BContextQueries, BContextSettings } from '@/workbench/context/bContext'
import type { V2WorldFrame } from '@/render/data/sceneDocumentV2'
import type { BlockRef } from '@/workbench/selectionContext'
import { createRNARegistry, blockRNA, toolSettingsRNA, sceneMetaRNA, wikiConfigRNA } from '@/workbench/ux/rna'
import { ref } from 'vue'
import type { OperatorType } from '@/workbench/operators/operatorType'
import { globalOperators } from '@/workbench/operators/operatorRegistry'
import { eventDispatcher } from '@/workbench/eventDispatcher'
import { logCenter } from '@/workbench/logging/LogCenter'

/* —— Mock RNA —— */

function createMockRNA() {
  const rna = createRNARegistry()
  rna.register(blockRNA)
  rna.register(toolSettingsRNA)
  rna.register(sceneMetaRNA)
  rna.register(wikiConfigRNA)
  return rna
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

  if (opts?.blocks?.length) {
    const frame: V2WorldFrame = {
      label: 'Frame 0',
      index: 0,
      blocks: opts.blocks.map(b => ({
        pos: { x: b.x, y: b.y, z: b.z },
        block_state_id: b.id,
      })),
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

  const mockQueries: BContextQueries = {
    pickVoxel(event: PointerEvent): BlockRef | null {
      return (event as any).__mockPickedBlock ?? null
    },
    getCurrentFrame(): V2WorldFrame | null {
      const doc = mockScene.value
      if (!doc?.frames?.length) return null
      return doc.frames[frameIndex.value ?? 0] ?? null
    },
    getFrameBlocks(): BlockRef[] {
      const frame = this.getCurrentFrame()
      if (!frame) return []
      return (frame.blocks ?? []).map(b => ({
        pos: { ...b.pos },
        block_state_id: b.block_state_id,
      }))
    },
    getDocument(): Record<string, any> | null {
      return mockScene.value
    },
    projectBlock(_pos) { return null },
    getGizmoAnchor(_axis) { return null },
    axisAdd(origin, axis, delta) {
      return {
        x: origin.x + (axis === 'x' ? delta : 0),
        y: origin.y + (axis === 'y' ? delta : 0),
        z: origin.z + (axis === 'z' ? delta : 0),
      }
    },
    roundVec(v) {
      return { x: Math.round(v.x), y: Math.round(v.y), z: Math.round(v.z) }
    },
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
      scene: mockScene,
      dirty: mockDirty,
      markDirty() { mockDirty.value = true },
      markClean() { mockDirty.value = false },
    } as any,
    selection: {
      items: selectionItems,
      frameIndex,
      select(voxel: BlockRef) { selectionItems.value = new Set([voxel]) },
      add(voxels: BlockRef[]) {
        const s = new Set(selectionItems.value)
        voxels.forEach(v => s.add(v))
        selectionItems.value = s
      },
      clear() { selectionItems.value = new Set() },
    } as any,
    editHistory: { push() {}, entries: [] } as any,
    toolRegistry: {
      activeTool: ref(null),
      activate(id: string) { (this.activeTool as any).value = { id } },
      deactivate() { (this.activeTool as any).value = null },
      rebuildTools() {},
      tools: ref(new Map()),
      getPreviousEditToolId() { return null },
    } as any,
    connection: {} as any,
    queries: mockQueries,
    settings: mockSettings,
    camera: null,
    contentGroup: null,
    domElement: null,
    controlsRef: { enabled: true },
    definition: null,
    layerPreview: null,
    wm: { windows: [], activeWindow: null } as any,
    screen: null as any,
    area: null as any,
    region: null as any,
    rna: createMockRNA(),
    ui: {
      computeLayout: (_s: any) => {},
      boundsOf: (_id: string) => null,
      regionAt: (_x: number, _y: number) => null,
      relayout: () => {},
    } as any,
    operators: {
      exec: (id: string, props?: Record<string, unknown>) => globalOperators.exec(mockCtx as any, id, props),
      invoke: (id: string, props?: Record<string, unknown>, event?: Event) => globalOperators.invoke(mockCtx as any, id, props, event as any),
      find: (id: string) => globalOperators.find(id),
      all: () => globalOperators.all(),
      register: (op: any) => globalOperators.register(op),
    } as any,
    eventDispatcher: eventDispatcher as any,
    log: logCenter as any,
    wikiConfig: {},
    statusMessage: ref('') as any,
  }
  return mockCtx
}

/* —— TestSpec —— */

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
  bctx.log.clear()
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
      const op = bctx.operators.find(action.id) as unknown as OperatorType | undefined
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
      const op = bctx.operators.find(activeId) as unknown as OperatorType | undefined
      if (!op) return { passed: false, error: `operator not found: ${activeId}` }
      const event = new PointerEvent(action.action, {
        clientX: action.x ?? 0, clientY: action.y ?? 0,
        ctrlKey: action.ctrlKey, shiftKey: action.shiftKey, button: 0,
      })
      // Mock pick: find block matching action coordinates
      if (action.action === 'pointerdown') {
        const frame = bctx.queries.getCurrentFrame()
        if (frame && action.x !== undefined && action.y !== undefined && action.z !== undefined) {
          const block = frame.blocks.find(
            b => b.pos.x === action.x && b.pos.y === action.y && b.pos.z === action.z,
          )
          if (block) {
            (event as any).__mockPickedBlock = {
              pos: { ...block.pos },
              block_state_id: block.block_state_id,
            }
          }
        }
        if (op.invoke) {
          const result = op.invoke(bctx, {}, event)
          return { passed: result !== 'CANCELLED', detail: { result } }
        }
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
      const contains = bctx.log.contains(action.value as number)
      return { passed: contains, detail: { mask: action.value, recent: bctx.log.recent(action.value as number, 5) } }
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
