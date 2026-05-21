/**
 * 共享 scene lifecycle — mesh pipeline、帧管理、注解 overlay。
 *
 * embedContext 和 workbenchContext 共用的核心逻辑。
 */
import { computed, watch, type ComputedRef, type Ref, type ShallowRef } from 'vue'
import * as THREE from 'three'
import type { LoadStatus } from '@/workbench/context/bContext'
import type { View3DConfig } from '@/preview/previewConfig'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import type { LayerPreviewMode } from '@/render/data/layerPreview'
import type { StructureDefinition, World } from '@/render/schema/types'
import type { Annotation } from '@/render/data/annotationTypes'
import type { BlockStatRow } from '@/render/interaction/blockStats'
import { BlockIconCache, BLOCK_ICON_LAYOUT_REVISION, blockIconBakeLayoutKey } from '@/render/interaction/blockIconCache'
import { buildBlockStatsEntries } from '@/render/interaction/blockStats'
import { MC_ITEM_SLOT_BAKE_REVISION, summarizeBlocksForCache } from '@/render/interaction/blockSlotBaker'
import { isWorldDocument, resolveRenderBundle, type RenderBundleResolveResult } from '@/render/data/bundleResolve'
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

export interface SceneLifecycleDeps {
  configRef: ShallowRef<View3DConfig>
  loadStatus: Ref<LoadStatus>
  meshBusy: Ref<boolean>
  materialLibrary: ShallowRef<MaterialLibraryApi | null>
  blockIconCache: ShallowRef<BlockIconCache | null>
  tooltipPalette: ShallowRef<string[]>
  structureDefinition: ShallowRef<StructureDefinition | null>
  mainMeshGroup: ShallowRef<THREE.Group | null>
  sceneRef: ShallowRef<THREE.Scene | null>
  worldFrameIndex: Ref<number>
  layerWorldY: Ref<number>
  framesPlaybackIsPlaying: Ref<boolean>
}

export interface SceneLifecycleComputed {
  layerPreviewMode: ComputedRef<LayerPreviewMode>
  layerPreviewLabel: ComputedRef<string>
  gridHeight: ComputedRef<number>
  hasWorldMultiFrame: ComputedRef<boolean>
  worldFrameCount: ComputedRef<number>
  blockStatsEntries: ComputedRef<BlockStatRow[]>
}

export interface SceneLifecycleMethods {
  registerScene(scene: THREE.Scene): void
  loadStructureAndResources(): Promise<void>
  rebuildContentMesh(): Promise<void>
  rebuildAnnotationOverlay(annotations: Annotation[]): Promise<THREE.Group | null>
  setCurrentWorldFrame(index: number): Promise<void>
  toggleWorldFramesPlayback(): void
  disposeCachesAndLibrary(): void
  reloadFromConfig(cfg: View3DConfig): Promise<void>
  /** 替工厂暴露内部 computed，调用方挂到各自的 bctx 上 */
  computed: SceneLifecycleComputed
}

export function createSceneLifecycle(deps: SceneLifecycleDeps): SceneLifecycleMethods {
  const {
    configRef, loadStatus, meshBusy, materialLibrary, blockIconCache, tooltipPalette,
    structureDefinition, mainMeshGroup, sceneRef, worldFrameIndex, layerWorldY,
    framesPlaybackIsPlaying,
  } = deps

  const blockMeshProvider = new BlockMeshProvider()
  const annotationProvider = new AnnotationMeshProvider()

  let worldPlaybackTimeoutId: ReturnType<typeof setTimeout> | null = null
  const worldMeshCache = new Map<string, WorldMeshEntry>()
  let nonWorldMeshDispose: (() => void) | null = null

  // ---- Computed ----
  const worldFrameCount = computed(() => {
    const doc = configRef.value.renderBundle.document
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

    const lib = materialLibrary.value || configRef.value.materialLibrary
    if (!lib || lib.isDisposed()) return

    const isW = isWorldDocument(configRef.value.renderBundle.document)
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
        if (lib.isDisposed() || materialLibrary.value !== lib) { result.dispose(); return }
        worldMeshCache.set(k, { group: result.group, dispose: result.dispose, stats: result.stats })
        if (mainMeshGroup.value) scene.remove(mainMeshGroup.value)
        mainMeshGroup.value = result.group
        scene.add(result.group)
        return
      }
      const outputs = await blockMeshProvider.build(def, lib, { layerPreview })
      const out = outputs[0]! as Extract<import('@/render/mesh/providerTypes').MeshOutput, { kind: 'object3d' }>
      const result = { group: out.object as THREE.Group, dispose: out.dispose, stats: out.stats! }
      if (lib.isDisposed() || materialLibrary.value !== lib) { result.dispose(); return }
      if (mainMeshGroup.value) { scene.remove(mainMeshGroup.value); nonWorldMeshDispose?.(); nonWorldMeshDispose = null }
      nonWorldMeshDispose = result.dispose
      mainMeshGroup.value = result.group
      scene.add(result.group)
    } catch (e) {
      const fe = formatError(e)
      if (fe.includes('MaterialLibrary 已释放')) return
      console.error('[SceneLifecycle] buildBlockMesh', e)
    } finally {
      meshBusy.value = false
    }
  }

  // ---- Frame playback ----
  function clearWorldPlaybackSchedule(): void {
    if (worldPlaybackTimeoutId !== null) { clearTimeout(worldPlaybackTimeoutId); worldPlaybackTimeoutId = null }
  }

  function dwellMsForCurrentWorldFrame(): number {
    const doc = configRef.value.renderBundle.document
    if (!isWorldDocument(doc) || doc.frames.length === 0) return DEFAULT_WORLD_FRAME_DWELL_MS
    const f = frameAt(doc, worldFrameIndex.value)
    const d = f?.durationMs
    if (typeof d === 'number' && Number.isFinite(d) && d > 0) return d
    return DEFAULT_WORLD_FRAME_DWELL_MS
  }

  function scheduleNextWorldFrameStep(): void {
    clearWorldPlaybackSchedule()
    if (!framesPlaybackIsPlaying.value || !hasWorldMultiFrame.value) return
    const doc = configRef.value.renderBundle.document
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
    const doc = configRef.value.renderBundle.document
    if (!isWorldDocument(doc) || doc.frames.length === 0) return
    return runMesh(async () => {
      const idx = normalizeWorldFrameListIndex(doc, rawNext)
      worldFrameIndex.value = idx
      const resolved: RenderBundleResolveResult = resolveRenderBundle(configRef.value.renderBundle, idx)
      structureDefinition.value = resolved.definition
      tooltipPalette.value = resolved.tooltipPalette
      const lib = configRef.value.materialLibrary
      if (blockIconCache.value) blockIconCache.value.dispose()
      const iconCache = new BlockIconCache(lib, configRef.value.blockIconCacheOptions, resolved.definition)
      iconCache.setRevisionKey(
        `${resolved.definition.id}:${summarizeBlocksForCache(resolved.definition)}:${MC_ITEM_SLOT_BAKE_REVISION}:${BLOCK_ICON_LAYOUT_REVISION}:${blockIconBakeLayoutKey(configRef.value.blockIconCacheOptions)}`,
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
      const initial =
        isWorldDocument(configRef.value.renderBundle.document) && configRef.value.initialWorldFrameIndex !== undefined
          ? configRef.value.initialWorldFrameIndex
          : undefined
      const resolved: RenderBundleResolveResult = resolveRenderBundle(configRef.value.renderBundle, initial)
      if (resolved.worldFrameIndex !== undefined) worldFrameIndex.value = resolved.worldFrameIndex
      else worldFrameIndex.value = 0
      structureDefinition.value = resolved.definition
      tooltipPalette.value = resolved.tooltipPalette
      if (!materialLibrary.value || materialLibrary.value.isDisposed()) materialLibrary.value = configRef.value.materialLibrary
      if (blockIconCache.value) blockIconCache.value.dispose()
      const iconCache = new BlockIconCache(configRef.value.materialLibrary, configRef.value.blockIconCacheOptions, resolved.definition)
      iconCache.setRevisionKey(
        `${resolved.definition.id}:${summarizeBlocksForCache(resolved.definition)}:${MC_ITEM_SLOT_BAKE_REVISION}:${BLOCK_ICON_LAYOUT_REVISION}:${blockIconBakeLayoutKey(configRef.value.blockIconCacheOptions)}`,
      )
      blockIconCache.value = iconCache
      loadStatus.value = 'ok'
    } catch (e) {
      loadStatus.value = 'error'
      console.error('[SceneLifecycle] loadStructureAndResources', e)
    }
  }

  async function rebuildContentMesh(): Promise<void> {
    return runMesh(() => presentContentMesh())
  }

  async function rebuildAnnotationOverlay(annotations: Annotation[]): Promise<THREE.Group | null> {
    const def = structureDefinition.value
    const lib = materialLibrary.value
    if (!def || !lib || annotations.length === 0) return null
    annotationProvider.setAnnotations(annotations)
    const outputs = await annotationProvider.build(def, lib)
    const out = outputs[0]
    return out?.kind === 'object3d' ? (out.object as THREE.Group) : null
  }

  async function reloadFromConfig(cfg: View3DConfig): Promise<void> {
    configRef.value = cfg
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
    materialLibrary.value?.dispose()
    materialLibrary.value = null
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
    reloadFromConfig,
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
