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
import { createLogCenter, installUnifiedLogApi, type UnifiedLogDisposer } from '@/logging/LogCenter'
import { capabilitiesOf } from '@/composition/resolver'
import { objectTypeDeclarationsOf } from '@/composition/contributedObjectTypes'
import type { ShellRuntime } from '@/composition/shell'
import { createKernelSession, KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID } from '@/runtime/kernelSession'
import { createDiagnosticProjection } from '@/runtime/diagnosticProjection'
import { reportModuleAssembly } from '@/runtime/commandDiagnostics'

export class EmbedHost extends HostBase {
  constructor(
    readonly main: Main,
    readonly ctx: Context,
    readonly wm: WM,
    /**
     * **本实例的日志中心**（切分线①：日志实例由宿主创建并挂 `Context.log`）。
     *
     * 旧实现是模块级单例（`export const logCenter`）：同页两个嵌入共用一份
     * `entries`/`liveStatus`，于是 A 的"纹理加载中 3/57"出现在 B 的状态栏读面上
     * —— 那是"最后写者胜"。现在每个宿主各建一份。
     */
    readonly log: ReturnType<typeof createLogCenter>,
    /** 注销本实例的 `window.__log__` 登记（由 `createEmbedHost` 安装）。 */
    private readonly disposeLogApi: UnifiedLogDisposer,
  ) {
    super()
  }

  /**
   * 显式销毁（与 `WorkbenchHost.destroy` 同一形状；`mount().unmount()` 经
   * `EmbedRoot#onBeforeUnmount` 走到这里）。
   */
  override destroy(): void {
    super.destroy()
    this.disposeLogApi()
  }

  async start(): Promise<void> {
    // Document load: OPERATOR_LOAD_EMBED_DOCUMENT from EmbedRoot
  }
}

export function createEmbedHost(
  settings: EmbedSettings,
  bootstrap: Pick<EmbedBootstrapOptions, 'structureBase' | 'workbenchEdit' | 'handlers'> | undefined,
  /**
   * 外壳运行实例（**嵌入 profile 的装配结果**）。
   *
   * 必填：旧实现允许省略并落到 `EMPTY_SHELL`（能力空集），于是
   * 必填：旧实现允许省略并落到 `EMPTY_SHELL`（能力空集），于是
   * `EMBED_PROFILE` 的裁剪声明在生产里**零消费者** —— 那正是"只活在测试里"的根因。省略它在**类型层**就不可表达（没有第二条失败关闭旁路：
   * 装配失败由 `createEmbedShellRuntime` 显式抛出）。
   */
  shell: ShellRuntime,
  /**
   * **本嵌入实例身份**（由装配层 `embed/mount` 每实例分配一个）。
   *
   * 必填：它是"同页多实例"的唯一键 —— 实例设置、日志观测面、viewer 偏好/
   * 面板/键位全部按它命名。缺省成固定串就等于把"按外壳类型命名"留在原地。
   */
  instanceId: string,
): { host: EmbedHost; ctx: Context; shell: ShellRuntime } {
  const registry = createOperatorRegistry()
  const log = createLogCenter()
  const viewports = createViewportManager()
  // 主题是**实例**设置：宿主指定的主题经这里进本实例，
  // 落在实例根元素的 `data-lk-theme` 上 —— 不再写 `document.documentElement`
  // （那会让同页两实例互相覆盖）。
  const wm = new WM(log, {
    surface: 'embed',
    instanceId,
    ...(settings.theme === undefined ? {} : { initialTheme: settings.theme }),
  })
  // 诊断通道收口：C1 是唯一结构化诊断面，C2/C3 是它的投影。嵌入侧同样投影 —— 嵌入没有底栏
  // 诊断列表，但 `__log__` 与诊断记录的可读性不该因宿主而分叉。
  wm.observeDiagnostics(createDiagnosticProjection(log))
  // 装配结果（结构化诊断第七项）：嵌入外壳同样报一次（能力集是嵌入侧唯一可见的装配事实）。
  reportModuleAssembly(wm.diagnostics, shell.assembly)

  const screen = createEmbedScreenRoot(createToolSettings(), {
    initialLayerWorldY: settings.initialLayerWorldY,
    instanceId,
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
  // 内核会话：嵌入外壳同样由宿主创建 Editor，
  // 能力来自**嵌入 profile** 的装配结果（无内容编辑能力 ⇒ 运行时拒绝）。
  //
  // 装配贡献的类型声明同样来自本外壳的装配结果 —— 查看器也要**认识**
  // 文档里已有的贡献类型（"知道有哪些对象类型"与"能不能编辑"是两件事，见 profiles.ts 的
  // `M_TEXT_OBJECT_TYPE` 说明）；能不能**写**仍由能力集合决定（不受影响）。
  const kernel = createKernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: capabilitiesOf(runtime.assembly),
    contributedObjectTypes: objectTypeDeclarationsOf(runtime.assembly),
  })
  const ctx = new Context(
    main,
    wm,
    log,
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
  // 「运行时绕 UI 发编辑命令被拒绝」在这里有第二道落点：
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

  // `window.__log__` 的**按实例登记**（切分线②）：同页两实例各有自己的登记项，
  // 读面必须指明实例；缺省读面取第一个在册实例（不再是"最后安装者"）。
  const disposeLogApi = installUnifiedLogApi(ctx)

  return { host: new EmbedHost(main, ctx, wm, log, disposeLogApi), ctx, shell: runtime }
}