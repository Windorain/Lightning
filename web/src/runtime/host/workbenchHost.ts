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
import { CAPABILITY } from '@/composition/modules'
import { objectTypeDeclarationsOf } from '@/composition/contributedObjectTypes'
import type { ShellRuntime } from '@/composition/shell'
import { createKernelSession, KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID } from '@/runtime/kernelSession'
import { useAreaHost } from '@/editors/useAreaHost'
import { editorTypeRegistry } from '@/editors/builtinEditors'
import { createInitialLayout, createWorkspace } from '@/domain/workspace'
import { parseWorkbenchQuery } from '@/workbench/utils/fileNaming'
import {
  WORKBENCH_PANELS,
  registerWorkbenchOperators,
  validateWorkbenchRna,
  registerWorkbenchTools,
} from '@/workbench/registerWorkbench'

export interface WorkbenchHostDeps {
  selection: SelectionContext
  editHistory: UndoManager
  toolRegistry: ToolRegistry
  tool: ToolSettings
  /**
   * 外壳运行实例（装配结果 + 宿主端口）。
   *
   * B5 #7：旧接口是 `profile?: HostProfile`，实现里 `setHostProfile(deps.profile)`
   * 写一个**模块级全局**，之后 19 处消费点反查它。
   * 现在传的是**装配结果本身** —— 能力从它派生、宿主端口从它取，
   * 没有任何模块级可变状态。
   */
  shell: ShellRuntime
}

export interface WorkbenchHostResult {
  host: WorkbenchHost
  ctx: Context
  screen: ScreenRoot
  services: WorkbenchServices
  shell: ShellRuntime
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
    // B5 #7：旧实现是 `if (isWikiHostProfile()) { await bootWikiWorkbench(...); return }`。
    // 现在按**能力**分流 —— "这个外壳有没有 Wiki 上传面"决定启动哪套引导。
    if (this.ctx.hasCapability(CAPABILITY.WIKI_UPLOAD)) {
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
  const { selection, editHistory, toolRegistry, tool, shell } = deps
  const registry = createOperatorRegistry()
  const viewports = createViewportManager()
  const wm = new WM(logCenter)

  const screen = createWorkbenchScreenRoot(tool, WORKBENCH_PANELS)

  const main = new Main({
    operators: registry,
    tools: toolRegistry,
  })

  const parsers = main.registries.parsers
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)

  void validateWorkbenchRna()

  const services: WorkbenchServices = {
    selection,
    editHistory,
    toolRegistry,
    ui: {
      boundsOfByOperator: (opId: string) => boundsOfByOperator(opId),
      boundsOfByRNAPath: (rnaPath: string) => boundsOfByRNAPath(rnaPath),
    },
  }

  // 能力与宿主端口**显式**从装配结果传入 Context（旧实现经模块级全局反查）
  // 内核会话（#261 / R-WK-03）：宿主创建 Editor，能力来自同一装配结果。
  //
  // P11-F 段①（#262 A21 属性写半边）：装配贡献的对象类型（`contributes.objectTypes`
  // 里带 `rna` 的那些，例：`objects.text` 的 `text`）经**同一条装配结果**派生后交给会话
  // —— 于是"贡献类型能不能写属性"不再是"够不够得着某个模块级单例"的函数，
  // 而是装配结果的一部分（派生函数是纯函数，见 `composition/contributedObjectTypes`）。
  const kernel = createKernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: shell.assembly.capabilities,
    contributedObjectTypes: objectTypeDeclarationsOf(shell.assembly),
  })
  const ctx = new Context(
    main,
    wm,
    logCenter,
    viewports,
    screen,
    services,
    shell.assembly.capabilities,
    shell.pageKeyboard,
    kernel,
  )
  main.bindOperatorFacade(() => ctx)

  const host = new WorkbenchHost(main, ctx, wm, screen, services)
  computeLayout(ctx, screen)

  // ── Area 会话（#282 P10b）────────────────────────────────────────────────
  //
  // 在**宿主**里创建（不是渲染它的组件里）：#249 要求「Area 与编辑器实例的寿命
  // 不依赖组件挂载」。`WorkbenchRoot` 切工作区时用 `:key` 卸载重建子树，
  // 若布局归组件的 `ref`，切走再切回会丢掉分割出的 Area 与两个视口的机位 ——
  // 而"切回恢复"正是 §13/A13 的判据。
  //
  // 初始布局是**一个** 3D Area（`viewport3d`）：region 仍是 `r-viewport`，
  // 故单视口装配的行为与既有 e2e/`__vm__` 观测面**逐字一致**（零回归）。
  // 分割由 `splitArea` 等命令驱动（见 `operators/builtin/areaOperators`）。
  //
  // 只有**可调整布局**的外壳才建它：嵌入外壳在装配层就没有 `layout.edit`
  // （#257），给它一个 Area 会话会让"固定布局"变成只在 UI 上藏了按钮。
  if (shell.adjustableLayout) {
    ctx.setAreaSession(
      useAreaHost({
        initial: createWorkspace({
          id: 'workbench-ws',
          editContextId: KERNEL_CONTEXT_ID,
          layout: createInitialLayout({ id: 'a1', editorType: 'viewport3d' }),
        }),
        registry: editorTypeRegistry,
        instancePrefix: 'wb',
      }),
    )
  }

  for (const inputId of screen.wmInputRegionIds()) {
    wm.events.registerRegion(inputId)
  }
  wm.events.registerRegion(REGION.CHROME)

  registerWorkbenchOperators(registry)
  registerWorkbenchTools(toolRegistry, viewports, tool)

  installUnifiedLogApi(ctx)
  selection.bindLog(ctx.log)
  editHistory.bindLog(ctx.log)

  return { host, ctx, screen, services, shell }
}
