import { createOperatorRegistry, wrapOperatorRegistry } from '@/operators/operatorRegistry'
import { SetFrameIndexOperator, ToggleFramePlaybackOperator } from '@/operators/builtin/miscOperators'
import { ViewRotateOperator, ViewPanOperator, ViewZoomOperator } from '@/operators/builtin/viewOperators'
import { CopyCameraFromEmbedOperator } from '@/operators/builtin/copyCameraFromEmbed'
import { LoadEmbedDocumentOperator } from '@/operators/builtin/docLifecycleOperators'
import { V2PlainParser, createEnvelopeParser, WorldParser, StructureDataParser } from '@/parsers/builtinParsers'
import type { EmbedSettings } from '@/preview/previewConfig'
import { Main } from '@/runtime/main'
import { WM } from '@/runtime/wm'
import { Context, provideContext } from '@/runtime/context'
import { createViewportManager } from '@/runtime/viewportManager'
import { createEmbedState } from '@/runtime/state'
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
  const wm = new WM()
  viewports.register('r-embed')

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

  const embedState = createEmbedState(
    {
      replaceBrush: null,
      fillBrush: null,
      generateType: null,
      dragSensitivity: 0.05,
      snapEnabled: true,
    },
    { initialCamera: settings.initialCamera },
  )

  let ctx!: Context
  ctx = new Context(main, wm, logCenter, viewports, null, embedState)
  main.registries.operatorsFacade = wrapOperatorRegistry(registry, () => ctx, true)

  for (const op of [ViewRotateOperator, ViewPanOperator, ViewZoomOperator, CopyCameraFromEmbedOperator, LoadEmbedDocumentOperator, SetFrameIndexOperator, ToggleFramePlaybackOperator]) {
    if (!registry.find(op.id)) registry.register(op)
  }

  const host = new EmbedHost(main, ctx, wm)
  provideContext(ctx)
  return { host, ctx }
}

