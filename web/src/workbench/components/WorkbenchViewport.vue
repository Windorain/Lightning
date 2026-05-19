<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import ViewerCore, { type ViewerCoreReadyPayload } from '@/embed/components/ViewerCore.vue'
import LayerPreviewBar from '@/embed/components/LayerPreviewBar.vue'
import WorldFramePlayerControls from '@/embed/components/WorldFramePlayerControls.vue'
import WorldFrameScrubber from '@/embed/components/WorldFrameScrubber.vue'
import ToolTipBox from '@/embed/components/ToolTipBox.vue'
import type { View3DConfig } from '@/preview/previewConfig'
import {
  View3DContextKey,
  createView3DStore,
} from '@/preview/sceneStore'
import { usePreviewTooltip, resolvePreviewTooltipText } from '@/preview/tooltip'
import { useSelectionContext } from '@/workbench/selectionContext'
import { useBContext } from '@/workbench/context/bContext'
import { logCenter } from '@/workbench/logging/LogCenter'
import { createToolGizmoHandler } from '@/workbench/handlers/toolGizmoHandler'
import { createKeymapHandler } from '@/workbench/handlers/keymapHandler'
import type { ToolContext } from '@/workbench/tools/tool'
import * as THREE from 'three'

const props = defineProps<{
  config: View3DConfig
}>()

const selection = useSelectionContext()
const bctx = useBContext()

defineEmits<{}>()

const store = createView3DStore(props.config)
provide(View3DContextKey, store)

watch(() => props.config, async (cfg) => {
  try { await store.reloadFromConfig(cfg) } catch (e) { console.error('[Workbench] reloadFromConfig', e); logCenter.error('WorkbenchViewport', `reloadFromConfig: ${e}`) }
})

const { hover, setHover, clearHover } = usePreviewTooltip()

const {
  loadStatus,
  structureDefinition,
  materialLibrary,
  layerPreviewMode,
  mainMeshGroup,
  tooltipPalette,
  hasWorldMultiFrame,
  worldFrameIndex,
  worldFrameCount,
  layerPreviewLabel,
} = store

const tooltipDisplayText = computed(() => {
  const def = structureDefinition.value
  const h = hover.value
  if (!def || !h?.blockId) return ''
  return resolvePreviewTooltipText(def, tooltipPalette.value, h)
})

type BottomTab = 'frame' | 'layer'
const activeTab = ref<BottomTab>(hasWorldMultiFrame.value ? 'frame' : 'layer')

function createToolContext(): ToolContext {
  return {
    scene: bctx.scene,
    selection,
    editHistory: bctx.editHistory,
    viewport: bctx.viewport,
    pickVoxel: (e) => bctx.queries.pickVoxel(e),
    getCurrentFrame: () => bctx.queries.getCurrentFrame(),
    invokeOperator: (id, props, event, rid) => bctx.operators.invoke(id, props ?? {}, event, rid),
    execOperator: (id, props) => bctx.operators.exec(id, props),
    activeTool: bctx.toolRegistry.activeTool,
    modalDepth: (rid: string) => bctx.eventDispatcher.modalDepth(rid),
    setAnnotationDraft: (draft) => (bctx as any).annotationState?.setDraft(draft),
    transient: {},
    resetTransient() { this.transient = {} },
  }
}

/* ---- Viewport events ---- */
async function onViewportReady({ scene, layers, camera, domElement, orbitTarget }: ViewerCoreReadyPayload): Promise<void> {
  store.registerScene(scene)
  try { await store.rebuildContentMesh() } catch (e) { console.error('[Workbench] onViewportReady', e); logCenter.error('WorkbenchViewport', `rebuildContentMesh: ${e}`) }

  // Wire bContext viewport state
  const vp = bctx.viewport
  vp.orbitTarget.value = orbitTarget
  vp.camera.value = camera
  vp.contentGroup.value = mainMeshGroup.value ?? new THREE.Group()
  vp.domElement.value = domElement
  vp.definition.value = structureDefinition.value ?? null
  vp.layerPreview.value = layerPreviewMode.value

  // Build ToolContext for gizmos and tools
  toolCtx = createToolContext()
  bctx.toolRegistry.setToolContext(toolCtx)

  const VIEWPORT_REGION_ID = 'r-viewport'

  // EventDispatcher
  bctx.eventDispatcher.registerRegion(VIEWPORT_REGION_ID)
  bctx.eventDispatcher.setActiveRegion(VIEWPORT_REGION_ID)

  domElement.addEventListener('pointerdown', (e) => {
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
  document.addEventListener('keydown', (e) => { bctx.eventDispatcher.dispatch(e, { regionId: VIEWPORT_REGION_ID }) }, { capture: true })

  // Register handlers
  const unregGizmo = bctx.eventDispatcher.registerRegionHandler(
    VIEWPORT_REGION_ID,
    createToolGizmoHandler(
      VIEWPORT_REGION_ID,
      () => bctx,
      () => toolCtx,
    ),
  )
  const unregKeymap = bctx.eventDispatcher.registerRegionHandler(
    VIEWPORT_REGION_ID,
    createKeymapHandler(VIEWPORT_REGION_ID, () => bctx),
  )

  unregHandlers.push(unregGizmo, unregKeymap)

  // Overlay — use ViewerCore's layer group directly
  vp.overlayGroup.value = layers.overlay

  // Add registered gizmo roots to overlay
  if (vp.gizmo.value) {
    layers.overlay.add(vp.gizmo.value.root)
  }

  // Per-frame gizmo update via rAF
  function rafTick() {
    if (!_alive) return
    gizmoRafId = requestAnimationFrame(rafTick)
    updateOverlay()
  }
  gizmoRafId = requestAnimationFrame(rafTick)
}

let unregHandlers: Array<() => void> = []
let gizmoRafId: number | undefined
let _alive = true
let toolCtx: ToolContext | null = null

function voxelToWorld(x: number, y: number, z: number, def: { cellGrid: any[][][] }): THREE.Vector3 {
  const sCol = def.cellGrid[0]?.[0]?.length ?? 1
  const sRow = def.cellGrid[0]?.length ?? 1
  const sZ = def.cellGrid.length ?? 1
  return new THREE.Vector3(
    x - sCol / 2 + 0.5,
    y - sRow / 2 + 0.5,  // Y-up: y = world Y (0 = bottom, h-1 = top)
    z - sZ / 2 + 0.5,
  )
}

function updateSelectionWireframe(): void {
  if (bctx.viewport.wireframe.value) {
    bctx.viewport.overlayGroup.value?.remove(bctx.viewport.wireframe.value)
    bctx.viewport.wireframe.value.geometry?.dispose()
    ;(bctx.viewport.wireframe.value.material as THREE.Material)?.dispose()
    bctx.viewport.wireframe.value = null
  }

  const items = selection.items.value
  if (items.size === 0 || items.size > 500) return

  const def = structureDefinition.value
  if (!def) return

  const edges: number[] = []
  const s = 0.52

  for (const item of items) {
    const world = voxelToWorld(item.pos.x, item.pos.y, item.pos.z, def)
    const x = world.x; const y = world.y; const z = world.z

    const verts = [
      [x-s, y-s, z-s], [x+s, y-s, z-s], [x+s, y-s, z-s], [x+s, y+s, z-s],
      [x+s, y+s, z-s], [x-s, y+s, z-s], [x-s, y+s, z-s], [x-s, y-s, z-s],
      [x-s, y-s, z+s], [x+s, y-s, z+s], [x+s, y-s, z+s], [x+s, y+s, z+s],
      [x+s, y+s, z+s], [x-s, y+s, z+s], [x-s, y+s, z+s], [x-s, y-s, z+s],
      [x-s, y-s, z-s], [x-s, y-s, z+s], [x+s, y-s, z-s], [x+s, y-s, z+s],
      [x+s, y+s, z-s], [x+s, y+s, z+s], [x-s, y+s, z-s], [x-s, y+s, z+s],
    ]
    for (let i = 0; i < verts.length; i += 2) {
      const p1 = verts[i], p2 = verts[i + 1]
      edges.push(p1[0], p1[1], p1[2], p2[0], p2[1], p2[2])
    }
  }

  if (edges.length === 0) return

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(edges, 3))
  const mat = new THREE.LineBasicMaterial({ color: 0xffaa00, linewidth: 1, depthTest: true })
  bctx.viewport.wireframe.value = new THREE.LineSegments(geo, mat)
  bctx.viewport.overlayGroup.value?.add(bctx.viewport.wireframe.value)
}

function updateOverlay(): void {
  // Call active gizmo's render (MoveGizmo handles its own visibility/positioning)
  const gizmo = bctx.toolRegistry.activeGizmo.value
  if (gizmo && toolCtx) {
    gizmo.render(toolCtx)
  }

  // Selection wireframe (shared, not gizmo-specific)
  updateSelectionWireframe()

  // Debug state
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

function onViewportHover(
  p: { blockId: string; clientX: number; clientY: number; voxel: { column: number; row: number; zSlice: number } } | null,
): void {
  if (p) setHover({ ...p, source: 'viewport' })
  else clearHover('viewport')
}

function onViewportSelect(
  p: { blockId: string; voxel: { column: number; row: number; zSlice: number } } | null,
): void {
  if (p) {
    // 预览视口返回 cellGrid row (0=top)，转换为 Y-up
    const def = structureDefinition.value
    const h = def?.cellGrid[0]?.length ?? 0
    const worldY = h > 0 ? h - 1 - p.voxel.row : p.voxel.row
    selection.select({ block_state_id: p.blockId, pos: { x: p.voxel.column, y: worldY, z: p.voxel.zSlice } })
  } else {
    selection.clear()
  }
}


watch(worldFrameIndex, (i) => { bctx.operators.exec('OPERATOR_SET_FRAME_INDEX', { index: i }) }, { immediate: true })

// Sync vp.definition when the store updates its definition after scene reload
watch(structureDefinition, (def) => {
  bctx.viewport.definition.value = def ?? null
})

onMounted(async () => { await store.loadStructureAndResources() })
onBeforeUnmount(() => {
  unregHandlers.forEach(fn => fn())
  _alive = false
  if (gizmoRafId) cancelAnimationFrame(gizmoRafId)
  if (bctx.viewport.wireframe.value) {
    bctx.viewport.overlayGroup.value?.remove(bctx.viewport.wireframe.value)
    bctx.viewport.wireframe.value.geometry?.dispose()
    ;(bctx.viewport.wireframe.value.material as THREE.Material)?.dispose()
    bctx.viewport.wireframe.value = null
  }
  store.disposeCachesAndLibrary()
})
</script>

<template>
  <div class="wv-root">
    <div class="wv-viewport-wrap">
    <ViewerCore
      v-if="loadStatus === 'ok' && structureDefinition && materialLibrary"
      :definition="structureDefinition"
      :material-library="materialLibrary"
      :content-group="mainMeshGroup"
      :layer-preview-mode="layerPreviewMode"
      :scene-background="config.sceneBackground"
      :edit-mode="true"
      :show-axes-gizmo="config.features.showAxesGizmo !== false"
      @ready="onViewportReady"
      @hover-block="onViewportHover"
      @select-block="onViewportSelect"
    />
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
        <WorldFramePlayerControls />
        <WorldFrameScrubber />
      </div>
      <div class="wv-tab-panel" :class="{ 'wv-tab-panel--active': activeTab === 'layer' }">
        <LayerPreviewBar />
      </div>
    </div>

    <ToolTipBox v-if="hover && tooltipDisplayText" :text="tooltipDisplayText" :client-x="hover.clientX" :client-y="hover.clientY" />
  </div>
</template>

<style scoped>
.wv-root { width: 100%; height: 100%; position: relative; display: flex; flex-direction: column; }
.wv-viewport-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.wv-bottom-dock { flex-shrink: 0; display: flex; flex-direction: column; background: var(--nei-inset-bg); }
.wv-tab-row { display: flex; align-items: center; padding: 0 4px; background: var(--nei-bg-deep); border-bottom: 1px solid var(--nei-shadow); }
.wv-tab { padding: 6px 14px 5px; font-size: 11px; font-family: ui-monospace, 'Cascadia Code', monospace; font-weight: 600; color: var(--nei-text-muted); background: none; border: none; border-bottom: 2px solid transparent; cursor: pointer; user-select: none; white-space: nowrap; transition: color 0.15s, border-color 0.15s; }
.wv-tab:hover { color: var(--nei-text); }
.wv-tab--active { color: var(--nei-text); border-bottom-color: var(--nei-accent); }
.wv-tab-status { margin-left: auto; display: flex; align-items: center; gap: 14px; padding: 0 10px; font-size: 11px; font-family: ui-monospace, 'Cascadia Code', monospace; color: var(--nei-text-muted); text-shadow: 0 1px 0 rgba(0, 0, 0, 0.4); flex-shrink: 0; }
.wv-tab-stat strong { color: var(--nei-text); font-weight: 600; }
.wv-tab-panel { display: none; padding: 6px 10px; align-items: center; gap: 10px; height: 40px; background: var(--nei-inset-bg); }
.wv-tab-panel--active { display: flex; }
.wv-tab-panel :deep(.wm-wfs) { flex: 1; min-width: 0; background: transparent; border: none; padding: 0; }
.wv-tab-panel :deep(.wm-wfp-controls) { background: transparent; border: none; padding: 0; }
.wv-tab-panel :deep(.wm-layer-bar) { flex: 1; min-width: 0; background: transparent; border: none; padding: 0; }
</style>
