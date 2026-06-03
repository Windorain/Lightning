<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import RenderEngineHost from '@/shared/viewport/RenderEngineHost.vue'
import type { RenderEngineReadyPayload } from '@/runtime/renderEngine'
import LayerPreviewBar from '@/shared/viewport/LayerPreviewBar.vue'
import WorldFramePlayerControls from '@/shared/viewport/WorldFramePlayerControls.vue'
import WorldFrameScrubber from '@/shared/viewport/WorldFrameScrubber.vue'
import { useContext } from '@/runtime/context'
import { hostKey } from '@/runtime/host'
import type { WorkbenchHost } from '@/runtime/host/workbenchHost'
import { useViewportRuntime } from '@/shared/viewport/useViewportRuntime'
import { REGION } from '@/runtime/regionIds'
import { createToolGizmoHandler } from '@/handlers/toolGizmoHandler'
import { createKeymapHandler } from '@/handlers/keymapHandler'
import { createHoverHandler } from '@/handlers/hoverHandler'
import type { ToolContext } from '@/workbench/tools/tool'
import { pickVoxel, pickAll, getCurrentFrame, gridCenterWorld, getBlockGeometry } from '@/context/queries'
import ToolHintsBar from '@/workbench/ux/ToolHintsBar.vue'
import type { ToolHint } from '@/workbench/tools/tool'

const ctx = useContext()
const host = inject(hostKey)! as WorkbenchHost
const selection = ctx.getSelection()

const VIEWPORT_REGION_ID = REGION.WORKBENCH_VIEWPORT
const prefs = ctx.requireRegion(VIEWPORT_REGION_ID).state.viewer
if (!prefs) throw new Error('viewer preferences missing on r-viewport')

const {
  drw, vpSlot, loadStatus, meshBusy, structureDefinition, mainMeshGroup,
  worldFrameIndex, layerWorldY, framesPlaybackIsPlaying,
  computed: drwComputed, materialLibrary,
} = useViewportRuntime({
  ctx,
  regionId: VIEWPORT_REGION_ID,
  viewerPrefs: prefs,
})

const {
  layerPreviewMode, layerPreviewLabel, gridHeight,
  hasWorldMultiFrame, worldFrameCount,
} = drwComputed

type BottomTab = 'frame' | 'layer'
const _preferredTab = ref<BottomTab>(hasWorldMultiFrame.value ? 'frame' : 'layer')
const activeTab = computed<BottomTab>({
  get: () => hasWorldMultiFrame.value ? _preferredTab.value : 'layer',
  set: (v: BottomTab) => { _preferredTab.value = v },
})

function createToolContext(): ToolContext {
  return {
    selection,
    viewport: vpSlot,
    pickVoxel: (e) => pickVoxel(ctx, e, VIEWPORT_REGION_ID),
    pickAll: (e) => pickAll(ctx, e, VIEWPORT_REGION_ID),
    getCurrentFrame: () => getCurrentFrame(ctx),
    gridCenterWorld: (pos) => gridCenterWorld(ctx, pos),
    getBlockGeometry: (pos) => getBlockGeometry(ctx, pos),
    invokeOperator: (id, props, event, rid) => ctx.getOperators().invoke(id, props ?? {}, event, rid),
    activeTool: ctx.getToolRegistry().activeTool,
    modalDepth: (rid: string) => ctx.wm.events.modalDepth(rid),
  }
}

let _alive = true
let toolCtx: ToolContext | null = null
let unframeHook: (() => void) | null = null
const engineHostRef = ref<InstanceType<typeof RenderEngineHost> | null>(null)

async function onViewportReady(payload: RenderEngineReadyPayload): Promise<void> {
  toolCtx = createToolContext()
  ctx.getToolRegistry().setToolContext(toolCtx)

  await host.attachViewport(VIEWPORT_REGION_ID, {
    drw,
    payload,
    layerPreviewMode: layerPreviewMode.value,
    structureDefinition,
    mainMeshGroup,
    handlers: {
      hover: createHoverHandler(VIEWPORT_REGION_ID, () => ctx),
      gizmo: createToolGizmoHandler(VIEWPORT_REGION_ID, () => ctx, () => toolCtx),
      keymap: createKeymapHandler(VIEWPORT_REGION_ID, () => ctx),
    },
    selectionOutline: {
      selectionItems: selection.items,
      hoveredBlock: ctx.getHoveredBlock(),
      highlightOnHover: computed(() => prefs!.highlightOnHover),
      getBlockGeometry: (pos) => getBlockGeometry(ctx, pos),
      gridCenterWorld: (pos) => gridCenterWorld(ctx, pos),
    },
  })

  const toolsRoot = vpSlot.toolsOverlayGroup.value
  if (vpSlot.gizmo.value && toolsRoot) {
    toolsRoot.add(vpSlot.gizmo.value.root)
  }

  const onFrame = (): void => {
    if (!_alive) return
    try { updateOverlay() } catch (e) { console.error('[Workbench] updateOverlay', e) }
  }
  unframeHook = engineHostRef.value?.addFrameHook(onFrame) ?? null
  onFrame()
}

const toolHints = computed<ToolHint[]>(() => ctx.getToolRegistry().activeTool.value?.hints ?? [])

function updateOverlay(): void {
  const gizmo = ctx.getToolRegistry().activeGizmo.value
  if (gizmo && toolCtx) gizmo.render(toolCtx)

  const moveGizmo = vpSlot.gizmo.value
  if (moveGizmo && ctx.getToolRegistry().activeTool.value?.id === 'move') {
    const gp = moveGizmo.root.position
    ctx.log.updateGizmoState({ x: gp.x, y: gp.y, z: gp.z })
  } else {
    ctx.log.updateGizmoState(null)
  }
  const cam = vpSlot.camera.value
  const orbit = vpSlot.orbitTarget.value
  if (cam) {
    ctx.log.updateCameraState({
      position: [cam.position.x, cam.position.y, cam.position.z],
      target: orbit ? [orbit.x, orbit.y, orbit.z] : [0, 0, 0],
    })
  }
}

function togglePlayback(): void {
  void ctx.getOperators().exec('OPERATOR_TOGGLE_FRAME_PLAYBACK')
}

function setFrameIndex(i: number): void {
  void ctx.getOperators().exec('OPERATOR_SET_FRAME_INDEX', { index: i })
}

function setLayerY(v: number): void {
  void ctx.getOperators().exec('OPERATOR_SET_LAYER_Y', { y: v })
}

const dragOver = ref(false)
let dragEnterCount = 0

function onDragEnter(e: DragEvent) {
  e.preventDefault()
  dragEnterCount++
  if (e.dataTransfer?.types.includes('Files')) dragOver.value = true
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
  ctx.getOperators().exec('OPERATOR_OPEN_SCENE', { file })
}

onMounted(() => {
  void drw.loadStructureAndResources()
})
onBeforeUnmount(() => {
  host.detachViewport(VIEWPORT_REGION_ID)
  _alive = false
  unframeHook?.()
  unframeHook = null
  drw.dispose()
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
    <RenderEngineHost
      ref="engineHostRef"
      v-if="loadStatus === 'ok' && structureDefinition && materialLibrary"
      :definition="structureDefinition"
      :material-library="materialLibrary"
      :content-group="mainMeshGroup"
      :layer-preview-mode="layerPreviewMode"
      :scene-background="0x5a5a5a"
      :show-axes-gizmo="true"
      @ready="onViewportReady"
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
          @toggle="togglePlayback"
        />
        <WorldFrameScrubber
          :has-world-multi-frame="hasWorldMultiFrame"
          :frame-count="worldFrameCount"
          :is-playing="framesPlaybackIsPlaying"
          :mesh-busy="meshBusy"
          :world-frame-index="worldFrameIndex"
          @toggle-playback="togglePlayback"
          @set-frame="setFrameIndex"
        />
      </div>
      <div class="wv-tab-panel" :class="{ 'wv-tab-panel--active': activeTab === 'layer' }">
        <LayerPreviewBar
          :grid-height="gridHeight"
          :mesh-busy="meshBusy"
          :layer-world-y="layerWorldY"
          :layer-preview-label="layerPreviewLabel"
          @update:layer-y="setLayerY"
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
