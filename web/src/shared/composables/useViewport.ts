/**
 * useViewport — shared composable for viewport state and rendering assets.
 *
 * Extracts the common createRenderAssets() call, ref declarations, and
 * SelectionOutlinePass creation that were duplicated between
 * WorkbenchViewport.vue and EmbedViewport.vue.
 *
 * Uses minimal interfaces from @/shared/types to avoid depending on
 * workbench/ context types.
 */
import { computed, ref, shallowRef, type ShallowRef } from 'vue'
import * as THREE from 'three'
import type { StructureDefinition } from '@/render/schema/types'
import type { BlockIconCache } from '@/render/interaction/blockIconCache'
import { SelectionOutlinePass } from '@/render/postprocessing/SelectionOutlinePass'
import { type Annotation, annotationIsOnLayer } from '@/render/data/annotationTypes'
import type { LoadStatus, ViewportBContext, ViewportRenderAssets } from '@/shared/types'

export interface UseViewportOptions<TRenderAssets = ViewportRenderAssets> {
  bctx: ViewportBContext
  structureDefinition: ShallowRef<StructureDefinition | null>
  mainMeshGroup: ShallowRef<THREE.Group | null>
  blockIconCacheOptions?: { sizePx?: number; orthoHalf?: number }
  initialWorldFrameIndex?: number
  initialLayerWorldY?: number
  /**
   * Factory function to create render assets (texture cache, mesh providers…).
   * Provided by the caller (who imports createRenderAssets from workbench/context).
   * The deps object matches RenderAssetsDeps structurally at runtime.
   */
  createRenderAssets: (deps: any) => TRenderAssets
}

/**
 * @typeParam TRenderAssets — The concrete RenderAssets subtype returned by
 *   createRenderAssets. Inferred from the passed `createRenderAssets` callback
 *   (typically RenderAssets from workbench/context). Falls back to the minimal
 *   ViewportRenderAssets interface as a constraint.
 */
export function useViewport<TRenderAssets = ViewportRenderAssets>(
  options: UseViewportOptions<TRenderAssets>,
) {
  const {
    bctx,
    structureDefinition,
    mainMeshGroup,
    blockIconCacheOptions = {},
    initialWorldFrameIndex,
    initialLayerWorldY = -1,
  } = options

  // ---- Shared refs (formerly duplicated in each viewport) ----
  const sceneRef = shallowRef<THREE.Scene | null>(null)
  const loadStatus = ref<LoadStatus>('loading')
  const meshBusy = ref(false)
  const blockIconCache = shallowRef<BlockIconCache | null>(null)
  const tooltipPalette = shallowRef<string[]>([])
  const worldFrameIndex = ref(0)
  const layerWorldY = ref(initialLayerWorldY)
  const framesPlaybackIsPlaying = ref(false)

  // ---- Computed doc ref from bctx ----
  const docRef = computed(() => bctx.doc.value)

  // ---- Render assets (texture cache, mesh providers, etc.) ----
  const renderAssets = options.createRenderAssets({
    docRef,
    loadStatus,
    meshBusy,
    blockIconCache,
    tooltipPalette,
    structureDefinition,
    mainMeshGroup,
    sceneRef,
    worldFrameIndex,
    layerWorldY,
    framesPlaybackIsPlaying,
    blockIconCacheOptions,
    initialWorldFrameIndex,
    structEpochRef: bctx.structEpoch,
  }) as TRenderAssets

  // ---- Shared SelectionOutlinePass (configured per-viewport in onViewportReady) ----
  const outlinePass = new SelectionOutlinePass(new THREE.Vector2(1024, 768))

  return {
    // Refs (used in templates — keep as top-level bindings via destructuring)
    sceneRef,
    loadStatus,
    meshBusy,
    blockIconCache,
    tooltipPalette,
    structureDefinition,
    mainMeshGroup,
    worldFrameIndex,
    layerWorldY,
    framesPlaybackIsPlaying,
    docRef,
    // Objects
    renderAssets,
    outlinePass,
  }
}

// ---- Per-viewport annotation overlay state (was module-level single-instance) ----
const _annoState = new Map<string, { group: THREE.Group | null; hash: string; pending: boolean }>()

function _getAnnoState(viewportId: string): { group: THREE.Group | null; hash: string; pending: boolean } {
  let s = _annoState.get(viewportId)
  if (!s) {
    s = { group: null, hash: '', pending: false }
    _annoState.set(viewportId, s)
  }
  return s
}

/**
 * Update annotation overlay meshes in the viewport scene.
 *
 * Deduplicates ~40 lines shared between WorkbenchViewport and EmbedViewport.
 *
 * @param bctx
 * @param renderAssets
 * @param showAnnotationsGate — optional gate; when false, annotation group is
 *   built but not added to the overlay scene. Defaults to true.
 */
export function updateAnnotationOverlay(
  bctx: ViewportBContext,
  renderAssets: ViewportRenderAssets,
  showAnnotationsGate?: boolean,
): void {
  const doc = bctx.doc.value
  if (!doc) return
  const plain = doc.serialize() as Record<string, any>
  let annos: Annotation[] = plain.annotations ?? []

  const mode = renderAssets.computed.layerPreviewMode.value
  if (mode !== 'all') {
    const gh = renderAssets.computed.gridHeight.value
    annos = annos.filter(a => annotationIsOnLayer(a, mode.worldY, gh))
  }

  const maxUpdated = annos.length > 0
    ? annos.reduce((max, a) => Math.max(max, a.updated_at), 0)
    : 0
  const layerKey = mode === 'all' ? 'all' : `l${mode.worldY}`
  const hash = annos.length > 0 ? `${layerKey}_${annos.length}_${maxUpdated}` : 'empty'

  const viewportId = bctx.viewport.id
  const s = _getAnnoState(viewportId)
  if (hash === s.hash || s.pending) return
  s.hash = hash
  s.pending = true

  renderAssets.rebuildAnnotationOverlay(annos).then(group => {
    const s2 = _getAnnoState(viewportId)
    s2.pending = false
    if (s2.group) {
      bctx.viewport.overlayGroup.value?.remove(s2.group)
      s2.group.traverse((c) => {
        if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments || c instanceof THREE.Line) {
          c.geometry?.dispose()
          ;(c.material as THREE.Material)?.dispose()
        }
      })
      s2.group = null
    }
    if (group) {
      s2.group = group
      if (showAnnotationsGate ?? true) {
        bctx.viewport.overlayGroup.value?.add(s2.group)
      }
    }
  }).catch(() => {
    const s3 = _getAnnoState(viewportId)
    s3.pending = false
  })
}

/** Dispose annotation overlay group and reset cached state for a given viewport. */
export function disposeAnnotationOverlay(viewportId: string): void {
  const s = _annoState.get(viewportId)
  if (!s) return
  if (s.group) {
    s.group.traverse((c) => {
      if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments || c instanceof THREE.Line) {
        c.geometry?.dispose()
        ;(c.material as THREE.Material)?.dispose()
      }
    })
  }
  _annoState.delete(viewportId)
}

/** Get the current annotation overlay group for a given viewport (for visibility toggling). */
export function getAnnotationOverlayGroup(viewportId: string): THREE.Group | null {
  return _annoState.get(viewportId)?.group ?? null
}
