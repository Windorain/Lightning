/**
 * DRW 结构面管线（不 import Context，只订阅 Ref）。
 *
 * ## R1-β① C8 的退役改造（本文件删掉的是**画面**的生产路径）
 *
 * | 旧形态 | 现状 |
 * |---|---|
 * | `BlockMeshProvider` → legacy `blockMesh` 建几何、写 `mainMeshGroup`（= 视口结构层） | **已删除**：画面由 `composition/presenterSession` 的 `PresenterSession` 产出，视口把它挂进场景树（`shared/viewport/useViewportRuntime`） |
 * | `AnnotationMeshProvider` → 注解 Mesh 子树（overlay / world 两桶） | **已删除**：注解由 `presentation/annotationPlan` + `presentation/overlayPresenter` 产出（同一呈现会话） |
 * | `rebuildContentMesh()`（内容变化 ⇒ 重建 mesh） | **已删除**：呈现会话按**内容身份**自行决定重编 |
 * | `presentWorldFrame(index)`（解析 bundle + 建 mesh） | 改名 `applyWorldFrame(index)`：只**解析**结构定义与调色板（拿掉建 mesh 那一步） |
 *
 * ## 本文件**保留**的职责（C8 的交付轴不含它们）
 *
 *  - **材质库**（`textureCache`）：`buildMaterialLibrary(doc.serialize())` —— 它的另一个消费者是
 *    **方块图标缓存**（`blockIconCache`，侧栏/统计面板的缩略图），而图标链不在本批轴内；
 *  - **结构定义解析**（`resolveRenderBundle`）：`structureDefinition` 是分层预览、
 *    统计面板与 `ViewportSlot.definition` 的读面来源；
 *  - **工具预览根**（`toolsOverlayGroup`）：工具（box/line/point/text/face）把自己的预览 mesh
 *    挂在这里 —— 那是**工具**的呈现，不是内容网格的呈现，故不随 mesh 路径一起退役；
 *  - **内容重读信号**（`contentRefreshTick` + `presentation/contentIdentity`）：
 *    只保留 `reloadResources`/`resolveStructure` 两处执行（见 `applyContentRefresh`）。
 *
 * ⚠️ **画面不再经本文件**：`mainMeshGroup`/`worldAnnotationGroup` 两个写入点已删除。
 * 于是"谁画了这 24 个三角形"只有一个答案（呈现会话的批次）。
 *
 * ## 旧文档来源（`docRef`）为什么还在
 *
 * 上面保留的三件事（材质库、结构定义、图标缓存）读的仍是旧格式视图文档
 * （`composition/kernelRenderView` 的投影产物）。那是接缝 `legacy-render-source-document`
 * 的剩余边（画面终切已完成，**定义/图标面**的迁移归 R2/R3），登记见 `composition/seams.ts`。
 */
import { computed, shallowRef, watch, type ComputedRef, type Ref, type ShallowRef } from 'vue'
import * as THREE from 'three'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import type { LoadStatus } from '@/runtime/types'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import type { LayerPreviewMode } from '@/render/data/layerPreview'
import type { StructureDefinition } from '@/render/schema/types'
import type { BlockStatRow } from '@/render/interaction/blockStats'
import { buildBlockStatsEntries } from '@/render/interaction/blockStats'
import { buildMaterialLibrary } from '@/render/data/buildMaterialLibrary'
import { isWorldDocument, resolveRenderBundle, type RenderBundleResolveResult } from '@/render/data/bundleResolve'
import {
  BlockIconCache,
  BLOCK_ICON_LAYOUT_REVISION,
  blockIconBakeLayoutKey,
} from '@/render/interaction/blockIconCache'
import {
  MC_ITEM_SLOT_BAKE_REVISION,
  summarizeBlocksForCache,
} from '@/render/interaction/blockSlotBaker'
import { createContentSignal } from '@/presentation/contentSignal'
import type { RebuildPlan } from '@/presentation/contentIdentity'
import type { KernelRenderSourceFace } from '@/composition/kernelPresentationInputs'
import { readContentIdentity } from '@/runtime/presentationAdapter'

/**
 * 帧下标取模归一（纯；把任意整数折进 `[0, n)`）。
 *
 * 保留在本文件（而不是挪进内核）的理由：它是**呈现侧**的归一化 ——
 * 内核派生的帧下标已经是合法的（离散阶跃采样恒落在定义域内），
 * 这里归一化的是"呈现请求"里可能越界的原始值（例如 `seekFrame(999)`）。
 */
function normalizeWorldFrameListIndex(w: { frames: unknown[] }, raw: number): number {
  const n = w.frames.length
  if (n === 0) return 0
  const i = Math.floor(raw)
  return ((i % n) + n) % n
}

/**
 * **换帧请求不可用的判别式**（R2/S3）。
 *
 * 取值**复用既有守卫**（`setCurrentWorldFrame` 的 `!doc || doc.frameCount === 0`），
 * 不新造判定 —— 于是"什么时候算不可用"只有一个答案（就是那个 `if`）。
 *
 * | reason | 判据 | 语义 |
 * |---|---|---|
 * | `no-render-view-document` | `docRef.value === null` | 没有渲染视图文档。生产里最常见的原因是**未装配成功**（`hasAdoptedContent() === false` ⇒ 内核面求值产不出文档）；多方块再装配失败 / 投影读不回也落这条（两者同样如实给 `doc: null`，不伪造） |
 * | `empty-frame-axis` | `doc.frameCount === 0` | 文档在，但帧轴是空的 ⇒ 没有可换的帧 |
 */
export type FrameChangeUnavailableReason = 'no-render-view-document' | 'empty-frame-axis'

/** 一次"换帧不可用"的事实（**不**含自然语言；文案归 UI 翻译层）。 */
export interface FrameChangeUnavailableReport {
  /** 被请求、但未能生效的帧下标。 */
  readonly index: number
  readonly reason: FrameChangeUnavailableReason
}

/** "换帧不可用"的上报器（决策在这里；落点由 `emit` 承担）。 */
export interface FrameChangeUnavailableReporter {
  /** 上报一次（同一不可用时段内每个 reason 只记首条；返回本次是否真的发出）。 */
  report(index: number, reason: FrameChangeUnavailableReason): boolean
  /** 内容恢复可用（换帧真的生效）⇒ 结账；下一次不可用重新记一条。 */
  clear(): void
}

/**
 * 建"换帧不可用"上报器。
 *
 * ## 为什么必须去重（不是优化）
 *
 * 请求方是帧滑块/快捷键 —— 拖一次滑块就是几十次 `setCurrentWorldFrame`，而记录器是
 * **容量 512 的共享**环形缓冲：逐次记账会把其它通道的记录挤掉。⇒ 同一"不可用时段"内
 * **每个 reason 只记首条**；换帧真的生效时调 `clear()` 结账。
 *
 * ## 为什么不需要"丢弃计数"（与 `createPresenterFailureReporter` 的差别）
 *
 * 那个上报器的签名空间**无界**（承载自由文本），超限必须计数并上报；本函数的签名空间
 * **恰为 2**（`FrameChangeUnavailableReason` 的取值数）⇒ 一个不可用时段最多 2 条记录，
 * 有界性在**结构上**成立（判据钉住这一点，不靠"请求方不会来回抖动"这种外部假设）。
 */
export function createFrameChangeUnavailableReporter(
  emit: (report: FrameChangeUnavailableReport) => void,
): FrameChangeUnavailableReporter {
  // 上界由类型给出：`FrameChangeUnavailableReason` 只有两个成员。
  const reported = new Set<FrameChangeUnavailableReason>()
  return {
    report(index, reason) {
      if (reported.has(reason)) return false
      reported.add(reason)
      emit({ index, reason })
      return true
    },
    clear() {
      reported.clear()
    },
  }
}

export interface DrwMeshPipelineDeps {
  /** 场景文档（RuntimeDocument）——**暂存路径**：只服务多方块的再装配投影（见 `renderSourceRef`） */
  docRef: Ref<RuntimeDocument | null>
  /**
   * **内核渲染源面**（G4 · S2 第二半）：定义 / 说明池 / 材质库输入三样由**内核内容**直出。
   *
   * ## 它替代的旧读取点（逐条对位本文件的 `doc.serialize()` 路径）
   *
   * | 旧读取点 | 本面字段 |
   * |---|---|
   * | `:225 worldFrameCount` | `frameCount` |
   * | `:304-320` / `:344-361`（`resolveRenderBundle`） | `definitionAt(i)` |
   * | `:314` / `:361 tooltipPalette` | `definitionAt(i).tooltipPalette` |
   * | `:178 buildMaterialLibrary(doc.serialize())` | `materialInput` |
   *
   * ⇒ **在场时本文件的 `docRef` 对这三样不再被读**（帧为主的文档上等于旧格式源整条脱离渲染链）。
   * 它**不**覆盖多方块的再装配（那仍要 `doc.multiblockSource`，是 G3 落地前**已登记**的暂存路径）；
   * 故两者不是"并存两份真相"，而是"同一份内容的两条**已登记**来源"：面在场优先，面缺席才走旧源。
   */
  renderSourceRef?: Ref<KernelRenderSourceFace | null>
  loadStatus: Ref<LoadStatus>
  blockIconCache: ShallowRef<BlockIconCache | null>
  tooltipPalette: ShallowRef<string[]>
  structureDefinition: ShallowRef<StructureDefinition | null>
  sceneRef: ShallowRef<THREE.Scene | null>
  /**
   * **世界帧下标**（P10 #261：由内核会话提供的**派生**值，不再是 `Main` 上的 Ref）。
   *
   * 它是**只读** getter：旧形态下本管线可以（也确实）直接写这个 Ref，于是
   * "谁在推进帧"有两个答案。现在帧下标由 `EditContext.time` 派生，
   * 唯一的写路径是 `setTime` 命令（经 `seekFrame` 注入）—— 本管线只能**读**。
   */
  worldFrameIndex: () => number
  layerWorldY: Ref<number>
  blockIconCacheOptions: { sizePx?: number; orthoHalf?: number }
  initialWorldFrameIndex?: number
  /**
   * **内容重读请求**（原 `structEpochRef` 的位置）。
   *
   * 语义是"内容**可能**变了"——本管线重读内容并自己判断（见文件头）。
   * 计数本身不参与判定，因此无论它怎么变，内容没变就**不会**重建。
   */
  contentRefreshTickRef: Ref<number>
  /** overlay pass 内工具预览根（ViewportSlot）—— **工具**的呈现，不是内容网格 */
  toolsOverlayGroupRef?: ShallowRef<THREE.Group | null>
  /**
   * 换帧（P10 #261）：写**时间**，不是写帧下标。
   *
   * 旧接口 `setFrameIndex(index)` 直接写一个独立权威（`Main.currentFrameIndex`），
   * 于是"帧"与"时间"可以互相矛盾；`seekFrame` 经 `setTime` 命令按帧时长轴换算成时间
   * ⇒ "跳到第 3 帧"与"播放到第 3 帧"落在**同一个**时间值上（A09）。
   */
  seekFrame?: (index: number) => void | Promise<void>
  /**
   * **未装配 ⇒ 换帧不可用**的上报口（R2/S3）。
   *
   * 判别与决策都在本层（判别式**就是** `setCurrentWorldFrame` 的既有守卫；见
   * `FrameChangeUnavailableReason`），**落点**由接线层给出 —— 生产接线把它映射到
   * **既有**诊断通道（`ctx.wm.diagnostics.record`，既有码表，不新造体系；
   * 见 `shared/viewport/useViewportRuntime`）。故本层不 import 任何诊断实现。
   *
   * 缺席 = 退回静默（只为"单测/无会话"直接构造本管线的场景保留）；生产**恒**注入，
   * 这一点由接线判据把守。
   */
  onFrameChangeUnavailable?: (report: FrameChangeUnavailableReport) => void
  /**
   * 时间是否在前进（P10 #261：替代旧的 `framesPlaybackIsPlaying` Ref）。
   *
   * 本管线不做任何调度 —— 只把它当**呈现侧观测**（是否继续跟随）。
   */
  isPlaying?: () => boolean
}

export interface DrwComputed {
  layerPreviewMode: ComputedRef<LayerPreviewMode>
  layerPreviewLabel: ComputedRef<string>
  gridHeight: ComputedRef<number>
  hasWorldMultiFrame: ComputedRef<boolean>
  worldFrameCount: ComputedRef<number>
  blockStatsEntries: ComputedRef<BlockStatRow[]>
}

export interface DrwMeshPipeline {
  registerScene(scene: THREE.Scene): void
  loadStructureAndResources(): Promise<void>
  /** 绑定 RenderEngine overlay pass 根 Group（工具预览挂在它下面） */
  bindOverlayPass(group: THREE.Group): void
  unbindOverlayPass(): void
  /** 请求内核把时间定位到某帧（**唯一**换帧入口；不改本地帧下标 —— 那是派生值）。 */
  setCurrentWorldFrame(index: number): Promise<void>
  /**
   * 按给定帧下标**解析**结构定义/调色板并刷新图标缓存（**不建几何**）。
   *
   * 与 `setCurrentWorldFrame` 的分工：后者是"请求换帧"（写面），本方法是
   * "把某一帧的**定义**读出来"（读面）。几何由呈现会话自行产出。
   */
  applyWorldFrame(index: number): Promise<void>
  disposeCachesAndLibrary(): void
  /**
   * 按**内容身份**应用一次内容重读（原 `rebuildAll()` 的位置）。
   *
   * 返回本次实际执行的 `RebuildPlan`；内容未变时返回 `null`（**什么都不做**）。
   */
  applyContentRefresh(source: string): Promise<RebuildPlan | null>
  /** 注册内容重读观察者；须在 registerScene 之后调用 */
  init(): void
  /** 解构 init 注册的 watch */
  dispose(): void
  /** 内部纹理缓存（供材质面板/图标缓存用，只读） */
  textureCache: Readonly<ShallowRef<MaterialLibraryApi | null>>
  computed: DrwComputed
}

export function createDrwMeshPipeline(deps: DrwMeshPipelineDeps): DrwMeshPipeline {
  const {
    docRef, loadStatus, blockIconCache, tooltipPalette,
    structureDefinition, sceneRef, worldFrameIndex, layerWorldY,
    blockIconCacheOptions, initialWorldFrameIndex, contentRefreshTickRef, seekFrame,
    toolsOverlayGroupRef, renderSourceRef, onFrameChangeUnavailable,
  } = deps

  /** 内核渲染源面（在场 ⇒ 定义/说明/材质三样**不**再经旧格式文档）。 */
  const renderSource = (): KernelRenderSourceFace | null => renderSourceRef?.value ?? null

  /**
   * 当前帧下标 —— **每次现读**（派生值）。
   *
   * 不缓存在局部变量里：帧下标由 `EditContext.time` 派生，
   * 缓存它就会重新引入"两个权威"（缓存值与真值可以漂移）。
   */
  const frameIndex = (): number => worldFrameIndex()

  // === 内部纹理缓存，从 doc.textureBlobs 构建 ===
  const textureCache = shallowRef<MaterialLibraryApi | null>(null)

  /**
   * 确保 textureCache 就绪；已完成则直接返回。
   *
   * 入参是**材质库输入**（`render/data/buildMaterialLibrary` 的 `plainDoc`）：
   * 内核渲染源面在场时传它的 `materialInput`（内核内容派生），否则传旧格式 plain（暂存路径）。
   */
  async function ensureTextures(materialInput: Record<string, unknown>): Promise<MaterialLibraryApi | null> {
    if (textureCache.value && !textureCache.value.isDisposed()) return textureCache.value
    try {
      textureCache.value = await buildMaterialLibrary(materialInput)
      return textureCache.value
    } catch (e) {
      console.error('[drw] buildMaterialLibrary failed', e)
      return null
    }
  }

  // ---- Overlay pass（工具预览；与 main structure 并列，由 DRW 统一同步）----
  let overlayPassTarget: THREE.Group | null = null
  let overlayToolsRoot: THREE.Group | null = null

  function ensureToolsOverlayRoot(): THREE.Group | null {
    const target = overlayPassTarget
    if (!target) return null
    if (!overlayToolsRoot) {
      overlayToolsRoot = new THREE.Group()
      overlayToolsRoot.name = 'drw-overlay-tools'
      target.add(overlayToolsRoot)
    } else if (overlayToolsRoot.parent !== target) {
      overlayToolsRoot.parent?.remove(overlayToolsRoot)
      target.add(overlayToolsRoot)
    }
    if (toolsOverlayGroupRef) toolsOverlayGroupRef.value = overlayToolsRoot
    return overlayToolsRoot
  }

  function clearToolsOverlayRootRef(): void {
    if (overlayToolsRoot?.parent) overlayToolsRoot.parent.remove(overlayToolsRoot)
    overlayToolsRoot = null
    if (toolsOverlayGroupRef) toolsOverlayGroupRef.value = null
  }

  function bindOverlayPass(group: THREE.Group): void {
    overlayPassTarget = group
    ensureToolsOverlayRoot()
  }

  function unbindOverlayPass(): void {
    clearToolsOverlayRootRef()
    overlayPassTarget = null
  }

  let stopContentRefreshWatch: (() => void) | null = null
  let stopLayerWorldYWatch: (() => void) | null = null

  // ---- Computed ----
  const worldFrameCount = computed(() => renderSource()?.frameCount ?? docRef.value?.frameCount ?? 0)
  const hasWorldMultiFrame = computed(() => worldFrameCount.value > 1)
  const gridHeight = computed(() => structureDefinition.value?.cellGrid[0]?.length ?? 0)
  const layerPreviewMode = computed<LayerPreviewMode>(() => {
    const y = layerWorldY.value
    if (y < 0) return 'all'
    return { worldY: y }
  })
  const layerPreviewLabel = computed(() =>
    layerWorldY.value < 0 ? 'ALL' : `Y = ${layerWorldY.value}`,
  )
  const blockStatsEntries = computed(() => {
    const def = structureDefinition.value
    if (!def) return []
    return buildBlockStatsEntries(def, layerPreviewMode.value)
  })

  watch(
    [blockStatsEntries, blockIconCache],
    () => {
      const cache = blockIconCache.value
      if (!cache) return
      cache.ensure(blockStatsEntries.value.map((r) => r.blockId))
    },
    { flush: 'post' },
  )

  // ---- 装配串行化 ----
  // 保留它：`loadStructureAndResources`（异步解码材质）与内容重读观察者可能并发，
  // 串行化保证"最后一次落地的是最新一次请求"。
  let pipeline: Promise<unknown> = Promise.resolve()
  function run<T>(fn: () => Promise<T>): Promise<T> {
    const p = pipeline.then(fn)
    pipeline = p.then(() => {}, () => {}) as Promise<unknown>
    return p
  }

  // ---- 图标缓存管理 ----
  function rebuildIconCache(lib: MaterialLibraryApi, definition: StructureDefinition): void {
    if (blockIconCache.value) blockIconCache.value.dispose()
    const cache = new BlockIconCache(lib, blockIconCacheOptions, definition)
    cache.setRevisionKey(
      `${definition.id}:${summarizeBlocksForCache(definition)}:${MC_ITEM_SLOT_BAKE_REVISION}:${BLOCK_ICON_LAYOUT_REVISION}:${blockIconBakeLayoutKey(blockIconCacheOptions)}`,
    )
    blockIconCache.value = cache
  }
  function disposeIconCache(): void {
    blockIconCache.value?.dispose()
    blockIconCache.value = null
  }

  // ---- 帧（P10 #261：专用播放调度器已删除；C8：几何生产已迁出本文件） ----
  //
  // 本文件**没有任何定时器**；帧下标由 `EditContext.time` 经离散阶跃采样**派生**
  // （`worldFrameIndex()`），推进归宿主帧时钟（`composition/kernelRuntime`）。

  /**
   * **未装配 ⇒ 换帧不可用**的上报（R2/S3）：判别式就是下面的既有守卫，落点由接线层给。
   *
   * 去重与有界性见 `createFrameChangeUnavailableReporter` 的文件头。
   */
  const frameChangeUnavailable = createFrameChangeUnavailableReporter((report) => {
    onFrameChangeUnavailable?.(report)
  })

  /**
   * 换帧（**唯一**入口）：请求内核把时间定位到某帧。
   *
   * 它**不**直接改任何本地状态 —— 帧下标是派生值，改时间就是改帧。
   * `seekFrame` 由接线层注入（内部经 `setTime` 命令）。
   *
   * ## R2/S3：守卫不再"静默"
   *
   * `518bdc15` 删掉 `Context#legacyRenderSource()` 本体后，未装配成功的文档
   * （`hasAdoptedContent() === false`）**没有**渲染视图文档 ⇒ `docRef.value === null`
   * ⇒ 原来这里直接 `return`，调用方看到的是"点了没反应"（**静默丢弃请求**）。
   * 现在同一条守卫**先发一条可查诊断**再返回：判定不变，只是不可用这件事**说出来**。
   */
  async function setCurrentWorldFrame(rawNext: number): Promise<void> {
    const doc = docRef.value
    if (!doc || doc.frameCount === 0) {
      frameChangeUnavailable.report(
        rawNext,
        doc ? 'empty-frame-axis' : 'no-render-view-document',
      )
      return
    }
    // 文档在、帧轴非空 ⇒ 本次不可用时段结束（下一次不可用重新记一条）。
    frameChangeUnavailable.clear()
    if (seekFrame) {
      await Promise.resolve(seekFrame(rawNext))
      return
    }
    // 没有接线（例如单测直接构造本管线）：显式不做，**不**静默假装换帧成功。
    console.warn('[drw] setCurrentWorldFrame: 未注入 seekFrame（内核会话未接线）')
  }

  /**
   * 由帧下标解析结构定义 + 调色板并刷新图标缓存（**不建几何**）。
   *
   * C8 之前这里还会建 mesh（`presentContentMesh`）；那一步已删除 ——
   * 几何由呈现会话按内核内容身份产出，本函数只负责**定义面**。
   */
  async function applyWorldFrame(index: number): Promise<void> {
    const source = renderSource()
    if (source !== null) {
      if (source.frameCount === 0) return
      return run(async () => {
        const hit = source.definitionAt(index)
        // 该帧取不到定义（越界/对象缺失/无类型化几何）⇒ **什么都不做**、保留上一次结果。
        if (hit === null) return
        structureDefinition.value = hit.definition
        tooltipPalette.value = [...hit.tooltipPalette]
        const lib = textureCache.value
        if (!lib || lib.isDisposed()) return
        rebuildIconCache(lib, hit.definition)
      })
    }
    const doc = docRef.value
    if (!doc || doc.frameCount === 0) return
    return run(async () => {
      const plain = doc.serialize()
      if (!isWorldDocument(plain) || plain.frames.length === 0) return
      const idx = normalizeWorldFrameListIndex(plain, index)

      const resolved: RenderBundleResolveResult = resolveRenderBundle({ document: plain }, idx)
      structureDefinition.value = resolved.definition
      tooltipPalette.value = resolved.tooltipPalette

      const lib = textureCache.value
      if (!lib || lib.isDisposed()) return
      rebuildIconCache(lib, resolved.definition)
    })
  }

  // ---- Lifecycle ----
  function registerScene(scene: THREE.Scene): void {
    sceneRef.value = scene
  }

  function init(): void {
    stopContentRefreshWatch?.()
    stopContentRefreshWatch = watch(contentRefreshTickRef, () => {
      void applyContentRefresh('content-refresh-tick').catch(e => {
        console.error('[drw] content refresh failed:', e)
        loadStatus.value = 'error'
      })
    })

    // **帧下标观察者已删除**（P10 #261）；**图层观察者已删除**（R1-β① C8）：
    // 旧实现在 `layerWorldY` 变化时重建 mesh —— 那是"几何生产在本文件"的产物。
    // 现在分层预览由呈现会话的 `setLayerPreview` 承担（它进内容身份 ⇒ 自动重编），
    // 本文件对图层变化**无事可做**（geometry 不归它、定义不随层变化）。
    stopLayerWorldYWatch?.()
    stopLayerWorldYWatch = null
  }

  async function loadStructureAndResources(): Promise<void> {
    const preserveViewport = loadStatus.value === 'ok'
    if (!preserveViewport) loadStatus.value = 'loading'
    try {
      const source = renderSource()
      const frameIdx = preserveViewport ? frameIndex() : (initialWorldFrameIndex ?? 0)
      if (source !== null) {
        // 内核渲染源面路径：定义/说明/材质输入三样都来自内核内容，**不经**旧格式文档。
        const hit = source.definitionAt(frameIdx)
        if (hit === null) {
          loadStatus.value = 'error'
          console.error('[drw] loadStructureAndResources: 内核渲染源面在该帧取不到定义')
          return
        }
        structureDefinition.value = hit.definition
        tooltipPalette.value = [...hit.tooltipPalette]
        const lib = textureCache.value
        const effectiveLib = (lib && !lib.isDisposed())
          ? lib
          : await ensureTextures(source.materialInput as unknown as Record<string, unknown>)
        if (!effectiveLib || effectiveLib.isDisposed()) {
          loadStatus.value = 'error'
          console.error('[drw] loadStructureAndResources: failed to build textureCache')
          return
        }
        rebuildIconCache(effectiveLib, hit.definition)
        loadStatus.value = 'ok'
        return
      }
      const doc = docRef.value
      if (!doc) { loadStatus.value = 'error'; return }
      const plain = doc.serialize()
      const resolved: RenderBundleResolveResult = resolveRenderBundle(
        { document: plain },
        frameIdx,
      )
      // 非保留路径：按解析结果**定位时间**（帧下标是派生值 ⇒ 定位就是 seekFrame）。
      if (!preserveViewport && seekFrame) {
        await Promise.resolve(seekFrame(resolved.worldFrameIndex ?? 0))
      }
      structureDefinition.value = resolved.definition
      tooltipPalette.value = resolved.tooltipPalette
      const lib = textureCache.value
      const effectiveLib = (lib && !lib.isDisposed())
        ? lib
        : await ensureTextures(plain)
      if (!effectiveLib || effectiveLib.isDisposed()) {
        loadStatus.value = 'error'
        console.error('[drw] loadStructureAndResources: failed to build textureCache')
        return
      }
      rebuildIconCache(effectiveLib, resolved.definition)
      loadStatus.value = 'ok'
    } catch (e) {
      loadStatus.value = 'error'
      console.error('[drw] loadStructureAndResources', e)
    }
  }

  /**
   * 内容信号 —— 本管线的 `structEpoch` 替代物（见文件头）。
   *
   * 读取面是 `readContentIdentity()`（从文档/帧/分层/已解析定义机械派生摘要）。
   * **注意**：机位、选择、布局都不在读取面的入参里，因此它们**不可能**触发任何重建 ——
   * 这是 A11 的结构性保证，不依赖任何调用方的自觉。
   */
  const contentSignal = createContentSignal(() =>
    readContentIdentity({
      doc: docRef.value,
      frameIndex: frameIndex(),
      layerPreview: layerPreviewMode.value,
      definition: structureDefinition.value,
    }),
  )

  /**
   * 按**内容身份**应用一次内容重读（原 `rebuildAll()` 的位置）。
   *
   * ## C8 之后它只剩两个执行位
   *
   * | 计划位 | 本文件的行为 |
   * |---|---|
   * | `reloadResources` | 释放材质缓存与图标缓存（强制重新解码） |
   * | `resolveStructure` | 重解结构定义（换帧/改网格/改多方块取值） |
   * | `rebuildGeometry` | **不归本文件**：几何由呈现会话按内核内容身份自行重编（G1/A11 的同一判据） |
   * | `syncAnnotations` | **不归本文件**：注解由呈现会话（`annotationPlan` + `overlayPresenter`）同步 |
   *
   * 后两行**不是**"悄悄跳过"：它们有各自的**唯一**执行体（呈现会话），
   * 而本文件若也做一遍就会出现两套几何/注解生产者（C8 要消灭的正是这个）。
   */
  async function applyContentRefresh(source: string): Promise<RebuildPlan | null> {
    const revision = contentSignal.republish(source)
    if (revision === null) return null
    const plan = revision.plan

    return run(async () => {
      if (plan.reloadResources) {
        // ⚠️ 这里只动**资源**（材质库 + 图标缓存），**不**动视口宿主/画布。
        //
        // 宿主的寿命由"有已解析场景"决定（`loadStatus === 'ok' && structureDefinition`），
        // 不由本行的 `textureCache` 决定 —— SPEC §7.3「资源加载状态改变不得销毁正常视口
        // 宿主」、§7.4「部分资源未就绪时可以保留已有画面」。#397（M2-1）之前两个宿主模板
        // 把 `materialLibrary`（= 本 ref）写进 `v-if`，于是本行执行时 `RenderEngineHost`
        // 被卸载重挂、canvas DOM 节点被换掉（实测 2 帧宿主与画布同时缺席、空窗 512 ms）。
        // 判据：`web/e2e/kernel-viewport-host-lifetime.spec.ts`。
        //
        // 登记（**未修**，不属 #397 轴）：内容身份在装载路径上**没有**基线
        // （`contentSignal` 首次 `republish` 时 `prev === null` ⇒ `documentChanged`），
        // 故"第一次内容编辑"会被判成"换了文档"⇒ 多做一次资源重解码（§8「编辑不得隐式
        // 改变未变资源」）。今天它只浪费一次解码、不改变画面（画面走呈现会话的纹理端口），
        // 故与本单分开处理。
        disposeIconCache()
        textureCache.value?.dispose()
        textureCache.value = null
      }
      if (plan.resolveStructure || plan.reloadResources) {
        // 重解结构：加载路径本身会（在缓存已释放时）重新解码纹理
        await loadStructureAndResources()
      }
      return plan
    })
  }

  function disposeCachesAndLibrary(): void {
    unbindOverlayPass()
    disposeIconCache()
    textureCache.value?.dispose()
    textureCache.value = null
    structureDefinition.value = null
    tooltipPalette.value = []
    // **不再重置帧下标**（P10 #261）：它是派生值，没有可写的本地状态。
    sceneRef.value = null
  }

  function dispose(): void {
    stopContentRefreshWatch?.()
    stopContentRefreshWatch = null
    stopLayerWorldYWatch?.()
    stopLayerWorldYWatch = null
  }

  return {
    registerScene,
    loadStructureAndResources,
    bindOverlayPass,
    unbindOverlayPass,
    setCurrentWorldFrame,
    applyWorldFrame,
    disposeCachesAndLibrary,
    applyContentRefresh,
    init,
    dispose,
    textureCache,
    computed: {
      layerPreviewMode,
      layerPreviewLabel,
      gridHeight,
      hasWorldMultiFrame,
      worldFrameCount,
      blockStatsEntries,
    },
  }
}
