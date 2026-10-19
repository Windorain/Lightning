/**
 * DRW — 视口**结构面**运行时：结构定义/材质缓存/图标缓存 + selection outline（不 import Context）。
 *
 * ## R1-β① C8：画面生产者已迁出本类
 *
 * 旧形态下 `DRW` 是**画面**的唯一生产者（`blockMeshProvider` → legacy `blockMesh` → 写
 * `mainMeshGroup`）。C8 把画面交给 `composition/presenterSession` 的呈现会话后，本类
 * 只剩三件事：**结构定义/材质/图标**（定义面，见 `drwMeshPipeline` 文件头）、
 * **选择描边**（`outlinePass` + `SelectionHighlightProvider` 自建 mask，与内容几何无关）、
 * **相机同步**（`bindViewportCameraSync`）。故 `mainMeshGroup` 与 `worldAnnotationGroup`
 * 两个槽位写入点已删除 —— 视口结构层由呈现会话产出。
 */
import { ref, shallowRef, toRaw, watch, type Ref, type ShallowRef } from 'vue'
import * as THREE from 'three'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import type { LoadStatus } from '@/runtime/types'
import type { StructureDefinition } from '@/render/schema/types'
import type { BlockIconCache } from '@/render/interaction/blockIconCache'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import { SelectionOutlinePass } from '@/render/postprocessing/SelectionOutlinePass'
import {
  createDrwMeshPipeline,
  type DecodedPaletteTexture,
  type DrwComputed,
  type DrwMeshPipeline,
  type FrameChangeUnavailableReport,
} from '@/runtime/drwMeshPipeline'
import type { BlockRef, SelectedEntity } from '@/context/selection'
import { OUTLINE_MASK_LIMIT, applyOutlineMaskBudget } from '@/presentation/outlineBudget'
import { SelectionHighlightProvider } from '@/render/mesh/selectionHighlightProvider'
import { plansToMaskMeshes } from '@/render/mesh/outlinePlanMasks'
import { bindViewportCameraSync } from '@/runtime/viewportCamera'
import type { ViewportCameraState } from '@/runtime/viewportCamera'
import type { KernelRenderSourceFace } from '@/composition/kernelPresentationInputs'

/**
 * 描边规划端口（**结构类型**，与 `composition/kernelOutlinePlanPort` 的实现同形）。
 *
 * ## 为什么不直接 import `composition/kernelOutlinePlanPort`
 *
 * 本文件属**旧层**（`runtime/`），而 `composition/` 是装配根。旧层持有装配根的
 * **值**依赖正是接缝 `shared-viewport-upward-imports-assembly-root` 要退役的方向
 * —— 该接缝**已核销**（R1-β① C10 / 提交 `0219a9eb`：其登记覆盖的
 * `shared/viewport/useViewportRuntime.ts` 值导入实测 4 → 0，登记已从 `SEAMS` 删除）；
 * 本条**不在**那份登记覆盖的文件里，但**同一条方向纪律**照旧适用。
 * 用结构类型让"DRW 需要什么"成为**一条可读的接口**，注入方（宿主装配边）负责
 * 提供实现 —— 与 C9/C10 的注入纪律一致（本处**不**新增门面包旧核心的边）。
 */
export interface OutlinePlanPort {
  planPicks(picks: readonly OutlinePickRef[]): {
    readonly plans: readonly import('@/presentation/outlinePlan').OutlinePlan[]
    readonly skipped: readonly import('@/presentation/outlinePlan').OutlineSkip[]
  }
}

/** 一次拾取引用（格 + 可选部件；与 `BlockRef` 同一语义面）。 */
export interface OutlinePickRef {
  readonly pos: { readonly x: number; readonly y: number; readonly z: number }
  readonly partLocalId?: string
}

export type { DrwComputed } from '@/runtime/drwMeshPipeline'

export interface DRWDeps {
  docRef: Ref<RuntimeDocument | null>
  /**
   * 内核渲染源面（G4 · S2 第二半）—— 定义 / 说明池 / 材质库输入的**内核直出**读面。
   *
   * 在场时本管线的这三样**不再**读 `docRef`（帧为主文档上等于旧格式源脱离渲染链）；
   * 缺席时才走 `docRef`+`resolveRenderBundle`（多方块再装配的**已登记暂存路径**）。
   */
  renderSourceRef?: Ref<KernelRenderSourceFace | null>
  /** 内容重读请求（原 `structEpochRef`；语义见 `drwMeshPipeline` 文件头） */
  contentRefreshTickRef: Ref<number>
  /**
   * 世界帧下标（P10 #261：**派生**值的只读 getter，不再是 `Ref`）。
   */
  worldFrameIndex: () => number
  layerWorldY: Ref<number>
  structureDefinition: ShallowRef<StructureDefinition | null>
  blockIconCacheOptions?: { sizePx?: number; orthoHalf?: number }
  initialWorldFrameIndex?: number
  /** 换帧（经 `setTime` 命令定位时间；见 `DrwMeshPipelineDeps.seekFrame`）。 */
  seekFrame?: (index: number) => void | Promise<void>
  /**
   * **未装配 ⇒ 换帧不可用**的上报口（R2/S3；`DrwMeshPipelineDeps.onFrameChangeUnavailable`）。
   *
   * 本类只透传：判别与去重都在管线的既有守卫处（那里才看得见 `docRef`）。
   */
  onFrameChangeUnavailable?: (report: FrameChangeUnavailableReport) => void
  /** 呈现链内部失败的上报口（M8-6；本类只透传，落点由接线层给）。 */
  onInternalFailure?: (report: { readonly reason: string; readonly detail?: string }) => void
  /** 时间是否在前进（呈现侧观测；不驱动任何调度）。 */
  isPlaying?: () => boolean
  /** overlay pass 内**工具预览**根（ViewportSlot；工具的呈现，不是内容网格）。 */
  toolsOverlayGroupRef?: ShallowRef<THREE.Group | null>
  viewportCameraRef?: Ref<ViewportCameraState | null>
  cameraRef?: Ref<THREE.Camera | null>
  orbitTargetRef?: Ref<THREE.Vector3 | null>
}

export class DRW {
  readonly sceneRef = shallowRef<THREE.Scene | null>(null)
  readonly loadStatus = ref<LoadStatus>('loading')
  /**
   * **网格构建忙碌**（UI 的按钮禁用/忙碌态）。
   *
   * ⚠️ R1-β① C8 之后它**恒为 `false`**：本类不再建网格（几何由呈现会话产出），
   * 故没有任何异步网格构建可以"忙"。保留该字段是因为它是**呈现契约**
   * （`LayerPreviewBar`/`WorldFrameScrubber`/`ViewportFrameLayerDock` 按它禁用控件），
   * 而"删字段"会连带改 4 个组件 —— 那不在 C8 的交付轴内。语义上它仍然为真：
   * "此刻没有网格在构建"，所以禁用态**不会**误伤交互。
   */
  readonly meshBusy = ref(false)
  readonly blockIconCache = shallowRef<BlockIconCache | null>(null)
  readonly tooltipPalette = shallowRef<string[]>([])
  readonly outlinePass: SelectionOutlinePass
  /**
   * 描边通道的**上限口径观测点**（B-5 / #38 收口）：每次装配 mask 后写入
   * `{ total, shown, dropped }`。`dropped > 0` = 命中总数超过 `OUTLINE_MASK_LIMIT`
   * 且被截断——调用方据此给出可辨认提示（"不得静默失效"）。
   * 只在读数变化时写入，避免与消费它的 computed 形成刷新循环。
   */
  readonly outlineMaskStats = ref<{ total: number; shown: number; dropped: number }>({
    total: 0,
    shown: 0,
    dropped: 0,
  })
  /**
   * **描边规划的跳过原因**（C9；空数组 = 无跳过）。
   *
   * 与 `outlineMaskStats` 的分工：后者是"画出来多少"（预算截断），本字段是
   * "为什么没画"（过期求值 / 缺几何 / 目标不完整）。分开是因为处置不同：
   * 截断要提示"只显示前 N 处"，跳过要提示"选中了但没高亮、因为……"。
   */
  readonly outlineSkipped = ref<readonly string[]>([])
  readonly computed: DrwComputed
  readonly textureCache: Readonly<ShallowRef<MaterialLibraryApi | null>>

  private readonly _mesh: DrwMeshPipeline
  private stopOutlineWatch: (() => void) | null = null
  private stopCameraSync: (() => void) | null = null
  private highlightProvider = new SelectionHighlightProvider()

  constructor(deps: DRWDeps) {
    this.outlinePass = new SelectionOutlinePass(new THREE.Vector2(1024, 768))
    this._mesh = createDrwMeshPipeline({
      docRef: deps.docRef,
      renderSourceRef: deps.renderSourceRef,
      loadStatus: this.loadStatus,
      blockIconCache: this.blockIconCache,
      tooltipPalette: this.tooltipPalette,
      structureDefinition: deps.structureDefinition,
      sceneRef: this.sceneRef,
      worldFrameIndex: deps.worldFrameIndex,
      layerWorldY: deps.layerWorldY,
      blockIconCacheOptions: deps.blockIconCacheOptions ?? {},
      initialWorldFrameIndex: deps.initialWorldFrameIndex,
      contentRefreshTickRef: deps.contentRefreshTickRef,
      seekFrame: deps.seekFrame,
      onFrameChangeUnavailable: deps.onFrameChangeUnavailable,
      onInternalFailure: deps.onInternalFailure,
      isPlaying: deps.isPlaying,
      toolsOverlayGroupRef: deps.toolsOverlayGroupRef,
    })
    if (deps.viewportCameraRef && deps.cameraRef && deps.orbitTargetRef) {
      this.stopCameraSync = bindViewportCameraSync(
        deps.viewportCameraRef,
        deps.cameraRef,
        deps.orbitTargetRef,
      )
    }
    this.computed = this._mesh.computed
    this.textureCache = this._mesh.textureCache
  }

  registerScene(scene: THREE.Scene): void {
    this._mesh.registerScene(scene)
  }

  init(): void {
    this._mesh.init()
  }

  loadStructureAndResources(): Promise<void> {
    return this._mesh.loadStructureAndResources()
  }

  /**
   * **接收已解码的调色板纹理**（M8-5）：视口的纹理同步环在五态结算后把 `ready`
   * 的像素交进来，图标材质库据此装配（本类不解码 —— 第二解码链已退役）。
   */
  applyDecodedTextures(textures: readonly DecodedPaletteTexture[]): void {
    this._mesh.applyDecodedTextures(textures)
  }

  /**
   * 呈现给定帧的**定义面**（宿主的帧时钟在观测到帧下标变化时调用）。
   *
   * 与 `setCurrentWorldFrame` 的分工见 `DrwMeshPipeline` 的接口说明：
   * 前者是"请求换帧"（写面），本方法是"把某一帧的结构定义读出来"（读面）。
   * **画面**由呈现会话每帧自行产出，不在这里。
   */
  applyWorldFrame(index: number): Promise<void> {
    return this._mesh.applyWorldFrame(index)
  }

  /**
   * 请求内核换帧（**唯一**换帧入口；经 `setTime` 命令）。
   *
   * 旧形态是 `setFrameIndex(index)` 直接写 `Main.currentFrameIndex` ——
   * 一个与时间无关的独立权威。现在它定位时间，帧下标随之派生。
   */
  setCurrentWorldFrame(index: number): Promise<void> {
    return this._mesh.setCurrentWorldFrame(index)
  }

  /**
   * 按**内容身份**应用一次内容重读（原 `rebuildAll()` 的位置）。
   *
   * 返回本次的 `RebuildPlan`；内容未变 ⇒ `null`（什么都不做）。
   */
  applyContentRefresh(source = 'manual'): Promise<import('@/presentation/contentIdentity').RebuildPlan | null> {
    return this._mesh.applyContentRefresh(source)
  }

  bindOverlayPass(overlayPassGroup: THREE.Group): void {
    this._mesh.bindOverlayPass(overlayPassGroup)
  }

  unbindOverlayPass(): void {
    this._mesh.unbindOverlayPass()
  }

  dispose(): void {
    this.stopCameraSync?.()
    this.stopCameraSync = null
    this.stopOutlineWatch?.()
    this.stopOutlineWatch = null
    this.outlinePass.dispose()
    this._mesh.disposeCachesAndLibrary()
    this._mesh.dispose()
  }

  bindSelectionOutline(options: {
    selectionItems: Ref<Set<SelectedEntity>>
    hoveredBlock: Ref<BlockRef | null>
    highlightOnHover: Ref<boolean>
    getBlockGeometry: (pos: { x: number; y: number; z: number }) => import('@/render/schema/types').BakedQuad[] | null
    gridCenterWorld: (pos: { x: number; y: number; z: number }) => { x: number; y: number; z: number } | null
    /**
     * B-1 部件级 mask 通道：`BlockRef.partLocalId` 给出时走该部件的盒几何，
     * 否则整格几何（既有行为）。hover 描边与点选高亮共用此入口。
     */
    getPartMaskGeometry?: import('@/render/mesh/selectionHighlightProvider').MaskGeometrySource
    /**
     * **R1-A C9：描边规划端口**（生产实现 = `composition/kernelOutlinePlanPort`）。
     *
     * 给定时，mask 由 `presentation/outlinePlan#planOutlines` 产出（图元 = 格四边形 /
     * 部件盒 / 1×1×1 兜底盒），而**不**再走 `SelectionHighlightProvider` 的 legacy
     * 决策分支 ⇒ "该不该画、画什么形状"只有一处判定（政策 = `BASELINE_OUTLINE_POLICY`，
     * 即迁移前行为）。未给定 ⇒ 维持 legacy 通道（调用方决定的过渡态）。
     */
    outlinePlans?: OutlinePlanPort
    /** Embed 侧栏按 blockId 高亮等附加遮罩 */
    extraMaskMeshes?: Ref<THREE.Mesh[]> | ShallowRef<THREE.Mesh[]>
  }): void {
    const update = (): void => {
      if (!this.outlinePass) return
      const items = options.selectionItems.value
      const hov = options.highlightOnHover.value ? options.hoveredBlock.value : null
      let masks: THREE.Mesh[] = []
      if (options.outlinePlans !== undefined) {
        // ── C9 生产路径：拾取引用 → 规划器 → mask ──
        const picks: OutlinePickRef[] = []
        const pushEntity = (ref: { pos: { x: number; y: number; z: number }; partLocalId?: string }): void => {
          picks.push(ref.partLocalId === undefined ? { pos: ref.pos } : { pos: ref.pos, partLocalId: ref.partLocalId })
        }
        // 「同格不同部件不是同一个悬停目标」（B-1：部件身份参与重复判定）。
        const dup = hov !== null && [...items].some(
          e => e.kind === 'block'
            && e.ref.pos.x === hov.pos.x && e.ref.pos.y === hov.pos.y && e.ref.pos.z === hov.pos.z
            && e.ref.partLocalId === hov.partLocalId,
        )
        // 预算判据与 legacy **同一口径**：命中总数（选择集 ∪ 悬停）超上限 ⇒ 一个都不画，
        // 而**不是**只丢掉超出的那些（legacy 的 `entities.size > OUTLINE_MASK_LIMIT ⇒ []`
        // 就是这个意思；`outlineMaskStats.dropped` 由下面的 `applyOutlineMaskBudget` 报）。
        const entityCount = items.size + (hov !== null && !dup ? 1 : 0)
        if (entityCount > 0 && entityCount <= OUTLINE_MASK_LIMIT) {
          if (hov !== null && !dup) pushEntity(hov)
          for (const e of items) if (e.kind === 'block') pushEntity(e.ref)
        }
        const outcome = options.outlinePlans.planPicks(picks)
        masks = plansToMaskMeshes(outcome.plans)
        // 跳过是**真实事实**（过期求值/缺几何/目标不完整），必须可见 —— 与
        // `presenterErrors` 同一纪律（不静默当"画好了"）。
        this.outlineSkipped.value = outcome.skipped.length === 0
          ? []
          : outcome.skipped.map((s) => `${s.kind}:${s.detail}`)
      } else if (!hov) {
        if (items.size > 0 && items.size <= OUTLINE_MASK_LIMIT) {
          masks = this.highlightProvider.build(
            items,
            options.getBlockGeometry,
            options.gridCenterWorld,
            options.getPartMaskGeometry,
          )
        }
      } else {
        const entities = new Set(items)
        // 同格不同部件不是同一个悬停目标（B-1：部件身份参与重复判定）
        const dup = [...items].some(
          e => e.kind === 'block'
            && e.ref.pos.x === hov.pos.x && e.ref.pos.y === hov.pos.y && e.ref.pos.z === hov.pos.z
            && e.ref.partLocalId === hov.partLocalId,
        )
        if (!dup) entities.add({ kind: 'block', ref: hov })
        if (entities.size > 0 && entities.size <= OUTLINE_MASK_LIMIT) {
          masks = this.highlightProvider.build(
            entities,
            options.getBlockGeometry,
            options.gridCenterWorld,
            options.getPartMaskGeometry,
          )
        }
      }
      // `extraMaskMeshes`（Embed 侧栏点选高亮）与选择/悬停 mask **共享同一预算**：整体 ≤ 上限。
      // B-5 之前这条通道无上限（大命中集合直接把描边通道压垮、且用户毫无察觉）——#38 收口：
      // 超出即截断，并把 `{ total, shown, dropped }` 写到 `outlineMaskStats` 供上层提示。
      const budget = applyOutlineMaskBudget(masks, options.extraMaskMeshes?.value ?? [])
      const stats = { total: budget.total, shown: budget.shown, dropped: budget.dropped }
      const prev = this.outlineMaskStats.value
      if (prev.total !== stats.total || prev.shown !== stats.shown || prev.dropped !== stats.dropped) {
        this.outlineMaskStats.value = stats
      }

      this.outlinePass.setMaskMeshes(budget.all.map((m) => toRaw(m)))
    }
    const sources: unknown[] = [
      options.selectionItems,
      options.hoveredBlock,
      options.highlightOnHover,
    ]
    if (options.extraMaskMeshes) sources.push(options.extraMaskMeshes)
    this.stopOutlineWatch = watch(
      sources,
      update,
      { deep: true, flush: 'post' },
    )
    update()
  }
}
