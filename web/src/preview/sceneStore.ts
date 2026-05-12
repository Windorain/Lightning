/**
 * 预览场景：结构、分层、网格、图标缓存与统计的编排。
 *
 * World 多帧：用 `frame:layer` 为键缓存已构建的 Group；切帧只挂场景。所有 mesh 操作经同一 `runMesh` 队列串行，避免并发判错。
 * 单结构：继续「当前一份 mesh + 独立 dispose」。
 */

import type { InjectionKey } from 'vue'
import {
  computed,
  ref,
  shallowRef,
  watch,
  type ComputedRef,
  type Ref,
  type ShallowRef,
} from 'vue'
import * as THREE from 'three'

import {
  BlockIconCache,
  BLOCK_ICON_LAYOUT_REVISION,
  blockIconBakeLayoutKey,
} from '@/render/interaction/blockIconCache'
import { buildBlockStatsEntries, type BlockStatRow } from '@/render/interaction/blockStats'
import { MC_ITEM_SLOT_BAKE_REVISION, summarizeBlocksForCache } from '@/render/interaction/blockSlotBaker'
import type { LayerPreviewMode } from '@/render/data/layerPreview'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import { isWorldDocument, resolveRenderBundle, type RenderBundleResolveResult } from '@/render/data/bundleResolve'
import { frameAt } from '@/render/data/worldPlayback'
import {
  buildBlockMesh,
  formatUndefinedBlockDetailsForStatus,
  type BlockMeshBuildStats,
} from '@/render/mesh/blockMesh'
import type { StructureDefinition, World } from '@/render/schema/types'
import { formatUnknownError } from '@/util/formatUnknownError'

import type { PreviewConfig } from './previewConfig'

export type LoadStatus = 'loading' | 'ok' | 'error'

export type StatusBarTone = 'loading' | 'ok' | 'warn' | 'error'

export interface PreviewSceneStore {
  /** 可被外部更新以同步最新配置（工作台 syncPreview 等场景） */
  config: ShallowRef<PreviewConfig>
  showBlockStatsSidebar: boolean
  loadStatus: Ref<LoadStatus>
  statusBarTone: Ref<StatusBarTone>
  statusMessage: Ref<string>
  layerWorldY: Ref<number>
  meshBusy: Ref<boolean>
  structureDefinition: ShallowRef<StructureDefinition | null>
  materialLibrary: ShallowRef<MaterialLibraryApi | null>
  blockIconCache: ShallowRef<BlockIconCache | null>
  sizeRow: ComputedRef<number>
  layerPreviewMode: ComputedRef<LayerPreviewMode>
  blockStatsEntries: ComputedRef<BlockStatRow[]>
  layerPreviewLabel: ComputedRef<string>
  tooltipPalette: ShallowRef<string[]>
  registerScene(scene: THREE.Scene): void
  readonly overlayScene: ShallowRef<THREE.Scene | null>
  registerOverlayScene(s: THREE.Scene): void
  /** OrbitControls — set by StructureViewport, consumed by Workbench to suppress during gizmo drag */
  controlsRef: THREE.EventDispatcher | null
  registerControls(c: THREE.EventDispatcher): void
  loadStructureAndResources(): Promise<void>
  rebuildContentMesh(): Promise<void>
  detachAndDisposeMesh(): void
  disposeCachesAndLibrary(): void
  contentGroupRef: ShallowRef<THREE.Group | null>
  hasWorldMultiFrame: ComputedRef<boolean>
  worldFrameIndex: Ref<number>
  framesPlaybackIsPlaying: Ref<boolean>
  toggleWorldFramesPlayback(): void
  worldFrameCount: ComputedRef<number>
  setCurrentWorldFrame(index: number): Promise<void>
  /** 清除所有已缓存的 mesh 与 icon 缓存（config 切换时调用） */
  clearAllMeshStorage(): void
  /** 从新 config 重载结构数据并重建网格（保持现有 Three.js 场景） */
  reloadFromConfig(cfg: PreviewConfig): Promise<void>
}

export const PreviewSceneContextKey: InjectionKey<PreviewSceneStore> = Symbol('PreviewSceneContext')

function formatError(err: unknown): string {
  return formatUnknownError(err)
}

const DEFAULT_WORLD_FRAME_DWELL_MS = 50

function normalizeWorldFrameListIndex(w: World, raw: number): number {
  const n = w.frames.length
  if (n === 0) return 0
  let i = Math.floor(raw)
  return ((i % n) + n) % n
}

interface WorldMeshEntry {
  group: THREE.Group
  dispose: () => void
  stats: BlockMeshBuildStats
}

export function createPreviewSceneStore(initialConfig: PreviewConfig): PreviewSceneStore {
  const config = shallowRef<PreviewConfig>(initialConfig)
  const loadStatus = ref<LoadStatus>('loading')
  const statusBarTone = ref<StatusBarTone>('loading')
  const statusMessage = ref(config.value.loadingMessage)
  const layerWorldY = ref(config.value.initialLayerWorldY)
  const meshBusy = ref(false)
  const structureDefinition = shallowRef<StructureDefinition | null>(null)
  const materialLibrary = shallowRef<MaterialLibraryApi | null>(null)
  const blockIconCache = shallowRef<BlockIconCache | null>(null)
  const tooltipPalette = shallowRef<string[]>([])
  const sceneRef = shallowRef<THREE.Scene | null>(null)
  const contentGroupRef = shallowRef<THREE.Group | null>(null)

  const worldFrameIndex = ref(0)
  const framesPlaybackIsPlaying = ref(false)
  let worldPlaybackTimeoutId: ReturnType<typeof setTimeout> | null = null

  const worldMeshCache = new Map<string, WorldMeshEntry>()
  let nonWorldMeshDispose: (() => void) | null = null

  const worldFrameCount = computed(() => {
    const doc = config.value.renderBundle.document
    if (!isWorldDocument(doc)) {
      return 0
    }
    return doc.frames.length
  })

  const hasWorldMultiFrame = computed(() => worldFrameCount.value > 1)

  const sizeRow = computed(() => structureDefinition.value?.cellGrid[0]?.length ?? 0)

  const layerPreviewMode = computed<LayerPreviewMode>(() => {
    const y = layerWorldY.value
    if (y < 0) return 'all'
    return { worldY: y }
  })

  const blockStatsEntries = computed(() => {
    const def = structureDefinition.value
    if (!def) return []
    return buildBlockStatsEntries(def, layerPreviewMode.value)
  })

  const layerPreviewLabel = computed(() =>
    layerWorldY.value < 0 ? 'ALL' : `Y = ${layerWorldY.value}`,
  )

  watch(
    [blockStatsEntries, blockIconCache],
    () => {
      const cache = blockIconCache.value
      if (!cache) return
      cache.ensure(blockStatsEntries.value.map((r) => r.blockId))
    },
    { flush: 'post' },
  )

  /** 所有呈现/建网格操作经此串行，避免竞态。 */
  let meshPipeline: Promise<unknown> = Promise.resolve()
  function runMesh<T>(fn: () => Promise<T>): Promise<T> {
    const p = meshPipeline.then(fn)
    meshPipeline = p.then(
      () => {},
      () => {},
    ) as Promise<unknown>
    return p
  }

  function clearAllMeshStorage(): void {
    for (const e of worldMeshCache.values()) {
      e.dispose()
    }
    worldMeshCache.clear()
    nonWorldMeshDispose?.()
    nonWorldMeshDispose = null
  }

  function worldMeshKey(): string {
    const y = layerWorldY.value
    return `${worldFrameIndex.value}:${y < 0 ? 'a' : `y${y}`}`
  }

  function applyBuildStatusToBar(def: StructureDefinition, stats: BlockMeshBuildStats, group: THREE.Group): void {
    const hasMesh = group.children.length > 0
    const undefinedAppend = formatUndefinedBlockDetailsForStatus(stats.undefinedBlockDetails)
    const hasUndefined = stats.undefinedBlockDetails.length > 0

    if (hasMesh) {
      statusBarTone.value = hasUndefined ? 'warn' : 'ok'
      statusMessage.value = `模型 ${def.id} · 非空气体素 ${stats.nonAirVoxelCount}` + undefinedAppend
    } else if (stats.nonAirVoxelCount === 0) {
      statusBarTone.value = 'ok'
      statusMessage.value = '非空气体素 0'
    } else {
      statusBarTone.value = 'warn'
      statusMessage.value = `无可见几何 · 非空气体素 ${stats.nonAirVoxelCount}` + undefinedAppend
    }
  }

  /**
   * 从当前 store 的 definition / 分层 / 前缀呈现 mesh。World 走缓存；单结构每次重建。
   */
  async function presentContentMesh(): Promise<void> {
    const def = structureDefinition.value
    const scene = sceneRef.value
    if (!def || !scene) {
      return
    }

    /** 真源为 `PreviewConfig.materialLibrary`；store 的 ref 可能仍指向已 dispose 实例（与 setFrame 里用的 config 不一致）。 */
    const fromConfig = config.value.materialLibrary
    if (fromConfig && !fromConfig.isDisposed()) {
      materialLibrary.value = fromConfig
    }

    const lib = materialLibrary.value
    if (!lib) {
      return
    }

    if (lib.isDisposed()) {
      return
    }

    const layerPreview = layerPreviewMode.value
    const doc = config.value.renderBundle.document
    const isW = isWorldDocument(doc)

    meshBusy.value = true
    try {
      if (isW) {
        const k = worldMeshKey()
        const hit = worldMeshCache.get(k)
        if (hit) {
          if (contentGroupRef.value === hit.group && hit.group.parent === scene) {
            applyBuildStatusToBar(def, hit.stats, hit.group)
            return
          }
          if (contentGroupRef.value) {
            scene.remove(contentGroupRef.value)
          }
          contentGroupRef.value = hit.group
          scene.add(hit.group)
          applyBuildStatusToBar(def, hit.stats, hit.group)
          return
        }
        const result = await buildBlockMesh(def, lib, {
          layerPreview,
        })
        if (lib.isDisposed() || materialLibrary.value !== lib) {
          result.dispose()
          return
        }
        worldMeshCache.set(k, { group: result.group, dispose: result.dispose, stats: result.stats })
        if (contentGroupRef.value) {
          scene.remove(contentGroupRef.value)
        }
        contentGroupRef.value = result.group
        scene.add(result.group)
        applyBuildStatusToBar(def, result.stats, result.group)
        return
      }
      const result = await buildBlockMesh(def, lib, { layerPreview })
      if (lib.isDisposed() || materialLibrary.value !== lib) {
        result.dispose()
        return
      }
      if (contentGroupRef.value) {
        scene.remove(contentGroupRef.value)
        nonWorldMeshDispose?.()
        nonWorldMeshDispose = null
      }
      nonWorldMeshDispose = result.dispose
      contentGroupRef.value = result.group
      scene.add(result.group)
      applyBuildStatusToBar(def, result.stats, result.group)
    } catch (e) {
      const fe = formatError(e)
      if (fe.includes('MaterialLibrary 已释放')) {
        return
      }
      statusBarTone.value = 'error'
      statusMessage.value = `网格构建失败: ${fe}`
      console.error('[StructureRenderer] buildBlockMesh', e)
    } finally {
      meshBusy.value = false
    }
  }

  function registerScene(scene: THREE.Scene): void {
    sceneRef.value = scene
  }

  /** Overlay scene — rendered on top after depth clear. Gizmos, wireframes, previews. */
  const overlayScene = shallowRef<THREE.Scene | null>(null)
  function registerOverlayScene(s: THREE.Scene): void {
    overlayScene.value = s
  }

  let controlsRef: THREE.EventDispatcher | null = null
  function registerControls(c: THREE.EventDispatcher): void {
    controlsRef = c
  }

  function clearWorldPlaybackSchedule(): void {
    if (worldPlaybackTimeoutId !== null) {
      clearTimeout(worldPlaybackTimeoutId)
      worldPlaybackTimeoutId = null
    }
  }

  function dwellMsForCurrentWorldFrame(): number {
    const doc = config.value.renderBundle.document
    if (!isWorldDocument(doc) || doc.frames.length === 0) {
      return DEFAULT_WORLD_FRAME_DWELL_MS
    }
    const f = frameAt(doc, worldFrameIndex.value)
    const d = f?.durationMs
    if (typeof d === 'number' && Number.isFinite(d) && d > 0) {
      return d
    }
    return DEFAULT_WORLD_FRAME_DWELL_MS
  }

  function scheduleNextWorldFrameStep(): void {
    clearWorldPlaybackSchedule()
    if (!framesPlaybackIsPlaying.value || !hasWorldMultiFrame.value) {
      return
    }
    const doc = config.value.renderBundle.document
    if (!isWorldDocument(doc) || doc.frames.length < 2) {
      return
    }
    const n = doc.frames.length
    const loop = true
    const delay = dwellMsForCurrentWorldFrame()
    const fromIndex = worldFrameIndex.value
    worldPlaybackTimeoutId = setTimeout(() => {
      worldPlaybackTimeoutId = null
      if (!framesPlaybackIsPlaying.value) {
        return
      }
      let next = fromIndex + 1
      if (next >= n) {
        if (loop) {
          next = 0
        } else {
          framesPlaybackIsPlaying.value = false
          return
        }
      }
      void setCurrentWorldFrame(next)
        .then(() => {
          if (framesPlaybackIsPlaying.value) {
            scheduleNextWorldFrameStep()
          }
        })
        .catch(() => {
          framesPlaybackIsPlaying.value = false
        })
    }, delay)
  }

  function toggleWorldFramesPlayback(): void {
    if (!hasWorldMultiFrame.value) {
      return
    }
    if (framesPlaybackIsPlaying.value) {
      framesPlaybackIsPlaying.value = false
      clearWorldPlaybackSchedule()
      return
    }
    framesPlaybackIsPlaying.value = true
    scheduleNextWorldFrameStep()
  }

  async function setCurrentWorldFrame(rawNext: number): Promise<void> {
    const doc = config.value.renderBundle.document
    if (!isWorldDocument(doc) || doc.frames.length === 0) {
      return
    }
    return runMesh(async () => {
      const idx = normalizeWorldFrameListIndex(doc, rawNext)
      worldFrameIndex.value = idx
      const resolved: RenderBundleResolveResult = resolveRenderBundle(config.value.renderBundle, idx)
      structureDefinition.value = resolved.definition
      tooltipPalette.value = resolved.tooltipPalette
      const lib = config.value.materialLibrary
      /** 每帧新建 BlockIconCache 前必须释放旧实例：其内部懒建 WebGLRenderer 烘焙，会占满浏览器 WebGL 上下文上限。 */
      if (blockIconCache.value) {
        blockIconCache.value.dispose()
      }
      const iconCache = new BlockIconCache(
        lib,
        config.value.blockIconCacheOptions,
        resolved.definition,
      )
      iconCache.setRevisionKey(
        `${resolved.definition.id}:${summarizeBlocksForCache(resolved.definition)}:${MC_ITEM_SLOT_BAKE_REVISION}:${BLOCK_ICON_LAYOUT_REVISION}:${blockIconBakeLayoutKey(config.value.blockIconCacheOptions)}`,
      )
      blockIconCache.value = iconCache
      await presentContentMesh()
    })
  }

  async function loadStructureAndResources(): Promise<void> {
    clearWorldPlaybackSchedule()
    framesPlaybackIsPlaying.value = false
    clearAllMeshStorage()
    loadStatus.value = 'loading'
    statusBarTone.value = 'loading'
    statusMessage.value = config.value.loadingMessage
    try {
      const initial =
        isWorldDocument(config.value.renderBundle.document) && config.value.initialWorldFrameIndex !== undefined
          ? config.value.initialWorldFrameIndex
          : undefined
      const resolved: RenderBundleResolveResult = resolveRenderBundle(config.value.renderBundle, initial)
      if (resolved.worldFrameIndex !== undefined) {
        worldFrameIndex.value = resolved.worldFrameIndex
      } else {
        worldFrameIndex.value = 0
      }
      structureDefinition.value = resolved.definition
      tooltipPalette.value = resolved.tooltipPalette
      materialLibrary.value = config.value.materialLibrary
      if (blockIconCache.value) {
        blockIconCache.value.dispose()
      }
      const iconCache = new BlockIconCache(config.value.materialLibrary, config.value.blockIconCacheOptions, resolved.definition)
      iconCache.setRevisionKey(
        `${resolved.definition.id}:${summarizeBlocksForCache(resolved.definition)}:${MC_ITEM_SLOT_BAKE_REVISION}:${BLOCK_ICON_LAYOUT_REVISION}:${blockIconBakeLayoutKey(config.value.blockIconCacheOptions)}`,
      )
      blockIconCache.value = iconCache
      loadStatus.value = 'ok'
      statusBarTone.value = 'ok'
      statusMessage.value = '正在构建网格…'
    } catch (e) {
      loadStatus.value = 'error'
      statusBarTone.value = 'error'
      statusMessage.value = formatError(e)
      console.error('[StructureRenderer]', e)
    }
  }

  async function rebuildContentMesh(): Promise<void> {
    return runMesh(() => presentContentMesh())
  }

  async function reloadFromConfig(cfg: PreviewConfig): Promise<void> {
    config.value = cfg
    clearAllMeshStorage()
    blockIconCache.value?.dispose()
    blockIconCache.value = null
    await loadStructureAndResources()
    if (loadStatus.value === 'ok') {
      await rebuildContentMesh()
    }
  }

  function detachAndDisposeMesh(): void {
    const scene = sceneRef.value
    const g = contentGroupRef.value
    if (g && scene) {
      scene.remove(g)
    }
    contentGroupRef.value = null
    if (!isWorldDocument(config.value.renderBundle.document)) {
      nonWorldMeshDispose?.()
      nonWorldMeshDispose = null
    }
  }

  function disposeCachesAndLibrary(): void {
    clearWorldPlaybackSchedule()
    framesPlaybackIsPlaying.value = false
    clearAllMeshStorage()
    contentGroupRef.value = null
    blockIconCache.value?.dispose()
    blockIconCache.value = null
    materialLibrary.value?.dispose()
    materialLibrary.value = null
    structureDefinition.value = null
    tooltipPalette.value = []
    worldFrameIndex.value = 0
    sceneRef.value = null
  }

  watch(layerWorldY, () => {
    if (!structureDefinition.value || !sceneRef.value) {
      return
    }
    void runMesh(async () => {
      const scene = sceneRef.value
      const g = contentGroupRef.value
      if (g && scene) {
        scene.remove(g)
      }
      contentGroupRef.value = null
      clearAllMeshStorage()
      await presentContentMesh()
    })
  })

  return {
    config,
    showBlockStatsSidebar: config.value.features.blockStatsSidebar,
    loadStatus,
    statusBarTone,
    statusMessage,
    layerWorldY,
    meshBusy,
    structureDefinition,
    materialLibrary,
    blockIconCache,
    sizeRow,
    layerPreviewMode,
    blockStatsEntries,
    layerPreviewLabel,
    tooltipPalette,
    registerScene,
    overlayScene,
    registerOverlayScene,
    controlsRef,
    registerControls,
    loadStructureAndResources,
    rebuildContentMesh,
    detachAndDisposeMesh,
    disposeCachesAndLibrary,
    clearAllMeshStorage,
    reloadFromConfig,
    contentGroupRef,
    hasWorldMultiFrame,
    worldFrameIndex,
    framesPlaybackIsPlaying,
    toggleWorldFramesPlayback,
    worldFrameCount,
    setCurrentWorldFrame,
  }
}
