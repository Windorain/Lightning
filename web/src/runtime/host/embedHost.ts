import { createOperatorRegistry, wrapOperatorRegistry } from '@/operators/operatorRegistry'
import { SetFrameIndexOperator, SetFramePlaybackOperator, SetLayerYOperator, ToggleFramePlaybackOperator } from '@/operators/builtin/miscOperators'
import { ViewRotateOperator, ViewPanOperator, ViewZoomOperator } from '@/operators/builtin/viewOperators'
import { CopyCameraFromEmbedOperator } from '@/operators/builtin/copyCameraFromEmbed'
import { LoadEmbedDocumentOperator } from '@/operators/builtin/docLifecycleOperators'
import { V2PlainParser, createEnvelopeParser, WorldParser, StructureDataParser } from '@/parsers/builtinParsers'
import type { EmbedSettings } from '@/preview/previewConfig'
import { Main } from '@/runtime/main'
import { WM } from '@/runtime/wm'
import { Context, provideContext } from '@/runtime/context'
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
    // Document load is driven by OPERATOR_LOAD_EMBED_DOCUMENT from EmbedRoot
  }
}

export function createEmbedHost(settings: EmbedSettings): { host: EmbedHost; ctx: Context } {
  const registry = createOperatorRegistry()
  const viewports = createViewportManager()
  const wm = new WM(logCenter, { surface: 'embed' })

  const screen = createEmbedScreenRoot(createToolSettings(), {
    initialCamera: settings.initialCamera,
    initialLayerWorldY: settings.initialLayerWorldY,
  })

  const main = new Main({
    operators: registry,
    operatorsFacade: wrapOperatorRegistry(registry, () => ctx, true),
    tools: null,
    rna: null,
  })

  const parsers = main.registries.parsers
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)

  let ctx!: Context
  ctx = new Context(main, wm, logCenter, viewports, screen, null)
  main.registries.operatorsFacade = wrapOperatorRegistry(registry, () => ctx, true)

  for (const inputId of screen.wmInputRegionIds()) {
    wm.events.registerRegion(inputId)
  }

  for (const op of [ViewRotateOperator, ViewPanOperator, ViewZoomOperator, CopyCameraFromEmbedOperator, LoadEmbedDocumentOperator, SetFrameIndexOperator, ToggleFramePlaybackOperator, SetFramePlaybackOperator, SetLayerYOperator]) {
    if (!registry.find(op.id)) registry.register(op)
  }

  const host = new EmbedHost(main, ctx, wm)
  provideContext(ctx)
  return { host, ctx }
}
