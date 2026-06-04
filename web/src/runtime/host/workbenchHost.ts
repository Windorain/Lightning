import { createOperatorRegistry } from '@/operators/operatorRegistry'
import { logCenter, installUnifiedLogApi } from '@/logging/LogCenter'
import { computeLayout, boundsOfByOperator, boundsOfByRNAPath } from '@/workbench/ux/layout'
import { V2PlainParser, createEnvelopeParser, WorldParser, StructureDataParser } from '@/context/parsers/builtinParsers'
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
import { autoConnectSde } from '@/runtime/host/workbenchBoot'
import { bootWikiWorkbench } from '@/runtime/host/wikiWorkbenchBoot'
import { isWikiHostProfile, setHostProfile, type HostProfile } from '@/runtime/hostProfile'
import { parseWorkbenchQuery } from '@/workbench/utils/fileNaming'
import {
  WORKBENCH_PANELS,
  registerWorkbenchOperators,
  registerWorkbenchRna,
  registerWorkbenchTools,
} from '@/workbench/registerWorkbench'

export interface WorkbenchHostDeps {
  selection: SelectionContext
  editHistory: UndoManager
  toolRegistry: ToolRegistry
  tool: ToolSettings
  profile?: HostProfile
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
    if (isWikiHostProfile()) {
      await bootWikiWorkbench(this.ctx)
      return
    }
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
  setHostProfile(deps.profile ?? 'desktop')
  const { selection, editHistory, toolRegistry, tool } = deps
  const registry = createOperatorRegistry()
  const viewports = createViewportManager()
  const wm = new WM(logCenter)

  const screen = createWorkbenchScreenRoot(tool, WORKBENCH_PANELS)

  const main = new Main({
    operators: registry,
    tools: toolRegistry,
    rna: null,
  })

  const parsers = main.registries.parsers
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)

  registerWorkbenchRna(main)

  const services: WorkbenchServices = {
    selection,
    editHistory,
    toolRegistry,
    rna: main.registries.rna!,
    ui: {
      boundsOfByOperator: (opId: string) => boundsOfByOperator(opId),
      boundsOfByRNAPath: (rnaPath: string) => boundsOfByRNAPath(rnaPath),
    },
  }

  const ctx = new Context(main, wm, logCenter, viewports, screen, services)
  main.bindOperatorFacade(() => ctx)

  const host = new WorkbenchHost(main, ctx, wm, screen, services)
  computeLayout(ctx, screen)

  for (const inputId of screen.wmInputRegionIds()) {
    wm.events.registerRegion(inputId)
  }
  wm.events.registerRegion(REGION.CHROME)

  registerWorkbenchOperators(registry)
  registerWorkbenchTools(toolRegistry, viewports, tool)

  installUnifiedLogApi(ctx)
  selection.bindLog(ctx.log)
  editHistory.bindLog(ctx.log)

  return { host, ctx, screen, services }
}
