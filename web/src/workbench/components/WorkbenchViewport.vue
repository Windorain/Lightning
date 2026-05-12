<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import StructureViewport from '@/embed/components/StructureViewport.vue'
import LayerPreviewBar from '@/embed/components/LayerPreviewBar.vue'
import WorldFramePlayerControls from '@/embed/components/WorldFramePlayerControls.vue'
import WorldFrameScrubber from '@/embed/components/WorldFrameScrubber.vue'
import ToolTipBox from '@/embed/components/ToolTipBox.vue'
import type { PreviewConfig } from '@/preview/previewConfig'
import {
  PreviewSceneContextKey,
  createPreviewSceneStore,
} from '@/preview/sceneStore'
import { usePreviewTooltip, resolvePreviewTooltipText } from '@/preview/tooltip'
import { useSceneContext } from '@/workbench/sceneContext'
import { useSelectionContext } from '@/workbench/selectionContext'
import { useToolRegistry } from '@/workbench/toolRegistry'
import { useBContext } from '@/workbench/context/bContext'
import { MoveGizmo } from '@/workbench/tools/gizmos'
import { updateGizmoState, updateCameraState, logError } from '@/workbench/debug/debugLog'
import { eventDispatcher } from '@/workbench/eventDispatcher'
import { createToolGizmoHandler } from '@/workbench/handlers/toolGizmoHandler'
import { createActiveToolHandler } from '@/workbench/handlers/activeToolHandler'
import { createDefaultPickHandler } from '@/workbench/handlers/defaultPickHandler'
import * as THREE from 'three'

const props = defineProps<{
  mergedConfig: PreviewConfig
}>()

const ctx = useSceneContext()
const selection = useSelectionContext()
const toolRegistry = useToolRegistry()
const bctx = useBContext()

defineEmits<{}>()

const store = createPreviewSceneStore(props.mergedConfig)
provide(PreviewSceneContextKey, store)

watch(() => props.mergedConfig, async (cfg) => {
  try { await store.reloadFromConfig(cfg) } catch (e) { console.error('[Workbench] reloadFromConfig', e); logError(`reloadFromConfig: ${e}`) }
})

const { hover, setHover, clearHover } = usePreviewTooltip()

let overlaySceneRef: THREE.Scene | null = null
let moveGizmo: MoveGizmo | null = null
let selectionWireframe: THREE.LineSegments | null = null
let viewportCamera: THREE.Camera | null = null
let orbitTarget: THREE.Vector3 | null = null

const {
  loadStatus,
  structureDefinition,
  materialLibrary,
  layerPreviewMode,
  contentGroupRef,
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

/* ---- Viewport events ---- */
async function onViewportReady(scene: THREE.Scene, camera: THREE.Camera, canvas: HTMLElement, _orbitTarget: THREE.Vector3): Promise<void> {
  store.registerScene(scene)
  try { await store.rebuildContentMesh() } catch (e) { console.error('[Workbench] onViewportReady', e); logError(`rebuildContentMesh: ${e}`) }

  viewportCamera = camera
  orbitTarget = _orbitTarget

  // Wire bContext viewport state
  bctx.camera = camera
  bctx.contentGroup = contentGroupRef.value ?? new THREE.Group()
  bctx.domElement = canvas
  bctx.controlsRef = store.controlsRef as { enabled: boolean } | null
  bctx.definition = structureDefinition.value ?? null
  bctx.layerPreview = layerPreviewMode.value

  // Remap OrbitControls: LMB→tools, MMB→orbit, RMB→pan
  const ctrlRef = store.controlsRef
  if (ctrlRef && 'mouseButtons' in ctrlRef) {
    const mb = (ctrlRef as any).mouseButtons
    if (mb) mb.LEFT = -1
  }

  // EventDispatcher — capture phase runs before OrbitControls' bubble listeners
  canvas.addEventListener('pointerdown', (e) => { if (dispatchCanvas(e)) e.stopImmediatePropagation() }, { capture: true })
  canvas.addEventListener('pointermove', (e) => { dispatchCanvas(e) }, { capture: true })
  canvas.addEventListener('pointerup', (e) => { if (dispatchCanvas(e)) e.stopImmediatePropagation() }, { capture: true })
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault() }, { capture: true })
  document.addEventListener('keydown', (e) => { eventDispatcher.dispatch(e) }, { capture: true })

  // Register handlers (operator-based)
  const unregGizmo = eventDispatcher.registerTypedHandler(
    createToolGizmoHandler(
      () => toolRegistry.activeTool.value?.id ?? 'OPERATOR_SELECT',
      () => moveGizmo,
      () => bctx,
      () => viewportCamera,
      () => store.controlsRef as { enabled: boolean } | null,
    ),
  )
  const unregTool = eventDispatcher.registerTypedHandler(
    createActiveToolHandler(() => bctx),
  )
  const unregPick = eventDispatcher.registerHandler(createDefaultPickHandler())

  ;(store as any)._unregHandlers = [unregGizmo, unregTool, unregPick]

  // Create overlay scene
  const overlayScene = new THREE.Scene()
  overlaySceneRef = overlayScene
  store.registerOverlayScene(overlayScene)

  // MoveGizmo
  moveGizmo = new MoveGizmo()
  overlayScene.add(moveGizmo.root)

  // Per-frame update
  const origAnimate = (store as any)._animate as (() => void) | undefined
  if (origAnimate) {
    const wrapped = () => { origAnimate(); updateGizmo() }
    ;(store as any)._animate = wrapped
  } else {
    const interval = setInterval(updateGizmo, 16)
    ;(store as any)._gizmoInterval = interval
  }
}

function dispatchCanvas(event: Event): boolean {
  const result = eventDispatcher.dispatch(event)
  return result.break
}

let annotPreviewMesh: THREE.LineSegments | null = null

function updateAnnotationPreview(): void {
  if (annotPreviewMesh) {
    overlaySceneRef?.remove(annotPreviewMesh)
    annotPreviewMesh.geometry?.dispose()
    ;(annotPreviewMesh.material as THREE.Material)?.dispose()
    annotPreviewMesh = null
  }
  // Annotation preview is now driven by AnnotationOperator.modal() render state
  // The preview wireframe is rendered by operator.renderOverlay (future phase)
}

function voxelToWorld(col: number, row: number, zSlice: number, def: { cellGrid: any[][][] }): THREE.Vector3 {
  const sCol = def.cellGrid[0]?.[0]?.length ?? 1
  const sRow = def.cellGrid[0]?.length ?? 1
  const sZ = def.cellGrid.length ?? 1
  return new THREE.Vector3(
    col - sCol / 2 + 0.5,
    sRow / 2 - 0.5 - row,
    zSlice - sZ / 2 + 0.5,
  )
}

function updateSelectionWireframe(): void {
  if (selectionWireframe) {
    overlaySceneRef?.remove(selectionWireframe)
    selectionWireframe.geometry?.dispose()
    ;(selectionWireframe.material as THREE.Material)?.dispose()
    selectionWireframe = null
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
  selectionWireframe = new THREE.LineSegments(geo, mat)
  overlaySceneRef?.add(selectionWireframe)
}

function updateGizmo(): void {
  if (!moveGizmo) return

  const tool = toolRegistry.activeTool.value
  const showMoveGizmo = tool?.id === 'OPERATOR_MOVE'
  moveGizmo.setVisible(showMoveGizmo)

  if (showMoveGizmo) {
    const items = selection.items.value
    if (items.size > 0) {
      const def = structureDefinition.value
      if (def) {
        let cx = 0, cy = 0, cz = 0
        for (const item of items) {
          const w = voxelToWorld(item.pos.x, item.pos.y, item.pos.z, def)
          cx += w.x; cy += w.y; cz += w.z
        }
        cx /= items.size; cy /= items.size; cz /= items.size
        moveGizmo.setPosition(new THREE.Vector3(cx, cy, cz))
      }
    }
  }

  updateSelectionWireframe()
  updateAnnotationPreview()

  if (moveGizmo && showMoveGizmo) {
    const gp = moveGizmo.root.position
    updateGizmoState({ x: gp.x, y: gp.y, z: gp.z })
  } else {
    updateGizmoState(null)
  }
  if (viewportCamera) {
    updateCameraState({
      position: [viewportCamera.position.x, viewportCamera.position.y, viewportCamera.position.z],
      target: orbitTarget ? [orbitTarget.x, orbitTarget.y, orbitTarget.z] : [0, 0, 0],
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
    selection.select({ block_state_id: p.blockId, pos: { x: p.voxel.column, y: p.voxel.row, z: p.voxel.zSlice } })
  } else {
    selection.clear()
  }
}

const selectedVoxel = computed(() => null)

watch(worldFrameIndex, (i) => { ctx.setPreviewWorldFrameIndex(i) }, { immediate: true })

onMounted(async () => { await store.loadStructureAndResources() })
onBeforeUnmount(() => {
  const unregs = (store as any)._unregHandlers as Array<() => void> | undefined
  unregs?.forEach(fn => fn())
  const gizmoInterval = (store as any)._gizmoInterval as number | undefined
  if (gizmoInterval) clearInterval(gizmoInterval)
  moveGizmo?.dispose()
  if (selectionWireframe) {
    overlaySceneRef?.remove(selectionWireframe)
    selectionWireframe.geometry?.dispose()
    ;(selectionWireframe.material as THREE.Material)?.dispose()
    selectionWireframe = null
  }
  if (annotPreviewMesh) {
    overlaySceneRef?.remove(annotPreviewMesh)
    annotPreviewMesh.geometry?.dispose()
    ;(annotPreviewMesh.material as THREE.Material)?.dispose()
    annotPreviewMesh = null
  }
  store.disposeCachesAndLibrary()
})
</script>

<template>
  <div class="wv-root">
    <div class="wv-viewport-wrap">
    <StructureViewport
      v-if="loadStatus === 'ok' && structureDefinition && materialLibrary"
      :definition="structureDefinition"
      :material-library="materialLibrary"
      :content-group="contentGroupRef"
      :layer-preview-mode="layerPreviewMode"
      :scene-background="mergedConfig.sceneBackground"
      :edit-mode="true"
      :selected-voxel="selectedVoxel"
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
