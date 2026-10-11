/**
 * DRW 内部 mesh/材质/帧管线（不 import Context，只订阅 Ref）。
 *
 * ## 本文件的退役改造（#249 §15 第 5 条，本批 P5）
 *
 * **被删除**：`structEpochRef` 观察者 + `rebuildAll()` 全量失效。
 *
 * 旧形状是「`structEpoch` 自增 ⇒ `rebuildAll()`（清空全部 mesh 缓存 + 重解码全部纹理 +
 * 重建资源 + 重建 mesh）」。它有两个不可接受的后果，且都已被实测（G1/A11）：
 *  - 改一个注解文字 ⇒ 全量重建方块几何（G1 判红）；
 *  - 移动方块 ⇒ 连纹理一起重解码（`bindMultiblockMeshSync` 不得不**手工绕开**
 *    `rebuildAll` 只调 `loadStructureAndResources()` + `rebuildContentMesh()`，
 *    那正是 §15 要删的"调用方手动刷新、版本补丁"）。
 *
 * **替代物**：`contentRefreshTick` 只表示"内容**可能**变了，请重读"。本文件用
 * `presentation/contentIdentity` 从数据算出身份，再按 `RebuildPlan` **分范围**执行：
 *
 * | 计划位 | 执行的动作 | 旧全量行为 |
 * |---|---|---|
 * | `reloadResources` | 释放并重建纹理/图标缓存 | 每次都做 |
 * | `resolveStructure` | 重解结构定义 + 图标缓存 | 每次都做 |
 * | `rebuildGeometry` | 重建 mesh | 每次都做 |
 * | `syncAnnotations` | 同步注解叠加层 | 每次都做（且 mesh 重建是副作用） |
 *
 * 于是「改注解」只做最后一项、「移动方块」不碰纹理 —— 两条都由**内容身份**决定，
 * 不由任何调用方声明。
 */
import { computed, ref, shallowRef, watch, type ComputedRef, type Ref, type ShallowRef } from 'vue'
import * as THREE from 'three'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import type { LoadStatus } from '@/runtime/types'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import type { LayerPreviewMode } from '@/render/data/layerPreview'
import type { StructureDefinition } from '@/render/schema/types'
import { type Annotation, annotationIsOnLayer } from '@/render/data/annotationTypes'
import { disposeAnnotationGroup } from '@/render/mesh/annotationMeshProvider'
import type { BlockStatRow } from '@/render/interaction/blockStats'
import type { BlockMeshBuildStats } from '@/render/mesh/blockMesh'
import { buildBlockStatsEntries } from '@/render/interaction/blockStats'
import { BlockMeshProvider } from '@/render/mesh/blockMeshProvider'
import { AnnotationMeshProvider } from '@/render/mesh/annotationMeshProvider'
import { buildMaterialLibrary } from '@/render/data/buildMaterialLibrary'
import { isWorldDocument, resolveRenderBundle, type RenderBundleResolveResult } from '@/render/data/bundleResolve'
import { formatUnknownError } from '@/util/formatUnknownError'
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
import { readContentIdentity } from '@/runtime/presentationAdapter'

function formatError(err: unknown): string {
  return formatUnknownError(err)
}

/**
 * 帧下标取模归一（纯；把任意整数折进 `[0, n)`）。
 *
 * 保留在本文件（而不是挪进内核）的理由：它是**呈现侧**的归一化 ——
 * 内核派生的帧下标已经是合法的（离散阶跃采样恒落在定义域内），
 * 这里归一化的是"呈现请求"里可能越界的原始值（例如 `seekFrame(999)`）。
 * 两者职责不同：内核保证**产出**合法，呈现保证**请求**合法。
 */
function normalizeWorldFrameListIndex(w: { frames: unknown[] }, raw: number): number {
  const n = w.frames.length
  if (n === 0) return 0
  const i = Math.floor(raw)
  return ((i % n) + n) % n
}

interface WorldMeshEntry {
  group: THREE.Group
  dispose: () => void
  stats: BlockMeshBuildStats
}

export interface DrwMeshPipelineDeps {
  /** 场景文档（RuntimeDocument；render 管线内部按需调用 serialize() 获取 plain JSON） */
  docRef: Ref<RuntimeDocument | null>
  loadStatus: Ref<LoadStatus>
  meshBusy: Ref<boolean>
  blockIconCache: ShallowRef<BlockIconCache | null>
  tooltipPalette: ShallowRef<string[]>
  structureDefinition: ShallowRef<StructureDefinition | null>
  mainMeshGroup: ShallowRef<THREE.Group | null>
  sceneRef: ShallowRef<THREE.Scene | null>
  /**
   * **世界帧下标**（P10 #261：由内核会话提供的**派生**值，不再是 `Main` 上的 Ref）。
   *
   * 它是一个**只读**的 getter，不是 `Ref` —— 这一点是刻意的：
   * 旧形态下本管线可以（也确实）直接写这个 Ref（`worldFrameIndex.value = idx`），
   * 于是"谁在推进帧"有两个答案（本管线的 `setCurrentWorldFrame` 与 operator）。
   * 现在帧下标由 `EditContext.time` 派生，唯一的写路径是 `setTime` 命令
   * （经 `setFrameIndex` 注入）—— 本管线只能**读**。
   *
   * 为什么是函数而不是 `Ref`：若给一个 `computed`，Vue 的响应式依赖收集会
   * 让本管线在每次时间变化时被唤醒（包括"时间在动但帧没变"的那些次）。
   * 函数形式让"什么时候读"由调用点决定，与旧 `worldFrameIndex.value` 的
   * 读取时机一致（换帧路径 + 缓存键 + 内容身份）。
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
  /** overlay pass 可见性（Embed 偏好等）；默认始终显示 */
  showAnnotationsRef?: Ref<boolean>
  /** 主场景深度注解根（ViewportSlot，供拾取） */
  worldAnnotationGroupRef?: ShallowRef<THREE.Group | null>
  /** overlay pass 内工具预览根（ViewportSlot） */
  toolsOverlayGroupRef?: ShallowRef<THREE.Group | null>
  /**
   * 换帧（P10 #261）：写**时间**，不是写帧下标。
   *
   * 语义变化是本质的：旧接口 `setFrameIndex(index)` 直接写一个独立权威
   * （`Main.currentFrameIndex`），于是"帧"与"时间"可以互相矛盾。
   * 新接口 `seekFrame(index)` 经 `setTime` 命令按帧时长轴换算成时间 ——
   * 于是"跳到第 3 帧"与"播放到第 3 帧"落在**同一个**时间值上（A09）。
   *
   * `worldFrameIndex` 提供的 getter 会随这次写而变化（它是派生值）。
   */
  seekFrame?: (index: number) => void | Promise<void>
  /**
   * 时间是否在前进（P10 #261：替代旧的 `framesPlaybackIsPlaying` Ref）。
   *
   * 本管线用它做的唯一判断是"要不要在换帧后继续等待下一帧"——
   * 而那个等待现在是**宿主的帧时钟**（`composition/kernelRuntime`）的事，
   * 不是本管线的定时器。故本字段只用于**呈现侧**的显示（播放按钮状态）
   * 与"是否继续跟随"的观测，不驱动任何调度。
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
  rebuildContentMesh(): Promise<void>
  /** 绑定 RenderEngine overlay pass 根 Group（注解层由 DRW 独占子树） */
  bindOverlayPass(group: THREE.Group): void
  unbindOverlayPass(): void
  /**
   * 请求内核把时间定位到某帧（**唯一**换帧入口）。
   *
   * 它**不**改本地帧下标（那是派生值）—— 改时间就是改帧。
   */
  setCurrentWorldFrame(index: number): Promise<void>
  /**
   * 按给定帧下标解析 bundle 并呈现（**呈现**；不改帧下标）。
   *
   * 与 `setCurrentWorldFrame` 的分工：后者是"请求换帧"（写面），
   * 本方法是"把某一帧画出来"（读面 + 绘制）。宿主的帧时钟在观测到
   * 帧下标变化时调本方法 —— 于是"谁决定换帧"（内核时间）与
   * "谁负责画"（呈现）在类型上是两件事。
   */
  presentWorldFrame(index: number): Promise<void>
  disposeCachesAndLibrary(): void
  /**
   * 按**内容身份**应用一次内容重读（原 `rebuildAll()` 的位置）。
   *
   * 返回本次实际执行的 `RebuildPlan`；内容未变时返回 `null`（**什么都不做**）。
   * 这是 `contentRefreshTick` 观察者的唯一执行体，也是"无手动刷新"的实现落点：
   * 调用方只能请求重读，不能指定重建范围。
   */
  applyContentRefresh(source: string): Promise<RebuildPlan | null>
  /** 注册内容重读观察者；须在 registerScene 之后调用 */
  init(): void
  /** 解构 init 注册的 watch */
  dispose(): void
  /** 内部纹理缓存（供 RenderEngine 渲染用，只读） */
  textureCache: Readonly<ShallowRef<MaterialLibraryApi | null>>
  computed: DrwComputed
}

export function createDrwMeshPipeline(deps: DrwMeshPipelineDeps): DrwMeshPipeline {
  const {
    docRef, loadStatus, meshBusy, blockIconCache, tooltipPalette,
    structureDefinition, mainMeshGroup, sceneRef, worldFrameIndex, layerWorldY,
    blockIconCacheOptions, initialWorldFrameIndex, contentRefreshTickRef, seekFrame,
    showAnnotationsRef: showAnnotationsRefIn,
    worldAnnotationGroupRef,
    toolsOverlayGroupRef,
  } = deps

  const showAnnotationsRef = showAnnotationsRefIn ?? ref(true)

  /**
   * 当前帧下标 —— **每次现读**（派生值）。
   *
   * 不缓存在局部变量里：帧下标由 `EditContext.time` 派生，
   * 缓存它就会重新引入"两个权威"（缓存值与真值可以漂移）。
   */
  const frameIndex = (): number => worldFrameIndex()

  // === 内部纹理缓存，从 doc.textureBlobs 构建 ===
  const textureCache = shallowRef<MaterialLibraryApi | null>(null)

  /** 确保 textureCache 就绪；已完成则直接返回。 */
  async function ensureTextures(doc: RuntimeDocument, plain?: Record<string, unknown>): Promise<MaterialLibraryApi | null> {
    if (textureCache.value && !textureCache.value.isDisposed()) return textureCache.value
    try {
      textureCache.value = await buildMaterialLibrary(plain ?? doc.serialize())
      return textureCache.value
    } catch (e) {
      console.error('[drw] buildMaterialLibrary failed', e)
      return null
    }
  }

  const blockMeshProvider = new BlockMeshProvider()
  const annotationProvider = new AnnotationMeshProvider()

  // ---- Overlay pass（与 main structure 并列，由 DRW 统一同步）----
  let overlayPassTarget: THREE.Group | null = null
  let overlayToolsRoot: THREE.Group | null = null
  let overlayAnnotationRoot: THREE.Group | null = null
  let overlayAnnotationMesh: THREE.Group | null = null
  let structureAnnotationRoot: THREE.Group | null = null
  let structureAnnotationMesh: THREE.Group | null = null
  let annotationSyncGen = 0
  let stopAnnotationPassWatch: (() => void) | null = null

  function readDocumentAnnotations(): Annotation[] {
    const doc = docRef.value
    if (!doc) return []
    let annos = (doc.annotations ?? []) as Annotation[]
    const mode = layerPreviewMode.value
    if (mode !== 'all') {
      const gh = gridHeight.value
      annos = annos.filter(a => annotationIsOnLayer(a, mode.worldY, gh))
    }
    return annos
  }

  function detachOverlayAnnotationMesh(): void {
    if (overlayAnnotationMesh) {
      overlayAnnotationRoot?.remove(overlayAnnotationMesh)
      disposeAnnotationGroup(overlayAnnotationMesh)
      overlayAnnotationMesh = null
    }
  }

  function detachStructureAnnotationMesh(): void {
    if (structureAnnotationMesh) {
      structureAnnotationRoot?.remove(structureAnnotationMesh)
      disposeAnnotationGroup(structureAnnotationMesh)
      structureAnnotationMesh = null
    }
  }

  function ensureStructureAnnotationRoot(scene: THREE.Scene): THREE.Group {
    if (!structureAnnotationRoot) {
      structureAnnotationRoot = new THREE.Group()
      structureAnnotationRoot.name = 'drw-structure-annotations'
      scene.add(structureAnnotationRoot)
    } else if (structureAnnotationRoot.parent !== scene) {
      structureAnnotationRoot.parent?.remove(structureAnnotationRoot)
      scene.add(structureAnnotationRoot)
    }
    if (worldAnnotationGroupRef) worldAnnotationGroupRef.value = structureAnnotationRoot
    return structureAnnotationRoot
  }

  function clearStructureAnnotationRootRef(): void {
    if (structureAnnotationRoot?.parent) structureAnnotationRoot.parent.remove(structureAnnotationRoot)
    structureAnnotationRoot = null
    if (worldAnnotationGroupRef) worldAnnotationGroupRef.value = null
  }

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

  function ensureOverlayAnnotationRoot(): THREE.Group | null {
    const target = overlayPassTarget
    if (!target) return null
    if (!overlayAnnotationRoot) {
      overlayAnnotationRoot = new THREE.Group()
      overlayAnnotationRoot.name = 'drw-overlay-annotations'
      target.add(overlayAnnotationRoot)
    } else if (overlayAnnotationRoot.parent !== target) {
      overlayAnnotationRoot.parent?.remove(overlayAnnotationRoot)
      target.add(overlayAnnotationRoot)
    }
    return overlayAnnotationRoot
  }

  /** 文档注解 → 按 overlay 属性挂到 main / overlay pass（唯一同步入口） */
  async function syncAnnotations(): Promise<void> {
    const gen = ++annotationSyncGen
    const def = structureDefinition.value
    const scene = sceneRef.value
    const annos = readDocumentAnnotations()

    if (!showAnnotationsRef.value || !def) {
      detachOverlayAnnotationMesh()
      detachStructureAnnotationMesh()
      if (overlayAnnotationRoot) overlayAnnotationRoot.visible = false
      if (structureAnnotationRoot) structureAnnotationRoot.visible = false
      return
    }

    const buckets = annotationProvider.buildBuckets(def, annos)
    if (gen !== annotationSyncGen) return

    if (overlayPassTarget) {
      const root = ensureOverlayAnnotationRoot()
      if (root) {
        root.visible = true
        detachOverlayAnnotationMesh()
        if (buckets.overlay) {
          overlayAnnotationMesh = buckets.overlay
          root.add(buckets.overlay)
        }
      }
    } else {
      detachOverlayAnnotationMesh()
    }

    if (scene) {
      const worldRoot = ensureStructureAnnotationRoot(scene)
      worldRoot.visible = true
      detachStructureAnnotationMesh()
      if (buckets.world) {
        structureAnnotationMesh = buckets.world
        worldRoot.add(buckets.world)
      }
    } else {
      detachStructureAnnotationMesh()
    }
  }

  function bindOverlayPass(group: THREE.Group): void {
    overlayPassTarget = group
    ensureToolsOverlayRoot()
    void runMesh(() => syncAnnotations())
  }

  function unbindOverlayPass(): void {
    annotationSyncGen++
    detachOverlayAnnotationMesh()
    detachStructureAnnotationMesh()
    if (overlayAnnotationRoot?.parent) overlayAnnotationRoot.parent.remove(overlayAnnotationRoot)
    overlayAnnotationRoot = null
    clearStructureAnnotationRootRef()
    clearToolsOverlayRootRef()
    overlayPassTarget = null
  }

  const worldMeshCache = new Map<string, WorldMeshEntry>()
  let nonWorldMeshDispose: (() => void) | null = null
  let stopContentRefreshWatch: (() => void) | null = null
  let stopLayerWorldYWatch: (() => void) | null = null
  /** 资源缺失时的一次性恢复哨兵（避免"解码持续失败 ⇒ 无限递归"）。 */
  let resourceRecoveryRetry = false

  // ---- Computed ----
  const worldFrameCount = computed(() => docRef.value?.frameCount ?? 0)
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

  // ---- Mesh pipeline ----
  let meshPipeline: Promise<unknown> = Promise.resolve()
  function runMesh<T>(fn: () => Promise<T>): Promise<T> {
    const p = meshPipeline.then(fn)
    meshPipeline = p.then(() => {}, () => {}) as Promise<unknown>
    return p
  }

  function clearAllMeshStorage(): void {
    for (const e of worldMeshCache.values()) e.dispose()
    worldMeshCache.clear()
    nonWorldMeshDispose?.()
    nonWorldMeshDispose = null
  }

  function worldMeshKey(): string {
    const y = layerWorldY.value
    return `${frameIndex()}:${y < 0 ? 'a' : `y${y}`}`
  }

  async function presentContentMesh(): Promise<void> {
    const def = structureDefinition.value
    const scene = sceneRef.value
    if (!def || !scene) return

    const lib = textureCache.value
    if (!lib || lib.isDisposed()) {
      // 资源缓存不在了（被释放/从未建立）但内容身份**没变** —— 这不是"内容变化"，
      // 因此**不**走内容信号（走了也会正确地返回 null）。这里做的是**资源恢复**：
      // 重解一次（`loadStructureAndResources` 会在缓存缺失时重新解码）后重试呈现。
      // 用一次性哨兵避免"解码持续失败 ⇒ 无限递归"。
      if (!resourceRecoveryRetry) {
        resourceRecoveryRetry = true
        console.warn('[drw] presentContentMesh: textureCache 不可用，正在恢复资源后重试')
        void runMesh(async () => {
          await loadStructureAndResources()
          resourceRecoveryRetry = false
          if (loadStatus.value === 'ok') await presentContentMesh()
        }).catch((e: unknown) => {
          resourceRecoveryRetry = false
          console.error('[drw] presentContentMesh: 资源恢复失败', e)
        })
      }
      return
    }

    const isW = (docRef.value?.frameCount ?? 0) > 1
    const layerPreview = layerPreviewMode.value

    meshBusy.value = true
    try {
      if (isW) {
        const k = worldMeshKey()
        const hit = worldMeshCache.get(k)
        if (hit) {
          if (mainMeshGroup.value === hit.group && hit.group.parent === scene) return
          if (mainMeshGroup.value) scene.remove(mainMeshGroup.value)
          mainMeshGroup.value = hit.group
          scene.add(hit.group)
          return
        }
        const outputs = await blockMeshProvider.build(def, lib, { layerPreview })
        const out = outputs[0]! as Extract<import('@/render/mesh/providerTypes').MeshOutput, { kind: 'object3d' }>
        const result = { group: out.object as THREE.Group, dispose: out.dispose, stats: out.stats! }
        if (lib.isDisposed() || textureCache.value !== lib) { result.dispose(); return }
        worldMeshCache.set(k, { group: result.group, dispose: result.dispose, stats: result.stats })
        if (mainMeshGroup.value) scene.remove(mainMeshGroup.value)
        mainMeshGroup.value = result.group
        scene.add(result.group)
        return
      }
      const outputs = await blockMeshProvider.build(def, lib, { layerPreview })
      const out = outputs[0]! as Extract<import('@/render/mesh/providerTypes').MeshOutput, { kind: 'object3d' }>
      const result = { group: out.object as THREE.Group, dispose: out.dispose, stats: out.stats! }
      if (lib.isDisposed() || textureCache.value !== lib) { result.dispose(); return }
      if (mainMeshGroup.value) { scene.remove(mainMeshGroup.value); nonWorldMeshDispose?.(); nonWorldMeshDispose = null }
      nonWorldMeshDispose = result.dispose
      mainMeshGroup.value = result.group
      scene.add(result.group)
    } catch (e) {
      const fe = formatError(e)
      if (fe.includes('MaterialLibrary 已释放')) return
      console.error('[drw] buildBlockMesh', e)
    } finally {
      meshBusy.value = false
    }
    await syncAnnotations()
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

  // ---- 帧播放（P10 #261：**已删除**专用播放调度器） ----
  //
  // ## 被删除的机制（B5 #8 `frame-sequence-as-animation`；R-WK-03 明列）
  //
  // 旧实现是本文件里一个**自续的 `setTimeout` 链**：
  //
  // ```ts
  // let worldPlaybackTimeoutId = null
  // function scheduleNextWorldFrameStep() {
  //   clearWorldPlaybackSchedule()
  //   if (!framesPlaybackIsPlaying.value) return
  //   const delay = dwellMsForCurrentWorldFrame()
  //   worldPlaybackTimeoutId = setTimeout(() => {
  //     setFrameIndex(next)                        // 写 Main.currentFrameIndex
  //     if (framesPlaybackIsPlaying.value) scheduleNextWorldFrameStep()
  //   }, delay)
  // }
  // ```
  //
  // 它是**帧专用**的播放调度器（#249 §7 明文要退役的"另建专用播放循环"），
  // 且它的时间**不来自** `EditContext` —— 于是：
  //  - 两个 Area 各持一份 `framesPlaybackIsPlaying` 读法，各播各的（A05 的形态）；
  //  - 面板里看到的帧（按 `durationMs` 累加算）与视口里播放到的帧（按定时器算）
  //    可以不一致；
  //  - "跳帧"与"连续播放到同一时刻"落在不同路径上（#249 §7 要消除的分叉）。
  //
  // ## 替代（本条现在**没有**任何定时器）
  //
  //  - **谁推进**：宿主的帧时钟（`composition/kernelRuntime`）每帧把经过秒数
  //    作为 `advancePlayback` 命令注入内核；
  //  - **帧下标从哪来**：`EditContext.time` 经离散阶跃采样派生（`worldFrameIndex()`）；
  //  - **本管线做什么**：当派生出的帧下标**变化**时，重建 mesh 呈现新帧。
  //    它不拥有时间、不拥有调度、不拥有"正在播放"这个状态。
  //
  // ⇒ 本文件里 `setTimeout`/`setInterval` 零出现；"帧专用播放循环"不存在。
  //    `dwellMsForCurrentWorldFrame` / `scheduleNextWorldFrameStep` /
  //    `clearWorldPlaybackSchedule` / `worldPlaybackTimeoutId` 四个符号全部删除。

  /**
   * 换帧（**唯一**入口）：请求内核把时间定位到某帧。
   *
   * 它**不**直接改任何本地状态 —— 帧下标是派生值，改时间就是改帧。
   * `seekFrame` 由接线层注入（内部经 `setTime` 命令）。
   */
  async function setCurrentWorldFrame(rawNext: number): Promise<void> {
    const doc = docRef.value
    if (!doc || doc.frameCount === 0) return
    if (seekFrame) {
      await Promise.resolve(seekFrame(rawNext))
      return
    }
    // 没有接线（例如单测直接构造本管线）：显式不做，**不**静默假装换帧成功。
    console.warn('[drw] setCurrentWorldFrame: 未注入 seekFrame（内核会话未接线）')
  }

  /** 由帧下标解析 bundle 并呈现结构 mesh（**呈现**，不改帧下标）。 */
  async function presentWorldFrame(index: number): Promise<void> {
    const doc = docRef.value
    if (!doc || doc.frameCount === 0) return
    return runMesh(async () => {
      const plain = doc.serialize()
      if (!isWorldDocument(plain) || plain.frames.length === 0) return
      const idx = normalizeWorldFrameListIndex(plain, index)

      const resolved: RenderBundleResolveResult = resolveRenderBundle({ document: plain }, idx)
      structureDefinition.value = resolved.definition
      tooltipPalette.value = resolved.tooltipPalette

      const lib = textureCache.value
      if (!lib || lib.isDisposed()) return

      rebuildIconCache(lib, resolved.definition)
      await presentContentMesh()
    })
  }

  // ---- Lifecycle ----
  function registerScene(scene: THREE.Scene): void {
    sceneRef.value = scene
  }

  function init(): void {
    stopAnnotationPassWatch?.()
    // 仅文档注解 / 图层过滤 / 显隐；结构重建由 presentContentMesh / rebuildAll 末尾同步
    stopAnnotationPassWatch = watch(
      [docRef, layerWorldY, showAnnotationsRef],
      () => { void runMesh(() => syncAnnotations()) },
      { flush: 'post' },
    )

    stopContentRefreshWatch?.()
    stopContentRefreshWatch = watch(contentRefreshTickRef, () => {
      void applyContentRefresh('content-refresh-tick').catch(e => {
        console.error('[drw] content refresh failed:', e)
        loadStatus.value = 'error'
      })
    })

    // **帧下标观察者已删除**（P10 #261）：旧实现 watch 一个 `Ref<number>`
    // （`Main.currentFrameIndex`），在它变化时换 mesh。现在帧下标是**派生值**
    // （`frameIndex()`），没有可 watch 的独立源 —— 换帧由宿主的帧时钟
    // （`composition/kernelRuntime` 的 `onFrame`）在**观测到帧下标变化**时
    // 调 `presentWorldFrame(index)` 驱动。
    //
    // 这不是"把 watch 挪了个地方"：旧 watch 的语义是"有人写了帧下标 ⇒ 重绘"，
    // 而写入者可能不是播放（operator、加载路径都写）；新语义是"内核的时间
    // 落在另一帧上 ⇒ 重绘"，判据只有一个（时间），且**不存在**"写了但没生效"
    // 的中间态（时间是不可变值，一次发布就是一次一致快照）。

    stopLayerWorldYWatch?.()
    stopLayerWorldYWatch = watch(layerWorldY, () => {
      if (!structureDefinition.value || !sceneRef.value) return
      void runMesh(async () => {
        const scene = sceneRef.value
        const g = mainMeshGroup.value
        if (g && scene) scene.remove(g)
        mainMeshGroup.value = null
        await presentContentMesh()
      }).catch((e: unknown) => {
        console.error('[drw] layer watch mesh rebuild failed', e)
      })
    })

    // **播放观察者已删除**（P10 #261）：旧实现 watch `framesPlaybackIsPlaying`
    // 并在它为真时启动 `scheduleNextWorldFrameStep()` 的 `setTimeout` 自续链。
    // 现在"时间要不要走"是 `EditContext.playing`，由内核的 `advancePlayback`
    // 命令在**宿主注入 delta 时**判定 —— 本管线不再有可启动的调度器。
  }

  async function loadStructureAndResources(): Promise<void> {
    const preserveViewport = loadStatus.value === 'ok'
    clearAllMeshStorage()
    if (!preserveViewport) loadStatus.value = 'loading'
    try {
      const doc = docRef.value
      if (!doc) { loadStatus.value = 'error'; return }
      const plain = doc.serialize()
      const frameIdx = preserveViewport ? frameIndex() : initialWorldFrameIndex
      const resolved: RenderBundleResolveResult = resolveRenderBundle(
        { document: plain },
        frameIdx,
      )
      // 非保留路径：按解析结果**定位时间**（帧下标是派生值 ⇒ 定位就是 seekFrame）。
      // 旧实现直接写 `worldFrameIndex.value`（一个独立权威）；现在没有可写的
      // 帧下标，只有可写的时间 —— 这正是"时间唯一权威"在加载路径上的落点。
      if (!preserveViewport && seekFrame) {
        await Promise.resolve(seekFrame(resolved.worldFrameIndex ?? 0))
      }
      structureDefinition.value = resolved.definition
      tooltipPalette.value = resolved.tooltipPalette
      const lib = textureCache.value
      const effectiveLib = (lib && !lib.isDisposed())
        ? lib
        : await ensureTextures(doc, plain)
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

  async function rebuildContentMesh(): Promise<void> {
    return runMesh(() => presentContentMesh())
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
   * 三件事按 `RebuildPlan` 分范围执行，**并串行化**（`runMesh`）以免两条重建链并发：
   *
   * 1. `reloadResources` ⇒ 释放纹理缓存与图标缓存，强制重新解码（换纹理/换文档）；
   * 2. `resolveStructure` ⇒ 重解结构定义（换帧/改网格/改多方块取值）；
   * 3. `rebuildGeometry` ⇒ 重建 mesh；
   * 4. `syncAnnotations` ⇒ 同步注解叠加层。
   *
   * 内容未变 ⇒ 返回 `null` 且**不做任何事**（旧 `rebuildAll` 在这里必然全量重建）。
   */
  async function applyContentRefresh(source: string): Promise<RebuildPlan | null> {
    const revision = contentSignal.republish(source)
    if (revision === null) return null
    const plan = revision.plan

    return runMesh(async () => {
      if (plan.reloadResources) {
        disposeIconCache()
        textureCache.value?.dispose()
        textureCache.value = null
      }
      if (plan.resolveStructure || plan.reloadResources) {
        // 重解结构：加载路径本身会（在缓存已释放时）重新解码纹理
        await loadStructureAndResources()
      }
      if (plan.rebuildGeometry && loadStatus.value === 'ok') {
        await presentContentMesh()
      } else if (plan.syncAnnotations) {
        await syncAnnotations()
      }
      return plan
    })
  }

  function disposeCachesAndLibrary(): void {
    unbindOverlayPass()
    clearAllMeshStorage()
    mainMeshGroup.value = null
    disposeIconCache()
    textureCache.value?.dispose()
    textureCache.value = null
    structureDefinition.value = null
    tooltipPalette.value = []
    // **不再重置帧下标**（P10 #261）：它是派生值，没有可写的本地状态。
    // "把帧归零"现在是 `setTime` 的职责（内核侧），由宿主在换文档时显式发出。
    sceneRef.value = null
  }

  function dispose(): void {
    stopAnnotationPassWatch?.()
    stopAnnotationPassWatch = null
    stopContentRefreshWatch?.()
    stopContentRefreshWatch = null
    stopLayerWorldYWatch?.()
    stopLayerWorldYWatch = null
  }

  return {
    registerScene,
    loadStructureAndResources,
    rebuildContentMesh,
    bindOverlayPass,
    unbindOverlayPass,
    setCurrentWorldFrame,
    presentWorldFrame,
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
