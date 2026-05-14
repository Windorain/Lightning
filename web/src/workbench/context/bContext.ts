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
import type * as THREE from 'three'
import type { BlockRef } from '@/workbench/selectionContext'
import type { V2WorldFrame } from '@/render/data/sceneDocumentV2'
import type { wmWindow, bScreen, ScrArea, ARegion, Rect } from '@/workbench/ux/types/screen'
import type { RNARegistry } from '@/workbench/ux/rna/types'

export interface BContextQueries {
  /** 屏幕坐标 → 方块引用（生产走 Three.js Raycaster，测试走纯数学） */
  pickVoxel(event: PointerEvent): BlockRef | null
  /** 获取当前帧的可变引用（用于读写 blocks/labels/annotations） */
  getCurrentFrame(): V2WorldFrame | null
  /** 获取当前帧的 BlockRef 快照列表 */
  getFrameBlocks(): BlockRef[]
  /** 获取完整的场景文档（用于 annotations、labels 等顶层集合的访问） */
  getDocument(): Record<string, any> | null
  /** 方块世界坐标 → 屏幕坐标（供测试反算点击位置） */
  projectBlock(pos: { x: number; y: number; z: number }): { x: number; y: number } | null
  /** Gizmo 箭头在屏幕上的锚点坐标 */
  getGizmoAnchor(axis: 'x' | 'y' | 'z'): { x: number; y: number } | null
  /** 轴对齐向量运算：target = origin + dir * delta（替代 THREE.Vector3） */
  axisAdd(origin: { x: number; y: number; z: number }, axis: 'x' | 'y' | 'z', delta: number): { x: number; y: number; z: number }
  /** 向量取整 */
  roundVec(v: { x: number; y: number; z: number }): { x: number; y: number; z: number }
}

export interface BContextSettings {
  replaceBrush: string | null
  fillBrush: string | null
  generateType: string | null
  /** Gizmo 拖拽灵敏度（原硬编码 const k = 0.05） */
  dragSensitivity: number
  /** Snap 吸附开关 */
  snapEnabled: boolean
}

export interface BContext {
  scene: SceneContext
  selection: SelectionContext
  editHistory: UndoManager
  toolRegistry: ToolRegistry
  connection: ConnectionContext
  /** 场景查询（操作符通过此访问场景数据，不直接 import sceneQueries） */
  queries: BContextQueries
  /** 工具设置（替代 brushState.ts 的模块级 Vue ref） */
  settings: BContextSettings
  /** 操作符注册表（通过 exec/invoke/find 执行操作符） */
  operators: {
    exec(id: string, props?: Record<string, unknown>): void
    invoke(id: string, props?: Record<string, unknown>, event?: Event): string
    find(id: string): { id: string; label: string } | undefined
    all(): { id: string; label: string }[]
    register(op: any): void
  }
  /** 事件分发器 */
  eventDispatcher: {
    pushModal(op: unknown, event: PointerEvent): () => void
    dispatch(event: Event): { break: boolean }
    registerHandler(handler: unknown): () => void
    registerTypedHandler(handler: unknown): () => void
  }
  /** 日志中心 */
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
  /** Wiki 配置 */
  wikiConfig: Record<string, any>
  /** Viewport 运行时状态（WorkbenchViewport.onViewportReady 时填充） */
  camera: THREE.Camera | null
  contentGroup: THREE.Group | null
  domElement: HTMLElement | null
  controlsRef: { enabled: boolean } | null
  definition: StructureDefinition | null
  layerPreview: LayerPreviewMode | null

  /** Window manager (Blender 对标 wmWindowManager) */
  wm: {
    windows: wmWindow[]
    activeWindow: wmWindow | null
  }

  /** Current context pointers (C->screen, C->area, C->region in Blender) */
  screen: bScreen | null
  area: ScrArea | null
  region: ARegion | null

  /** RNA reflection registry */
  rna: RNARegistry

  /** UI layout engine */
  ui: {
    computeLayout(screen: bScreen): void
    boundsOf(id: string): Rect | null
    boundsOfByOperator(opId: string): Rect[]
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
