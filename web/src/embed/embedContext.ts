/**
 * Embed BContext 工厂 — 创建完整 BContext 供嵌入场景使用。
 *
 * 与 workbench 同构：接收 document + settings，内部用 createRenderAssets。
 */
import { ref, shallowRef } from 'vue'
import type { Ref } from 'vue'
import type { BContext, LoadStatus } from '@/workbench/context/bContext'
import { createViewportManager } from '@/workbench/context/bContext'
import { createRenderAssets } from '@/workbench/context/sceneLifecycle'
import type { EmbedSettings } from '@/preview/previewConfig'
import type { BlockIconCache } from '@/render/interaction/blockIconCache'
import type { OperatorType } from '@/workbench/operators/operatorType'
import { globalOperators } from '@/workbench/operators/operatorRegistry'
import { EventDispatcherImpl } from '@/workbench/eventDispatcher'
import * as THREE from 'three'

// Operators
import { ViewRotateOperator, ViewPanOperator, ViewZoomOperator } from '@/workbench/operators/builtin/viewOperators'
import { ResetViewOperator } from '@/embed/operators/resetViewOperator'

export function createEmbedBContext(document: unknown, settings: EmbedSettings): BContext {
  // ---- Shared state ----
  const docRef = ref<unknown>(document)
  const loadStatus = ref<LoadStatus>('loading')
  const meshBusy = ref(false)
  const blockIconCache = shallowRef<BlockIconCache | null>(null)
  const tooltipPalette = shallowRef<string[]>([])
  const sceneRef = shallowRef<THREE.Scene | null>(null)

  // ---- Viewport slots ----
  const viewports = createViewportManager()
  const defaultVp = viewports.register('r-viewport')
  const structureDefinition = defaultVp.definition
  const mainMeshGroup = defaultVp.contentGroup

  // Frame/Layer
  const worldFrameIndex = ref(0)
  const layerWorldY = ref(settings.initialLayerWorldY)
  const framesPlaybackIsPlaying = ref(false)

  // ---- renderAssets（shared）— textureCache built internally from doc ----
  const renderAssets = createRenderAssets({
    docRef: docRef as Ref<unknown>,
    loadStatus,
    meshBusy,
    blockIconCache,
    tooltipPalette,
    structureDefinition,
    mainMeshGroup,
    sceneRef,
    worldFrameIndex,
    layerWorldY,
    framesPlaybackIsPlaying,
    blockIconCacheOptions: settings.blockIconCacheOptions ?? {},
    initialWorldFrameIndex: settings.initialWorldFrameIndex,
  })

  const {
    layerPreviewMode, layerPreviewLabel, gridHeight,
    hasWorldMultiFrame, worldFrameCount, blockStatsEntries,
  } = renderAssets.computed

  // ---- Operators ----
  const operators = {
    exec: (id: string, props?: Record<string, unknown>) => globalOperators.exec(ctx, id, props),
    invoke: (id: string, props?: Record<string, unknown>, event?: Event, regionId?: string) =>
      globalOperators.invoke(ctx, id, props, event as PointerEvent | KeyboardEvent, regionId),
    find: (id: string) => { const o = globalOperators.find(id); return o ? { id: o.id, label: o.label } : undefined },
    all: () => globalOperators.all().map(o => ({ id: o.id, label: o.label })),
    register: (op: OperatorType) => globalOperators.register(op),
  }

  // ---- Atomic bctx assembly ----
  const ctx = {
    materialLibrary: renderAssets.textureCache,
    initialCamera: settings.initialCamera,
    loadStatus,
    meshBusy,
    blockIconCache,
    tooltipPalette,
    worldFrameIndex,
    worldFrameCount,
    hasWorldMultiFrame,
    framesPlaybackIsPlaying,
    toggleWorldFramesPlayback: renderAssets.toggleWorldFramesPlayback,
    setCurrentWorldFrame: renderAssets.setCurrentWorldFrame,
    layerWorldY,
    layerPreviewMode,
    layerPreviewLabel,
    gridHeight,
    loadStructureAndResources: renderAssets.loadStructureAndResources,
    rebuildContentMesh: renderAssets.rebuildContentMesh,
    rebuildAnnotationOverlay: renderAssets.rebuildAnnotationOverlay,
    disposeCachesAndLibrary: renderAssets.disposeCachesAndLibrary,
    registerScene: renderAssets.registerScene,
    reloadFromConfig: async () => { await renderAssets.rebuildAll() },
    blockStatsEntries,
    viewports,
    get viewport() { return viewports.active.value! },
    operators,
    eventDispatcher: new EventDispatcherImpl(),
    settings: {
      replaceBrush: null, fillBrush: null, generateType: null,
      dragSensitivity: 0.05, snapEnabled: true,
    },
    statusMessage: { value: '' },

    // Workbench-only fields — stub
    doc: null!,
    dirty: null!,
    structEpoch: null!,
    currentWorldFrameIndex: null!,
    workspaceMode: null!,
    localFileName: null!,
    markDirty: null!,
    markStructureDirty: null!,
    markClean: null!,
    connectionApiBase: null!,
    connectionToken: null!,
    connectionConnected: null!,
    connectionExports: null!,
    connectionExportsLoading: null!,
    connectionSelectedExportName: null!,
    selection: null!,
    editHistory: null!,
    toolRegistry: null!,
    queries: null!,
    log: null!,
    wikiConfig: null!,
    wm: {},
    screen: null,
    rna: null!,
    ui: null!,
  }

  // Register embed operators
  for (const op of [ViewRotateOperator, ViewPanOperator, ViewZoomOperator, ResetViewOperator]) {
    ctx.operators.register(op)
  }

  return ctx
}

export { provideBContext as provideEmbedBContext } from '@/workbench/context/bContext'
