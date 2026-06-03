import { createOperatorRegistry, wrapOperatorRegistry } from '@/operators/operatorRegistry'
import type { OperatorType } from '@/operators/operatorType'
import type { OperatorRegistry } from '@/operators/operatorRegistry'
import { logCenter, installUnifiedLogApi } from '@/logging/LogCenter'
import { createRNARegistry, blockRNA, toolSettingsRNA, sceneMetaRNA, wikiConfigRNA, annotationRNA, materialRNA } from '@/workbench/ux/rna'
import { computeLayout, boundsOfByOperator, boundsOfByRNAPath } from '@/workbench/ux/layout'
import {
  blockInspectorPanel, toolShelfPanel,
  transformPanel, sceneInfoPanel,
  menuBarPanel, blockStatsPanel,
  annotationPanel, wikiConfigPanel,
  tooltipEditorPanel,
} from '@/workbench/ux/panels'
import { SelectOperator, SelectByTypeOperator, SelectAllOperator } from '@/operators/builtin/selectOperator'
import { MoveOperator } from '@/operators/builtin/moveTranslate'
import { ViewRotateOperator, ViewPanOperator, ViewZoomOperator, ViewResetOperator } from '@/operators/builtin/viewOperators'
import { TooltipEditOperator } from '@/operators/builtin/metaEditOperators'
import { NewSceneOperator, OpenSceneOperator, SaveFileOperator, LoadBuiltinSceneOperator } from '@/operators/builtin/docLifecycleOperators'
import { SDEConnectOperator, SDELoadExportOperator, SDELoadWorkspaceOperator, SDEPushOperator } from '@/operators/builtin/sdeOperators'
import { ExportPlainOperator, ExportEnvelopeOperator, ExportObjOperator, ExportIsoPngOperator } from '@/operators/builtin/exportOperators'
import { AnnotationCreateOperator, AnnotationUpdateOperator, AnnotationDeleteOperator } from '@/operators/builtin/annotationOperators'
import {
  SetFrameIndexOperator, ToggleFramePlaybackOperator, SetFramePlaybackOperator, SetHoveredBlockOperator, SetHoveredAnnotationOperator, ThemeToggleOperator, SetLanguageOperator, SetToolSettingOperator, SetRegionSettingOperator, UndoOperator, RedoOperator,
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
import type { WorkbenchServices } from '@/runtime/state'
import { createWorkbenchScreenRoot, type ScreenRoot } from '@/runtime/screenRoot'
import type { ToolSettings } from '@/runtime/contextAccess'
import type { SelectionContext } from '@/context/selection'
import type { UndoManager } from '@/context/editHistory'
import type { ToolRegistry } from '@/workbench/tools/registry'
import { HostBase } from '@/runtime/host'
import { REGION } from '@/runtime/regionIds'
import { autoConnectSde } from '@/workbench/context/autoConnectSde'
import { parseWorkbenchQuery } from '@/workbench/utils/fileNaming'

const ALL_OPERATORS: OperatorType[] = [
  SelectOperator, SelectByTypeOperator, SelectAllOperator, MoveOperator,
  UndoOperator, RedoOperator,
  ViewRotateOperator, ViewPanOperator, ViewZoomOperator, ViewResetOperator,
  TooltipEditOperator,
  NewSceneOperator, OpenSceneOperator, SaveFileOperator, LoadBuiltinSceneOperator,
  SetFrameIndexOperator, ToggleFramePlaybackOperator, SetFramePlaybackOperator, SetToolSettingOperator, SetRegionSettingOperator, SetHoveredBlockOperator, SetHoveredAnnotationOperator, SetLayerYOperator, ApplySettingsOperator, SetWikiConfigOperator,
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
  tool: ToolSettings
}

export interface WorkbenchHostResult {
  host: WorkbenchHost
  ctx: Context
  screen: ScreenRoot
  services: WorkbenchServices
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
    readonly screen: ScreenRoot,
    readonly services: WorkbenchServices,
  ) {
    super()
    this.main = main
    this.ctx = ctx
    this.wm = wm
  }

  async start(): Promise<void> {
    const query = parseWorkbenchQuery()
    if (query.apiBase) {
      await this.ctx.getOperators().exec('OPERATOR_APPLY_SETTINGS', {
        connection: { apiBase: query.apiBase },
        workspaceMode: 'sde',
      })
    }
    await autoConnectSde(this.ctx)
  }
}

export function createWorkbenchHost(deps: WorkbenchHostDeps): WorkbenchHostResult {
  const { selection, editHistory, toolRegistry, tool } = deps
  const registry = createOperatorRegistry()
  const viewports = createViewportManager()
  const wm = new WM(logCenter)

  const screen = createWorkbenchScreenRoot(tool, {
    toolShelf: [toolShelfPanel],
    header: [menuBarPanel],
    properties: [
      blockInspectorPanel, transformPanel, sceneInfoPanel, blockStatsPanel,
      annotationPanel, wikiConfigPanel, tooltipEditorPanel,
    ],
  })

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

  const services: WorkbenchServices = {
    selection,
    editHistory,
    toolRegistry,
    rna,
    ui: {
      boundsOfByOperator: (opId: string) => boundsOfByOperator(opId),
      boundsOfByRNAPath: (rnaPath: string) => boundsOfByRNAPath(rnaPath),
    },
  }

  let ctx!: Context
  ctx = new Context(main, wm, logCenter, viewports, screen, services)
  main.registries.operatorsFacade = wrapOperatorRegistry(registry, () => ctx)

  const host = new WorkbenchHost(main, ctx, wm, screen, services)
  computeLayout(ctx, screen)

  for (const inputId of screen.wmInputRegionIds()) {
    wm.events.registerRegion(inputId)
  }
  wm.events.registerRegion(REGION.CHROME)

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

  return { host, ctx, screen, services }
}

export function registerAllOperators(registry: OperatorRegistry): void {
  for (const op of ALL_OPERATORS) {
    if (!registry.find(op.id)) registry.register(op)
  }
}
