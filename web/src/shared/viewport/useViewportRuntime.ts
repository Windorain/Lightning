import { computed, onScopeDispose, ref, toRef, watch, type Ref } from 'vue'
import type { Context } from '@/runtime/context'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import { cameraMainKeyForRegion } from '@/runtime/mainCameras'
import { DRW } from '@/runtime/drw'
/**
 * **R1-A C10：本文件对 `@/composition/` 的值导入为 0**（接缝
 * `shared-viewport-upward-imports-assembly-root` 的退出判据）。
 *
 * 下面两条都是 **type-only**（不进运行时依赖图，另计）：
 * `PresenterSession` 只用于 `Parameters<...>` 形态推导，
 * `ViewportPresenterBundle` 是宿主注入面的形状。实现由装配边
 * （`runtime/host.ts#HostBase#createViewportPresenter`）构造后下行。
 */
import type { PresenterSession } from '@/composition/presenterSession'
import type { ViewportPresenterBundle } from '@/runtime/host'
import { attachViewportDeviceEvents } from '@/runtime/deviceEvents'
import { createDomTextureDecoder } from '@/adapters/textureDecode'
import { animationSpecKey } from '@/domain/textureAnimation'
import type { ContentResource } from '@/domain/content'
// 中立设施（`kernel-legacy-isolation.test.ts` 的中立清单含 `logging`）：实时状态槽是
// 状态栏的读面来源，不是"旧权威对象"。
import { LOG_LEVEL, type LogLevelValue } from '@/logging/LogCenter'

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

/**
 * **呈现链失败的上报器**：有界去重 + **有界**丢弃上报（R5-0 ② 的落点）。
 *
 * ## 为什么去重（动机）
 *
 * 结构化上报的落点（`ctx.wm.diagnostics`）是**共享**的有界环形缓冲（容量 512），
 * 而呈现链的错误是在**帧循环**里产生的：逐帧记账会把其它通道的记录挤掉。
 * 故同一"失败签名"每实例只上报一次（首现上报）。
 *
 * ## 为什么要给去重**自己**一个有界（R5-0 ② 修的缺陷）
 *
 * 去重的动机是保护**有界**缓冲，而其初版集合**无界**：签名里带 `detail`，
 * 而 `detail` 承载自由文本（异常 `message`、`out.compileError`）⇒ 错误信息若
 * 逐帧变化，集合只增不减、没有容量上限、也没有任何判据能看见它。
 * **观测设施自己不得成为泄漏源**，故：
 *
 *  1. 签名数封顶 `PRESENTER_FAILURE_SIGNATURE_MAX`；
 *  2. 签名里的 `detail` 截断到 `PRESENTER_FAILURE_DETAIL_MAX` —— 否则 256 条签名
 *     可以各自长到任意长，"有界"只是假的（内存由"条数 × 单条长度"共同决定）；
 *  3. 超限**不是静默丢弃**：丢弃经 `report`（`kind === 'dropped'`）上报，
 *     读面可按 `dropped === true` 单独查询 —— 而丢弃上报本身也必须有界（见下）。
 *
 * ## 丢弃上报为什么是"≤8 次逐次 + 此后 2 的幂"
 *
 * 有界缓冲 + 追加语义下，"每丢一次就记一条"**正是**去重要防的那件事（挤掉别的通道）；
 * 而"精确到个位的累计丢弃数"在有界记录器里**不可表达**（那是无界状态）。
 * ⇒ 折中口径：前 8 次逐次精确上报，其后按 2 的幂（`1,2,…,8,16,32,…`）上报，
 * 故 N 次丢弃至多产生 `8 + ⌈log₂(N/8)⌉` 条记录
 * （60 fps 跑满 24h ≈ 5.2M 次丢弃 ⇒ 27 条；**记录数随 N 对数增长**，不是逐次）。
 * 读面因此能回答三件事：丢弃**确实发生了**、**哪个 reason** 在溢出、**量级**多大；
 * 代价是第 8 次之后读数与真值的偏差 ≤2×（已登记为残留，见交付报告）。
 *
 * ## 截断口径必须与记录器一致
 *
 * `application/diagnostics#sanitizeParams` 在**写入时**把字符串值截到
 * `PARAM_VALUE_MAX = 200` 再补 `…`。签名若用**全长**，两条只在第 200 字符后不同的
 * `detail` 会被判"不同"而各记一次 —— 而读面看到的 `params.detail` **逐字节相同**，
 * 于是同一条事实在账上出现两次、人却看不出区别。故签名与记录器**同口径**截断。
 *
 * ⚠️ 本文件属旧层 `shared/`，**不** import `@/application/diagnostics#PARAM_VALUE_MAX`
 * （同 `ZERO_TIME` 那段：旧层→新内核的导入要登记，而这里需要的只是一个数）。
 * 两个数的等值由 `__tests__/presenterFailureBound.test.ts` 断言钉住，防口径漂移。
 *
 * `report` 是上报设施与决策的**解耦点**：本函数是纯的（不 import 新层类型、
 * 不读时钟、不碰 DOM），故可被单测直接驱动（构造逐帧变化的 `message` 即为其负对照）。
 */

/** 去重签名的条数上限（见上方说明：去重不得自己无界）。 */
export const PRESENTER_FAILURE_SIGNATURE_MAX = 256

/** 签名里 `detail` 的截断长度（必须等于 `application/diagnostics#PARAM_VALUE_MAX`）。 */
export const PRESENTER_FAILURE_DETAIL_MAX = 200

/** 一次上报（"真实失败"与"因容量上限被丢弃"共用同一形状，用 `kind` 区分）。 */
export interface PresenterFailureReport {
  /** `'failure'` = 一次真实失败；`'dropped'` = 因容量上限被丢弃的失败。 */
  readonly kind: 'failure' | 'dropped'
  /** 失败原因（`'dropped'` 时是**被丢那次**的原因，便于定位谁在溢出）。 */
  readonly reason: string
  /** 详情（`'failure'` 时已截断）；`'dropped'` 时是当时的累计丢弃数。 */
  readonly detail: string
  /** 关联对象身份（无关联时为 `null`）。 */
  readonly objectId: string | null
}

export interface PresenterFailureReporter {
  /** 记一次失败（首现上报；超限则计入丢弃并在上报点上报）。 */
  readonly emit: (reason: string, detail: string, objectId?: string) => void
  /** 当前去重签名数（**恒** ≤ `PRESENTER_FAILURE_SIGNATURE_MAX`；判据面）。 */
  readonly signatureCount: () => number
  /** 因容量上限被丢弃的不同签名数（累计；判据面）。 */
  readonly dropCount: () => number
}

/** 签名分隔符（NUL：不出现在 reason / objectId / 常规 `detail` 文本里，避免拼接歧义）。 */
const PRESENTER_FAILURE_SEP = String.fromCharCode(0)

export function createPresenterFailureReporter(
  report: (report: PresenterFailureReport) => void,
): PresenterFailureReporter {
  const signatures = new Set<string>()
  let drops = 0
  /** 下一次**必然**上报的丢弃数：≤8 逐次（`+1`），其后翻倍 ⇒ 记录数对数增长、不会退化成逐次。 */
  let nextDropReportAt = 1
  return {
    emit(reason, detail, objectId) {
      const bounded =
        detail.length > PRESENTER_FAILURE_DETAIL_MAX
          ? `${detail.slice(0, PRESENTER_FAILURE_DETAIL_MAX)}…`
          : detail
      const signature =
        objectId === undefined
          ? `${reason}${PRESENTER_FAILURE_SEP}${bounded}`
          : `${reason}${PRESENTER_FAILURE_SEP}${objectId}${PRESENTER_FAILURE_SEP}${bounded}`
      if (signatures.has(signature)) return
      if (signatures.size >= PRESENTER_FAILURE_SIGNATURE_MAX) {
        drops += 1
        if (drops >= nextDropReportAt) {
          report({ kind: 'dropped', reason, detail: String(drops), objectId: objectId ?? null })
          nextDropReportAt = drops < 8 ? drops + 1 : drops * 2
        }
        return
      }
      signatures.add(signature)
      report({ kind: 'failure', reason, detail: bounded, objectId: objectId ?? null })
    },
    signatureCount: () => signatures.size,
    dropCount: () => drops,
  }
}

export interface UseViewportRuntimeOptions {
  ctx: Context
  regionId: string
  viewerPrefs: ViewerPreferences
  blockIconCacheOptions?: BlockIconCacheOptions
  initialWorldFrameIndex?: number
  /**
   * **渲染视图文档**（必填；由 `useKernelChannels().renderDoc` 提供）。
   *
   * ## 为什么是必填（R1-β① C5 的改写点）
   *
   * 原形态是 `docOverride?: Ref<RuntimeDocument|null>`，缺省时回落
   * `ctx.legacyRenderSource()` —— 那是接缝 `legacy-render-source-document` 的落点。
   * C5 按 #385 评论 7140（「永远是消费者适应新的内核」）**删除该回落**：
   *
   *  - 生产里**两个**调用方（`EmbedViewport.vue`、`workbench/components/WorkbenchViewport.vue`）
   *    **都**传了它 ⇒ 回落分支是**死码**，而"死码"在结构上仍是一条可被重新想起的旁路
   *    （改天有人省略参数就悄悄退回旧文档，且没有任何判据会响）；
   *  - 改成必填后，"渲染源从哪来"在**类型层**只有一个答案：调用方必须显式给出。
   *
   * ⚠️ **它不是画面源**（R1-β① C8 起）：它只喂**定义面**（结构定义/材质库/图标缓存）。
   * 画面由 `PresenterSession` 从**内核文档**产出（见下方 `presenterSurface`）。
   * 这条"旧格式视图文档仍被 DRW 读"的剩余边登记在 `composition/seams.ts` 的
   * `legacy-render-source-document`（画面终切已完成；定义/图标面的迁移归 R2/R3）。
   */
  renderDocRef: Ref<RuntimeDocument | null>
  /**
   * **呈现会话包的构造（必填注入；R1-A C10）**。
   *
   * ## 为什么是必填（与 `renderDocRef` 同形）
   *
   * 原形态是本文件 `import { PresenterSession } from '@/composition/presenterSession'`
   * 并**就地 `new`** —— 那是"视口向上 import 装配根"，正是接缝
   * `shared-viewport-upward-imports-assembly-root` 要退役的方向（#387 评论 7292：
   * 优先"注入"而不是"视口向上 import 装配根"）。
   *
   * 改成必填后，"呈现会话从哪来"在**类型层**只有一个答案：调用方必须显式给出
   * （两个生产调用方都经 `host.createViewportPresenter(regionId)` 提供）。
   * 省略即类型错误 ⇒ 不存在"悄悄退回就地构造"的旁路。
   *
   * 生命期仍归**本 composable**（`onScopeDispose` 调 `bundle.dispose()`）：
   * 构造位置搬走了，"谁负责释放"没有变。
   */
  createPresenter: (regionId: string) => ViewportPresenterBundle
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
  const { ctx, regionId, viewerPrefs, blockIconCacheOptions = {}, initialWorldFrameIndex, renderDocRef, createPresenter } = opts
  const vpSlot = ctx.viewports.get(regionId) ?? ctx.viewports.register(regionId)
  // R1-β① C5：渲染源是**必填注入**（原 `docOverride ?? ctx.legacyRenderSource()` 的
  // 回落已删 —— 见 `renderDocRef` 的说明）。本处不再有"省略参数就退回旧文档"的路径。
  const docRef = renderDocRef

  /**
   * **内核渲染源面**（G4 · S2 第二半）：DRW 的定义 / 说明池 / 材质库输入三样由内核直出。
   *
   * 为什么在这里构造（而不是让 `.vue` 调用方再传一个 prop）：本 composable 已经持有
   * `ctx`，面是**读面**（`Context#kernelRenderSourceFace`）—— 多一条注入 prop 只会
   * 让装配边多一个可省略的口子（"省略即回落"正是 C5 删掉的那种形态）。
   *
   * 面在场 ⇒ DRW 不再读 `docRef` 的这三样；`docRef` 只留给多方块的再装配投影
   * （G3 落地前已登记的暂存路径）与内容身份。
   *
   * ## ⚠️ 这里**故意不**写类型标注（不许再 import 装配根的类型）
   *
   * 接缝 `shared-viewport-upward-imports-assembly-root` 把本目录 → `@/composition/**`
   * 的 **type-only 残余逐字钉住恰 1 条**（值导入/动态导入皆 0）。加一条 `import type
   * { KernelRenderSourceFace } from '@/composition/…'` 就让残余变 2 ⇒ 判据判红
   * （`web/tests/architecture/shared-viewport-upward-import-closure.test.ts`）。
   * ⇒ 面的类型由 `Context#kernelRenderSourceFace()` 的**返回值推断**得到：
   * 端口形状归 Context 这一层（本目录可向下 import `@/runtime/**`），
   * 既不需要向上 import，也不在本目录另立一份"最小结构类型"（那会成为第二份形状、
   * 与真类型漂移）。
   */
  const renderSourceRef = computed(() => ctx.kernelRenderSourceFace())

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

  /**
   * **呈现会话包**（R1-A C10：由装配边构造后下行；见 `createPresenter` 的说明）。
   *
   * 它是本视口的**画面生产者**（C8 起）与纹理端口（C5/D3）的同一处来源：
   * `presenterSurface` 产出画面，`presenterTextures` 管 GPU 句柄账，
   * 两者同生共死（`bundle.dispose()`）。
   */
  const presenterBundle = createPresenter(regionId)
  const presenterTextures = presenterBundle.textures
  /** DOM 侧解码器（端口实现；非浏览器环境下 `decode` 如实返回 `null` ⇒ 资源记 `failed`）。 */
  const textureDecoder = createDomTextureDecoder()

  const drw = new DRW({
    docRef,
    renderSourceRef,
    contentRefreshTickRef: ctx.getContentRefreshTick(),
    // 帧下标：派生值（无会话 ⇒ 恒 0，即静态第一帧）。
    worldFrameIndex: () => kernel?.frameIndex() ?? 0,
    layerWorldY: ctx.getLayerWorldY(),
    structureDefinition: vpSlot.definition,
    blockIconCacheOptions,
    initialWorldFrameIndex,
    // 换帧 = 定位时间（**不**写帧下标）。
    seekFrame: (i) => kernel?.seekFrame(i),
    /**
     * **未装配 ⇒ 换帧不可用的上报**（R2/S3）。
     *
     * ## 为什么是"既有通道 + 既有判别式"
     *
     * 立项单两面都写着："未恢复入口**显式不可用**，不自动回落" ＋ "**不静默丢弃**、
     * 填空、伪造成功"。判别式由管线给出（**就是**它自己的那条守卫：
     * `!doc || doc.frameCount === 0`），这里只把事实写进**已经存在**的记录器
     * —— `ctx.wm.diagnostics`（读面 `Context.getDiagnostics()`，e2e 经 `__vm__` 取证），
     * 写法照 `runtime/contentDiagnostics.ts:59` 与下方呈现链失败上报（同一通道、同一形状）。
     *
     * ## 码与判别式（**不自行扩码表**）
     *
     * 既有 22 码里没有"换帧不可用"这一族，最贴近的是 `command.unsupported`
     * （命令在当前状态下不可执行）⇒ 本处用**既有码**，判别式用两个既有事实：
     * `params.reason`（管线给的 reason）与 `params.contentAdopted`
     * （`Context#hasAdoptedContent()` —— GF-16 的**既有**判别式，不另立判定）。
     * **新码请求**（更精确的码，如 `frame.changeUnavailable`）在交付报告里列出交由裁决，
     * 不在这里悄悄加码。
     */
    onFrameChangeUnavailable: (report) => {
      ctx.wm.diagnostics.record({
        channel: 'command',
        code: 'command.unsupported',
        params: {
          source: 'drw.setCurrentWorldFrame',
          reason: report.reason,
          frame: report.index,
          contentAdopted: ctx.hasAdoptedContent(),
        },
        correlation: {},
      })
    },
    // 播放状态是**读面**：本层不驱动任何调度（帧时钟归外壳）。
    isPlaying: () => kernel?.playback().playing ?? false,
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
   * **呈现会话**（#299 P10e 段② 建立；R1-β① C8 起是**画面**的唯一生产者）。
   *
   * ## 它替代的旧机制
   *
   * `BatchedPresenter` 在本批之前**零生产调用方**（只被 e2e 探针与单测驱动）
   * —— 于是"内核场景 → `PresentationInputs` → `compileScene` → presenter → 屏幕"
   * 这条链在**判定面上绿**、在**生产上不存在**（P10c/P10d 反复实测的缺口形态）。
   * 本会话就是那个缺失的生产消费者。
   *
   * ## C8 之后它接管了画面（不再是平行路径）
   *
   * 旧形态：`DRW`（`blockMeshProvider` → legacy `blockMesh`）是**画面**的生产路径，
   * 本会话平行存在且**不挂进**场景树（注解/描边对象建了但看不见）。
   * C8 把两头一起改：`vpSlot.contentGroup` 指向本会话的 `object3d`（见下），
   * 而 `drwMeshPipeline` 的网格产出被删除。⇒ 画面 = 内核求值产物。
   *
   * 仍**并存**的是**定义面**（结构定义/材质库/图标缓存经旧格式视图文档解析，
   * 接缝 `legacy-render-source-document` 的剩余边，归 R2/R3）。
   *
   * ## 挂载点与释放
   *
   * 根对象由本 composable 交给视口结构层（`vpSlot.contentGroup.value`），
   * 生命期与 `onScopeDispose` 对齐（dispose + 解引用，见下）。
   */
  const presenterSurface = presenterBundle.surface
  vpSlot.presenterSurface = presenterSurface
  /**
   * **画面接管**（R1-β① C8 第 1 项；#387 7298）。
   *
   * ## 这一行就是"画面由内核呈现根产出"的落点
   *
   * `vpSlot.contentGroup` 是**视口结构层在场景树里的挂载点**：
   *
   * ```
   *  RenderEngineHost → RenderEngine.mount(contentGroup = vpSlot.contentGroup)
   *      ⇒ drawFrame(): layers.structure.add(opts.contentGroup)   // 进场景树
   * ```
   *
   * 旧实现把它指向 `DRW` 的 legacy 网格（`drwMeshPipeline` 的 `mainMeshGroup.value = result.group`）；
   * C7 之前本会话的 `object3d` **从未** `.add(` 进任何场景树（`presenterSurface` 是个平行路径，
   * 画面仍由 legacy 网格产出）。C8 把这两件事**同时**改掉：
   *
   *  - 本行把呈现根交给视口结构层；
   *  - `drwMeshPipeline` 里写 `mainMeshGroup` 的那两处**已删除**（无第二生产者）。
   *
   * ## 为什么挂在 `contentGroup` 而不是另起一个层级
   *
   * `contentGroup` 同时是**相机取景**（`viewportCameraApply` 按它的包围盒夹裁剪面）
   * 与 e2e 观测（`slot.contentGroup` 是公开字段）的读面。另起一级会让"相机取景围着
   * 谁"和"谁画了画面"重新分家 —— 而它们必须围着**同一份**几何。
   *
   * ## 生命周期
   *
   * 挂在会话的 `object3d` 上 ⇒ 下面的 `onScopeDispose` 一次 `dispose()` 同时释放
   * GPU 份额与（由 RenderEngine 的重挂逻辑）场景挂载。
   */
  vpSlot.contentGroup.value = presenterSurface.object3d
  /** 上次同步给呈现会话的注解身份（文档版本 + 视口可见性）。 */
  let lastAnnotationIdentity: string | null = null
  onScopeDispose(() => {
    // 卸载即释放（A19：视口关闭不泄漏 GPU 份额；两个视口共享源数据时
    // 关其一不破坏另一方 —— 设备作用域按 region 分，故账天然分开）。
    //
    // R1-A C10：会话与纹理端口的**创建**搬到了装配边（`HostBase#createViewportPresenter`），
    // 但**释放**仍归本作用域 —— `bundle.dispose()` 是"创建与释放同源"的落点，
    // 调用方不可能只释放其中一个。
    // #399：本标志此前**只读不写**（恒为 false ⇒ "卸载后不写"的守卫是空的）。
    // 卸载后不得再写实时状态/纹理同步结果：没有消费者，且会改写共享状态栏。
    texturesDisposed = true
    ctx.log.clearLiveStatus()
    presenterBundle.dispose()
    if (vpSlot.presenterSurface === presenterSurface) vpSlot.presenterSurface = null
    // 结构层指向已释放的呈现根会让"卸载后仍有对象在场景里"（幽灵挂载）——
    // 只有确实是**本会话**的根才清（避免抹掉重挂后新会话写下的值）。
    if (vpSlot.contentGroup.value === presenterSurface.object3d) vpSlot.contentGroup.value = null
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
   * C8 之后呈现会话**就是画面**，它失败时画面不再有 legacy 兜底 ——
   * 若让它抛出，一个呈现侧的问题会**连带打死**整条帧循环（画面与交互一起停）。
   * 那不是"失败关闭"，而是"一个可降级的子系统拖垮不可降级的子系统"。
   *
   * ⇒ 这里**显式降级**并把错误记进诊断：`presenterErrors` 是公开观测点，
   * e2e 可断言"没有静默失败"。而**不**把异常吞成 `null` 让调用方猜。
   */
  const presenterErrors: string[] = []

  /**
   * **R5-0 ①：呈现链错误的结构化发射点**（既有诊断通道，不新造体系）。
   *
   * ## 为什么必须有它（修的是一个**活跃假绿**）
   *
   * `presenterErrors` 在生产里被写、被返回，但**全 `web/src` 零消费者**：两个宿主
   * （`EmbedViewport.vue` / `WorkbenchViewport.vue`）的解构都不取它，e2e 又硬编码
   * `presenterErrors: []` ⇒ "呈现链没有错误"这条断言**恒真**，掩盖了这条链真实产生的
   * 全部错误。可观测性的唯一判据是"能按码/按关联查询"，而那个读面**已经存在**：
   * `ctx.wm.diagnostics`（读面 `Context.getDiagnostics()`，e2e 经 `__vm__.getDiagnostics()`
   * 取 `byCode()`/`byCorrelation()`）。故这里把那 9 处 `push` 的**同一事实**再发一份进既有
   * 记录器 —— 形态照 `runtime/contentDiagnostics.ts:59` 的
   * `recorder.record({ channel, code, params, correlation })`。
   *
   * ## 码与通道的现状（**不自行扩码表**）
   *
   * 既有 22 码里没有"呈现链失败"这一族，最贴近的是 `effect.failed`（效果生命周期失败）
   * ⇒ 本批先用既有码 + `params.source === 'presenter'` 区分；**新码请求**在交付报告里
   * 列出交由裁决，不在这里悄悄加码。
   *
   * ## ⚠️ 为什么**不** import 任何东西
   *
   * 本文件在 `shared/`（旧层）：加 `@/runtime`、`@/domain` 的**值**导入会撞接缝
   * `kernel-legacy-isolation`（见本文件头 `ZERO_TIME` 那段，同一坑已实测红过）。
   * 记录器从 `ctx.wm.diagnostics` **现取**，故零新增导入。
   *
   * ## 去重：保护**有界**缓冲，不改 push 语义
   *
   * `presenterErrors.push` 逐帧执行（数组行为**本批不动**），而记录器是容量 512 的**共享**
   * 环形缓冲：逐帧记账会把其它通道的记录挤掉。故同一"错误签名"每实例只记一次
   * （首现上报；与 `contentDiagnostics` 的"按批次聚合"同一动机）。
   *
   * ## R5-0 ②：去重**自己**也必须有界（缺陷修复，不是优化）
   *
   * 上一条的动机是保护**有界**缓冲，而初版集合**无界**（`detail` 承载自由文本，
   * 帧循环里逐帧变化 ⇒ 只增不减、零容量上限、零判据可见）。去重/截断/丢弃上报的
   * 全部口径收在 `createPresenterFailureReporter`（上方模块级函数）里，
   * 此处只做"决策 → 记录器"的**形状适配**（零新增 import：记录器仍从
   * `ctx.wm.diagnostics` 现取）。
   */
  const { emit: emitPresenterFailure } = createPresenterFailureReporter((r) => {
    ctx.wm.diagnostics.record({
      channel: 'effect',
      code: 'effect.failed',
      params:
        r.kind === 'failure'
          ? { source: 'presenter', reason: r.reason, detail: r.detail }
          : // 丢弃**不静默**：多带一个 `dropped` 标量供读面单独查询；
            // `detail` 是当时的累计丢弃数（见 `createPresenterFailureReporter`）。
            { source: 'presenter', reason: r.reason, detail: r.detail, dropped: true },
      correlation: r.objectId === null ? {} : { objectId: r.objectId },
    })
  })

  /**
   * **材质统一：内核内容资源 → 纹理端口 → 材质绑定**（#301 P10f D3；R1-β① C5）。
   *
   * ## 为什么必须有这条链（它修的是一个**可感知**的回退）
   *
   * 呈现会话此前创建时**不传** `textures` ⇒ `presentation/presenter#createMaterial` 的
   * `textures !== undefined` 短路 ⇒ `params.map` 永不设置 ⇒ 呈现画面只有中性色
   * （legacy 链有贴图）。这正是"画面终切被阻塞"的实质原因之一（接缝
   * `presenter-surface-dual-track` 的（甲）前置「材质统一」）。
   *
   * ## 顺序（是判据的一部分，反了会静默变平）
   *
   * 1. 解码五态：`textureResourcesOf`（坏一张只坏那一张；**不** Promise.all）；
   * 2. 上传：`presenterTextures.sync`（同身份复用、消失即释放）；
   * 3. 绑定：`presenterSurface.bindTextures`（唯一绑定生产点 + 触发按新绑定重建）。
   *
   * ## 为什么是异步且带序号（取消语义）
   *
   * 解码是异步的，而帧循环每帧都会调它 ⇒ 必须有**取消**：只允许**最新**一次
   * 同步落地（`seq` 比对）。否则旧的一次解码在换文档后回来，会把已换掉那批
   * 纹理重新绑上（画面停在上一个文档的贴图，且没有任何报错）。
   */
  let textureSyncSeq = 0
  let texturesDisposed = false

  /**
   * 纹理生命周期的**实时状态写点**（#399 缺陷 B 的修复落点之一）。
   *
   * ## 与「编辑拒绝可见」（M4-3 R2）共用同一个槽：写序与覆盖关系
   *
   * 本链写 `origin: 'texture'`，拒绝链写 `origin: 'rejection'`。两者**互不清理**：
   *  - 纹理链按**内容身份**去重（`identity === lastTextureIdentity` ⇒ 直接返回），
   *    所以加载完成后不会每帧重写；此后若发生一次编辑拒绝，底栏就停在拒绝文案上
   *    —— 那是正确的：拒绝是**更晚**的事实。
   *  - 反之，纹理资源身份变化（换文档/换资源）时纹理链会**覆盖**拒绝文案：
   *    那也是正确的：资源生命周期重新开始时，「正在加载」比一条旧拒绝更该显示。
   *  - 成功提交只清 `origin === 'rejection'` 的那一条（`clearRejectionStatus`），
   *    **不**动纹理结论 —— 否则一次写成功会把「纹理就绪 4/4」永久抹掉
   *    （纹理链不会自动重写它）。
   *
   * ## 为什么写 `liveStatus` 而不是既有的 `ctx.log.setStatus`
   *
   * `setStatus` 在当前状态栏被 `lastDisplayable` **永久遮蔽**：任一非 DEBUG 日志写过之后，
   * 状态栏就恒显示「初始化视口相机 → FINISHED」，而唯一能清它的 `LogCenter.clear()` 全树零调用。
   * ⇒ 只调 `setStatus` 的修法会「改完了但屏幕没变」（#399 分诊 §2.1 的暗坑）。
   * `liveStatus` 是独立槽，状态栏为它保留了最高渲染优先级与 `data-texture-state` 读面。
   *
   * ## 为什么不必在这里去重
   *
   * 本链由 `applyPresenterSurface` **每帧**调用；去重放在 `LogCenter.setLiveStatus` 的
   * 唯一入口（同值不写 ref），比每个调用方各记一份「上一条」更不易漏。
   *
   * ## 为什么卸载后不写
   *
   * 卸载后的写入没有消费者，却会让已关闭的视口继续改写共享状态栏。
   */
  const writeTextureLive = (
    message: string,
    state: 'loading' | 'ready' | 'missing' | 'failed',
    level: LogLevelValue = LOG_LEVEL.INFO,
  ): void => {
    if (texturesDisposed) return
    ctx.log.setLiveStatus(message, level, state, 'texture')
  }

  /**
   * 纹理装配的耗时标记（#399 步骤 6）：只登记、不参与判定。
   *
   * 读数面 =
   * `performance.getEntriesByName('texture-sync:decode' | 'texture-sync:bind' | 'texture-sync:total')`
   * —— 白模期墙钟由 `total` 给出，解码/上传绑定各占多少由前两者拆开（同机同夹具对照）。
   * 标记缺失/`performance` 不可用时全部静默跳过：测量是旁路，不得改变装配行为。
   */
  const perfMark = (name: string): void => {
    if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return
    try {
      performance.mark(name)
    } catch {
      // 测量是旁路（标记缓冲写满等），不影响装配。
    }
  }
  const perfMeasure = (name: string, startMark: string, endMark: string): void => {
    if (typeof performance === 'undefined' || typeof performance.measure !== 'function') return
    try {
      performance.measure(name, startMark, endMark)
    } catch {
      // 标记不存在（例如在解码前就取消）⇒ 不测量，也不抛。
    }
  }
  /**
   * 上次**成功**同步所用的资源独立身份（`assetId@contentVersion` 串）。
   *
   * ## 为什么必须有它（本批 e2e 实测的缺陷）
   *
   * `applyPresenterSurface` 在**帧循环里每帧**调用，于是同步也每帧启动一次；
   * 而取消判据是 `seq !== textureSyncSeq` ⇒ 下一帧把上一帧**在途**的解码结果作废。
   * 若一次解码（4 张 1×1 PNG 的 `createImageBitmap` + `getImageData`）长于一帧，
   * 落地那一行**永远不会执行**：资源永远 `ready`、绑定表永远为空、画面永远无贴图，
   * 而且**没有任何报错**（`missingRequired` 也是 0，因为绑定从未产出）。
   * 实测：真实夹具 4 张资源在浏览器里全部 `ready` 且有像素，而挂载材质 `map` 全为 null。
   *
   * 正解 = 与 `PresenterSession.applyIfChanged` **同一纪律**：按**内容身份**去重
   * （资源表没变就不重解码、不重绑定 —— A11「不动就不算」同族）。
   * `seq` 取消判据保留，负责"换文档时旧解码不得落地"。
   */
  let lastTextureIdentity: string | null = null
  /**
   * **资源失败重试**（M8-5 / D6；SPEC §7.4:252「重试建立新的请求，旧请求不得覆盖它」）。
   *
   * ## 为什么入口在 `Context`、执行在这里
   *
   * 发起者可能是底栏按钮/命令（它们只认得 `Context`），而**执行**只可能在这里 ——
   * 只有本环持有解码器、纹理端口与取消序号。`Context#requestResourceRetry()` 是
   * 两者之间唯一的请求槽（自增计数 + 监听器，见那里的说明）。
   *
   * ## 一次重试 = 一次**新请求**
   *
   * 落地的两件事：①把去重键作废（否则"同一份资源"会直接早退，等于没重试）；
   * ②把 `attempt` 加一并发 `resource.retryRequested`（新请求的序号进诊断）。
   * 旧的在途解码由既有的 `seq !== textureSyncSeq` 判据作废 —— 不新增取消机制。
   */
  let retryAttempt = 0
  let pendingRetry = false
  /**
   * 上次结算里**失败**的资源名（重试请求的**点名**用；有界 = 资源条数）。
   *
   * locator 优先（有取回位置就报取回位置，否则报 assetId）—— 与状态栏文案、
   * `resource.failed` 的 `params.locator`/`params.assetId` 同一口径：
   * 诊断里的名字要能被**用户在底栏看到的那个名字**对上（D7）。
   */
  let lastFailedNames: string[] = []
  const stopResourceRetryWatch = ctx.onResourceRetry(() => {
    pendingRetry = true
    // 去重键作废：失败后同身份不会自动重试（这正是 D6 的成因），重试必须显式破键。
    lastTextureIdentity = null
    inFlightTextureIdentity = null
  })
  onScopeDispose(() => {
    stopResourceRetryWatch()
  })

  /**
   * **在途**同步的资源身份。
   *
   * ⚠️ 只记"已完成"的去重**不够**（本批 e2e 实测第二次仍全无贴图）：帧循环每帧进本函数，
   * 而 `seq` 判据会把上一帧**在途**的解码作废 ⇒ 每一次都活不到落地那一行。
   * 记在途身份使"同一份资源的第二次调用直接返回"，在途那一次才可能真正落地。
   */
  let inFlightTextureIdentity: string | null = null
  /**
   * 纹理同步的**去重键**：资源内容身份 + **动画声明**。
   *
   * 只拼 `assetId@contentVersion` 会漏掉"字节没变、播放速度/帧序变了"：
   * mcmeta 声明改而像素不变时不会重同步 ⇒ 绑定表里还是旧序列 ⇒
   * "改了播放速度不生效"（且没有任何报错）。声明键是纯函数
   * （`domain/textureAnimation#animationSpecKey`），不是派生后的序列 ——
   * 多一次重建是安全的，少一次不是。
   */
  const textureIdentityOf = (doc: { readonly content: { readonly resources: readonly ContentResource[] } }): string =>
    doc.content.resources.map((r) => `${r.ref.assetId}@${r.ref.contentVersion}#${animationSpecKey(r.animation)}`).join('\u0001')
  const syncPresenterTextures = async (): Promise<void> => {
    if (texturesDisposed) return
    const doc = kernel?.document()
    if (doc === undefined) {
      // 文档已关闭：实时状态不得残留上一份文档的成品结论（SPEC §7.4：状态由**当前**事实推导）。
      ctx.log.clearLiveStatus()
      // 失败清单同理：下一份文档的"恢复"不得拿上一份的身份对账。
      lastFailedNames = []
      return
    }
    const identity = textureIdentityOf(doc)
    // 已同步过 / 正在同步同一份资源 ⇒ 不重解码、不重绑定（否则帧循环会把在途解码反复作废）。
    if (identity === lastTextureIdentity || identity === inFlightTextureIdentity) return
    const total = doc.content.resources.length
    if (total === 0) {
      // 没有资源可报 ⇒ 不写「0/0」这种假进度，也不让上一份文档的结论留着。
      ctx.log.clearLiveStatus()
      return
    }
    inFlightTextureIdentity = identity
    const seq = ++textureSyncSeq
    // 显式重试 ⇒ 本次是**新请求**：先记请求事实（哪怕随后解码抛错，请求也真实发生过），
    // 再按同一套流程走。旧请求的结果由下面的 `seq` 判据作废（不静默覆盖）。
    if (pendingRetry) {
      pendingRetry = false
      retryAttempt += 1
      presenterBundle.resources.reportRetryRequested({
        viewportId: regionId,
        failed: lastFailedNames,
        attempt: retryAttempt,
      })
    }
    // 起点：加载中 0/total。相位与计数都取自**本次请求的事实**（不是计时器猜测）。
    writeTextureLive(`纹理加载中 0/${total}`, 'loading')
    perfMark(`texture-sync:${seq}:start`)
    try {
      const resources = await presenterBundle.textureResourcesOf(
        doc.content.resources,
        textureDecoder,
        (p) => {
          // 取消/卸载后不写：过期批次不得覆盖新批次的进度（与下面的 seq 判据同一条纪律）。
          if (seq !== textureSyncSeq || texturesDisposed) return
          writeTextureLive(`纹理加载中 ${p.done}/${p.total}`, 'loading')
        },
      )
      perfMark(`texture-sync:${seq}:decoded`)
      // 取消：更新的同步已开始（或有更新的文档）⇒ 本次结果作废，**不**落地。
      if (seq !== textureSyncSeq || texturesDisposed) return
      const synced = presenterTextures.sync(resources)
      const bound = presenterSurface.bindTextures(resources)
      // **图标材质库的像素来源**（M8-5）：把**已解码**的槽位交给 DRW。
      //
      // 解码只发生在上面的 `textureResourcesOf`（唯一链）；DRW 拿到的是像素，
      // 于是"一张坏图"不可能让图标库整库失败（旧 `buildMaterialLibrary` 的
      // `Promise.all` 形态已删除）。`materialId` 用**下标字符串** —— 与
      // `listPaletteTextureDataUrls` 的槽位口径一致（见 `materialLibraryFromTextures`）。
      //
      // 只在 `ready` 且带像素时交出：未就绪的槽缺失 ⇒ 该材质图标落占位（Q1 同族降级）。
      drw.applyDecodedTextures(
        resources.flatMap((r, index) =>
          r.state === 'ready' && r.pixels !== null
            ? [{
                materialId: String(index),
                width: r.pixels.width,
                height: r.pixels.height,
                rgba: r.pixels.rgba,
                name: `${r.identity.id}@${r.identity.version}`,
              }]
            : [],
        ),
      )
      perfMark(`texture-sync:${seq}:bound`)
      lastTextureIdentity = identity
      // 终态（#399）：以**绑定事实** `missingRequired` 优先 —— 「解码成功」不等于「显示就绪」
      // （SPEC §7.4：原始字节/解码结果/设备绑定并不等价；占位不得冒充完整结果）。
      // 三条文案是 e2e 的锚点：加载中 n/total、就绪 n/n、缺失|失败 k/total。
      //
      // ⚠️ 计数单位必须与分母一致：`total` 是**资源**条数，故 k 也是资源条数。
      // `bound.missingRequired` 数的是**绑定**（材质）条数（`presenterSession.bindTextures`），
      // 同一张纹理可被多个材质引用 ⇒ 拿它当分子会得到「缺失 3/57」这种跨单位读数。
      // 它只用来判定「缺的是必需贴图」与否（语义），数量取未就绪资源条数。
      //
      // 「缺失范围可辨认」（SPEC §7.4）：计数之外再点名**哪几张**（有界：最多 2 条，单条截断到
      // 28 字符）。locator 是给用户的取回位置（如 `gregtech:iconsets/GODFORGE_TRIM`），为空时
      // 退回 assetId —— 绝不只报一个孤零零的数字让人去翻日志。
      // 注意：这里**不早退** —— 下面的 `missingRequired` / `readyWithoutPixels` 诊断必须照旧上报。
      const notReadyResources = resources.filter((r) => r.state !== 'ready' && r.state !== 'unrequested')
      const notReady = notReadyResources.length
      /**
       * **未请求**的资源（`payload === null`：外链条目）。
       *
       * ## 为什么它必须参与终态（M8-5 / S0-B D8）
       *
       * `unrequested` 的语义是"**还没**请求"（不是"缺失"也不是"失败"），所以它不进
       * `notReady` —— 那是五态模型的口径，不动。但**界面所称"显示完成"必须对应必要资源
       * 已经可呈现**（SPEC §7.4:254「占位不能冒充完整结果」）。
       *
       * 本产品的取回是宿主端口的职责，而**生产里没有外链取回路径**（内核资源都由文档内嵌
       * 字节承载）⇒ 一条 `payload === null` 的资源**永远**停在 `unrequested`。
       * 旧实现在这种情况下照样报「纹理就绪 n/n」—— 那是**假就绪**（D8）：
       * 用户看到"全就绪"，而某张图从来没被取过、画面里那块是占位。
       *
       * ⇒ 只要存在未请求资源，就**不得**声称整批就绪：文案点名数量与去向，
       * 状态标 `missing`（"这一批里有没有到的"是**可辨认的缺失**，不是解码失败 ——
       * 用 `failed` 会把"没人去取"说成"取回来是坏的"）。
       */
      // ⚠️ 只有**有取回位置**的未请求条目才算"没到"：`payload===null && locator===''` 是
      // "该材质本来就没有贴图"（装配侧已就 `resourceWithoutPayloadOrLocator` 报过），
      // 把它算成"未请求"会让每份无贴图材质都变成一条待办事项。
      const unrequestedResources = resources.filter(
        (r) => r.state === 'unrequested' && r.locator.url !== '',
      )
      if (notReady === 0 && unrequestedResources.length === 0) {
        writeTextureLive(`纹理就绪 ${total}/${total}`, 'ready')
      } else if (notReady === 0) {
        const namedUnrequested = unrequestedResources
          .slice(0, 2)
          .map((r) => {
            const s = r.locator.url !== '' ? r.locator.url : r.identity.id
            return s.length > 28 ? `${s.slice(0, 27)}…` : s
          })
          .join(', ')
        writeTextureLive(
          `纹理未请求 ${unrequestedResources.length}/${total}（${namedUnrequested}${
            unrequestedResources.length > 2 ? ' 等' : ''
          }）：外链资源未取回，画面中对应图元以占位显示`,
          'missing',
          LOG_LEVEL.WARN,
        )
      } else {
        const named = notReadyResources
          .slice(0, 2)
          .map((r) => {
            const s = r.locator.url !== '' ? r.locator.url : r.identity.id
            return s.length > 28 ? `${s.slice(0, 27)}…` : s
          })
          .join(', ')
        const suffix = `（${named}${notReady > 2 ? ' 等' : ''}）`
        // Q1（M8-5）：资源失败**不夺视口** —— 受影响图元以占位（无贴图）呈现，
        // 其余内容照常。文案必须同时说清三件事：数量、**点名**、以及"画面还在"，
        // 否则读者会按旧行为理解成"整个视口没了"（那正是 S0-B D2 的旧形态）。
        if (bound.missingRequired > 0) {
          writeTextureLive(
            `纹理缺失 ${notReady}/${total}${suffix}：视口保留，受影响图元以占位显示`,
            'missing',
            LOG_LEVEL.WARN,
          )
        } else {
          // 非必需贴图坏了：画面可显示，但「有失败」是事实，不得报成就绪。
          writeTextureLive(
            `纹理失败 ${notReady}/${total}${suffix}：视口保留，其余正常显示`,
            'failed',
            LOG_LEVEL.ERROR,
          )
        }
      }
      // 资源事实的**结构化**记录（M8-5）：逐条点名 + 降级范围 + 重试后的恢复对账。
      // 这里**不**再借 `effect.failed`（D2/D7：那条记录没有 assetId，且与呈现链的
      // 编译/注解失败混在同一条通道里）。计数单位见上面的注释。
      presenterBundle.resources.reportOutcome({
        viewportId: regionId,
        resources,
        degradedMaterials: bound.degraded,
        missingRequired: bound.missingRequired,
        attempt: retryAttempt,
      })
      lastFailedNames = notReadyResources.map((r) => (r.locator.url !== '' ? r.locator.url : r.identity.id))
      if (bound.missingRequired > 0) {
        presenterErrors.push(`textures-missing-required:${bound.missingRequired}`)
      }
      if (synced.readyWithoutPixels > 0) {
        // 契约说 `ready` ⇒ 有像素；这条分支出现即为实现缺陷，显式上报。
        presenterErrors.push(`textures-ready-without-pixels:${synced.readyWithoutPixels}`)
        emitPresenterFailure('textures-ready-without-pixels', String(synced.readyWithoutPixels))
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      presenterErrors.push(`textures-threw:${message}`)
      emitPresenterFailure('textures-threw', message)
      // 整批失败同样是**终态**：不得停在「加载中」（SPEC §7.4 末句：失败不能一直显示为加载中）。
      // 过期批次（已有更新文档）不得改写状态栏。
      if (seq === textureSyncSeq && !texturesDisposed) {
        writeTextureLive(`纹理失败 ${total}/${total}`, 'failed', LOG_LEVEL.ERROR)
      }
    } finally {
      // 耗时登记（#399 步骤 6）：total 是白模期墙钟，decode/bind 是它的两段拆分。
      perfMark(`texture-sync:${seq}:end`)
      perfMeasure('texture-sync:total', `texture-sync:${seq}:start`, `texture-sync:${seq}:end`)
      perfMeasure('texture-sync:decode', `texture-sync:${seq}:start`, `texture-sync:${seq}:decoded`)
      perfMeasure('texture-sync:bind', `texture-sync:${seq}:decoded`, `texture-sync:${seq}:bound`)
      if (inFlightTextureIdentity === identity) inFlightTextureIdentity = null
    }
  }

  /**
   * **设备丢失/恢复的生产接线**（M8-3；S0-A D1/D11）。
   *
   * 画布由 `attachViewport` 写进 `vpSlot.domElement`（视口就绪后才非空）⇒ 用 watch
   * 跟随它：**重挂会换画布**，旧监听必须先注销再挂新画布（同一函数返回注销句柄）。
   *
   * ## 各层分工（本接线只做"搬家"）
   *
   * - 会话（`PresenterSession`）：放弃旧代次份额、置 `pendingRebuild`、恢复后强制重建；
   * - 图幅/纹理：丢失期放弃旧 GPU 纹理（`abandon` —— 不逐张 dispose 死句柄），
   *   恢复后把纹理同步去重键作废，使下一帧按**当前内容**重新上传；
   * - 诊断/底栏：`runtime/deviceEvents` 发 `device.*` 并写用户可见状态。
   *
   * ## 为什么恢复期要作废纹理去重键
   *
   * `syncPresenterTextures` 按 `assetId@version` 去重（那是它的正确性来源）。
   * 设备丢失后纹理被**放弃**，若去重键不变，恢复后不会重传 —— 画面回来但没有贴图，
   * 而且没有任何报错。设备代次变了 ⇒ 纹理代次也必须重来（§7.5:262）。
   */
  let detachDeviceEvents: (() => void) | null = null
  watch(
    vpSlot.domElement,
    (canvas) => {
      detachDeviceEvents?.()
      detachDeviceEvents = null
      if (canvas === null) return
      detachDeviceEvents = attachViewportDeviceEvents({
        canvas,
        viewportId: regionId,
        session: presenterSurface,
        diagnostics: ctx.wm.diagnostics,
        liveStatus: ctx.log,
        onLost: () => presenterTextures.abandon(),
        onRestored: () => {
          lastTextureIdentity = null
          inFlightTextureIdentity = null
        },
      })
    },
    { flush: 'post', immediate: true },
  )
  onScopeDispose(() => {
    detachDeviceEvents?.()
    detachDeviceEvents = null
  })

  const applyPresenterSurface = (): void => {
    /**
     * **画面源 = 内核呈现文档**（M5-2）。
     *
     * 此前读 `kernel?.document()` 的 **装载期场景**：通道取值变化不重跑装配、
     * 也不写回该场景 ⇒ "滑杆动了画面不动"（断点②）。现在读
     * `Context#kernelPresentationDocument()`：多方块文档的 `scene` 是**按当前取值
     * 求值的派生场景**（唯一求值点 `composition/kernelMultiblockEvaluation`），
     * 帧为主文档原样返回内核文档（行为零变化）。
     *
     * 派生文档不落存储、不进历史：它只是"这一帧该画什么"的求值产物。
     */
    const doc = ctx.kernelPresentationDocument()
    if (doc === null) return
    // **设备丢失期暂停呈现**（M8-3 / §7.5:264）：画面资源已随设备失效，此时再
    // 求值/上传只会把新份额建在死上下文上。会话的相位机是唯一判据；恢复事件
    // 把它推回 ready 后，本函数下一帧自然按**当前**文档/时间重建。
    // 注意：只暂停"呈现"，不碰文档/选择/时间/机位 —— 那些读面照旧可用。
    if (!presenterSurface.deviceReady) return
    try {
      // **分层预览**是呈现侧过滤（不进冻结的 `EvaluationKey`）：每帧按当前层写入会话，
      // 它进**内容身份** ⇒ 换一层必然重编（否则"选了 Y=3 画面不动"）。
      // 这里读 `drw.computed.layerPreviewMode`：该派生规则（`< 0 ⇒ 'all'`）只有一处定义；
      // 会话侧收的是 `worldY: number | null`（`null` = 不分层）⇒ 本行只做形状适配。
      const layerMode = drw.computed.layerPreviewMode.value
      presenterSurface.setLayerPreview(layerMode === 'all' ? null : layerMode.worldY)
      const out = presenterSurface.applyKernelDocument(doc, kernel?.playback().time ?? ZERO_TIME)
      // 编译失败/跳过是**真实事实**，必须可见（不得静默当"画好了"）。
      if (out.compileError !== null) {
        presenterErrors.push(`compile:${out.compileError}`)
        emitPresenterFailure('compile', out.compileError)
      }
      for (const s of out.skipped) {
        presenterErrors.push(`kernel-skip:${s.objectId}:${s.reason}`)
        emitPresenterFailure('kernel-skip', s.reason, s.objectId)
      }
      for (const s of out.compileSkipped) {
        presenterErrors.push(`compile-skip:${s.objectId}:${s.reason}`)
        emitPresenterFailure('compile-skip', s.reason, s.objectId)
      }
      // 材质统一：编译产物已就位 ⇒ 接着把贴图接上（否则该批次走中性色）。
      void syncPresenterTextures()
      syncPresenterAnnotations(doc)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      presenterErrors.push(`threw:${message}`)
      emitPresenterFailure('threw', message)
    }
  }

  /**
   * 注解从内核文档进呈现会话（R1-β① C7）。
   *
   * 去重口径与 `applyIfChanged` 同一纪律：**文档版本**是内容身份，版本没变就不重建
   * GPU 对象（注解每帧重编会让 overlay 每帧 dispose/重建一次）。
   *
   * `showAnnotations` 是**视口状态**（不是文档内容）⇒ 由本处过滤，而不是让内核承载它
   * （见 `composition/kernelAnnotationInputs` 的 `visible` 说明）。
   */
  const syncPresenterAnnotations = (doc: {
    readonly version: { readonly documentVersion: number }
    readonly scene: Parameters<PresenterSession['syncKernelAnnotations']>[0]
  }): void => {
    const visible = toRef(viewerPrefs, 'showAnnotations').value
    const wanted = `${visible ? 'show' : 'hide'}:d${doc.version.documentVersion}`
    if (wanted === lastAnnotationIdentity) return
    lastAnnotationIdentity = wanted
    try {
      const outcome = presenterSurface.syncKernelAnnotations(doc.scene, visible)
      for (const u of outcome.unrendered) {
        presenterErrors.push(`annotation:${u.objectId}:${u.aspect}`)
        emitPresenterFailure('annotation', u.aspect, u.objectId)
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      presenterErrors.push(`annotation-threw:${message}`)
      emitPresenterFailure('annotation-threw', message)
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
      drw.textureCache.value?.setSceneTime(presenterBundle.sceneSeconds(info.time))
      syncMirror()
      // **呈现会话的每帧应用**（#299 P10e 段②）。
      //
      // 它按**内容身份**决定要不要重编（`applyIfChanged`）：机位变化不重编（A11），
      // 换帧/换内容才重编。放在这里（而不是只在换帧时）的理由与纹理时间同一：
      // 内容可能因通道取值、文档替换而变化，而那与"帧下标变了"是两件不同的事。
      applyPresenterSurface()
      if (info.frameIndex === lastPresentedFrame) return
      lastPresentedFrame = info.frameIndex
      // **定义面**（结构定义/调色板/图标）随帧刷新；**画面**由上面的
      // `applyPresenterSurface()` 每帧产出（C8 起不再有 `presentWorldFrame` 建网格这一步）。
      void drw.applyWorldFrame(info.frameIndex)
    })
    onScopeDispose(() => {
      off()
    })
    // 首帧：进入视口时立刻呈现当前帧（不等第一次时钟 tick）。
    lastPresentedFrame = kernel.frameIndex()
    drw.textureCache.value?.setSceneTime(presenterBundle.sceneSeconds(kernel.playback().time))
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
    /**
     * 呈现会话（#299 P10e 段②）。
     *
     * 暴露它是为了**可观测**：e2e 要断言"内核链真的画出了批次、且逐格拾取可用"，
     * 而那必须能从页面里读到这个会话（与 `outlinePass` 同一手法）。
     */
    presenterSurface,
    /**
     * 纹理端口（材质统一的**可观测面**：`size` = 当前存活的 GPU 纹理数）。
     *
     * 暴露它的理由与 `presenterSurface` 同一：e2e 要断言"贴图真的接上了、
     * 且换文档后旧纹理被释放"——那必须能从页面里读到，而不是靠"看起来有颜色"。
     */
    presenterTextures,
    /**
     * 呈现会话的**错误累积**（公开观测点；空数组 = 无错误）。
     *
     * 为什么是"累积列表"而不是"最后一个错误"：并发/连续失败时后者会覆盖前者，
     * 而"哪一类失败"才是诊断要的信息。上限截断避免无界增长（帧循环每帧都可能 push）。
     */
    presenterErrors,
  }
}
