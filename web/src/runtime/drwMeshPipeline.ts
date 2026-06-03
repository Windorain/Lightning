/**
 * DRW 内部 mesh/材质/帧管线（不 import Context，只订阅 Ref）。
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

function formatError(err: unknown): string {
  return formatUnknownError(err)
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
  worldFrameIndex: Ref<number>
  layerWorldY: Ref<number>
  framesPlaybackIsPlaying: Ref<boolean>
  blockIconCacheOptions: { sizePx?: number; orthoHalf?: number }
  initialWorldFrameIndex?: number
  /** structEpoch 递增 → 触发 rebuildAll（外部文档刷新时） */
  structEpochRef: Ref<number>
  /** overlay pass 可见性（Embed 偏好等）；默认始终显示 */
  showAnnotationsRef?: Ref<boolean>
  /** 主场景深度注解根（ViewportSlot，供拾取） */
  worldAnnotationGroupRef?: ShallowRef<THREE.Group | null>
  /** overlay pass 内工具预览根（ViewportSlot） */
  toolsOverlayGroupRef?: ShallowRef<THREE.Group | null>
  /** 换帧时经 Operator 写入（避免 DRW 直改 ref） */
  setFrameIndex?: (index: number) => void | Promise<void>
  /** 停/启播放时经 Operator 写入 */
  setFramesPlayback?: (playing: boolean) => void | Promise<void>
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
  setCurrentWorldFrame(index: number): Promise<void>
  disposeCachesAndLibrary(): void
  /** 清空缓存后重新加载结构 + 重建 mesh（替代原 reloadFromConfig） */
  rebuildAll(): Promise<void>
  /** 注册 structEpoch 内部 watch；须在 registerScene 之后调用 */
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
    framesPlaybackIsPlaying, blockIconCacheOptions, initialWorldFrameIndex, structEpochRef, setFrameIndex, setFramesPlayback,
    showAnnotationsRef: showAnnotationsRefIn,
    worldAnnotationGroupRef,
    toolsOverlayGroupRef,
  } = deps

  const showAnnotationsRef = showAnnotationsRefIn ?? ref(true)

  function stopPlayback(): void {
    if (setFramesPlayback) void Promise.resolve(setFramesPlayback(false))
    else framesPlaybackIsPlaying.value = false
  }

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
  let stopStructEpochWatch: (() => void) | null = null
  let stopFrameIndexWatch: (() => void) | null = null
  let stopPlaybackWatch: (() => void) | null = null
  let stopLayerWorldYWatch: (() => void) | null = null
  let suppressFrameIndexWatch = false

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
    return `${worldFrameIndex.value}:${y < 0 ? 'a' : `y${y}`}`
  }

  async function presentContentMesh(): Promise<void> {
    const def = structureDefinition.value
    const scene = sceneRef.value
    if (!def || !scene) return

    const lib = textureCache.value
    if (!lib || lib.isDisposed()) {
      console.warn('[drw] presentContentMesh: textureCache not ready, triggering rebuildAll')
      void rebuildAll().catch(e => {
        console.error('[drw] rebuildAll (from presentContentMesh) failed:', e)
      })
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

  // ---- 帧播放控制 ----
  const DEFAULT_WORLD_FRAME_DWELL_MS = 50
  function normalizeWorldFrameListIndex(w: { frames: unknown[] }, raw: number): number {
    const n = w.frames.length
    if (n === 0) return 0
    const i = Math.floor(raw)
    return ((i % n) + n) % n
  }

  let worldPlaybackTimeoutId: ReturnType<typeof setTimeout> | null = null

  function clearWorldPlaybackSchedule(): void {
    if (worldPlaybackTimeoutId !== null) {
      clearTimeout(worldPlaybackTimeoutId)
      worldPlaybackTimeoutId = null
    }
  }

  function dwellMsForCurrentWorldFrame(): number {
    const doc = docRef.value
    if (!doc || doc.frameCount === 0) return DEFAULT_WORLD_FRAME_DWELL_MS
    const f = doc.frame(worldFrameIndex.value)
    const d = f?.durationMs
    if (typeof d === 'number' && Number.isFinite(d) && d > 0) return d
    return DEFAULT_WORLD_FRAME_DWELL_MS
  }

  function scheduleNextWorldFrameStep(): void {
    clearWorldPlaybackSchedule()
    if (!framesPlaybackIsPlaying.value) return

    const doc = docRef.value
    if (!doc || doc.frameCount < 2) return
    const n = doc.frameCount
    const delay = dwellMsForCurrentWorldFrame()
    const fromIndex = worldFrameIndex.value

    worldPlaybackTimeoutId = setTimeout(() => {
      worldPlaybackTimeoutId = null
      if (!framesPlaybackIsPlaying.value) return
      let next = fromIndex + 1
      if (next >= n) next = 0
      const advance = setFrameIndex
        ? () => Promise.resolve(setFrameIndex(next))
        : () => setCurrentWorldFrame(next)
      void advance().then(() => {
        if (framesPlaybackIsPlaying.value) scheduleNextWorldFrameStep()
      }).catch(() => { stopPlayback() })
    }, delay)
  }

  /** 多帧：按索引解析 bundle 并呈现结构 mesh（唯一换帧入口） */
  async function setCurrentWorldFrame(rawNext: number): Promise<void> {
    const doc = docRef.value
    if (!doc || doc.frameCount === 0) return
    return runMesh(async () => {
      const plain = doc.serialize()
      if (!isWorldDocument(plain) || plain.frames.length === 0) return
      const idx = normalizeWorldFrameListIndex(plain, rawNext)
      if (worldFrameIndex.value !== idx) {
        suppressFrameIndexWatch = true
        worldFrameIndex.value = idx
        suppressFrameIndexWatch = false
      }

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

    stopStructEpochWatch?.()
    stopStructEpochWatch = watch(structEpochRef, () => {
      void rebuildAll().catch(e => {
        console.error('[drw] rebuildAll (structEpoch watch) failed:', e)
        loadStatus.value = 'error'
      })
    })

    stopFrameIndexWatch?.()
    stopFrameIndexWatch = watch(worldFrameIndex, (idx, prev) => {
      if (suppressFrameIndexWatch || idx === prev) return
      const doc = docRef.value
      if (!doc || doc.frameCount < 2) return
      const plain = doc.serialize()
      if (!isWorldDocument(plain) || plain.frames.length === 0) return
      void setCurrentWorldFrame(idx)
    })

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

    stopPlaybackWatch?.()
    stopPlaybackWatch = watch(framesPlaybackIsPlaying, (playing) => {
      if (playing) scheduleNextWorldFrameStep()
      else clearWorldPlaybackSchedule()
    })
  }

  async function loadStructureAndResources(): Promise<void> {
    const preserveViewport = loadStatus.value === 'ok'
    clearWorldPlaybackSchedule()
    stopPlayback()
    clearAllMeshStorage()
    if (!preserveViewport) loadStatus.value = 'loading'
    try {
      const doc = docRef.value
      if (!doc) { loadStatus.value = 'error'; return }
      const plain = doc.serialize()
      const frameIdx = preserveViewport ? worldFrameIndex.value : initialWorldFrameIndex
      const resolved: RenderBundleResolveResult = resolveRenderBundle(
        { document: plain },
        frameIdx,
      )
      if (!preserveViewport) {
        if (resolved.worldFrameIndex !== undefined) worldFrameIndex.value = resolved.worldFrameIndex
        else worldFrameIndex.value = 0
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

  async function rebuildAll(): Promise<void> {
    clearAllMeshStorage()
    disposeIconCache()
    textureCache.value?.dispose()
    textureCache.value = null
    await loadStructureAndResources()
    if (loadStatus.value === 'ok') await rebuildContentMesh()
  }

  function disposeCachesAndLibrary(): void {
    clearWorldPlaybackSchedule()
    stopPlayback()
    unbindOverlayPass()
    clearAllMeshStorage()
    mainMeshGroup.value = null
    disposeIconCache()
    textureCache.value?.dispose()
    textureCache.value = null
    structureDefinition.value = null
    tooltipPalette.value = []
    worldFrameIndex.value = 0
    sceneRef.value = null
  }

  function dispose(): void {
    stopAnnotationPassWatch?.()
    stopAnnotationPassWatch = null
    stopStructEpochWatch?.()
    stopStructEpochWatch = null
    stopFrameIndexWatch?.()
    stopFrameIndexWatch = null
    stopPlaybackWatch?.()
    stopPlaybackWatch = null
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
    disposeCachesAndLibrary,
    rebuildAll,
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
