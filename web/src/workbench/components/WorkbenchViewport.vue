<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ViewerCore, { type ViewerCoreReadyPayload } from '@/shared/viewport/ViewerCore.vue'
import LayerPreviewBar from '@/shared/viewport/LayerPreviewBar.vue'
import WorldFramePlayerControls from '@/shared/viewport/WorldFramePlayerControls.vue'
import WorldFrameScrubber from '@/shared/viewport/WorldFrameScrubber.vue'
import { useViewport, updateAnnotationOverlay, disposeAnnotationOverlay } from '@/shared/composables/useViewport'
import { useSelectionContext, type BlockRef } from '@/context/selection'
import { useBContext } from '@/context/bContext'
import { createRenderAssets } from '@/context/renderAssets'
import { usePreferences } from '@/preview/preferences'
import { logCenter } from '@/logging/LogCenter'
import { structureRowToWorldY } from '@/pure/vec'
import { createToolGizmoHandler } from '@/handlers/toolGizmoHandler'
import { createKeymapHandler } from '@/handlers/keymapHandler'
import type { ToolContext } from '@/workbench/tools/tool'
import { type Annotation } from '@/render/data/annotationTypes'
import { isEditingTarget } from '@/util/browser'
import { SelectionHighlightProvider } from '@/render/mesh/selectionHighlightProvider'
import ToolHintsBar from '@/workbench/ux/ToolHintsBar.vue'
import type { ToolHint } from '@/workbench/tools/tool'
import * as THREE from 'three'

const selection = useSelectionContext()
const bctx = useBContext()
const prefs = usePreferences()

const VIEWPORT_REGION_ID = 'r-viewport'
const vpSlot = bctx.viewports.get(VIEWPORT_REGION_ID) ?? bctx.viewports.register(VIEWPORT_REGION_ID)

// ---- Viewport composable (shared with EmbedViewport) ----
const vp = useViewport({
  bctx,
  structureDefinition: vpSlot.definition,
  mainMeshGroup: vpSlot.contentGroup,
  blockIconCacheOptions: {},
  createRenderAssets,
})
const {
  loadStatus, meshBusy,
  structureDefinition, mainMeshGroup, worldFrameIndex, layerWorldY,
  framesPlaybackIsPlaying,
  renderAssets, outlinePass,
} = vp

const annotations = computed<Annotation[]>(() => {
  const doc = bctx.doc.value
  if (!doc) return []
  const plain = doc.serialize() as Record<string, any>
  return (plain.annotations ?? []) as Annotation[]
})

const {
  layerPreviewMode, layerPreviewLabel, gridHeight,
  hasWorldMultiFrame, worldFrameCount,
} = renderAssets.computed

// ---- Frame index 同步：local worldFrameIndex → operator → bctx.currentWorldFrameIndex ----
// setCurrentWorldFrame 是帧切换的权威路径（scrubber/playback 直接调用），
// 内部完成 mesh 重建并更新 worldFrameIndex。此 watcher 仅负责将 worldFrameIndex
// 同步到 bctx.currentWorldFrameIndex 供下游（StatusBar 等）消费。
watch(worldFrameIndex, (i) => {
  bctx.operators.exec('OPERATOR_SET_FRAME_INDEX', { index: i })
})

const materialLibrary = renderAssets.textureCache

type BottomTab = 'frame' | 'layer'
const _preferredTab = ref<BottomTab>(hasWorldMultiFrame.value ? 'frame' : 'layer')
const activeTab = computed<BottomTab>({
  get: () => hasWorldMultiFrame.value ? _preferredTab.value : 'layer',
  set: (v: BottomTab) => { _preferredTab.value = v },
})

function createToolContext(): ToolContext {
  const q = bctx.queries!
  return {
    selection,
    viewport: bctx.viewport,
    pickVoxel: (e) => q.pickVoxel(e),
    pickAll: (e) => q.pickAll(e),
    getCurrentFrame: () => q.getCurrentFrame(),
    gridCenterWorld: (pos) => q.gridCenterWorld(pos),
    getBlockGeometry: (pos) => q.getBlockGeometry(pos),
    invokeOperator: (id, props, event, rid) => bctx.operators.invoke(id, props ?? {}, event, rid),
    activeTool: bctx.toolRegistry.activeTool,
    modalDepth: (rid: string) => bctx.eventDispatcher.modalDepth(rid),
  }
}

/* ---- Viewport events ---- */
async function onViewportReady({ mainScene, overlayScene: _overlayScene, layers, camera, domElement, orbitTarget, renderer: vpRenderer }: ViewerCoreReadyPayload): Promise<void> {
  bctx.viewports.activeId.value = VIEWPORT_REGION_ID
  renderAssets.registerScene(mainScene)
  renderAssets.init()

  // Register screen-space outline pass
  outlinePass.setCamera(camera as THREE.Camera)
  vpRenderer.setOutlinePass(outlinePass)

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
  const _onKeydown = (e: KeyboardEvent) => {
    if (isEditingTarget(e.target)) return
    bctx.eventDispatcher.dispatch(e, { regionId: VIEWPORT_REGION_ID })
  }
  document.addEventListener('keydown', _onKeydown, { capture: true })
  unregHandlers.push(() => document.removeEventListener('keydown', _onKeydown, { capture: true }))

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
  const worldY = h > 0 ? structureRowToWorldY(payload.voxel.row, h) : payload.voxel.row
  hoveredBlockRef.value = {
    pos: { x: payload.voxel.column, y: worldY, z: payload.voxel.zSlice },
    block_state_id: payload.blockId,
  }
}

// ---- Annotation overlay (shared via useViewport composable) ----

function updateSelectionHighlight(): void {
  if (!outlinePass) return
  const q = bctx.queries
  if (!q) return

  const items = selection.items.value
  const hov = hoveredBlockRef.value
  if (!hov || !prefs.highlightOnHover) {
    // No hover: selection-only (existing behavior)
    if (items.size === 0 || items.size > 500) { outlinePass.setMaskMeshes([]); return }
    const masks = highlightProvider.build(
      items,
      (pos) => q.getBlockGeometry(pos),
      (pos) => q.gridCenterWorld(pos),
    )
    outlinePass.setMaskMeshes(masks)
    return
  }

  // Hover + optional selection: merge, dedup by position
  const entities = new Set(items)
  const dup = [...items].some(
    e => e.kind === 'block' && e.ref.pos.x === hov.pos.x && e.ref.pos.y === hov.pos.y && e.ref.pos.z === hov.pos.z,
  )
  if (!dup) entities.add({ kind: 'block', ref: hov })

  if (entities.size > 500) { outlinePass.setMaskMeshes([]); return }
  const masks = highlightProvider.build(
    entities,
    (pos) => q.getBlockGeometry(pos),
    (pos) => q.gridCenterWorld(pos),
  )
  outlinePass.setMaskMeshes(masks)
}

function updateOverlay(): void {
  const gizmo = bctx.toolRegistry.activeGizmo.value
  if (gizmo && toolCtx) {
    gizmo.render(toolCtx)
  }
  updateSelectionHighlight()
  updateAnnotationOverlay(bctx, renderAssets)

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

// ---- 拖拽文件加载 ----
const dragOver = ref(false)
let dragEnterCount = 0

function onDragEnter(e: DragEvent) {
  e.preventDefault()
  dragEnterCount++
  if (e.dataTransfer?.types.includes('Files')) {
    dragOver.value = true
  }
}
function onDragOver(e: DragEvent) {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}
function onDragLeave(_e: DragEvent) {
  dragEnterCount--
  if (dragEnterCount <= 0) {
    dragEnterCount = 0
    dragOver.value = false
  }
}
function onDrop(e: DragEvent) {
  e.preventDefault()
  dragOver.value = false
  dragEnterCount = 0
  const file = e.dataTransfer?.files[0]
  if (!file) return
  bctx.operators.exec('OPERATOR_OPEN_SCENE', { file })
}

onMounted(() => {
  void renderAssets.loadStructureAndResources()
})
onBeforeUnmount(() => {
  unregHandlers.forEach(fn => fn())
  _alive = false
  if (gizmoRafId) cancelAnimationFrame(gizmoRafId)
  outlinePass.dispose()
  disposeAnnotationOverlay(bctx.viewport.id)
  highlightProvider.dispose()
  renderAssets.disposeCachesAndLibrary()
  renderAssets.dispose()
})
</script>

<template>
  <div class="wv-root">
    <div
      class="wv-viewport-wrap"
      @dragenter="onDragEnter"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
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
      <div v-if="dragOver" class="wv-drag-overlay">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <span>释放以加载场景</span>
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

.wv-drag-overlay {
  position: absolute;
  inset: 0;
  z-index: 500;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgba(77, 171, 247, 0.12);
  border: 3px dashed var(--wb-accent);
  pointer-events: none;
  color: var(--wb-accent);
  font-size: 15px;
  font-weight: 600;
  backdrop-filter: blur(2px);
}

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
