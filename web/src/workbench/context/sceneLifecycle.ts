/**
 * renderAssets — 共享渲染管线 composable。
 *
 * 从原始文档 + materialLibrary 产出 Three.js 渲染所需的数据结构与 mesh。
 * embedContext 和 WorkbenchViewport 共用。不依赖 View3DConfig。
 */
import { computed, shallowRef, watch, type ComputedRef, type Ref, type ShallowRef } from 'vue'
import * as THREE from 'three'
import type { LoadStatus } from '@/workbench/context/bContext'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import type { LayerPreviewMode } from '@/render/data/layerPreview'
import type { StructureDefinition, World } from '@/render/schema/types'
import type { Annotation } from '@/render/data/annotationTypes'
import type { BlockStatRow } from '@/render/interaction/blockStats'
import { BlockIconCache, BLOCK_ICON_LAYOUT_REVISION, blockIconBakeLayoutKey } from '@/render/interaction/blockIconCache'
import { buildBlockStatsEntries } from '@/render/interaction/blockStats'
import { MC_ITEM_SLOT_BAKE_REVISION, summarizeBlocksForCache } from '@/render/interaction/blockSlotBaker'
import { isWorldDocument, resolveRenderBundle, type RenderBundleResolveResult } from '@/render/data/bundleResolve'
import { buildMaterialLibrary } from '@/render/data/buildMaterialLibrary'
import { frameAt } from '@/render/data/worldPlayback'
import type { BlockMeshBuildStats } from '@/render/mesh/blockMesh'
import { BlockMeshProvider } from '@/render/mesh/blockMeshProvider'
import { AnnotationMeshProvider } from '@/render/mesh/annotationMeshProvider'
import { formatUnknownError } from '@/util/formatUnknownError'

const DEFAULT_WORLD_FRAME_DWELL_MS = 50

function normalizeWorldFrameListIndex(w: World, raw: number): number {
  const n = w.frames.length
  if (n === 0) return 0
  const i = Math.floor(raw)
  return ((i % n) + n) % n
}

function formatError(err: unknown): string {
  return formatUnknownError(err)
}

interface WorldMeshEntry {
  group: THREE.Group
  dispose: () => void
  stats: BlockMeshBuildStats
}

export interface RenderAssetsDeps {
  /** 原始文档（RuntimeDocument.toRaw() 产物，或 embed 传入的 plain doc） */
  docRef: Ref<unknown>
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
}

export interface RenderAssetsComputed {
  layerPreviewMode: ComputedRef<LayerPreviewMode>
  layerPreviewLabel: ComputedRef<string>
  gridHeight: ComputedRef<number>
  hasWorldMultiFrame: ComputedRef<boolean>
  worldFrameCount: ComputedRef<number>
  blockStatsEntries: ComputedRef<BlockStatRow[]>
}

export interface RenderAssets {
  registerScene(scene: THREE.Scene): void
  loadStructureAndResources(): Promise<void>
  rebuildContentMesh(): Promise<void>
  rebuildAnnotationOverlay(annotations: Annotation[]): Promise<THREE.Group | null>
  setCurrentWorldFrame(index: number): Promise<void>
  toggleWorldFramesPlayback(): void
  disposeCachesAndLibrary(): void
  /** 清空缓存后重新加载结构 + 重建 mesh（替代原 reloadFromConfig） */
  rebuildAll(): Promise<void>
  /** 内部纹理缓存（供 ViewerCore 渲染用，只读） */
  textureCache: Readonly<ShallowRef<MaterialLibraryApi | null>>
  computed: RenderAssetsComputed
}

/** @deprecated 使用 RenderAssetsDeps / RenderAssets */
export type SceneLifecycleDeps = RenderAssetsDeps
/** @deprecated 使用 RenderAssets */
export type SceneLifecycleMethods = RenderAssets
/** @deprecated 使用 RenderAssetsComputed */
export type SceneLifecycleComputed = RenderAssetsComputed

export function createRenderAssets(deps: RenderAssetsDeps): RenderAssets {
  const {
    docRef, loadStatus, meshBusy, blockIconCache, tooltipPalette,
    structureDefinition, mainMeshGroup, sceneRef, worldFrameIndex, layerWorldY,
    framesPlaybackIsPlaying, blockIconCacheOptions, initialWorldFrameIndex,
  } = deps

  // === 内部纹理缓存，从 doc.textureBlobs 构建 ===
  const textureCache = shallowRef<MaterialLibraryApi | null>(null)

  /** 确保 textureCache 就绪；已完成则直接返回。doc 必须是 plain V2 文档 */
  async function ensureTextures(doc: unknown): Promise<MaterialLibraryApi | null> {
    if (textureCache.value && !textureCache.value.isDisposed()) return textureCache.value
    try {
      textureCache.value = await buildMaterialLibrary(doc)
      return textureCache.value
    } catch (e) {
      console.error('[renderAssets] buildMaterialLibrary failed', e)
      return null
    }
  }

  const blockMeshProvider = new BlockMeshProvider()
  const annotationProvider = new AnnotationMeshProvider()

  let worldPlaybackTimeoutId: ReturnType<typeof setTimeout> | null = null
  const worldMeshCache = new Map<string, WorldMeshEntry>()
  let nonWorldMeshDispose: (() => void) | null = null

  // ---- Computed ----
  const worldFrameCount = computed(() => {
    const doc = docRef.value
    if (!isWorldDocument(doc)) return 0
    return doc.frames.length
  })
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
      console.warn('[renderAssets] presentContentMesh: textureCache not ready, triggering rebuildAll')
      void rebuildAll()
      return
    }

    const isW = isWorldDocument(docRef.value)
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
      console.error('[renderAssets] buildBlockMesh', e)
    } finally {
      meshBusy.value = false
    }
  }

  // ---- Frame playback ----
  function clearWorldPlaybackSchedule(): void {
    if (worldPlaybackTimeoutId !== null) { clearTimeout(worldPlaybackTimeoutId); worldPlaybackTimeoutId = null }
  }

  function dwellMsForCurrentWorldFrame(): number {
    const doc = docRef.value
    if (!isWorldDocument(doc) || doc.frames.length === 0) return DEFAULT_WORLD_FRAME_DWELL_MS
    const f = frameAt(doc, worldFrameIndex.value)
    const d = f?.durationMs
    if (typeof d === 'number' && Number.isFinite(d) && d > 0) return d
    return DEFAULT_WORLD_FRAME_DWELL_MS
  }

  function scheduleNextWorldFrameStep(): void {
    clearWorldPlaybackSchedule()
    if (!framesPlaybackIsPlaying.value || !hasWorldMultiFrame.value) return
    const doc = docRef.value
    if (!isWorldDocument(doc) || doc.frames.length < 2) return
    const n = doc.frames.length
    const delay = dwellMsForCurrentWorldFrame()
    const fromIndex = worldFrameIndex.value
    worldPlaybackTimeoutId = setTimeout(() => {
      worldPlaybackTimeoutId = null
      if (!framesPlaybackIsPlaying.value) return
      let next = fromIndex + 1
      if (next >= n) next = 0
      void setCurrentWorldFrame(next).then(() => {
        if (framesPlaybackIsPlaying.value) scheduleNextWorldFrameStep()
      }).catch(() => { framesPlaybackIsPlaying.value = false })
    }, delay)
  }

  function toggleWorldFramesPlayback(): void {
    if (!hasWorldMultiFrame.value) return
    if (framesPlaybackIsPlaying.value) { framesPlaybackIsPlaying.value = false; clearWorldPlaybackSchedule(); return }
    framesPlaybackIsPlaying.value = true
    scheduleNextWorldFrameStep()
  }

  async function setCurrentWorldFrame(rawNext: number): Promise<void> {
    const doc = docRef.value
    if (!isWorldDocument(doc) || doc.frames.length === 0) return
    return runMesh(async () => {
      const idx = normalizeWorldFrameListIndex(doc, rawNext)
      worldFrameIndex.value = idx
      const resolved: RenderBundleResolveResult = resolveRenderBundle({ document: doc }, idx)
      structureDefinition.value = resolved.definition
      tooltipPalette.value = resolved.tooltipPalette
      const lib = textureCache.value
      if (!lib || lib.isDisposed()) return
      if (blockIconCache.value) blockIconCache.value.dispose()
      const iconCache = new BlockIconCache(lib, blockIconCacheOptions, resolved.definition)
      iconCache.setRevisionKey(
        `${resolved.definition.id}:${summarizeBlocksForCache(resolved.definition)}:${MC_ITEM_SLOT_BAKE_REVISION}:${BLOCK_ICON_LAYOUT_REVISION}:${blockIconBakeLayoutKey(blockIconCacheOptions)}`,
      )
      blockIconCache.value = iconCache
      await presentContentMesh()
    })
  }

  // ---- Lifecycle ----
  function registerScene(scene: THREE.Scene): void {
    sceneRef.value = scene
  }

  async function loadStructureAndResources(): Promise<void> {
    clearWorldPlaybackSchedule()
    framesPlaybackIsPlaying.value = false
    clearAllMeshStorage()
    loadStatus.value = 'loading'
    try {
      const doc = docRef.value
      if (!doc) { loadStatus.value = 'error'; return }
      const resolved: RenderBundleResolveResult = resolveRenderBundle(
        { document: doc },
        initialWorldFrameIndex,
      )
      if (resolved.worldFrameIndex !== undefined) worldFrameIndex.value = resolved.worldFrameIndex
      else worldFrameIndex.value = 0
      structureDefinition.value = resolved.definition
      tooltipPalette.value = resolved.tooltipPalette
      const lib = textureCache.value
      const effectiveLib = (lib && !lib.isDisposed())
        ? lib
        : await ensureTextures(doc as Record<string, unknown>)
      if (!effectiveLib || effectiveLib.isDisposed()) {
        loadStatus.value = 'error'
        console.error('[renderAssets] loadStructureAndResources: failed to build textureCache')
        return
      }
      if (blockIconCache.value) blockIconCache.value.dispose()
      const iconCache = new BlockIconCache(effectiveLib, blockIconCacheOptions, resolved.definition)
      iconCache.setRevisionKey(
        `${resolved.definition.id}:${summarizeBlocksForCache(resolved.definition)}:${MC_ITEM_SLOT_BAKE_REVISION}:${BLOCK_ICON_LAYOUT_REVISION}:${blockIconBakeLayoutKey(blockIconCacheOptions)}`,
      )
      blockIconCache.value = iconCache
      loadStatus.value = 'ok'
    } catch (e) {
      loadStatus.value = 'error'
      console.error('[renderAssets] loadStructureAndResources', e)
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
    blockIconCache.value?.dispose()
    blockIconCache.value = null
    await loadStructureAndResources()
    if (loadStatus.value === 'ok') await rebuildContentMesh()
  }

  function disposeCachesAndLibrary(): void {
    clearWorldPlaybackSchedule()
    framesPlaybackIsPlaying.value = false
    clearAllMeshStorage()
    mainMeshGroup.value = null
    blockIconCache.value?.dispose()
    blockIconCache.value = null
    textureCache.value?.dispose()
    textureCache.value = null
    structureDefinition.value = null
    tooltipPalette.value = []
    worldFrameIndex.value = 0
    sceneRef.value = null
  }

  // Layer Y reactivity — re-mesh when layer changes
  watch(layerWorldY, () => {
    if (!structureDefinition.value || !sceneRef.value) return
    void runMesh(async () => {
      const scene = sceneRef.value
      const g = mainMeshGroup.value
      if (g && scene) scene.remove(g)
      mainMeshGroup.value = null
      clearAllMeshStorage()
      await presentContentMesh()
    })
  })

  return {
    registerScene,
    loadStructureAndResources,
    rebuildContentMesh,
    rebuildAnnotationOverlay,
    setCurrentWorldFrame,
    toggleWorldFramesPlayback,
    disposeCachesAndLibrary,
    rebuildAll,
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

/** @deprecated 使用 createRenderAssets */
export const createSceneLifecycle = createRenderAssets
