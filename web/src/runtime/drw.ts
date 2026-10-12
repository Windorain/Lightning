/**
 * DRW — 视口绘制运行时：mesh/材质/帧呈现 + selection outline（不 import Context）。
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
  type DrwComputed,
  type DrwMeshPipeline,
} from '@/runtime/drwMeshPipeline'
import type { BlockRef, SelectedEntity } from '@/context/selection'
import { OUTLINE_MASK_LIMIT, applyOutlineMaskBudget } from '@/presentation/outlineBudget'
import { SelectionHighlightProvider } from '@/render/mesh/selectionHighlightProvider'
import { bindViewportCameraSync } from '@/runtime/viewportCamera'
import type { ViewportCameraState } from '@/runtime/viewportCamera'

export type { DrwComputed } from '@/runtime/drwMeshPipeline'

export interface DRWDeps {
  docRef: Ref<RuntimeDocument | null>
  /** 内容重读请求（原 `structEpochRef`；语义见 `drwMeshPipeline` 文件头） */
  contentRefreshTickRef: Ref<number>
  /**
   * 世界帧下标（P10 #261：**派生**值的只读 getter，不再是 `Ref`）。
   *
   * 见 `DrwMeshPipelineDeps.worldFrameIndex` 的说明：帧下标由
   * `EditContext.time` 派生，本层只能读。
   */
  worldFrameIndex: () => number
  layerWorldY: Ref<number>
  structureDefinition: ShallowRef<StructureDefinition | null>
  mainMeshGroup: ShallowRef<THREE.Group | null>
  blockIconCacheOptions?: { sizePx?: number; orthoHalf?: number }
  initialWorldFrameIndex?: number
  /** 换帧（经 `setTime` 命令定位时间；见 `DrwMeshPipelineDeps.seekFrame`）。 */
  seekFrame?: (index: number) => void | Promise<void>
  /** 时间是否在前进（呈现侧观测；不驱动任何调度）。 */
  isPlaying?: () => boolean
  showAnnotationsRef?: Ref<boolean>
  worldAnnotationGroupRef?: ShallowRef<THREE.Group | null>
  toolsOverlayGroupRef?: ShallowRef<THREE.Group | null>
  viewportCameraRef?: Ref<ViewportCameraState | null>
  cameraRef?: Ref<THREE.Camera | null>
  orbitTargetRef?: Ref<THREE.Vector3 | null>
}

export class DRW {
  readonly sceneRef = shallowRef<THREE.Scene | null>(null)
  readonly loadStatus = ref<LoadStatus>('loading')
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
      loadStatus: this.loadStatus,
      meshBusy: this.meshBusy,
      blockIconCache: this.blockIconCache,
      tooltipPalette: this.tooltipPalette,
      structureDefinition: deps.structureDefinition,
      mainMeshGroup: deps.mainMeshGroup,
      sceneRef: this.sceneRef,
      worldFrameIndex: deps.worldFrameIndex,
      layerWorldY: deps.layerWorldY,
      blockIconCacheOptions: deps.blockIconCacheOptions ?? {},
      initialWorldFrameIndex: deps.initialWorldFrameIndex,
      contentRefreshTickRef: deps.contentRefreshTickRef,
      seekFrame: deps.seekFrame,
      isPlaying: deps.isPlaying,
      showAnnotationsRef: deps.showAnnotationsRef,
      worldAnnotationGroupRef: deps.worldAnnotationGroupRef,
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

  rebuildContentMesh(): Promise<void> {
    return this._mesh.rebuildContentMesh()
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
   * 呈现给定帧（宿主的帧时钟在观测到帧下标变化时调用）。
   *
   * 与 `setCurrentWorldFrame` 的分工见 `DrwMeshPipeline` 的接口说明：
   * 前者是"请求换帧"（写面），本方法是"把某一帧画出来"（呈现）。
   */
  presentWorldFrame(index: number): Promise<void> {
    return this._mesh.presentWorldFrame(index)
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
    /** Embed 侧栏按 blockId 高亮等附加遮罩 */
    extraMaskMeshes?: Ref<THREE.Mesh[]> | ShallowRef<THREE.Mesh[]>
  }): void {
    const update = (): void => {
      if (!this.outlinePass) return
      const items = options.selectionItems.value
      const hov = options.highlightOnHover.value ? options.hoveredBlock.value : null
      let masks: THREE.Mesh[] = []
      if (!hov) {
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
