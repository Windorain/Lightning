/**
 * Embed BContext 工厂 — 创建完整 BContext 供嵌入场景使用。
 *
 * 核心逻辑委托给 createSceneLifecycle（与 workbench 共享）。
 */
import { ref, shallowRef } from 'vue'
import type { BContext, LoadStatus } from '@/workbench/context/bContext'
import { createViewportManager } from '@/workbench/context/bContext'
import { createSceneLifecycle } from '@/workbench/context/sceneLifecycle'
import type { View3DConfig } from '@/preview/previewConfig'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import { globalOperators } from '@/workbench/operators/operatorRegistry'
import { eventDispatcher } from '@/workbench/eventDispatcher'
import * as THREE from 'three'

// Operators
import { ViewRotateOperator, ViewPanOperator, ViewZoomOperator } from '@/workbench/operators/builtin/viewOperators'
import { ResetViewOperator } from '@/embed/operators/resetViewOperator'

export function createEmbedBContext(config: View3DConfig): BContext {
  // ---- Shared state ----
  const configRef = shallowRef<View3DConfig>(config)
  const loadStatus = ref<LoadStatus>('loading')
  const meshBusy = ref(false)
  const materialLibrary = shallowRef<MaterialLibraryApi | null>(null)
  const blockIconCache = shallowRef(null) as any
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

  // ---- Scene lifecycle (shared) ----
  const lifecycle = createSceneLifecycle({
    configRef,
    loadStatus,
    meshBusy,
    materialLibrary: materialLibrary as any,
    blockIconCache,
    tooltipPalette,
    structureDefinition,
    mainMeshGroup,
    sceneRef,
    worldFrameIndex,
    layerWorldY,
    framesPlaybackIsPlaying,
  })

  const {
    layerPreviewMode, layerPreviewLabel, gridHeight,
    hasWorldMultiFrame, worldFrameCount, blockStatsEntries,
  } = lifecycle.computed

  // ---- Assemble bctx (partial, for self-reference) ----
  const ctx = {} as BContext

  // ---- Operators ----
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
    materialLibrary: materialLibrary as any,
    blockIconCache,
    tooltipPalette,
    worldFrameIndex,
    worldFrameCount,
    hasWorldMultiFrame,
    framesPlaybackIsPlaying,
    toggleWorldFramesPlayback: lifecycle.toggleWorldFramesPlayback,
    setCurrentWorldFrame: lifecycle.setCurrentWorldFrame,
    layerWorldY,
    layerPreviewMode,
    layerPreviewLabel,
    gridHeight,
    loadStructureAndResources: lifecycle.loadStructureAndResources,
    rebuildContentMesh: lifecycle.rebuildContentMesh,
    rebuildAnnotationOverlay: lifecycle.rebuildAnnotationOverlay,
    reloadFromConfig: lifecycle.reloadFromConfig,
    disposeCachesAndLibrary: lifecycle.disposeCachesAndLibrary,
    registerScene: lifecycle.registerScene,
    blockStatsEntries,
    viewports,
    operators,
    eventDispatcher,
    settings: {
      replaceBrush: null, fillBrush: null, generateType: null,
      dragSensitivity: 0.05, snapEnabled: true,
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
      entries: { value: [] }, lastDisplayable: { value: null },
      debug: () => undefined as unknown, info: () => undefined as unknown,
      operator: () => undefined as unknown, warn: () => undefined as unknown,
      error: () => undefined as unknown, clear: () => {},
      contains: () => false, recent: () => [],
    } as any,
    wikiConfig: null as any,
    wm: {} as any,
    screen: null, rna: null as any, ui: null as any,
  })

  // Register embed operators
  for (const op of [ViewRotateOperator, ViewPanOperator, ViewZoomOperator, ResetViewOperator]) {
    ctx.operators.register(op)
  }

  return ctx
}

export { provideBContext as provideEmbedBContext } from '@/workbench/context/bContext'
