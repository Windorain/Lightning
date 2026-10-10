import { computed, toRef, type Ref } from 'vue'
import type { Context } from '@/runtime/context'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import { cameraMainKeyForRegion } from '@/runtime/mainCameras'
import { DRW } from '@/runtime/drw'
import type { ViewerPreferences } from '@/viewer/preferences'
import type { BlockIconCacheOptions } from '@/render/interaction/blockIconCache'

export interface UseViewportRuntimeOptions {
  ctx: Context
  regionId: string
  viewerPrefs: ViewerPreferences
  blockIconCacheOptions?: BlockIconCacheOptions
  initialWorldFrameIndex?: number
  /**
   * 可选的**渲染视图文档**覆盖（T2.5 接线）。
   *
   * 多方块文档的 `frame.grid` 恒为 `null`（网格是装配产物），故渲染路径必须吃装配结果；
   * 由 `useMultiblockChannels().renderDoc` 提供（帧为主文档时它就是 `ctx.getDoc()` 本身，行为零变化）。
   * 省略该参数时 DRW 直接订阅 `ctx.getDoc()`（既有行为）。
   */
  docOverride?: Ref<RuntimeDocument | null>
}

/**
 * 共享视口运行时：ViewportSlot 注册 + DRW 构造（Embed / Workbench 共用）。
 */
export function useViewportRuntime(opts: UseViewportRuntimeOptions) {
  const { ctx, regionId, viewerPrefs, blockIconCacheOptions = {}, initialWorldFrameIndex, docOverride } = opts
  const vpSlot = ctx.viewports.get(regionId) ?? ctx.viewports.register(regionId)
  const docRef = docOverride ?? computed(() => ctx.getDoc().value)

  const drw = new DRW({
    docRef,
    contentRefreshTickRef: ctx.getContentRefreshTick(),
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
    viewportCameraRef: ctx.main.cameras[cameraMainKeyForRegion(regionId)],
    cameraRef: vpSlot.camera,
    orbitTargetRef: vpSlot.orbitTarget,
  })

  // B-1：把描边 mask pass 挂到 slot 的公开观测点（e2e 读 mask 几何、排障用）
  vpSlot.outlinePass = drw.outlinePass

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
