/**
 * Embed BContext 工厂 — 创建完整 BContext 供嵌入场景使用。
 *
 * 核心逻辑委托给 createSceneLifecycle（与 workbench 共享）。
 */
import { ref, shallowRef, computed } from 'vue'
import type { Ref, ShallowRef } from 'vue'
import type { BContext, LoadStatus } from '@/workbench/context/bContext'
import { createViewportManager } from '@/workbench/context/bContext'
import { createRenderAssets } from '@/workbench/context/sceneLifecycle'
import type { View3DConfig } from '@/preview/previewConfig'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import type { BlockIconCache } from '@/render/interaction/blockIconCache'
import type { OperatorType } from '@/workbench/operators/operatorType'
import { globalOperators } from '@/workbench/operators/operatorRegistry'
import { EventDispatcherImpl } from '@/workbench/eventDispatcher'
import * as THREE from 'three'

// Operators
import { ViewRotateOperator, ViewPanOperator, ViewZoomOperator } from '@/workbench/operators/builtin/viewOperators'
import { ResetViewOperator } from '@/embed/operators/resetViewOperator'

export function createEmbedBContext(config: View3DConfig): BContext {
  // ---- Shared state ----
  const configRef = shallowRef<View3DConfig>(config)
  const docRef = computed(() => configRef.value.renderBundle.document)
  const loadStatus = ref<LoadStatus>('loading')
  const meshBusy = ref(false)
  const materialLibrary = shallowRef<MaterialLibraryApi | null>(config.materialLibrary)
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
  const layerWorldY = ref(config.initialLayerWorldY)
  const framesPlaybackIsPlaying = ref(false)

  // ---- renderAssets (shared) ----
  const renderAssets = createRenderAssets({
    docRef: docRef as Ref<unknown>,
    loadStatus,
    meshBusy,
    materialLibrary,
    blockIconCache,
    tooltipPalette,
    structureDefinition,
    mainMeshGroup,
    sceneRef,
    worldFrameIndex,
    layerWorldY,
    framesPlaybackIsPlaying,
    blockIconCacheOptions: config.blockIconCacheOptions ?? {},
    initialWorldFrameIndex: config.initialWorldFrameIndex,
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
  const ctx: BContext = {
    config: configRef as unknown as ShallowRef<import('@/preview/previewConfig').View3DConfig | null>,
    loadStatus,
    meshBusy,
    materialLibrary,
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
    reloadFromConfig: async (cfg: import('@/preview/previewConfig').View3DConfig) => { configRef.value = cfg as any; await renderAssets.rebuildAll() },
    disposeCachesAndLibrary: renderAssets.disposeCachesAndLibrary,
    registerScene: renderAssets.registerScene,
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
