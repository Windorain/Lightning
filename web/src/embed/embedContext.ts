/**
 * Embed BContext 工厂 — 创建轻量 BContext 供嵌入场景使用。
 *
 * 与 workbench 同构：EmbedRoot 创建 bctx → provide → EmbedViewport 消费。
 * 只包含 embed 实际需要的字段，workbench-only 子系统抛出明确错误。
 */
import type { BContext, BContextQueries, WorkbenchWorkspaceMode, UIWorkspace } from '@/workbench/context/bContext'
import { createViewportManager } from '@/workbench/context/bContext'
import type { RuntimeDocument } from '@/workbench/context/runtimeDocument'
import type { EmbedSettings } from '@/preview/previewConfig'
import type { OperatorType } from '@/workbench/operators/operatorType'
import { globalOperators } from '@/workbench/operators/operatorRegistry'
import { EventDispatcherImpl } from '@/workbench/eventDispatcher'
import { ref } from 'vue'
import type { Ref } from 'vue'
import type { SelectionContext } from '@/workbench/selectionContext'
import type { UndoManager } from '@/workbench/editHistoryContext'
import type { ToolRegistry } from '@/workbench/toolRegistry'
import type { ExportFileInfo } from '@/workbench/sdeApi'
import type { Rect } from '@/workbench/ux/types/screen'
import type { RNARegistry } from '@/workbench/ux/rna/types'

// Operators
import { ViewRotateOperator, ViewPanOperator, ViewZoomOperator } from '@/workbench/operators/builtin/viewOperators'
import { ResetViewOperator } from '@/embed/operators/resetViewOperator'

function throwError(name: string): never {
  throw new Error(`embed: ${name} not available`)
}

export function createEmbedContext(settings: EmbedSettings): BContext {
  const viewports = createViewportManager()
  viewports.register('r-embed')

  const docRef: Ref<RuntimeDocument | null> = ref(null)
  const dirtyRef = ref(false)
  const structEpochRef = ref(0)
  const currentWorldFrameIndexRef = ref(0)
  const workspaceModeRef: Ref<WorkbenchWorkspaceMode> = ref('local-file')
  const uiWorkspaceRef: Ref<UIWorkspace> = ref('wiki')
  const localFileNameRef = ref<string | null>(null)
  const connectionApiBaseRef = ref('')
  const connectionTokenRef = ref('')
  const connectionConnectedRef = ref<boolean | null>(null)
  const connectionExportsRef = ref<ExportFileInfo[]>([])
  const connectionExportsLoadingRef = ref(false)
  const connectionSelectedExportNameRef = ref<string | null>(null)

  const operators = {
    exec: (id: string, props?: Record<string, unknown>) => globalOperators.exec(ctx, id, props),
    invoke: (id: string, props?: Record<string, unknown>, event?: Event, regionId?: string) =>
      globalOperators.invoke(ctx, id, props, event as PointerEvent | KeyboardEvent, regionId),
    find: (id: string) => { const o = globalOperators.find(id); return o ? { id: o.id, label: o.label } : undefined },
    all: () => globalOperators.all().map(o => ({ id: o.id, label: o.label })),
    register: (op: OperatorType) => globalOperators.register(op),
  }

  // Minimal bctx — embed 实际使用的字段
  const ctx: BContext = {
    doc: docRef,
    dirty: dirtyRef,
    structEpoch: structEpochRef,
    currentWorldFrameIndex: currentWorldFrameIndexRef,
    workspaceMode: workspaceModeRef,
    uiWorkspace: uiWorkspaceRef,
    localFileName: localFileNameRef,
    markDirty() { dirtyRef.value = true },
    markStructureDirty() { structEpochRef.value += 1; dirtyRef.value = true },
    markClean() { dirtyRef.value = false },

    connectionApiBase: connectionApiBaseRef,
    connectionToken: connectionTokenRef,
    connectionConnected: connectionConnectedRef,
    connectionExports: connectionExportsRef,
    connectionExportsLoading: connectionExportsLoadingRef,
    connectionSelectedExportName: connectionSelectedExportNameRef,

    get selection(): SelectionContext { return throwError('selection') },
    get editHistory(): UndoManager { return throwError('editHistory') },
    get toolRegistry(): ToolRegistry { return throwError('toolRegistry') },
    queries: null as any,

    settings: {
      replaceBrush: null, fillBrush: null, generateType: null,
      dragSensitivity: 0.05, snapEnabled: true,
    },

    operators,
    eventDispatcher: new EventDispatcherImpl(),

    get log() { return throwError('log') },
    wikiConfig: {},
    statusMessage: { value: '' },

    viewports,
    get viewport() { return viewports.active.value! },

    get wm(): any { return {} },
    get screen() { return null },
    get rna(): RNARegistry { return throwError('rna') },
    get ui(): { boundsOfByOperator(opId: string): Rect[]; boundsOfByRNAPath(rnaPath: string): Rect[] } { return throwError('ui') },
  }

  // Embed-specific extras (accessed via bctx internals)
  ;(ctx as any).initialCamera = settings.initialCamera

  // Register embed operators
  for (const op of [ViewRotateOperator, ViewPanOperator, ViewZoomOperator, ResetViewOperator]) {
    if (!ctx.operators.find(op.id)) ctx.operators.register(op)
  }

  return ctx
}

export { provideBContext as provideEmbedBContext } from '@/workbench/context/bContext'
