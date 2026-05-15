/**
 * createWorkbenchContext — VM 组装函数（生产 + 测试共享）。
 *
 * WorkbenchRoot.vue 调用它搭建生产 BContext。
 * 测试 harness 调用它搭建测试 VM——同一份代码，同一份行为。
 *
 * 可注入依赖（scene / connection / selection / editHistory / toolRegistry / settings）
 * 由调用方创建后传入——生产用 provide* 工厂，测试用 create* 工厂。
 */

import { ref } from 'vue'
import type { BContext } from '@/workbench/context/bContext'
import type { SceneContext } from '@/workbench/sceneContext'
import type { ConnectionContext } from '@/workbench/connectionContext'
import type { SelectionContext } from '@/workbench/selectionContext'
import type { UndoManager } from '@/workbench/editHistoryContext'
import type { ToolRegistry } from '@/workbench/toolRegistry'
import type { BContextSettings } from '@/workbench/context/bContext'
import type { bScreen } from '@/workbench/ux/types/screen'
import { globalOperators } from '@/workbench/operators/operatorRegistry'
import { eventDispatcher } from '@/workbench/eventDispatcher'
import { logCenter } from '@/workbench/logging/LogCenter'
import { wikiConfig } from '@/workbench/wikiConfig'
import { createProductionQueries } from '@/workbench/context/sceneQueries'
import { createRNARegistry, blockRNA, toolSettingsRNA, sceneMetaRNA, wikiConfigRNA } from '@/workbench/ux/rna'
import { computeLayout, boundsOf, boundsOfByOperator, boundsOfByRNAPath, regionAt, relayout } from '@/workbench/ux/layout'
import { SpaceType, RegionType } from '@/workbench/ux/types/screen'
import { createContextMenu } from '@/workbench/ux/contextMenu'
import {
  blockInspectorPanel, toolShelfPanel, generatePanel,
  transformPanel, batchEditPanel, annotationPanel, labelPanel, sceneInfoPanel,
  menuBarPanel,
} from '@/workbench/ux/panels'

// All builtin operators
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
import { UndoOperator, RedoOperator } from '@/workbench/operators/builtin/undoOperator'
import { ViewRotateOperator, ViewPanOperator, ViewZoomOperator } from '@/workbench/operators/builtin/viewOperators'
import { ToolSetOperator } from '@/workbench/operators/builtin/toolOperator'
import { SceneMetaEditOperator, TooltipEditOperator } from '@/workbench/operators/builtin/sceneEditOperators'
import { NewSceneOperator, OpenSceneOperator, SaveFileOperator, LoadBuiltinSceneOperator } from '@/workbench/operators/builtin/sceneLifecycleOperators'
import { SyncPreviewOperator, SetFrameIndexOperator } from '@/workbench/operators/builtin/previewOperators'
import { SetWorkspaceModeOperator, ResetLayoutOperator } from '@/workbench/operators/builtin/workspaceOperators'
import { SDEConnectOperator, SDELoadExportOperator, SDEPushOperator } from '@/workbench/operators/builtin/sdeOperators'
import { ExportPlainOperator, ExportEnvelopeOperator, ExportObjOperator, ExportIsoPngOperator } from '@/workbench/operators/builtin/exportOperators'
import { ThemeToggleOperator, SetLanguageOperator } from '@/workbench/operators/builtin/appearanceOperators'

const ALL_OPERATORS = [
  SelectOperator, MoveOperator, DeleteOperator, ReplaceOperator,
  FillOperator, EyedropperOperator, MirrorOperator,
  AddBlockOperator, AddAnnotationBoxOperator,
  AnnotationOperator, LabelOperator, UndoOperator, RedoOperator,
  ViewRotateOperator, ViewPanOperator, ViewZoomOperator,
  ToolSetOperator, SceneMetaEditOperator, TooltipEditOperator,
  NewSceneOperator, OpenSceneOperator, SaveFileOperator, LoadBuiltinSceneOperator,
  SyncPreviewOperator, SetFrameIndexOperator,
  SetWorkspaceModeOperator, ResetLayoutOperator,
  SDEConnectOperator, SDELoadExportOperator, SDEPushOperator,
  ExportPlainOperator, ExportEnvelopeOperator, ExportObjOperator, ExportIsoPngOperator,
  ThemeToggleOperator, SetLanguageOperator,
]

export interface WorkbenchContextDeps {
  scene: SceneContext
  connection: ConnectionContext
  selection: SelectionContext
  editHistory: UndoManager
  toolRegistry: ToolRegistry
  settings: BContextSettings
  statusMessage?: { value: string }
}

export interface WorkbenchContextResult {
  bctx: BContext
  rna: ReturnType<typeof createRNARegistry>
  screen: bScreen
}

/**
 * 组装 BContext VM——生产与测试共享。
 * 调用方负责创建 context 对象和后续的 operator 注册/外设挂载。
 */
export function createWorkbenchContext(deps: WorkbenchContextDeps): WorkbenchContextResult {
  const { scene, connection, selection, editHistory, toolRegistry, settings } = deps

  // ---- BContext 核心对象（与 WorkbenchRoot.vue 完全一致）----
  const bctx = {
    scene,
    selection,
    editHistory,
    toolRegistry,
    connection,
    operators: {
      exec: (id: string, props?: Record<string, unknown>) => globalOperators.exec(bctx, id, props),
      invoke: (id: string, props?: Record<string, unknown>, event?: Event) => globalOperators.invoke(bctx, id, props, event as any),
      find: (id: string) => globalOperators.find(id),
      all: () => globalOperators.all(),
      register: (op: any) => globalOperators.register(op),
    },
    eventDispatcher: eventDispatcher as any,
    log: logCenter as any,
    wikiConfig: wikiConfig as any,
    statusMessage: deps.statusMessage ?? ref('') as any,
    viewport: {
      camera: ref(null) as any,
      contentGroup: ref(null) as any,
      domElement: ref(null) as any,
      controls: ref(null) as any,
      definition: ref(null) as any,
      layerPreview: ref(null) as any,
      gizmo: ref(null) as any,
      overlayScene: ref(null) as any,
      wireframe: ref(null) as any,
    },
    settings,
  } as BContext

  // queries 依赖 bctx 自身（循环引用）
  bctx.queries = createProductionQueries(bctx)

  // ---- RNA 注册表 ----
  const rna = createRNARegistry()
  rna.register(blockRNA)
  rna.register(toolSettingsRNA)
  rna.register(sceneMetaRNA)
  rna.register(wikiConfigRNA)

  // ---- 默认 screen 布局 ----
  const defaultScreen: bScreen = {
    id: 'workbench',
    areas: [
      {
        id: 'viewport-area',
        spaceType: SpaceType.VIEW_3D,
        splitDir: 'none',
        parentArea: null,
        regions: [
          { id: 'r-header', type: RegionType.HEADER, panels: [], visible: true, collapsed: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, handlers: [] },
          { id: 'r-toolshelf', type: RegionType.TOOLSHELF, panels: [], visible: true, collapsed: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, handlers: [] },
          { id: 'r-viewport', type: RegionType.MAIN, panels: [], visible: true, collapsed: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, handlers: [] },
        ],
      },
      {
        id: 'properties-area',
        spaceType: SpaceType.PROPERTIES,
        splitDir: 'none',
        parentArea: null,
        regions: [
          { id: 'r-props-main', type: RegionType.MAIN, panels: [], visible: true, collapsed: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, handlers: [] },
        ],
      },
    ],
    popupRegions: [],
    bounds: { width: 1400, height: 800 },
  }

  const viewportArea = defaultScreen.areas.find(a => a.spaceType === SpaceType.VIEW_3D)!
  viewportArea.regions.find(r => r.type === RegionType.TOOLSHELF)!.panels.push(toolShelfPanel)
  viewportArea.regions.find(r => r.type === RegionType.HEADER)!.panels.push(menuBarPanel)
  const propertiesArea = defaultScreen.areas.find(a => a.spaceType === SpaceType.PROPERTIES)!
  propertiesArea.regions.find(r => r.type === RegionType.MAIN)!.panels.push(
    blockInspectorPanel, generatePanel, transformPanel,
    batchEditPanel, annotationPanel, labelPanel, sceneInfoPanel,
  )

  computeLayout(bctx, defaultScreen)

  // ---- Context menu ----
  const contextMenu = createContextMenu()

  // ---- 挂载到 bctx ----
  ;(bctx as any).wm = { windows: [], activeWindow: null, contextMenu }
  ;(bctx as any).screen = defaultScreen
  ;(bctx as any).area = null
  ;(bctx as any).region = null
  ;(bctx as any).rna = rna
  ;(bctx as any).ui = {
    computeLayout: (s: bScreen) => computeLayout(bctx, s),
    boundsOf: (id: string) => boundsOf(bctx, id),
    boundsOfByOperator: (opId: string) => boundsOfByOperator(opId),
    boundsOfByRNAPath: (rnaPath: string) => boundsOfByRNAPath(rnaPath),
    regionAt: (x: number, y: number) => regionAt(defaultScreen, x, y),
    relayout: () => relayout(bctx),
  }

  return { bctx, rna, screen: defaultScreen }
}

/** 注册所有内置 operator 到 globalOperators */
export function registerAllOperators(bctx: BContext): void {
  for (const op of ALL_OPERATORS) {
    if (!globalOperators.find(op.id)) {
      bctx.operators.register(op)
    }
  }
}

// ---- 测试视口启动（对标 WorkbenchViewport.onViewportReady） ----

import { JSDOM } from 'jsdom'
import * as THREE from 'three'
import { createToolGizmoHandler } from '@/workbench/handlers/toolGizmoHandler'
import { createActiveToolHandler } from '@/workbench/handlers/activeToolHandler'
import { createUIHandler } from '@/workbench/handlers/uiHandler'
import { HANDLER_TYPE } from '@/workbench/events/eventTypes'
import { DEFAULT_KEYMAP, matchBinding } from '@/workbench/keymap'

let _testDomElement: HTMLElement | null = null

function ensureTestDom(): HTMLElement {
  if (!_testDomElement) {
    const dom = new JSDOM('<!DOCTYPE html><html><body><canvas id="test-canvas"></canvas></body></html>')
    _testDomElement = dom.window.document.getElementById('test-canvas') as HTMLElement
    _testDomElement.getBoundingClientRect = (() => {
      const r = { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }
      return () => ({ ...r, toJSON() { return {} } })
    })() as any
  }
  return _testDomElement
}

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
          mesh.position.set(
            x - sizeX / 2 + 0.5,
            sizeY / 2 - y - 0.5,
            z - sizeZ / 2 + 0.5,
          )
          g.add(mesh)
        }
      }
    }
  }
  g.updateMatrixWorld()
  return g
}

const TOOL_KEY_MAP: Record<string, string> = {
  select: 'OPERATOR_SELECT', move: 'OPERATOR_MOVE',
  delete: 'OPERATOR_DELETE', replace: 'OPERATOR_REPLACE',
  fill: 'OPERATOR_FILL', eyedropper: 'OPERATOR_EYEDROPPER',
  mirror: 'OPERATOR_MIRROR',
  'add-block': 'OPERATOR_ADD_BLOCK',
  'add-annotation-box': 'OPERATOR_ADD_ANNOTATION_BOX',
}

export interface BootViewportOpts {
  cellGrid: number[][][]
  blockPalette: Array<{ registryId: string; meta: number }>
}

/**
 * 启动测试视口——对标 WorkbenchViewport.onViewportReady。
 * 创建 camera / contentGroup / domElement / definition，
 * 注册事件 handlers。harness 调用一次即可。
 */
let _viewportBooted = false
let _activeBctx: BContext | null = null
const _registeredHandlerUnsubs: Array<() => void> = []

/** 硬重置——清空跨测试累积的单例状态 */
function resetVMState(): void {
  // 清空 modal 栈
  const ed = _activeBctx?.eventDispatcher ?? eventDispatcher as any
  while ((ed as any)._modalStack?.length > 0) {
    (ed as any)._modalStack.pop()
  }
  // 注销上次注册的 handlers
  for (const unsub of _registeredHandlerUnsubs) unsub()
  _registeredHandlerUnsubs.length = 0
  _viewportBooted = false
}

export function bootTestViewport(bctx: BContext, opts: BootViewportOpts): void {
  // 每次调用先重置旧 VM 残留状态
  resetVMState()
  _activeBctx = bctx
  _viewportBooted = true

  const { cellGrid, blockPalette } = opts

  // camera
  const camera = createTestCamera()
  bctx.viewport.camera.value = camera

  // contentGroup（mesh 供 pickVoxel 射线检测）
  const contentGroup = populateContentGroup(cellGrid)
  bctx.viewport.contentGroup.value = contentGroup

  // DOM
  bctx.viewport.domElement.value = ensureTestDom()

  // definition（供 buildVoxelVolume）
  bctx.viewport.definition.value = { cellGrid, blockPalette } as any

  // layer preview
  bctx.viewport.layerPreview.value = 'all'

  // controls
  bctx.viewport.controls.value = null

  // 注册事件 handlers（与 WorkbenchViewport.onViewportReady 一致，只注册一次）
  let gizmoRef: any = null
  const getBctx = () => _activeBctx
  const getCamera = () => _activeBctx?.viewport.camera.value ?? null
  const getControls = () => _activeBctx?.viewport.controls.value ?? null

  _registeredHandlerUnsubs.push(bctx.eventDispatcher.registerTypedHandler(
    createToolGizmoHandler(
      () => getBctx()?.toolRegistry.activeTool.value?.id ?? '',
      () => gizmoRef,
      () => getBctx(),
      () => getCamera(),
      () => getControls(),
    ),
  ))
  _registeredHandlerUnsubs.push(bctx.eventDispatcher.registerTypedHandler(createUIHandler(() => getBctx())))
  _registeredHandlerUnsubs.push(bctx.eventDispatcher.registerTypedHandler({
    type: HANDLER_TYPE.KEYMAP,
    handle(event: Event): { break: boolean } {
      const ctx = getBctx()
      if (!ctx || !(event instanceof KeyboardEvent)) return { break: false }
      if (event.key === 'a' && event.shiftKey && !event.ctrlKey && !event.metaKey) {
        const ADD_MENU_ITEMS = [
          { kind: 'label', label: '生成', icon: '＋' },
          { kind: 'separator', label: '' },
          { kind: 'operator', label: '方块', icon: '⬜', opId: 'OPERATOR_TOOL_SET', props: { toolId: 'OPERATOR_ADD_BLOCK' } },
          { kind: 'operator', label: '注解框', icon: '📝', opId: 'OPERATOR_TOOL_SET', props: { toolId: 'OPERATOR_ADD_ANNOTATION_BOX' } },
        ]
        const wm = (ctx as any).wm
        if (wm?.showContextMenu) {
          wm.showContextMenu(wm.contextMenu, { x: 400, y: 300 }, ADD_MENU_ITEMS)
        }
        return { break: true }
      }
      for (const binding of DEFAULT_KEYMAP) {
        if (!matchBinding(binding, event)) continue
        if (binding.toolId) {
          const opId = TOOL_KEY_MAP[binding.toolId] ?? `OPERATOR_${binding.toolId.toUpperCase()}`
          ctx.operators.exec('OPERATOR_TOOL_SET', { toolId: opId })
          return { break: true }
        }
        if (binding.action === 'undo') { ctx.operators.exec('OPERATOR_UNDO'); return { break: true } }
        if (binding.action === 'redo') { ctx.operators.exec('OPERATOR_REDO'); return { break: true } }
      }
      return { break: false }
    },
  }))
  _registeredHandlerUnsubs.push(bctx.eventDispatcher.registerTypedHandler(createActiveToolHandler(() => getBctx())))
}
