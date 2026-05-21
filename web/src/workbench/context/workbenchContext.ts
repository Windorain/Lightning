/**
 * createWorkbenchContext — VM 组装函数（生产 + 测试共享）。
 *
 * WorkbenchRoot.vue 调用它搭建生产 BContext。
 * 测试 harness 调用它搭建测试 VM——同一份代码，同一份行为。
 *
 * 可注入依赖（scene / connection / selection / editHistory / toolRegistry / settings）
 * 由调用方创建后传入——生产用 provide* 工厂，测试用 create* 工厂。
 */

import { computed, ref, shallowRef } from 'vue'
import type { Ref } from 'vue'
import type { BContext, LoadStatus, WorkbenchWorkspaceMode } from '@/workbench/context/bContext'
import { createViewportManager } from '@/workbench/context/bContext'
import type { SelectionContext } from '@/workbench/selectionContext'
import type { UndoManager } from '@/workbench/editHistoryContext'
import type { ToolRegistry } from '@/workbench/toolRegistry'
import type { BContextSettings } from '@/workbench/context/bContext'
import type { RuntimeDocument } from '@/workbench/context/runtimeDocument'
import type { ExportFileInfo } from '@/workbench/sdeApi'
import type { bScreen } from '@/workbench/ux/types/screen'
import type { BlockStatRow } from '@/render/interaction/blockStats'
import type { LayerPreviewMode } from '@/render/data/layerPreview'
import { globalOperators } from '@/workbench/operators/operatorRegistry'
import type { OperatorType } from '@/workbench/operators/operatorType'
import { eventDispatcher } from '@/workbench/eventDispatcher'
import { logCenter } from '@/workbench/logging/LogCenter'
import { wikiConfig } from '@/workbench/wikiConfig'
import { createProductionQueries } from '@/workbench/context/sceneQueries'
import { createRNARegistry, blockRNA, toolSettingsRNA, sceneMetaRNA, wikiConfigRNA, annotationRNA, materialRNA } from '@/workbench/ux/rna'
import { computeLayout, boundsOfByOperator, boundsOfByRNAPath } from '@/workbench/ux/layout'
import { SpaceType, RegionType } from '@/workbench/ux/types/screen'
import {
  blockInspectorPanel, toolShelfPanel,
  transformPanel, sceneInfoPanel,
  menuBarPanel, blockStatsPanel,
  annotationPanel,
} from '@/workbench/ux/panels'

// All builtin operators
import { SelectOperator, SelectByTypeOperator } from '@/workbench/operators/builtin/selectOperator'
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
import { AnnotationCreateOperator, AnnotationUpdateOperator, AnnotationDeleteOperator } from '@/workbench/operators/builtin/annotationOperators'
import { ExportTextureOperator, ExportAllTexturesOperator, CopyMaterialLocatorOperator, ExportGifOperator } from '@/workbench/operators/builtin/materialOperators'

// Tools
import { selectTool } from '@/workbench/tools/selectTool'
import { moveTool } from '@/workbench/tools/moveTool'
import { MoveGizmo } from '@/workbench/tools/gizmos'
import { boxTool, BoxGizmo } from '@/workbench/tools/boxTool'
import { pointTool, PointGizmo } from '@/workbench/tools/pointTool'
import { lineTool, LineGizmo } from '@/workbench/tools/lineTool'
import { textTool, TextGizmo } from '@/workbench/tools/textTool'

const ALL_OPERATORS: OperatorType[] = [
  SelectOperator, SelectByTypeOperator, MoveOperator,
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
  AnnotationCreateOperator, AnnotationUpdateOperator, AnnotationDeleteOperator,
  ExportTextureOperator, ExportAllTexturesOperator, CopyMaterialLocatorOperator, ExportGifOperator,
]

export interface WorkbenchContextDeps {
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
  const { selection, editHistory, toolRegistry, settings } = deps

  // === 场景核心数据 ===
  const doc: Ref<RuntimeDocument | null> = ref(null)
  const dirty = ref(false)
  const structEpoch = ref(0)
  const currentWorldFrameIndex = ref(0)
  const workspaceMode = ref<WorkbenchWorkspaceMode>('local-file')
  const localFileName = ref<string | null>(null)

  function markDirty(): void { dirty.value = true }
  function markStructureDirty(): void { structEpoch.value += 1; markDirty() }
  function markClean(): void { dirty.value = false }

  // === 连接数据 ===
  const connectionApiBase = ref('')
  const connectionToken = ref('')
  const connectionConnected = ref<boolean | null>(null)
  const connectionExports = ref<ExportFileInfo[]>([])
  const connectionExportsLoading = ref(false)
  const connectionSelectedExportName = ref<string | null>(null)

  // ---- 所有独立的 ref / computed / 对象先创建 ----
  const loadStatus = ref<LoadStatus>('loading')
  const meshBusy = ref(false)
  const worldFrameIndex = ref(0)
  const worldFrameCount = computed(() => 0)
  const hasWorldMultiFrame = computed(() => worldFrameCount.value > 1)
  const framesPlaybackIsPlaying = ref(false)
  const layerWorldY = ref(-1)
  const layerPreviewMode = computed<LayerPreviewMode>(() => 'all')
  const layerPreviewLabel = computed(() => 'ALL')
  const gridHeight = computed(() => 0)
  const blockStatsEntries = computed<BlockStatRow[]>(() => [])
  const viewports = createViewportManager()

  // RNA
  const rna = createRNARegistry()
  rna.register(blockRNA)
  rna.register(toolSettingsRNA)
  rna.register(sceneMetaRNA)
  rna.register(wikiConfigRNA)
  rna.register(annotationRNA)
  rna.register(materialRNA)

  // Screen layout
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
    blockInspectorPanel, transformPanel, sceneInfoPanel, blockStatsPanel, annotationPanel,
  )

  // ---- 原子构造 bctx（一次性全部填入，不用 as unknown / as any 后补） ----
  const bctx: BContext = {
    // === 新平铺字段 ===
    doc,
    dirty,
    structEpoch,
    currentWorldFrameIndex,
    workspaceMode,
    localFileName,
    markDirty,
    markStructureDirty,
    markClean,
    connectionApiBase,
    connectionToken,
    connectionConnected,
    connectionExports,
    connectionExportsLoading,
    connectionSelectedExportName,

    selection,
    editHistory,
    toolRegistry,
    get viewport() { return viewports.active.value! },
    viewports,
    operators: {
      exec: (id: string, props?: Record<string, unknown>) => globalOperators.exec(bctx, id, props),
      invoke: (id: string, props?: Record<string, unknown>, event?: Event, regionId?: string) =>
        globalOperators.invoke(bctx, id, props, event as PointerEvent | KeyboardEvent, regionId),
      find: (id: string) => globalOperators.find(id),
      all: () => globalOperators.all(),
      register: (op: OperatorType) => globalOperators.register(op),
    },
    eventDispatcher,
    log: logCenter,
    wikiConfig,
    statusMessage: deps.statusMessage ?? ref(''),
    settings,

    blockIconCache: shallowRef(null),
    tooltipPalette: shallowRef<string[]>([]),

    worldFrameIndex,
    worldFrameCount,
    hasWorldMultiFrame,
    framesPlaybackIsPlaying,
    toggleWorldFramesPlayback() {},

    layerWorldY,
    layerPreviewMode,
    layerPreviewLabel,
    gridHeight,

    loadStatus,
    meshBusy,
    setCurrentWorldFrame: async () => {},
    loadStructureAndResources: async () => {},
    rebuildContentMesh: async () => {},
    rebuildAnnotationOverlay: async () => null,
    disposeCachesAndLibrary() {},
    reloadFromConfig: async () => {},
    registerScene() {},
    blockStatsEntries,

    // queries 需 bctx 自身（循环引用）——先填 null，下一行立即赋真值
    queries: null!,
    screen: defaultScreen,
    rna,
    ui: {
      boundsOfByOperator: (opId: string) => boundsOfByOperator(opId),
      boundsOfByRNAPath: (rnaPath: string) => boundsOfByRNAPath(rnaPath),
    },
    wm: {},
  }

  bctx.queries = createProductionQueries(bctx)

  computeLayout(bctx, defaultScreen)

  // Register all regions with event dispatcher
  for (const area of defaultScreen.areas) {
    for (const region of area.regions) {
      eventDispatcher.registerRegion(region.id)
    }
  }

  // Register all builtin operators + tools
  registerAllOperators(bctx)

  const moveGizmo = new MoveGizmo()
  const defaultVp = viewports.register('r-viewport')
  defaultVp.gizmo.value = moveGizmo
  toolRegistry.register(selectTool)
  toolRegistry.register(moveTool, moveGizmo)
  toolRegistry.register(boxTool, new BoxGizmo())
  toolRegistry.register(pointTool, new PointGizmo())
  toolRegistry.register(lineTool, new LineGizmo())
  toolRegistry.register(textTool, new TextGizmo())
  toolRegistry.activate('select')

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