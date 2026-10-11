import { computed, onScopeDispose, toRef, type Ref } from 'vue'
import type { Context } from '@/runtime/context'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import { cameraMainKeyForRegion } from '@/runtime/mainCameras'
import { DRW } from '@/runtime/drw'
import { sceneSeconds } from '@/composition/kernelRuntime'
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
 *
 * ## P10 #261 的接线改造（R-WK-03）
 *
 * 三处变化，各自对应一个被退役的旧机制：
 *
 * | 旧形态 | 新形态 |
 * |---|---|
 * | `currentFrameIndex: ctx.main.currentFrameIndex`（可写 Ref） | `worldFrameIndex: () => kernel.frameIndex()`（**派生**只读 getter） |
 * | `framesPlaybackIsPlaying: ctx.main.framesPlaybackIsPlaying` | `isPlaying: () => kernel.playback().playing`（读面，不驱动调度） |
 * | `setFrameIndex` / `setFramesPlayback` 经 operator 写 Ref | `seekFrame` 经内核命令定位**时间** |
 *
 * 关键差别不在"换成函数了"，而在**权威数量**：旧形态下帧下标是一个可写
 * 独立权威（本文件、operator、加载路径都能写），于是"谁在推进帧"没有唯一答案；
 * 新形态下时间只有一个权威（`EditContext.time`），帧下标是它的派生值。
 *
 * ## 帧时钟的归属（**不在**本 composable）
 *
 * 帧时钟由 `composition/kernelRuntime` 创建，归**外壳**（工作台/嵌入各一个），
 * 而不是每个视口一个 —— 因为时间属共享 `EditContext`：
 * 两个 Area 必须看到同一时间（A05）。若每个视口各起一个帧时钟，
 * 同一时间会被推进两次（第二个视口让时间走两倍）。
 * ⇒ 本 composable 只**消费**会话，不拥有时钟。
 */
export function useViewportRuntime(opts: UseViewportRuntimeOptions) {
  const { ctx, regionId, viewerPrefs, blockIconCacheOptions = {}, initialWorldFrameIndex, docOverride } = opts
  const vpSlot = ctx.viewports.get(regionId) ?? ctx.viewports.register(regionId)
  const docRef = docOverride ?? computed(() => ctx.getDoc().value)

  /**
   * 内核会话（P10 #261）。
   *
   * 未接线时 `ctx.kernel` 为 `null` ⇒ 本 composable 退化为"帧下标恒 0、
   * 播放恒 false"，且**不**抛错（视口在无会话的装配里仍应能显示第一帧）。
   * 这与 `requireKernelSession()` 的抛错语义**刻意不同**：
   *  - operator（写面）：没有会话就是配置缺陷，必须显式失败；
   *  - 视口（读面）：没有会话只是"没有时间源"，退化为静态第一帧是**正确**行为
   *    （而不是把整个视口搞崩）。
   */
  const kernel = ctx.kernel

  const drw = new DRW({
    docRef,
    contentRefreshTickRef: ctx.getContentRefreshTick(),
    // 帧下标：派生值（无会话 ⇒ 恒 0，即静态第一帧）。
    worldFrameIndex: () => kernel?.frameIndex() ?? 0,
    layerWorldY: ctx.getLayerWorldY(),
    structureDefinition: vpSlot.definition,
    mainMeshGroup: vpSlot.contentGroup,
    blockIconCacheOptions,
    initialWorldFrameIndex,
    // 换帧 = 定位时间（**不**写帧下标）。
    seekFrame: (i) => kernel?.seekFrame(i),
    // 播放状态是**读面**：本层不驱动任何调度（帧时钟归外壳）。
    isPlaying: () => kernel?.playback().playing ?? false,
    showAnnotationsRef: toRef(viewerPrefs, 'showAnnotations'),
    worldAnnotationGroupRef: vpSlot.worldAnnotationGroup,
    toolsOverlayGroupRef: vpSlot.toolsOverlayGroup,
    viewportCameraRef: ctx.main.cameras[cameraMainKeyForRegion(regionId)],
    cameraRef: vpSlot.camera,
    orbitTargetRef: vpSlot.orbitTarget,
  })

  // B-1：把描边 mask pass 挂到 slot 的公开观测点（e2e 读 mask 几何、排障用）
  vpSlot.outlinePass = drw.outlinePass

  /**
   * 帧变化 ⇒ 重绘该帧（P10 #261）。
   *
   * ## 为什么订阅在**这里**而不是每个视口各起一个帧时钟
   *
   * 帧时钟归外壳（时间属共享 `EditContext`，见上方说明）。但"帧变了要重绘"
   * 是**每个视口**自己的事（两个 Area 各有自己的 mesh/definition）。
   * ⇒ 外壳的时钟广播一帧事实，各视口的本 composable 各自订阅并重绘自己。
   *
   * 这与旧形态的关键差别：旧实现是本管线自己 watch 一个 `Ref<number>`
   * （`Main.currentFrameIndex`）—— 那个 Ref 的写入者可能不是播放
   * （operator/加载路径都写），于是"重绘"与"时间真的变了"可以无关。
   * 现在判据只有一个：**内核派生的帧下标变了**。
   *
   * ## 为什么在 `onScopeDispose` 里退订
   *
   * 视口组件卸载（Area 关闭/切类型）后，残留的订阅会在下次换帧时
   * 对着已 dispose 的 DRW 调 `presentWorldFrame` —— 一次真实的"幽灵重绘"。
   */
  let lastPresentedFrame = -1
  const frameClock = ctx.getFrameClock()
  if (frameClock && kernel) {
    const off = frameClock.onFrame((info) => {
      /**
       * **纹理动画的时间输入**（P10 #261）。
       *
       * 这是被删除的 `materialLibrary.tick(clock.getDelta()*1000)` 的替代：
       * 旧实现是"每材质累加 delta"，新实现是"把**场景时间**告诉材质库"。
       *
       * 注意它**每帧**都调用（不只是换帧时）—— 因为纹理序列的采样率
       * 与显示刷新率是**解耦**的（#249 §7）：一次 tick 里纹理可能前进好几帧，
       * 也可能一帧都不前进。材质库内部是无状态的纯映射，故每帧调用
       * 不会累积任何东西。
       *
       * 顺序：**先**更新时间再判断换帧 —— 换帧判断读的是同一个时间，
       * 反过来会让"这一帧的纹理时间"与"这一帧的世界帧"来自两个时刻。
       */
      drw.textureCache.value?.setSceneTime(sceneSeconds(info.time))
      if (info.frameIndex === lastPresentedFrame) return
      lastPresentedFrame = info.frameIndex
      void drw.presentWorldFrame(info.frameIndex)
    })
    onScopeDispose(() => {
      off()
    })
    // 首帧：进入视口时立刻呈现当前帧（不等第一次时钟 tick）。
    lastPresentedFrame = kernel.frameIndex()
    drw.textureCache.value?.setSceneTime(sceneSeconds(kernel.playback().time))
  }

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
    /**
     * 世界帧下标（**派生**）。
     *
     * 返回 `Ref<number>` 形态是**呈现兼容**：模板里写
     * `:world-frame-index="worldFrameIndex"` 需要可自动解包的 `Ref`。
     * 它是一个 `computed`（只读）—— 与旧的可写 `Ref` 的差别在**写面**：
     * 想改帧必须走 `setFrameIndex`（经内核命令），不能 `.value = i`。
     */
    worldFrameIndex: computed(() => kernel?.frameIndex() ?? 0),
    layerWorldY: ctx.getLayerWorldY(),
    /** 播放状态（只读 `computed`；写面在 `togglePlayback`/`setFramePlayback`）。 */
    isPlaying: computed(() => kernel?.playback().playing ?? false),
    playbackRate: computed(() => kernel?.playback().rate ?? 1),
    frameCount: computed(() => kernel?.frameCount() ?? (ctx.getDoc().value?.frameCount ?? 0)),
    computed: drw.computed,
    materialLibrary: drw.textureCache,
  }
}
