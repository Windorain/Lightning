/**
 * Embed BContext 工厂 — 创建轻量 BContext 供嵌入场景使用。
 *
 * 与 workbench 同构：EmbedRoot 创建 bctx → provide → EmbedViewport 消费。
 * 只包含 embed 实际需要的字段，workbench-only 子系统抛出明确错误。
 */
import { createViewportManager } from '@/context/bContext'
import type { BContext, UIWorkspace, WorkbenchWorkspaceMode, ConnectionState } from '@/context/bContext'
import type { EmbedSettings } from '@/preview/previewConfig'
import { createOperatorRegistry, wrapOperatorRegistry } from '@/operators/operatorRegistry'
import { ref, reactive, type Ref } from 'vue'
import type { SelectionContext } from '@/context/selection'
import type { UndoManager } from '@/context/editHistory'
import type { Rect, RNARegistry } from '@/shared/types'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import { EventDispatcherImpl } from '@/events/dispatcher'

// Operators
import { ViewRotateOperator, ViewPanOperator, ViewZoomOperator } from '@/operators/builtin/viewOperators'
import { CopyCameraFromEmbedOperator } from '@/operators/builtin/copyCameraFromEmbed'

function throwError(name: string): never {
  throw new Error(`embed: ${name} not available`)
}

export function createEmbedContext(settings: EmbedSettings): BContext {
  const registry = createOperatorRegistry()
  const embedOperators = wrapOperatorRegistry(registry, () => ctx, true)

  const viewports = createViewportManager()
  const eventDispatcher = new EventDispatcherImpl()
  viewports.register('r-embed')

  // dirty: embed is read-only (no editHistory, no NEW_SCENE/OPEN_SCENE operators),
  // so dirty is always false. Core initializes it as ref(false) and we keep it.
  // If editing capability is added later, override with:
  //   dirty: computed(() => editHistory.canUndo.value)  — matching workbench
  const ctx: BContext = {
    doc: ref(null) as Ref<RuntimeDocument | null>,
    structEpoch: ref(0),
    currentWorldFrameIndex: ref(0),
    workspaceMode: ref<WorkbenchWorkspaceMode>('local-file'),
    uiWorkspace: ref<UIWorkspace>('wiki'),
    localFileName: ref<string | null>(null),
    connection: reactive<ConnectionState>({
      apiBase: '',
      token: '',
      connected: null,
      exports: [],
      exportsLoading: false,
      selectedExportName: null,
    }),
    viewports,
    eventDispatcher,
    operators: embedOperators,
    wikiConfig: {},

    get selection(): SelectionContext { return throwError('selection') },
    get editHistory(): UndoManager { return throwError('editHistory') },
    get toolRegistry() { return throwError('toolRegistry') },

    settings: {
      replaceBrush: null, fillBrush: null, generateType: null,
      dragSensitivity: 0.05, snapEnabled: true,
    },

    get log() { return throwError('log') },

    get viewport() { return viewports.active.value! },

    get wm(): any { return {} },
    get screen() { return null },
    get rna(): RNARegistry { return throwError('rna') },
    get ui(): { boundsOfByOperator(opId: string): Rect[]; boundsOfByRNAPath(rnaPath: string): Rect[] } { return throwError('ui') },
  }

  // Embed-specific extras (accessed via bctx internals)
  ;(ctx as any).initialCamera = settings.initialCamera

  // Register embed operators
  for (const op of [ViewRotateOperator, ViewPanOperator, ViewZoomOperator, CopyCameraFromEmbedOperator]) {
    if (!registry.find(op.id)) registry.register(op)
  }

  return ctx
}

export { provideBContext as provideEmbedBContext } from '@/context/bContext'
