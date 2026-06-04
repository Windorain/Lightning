import type { ComputedRef, Ref } from 'vue'
import type { BlockRef } from '@/context/selection'
import {
  createWorkbenchHoverAnnotationIdRef,
  createWorkbenchHoverBlockRef,
} from '@/runtime/hover/access'
import type { InjectionKey } from 'vue'
import { inject, provide } from 'vue'
import type { SelectionContext } from '@/context/selection'
import type { UndoManager } from '@/context/editHistory'
import type { ToolRegistry } from '@/workbench/tools/registry'
import type { Rect, RNARegistry } from '@/shared/types'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import type { Main } from '@/runtime/main'
import type { WM } from '@/runtime/wm'
import type { WorkbenchServices } from '@/runtime/state'
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
import type { ScreenRoot, RegionNode } from '@/runtime/screenRoot'
import { REGION } from '@/runtime/regionIds'

function embedUnavailable(name: string): never {
  throw new Error(`embed: ${name} not available`)
}

function workbenchUnavailable(name: string): never {
  throw new Error(`workbench: ${name} not available`)
}

export class Context {
  private workbenchHoverBlock: ComputedRef<BlockRef | null> | null = null
  private workbenchHoverAnnotation: ComputedRef<string | null> | null = null

  constructor(
    readonly main: Main,
    readonly wm: WM,
    readonly log: ReturnType<typeof createLogCenter>,
    readonly viewports: ViewportManager,
    readonly screen: ScreenRoot | null,
    readonly workbench: WorkbenchServices | null,
  ) {}

  isEmbed(): boolean {
    return this.workbench === null
  }

  // --- WM 输入域（活跃区域通道）---
  getActiveInputRegion(): string | null {
    return this.wm.events.getActiveRegion()
  }

  getCurrentInputRegion(): string | null {
    return this.wm.events.getCurrentRegionId()
  }

  resolveInputRegionId(props?: Record<string, unknown>): string | null {
    const fromProps = props?._regionId as string | undefined
    if (fromProps) return fromProps
    return this.getCurrentInputRegion() ?? this.getActiveInputRegion()
  }

  // --- Screen 树（UI 状态渠道）---
  getScreenRoot(): ScreenRoot | null {
    return this.screen
  }

  region(regionId: string): RegionNode | undefined {
    return this.screen?.region(regionId)
  }

  requireRegion(regionId: string): RegionNode {
    const r = this.region(regionId)
    if (!r) throw new Error(`region not found: ${regionId}`)
    return r
  }

  regionByInputId(wmInputId: string): RegionNode | undefined {
    return this.screen?.regionByInputId(wmInputId)
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

  /** 按 region 取 Main 逻辑相机 */
  getViewportCamera(regionId?: string): Ref<import('@/runtime/viewportCamera').ViewportCameraState | null> {
    const rid = regionId ?? this.resolveInputRegionId() ?? this.viewports.activeId.value
    const slot = rid ? this.viewports.get(rid) : this.viewports.active.value
    if (!slot) throw new Error('getViewportCamera: no viewport slot')
    return this.main.cameras[slot.cameraMainKey]
  }

  getOperators(): Main['registries']['operatorsFacade'] {
    return this.main.registries.operatorsFacade
  }

  getShellSettings(): ShellSettings {
    return this.wm.settings
  }

  getSession(): WorkbenchSession | EmbedSession {
    if (!this.screen) throw new Error('screen not available')
    return this.screen.session
  }

  getToolSettings(): ToolSettings {
    const rid = this.isEmbed() ? REGION.EMBED : REGION.WORKBENCH_TOOLSHELF
    const tool = this.requireRegion(rid).state.tool
    if (!tool) throw new Error(`tool settings missing on region ${rid}`)
    return tool as ToolSettings
  }

  getWorkspaceMode(): Ref<WorkbenchWorkspaceMode> {
    if (this.isEmbed()) workbenchUnavailable('workspaceMode')
    return (this.getSession() as WorkbenchSession).workspaceMode
  }
  getUiWorkspace(): Ref<UIWorkspace> {
    if (this.isEmbed()) workbenchUnavailable('uiWorkspace')
    return (this.getSession() as WorkbenchSession).uiWorkspace
  }
  getLocalFileName(): Ref<string | null> {
    if (this.isEmbed()) workbenchUnavailable('localFileName')
    return (this.getSession() as WorkbenchSession).localFileName
  }

  getDocumentBinding() {
    if (this.isEmbed()) workbenchUnavailable('documentBinding')
    return (this.getSession() as WorkbenchSession).documentBinding
  }
  getConnection(): ConnectionState {
    if (this.isEmbed()) workbenchUnavailable('connection')
    return (this.getSession() as WorkbenchSession).connection
  }
  getLayerWorldY(): Ref<number> {
    return this.getSession().layerWorldY
  }
  getHoveredBlock(): Ref<BlockRef | null> {
    if (this.isEmbed()) workbenchUnavailable('hoveredBlock')
    this.workbenchHoverBlock ??= createWorkbenchHoverBlockRef(this)
    return this.workbenchHoverBlock
  }
  getHoveredAnnotationId(): Ref<string | null> {
    if (this.isEmbed()) workbenchUnavailable('hoveredAnnotationId')
    this.workbenchHoverAnnotation ??= createWorkbenchHoverAnnotationIdRef(this)
    return this.workbenchHoverAnnotation
  }

  getSelection(): SelectionContext {
    return this.workbench?.selection ?? embedUnavailable('selection')
  }
  getEditHistory(): UndoManager {
    return this.workbench?.editHistory ?? embedUnavailable('editHistory')
  }
  getToolRegistry(): ToolRegistry {
    return this.workbench?.toolRegistry ?? embedUnavailable('toolRegistry')
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
  const rid = ctx.resolveInputRegionId(props) ?? undefined
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
