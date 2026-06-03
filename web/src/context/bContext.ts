/**
 * bContext — 对标 Blender 的 bContext。
 *
 * 聚合所有 Vue provide/inject 上下文为单一对象，
 * 操作符通过 bContext 隐式获取 scene/selection/editHistory/toolRegistry/connection。
 */
import type { InjectionKey } from 'vue'
import { inject, provide } from 'vue'
import type { SelectionContext } from '@/context/selection'
import type { UndoManager } from '@/context/editHistory'
import type { ToolRegistry } from '@/workbench/tools/registry'
import type { Rect, RNARegistry } from '@/shared/types'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import type { ExportFileInfo } from '@/workbench/sdeApi'
import type { StructureDefinition } from '@/render/schema/types'
import type { LayerPreviewMode } from '@/render/data/layerPreview'
import { computed, ref, shallowRef } from 'vue'
import type { Ref, ShallowRef } from 'vue'
import type * as THREE from 'three'

import type { bScreen } from '@/workbench/ux/types/screen'
import type { MoveGizmo } from '@/workbench/tools/gizmos'

export type LoadStatus = 'loading' | 'ok' | 'error'
export type WorkbenchWorkspaceMode = 'sde' | 'local-file' | 'local-bundle'
export type UIWorkspace = 'preview' | 'wiki' | 'export' | 'materials'

export interface MaterialQueryItem {
  materialId: string
  kind: 'static16' | 'animated'
  blend?: 'opaque' | 'cutout' | 'translucent'
  locator?: string
  emissive?: number
  animation?: {
    defaultFrametimeTicks?: number
    frameSequence?: Array<{ index: number; timeTicks?: number }>
    interpolate?: boolean
  }
  textureDataUrl: string | null
  atlas?: string | null
  linear?: boolean
  useMipmaps?: boolean
}

export interface BlockTypeStat {
  count: number
}

export interface ConnectionState {
  apiBase: string
  token: string
  connected: boolean | null
  exports: ExportFileInfo[]
  exportsLoading: boolean
  selectedExportName: string | null
}

export interface BContextSettings {
  replaceBrush: string | null
  fillBrush: string | null
  generateType: string | null
  /** Gizmo 拖拽灵敏度（原硬编码 const k = 0.05） */
  dragSensitivity: number
  /** Snap 吸附开关 */
  snapEnabled: boolean
  /** Hook for dirty-check confirmation; used by NewScene/OpenScene operators */
  confirmDirty?: (message: string) => boolean
  /** Current theme ('dark' | 'light') — observable for testing */
  theme?: 'dark' | 'light'
  /** Current language ('zh' | 'en') — observable for testing */
  language?: 'zh' | 'en'
}

/** Per-viewport runtime state — one slot per viewport instance. */
export interface ViewportSlot {
  readonly id: string
  camera: Ref<THREE.Camera | null>
  contentGroup: ShallowRef<THREE.Group | null>
  domElement: Ref<HTMLElement | null>
  definition: ShallowRef<StructureDefinition | null>
  layerPreview: Ref<LayerPreviewMode | null>
  gizmo: ShallowRef<MoveGizmo | null>
  overlayGroup: Ref<THREE.Group | null>
  wireframe: ShallowRef<THREE.LineSegments | null>
  orbitTarget: Ref<THREE.Vector3 | null>
}

export interface BContext {
  // === 场景核心数据（原 SceneContext） ===
  doc: Ref<RuntimeDocument | null>
  structEpoch: Ref<number>
  currentWorldFrameIndex: Ref<number>
  workspaceMode: Ref<WorkbenchWorkspaceMode>
  uiWorkspace: Ref<UIWorkspace>
  localFileName: Ref<string | null>
  // === 连接数据（reactive ConnectionState） ===
  connection: ConnectionState

  // === 子系统 ===
  selection: SelectionContext
  editHistory: UndoManager
  toolRegistry: ToolRegistry
  settings: BContextSettings
  operators: {
    exec(id: string, props?: Record<string, unknown>): void
    invoke(id: string, props?: Record<string, unknown>, event?: Event, regionId?: string): string
    find(id: string): { id: string; label: string } | undefined
    all(): { id: string; label: string }[]
    register(op: any): void
  }
  eventDispatcher: {
    registerRegion(regionId: string): void
    unregisterRegion(regionId: string): void
    registerRegionHandler(regionId: string, handler: import('@/events/handlerTypes').RegionEventHandler): () => void
    setActiveRegion(regionId: string): void
    getActiveRegion(): string | null
    getCurrentRegionId(): string | null
    pushModal(regionId: string, op: import('@/events/dispatcher').ModalOperation, event: Event): void
    cancelModal(regionId: string): void
    commitModal(regionId: string): void
    modalDepth(regionId: string): number
    dispatch(event: Event, options?: { regionId?: string }): { break: boolean }
  }
  log: {
    readonly entries: ShallowRef<Array<{ id: number; time: string; level: number; source: string; message: string; detail?: unknown }>>
    readonly lastDisplayable: Ref<{ level: number; source: string; message: string; detail?: unknown } | null>
    debug(source: string, message: string, detail?: unknown): unknown
    info(source: string, message: string, detail?: unknown): unknown
    operator(source: string, message: string, detail?: unknown): unknown
    warn(source: string, message: string, detail?: unknown): unknown
    error(source: string, message: string, detail?: unknown): unknown
    clear(): void
    contains(levelMask: number): boolean
    recent(levelMask?: number, count?: number): Array<unknown>
  }
  wikiConfig: Record<string, any>

  // === Multi-viewport ===
  /** Backward-compat: returns the active viewport slot. Code should migrate to `viewports.get(id)`. */
  readonly viewport: ViewportSlot
  viewports: ReturnType<typeof createViewportManager>

  /** Window manager (Blender 对标 wmWindowManager) */
  wm: {
    contextMenuOpen?: Ref<boolean>
    contextMenuPosition?: Ref<{ x: number; y: number }>
    contextMenuItems?: unknown[]
    showContextMenu?(cm: unknown, pos: { x: number; y: number }, items: unknown[]): void
    hideContextMenu?(cm: unknown): void
  }

  screen: bScreen | null
  rna: RNARegistry

  ui: {
    boundsOfByOperator(opId: string): Rect[]
    boundsOfByRNAPath(rnaPath: string): Rect[]
  }
}

/**
 * 从操作符 props 解析对应的 ViewportSlot。
 * 若 props 带 `_regionId`（由 operatorRegistry.invoke 注入），返回该 region 的 slot；
 * 否则回退到 `bctx.viewport`（active slot）。
 */
export function resolveViewportSlot(
  bctx: BContext,
  props: Record<string, unknown> | undefined,
): ViewportSlot {
  const rid = props?._regionId as string | undefined
  if (rid) {
    const slot = bctx.viewports.get(rid)
    if (slot) return slot
  }
  return bctx.viewport
}

export function createViewportManager() {
  const slots = new Map<string, ViewportSlot>()
  const activeId = ref<string | null>(null)
  const active = computed(() => {
    const id = activeId.value
    return id ? (slots.get(id) ?? null) : null
  })

  return {
    register(id: string): ViewportSlot {
      if (slots.has(id)) return slots.get(id)!
      const slot: ViewportSlot = {
        id,
        camera: ref(null),
        contentGroup: shallowRef(null),
        domElement: ref(null),
        definition: shallowRef(null),
        layerPreview: ref(null),
        gizmo: shallowRef(null),
        overlayGroup: ref(null),
        wireframe: shallowRef(null),
        orbitTarget: ref(null),
      }
      slots.set(id, slot)
      if (!activeId.value) activeId.value = id
      return slot
    },
    unregister(id: string): void {
      slots.delete(id)
      if (activeId.value === id) {
        activeId.value = slots.keys().next().value ?? null
      }
    },
    get(id: string): ViewportSlot | undefined {
      return slots.get(id)
    },
    activeId,
    active,
  }
}

export const bContextKey: InjectionKey<BContext> = Symbol('bContext')

export function provideBContext(ctx: BContext): void {
  provide(bContextKey, ctx)
}

export function useBContext(): BContext {
  const ctx = inject(bContextKey)
  if (!ctx) throw new Error('useBContext() 须在 WorkbenchRoot 子树内调用')
  return ctx
}
