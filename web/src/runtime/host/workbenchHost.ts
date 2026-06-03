import { createOperatorRegistry, wrapOperatorRegistry } from '@/operators/operatorRegistry'
import type { OperatorType } from '@/operators/operatorType'
import type { OperatorRegistry } from '@/operators/operatorRegistry'
import { logCenter, installUnifiedLogApi } from '@/logging/LogCenter'
import { createRNARegistry, blockRNA, toolSettingsRNA, sceneMetaRNA, wikiConfigRNA, annotationRNA, materialRNA } from '@/workbench/ux/rna'
import { computeLayout, boundsOfByOperator, boundsOfByRNAPath } from '@/workbench/ux/layout'
import { SpaceType, RegionType } from '@/workbench/ux/types/screen'
import type { bScreen } from '@/workbench/ux/types/screen'
import {
  blockInspectorPanel, toolShelfPanel,
  transformPanel, sceneInfoPanel,
  menuBarPanel, blockStatsPanel,
  annotationPanel, wikiConfigPanel,
  tooltipEditorPanel,
} from '@/workbench/ux/panels'
import { SelectOperator, SelectByTypeOperator, SelectAllOperator } from '@/operators/builtin/selectOperator'
import { MoveOperator } from '@/operators/builtin/moveTranslate'
import { ViewRotateOperator, ViewPanOperator, ViewZoomOperator } from '@/operators/builtin/viewOperators'
import { TooltipEditOperator } from '@/operators/builtin/metaEditOperators'
import { NewSceneOperator, OpenSceneOperator, SaveFileOperator, LoadBuiltinSceneOperator } from '@/operators/builtin/docLifecycleOperators'
import { SDEConnectOperator, SDELoadExportOperator, SDELoadWorkspaceOperator, SDEPushOperator } from '@/operators/builtin/sdeOperators'
import { ExportPlainOperator, ExportEnvelopeOperator, ExportObjOperator, ExportIsoPngOperator } from '@/operators/builtin/exportOperators'
import { AnnotationCreateOperator, AnnotationUpdateOperator, AnnotationDeleteOperator } from '@/operators/builtin/annotationOperators'
import {
  SetFrameIndexOperator, ToggleFramePlaybackOperator, SetHoveredBlockOperator, ThemeToggleOperator, SetLanguageOperator, UndoOperator, RedoOperator,
  SetWorkspaceModeOperator, ResetLayoutOperator, SetWikiConfigOperator, ApplySettingsOperator, SetLayerYOperator,
} from '@/operators/builtin/miscOperators'
import { ExportTextureOperator, CopyMaterialLocatorOperator, ExportGifOperator } from '@/operators/builtin/materialOperators'
import { CopyCameraFromEmbedOperator } from '@/operators/builtin/copyCameraFromEmbed'
import { selectTool, moveTool } from '@/workbench/tools/toolDefs'
import { MoveGizmo } from '@/workbench/tools/gizmos'
import { boxTool, boxFullTool, BoxGizmo, AnnotationBoxCommitOperator, AnnotationBoxResetOperator } from '@/workbench/tools/boxTool'
import { pointTool, PointGizmo } from '@/workbench/tools/pointTool'
import { lineTool, LineGizmo } from '@/workbench/tools/lineTool'
import { textTool, TextGizmo } from '@/workbench/tools/textTool'
import { faceTool, FaceGizmo } from '@/workbench/tools/faceTool'
import { V2PlainParser, createEnvelopeParser, WorldParser, StructureDataParser } from '@/parsers/builtinParsers'
import { Main } from '@/runtime/main'
import { WM } from '@/runtime/wm'
import { Context } from '@/runtime/context'
import { createViewportManager } from '@/runtime/viewportManager'
import { createWorkbenchState, type WorkbenchState } from '@/runtime/state'
import type { ContextSettings } from '@/runtime/types'
import type { SelectionContext } from '@/context/selection'
import type { UndoManager } from '@/context/editHistory'
import type { ToolRegistry } from '@/workbench/tools/registry'
import { HostBase } from '@/runtime/host'
import { autoConnectSde } from '@/workbench/context/autoConnectSde'
import { parseWorkbenchQuery } from '@/workbench/utils/fileNaming'

const ALL_OPERATORS: OperatorType[] = [
  SelectOperator, SelectByTypeOperator, SelectAllOperator, MoveOperator,
  UndoOperator, RedoOperator,
  ViewRotateOperator, ViewPanOperator, ViewZoomOperator,
  TooltipEditOperator,
  NewSceneOperator, OpenSceneOperator, SaveFileOperator, LoadBuiltinSceneOperator,
  SetFrameIndexOperator, ToggleFramePlaybackOperator, SetHoveredBlockOperator, SetLayerYOperator, ApplySettingsOperator, SetWikiConfigOperator,
  SetWorkspaceModeOperator, ResetLayoutOperator,
  SDEConnectOperator, SDELoadExportOperator, SDELoadWorkspaceOperator, SDEPushOperator,
  ExportPlainOperator, ExportEnvelopeOperator, ExportObjOperator, ExportIsoPngOperator,
  ThemeToggleOperator, SetLanguageOperator,
  AnnotationCreateOperator, AnnotationUpdateOperator, AnnotationDeleteOperator,
  AnnotationBoxCommitOperator, AnnotationBoxResetOperator,
  ExportTextureOperator, CopyMaterialLocatorOperator, ExportGifOperator,
  CopyCameraFromEmbedOperator,
]

export interface WorkbenchHostDeps {
  selection: SelectionContext
  editHistory: UndoManager
  toolRegistry: ToolRegistry
  settings: ContextSettings
}

export interface WorkbenchHostResult {
  host: WorkbenchHost
  ctx: Context
  screen: bScreen
  state: WorkbenchState
}

export class WorkbenchHost extends HostBase {
  readonly main: Main
  readonly ctx: Context
  readonly wm: WM
  readonly log = logCenter

  constructor(
    main: Main,
    ctx: Context,
    wm: WM,
    readonly screen: bScreen,
    readonly state: WorkbenchState,
  ) {
    super()
    this.main = main
    this.ctx = ctx
    this.wm = wm
  }

  async start(): Promise<void> {
    const query = parseWorkbenchQuery()
    if (query.apiBase) {
      await this.ctx.operators.exec('OPERATOR_APPLY_SETTINGS', {
        connection: { apiBase: query.apiBase },
        workspaceMode: 'sde',
      })
    }
    await autoConnectSde(this.ctx)
  }
}

export function createWorkbenchHost(deps: WorkbenchHostDeps): WorkbenchHostResult {
  const { selection, editHistory, toolRegistry, settings } = deps
  const registry = createOperatorRegistry()
  const viewports = createViewportManager()
  const wm = new WM(logCenter)

  const main = new Main({
    operators: registry,
    operatorsFacade: wrapOperatorRegistry(registry, () => ctx),
    tools: toolRegistry,
    rna: null,
  })

  const parsers = main.registries.parsers
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)

  const rna = createRNARegistry()
  rna.register(blockRNA)
  rna.register(toolSettingsRNA)
  rna.register(sceneMetaRNA)
  rna.register(wikiConfigRNA)
  rna.register(annotationRNA)
  rna.register(materialRNA)
  main.registries.rna = rna

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

  const state = createWorkbenchState({
    selection,
    editHistory,
    toolRegistry,
    settings,
    screen: defaultScreen,
    rna,
    ui: {
      boundsOfByOperator: (opId: string) => boundsOfByOperator(opId),
      boundsOfByRNAPath: (rnaPath: string) => boundsOfByRNAPath(rnaPath),
    },
  })

  let ctx!: Context
  ctx = new Context(main, wm, logCenter, viewports, state, null)
  main.registries.operatorsFacade = wrapOperatorRegistry(registry, () => ctx)

  const host = new WorkbenchHost(main, ctx, wm, defaultScreen, state)
  computeLayout(ctx, defaultScreen)

  for (const area of defaultScreen.areas) {
    for (const region of area.regions) {
      wm.events.registerRegion(region.id)
    }
  }
  wm.events.registerRegion('r-chrome')

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

  installUnifiedLogApi(ctx)
  selection.bindLog(ctx.log)
  editHistory.bindLog(ctx.log)

  return { host, ctx, screen: defaultScreen, state }
}

export function registerAllOperators(registry: OperatorRegistry): void {
  for (const op of ALL_OPERATORS) {
    if (!registry.find(op.id)) registry.register(op)
  }
}

