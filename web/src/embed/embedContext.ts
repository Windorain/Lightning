/**
 * Embed BContext 工厂 — 创建完整 BContext 供嵌入场景使用。
 *
 * 与 workbench bctx 共享同一接口，但更轻：
 * - scene / selection / editHistory / toolRegistry / rna / ui → stub
 * - materialLibrary / worldFrame / layer / mesh pipeline → 完整实现
 */
import { computed, ref, shallowRef } from 'vue'
import type { BContext, LoadStatus } from '@/workbench/context/bContext'
import { createViewportManager } from '@/workbench/context/bContext'
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
import { globalOperators } from '@/workbench/operators/operatorRegistry'
import { eventDispatcher } from '@/workbench/eventDispatcher'
import * as THREE from 'three'

// Operators
import { ViewRotateOperator, ViewPanOperator, ViewZoomOperator } from '@/workbench/operators/builtin/viewOperators'
import { ResetViewOperator } from '@/embed/operators/resetViewOperator'

function formatError(err: unknown): string {
  return formatUnknownError(err)
}

const DEFAULT_WORLD_FRAME_DWELL_MS = 50

function normalizeWorldFrameListIndex(w: World, raw: number): number {
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

export function createEmbedBContext(config: View3DConfig): BContext {
  // ---- Shared state ----
  const configRef = shallowRef<View3DConfig>(config)
  const loadStatus = ref<LoadStatus>('loading')
  const meshBusy = ref(false)
  const materialLibrary = shallowRef<MaterialLibraryApi | null>(null)
  const blockIconCache = shallowRef<BlockIconCache | null>(null)
  const tooltipPalette = shallowRef<string[]>([])
  const sceneRef = shallowRef<THREE.Scene | null>(null)

  // ---- Viewport slots ----
  const viewports = createViewportManager()
  const defaultVp = viewports.register('r-viewport')
  // Use viewport slot refs directly as the canonical storage
  const structureDefinition = defaultVp.definition
  const mainMeshGroup = defaultVp.contentGroup

  // Frame/Layer
  const worldFrameIndex = ref(0)
  const layerWorldY = ref(config.initialLayerWorldY)
  const framesPlaybackIsPlaying = ref(false)
  let worldPlaybackTimeoutId: ReturnType<typeof setTimeout> | null = null

  const worldMeshCache = new Map<string, WorldMeshEntry>()
  let nonWorldMeshDispose: (() => void) | null = null

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
  const layerPreviewLabel = computed(() => layerWorldY.value < 0 ? 'ALL' : `Y = ${layerWorldY.value}`)
  const blockStatsEntries = computed<BlockStatRow[]>(() => {
    const def = structureDefinition.value
    if (!def) return []
    return buildBlockStatsEntries(def, layerPreviewMode.value)
  })

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

  function applyBuildStatusToBar(_def: StructureDefinition, _stats: BlockMeshBuildStats, _group: THREE.Group): void {
    // Embed doesn't show status bar — no-op
  }

  const blockMeshProvider = new BlockMeshProvider()
  const annotationProvider = new AnnotationMeshProvider()

  async function presentContentMesh(): Promise<void> {
    const def = structureDefinition.value
    const scene = sceneRef.value
    if (!def || !scene) return

    const fromConfig = configRef.value.materialLibrary
    if (fromConfig && !fromConfig.isDisposed()) materialLibrary.value = fromConfig

    const lib = materialLibrary.value
    if (!lib || lib.isDisposed()) return

    meshBusy.value = true
    try {
      const doc = configRef.value.renderBundle.document
      const isW = isWorldDocument(doc)
      const layerPreview = layerPreviewMode.value

      if (isW) {
        const k = worldMeshKey()
        const hit = worldMeshCache.get(k)
        if (hit) {
          if (mainMeshGroup.value === hit.group && hit.group.parent === scene) {
            applyBuildStatusToBar(def, hit.stats, hit.group)
            return
          }
          if (mainMeshGroup.value) scene.remove(mainMeshGroup.value)
          mainMeshGroup.value = hit.group
          scene.add(hit.group)
          applyBuildStatusToBar(def, hit.stats, hit.group)
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
        applyBuildStatusToBar(def, result.stats, result.group)
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
      applyBuildStatusToBar(def, result.stats, result.group)
    } catch (e) {
      const fe = formatError(e)
      if (fe.includes('MaterialLibrary 已释放')) return
      console.error('[EmbedContext] buildBlockMesh', e)
    } finally {
      meshBusy.value = false
    }
  }

  function registerScene(scene: THREE.Scene): void {
    sceneRef.value = scene
  }

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
      if (next >= n) { next = 0 }
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
      materialLibrary.value = configRef.value.materialLibrary
      if (blockIconCache.value) blockIconCache.value.dispose()
      const iconCache = new BlockIconCache(configRef.value.materialLibrary, configRef.value.blockIconCacheOptions, resolved.definition)
      iconCache.setRevisionKey(
        `${resolved.definition.id}:${summarizeBlocksForCache(resolved.definition)}:${MC_ITEM_SLOT_BAKE_REVISION}:${BLOCK_ICON_LAYOUT_REVISION}:${blockIconBakeLayoutKey(configRef.value.blockIconCacheOptions)}`,
      )
      blockIconCache.value = iconCache
      loadStatus.value = 'ok'
    } catch (e) {
      loadStatus.value = 'error'
      console.error('[EmbedContext] loadStructureAndResources', e)
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

  // ---- Assemble bctx (partial, for self-reference) ----
  const ctx = {} as BContext

  // ---- Operators (needs ctx reference) ----
  const operators = {
    exec: (id: string, props?: Record<string, unknown>) => globalOperators.exec(ctx, id, props),
    invoke: (id: string, props?: Record<string, unknown>, event?: Event, regionId?: string) =>
      globalOperators.invoke(ctx, id, props, event as any, regionId),
    find: (id: string) => { const o = globalOperators.find(id); return o ? { id: o.id, label: o.label } : undefined },
    all: () => globalOperators.all().map(o => ({ id: o.id, label: o.label })),
    register: (op: any) => globalOperators.register(op),
  }

  // ---- Fill ctx ----
  Object.defineProperty(ctx, 'viewport', {
    get() { return viewports.active.value! },
    enumerable: true,
    configurable: true,
  })
  Object.assign(ctx, {
    config: configRef,
    loadStatus,
    meshBusy,
    materialLibrary,
    blockIconCache,
    tooltipPalette,
    worldFrameIndex,
    worldFrameCount,
    hasWorldMultiFrame,
    framesPlaybackIsPlaying,
    toggleWorldFramesPlayback,
    setCurrentWorldFrame,
    layerWorldY,
    layerPreviewMode,
    layerPreviewLabel,
    gridHeight,
    loadStructureAndResources,
    rebuildContentMesh,
    rebuildAnnotationOverlay,
    reloadFromConfig,
    disposeCachesAndLibrary,
    registerScene,
    blockStatsEntries,
    viewports,
    operators,
    eventDispatcher,
    settings: {
      replaceBrush: null,
      fillBrush: null,
      generateType: null,
      dragSensitivity: 0.05,
      snapEnabled: true,
    },
    statusMessage: { value: '' },

    // Stubs
    scene: null as any,
    selection: null as any,
    editHistory: null as any,
    toolRegistry: null as any,
    connection: null as any,
    queries: null as any,
    log: {
      entries: { value: [] },
      lastDisplayable: { value: null },
      debug: () => undefined as unknown,
      info: () => undefined as unknown,
      operator: () => undefined as unknown,
      warn: () => undefined as unknown,
      error: () => undefined as unknown,
      clear: () => {},
      contains: () => false,
      recent: () => [],
    } as any,
    wikiConfig: null as any,
    wm: { windows: [], activeWindow: null },
    screen: null,
    area: null,
    region: null,
    rna: null as any,
    ui: null as any,
  } satisfies Partial<BContext>)

  // Register embed operators
  for (const op of [ViewRotateOperator, ViewPanOperator, ViewZoomOperator, ResetViewOperator]) {
    ctx.operators.register(op)
  }

  return ctx
}

export { provideBContext as provideEmbedBContext } from '@/workbench/context/bContext'
