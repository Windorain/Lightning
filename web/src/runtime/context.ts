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
  ContextSettings,
  RenderViewState,
  UIWorkspace,
  ViewportSlot,
  WorkbenchWorkspaceMode,
} from '@/runtime/types'
import type { createLogCenter } from '@/logging/LogCenter'

function embedUnavailable(name: string): never {
  throw new Error(`embed: ${name} not available`)
}

export class Context {
  readonly renderView: Record<string, RenderViewState> = {}

  constructor(
    readonly main: Main,
    readonly wm: WM,
    readonly log: ReturnType<typeof createLogCenter>,
    readonly viewports: ViewportManager,
    readonly workbench: WorkbenchState | null,
    readonly embed: EmbedState | null,
  ) {}

  get isEmbed(): boolean {
    return this.workbench === null
  }

  // --- Main projections ---
  get doc(): Ref<RuntimeDocument | null> { return this.main.doc }
  get structEpoch(): Ref<number> { return this.main.structEpoch }
  get currentFrameIndex(): Ref<number> { return this.main.currentFrameIndex }
  /** @deprecated use currentFrameIndex */
  get currentWorldFrameIndex(): Ref<number> { return this.main.currentFrameIndex }

  get operators() { return this.main.registries.operatorsFacade }

  get eventDispatcher() { return this.wm.events }

  // --- Workbench state ---
  get selection(): SelectionContext {
    return this.workbench?.selection ?? embedUnavailable('selection')
  }
  get editHistory(): UndoManager {
    return this.workbench?.editHistory ?? embedUnavailable('editHistory')
  }
  get toolRegistry(): ToolRegistry {
    return this.workbench?.toolRegistry ?? embedUnavailable('toolRegistry')
  }
  get settings(): ContextSettings {
    return this.workbench?.settings ?? this.embed!.settings
  }
  get workspaceMode(): Ref<WorkbenchWorkspaceMode> {
    return this.workbench?.workspaceMode ?? embedUnavailable('workspaceMode')
  }
  get uiWorkspace(): Ref<UIWorkspace> {
    return this.workbench?.uiWorkspace ?? embedUnavailable('uiWorkspace')
  }
  get localFileName(): Ref<string | null> {
    return this.workbench?.localFileName ?? embedUnavailable('localFileName')
  }
  get connection(): ConnectionState {
    return this.workbench?.connection ?? embedUnavailable('connection')
  }
  get wikiConfig(): Record<string, unknown> {
    return this.workbench?.wikiConfig ?? this.embed!.wikiConfig
  }
  get layerWorldY(): Ref<number> {
    return this.workbench?.layerWorldY ?? embedUnavailable('layerWorldY')
  }
  get hoveredBlock(): Ref<import('@/context/selection').BlockRef | null> {
    return this.workbench?.hoveredBlock ?? embedUnavailable('hoveredBlock')
  }
  get screen(): bScreen | null {
    return this.workbench?.screen ?? null
  }
  get rna(): RNARegistry {
    return this.workbench?.rna ?? embedUnavailable('rna')
  }
  get ui(): { boundsOfByOperator(opId: string): Rect[]; boundsOfByRNAPath(rnaPath: string): Rect[] } {
    return this.workbench?.ui ?? embedUnavailable('ui')
  }

  get viewport(): ViewportSlot {
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
  return ctx.viewport
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

