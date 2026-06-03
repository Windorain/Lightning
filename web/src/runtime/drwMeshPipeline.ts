/**
 * DRW 内部 mesh/材质/帧管线（不 import Context，只订阅 Ref）。
 */
import { computed, shallowRef, watch, type ComputedRef, type Ref, type ShallowRef } from 'vue'
import * as THREE from 'three'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import type { LoadStatus } from '@/runtime/types'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import type { LayerPreviewMode } from '@/render/data/layerPreview'
import type { StructureDefinition } from '@/render/schema/types'
import type { Annotation } from '@/render/data/annotationTypes'
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
  /** 换帧时经 Operator 写入（避免 DRW 直改 ref） */
  setFrameIndex?: (index: number) => void | Promise<void>
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
  rebuildAnnotationOverlay(annotations: Annotation[]): Promise<THREE.Group | null>
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

/** 注解 overlay 所需的最小 DRW 面 */
export type DrwAnnotationApi = Pick<DrwMeshPipeline, 'computed' | 'rebuildAnnotationOverlay'>

export function createDrwMeshPipeline(deps: DrwMeshPipelineDeps): DrwMeshPipeline {
  const {
    docRef, loadStatus, meshBusy, blockIconCache, tooltipPalette,
    structureDefinition, mainMeshGroup, sceneRef, worldFrameIndex, layerWorldY,
    framesPlaybackIsPlaying, blockIconCacheOptions, initialWorldFrameIndex, structEpochRef, setFrameIndex,
  } = deps

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

  const worldMeshCache = new Map<string, WorldMeshEntry>()
  let nonWorldMeshDispose: (() => void) | null = null
  let stopStructEpochWatch: (() => void) | null = null
  let stopFrameIndexWatch: (() => void) | null = null
  let stopPlaybackWatch: (() => void) | null = null
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
      }).catch(() => { framesPlaybackIsPlaying.value = false })
    }, delay)
  }

  async function setCurrentWorldFrame(rawNext: number): Promise<void> {
    const doc = docRef.value
    if (!doc || doc.frameCount === 0) return
    return runMesh(async () => {
      const plain = doc.serialize()
      if (!isWorldDocument(plain) || plain.frames.length === 0) return
      const idx = normalizeWorldFrameListIndex(plain, rawNext)
      suppressFrameIndexWatch = true
      worldFrameIndex.value = idx
      suppressFrameIndexWatch = false

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
      if (setFrameIndex) void Promise.resolve(setFrameIndex(idx))
      else void setCurrentWorldFrame(idx)
    })
    stopPlaybackWatch?.()
    stopPlaybackWatch = watch(framesPlaybackIsPlaying, (playing) => {
      if (playing) scheduleNextWorldFrameStep()
      else clearWorldPlaybackSchedule()
    })
  }

  async function loadStructureAndResources(): Promise<void> {
    clearWorldPlaybackSchedule()
    framesPlaybackIsPlaying.value = false
    clearAllMeshStorage()
    loadStatus.value = 'loading'
    try {
      const doc = docRef.value
      if (!doc) { loadStatus.value = 'error'; return }
      const plain = doc.serialize()
      const resolved: RenderBundleResolveResult = resolveRenderBundle(
        { document: plain },
        initialWorldFrameIndex,
      )
      if (resolved.worldFrameIndex !== undefined) worldFrameIndex.value = resolved.worldFrameIndex
      else worldFrameIndex.value = 0
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

  async function rebuildAnnotationOverlay(annotations: Annotation[]): Promise<THREE.Group | null> {
    const def = structureDefinition.value
    const lib = textureCache.value
    if (!def || !lib || annotations.length === 0) return null
    annotationProvider.setAnnotations(annotations)
    const outputs = await annotationProvider.build(def, lib)
    const out = outputs[0]
    return out?.kind === 'object3d' ? (out.object as THREE.Group) : null
  }

  async function rebuildAll(): Promise<void> {
    clearAllMeshStorage()
    disposeIconCache()
    await loadStructureAndResources()
    if (loadStatus.value === 'ok') await rebuildContentMesh()
  }

  function disposeCachesAndLibrary(): void {
    clearWorldPlaybackSchedule()
    framesPlaybackIsPlaying.value = false
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
    stopStructEpochWatch?.()
    stopStructEpochWatch = null
    stopFrameIndexWatch?.()
    stopFrameIndexWatch = null
    stopPlaybackWatch?.()
    stopPlaybackWatch = null
  }

  // Layer Y reactivity — re-mesh when layer changes
  watch(layerWorldY, () => {
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

  return {
    registerScene,
    loadStructureAndResources,
    rebuildContentMesh,
    rebuildAnnotationOverlay,
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
