import { createOperatorRegistry } from '@/operators/operatorRegistry'
import { SetFrameIndexOperator, SetFramePlaybackOperator, SetLayerYOperator, ToggleFramePlaybackOperator } from '@/operators/builtin/miscOperators'
import {
  ViewRotateOperator, ViewPanOperator, ViewZoomOperator, ViewResetOperator,
  InitViewportCameraOperator,
} from '@/operators/builtin/viewOperators'
import { SyncEmbedInitialViewOperator } from '@/operators/builtin/embedInitialViewOperators'
import { LoadEmbedDocumentOperator } from '@/operators/builtin/docLifecycleOperators'
import { V2PlainParser, createEnvelopeParser, WorldParser, StructureDataParser } from '@/context/parsers/builtinParsers'
import type { EmbedBootstrapOptions } from '@/embed/embedContract'
import type { EmbedSettings } from '@/viewer/viewerConfig'
import { OpenWikiWorkbenchOperator } from '@/operators/builtin/embedWorkbenchOperators'
import { Main } from '@/runtime/main'
import { WM } from '@/runtime/wm'
import { Context } from '@/runtime/context'
import { createViewportManager } from '@/runtime/viewportManager'
import { createEmbedScreenRoot } from '@/runtime/screenRoot'
import { createToolSettings } from '@/runtime/toolSettings'
import { HostBase } from '@/runtime/host'
import { logCenter } from '@/logging/LogCenter'

export class EmbedHost extends HostBase {
  readonly log = logCenter

  constructor(
    readonly main: Main,
    readonly ctx: Context,
    readonly wm: WM,
  ) {
    super()
  }

  async start(): Promise<void> {
    // Document load: OPERATOR_LOAD_EMBED_DOCUMENT from EmbedRoot
  }
}

export function createEmbedHost(
  settings: EmbedSettings,
  bootstrap?: Pick<EmbedBootstrapOptions, 'structureBase' | 'workbenchEdit' | 'handlers'>,
): { host: EmbedHost; ctx: Context } {
  const registry = createOperatorRegistry()
  const viewports = createViewportManager()
  const wm = new WM(logCenter, { surface: 'embed' })

  const screen = createEmbedScreenRoot(createToolSettings(), {
    initialLayerWorldY: settings.initialLayerWorldY,
  })

  const main = new Main({
    operators: registry,
    tools: null,
    rna: null,
  })

  if (bootstrap?.structureBase) {
    main.embedStructureBase.value = bootstrap.structureBase
  }
  if (bootstrap?.workbenchEdit) {
    main.embedWorkbenchEdit.value = bootstrap.workbenchEdit
  }
  main.embedWorkbenchHandlers = bootstrap?.handlers?.workbenchEdit ?? null

  const parsers = main.registries.parsers
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)

  const ctx = new Context(main, wm, logCenter, viewports, screen, null)
  main.bindOperatorFacade(() => ctx, true)

  for (const inputId of screen.wmInputRegionIds()) {
    wm.events.registerRegion(inputId)
  }

  for (const op of [
    ViewRotateOperator, ViewPanOperator, ViewZoomOperator, ViewResetOperator,
    InitViewportCameraOperator,
    SyncEmbedInitialViewOperator, LoadEmbedDocumentOperator,
    OpenWikiWorkbenchOperator,
    SetFrameIndexOperator, ToggleFramePlaybackOperator, SetFramePlaybackOperator, SetLayerYOperator,
  ]) {
    if (!registry.find(op.id)) registry.register(op)
  }

  return { host: new EmbedHost(main, ctx, wm), ctx }
}
