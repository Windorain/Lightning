<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import ViewerCore, { type ViewerCoreReadyPayload } from '@/embed/components/ViewerCore.vue'
import LayerPreviewBar from '@/embed/components/LayerPreviewBar.vue'
import WorldFramePlayerControls from '@/embed/components/WorldFramePlayerControls.vue'
import WorldFrameScrubber from '@/embed/components/WorldFrameScrubber.vue'
import { useSelectionContext, type BlockRef } from '@/workbench/selectionContext'
import { useBContext } from '@/workbench/context/bContext'
import { usePreferences } from '@/preview/preferences'
import { createRenderAssets } from '@/workbench/context/sceneLifecycle'
import { logCenter } from '@/workbench/logging/LogCenter'
import { createToolGizmoHandler } from '@/workbench/handlers/toolGizmoHandler'
import { createKeymapHandler } from '@/workbench/handlers/keymapHandler'
import type { ToolContext } from '@/workbench/tools/tool'
import { type Annotation, annotationIsOnLayer } from '@/render/data/annotationTypes'
import { isEditingTarget } from '@/util/browser'
import { SelectionHighlightProvider } from '@/render/mesh/selectionHighlightProvider'
import { SelectionOutlinePass } from '@/render/postprocessing/SelectionOutlinePass'
import ToolHintsBar from '@/workbench/ux/ToolHintsBar.vue'
import type { ToolHint } from '@/workbench/tools/tool'
import * as THREE from 'three'

const selection = useSelectionContext()
const bctx = useBContext()
const prefs = usePreferences()

const VIEWPORT_REGION_ID = 'r-viewport'
const vpSlot = bctx.viewports.get(VIEWPORT_REGION_ID) ?? bctx.viewports.register(VIEWPORT_REGION_ID)

// ---- 本地 ref —— 全部 renderAssets 自管，不挂 bctx ----
const sceneRef = shallowRef<THREE.Scene | null>(null)
const loadStatus = ref<'loading' | 'ok' | 'error'>('loading')
const meshBusy = ref(false)
const blockIconCache = shallowRef<import('@/render/interaction/blockIconCache').BlockIconCache | null>(null)
const tooltipPalette = shallowRef<string[]>([])
const worldFrameIndex = ref(0)
const layerWorldY = ref(-1)
const framesPlaybackIsPlaying = ref(false)

const docRef = computed(() => bctx.doc.value)

const annotations = computed<Annotation[]>(() => {
  const doc = bctx.doc.value
  if (!doc) return []
  const plain = doc.serialize() as Record<string, any>
  return (plain.annotations ?? []) as Annotation[]
})

// ---- renderAssets（viewport 本地） ----
const renderAssets = createRenderAssets({
  docRef,
  loadStatus,
  meshBusy,
  blockIconCache,
  tooltipPalette,
  structureDefinition: vpSlot.definition,
  mainMeshGroup: vpSlot.contentGroup,
  sceneRef,
  worldFrameIndex,
  layerWorldY,
  framesPlaybackIsPlaying,
  blockIconCacheOptions: {},
})

const {
  layerPreviewMode, layerPreviewLabel, gridHeight,
  hasWorldMultiFrame, worldFrameCount,
} = renderAssets.computed

// ---- structEpoch → 重建 mesh ----
watch(() => bctx.structEpoch.value, () => {
  void renderAssets.rebuildAll()
})

// ---- Frame index 同步：local frameIndex → operator → currentWorldFrameIndex → renderAssets ----
watch(worldFrameIndex, (i) => {
  bctx.operators.exec('OPERATOR_SET_FRAME_INDEX', { index: i })
})
watch(() => bctx.currentWorldFrameIndex.value, (i) => {
  void renderAssets.setCurrentWorldFrame(i)
}, { immediate: true })

const structureDefinition = vpSlot.definition
const mainMeshGroup = vpSlot.contentGroup
const materialLibrary = renderAssets.textureCache

type BottomTab = 'frame' | 'layer'
const activeTab = ref<BottomTab>(hasWorldMultiFrame.value ? 'frame' : 'layer')

function createToolContext(): ToolContext {
  return {
    selection,
    viewport: bctx.viewport,
    pickVoxel: (e) => bctx.queries.pickVoxel(e),
    pickAll: (e) => bctx.queries.pickAll(e),
    getCurrentFrame: () => bctx.queries.getCurrentFrame(),
    gridCenterWorld: (pos) => bctx.queries.gridCenterWorld(pos),
    getBlockGeometry: (pos) => bctx.queries.getBlockGeometry(pos),
    invokeOperator: (id, props, event, rid) => bctx.operators.invoke(id, props ?? {}, event, rid),
    activeTool: bctx.toolRegistry.activeTool,
    modalDepth: (rid: string) => bctx.eventDispatcher.modalDepth(rid),
  }
}

/* ---- Viewport events ---- */
async function onViewportReady({ mainScene, overlayScene: _overlayScene, layers, camera, domElement, orbitTarget, renderer: vpRenderer }: ViewerCoreReadyPayload): Promise<void> {
  _annoHash = ''  // reset after tab switch / remount
  bctx.viewports.activeId.value = VIEWPORT_REGION_ID
  renderAssets.registerScene(mainScene)

  // Create and register screen-space outline pass
  const outlinePass = new SelectionOutlinePass(
    new THREE.Vector2(domElement.clientWidth, domElement.clientHeight),
  )
  outlinePass.setCamera(camera as THREE.Camera)
  vpRenderer.setOutlinePass(outlinePass)
  _outlinePass = outlinePass

  try { await renderAssets.rebuildContentMesh() } catch (e) { console.error('[Workbench] onViewportReady', e); logCenter.error('WorkbenchViewport', `rebuildContentMesh: ${e}`) }

  vpSlot.orbitTarget.value = orbitTarget
  vpSlot.camera.value = camera
  vpSlot.contentGroup.value = mainMeshGroup.value ?? new THREE.Group()
  vpSlot.domElement.value = domElement
  vpSlot.definition.value = structureDefinition.value ?? null
  vpSlot.layerPreview.value = layerPreviewMode.value

  toolCtx = createToolContext()
  bctx.toolRegistry.setToolContext(toolCtx)

  bctx.eventDispatcher.registerRegion(VIEWPORT_REGION_ID)
  bctx.eventDispatcher.setActiveRegion(VIEWPORT_REGION_ID)

  domElement.addEventListener('pointerdown', (e) => {
    bctx.viewports.activeId.value = VIEWPORT_REGION_ID
    bctx.eventDispatcher.setActiveRegion(VIEWPORT_REGION_ID)
    if (e.button === 1) e.preventDefault()
    bctx.eventDispatcher.dispatch(e, { regionId: VIEWPORT_REGION_ID })
  }, { capture: true })
  domElement.addEventListener('pointermove', (e) => {
    bctx.eventDispatcher.setActiveRegion(VIEWPORT_REGION_ID)
    bctx.eventDispatcher.dispatch(e, { regionId: VIEWPORT_REGION_ID })
  }, { capture: true })
  domElement.addEventListener('pointerup', (e) => {
    bctx.eventDispatcher.dispatch(e, { regionId: VIEWPORT_REGION_ID })
  }, { capture: true })
  domElement.addEventListener('wheel', (e) => {
    bctx.eventDispatcher.dispatch(e, { regionId: VIEWPORT_REGION_ID })
    e.preventDefault()
  }, { capture: true, passive: false })
  domElement.addEventListener('contextmenu', (e) => { e.preventDefault() }, { capture: true })
  document.addEventListener('keydown', (e) => {
    if (isEditingTarget(e.target)) return
    bctx.eventDispatcher.dispatch(e, { regionId: VIEWPORT_REGION_ID })
  }, { capture: true })

  const unregGizmo = bctx.eventDispatcher.registerRegionHandler(
    VIEWPORT_REGION_ID,
    createToolGizmoHandler(VIEWPORT_REGION_ID, () => bctx, () => toolCtx),
  )
  const unregKeymap = bctx.eventDispatcher.registerRegionHandler(
    VIEWPORT_REGION_ID,
    createKeymapHandler(VIEWPORT_REGION_ID, () => bctx),
  )
  unregHandlers.push(unregGizmo, unregKeymap)

  vpSlot.overlayGroup.value = layers.overlay
  if (vpSlot.gizmo.value) {
    layers.overlay.add(vpSlot.gizmo.value.root)
  }

  function rafTick() {
    if (!_alive) return
    gizmoRafId = requestAnimationFrame(rafTick)
    try { updateOverlay() } catch (e) { console.error('[Workbench] updateOverlay error', e) }
  }
  gizmoRafId = requestAnimationFrame(rafTick)
}

let unregHandlers: Array<() => void> = []
let gizmoRafId: number | undefined
let _alive = true
let toolCtx: ToolContext | null = null

// ---- Tool hints ----
const toolHints = computed<ToolHint[]>(() => {
  return bctx.toolRegistry.activeTool.value?.hints ?? []
})

// ---- Selection highlight (screen-space outline) ----
const highlightProvider = new SelectionHighlightProvider()
let _outlinePass: SelectionOutlinePass | null = null

// ---- Hover highlight ----
const hoveredBlockRef = ref<BlockRef | null>(null)

function onViewportHover(
  payload: { blockId: string; voxel: { column: number; row: number; zSlice: number }; source: string } | null,
): void {
  if (!payload || !prefs.highlightOnHover) {
    hoveredBlockRef.value = null
    return
  }
  const h = gridHeight.value ?? 0
  const worldY = h > 0 ? h - 1 - payload.voxel.row : payload.voxel.row
  hoveredBlockRef.value = {
    pos: { x: payload.voxel.column, y: worldY, z: payload.voxel.zSlice },
    block_state_id: payload.blockId,
  }
}

// ---- Annotation overlay ----
let _annoGroup: THREE.Group | null = null
let _annoHash = ''
let _annoPending = false

function updateAnnotationOverlay(): void {
  const doc = bctx.doc.value as Record<string, any> | null
  let annos: Annotation[] = doc?.annotations ?? []

  const mode = layerPreviewMode.value
  if (mode !== 'all') {
    const gh = gridHeight.value
    annos = annos.filter(a => annotationIsOnLayer(a, mode.worldY, gh))
  }

  const maxUpdated = annos.length > 0
    ? annos.reduce((max, a) => Math.max(max, a.updated_at), 0)
    : 0
  const layerKey = mode === 'all' ? 'all' : `l${mode.worldY}`
  const hash = annos.length > 0 ? `${layerKey}_${annos.length}_${maxUpdated}` : 'empty'
  if (hash === _annoHash || _annoPending) return
  _annoHash = hash
  _annoPending = true

  renderAssets.rebuildAnnotationOverlay(annos).then(group => {
    _annoPending = false
    if (_annoGroup) {
      bctx.viewport.overlayGroup.value?.remove(_annoGroup)
      _annoGroup.traverse((c) => {
        if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments || c instanceof THREE.Line) {
          c.geometry?.dispose()
          ;(c.material as THREE.Material)?.dispose()
        }
      })
      _annoGroup = null
    }
    if (group) {
      _annoGroup = group
      bctx.viewport.overlayGroup.value?.add(_annoGroup)
    }
  }).catch(() => { _annoPending = false })
}

function updateSelectionHighlight(): void {
  if (!_outlinePass) return

  const items = selection.items.value
  const hov = hoveredBlockRef.value
  if (!hov || !prefs.highlightOnHover) {
    // No hover: selection-only (existing behavior)
    if (items.size === 0 || items.size > 500) { _outlinePass.setMaskMeshes([]); return }
    const masks = highlightProvider.build(
      items,
      (pos) => bctx.queries.getBlockGeometry(pos),
      (pos) => bctx.queries.gridCenterWorld(pos),
    )
    _outlinePass.setMaskMeshes(masks)
    return
  }

  // Hover + optional selection: merge, dedup by position
  const entities = new Set(items)
  const dup = [...items].some(
    e => e.kind === 'block' && e.ref.pos.x === hov.pos.x && e.ref.pos.y === hov.pos.y && e.ref.pos.z === hov.pos.z,
  )
  if (!dup) entities.add({ kind: 'block', ref: hov })

  if (entities.size > 500) { _outlinePass.setMaskMeshes([]); return }
  const masks = highlightProvider.build(
    entities,
    (pos) => bctx.queries.getBlockGeometry(pos),
    (pos) => bctx.queries.gridCenterWorld(pos),
  )
  _outlinePass.setMaskMeshes(masks)
}

function updateOverlay(): void {
  const gizmo = bctx.toolRegistry.activeGizmo.value
  if (gizmo && toolCtx) {
    gizmo.render(toolCtx)
  }
  updateSelectionHighlight()
  updateAnnotationOverlay()

  if (bctx.viewport.gizmo.value && bctx.toolRegistry.activeTool.value?.id === 'move') {
    const gp = bctx.viewport.gizmo.value.root.position
    logCenter.updateGizmoState({ x: gp.x, y: gp.y, z: gp.z })
  } else {
    logCenter.updateGizmoState(null)
  }
  if (bctx.viewport.camera.value) {
    logCenter.updateCameraState({
      position: [bctx.viewport.camera.value.position.x, bctx.viewport.camera.value.position.y, bctx.viewport.camera.value.position.z],
      target: bctx.viewport.orbitTarget.value ? [bctx.viewport.orbitTarget.value.x, bctx.viewport.orbitTarget.value.y, bctx.viewport.orbitTarget.value.z] : [0, 0, 0],
    })
  }
}

onMounted(() => {
  void renderAssets.loadStructureAndResources()
})
onBeforeUnmount(() => {
  unregHandlers.forEach(fn => fn())
  _alive = false
  if (gizmoRafId) cancelAnimationFrame(gizmoRafId)
  if (_outlinePass) {
    _outlinePass.dispose()
    _outlinePass = null
  }
  highlightProvider.dispose()
  renderAssets.disposeCachesAndLibrary()
})
</script>

<template>
  <div class="wv-root">
    <div class="wv-viewport-wrap">
      <ToolHintsBar :hints="toolHints" />
    <ViewerCore
      v-if="loadStatus === 'ok' && structureDefinition && materialLibrary"
      :definition="structureDefinition"
      :material-library="materialLibrary"
      :content-group="mainMeshGroup"
      :layer-preview-mode="layerPreviewMode"
      :scene-background="0x5a5a5a"
      :show-axes-gizmo="true"
      :annotations="annotations"
      @ready="onViewportReady"
      @hover-block="onViewportHover"
    />
    <div v-else class="wv-placeholder">
          <svg class="wv-placeholder-icon" viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/></svg>
          <span class="wv-placeholder-title">No scene loaded</span>
          <span class="wv-placeholder-hint">Open a scene from the File menu or drop a .json file</span>
        </div>
    </div>

    <div class="wv-bottom-dock">
      <div class="wv-tab-row">
        <button v-if="hasWorldMultiFrame" class="wv-tab" :class="{ 'wv-tab--active': activeTab === 'frame' }" @click="activeTab = 'frame'">帧控制</button>
        <button class="wv-tab" :class="{ 'wv-tab--active': activeTab === 'layer' }" @click="activeTab = 'layer'">分层预览</button>
        <div class="wv-tab-status">
          <span v-if="hasWorldMultiFrame" class="wv-tab-stat">帧 <strong>{{ worldFrameIndex + 1 }}/{{ worldFrameCount }}</strong></span>
          <span class="wv-tab-stat">层 <strong>{{ layerPreviewLabel }}</strong></span>
        </div>
      </div>
      <div v-if="hasWorldMultiFrame" class="wv-tab-panel" :class="{ 'wv-tab-panel--active': activeTab === 'frame' }">
        <WorldFramePlayerControls
          :has-world-multi-frame="hasWorldMultiFrame"
          :is-playing="framesPlaybackIsPlaying"
          @toggle="renderAssets.toggleWorldFramesPlayback()"
        />
        <WorldFrameScrubber
          :has-world-multi-frame="hasWorldMultiFrame"
          :frame-count="worldFrameCount"
          :is-playing="framesPlaybackIsPlaying"
          :mesh-busy="meshBusy"
          :world-frame-index="worldFrameIndex"
          @toggle-playback="renderAssets.toggleWorldFramesPlayback()"
          @set-frame="(i: number) => renderAssets.setCurrentWorldFrame(i)"
        />
      </div>
      <div class="wv-tab-panel" :class="{ 'wv-tab-panel--active': activeTab === 'layer' }">
        <LayerPreviewBar
          :grid-height="gridHeight"
          :mesh-busy="meshBusy"
          :layer-world-y="layerWorldY"
          :layer-preview-label="layerPreviewLabel"
          @update:layer-y="(v: number) => { layerWorldY = v }"
        />
      </div>
    </div>

  </div>
</template>

<style scoped>
.wv-root { width: 100%; height: 100%; position: relative; display: flex; flex-direction: column; }
.wv-viewport-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
.wv-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  color: var(--wb-text-muted);
}
.wv-placeholder-icon { opacity: 0.25; color: var(--wb-text-dim); }
.wv-placeholder-title { font-size: 15px; font-weight: 500; color: var(--wb-text-dim); }
.wv-placeholder-hint { font-size: 11px; color: var(--wb-text-muted); }
.wv-bottom-dock { flex-shrink: 0; display: flex; flex-direction: column; background: var(--wb-bg-elevated); box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.12); }
.wv-tab-row { display: flex; align-items: center; padding: 0 4px; background: var(--wb-bg-surface); border-bottom: 1px solid var(--wb-border); }
.wv-tab { padding: 6px 14px 5px; font-size: 12px; font-family: system-ui, sans-serif; font-weight: 600; color: var(--wb-text-muted); background: none; border: none; border-bottom: 2px solid transparent; cursor: pointer; user-select: none; white-space: nowrap; transition: color 0.15s, border-color 0.15s; }
.wv-tab:hover { color: var(--wb-text); }
.wv-tab--active { color: var(--wb-text); border-bottom-color: var(--wb-accent); }
.wv-tab-status { margin-left: auto; display: flex; align-items: center; gap: 14px; padding: 0 10px; font-size: 12px; font-family: system-ui, sans-serif; color: var(--wb-text-muted); flex-shrink: 0; }
.wv-tab-stat strong { color: var(--wb-text); font-weight: 600; }
.wv-tab-panel { display: none; padding: 6px 10px; align-items: center; gap: 10px; height: 40px; background: var(--wb-bg-elevated); }
.wv-tab-panel--active { display: flex; }
.wv-tab-panel :deep(.wm-wfs) { flex: 1; min-width: 0; background: transparent; border: none; padding: 0; }
.wv-tab-panel :deep(.wm-wfp-controls) { background: transparent; border: none; padding: 0; }
.wv-tab-panel :deep(.wm-layer-bar) { flex: 1; min-width: 0; background: transparent; border: none; padding: 0; }
</style>
