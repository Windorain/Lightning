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

export interface BContext {
  scene: SceneContext
  selection: SelectionContext
  editHistory: UndoManager
  toolRegistry: ToolRegistry
  connection: ConnectionContext
  /** Viewport 运行时状态（WorkbenchViewport.onViewportReady 时填充） */
  camera: THREE.Camera | null
  contentGroup: THREE.Group | null
  domElement: HTMLElement | null
  controlsRef: { enabled: boolean } | null
  definition: StructureDefinition | null
  layerPreview: LayerPreviewMode | null
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
