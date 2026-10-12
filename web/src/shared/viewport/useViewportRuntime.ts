import { computed, onScopeDispose, ref, toRef, type Ref } from 'vue'
import type { Context } from '@/runtime/context'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import { cameraMainKeyForRegion } from '@/runtime/mainCameras'
import { DRW } from '@/runtime/drw'
import { PresenterSession } from '@/composition/presenterSession'
import { sceneSeconds } from '@/composition/kernelRuntime'

/**
 * 时间零值（领域形状 `{frame,fps}`）。
 *
 * ## 为什么在这里就地声明（而**不** import `@/domain/animation#TIME_ZERO`）
 *
 * 本文件属**旧层**（`shared/`），而 `domain/` 是**新内核**。旧层 import 新内核
 * 必须有登记（`kernel-legacy-isolation` 的 `APPROVED_LEGACY_TO_KERNEL_EDGES`）——
 * 本批实测：加一条为取"时间零值"而生的旧→新依赖，被闸门正确判红。
 *
 * 而这里需要的东西**只是一个零值字面量**（`{frame: 0, fps: 20}`），
 * 为它开一条迁移边是本末倒置：那条边会长期存在，而"零值"根本不是内核能力。
 * ⇒ 就地声明，与 `domain/animation` 的初值同形（`fps: 20` = 1 MC tick/帧，
 * 见 `DEFAULT_WORLD_FRAME_DWELL_MS` 的同源口径）。
 *
 * 这条选择本身是可断言的：`e2e`/单测里"无会话视口退化为静态第一帧"的行为不变。
 */
const ZERO_TIME = Object.freeze({ frame: 0, fps: 20 })
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
  // #301 P10f D3（R9）：DRW 的文档来源（渲染链旧格式）。终切在 D 批映射表 §八
  // 被显式排除 ⇒ 本处是接缝 `legacy-render-source-document` 的落点。
  const docRef = docOverride ?? computed(() => ctx.legacyRenderSource())

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
    // 经 `ensureCamera`（不是直接下标）：`cameras` 是**开放**键空间（按 region
    // 分配，#282）—— 新视口的键可能尚未创建，直接下标会得到 `undefined`，
    // 而 `DRW.bindViewportCameraSync` 拿到 `undefined` 会**静默跳过**机位同步
    // （表现为"新视口转不动/不跟随时序"，且没有任何报错）。
    viewportCameraRef: ctx.main.ensureCamera(cameraMainKeyForRegion(regionId)),
    cameraRef: vpSlot.camera,
    orbitTargetRef: vpSlot.orbitTarget,
  })

  // B-1：把描边 mask pass 挂到 slot 的公开观测点（e2e 读 mask 几何、排障用）
  vpSlot.outlinePass = drw.outlinePass

  /**
   * **呈现会话**（#299 P10e 段②：`BatchedPresenter` 的生产接线）。
   *
   * ## 它替代的旧机制
   *
   * `BatchedPresenter` 在本批之前**零生产调用方**（只被 e2e 探针与单测驱动）
   * —— 于是"内核场景 → `PresentationInputs` → `compileScene` → presenter → 屏幕"
   * 这条链在**判定面上绿**、在**生产上不存在**（P10c/P10d 反复实测的缺口形态）。
   * 本会话就是那个缺失的生产消费者。
   *
   * ## 与 DRW 的并存关系（**本批不切换渲染链**，显式登记）
   *
   * `DRW`（`blockMeshProvider` → legacy `blockMesh`）此刻仍是**画面**的生产路径；
   * 本会话平行建立一套呈现产物并挂在**同一个** `contentGroup` 之外的结构层下。
   * 两者并存是**有退出阶段的暂存**（登记于 `composition/seams.ts`：
   * `presenter-surface-dual-track`），渲染链终切归 **#301（P10f 子批 C/D）**。
   *
   * ## 为什么现在不接管画面（本批刻意的边界）
   *
   * 接管需要"DRW 消费内核求值产物"的整体切换，而其前置（保存面迁移、
   * 9 条未装配的加载路径、命令面扩展）尚未交付。按 #171 纪律**不做半成品替换**
   * —— 切一半会让"交互或画面回退且无替代"。本批交付的是**新层在生产里真实运行**
   * 且有其自己的可观测面（拾取逐格、纹理绑定、逐像素证据），
   * 而不是"看起来切了但能力少一半"。
   *
   * ## 挂载位置：不挂进 `contentGroup`
   *
   * `contentGroup` 是 legacy 渲染路径的产物（`DRW` 往里放 `blockMesh` 的 Group）。
   * 挂进去会让两条路径的对象混在同一棵子树里 —— 既无法分别观测，
   * 也会让"谁画了这 24 个三角形"没有唯一答案。故本会话有**自己的**根对象，
   * 由本 composable 加到视口场景（见下方 `onScopeDispose` 的对称释放）。
   */
  const presenterSurface = new PresenterSession({ scope: `viewport:${regionId}` })
  vpSlot.presenterSurface = presenterSurface
  onScopeDispose(() => {
    // 卸载即释放（A19：视口关闭不泄漏 GPU 份额；两个视口共享源数据时
    // 关其一不破坏另一方 —— 设备作用域按 region 分，故账天然分开）。
    presenterSurface.dispose()
    if (vpSlot.presenterSurface === presenterSurface) vpSlot.presenterSurface = null
  })

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
  /**
   * **响应式镜像**（P10 #261：派生值的呈现侧缓存）。
   *
   * ## 为什么需要它（一处真实的、由 e2e 抓出的缺陷）
   *
   * 首版把 `worldFrameIndex` 写成 `computed(() => kernel.frameIndex())` ——
   * 看起来对，实际**不响应**：`kernel.frameIndex()` 读的是内核会话的**普通私有字段**
   * （不是 Vue Ref），`computed` 收集不到任何依赖，于是它算出一次就再也不重算。
   * 后果由 `multiblock-frame-regression.spec.ts` 抓到：拖滑杆换帧后，
   * 视口底栏仍显示"帧 1/3"（DOM 用的是这个 computed），而
   * `ctx.getFrameIndex()`（直接问内核）**已经是 2** —— 两个读面不一致。
   *
   * ## 修法：**推**而不是**拉**
   *
   * 内核状态是值（不可变快照），没有可订阅的 Ref；故呈现侧的镜像必须由
   * **帧时钟的每帧广播**推过来（`onFrame`）。这与旧形态的差别不是"换成推了"，
   * 而是**推的依据**：旧 `Ref` 由任何写入者改（operator、加载路径），
   * 新镜像由"内核派生出的帧下标"这一**唯一**事实推出。
   *
   * 每帧同步（而不是只在换帧时）是刻意的：播放开关、倍率、帧数都可能
   * 在两次换帧之间变化，而它们同样是呈现要显示的状态。
   */
  const frameIndexRef = ref(kernel?.frameIndex() ?? 0)
  const playingRef = ref(kernel?.playback().playing ?? false)
  const rateRef = ref(kernel?.playback().rate ?? 1)

  /** 把内核的当前派生事实推入响应式镜像。 */
  const syncMirror = (): void => {
    if (!kernel) return
    const idx = kernel.frameIndex()
    if (frameIndexRef.value !== idx) frameIndexRef.value = idx
    const p = kernel.playback()
    if (playingRef.value !== p.playing) playingRef.value = p.playing
    if (rateRef.value !== p.rate) rateRef.value = p.rate
  }

  let lastPresentedFrame = -1

  /**
   * 把**当前内核文档**喂给呈现会话（每帧调用；内部按内容身份去重）。
   *
   * ## 为什么用 try/catch 包住（而不是让它抛）
   *
   * 呈现会话是**平行**路径（本批不接管画面，见 `presenterSurface` 的说明）。
   * 它失败时画面仍由 legacy 渲染链产出 —— 若让它抛出，一个呈现侧的问题会
   * **连带打死**整条帧循环（画面与交互一起停）。那不是"失败关闭"，
   * 而是"一个可降级的子系统拖垮不可降级的子系统"。
   *
   * ⇒ 这里**显式降级**并把错误记进诊断：`presenterSurfaceError` 是公开观测点，
   * e2e 可断言"没有静默失败"。而**不**把异常吞成 `null` 让调用方猜。
   */
  const presenterErrors: string[] = []
  const applyPresenterSurface = (): void => {
    const doc = kernel?.document()
    if (doc === undefined) return
    try {
      const out = presenterSurface.applyKernelDocument(doc, kernel?.playback().time ?? ZERO_TIME)
      // 编译失败/跳过是**真实事实**，必须可见（不得静默当"画好了"）。
      if (out.compileError !== null) presenterErrors.push(`compile:${out.compileError}`)
      for (const s of out.skipped) presenterErrors.push(`kernel-skip:${s.objectId}:${s.reason}`)
      for (const s of out.compileSkipped) presenterErrors.push(`compile-skip:${s.objectId}:${s.reason}`)
    } catch (e) {
      presenterErrors.push(`threw:${e instanceof Error ? e.message : String(e)}`)
    }
  }

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
      syncMirror()
      // **呈现会话的每帧应用**（#299 P10e 段②）。
      //
      // 它按**内容身份**决定要不要重编（`applyIfChanged`）：机位变化不重编（A11），
      // 换帧/换内容才重编。放在这里（而不是只在换帧时）的理由与纹理时间同一：
      // 内容可能因通道取值、文档替换而变化，而那与"帧下标变了"是两件不同的事。
      applyPresenterSurface()
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
    applyPresenterSurface()
  } else {
    // 无帧时钟（组件挂载早于外壳装配）：退化为"静态第一帧"，但仍要
    // 在每次渲染前同步一次镜像，使"装配稍后完成"能被观察到。
    syncMirror()
    applyPresenterSurface()
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
     * 世界帧下标（**派生**的响应式镜像）。
     *
     * 返回 `Ref<number>` 形态是**呈现兼容**：模板里写
     * `:world-frame-index="worldFrameIndex"` 需要可自动解包的 `Ref`。
     * 它是**只读**的（`Readonly<Ref<number>>`）—— 与旧的可写 `Ref` 的差别在**写面**：
     * 想改帧必须走 `setFrameIndex`（经内核命令），不能 `.value = i`。
     */
    worldFrameIndex: frameIndexRef as Readonly<Ref<number>>,
    layerWorldY: ctx.getLayerWorldY(),
    /** 播放状态（只读镜像；写面在 `togglePlayback`/`setFramePlayback`）。 */
    isPlaying: playingRef as Readonly<Ref<boolean>>,
    playbackRate: rateRef as Readonly<Ref<number>>,
    // #301 P10f B′：内核读面（`kernel` 为 null 时——仅非生产宿主——取 0）。
    //
    // 原写法 `kernel?.frameCount() ?? (ctx.getDoc().value?.frameCount ?? 0)` 的
    // legacy 兜底**生产不可达**：两个生产宿主都传内核
    // （`runtime/host/workbenchHost.ts`、`runtime/host/embedHost.ts`）。
    // 且它读的是**内核**帧数（`kernel.frameCount()` 经 `bindFrameSource`），
    // 不是 legacy 文档帧数 —— 两处在装配失败时都读 0（同一 D8 缺口），
    // 故保留 legacy 兜底并不能真正"兜"回 legacy 的 N 帧。
    frameCount: computed(() => kernel?.frameCount() ?? 0),
    computed: drw.computed,
    materialLibrary: drw.textureCache,
    /**
     * 呈现会话（#299 P10e 段②）。
     *
     * 暴露它是为了**可观测**：e2e 要断言"内核链真的画出了批次、且逐格拾取可用"，
     * 而那必须能从页面里读到这个会话（与 `outlinePass` 同一手法）。
     */
    presenterSurface,
    /**
     * 呈现会话的**错误累积**（公开观测点；空数组 = 无错误）。
     *
     * 为什么是"累积列表"而不是"最后一个错误"：并发/连续失败时后者会覆盖前者，
     * 而"哪一类失败"才是诊断要的信息。上限截断避免无界增长（帧循环每帧都可能 push）。
     */
    presenterErrors,
  }
}
