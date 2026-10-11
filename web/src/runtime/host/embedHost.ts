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
import { capabilitiesOf } from '@/composition/resolver'
import type { ShellRuntime } from '@/composition/shell'
import { createKernelSession, KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID } from '@/runtime/kernelSession'

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
  /** 外壳运行实例（嵌入 profile 的装配结果）。缺省时构造一个**能力为空**的实例（失败关闭）。 */
  shell?: ShellRuntime,
): { host: EmbedHost; ctx: Context; shell: ShellRuntime } {
  const registry = createOperatorRegistry()
  const viewports = createViewportManager()
  const wm = new WM(logCenter, { surface: 'embed' })

  const screen = createEmbedScreenRoot(createToolSettings(), {
    initialLayerWorldY: settings.initialLayerWorldY,
  })

  const main = new Main({
    operators: registry,
    tools: null,
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

  const runtime = shell ?? { ...EMPTY_SHELL, profileId: 'embed' as const }
  // 内核会话（#261 / R-WK-03）：嵌入外壳同样由宿主创建 Editor，
  // 能力来自**嵌入 profile** 的装配结果（无内容编辑能力 ⇒ 运行时拒绝，A15）。
  const kernel = createKernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: capabilitiesOf(runtime.assembly),
  })
  const ctx = new Context(
    main,
    wm,
    logCenter,
    viewports,
    screen,
    null,
    capabilitiesOf(runtime.assembly),
    runtime.pageKeyboard,
    kernel,
  )
  main.bindOperatorFacade(() => ctx, true)

  for (const inputId of screen.wmInputRegionIds()) {
    wm.events.registerRegion(inputId)
  }

  // 查看器（嵌入）的 operator 集合就是**不含任何内容编辑命令**的那一份 ——
  // A15「运行时绕 UI 发编辑命令被拒绝」在这里有第二道落点：
  // 注册表里根本没有那些命令（第一道是 Context 的能力集合）。
  for (const op of [
    ViewRotateOperator, ViewPanOperator, ViewZoomOperator, ViewResetOperator,
    InitViewportCameraOperator,
    SyncEmbedInitialViewOperator, LoadEmbedDocumentOperator,
    OpenWikiWorkbenchOperator,
    SetFrameIndexOperator, ToggleFramePlaybackOperator, SetFramePlaybackOperator, SetLayerYOperator,
  ]) {
    if (!registry.find(op.id)) registry.register(op)
  }

  return { host: new EmbedHost(main, ctx, wm), ctx, shell: runtime }
}

/** 缺省外壳（能力为空）：调用方未提供装配结果时的**失败关闭**兜底。 */
const EMPTY_SHELL: ShellRuntime = Object.freeze({
  profileId: 'embed',
  assembly: Object.freeze({
    profileId: 'embed',
    modules: Object.freeze([]),
    capabilities: Object.freeze([]),
    contributions: Object.freeze({
      objectTypes: Object.freeze([]),
      evaluationNodes: Object.freeze([]),
      commands: Object.freeze([]),
      editors: Object.freeze([]),
      controls: Object.freeze([]),
      hostPorts: Object.freeze([]),
      shellLayouts: Object.freeze([]),
    }),
    pruned: Object.freeze([]),
    prunedLandings: Object.freeze([]),
  }),
  has: () => false,
  adjustableLayout: false,
  regions: Object.freeze([]),
  pageKeyboard: null,
})
