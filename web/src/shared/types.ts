/**
 * shared/types.ts — 最小化接口定义，供 shared/ 层使用。
 *
 * 避免 shared/ composables 反向依赖 workbench/ 上下文类型。
 * workbench/ 层的 BContext / RenderAssets 通过 implements 这些接口关联。
 */
import type { ComputedRef, Ref } from 'vue'
import type * as THREE from 'three'
import type { Annotation } from '@/render/data/annotationTypes'
import type { LayerPreviewMode } from '@/render/data/layerPreview'

// ---------------------------------------------------------------------------
// LoadStatus
// ---------------------------------------------------------------------------

export type LoadStatus = 'loading' | 'ok' | 'error'

// ---------------------------------------------------------------------------
// ViewportSlotAccess — 注解覆层渲染所需的最小视口槽位接口
// ---------------------------------------------------------------------------

export interface ViewportSlotAccess {
  id: string
  overlayGroup: { value: THREE.Group | null }
}

// ---------------------------------------------------------------------------
// ViewportBContext — useViewport 所需的 BContext 最小化接口
// ---------------------------------------------------------------------------

export interface ViewportBContext {
  doc: Ref<{ serialize(): Record<string, any>; frameCount: number } | null>
  structEpoch: Ref<number>
  viewport: ViewportSlotAccess
}

// ---------------------------------------------------------------------------
// ViewportRenderAssets — useViewport 所需的 RenderAssets 最小化接口
// ---------------------------------------------------------------------------

export interface ViewportRenderAssets {
  computed: {
    layerPreviewMode: ComputedRef<LayerPreviewMode>
    gridHeight: ComputedRef<number>
  }
  rebuildAnnotationOverlay(annotations: Annotation[]): Promise<THREE.Group | null>
  disposeCachesAndLibrary(): void
  dispose(): void
}

// ---------------------------------------------------------------------------
// Screen types (shared between embed and workbench)
// ---------------------------------------------------------------------------

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

// ---------------------------------------------------------------------------
// RNA types (shared between embed and workbench)
// ---------------------------------------------------------------------------

export type RNAPropType =
  | 'string' | 'number' | 'boolean' | 'enum' | 'color' | 'vector3'

export interface PropertyDescriptor {
  name: string
  type: RNAPropType
  label: string
  description: string
  default: unknown
  min?: number
  max?: number
  enumItems?: string[]
  update?: string
  uiWidget?: 'text' | 'number' | 'slider' | 'stepper' | 'stepper-compact' | 'checkbox' | 'dropdown' | 'color' | 'vector'
  get(owner: unknown): unknown
  set(owner: unknown, value: unknown): void
}

export interface RNAStruct {
  name: string
  description: string
  properties: PropertyDescriptor[]
}

export interface RNARegistry {
  structs: Map<string, RNAStruct>
  register(struct: RNAStruct): void
  resolve(path: string): PropertyDescriptor | null
  widgetFor(prop: PropertyDescriptor): string
}

