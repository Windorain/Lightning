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
import { objectTypeDeclarationsOf } from '@/composition/contributedObjectTypes'
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
  bootstrap: Pick<EmbedBootstrapOptions, 'structureBase' | 'workbenchEdit' | 'handlers'> | undefined,
  /**
   * 外壳运行实例（**嵌入 profile 的装配结果**；M7-4 段 A / D1）。
   *
   * 必填：旧实现允许省略并落到 `EMPTY_SHELL`（能力空集），于是
   * `EMBED_PROFILE` 的裁剪声明在生产里**零消费者** —— 那正是 A14/A15
   * "只活在测试里"的根因。省略它在**类型层**就不可表达（没有第二条失败关闭旁路：
   * 装配失败由 `createEmbedShellRuntime` 显式抛出）。
   */
  shell: ShellRuntime,
): { host: EmbedHost; ctx: Context; shell: ShellRuntime } {
  const registry = createOperatorRegistry()
  const viewports = createViewportManager()
  // 主题是**实例**设置（P10 #261 F1）：宿主指定的主题经这里进本实例，
  // 落在实例根元素的 `data-lk-theme` 上 —— 不再写 `document.documentElement`
  // （那会让同页两实例互相覆盖）。
  const wm = new WM(logCenter, {
    surface: 'embed',
    ...(settings.theme === undefined ? {} : { initialTheme: settings.theme }),
  })

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

  const runtime = shell
  // 内核会话（#261 / R-WK-03）：嵌入外壳同样由宿主创建 Editor，
  // 能力来自**嵌入 profile** 的装配结果（无内容编辑能力 ⇒ 运行时拒绝，A15）。
  //
  // P11-F 段①（#262 A21）：贡献类型声明同样来自本外壳的装配结果 —— 查看器也要**认识**
  // 文档里已有的贡献类型（"知道有哪些对象类型"与"能不能编辑"是两件事，见 profiles.ts 的
  // `M_TEXT_OBJECT_TYPE` 说明）；能不能**写**仍由能力集合决定（A15 不受影响）。
  const kernel = createKernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: capabilitiesOf(runtime.assembly),
    contributedObjectTypes: objectTypeDeclarationsOf(runtime.assembly),
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

