/**
 * Embed BContext 工厂 — 创建轻量 BContext 供嵌入场景使用。
 *
 * 与 workbench 同构：EmbedRoot 创建 bctx → provide → EmbedViewport 消费。
 * 只包含 embed 实际需要的字段，workbench-only 子系统抛出明确错误。
 */
import type { BContext, UIWorkspace } from '@/context/bContext'
import type { EmbedSettings } from '@/preview/previewConfig'
import { createOperatorRegistry, wrapOperatorRegistry } from '@/operators/operatorRegistry'
import { ref } from 'vue'
import type { SelectionContext } from '@/context/selection'
import type { UndoManager } from '@/context/editHistory'
import type { Rect, RNARegistry } from '@/shared/types'
import { createCoreBContext } from '@/context/coreContext'

// Operators
import { ViewRotateOperator, ViewPanOperator, ViewZoomOperator } from '@/operators/builtin/viewOperators'
import { CopyCameraFromEmbedOperator } from '@/operators/builtin/copyCameraFromEmbed'

function throwError(name: string): never {
  throw new Error(`embed: ${name} not available`)
}

export function createEmbedContext(settings: EmbedSettings): BContext {
  const registry = createOperatorRegistry()
  const embedOperators = wrapOperatorRegistry(registry, () => ctx, true)

  const core = createCoreBContext(embedOperators)
  core.viewports.register('r-embed')

  // dirty: embed is read-only (no editHistory, no NEW_SCENE/OPEN_SCENE operators),
  // so dirty is always false. Core initializes it as ref(false) and we keep it.
  // If editing capability is added later, override with:
  //   dirty: computed(() => editHistory.canUndo.value)  — matching workbench
  const ctx: BContext = {
    ...core,
    uiWorkspace: ref<UIWorkspace>('wiki'),

    get selection(): SelectionContext { return throwError('selection') },
    get editHistory(): UndoManager { return throwError('editHistory') },
    get toolRegistry() { return throwError('toolRegistry') },
    queries: null,

    settings: {
      replaceBrush: null, fillBrush: null, generateType: null,
      dragSensitivity: 0.05, snapEnabled: true,
    },

    get log() { return throwError('log') },

    get viewport() { return core.viewports.active.value! },

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
