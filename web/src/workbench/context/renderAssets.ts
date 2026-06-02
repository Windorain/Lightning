/**
 * renderAssets — 共享渲染管线 composable。
 *
 * 从原始文档 + materialLibrary 产出 Three.js 渲染所需的数据结构与 mesh。
 * embedBContext 和 WorkbenchViewport 共用。不依赖 View3DConfig。
 *
 * 薄协调层，将帧播放委托给 WorldFrameController、图标缓存委托给 IconCacheManager。
 */
import { computed, shallowRef, watch, type ComputedRef, type Ref, type ShallowRef } from 'vue'
import * as THREE from 'three'
import type { RuntimeDocument } from '@/workbench/context/runtimeDocument'
import type { LoadStatus } from '@/workbench/context/bContext'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import type { LayerPreviewMode } from '@/render/data/layerPreview'
import type { StructureDefinition } from '@/render/schema/types'
import type { Annotation } from '@/render/data/annotationTypes'
import type { BlockStatRow } from '@/render/interaction/blockStats'
import type { BlockIconCache } from '@/render/interaction/blockIconCache'
import type { BlockMeshBuildStats } from '@/render/mesh/blockMesh'
import type { ViewportRenderAssets } from '@/shared/types'
import { buildBlockStatsEntries } from '@/render/interaction/blockStats'
import { BlockMeshProvider } from '@/render/mesh/blockMeshProvider'
import { AnnotationMeshProvider } from '@/render/mesh/annotationMeshProvider'
import { buildMaterialLibrary } from '@/render/data/buildMaterialLibrary'
import { resolveRenderBundle, type RenderBundleResolveResult } from '@/render/data/bundleResolve'
import { formatUnknownError } from '@/util/formatUnknownError'
import { createIconCacheManager } from './iconCacheManager'
import { createWorldFrameController } from './worldFrameController'

function formatError(err: unknown): string {
  return formatUnknownError(err)
}

interface WorldMeshEntry {
  group: THREE.Group
  dispose: () => void
  stats: BlockMeshBuildStats
}

export interface RenderAssetsDeps {
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
}

export interface RenderAssetsComputed {
  layerPreviewMode: ComputedRef<LayerPreviewMode>
  layerPreviewLabel: ComputedRef<string>
  gridHeight: ComputedRef<number>
  hasWorldMultiFrame: ComputedRef<boolean>
  worldFrameCount: ComputedRef<number>
  blockStatsEntries: ComputedRef<BlockStatRow[]>
}

export interface RenderAssets extends ViewportRenderAssets {
  registerScene(scene: THREE.Scene): void
  loadStructureAndResources(): Promise<void>
  rebuildContentMesh(): Promise<void>
  rebuildAnnotationOverlay(annotations: Annotation[]): Promise<THREE.Group | null>
  setCurrentWorldFrame(index: number): Promise<void>
  toggleWorldFramesPlayback(): void
  disposeCachesAndLibrary(): void
  /** 清空缓存后重新加载结构 + 重建 mesh（替代原 reloadFromConfig） */
  rebuildAll(): Promise<void>
  /** 注册 structEpoch 内部 watch；须在 registerScene 之后调用 */
  init(): void
  /** 解构 init 注册的 watch */
  dispose(): void
  /** 内部纹理缓存（供 ViewerCore 渲染用，只读） */
  textureCache: Readonly<ShallowRef<MaterialLibraryApi | null>>
  computed: RenderAssetsComputed
}


export function createRenderAssets(deps: RenderAssetsDeps): RenderAssets {
  const {
    docRef, loadStatus, meshBusy, blockIconCache, tooltipPalette,
    structureDefinition, mainMeshGroup, sceneRef, worldFrameIndex, layerWorldY,
    framesPlaybackIsPlaying, blockIconCacheOptions, initialWorldFrameIndex, structEpochRef,
  } = deps

  // === 内部纹理缓存，从 doc.textureBlobs 构建 ===
  const textureCache = shallowRef<MaterialLibraryApi | null>(null)

  /** 确保 textureCache 就绪；已完成则直接返回。 */
  async function ensureTextures(doc: RuntimeDocument): Promise<MaterialLibraryApi | null> {
    if (textureCache.value && !textureCache.value.isDisposed()) return textureCache.value
    try {
      textureCache.value = await buildMaterialLibrary(doc.serialize())
      return textureCache.value
    } catch (e) {
      console.error('[renderAssets] buildMaterialLibrary failed', e)
      return null
    }
  }

  const blockMeshProvider = new BlockMeshProvider()
  const annotationProvider = new AnnotationMeshProvider()

  const worldMeshCache = new Map<string, WorldMeshEntry>()
  let nonWorldMeshDispose: (() => void) | null = null
  let stopStructEpochWatch: (() => void) | null = null

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
      console.warn('[renderAssets] presentContentMesh: textureCache not ready, triggering rebuildAll')
      void rebuildAll().catch(e => {
        console.error('[renderAssets] rebuildAll (from presentContentMesh) failed:', e)
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
      console.error('[renderAssets] buildBlockMesh', e)
    } finally {
      meshBusy.value = false
    }
  }

  // ---- 图标缓存管理 ----
  const iconCacheManager = createIconCacheManager({ blockIconCache, blockIconCacheOptions })

  // ---- 帧播放控制 ----
  const worldFrameCtrl = createWorldFrameController({
    docRef,
    worldFrameIndex,
    framesPlaybackIsPlaying,
    structureDefinition,
    tooltipPalette,
    textureCache,
    rebuildBlockIconCache: iconCacheManager.rebuild,
    runMesh,
    presentContentMesh,
  })

  // ---- Lifecycle ----
  function registerScene(scene: THREE.Scene): void {
    sceneRef.value = scene
  }

  function init(): void {
    stopStructEpochWatch?.()
    stopStructEpochWatch = watch(structEpochRef, () => {
      void rebuildAll().catch(e => {
        console.error('[renderAssets] rebuildAll (structEpoch watch) failed:', e)
        loadStatus.value = 'error'
      })
    })
  }

  async function loadStructureAndResources(): Promise<void> {
    worldFrameCtrl.clearWorldPlaybackSchedule()
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
        : await ensureTextures(doc)
      if (!effectiveLib || effectiveLib.isDisposed()) {
        loadStatus.value = 'error'
        console.error('[renderAssets] loadStructureAndResources: failed to build textureCache')
        return
      }
      iconCacheManager.rebuild(effectiveLib, resolved.definition)
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
    iconCacheManager.dispose()
    await loadStructureAndResources()
    if (loadStatus.value === 'ok') await rebuildContentMesh()
  }

  function disposeCachesAndLibrary(): void {
    worldFrameCtrl.clearWorldPlaybackSchedule()
    framesPlaybackIsPlaying.value = false
    clearAllMeshStorage()
    mainMeshGroup.value = null
    iconCacheManager.dispose()
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
    })
  })

  return {
    registerScene,
    loadStructureAndResources,
    rebuildContentMesh,
    rebuildAnnotationOverlay,
    setCurrentWorldFrame: worldFrameCtrl.setCurrentWorldFrame,
    toggleWorldFramesPlayback: worldFrameCtrl.toggleWorldFramesPlayback,
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
