import { computed, toRef } from 'vue'
import type { Context } from '@/runtime/context'
import { DRW } from '@/runtime/drw'
import type { ViewerPreferences } from '@/viewer/preferences'
import type { BlockIconCacheOptions } from '@/render/interaction/blockIconCache'

export interface UseViewportRuntimeOptions {
  ctx: Context
  regionId: string
  viewerPrefs: ViewerPreferences
  blockIconCacheOptions?: BlockIconCacheOptions
  initialWorldFrameIndex?: number
}

/**
 * 共享视口运行时：ViewportSlot 注册 + DRW 构造（Embed / Workbench 共用）。
 */
export function useViewportRuntime(opts: UseViewportRuntimeOptions) {
  const { ctx, regionId, viewerPrefs, blockIconCacheOptions = {}, initialWorldFrameIndex } = opts
  const vpSlot = ctx.viewports.get(regionId) ?? ctx.viewports.register(regionId)
  const docRef = computed(() => ctx.getDoc().value)

  const drw = new DRW({
    docRef,
    structEpochRef: ctx.getStructEpoch(),
    currentFrameIndex: ctx.main.currentFrameIndex,
    layerWorldY: ctx.getLayerWorldY(),
    framesPlaybackIsPlaying: ctx.main.framesPlaybackIsPlaying,
    structureDefinition: vpSlot.definition,
    mainMeshGroup: vpSlot.contentGroup,
    blockIconCacheOptions,
    initialWorldFrameIndex,
    setFrameIndex: (i) => ctx.getOperators().exec('OPERATOR_SET_FRAME_INDEX', { index: i }),
    setFramesPlayback: (playing) => ctx.getOperators().exec('OPERATOR_SET_FRAME_PLAYBACK', { playing }),
    showAnnotationsRef: toRef(viewerPrefs, 'showAnnotations'),
    worldAnnotationGroupRef: vpSlot.worldAnnotationGroup,
    toolsOverlayGroupRef: vpSlot.toolsOverlayGroup,
    viewportCameraRef: vpSlot.viewportCamera,
    cameraRef: vpSlot.camera,
    orbitTargetRef: vpSlot.orbitTarget,
  })

  return {
    ctx,
    regionId,
    vpSlot,
    drw,
    docRef,
    viewerPrefs,
    loadStatus: drw.loadStatus,
    meshBusy: drw.meshBusy,
    blockIconCache: drw.blockIconCache,
    tooltipPalette: drw.tooltipPalette,
    outlinePass: drw.outlinePass,
    structureDefinition: vpSlot.definition,
    mainMeshGroup: vpSlot.contentGroup,
    worldFrameIndex: ctx.main.currentFrameIndex,
    layerWorldY: ctx.getLayerWorldY(),
    framesPlaybackIsPlaying: ctx.main.framesPlaybackIsPlaying,
    computed: drw.computed,
    materialLibrary: drw.textureCache,
  }
}
