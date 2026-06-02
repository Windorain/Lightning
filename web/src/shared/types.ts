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
}
