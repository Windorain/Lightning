import type { Ref } from 'vue'
import type { InjectionKey } from 'vue'
import { inject, provide } from 'vue'
import type { SelectionContext } from '@/context/selection'
import type { UndoManager } from '@/context/editHistory'
import type { ToolRegistry } from '@/workbench/tools/registry'
import type { Rect, RNARegistry } from '@/shared/types'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import type { bScreen } from '@/workbench/ux/types/screen'
import type { Main } from '@/runtime/main'
import type { WM } from '@/runtime/wm'
import type { EmbedState, WorkbenchState } from '@/runtime/state'
import type { ViewportManager } from '@/runtime/viewportManager'
import type {
  ConnectionState,
  UIWorkspace,
  ViewportSlot,
  WorkbenchWorkspaceMode,
} from '@/runtime/types'
import type {
  EmbedSession,
  ShellSettings,
  ToolSettings,
  WorkbenchSession,
} from '@/runtime/contextAccess'
import type { createLogCenter } from '@/logging/LogCenter'

function embedUnavailable(name: string): never {
  throw new Error(`embed: ${name} not available`)
}

function workbenchUnavailable(name: string): never {
  throw new Error(`workbench: ${name} not available`)
}

export class Context {
  constructor(
    readonly main: Main,
    readonly wm: WM,
    readonly log: ReturnType<typeof createLogCenter>,
    readonly viewports: ViewportManager,
    readonly workbench: WorkbenchState | null,
    readonly embed: EmbedState | null,
  ) {}

  isEmbed(): boolean {
    return this.workbench === null
  }

  // --- Main ---
  getDoc(): Ref<RuntimeDocument | null> {
    return this.main.doc
  }
  getStructEpoch(): Ref<number> {
    return this.main.structEpoch
  }
  getCurrentFrameIndex(): Ref<number> {
    return this.main.currentFrameIndex
  }

  getOperators(): Main['registries']['operatorsFacade'] {
    return this.main.registries.operatorsFacade
  }

  // --- Setting 簇（Context 渠道）---
  getShellSettings(): ShellSettings {
    return this.wm.settings
  }

  getToolSettings(): ToolSettings {
    return this.workbench?.tool ?? this.embed!.tool
  }

  getSession(): WorkbenchSession | EmbedSession {
    return this.workbench?.session ?? this.embed!.session
  }

  getWikiConfig(): Record<string, unknown> {
    return this.workbench?.wiki ?? this.embed!.wiki
  }

  // --- Workbench session 便捷投影 ---
  getWorkspaceMode(): Ref<WorkbenchWorkspaceMode> {
    return this.workbench?.session.workspaceMode ?? workbenchUnavailable('workspaceMode')
  }
  getUiWorkspace(): Ref<UIWorkspace> {
    return this.workbench?.session.uiWorkspace ?? workbenchUnavailable('uiWorkspace')
  }
  getLocalFileName(): Ref<string | null> {
    return this.workbench?.session.localFileName ?? workbenchUnavailable('localFileName')
  }
  getConnection(): ConnectionState {
    return this.workbench?.session.connection ?? workbenchUnavailable('connection')
  }
  getLayerWorldY(): Ref<number> {
    return this.getSession().layerWorldY
  }
  getHoveredBlock(): Ref<import('@/context/selection').BlockRef | null> {
    return this.workbench?.session.hoveredBlock ?? workbenchUnavailable('hoveredBlock')
  }

  // --- Workbench 服务 ---
  getSelection(): SelectionContext {
    return this.workbench?.selection ?? embedUnavailable('selection')
  }
  getEditHistory(): UndoManager {
    return this.workbench?.editHistory ?? embedUnavailable('editHistory')
  }
  getToolRegistry(): ToolRegistry {
    return this.workbench?.toolRegistry ?? embedUnavailable('toolRegistry')
  }
  getScreen(): bScreen | null {
    return this.workbench?.screen ?? null
  }
  getRna(): RNARegistry {
    return this.workbench?.rna ?? embedUnavailable('rna')
  }
  getUi(): { boundsOfByOperator(opId: string): Rect[]; boundsOfByRNAPath(rnaPath: string): Rect[] } {
    return this.workbench?.ui ?? embedUnavailable('ui')
  }

  getViewport(): ViewportSlot {
    return this.viewports.active.value!
  }

  viewportBinding(regionId: string): ViewportSlot | undefined {
    return this.viewports.get(regionId)
  }
}

export function resolveViewportSlot(
  ctx: Context,
  props: Record<string, unknown> | undefined,
): ViewportSlot {
  const rid = props?._regionId as string | undefined
  if (rid) {
    const slot = ctx.viewports.get(rid)
    if (slot) return slot
  }
  return ctx.getViewport()
}

export const contextKey: InjectionKey<Context> = Symbol('context')

export function provideContext(ctx: Context): void {
  provide(contextKey, ctx)
}

export function useContext(): Context {
  const ctx = inject(contextKey)
  if (!ctx) throw new Error('useContext() 须在 Host Root 子树内调用')
  return ctx
}
