/**
 * bContext — 对标 Blender 的 bContext。
 *
 * 聚合所有 Vue provide/inject 上下文为单一对象，
 * 操作符通过 bContext 隐式获取 scene/selection/editHistory/toolRegistry/connection。
 */
import type { InjectionKey } from 'vue'
import { inject, provide } from 'vue'
import type { SceneContext } from '@/workbench/sceneContext'
import type { SelectionContext } from '@/workbench/selectionContext'
import type { UndoManager } from '@/workbench/editHistoryContext'
import type { ToolRegistry } from '@/workbench/toolRegistry'
import type { ConnectionContext } from '@/workbench/connectionContext'
import type { StructureDefinition } from '@/render/schema/types'
import type { LayerPreviewMode } from '@/render/data/layerPreview'
import type { View3DConfig } from '@/preview/previewConfig'
import type { Ref, ShallowRef } from 'vue'
import type * as THREE from 'three'
import type { BlockRef } from '@/workbench/selectionContext'
import type { Frame } from '@/render/schema/types'
import type { WidgetRect } from '@/workbench/ux/layout'
import type { wmWindow, bScreen, ScrArea, ARegion, Rect } from '@/workbench/ux/types/screen'
import type { RNARegistry } from '@/workbench/ux/rna/types'
import type { MoveGizmo } from '@/workbench/tools/gizmos'

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

export interface BContextQueries {
  /** 屏幕坐标 → 方块引用（生产走 Three.js Raycaster，测试走纯数学） */
  pickVoxel(event: PointerEvent): BlockRef | null
  /** 获取当前帧的可变引用（用于读写 blocks/labels/annotations） */
  getCurrentFrame(): Frame | null
  /** 获取当前帧的 BlockRef 快照列表 */
  getFrameBlocks(): BlockRef[]
  /** 获取完整的场景文档（用于 annotations、labels 等顶层集合的访问） */
  getDocument(): Record<string, any> | null
  /** 方块世界坐标 → 屏幕坐标（供测试反算点击位置） */
  projectBlock(pos: { x: number; y: number; z: number }): { x: number; y: number } | null
  /** Gizmo 箭头在屏幕上的锚点坐标 */
  getGizmoAnchor(axis: 'x' | 'y' | 'z'): { x: number; y: number } | null
  /** 在 cellGrid 中移动方块（整数坐标），返回是否成功 */
  moveBlockInCellGrid(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): boolean
  /** 轴对齐向量运算：target = origin + dir * delta（替代 THREE.Vector3） */
  axisAdd(origin: { x: number; y: number; z: number }, axis: 'x' | 'y' | 'z', delta: number): { x: number; y: number; z: number }
  /** 向量取整 */
  roundVec(v: { x: number; y: number; z: number }): { x: number; y: number; z: number }
  /** 场景中所有注解框 */
  getAnnotationBoxes(): import('@/render/data/sceneDocumentV2').V2AnnotationBox[]
  /** 按 ID 获取单个注解框 */
  getAnnotationBox(id: string): import('@/render/data/sceneDocumentV2').V2AnnotationBox | null
  /** 射线命中方块 → 相邻放置位置 + 面法线。无命中返回 null */
  pickSurface(event: PointerEvent): { pos: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number } } | null
  /** 射线与地平面 (y=0) 交点，返回整数网格坐标 */
  pickGround(event: PointerEvent): { x: number; y: number; z: number } | null
  /** 射线命中浮点世界坐标（注解框用）。无命中 fallback 到地平面浮点坐标 */
  pickWorldPoint(event: PointerEvent): { x: number; y: number; z: number } | null
  /** List all materials with their texture data URLs */
  listMaterials(): MaterialQueryItem[]
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

/** 视口运行时——所有可观测的 Three.js / DOM 状态。单一赋值点：WorkbenchViewport.onViewportReady */
export interface ViewportRuntime {
  camera: Ref<THREE.Camera | null>
  contentGroup: Ref<THREE.Group | null>
  domElement: Ref<HTMLElement | null>
  definition: Ref<StructureDefinition | null>
  layerPreview: Ref<LayerPreviewMode | null>
  gizmo: ShallowRef<MoveGizmo | null>
  overlayGroup: Ref<THREE.Group | null>
  wireframe: ShallowRef<THREE.LineSegments | null>
  /** 轨道旋转目标点（scene.world.origin 偏移），默认 (0,0,0) */
  orbitTarget: Ref<THREE.Vector3 | null>
}

export interface BContext {
  scene: SceneContext
  selection: SelectionContext
  editHistory: UndoManager
  toolRegistry: ToolRegistry
  connection: ConnectionContext
  queries: BContextQueries
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
    registerRegionHandler(regionId: string, handler: import('@/workbench/events/handlerTypes').RegionEventHandler): () => void
    setActiveRegion(regionId: string): void
    getActiveRegion(): string | null
    getCurrentRegionId(): string | null
    pushModal(regionId: string, op: import('@/workbench/eventDispatcher').ModalOperation, event: PointerEvent): void
    cancelModal(regionId: string): void
    commitModal(regionId: string): void
    modalDepth(regionId: string): number
    dispatch(event: Event, options?: { regionId?: string }): { break: boolean }
  }
  log: {
    readonly entries: { value: Array<{ id: number; time: string; level: number; source: string; message: string; detail?: unknown }> }
    readonly lastDisplayable: { value: { level: number; source: string; message: string; detail?: unknown } | null }
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
  /** 底部状态栏消息 */
  statusMessage: { value: string }
  /** 视口运行时（WorkbenchViewport.onViewportReady 时填充） */
  viewport: ViewportRuntime

  /** 3D 渲染配置（embed 场景使用，workbench 内可选） */
  config?: ShallowRef<View3DConfig>

  /** Window manager (Blender 对标 wmWindowManager) */
  wm: {
    windows: wmWindow[]
    activeWindow: wmWindow | null
  }

  screen: bScreen | null
  area: ScrArea | null
  region: ARegion | null
  rna: RNARegistry

  ui: {
    computeLayout(screen: bScreen): void
    boundsOf(id: string): Rect | null
    boundsOfByOperator(opId: string): Rect[]
    boundsOfByOperatorMatchProps(opId: string, matchProps: Record<string, unknown>): WidgetRect[]
    boundsOfByRNAPath(rnaPath: string): Rect[]
    regionAt(x: number, y: number): { area: ScrArea; region: ARegion } | null
    relayout(): void
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
