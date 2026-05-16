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
  blockInspectorPanel, toolShelfPanel,
  transformPanel, sceneInfoPanel,
  menuBarPanel,
} from '@/workbench/ux/panels'

// All builtin operators
import { SelectOperator } from '@/workbench/operators/builtin/selectOperator'
import { MoveOperator } from '@/workbench/operators/builtin/moveOperator'
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
  SelectOperator, MoveOperator,
  UndoOperator, RedoOperator,
  ViewRotateOperator, ViewPanOperator, ViewZoomOperator,
  ToolSetOperator,
  SceneMetaEditOperator, TooltipEditOperator,
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
      definition: ref(null) as any,
      layerPreview: ref(null) as any,
      gizmo: ref(null) as any,
      overlayScene: ref(null) as any,
      wireframe: ref(null) as any,
      orbitTarget: ref(null) as any,
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
    blockInspectorPanel, transformPanel, sceneInfoPanel,
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