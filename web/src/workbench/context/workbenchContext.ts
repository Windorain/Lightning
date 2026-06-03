/**
 * createWorkbenchContext — VM 组装函数（生产 + 测试共享）。
 *
 * WorkbenchRoot.vue 调用它搭建生产 BContext。
 * 测试 harness 调用它搭建测试 VM——同一份代码，同一份行为。
 *
 * 可注入依赖（scene / connection / selection / editHistory / toolRegistry / settings）
 * 由调用方创建后传入——生产用 provide* 工厂，测试用 create* 工厂。
 */

import { createViewportManager } from '@/context/bContext'
import type { BContext, BContextSettings, WorkbenchWorkspaceMode, UIWorkspace, ConnectionState } from '@/context/bContext'
import type { SelectionContext } from '@/context/selection'
import type { UndoManager } from '@/context/editHistory'
import type { ToolRegistry } from '@/workbench/tools/registry'
import type { bScreen } from '@/workbench/ux/types/screen'
import { createOperatorRegistry, wrapOperatorRegistry } from '@/operators/operatorRegistry'
import type { OperatorType } from '@/operators/operatorType'
import type { OperatorRegistry } from '@/operators/operatorRegistry'
import { logCenter } from '@/logging/LogCenter'
import { wikiConfig } from '@/config/wikiConfig'
import { ref, reactive, type Ref } from 'vue'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import { EventDispatcherImpl } from '@/events/dispatcher'
import { createRNARegistry, blockRNA, toolSettingsRNA, sceneMetaRNA, wikiConfigRNA, annotationRNA, materialRNA } from '@/workbench/ux/rna'
import { computeLayout, boundsOfByOperator, boundsOfByRNAPath } from '@/workbench/ux/layout'
import { SpaceType, RegionType } from '@/workbench/ux/types/screen'
import {
  blockInspectorPanel, toolShelfPanel,
  transformPanel, sceneInfoPanel,
  menuBarPanel, blockStatsPanel,
  annotationPanel, wikiConfigPanel,
  tooltipEditorPanel,
} from '@/workbench/ux/panels'

// All builtin operators
import { SelectOperator, SelectByTypeOperator, SelectAllOperator } from '@/operators/builtin/selectOperator'
import { MoveOperator } from '@/operators/builtin/moveTranslate'
import { ViewRotateOperator, ViewPanOperator, ViewZoomOperator } from '@/operators/builtin/viewOperators'
import { TooltipEditOperator } from '@/operators/builtin/metaEditOperators'
import { NewSceneOperator, OpenSceneOperator, SaveFileOperator, LoadBuiltinSceneOperator } from '@/operators/builtin/docLifecycleOperators'
import { SDEConnectOperator, SDELoadExportOperator, SDEPushOperator } from '@/operators/builtin/sdeOperators'
import { ExportPlainOperator, ExportEnvelopeOperator, ExportObjOperator, ExportIsoPngOperator } from '@/operators/builtin/exportOperators'
import { AnnotationCreateOperator, AnnotationUpdateOperator, AnnotationDeleteOperator } from '@/operators/builtin/annotationOperators'
import { SetFrameIndexOperator, ThemeToggleOperator, SetLanguageOperator, UndoOperator, RedoOperator, SetWorkspaceModeOperator, ResetLayoutOperator } from '@/operators/builtin/miscOperators'
import { ExportTextureOperator, CopyMaterialLocatorOperator, ExportGifOperator } from '@/operators/builtin/materialOperators'
import { CopyCameraFromEmbedOperator } from '@/operators/builtin/copyCameraFromEmbed'

// Tools
import { selectTool, moveTool } from '@/workbench/tools/toolDefs'
import { MoveGizmo } from '@/workbench/tools/gizmos'
import { boxTool, boxFullTool, BoxGizmo, AnnotationBoxCommitOperator, AnnotationBoxResetOperator } from '@/workbench/tools/boxTool'
import { pointTool, PointGizmo } from '@/workbench/tools/pointTool'
import { lineTool, LineGizmo } from '@/workbench/tools/lineTool'
import { textTool, TextGizmo } from '@/workbench/tools/textTool'
import { faceTool, FaceGizmo } from '@/workbench/tools/faceTool'

const ALL_OPERATORS: OperatorType[] = [
  SelectOperator, SelectByTypeOperator, SelectAllOperator, MoveOperator,
  UndoOperator, RedoOperator,
  ViewRotateOperator, ViewPanOperator, ViewZoomOperator,
  TooltipEditOperator,
  NewSceneOperator, OpenSceneOperator, SaveFileOperator, LoadBuiltinSceneOperator,
  SetFrameIndexOperator,
  SetWorkspaceModeOperator, ResetLayoutOperator,
  SDEConnectOperator, SDELoadExportOperator, SDEPushOperator,
  ExportPlainOperator, ExportEnvelopeOperator, ExportObjOperator, ExportIsoPngOperator,
  ThemeToggleOperator, SetLanguageOperator,
  AnnotationCreateOperator, AnnotationUpdateOperator, AnnotationDeleteOperator,
  AnnotationBoxCommitOperator, AnnotationBoxResetOperator,
  ExportTextureOperator, CopyMaterialLocatorOperator, ExportGifOperator,
  CopyCameraFromEmbedOperator,
]

export interface WorkbenchContextDeps {
  selection: SelectionContext
  editHistory: UndoManager
  toolRegistry: ToolRegistry
  settings: BContextSettings
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

  // ---- operators (forward ref through bctx) ----
  const registry = createOperatorRegistry()
  const bctxOperators = wrapOperatorRegistry(registry, () => bctx)

  const viewports = createViewportManager()
  const eventDispatcher = new EventDispatcherImpl()

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
    blockInspectorPanel, transformPanel, sceneInfoPanel, blockStatsPanel, annotationPanel, wikiConfigPanel, tooltipEditorPanel,
  )

  // ---- 原子构造 bctx（一次性全部填入，不用 as unknown / as any 后补） ----
  const bctx: BContext = {
    doc: ref(null) as Ref<RuntimeDocument | null>,
    structEpoch: ref(0),
    currentWorldFrameIndex: ref(0),
    workspaceMode: ref<WorkbenchWorkspaceMode>('local-file'),
    uiWorkspace: ref<UIWorkspace>('preview'),
    localFileName: ref<string | null>(null),
    connection: reactive<ConnectionState>({
      apiBase: '',
      token: '',
      connected: null,
      exports: [],
      exportsLoading: false,
      selectedExportName: null,
    }),
    viewports,
    eventDispatcher,
    operators: bctxOperators,

    selection,
    editHistory,
    toolRegistry,
    get viewport() { return viewports.active.value! },
    log: logCenter,
    wikiConfig,
    settings,

    screen: defaultScreen,
    rna,
    ui: {
      boundsOfByOperator: (opId: string) => boundsOfByOperator(opId),
      boundsOfByRNAPath: (rnaPath: string) => boundsOfByRNAPath(rnaPath),
    },
    wm: {},
  }


  computeLayout(bctx, defaultScreen)

  // Register all regions with event dispatcher
  for (const area of defaultScreen.areas) {
    for (const region of area.regions) {
      eventDispatcher.registerRegion(region.id)
    }
  }

  // Register all builtin operators + tools
  registerAllOperators(registry)

  const moveGizmo = new MoveGizmo()
  const defaultVp = viewports.register('r-viewport')
  defaultVp.gizmo.value = moveGizmo
  toolRegistry.register(selectTool)
  toolRegistry.register(moveTool, moveGizmo)
  toolRegistry.register(boxTool, new BoxGizmo())
  toolRegistry.register(boxFullTool, new BoxGizmo())
  toolRegistry.register(pointTool, new PointGizmo())
  toolRegistry.register(lineTool, new LineGizmo())
  toolRegistry.register(textTool, new TextGizmo())
  toolRegistry.register(faceTool, new FaceGizmo())
  toolRegistry.activate('select')

  return { bctx, rna, screen: defaultScreen }
}

/** 注册所有内置 operator 到 registry */
export function registerAllOperators(registry: OperatorRegistry): void {
  for (const op of ALL_OPERATORS) {
    if (!registry.find(op.id)) {
      registry.register(op)
    }
  }
}