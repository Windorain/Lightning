/**
 * useViewport — shared composable for viewport state and rendering assets.
 *
 * Extracts the common createRenderAssets() call, ref declarations, and
 * SelectionOutlinePass creation that were duplicated between
 * WorkbenchViewport.vue and EmbedViewport.vue.
 */
import { computed, ref, shallowRef, type ShallowRef } from 'vue'
import * as THREE from 'three'
import type { BContext, LoadStatus } from '@/workbench/context/bContext'
import type { StructureDefinition } from '@/render/schema/types'
import type { BlockIconCache } from '@/render/interaction/blockIconCache'
import { createRenderAssets, type RenderAssets } from '@/workbench/context/renderAssets'
import { SelectionOutlinePass } from '@/render/postprocessing/SelectionOutlinePass'
import { type Annotation, annotationIsOnLayer } from '@/render/data/annotationTypes'

export interface UseViewportOptions {
  bctx: BContext
  structureDefinition: ShallowRef<StructureDefinition | null>
  mainMeshGroup: ShallowRef<THREE.Group | null>
  blockIconCacheOptions?: { sizePx?: number; orthoHalf?: number }
  initialWorldFrameIndex?: number
  initialLayerWorldY?: number
}

export function useViewport(options: UseViewportOptions) {
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
  const renderAssets: RenderAssets = createRenderAssets({
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
  })

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

// ---- Module-level annotation overlay state (single viewport instance) ----
let _annoGroup: THREE.Group | null = null
let _annoHash = ''
let _annoPending = false

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
  bctx: BContext,
  renderAssets: RenderAssets,
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
  if (hash === _annoHash || _annoPending) return
  _annoHash = hash
  _annoPending = true

  renderAssets.rebuildAnnotationOverlay(annos).then(group => {
    _annoPending = false
    if (_annoGroup) {
      bctx.viewport.overlayGroup.value?.remove(_annoGroup)
      _annoGroup.traverse((c) => {
        if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments || c instanceof THREE.Line) {
          c.geometry?.dispose()
          ;(c.material as THREE.Material)?.dispose()
        }
      })
      _annoGroup = null
    }
    if (group) {
      _annoGroup = group
      if (showAnnotationsGate ?? true) {
        bctx.viewport.overlayGroup.value?.add(_annoGroup)
      }
    }
  }).catch(() => { _annoPending = false })
}

/** Dispose annotation overlay group and reset cached state. */
export function disposeAnnotationOverlay(): void {
  if (_annoGroup) {
    _annoGroup.traverse((c) => {
      if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments || c instanceof THREE.Line) {
        c.geometry?.dispose()
        ;(c.material as THREE.Material)?.dispose()
      }
    })
    _annoGroup = null
  }
  _annoHash = ''
  _annoPending = false
}

/** Get the current annotation overlay group (for visibility toggling). */
export function getAnnotationOverlayGroup(): THREE.Group | null {
  return _annoGroup
}
