<script setup lang="ts">
/**
 * 工作台 3D 视口：始终可编辑，点击选取方块，浮动 ToolShelf。
 * 与 EmbedViewer（Wiki 嵌入）分离，不共享 editMode/features 开关。
 */
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
import { useEditHistory } from '@/workbench/editHistoryContext'
import type { ThreeToolContext } from '@/workbench/tools/_base'
import { createToolContext, type ToolContextDeps } from '@/workbench/tools/interactionFactory'
import { MoveGizmo, type GizmoPart } from '@/workbench/tools/gizmos'
import { updateGizmoState, updateCameraState, logError } from '@/workbench/debug/debugLog'
import * as THREE from 'three'

const props = defineProps<{
  mergedConfig: PreviewConfig
}>()

const ctx = useSceneContext()
const selection = useSelectionContext()

const toolRegistry = useToolRegistry()
const editHistory = useEditHistory()

defineEmits<{}>()

const store = createPreviewSceneStore(props.mergedConfig)
provide(PreviewSceneContextKey, store)

watch(() => props.mergedConfig, async (cfg) => {
  try { await store.reloadFromConfig(cfg) } catch (e) { console.error('[Workbench] reloadFromConfig', e); logError(`reloadFromConfig: ${e}`) }
})

const { hover, setHover, clearHover } = usePreviewTooltip()

let toolCtx: ThreeToolContext | null = null
let overlaySceneRef: THREE.Scene | null = null
let moveGizmo: MoveGizmo | null = null
let gizmoDragPart: GizmoPart = null
let gizmoDragOrigin: THREE.Vector3 | null = null
let gizmoDragging = false
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

  // Create tool context when scene + viewport are ready
  viewportCamera = camera
  orbitTarget = _orbitTarget
  const deps: ToolContextDeps = {
    scene: ctx,
    selection,
    toolRegistry,
    editHistory,
    camera,
    contentGroup: contentGroupRef.value ?? new THREE.Group(),
    domElement: canvas,
    definition: structureDefinition.value!,
    layerPreview: layerPreviewMode.value,
  }
  toolCtx = createToolContext(deps)
  toolRegistry.setToolContext(toolCtx)

  // Attach pointer listeners to canvas
  canvas.addEventListener('pointerdown', handlePointerDown)
  canvas.addEventListener('pointermove', handlePointerMove)
  canvas.addEventListener('pointerup', handlePointerUp)
  canvas.addEventListener('contextmenu', handleContextMenu)

  // Create overlay scene — rendered after main scene with depth cleared
  const overlayScene = new THREE.Scene()
  overlaySceneRef = overlayScene

  // Depth-clear hook: invisible mesh at max renderOrder, clears depth on afterRender
  const depthHookGeo = new THREE.SphereGeometry(0.001, 1, 1)
  const depthHookMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false })
  const depthHook = new THREE.Mesh(depthHookGeo, depthHookMat)
  depthHook.renderOrder = 99999
  depthHook.name = '__gizmo_depth_hook__'
  depthHook.onAfterRender = (renderer: THREE.WebGLRenderer) => {
    renderer.clearDepth()
    renderer.render(overlayScene, camera)
  }
  scene.add(depthHook)

  // Add gizmo, wireframe, annotation preview to overlay scene (not main scene)
  moveGizmo = new MoveGizmo()
  overlayScene.add(moveGizmo.root)

  // Register per-frame gizmo update via requestAnimationFrame wrapper
  const origAnimate = (store as any)._animate as (() => void) | undefined
  if (origAnimate) {
    const wrapped = () => {
      origAnimate()
      updateGizmo()
    }
    ;(store as any)._animate = wrapped
  } else {
    // Fallback: run updateGizmo via setInterval if animate hook isn't accessible
    const interval = setInterval(updateGizmo, 16) // ~60fps
    ;(store as any)._gizmoInterval = interval
  }
}

let annotPreviewMesh: THREE.LineSegments | null = null

function updateAnnotationPreview(): void {
  if (annotPreviewMesh) {
    overlaySceneRef?.remove(annotPreviewMesh)
    annotPreviewMesh.geometry?.dispose()
    ;(annotPreviewMesh.material as THREE.Material)?.dispose()
    annotPreviewMesh = null
  }

  if (!toolCtx?._annotPreview) return
  const { min, max } = toolCtx._annotPreview

  const c = [
    min.x-0.5, min.y-0.5, min.z-0.5, max.x+0.5, min.y-0.5, min.z-0.5,
    max.x+0.5, min.y-0.5, min.z-0.5, max.x+0.5, max.y+0.5, min.z-0.5,
    max.x+0.5, max.y+0.5, min.z-0.5, min.x-0.5, max.y+0.5, min.z-0.5,
    min.x-0.5, max.y+0.5, min.z-0.5, min.x-0.5, min.y-0.5, min.z-0.5,
    min.x-0.5, min.y-0.5, max.z+0.5, max.x+0.5, min.y-0.5, max.z+0.5,
    max.x+0.5, min.y-0.5, max.z+0.5, max.x+0.5, max.y+0.5, max.z+0.5,
    max.x+0.5, max.y+0.5, max.z+0.5, min.x-0.5, max.y+0.5, max.z+0.5,
    min.x-0.5, max.y+0.5, max.z+0.5, min.x-0.5, min.y-0.5, max.z+0.5,
    min.x-0.5, min.y-0.5, min.z-0.5, min.x-0.5, min.y-0.5, max.z+0.5,
    max.x+0.5, min.y-0.5, min.z-0.5, max.x+0.5, min.y-0.5, max.z+0.5,
    max.x+0.5, max.y+0.5, min.z-0.5, max.x+0.5, max.y+0.5, max.z+0.5,
    min.x-0.5, max.y+0.5, min.z-0.5, min.x-0.5, max.y+0.5, max.z+0.5,
  ]

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(c, 3))
  const mat = new THREE.LineBasicMaterial({ color: 0x4488ff, linewidth: 1, depthTest: true, transparent: true, opacity: 0.5 })
  annotPreviewMesh = new THREE.LineSegments(geo, mat)
  overlaySceneRef?.add(annotPreviewMesh)
}

/** 将网格索引 (col, row, zSlice) 转为世界坐标，与 StructureViewport.voxelToWorld 一致 */
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
    const x = world.x
    const y = world.y
    const z = world.z

    // 12 edges per cube, 2 vertices per edge: consecutive pairs form line segments
    const verts = [
      [x-s, y-s, z-s], [x+s, y-s, z-s],
      [x+s, y-s, z-s], [x+s, y+s, z-s],
      [x+s, y+s, z-s], [x-s, y+s, z-s],
      [x-s, y+s, z-s], [x-s, y-s, z-s],
      [x-s, y-s, z+s], [x+s, y-s, z+s],
      [x+s, y-s, z+s], [x+s, y+s, z+s],
      [x+s, y+s, z+s], [x-s, y+s, z+s],
      [x-s, y+s, z+s], [x-s, y-s, z+s],
      [x-s, y-s, z-s], [x-s, y-s, z+s],
      [x+s, y-s, z-s], [x+s, y-s, z+s],
      [x+s, y+s, z-s], [x+s, y+s, z+s],
      [x-s, y+s, z-s], [x-s, y+s, z+s],
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
  if (!moveGizmo || !toolCtx) return

  const tool = toolRegistry.activeTool.value
  const showMoveGizmo = tool?.id === 'move'
  moveGizmo.setVisible(showMoveGizmo)

  if (showMoveGizmo && !gizmoDragging) {
    // Position gizmo at selection center (world coords)
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

  // Call active tool's renderOverlay
  tool?.renderOverlay?.(toolCtx)

  // Update selection wireframe
  updateSelectionWireframe()

  // Update annotation preview wireframe
  updateAnnotationPreview()

  // Debug observability — update gizmo/camera state each frame
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

function handlePointerDown(event: PointerEvent): void {
  if (!toolCtx) return
  toolCtx._selectStart = { x: event.clientX, y: event.clientY }

  // Check gizmo hit for drag initiation
  if (moveGizmo && toolRegistry.activeTool.value?.id === 'move') {
    const cam = viewportCamera
    if (cam) {
      const raycaster = new THREE.Raycaster()
      const rect = (event.target as HTMLElement)?.getBoundingClientRect?.()
      if (rect) {
        const x = ((event.clientX - rect.left) / rect.width) * 2 - 1
        const y = -((event.clientY - rect.top) / rect.height) * 2 + 1
        raycaster.setFromCamera(new THREE.Vector2(x, y), cam)
        const hit = moveGizmo.hitTest(raycaster)
        if (hit && hit.length === 1) {
          gizmoDragPart = hit
          gizmoDragOrigin = moveGizmo.root.position.clone()
          gizmoDragging = true
          return // Gizmo handles the drag, don't forward to tool
        }
      }
    }
  }

  // Forward to active tool if no gizmo hit
  toolRegistry.activeTool.value?.onPointerDown?.(toolCtx, event)
}

function handlePointerMove(event: PointerEvent): void {
  if (!toolCtx) return
  toolRegistry.activeTool.value?.onPointerMove?.(toolCtx, event)

  // Gizmo interaction for Move tool
  if (moveGizmo && toolRegistry.activeTool.value?.id === 'move') {
    const cam = viewportCamera
    if (cam) {
      const raycaster = new THREE.Raycaster()
      const rect = (event.target as HTMLElement)?.getBoundingClientRect?.()
      if (rect) {
        const x = ((event.clientX - rect.left) / rect.width) * 2 - 1
        const y = -((event.clientY - rect.top) / rect.height) * 2 + 1
        raycaster.setFromCamera(new THREE.Vector2(x, y), cam)

        if (gizmoDragging && gizmoDragPart && gizmoDragOrigin) {
          // Compute constrained axis delta
          const delta = moveGizmo.computeAxisDelta(gizmoDragPart, gizmoDragOrigin, raycaster)
          const dirs: Record<string, THREE.Vector3> = {
            x: new THREE.Vector3(1, 0, 0),
            y: new THREE.Vector3(0, 1, 0),
            z: new THREE.Vector3(0, 0, 1),
          }
          const dir = dirs[gizmoDragPart] ?? new THREE.Vector3()
          moveGizmo.root.position.copy(gizmoDragOrigin.clone().addScaledVector(dir, delta))
        } else {
          // Hover highlight
          const hit = moveGizmo.hitTest(raycaster)
          moveGizmo.setHighlight(hit)
        }
      }
    }
  }
}

function handlePointerUp(event: PointerEvent): void {
  if (!toolCtx) return

  // Finish gizmo drag
  if (gizmoDragPart && gizmoDragOrigin) {
    const items = [...selection.items.value]
    if (items.length > 0) {
      const newCenter = moveGizmo!.root.position.clone()
      const delta = {
        x: Math.round(newCenter.x - gizmoDragOrigin.x),
        y: Math.round(newCenter.y - gizmoDragOrigin.y),
        z: Math.round(newCenter.z - gizmoDragOrigin.z),
      }
      if (delta.x !== 0 || delta.y !== 0 || delta.z !== 0) {
        toolCtx.executeMove(items.map(i => ({ ...i.pos })), delta)
      }
    }
    gizmoDragPart = null
    gizmoDragOrigin = null
    gizmoDragging = false
    // Re-snap gizmo to selection center on next frame
    return
  }

  toolRegistry.activeTool.value?.onPointerUp?.(toolCtx, event)
}

function handleContextMenu(event: Event): void {
  // Prevent default browser context menu — ContextMenu.vue handles the rest
  event.preventDefault()
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

const selectedVoxel = computed(() => null) // Disabled — wireframe now rendered by updateSelectionWireframe()

watch(
  worldFrameIndex,
  (i) => {
    ctx.setPreviewWorldFrameIndex(i)
  },
  { immediate: true },
)

onMounted(async () => { await store.loadStructureAndResources() })
onBeforeUnmount(() => {
  // Remove canvas listeners
  const vp = store as any
  const canvas: HTMLElement | undefined = vp._domElement ?? vp._canvas
  if (canvas) {
    canvas.removeEventListener('pointerdown', handlePointerDown)
    canvas.removeEventListener('pointermove', handlePointerMove)
    canvas.removeEventListener('pointerup', handlePointerUp)
    canvas.removeEventListener('contextmenu', handleContextMenu)
  }
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
    <!-- 3D Viewport -->
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

    <!-- 底部 Tab 控件栏 -->
    <div class="wv-bottom-dock">
      <div class="wv-tab-row">
        <button
          v-if="hasWorldMultiFrame"
          class="wv-tab"
          :class="{ 'wv-tab--active': activeTab === 'frame' }"
          @click="activeTab = 'frame'"
        >帧控制</button>
        <button
          class="wv-tab"
          :class="{ 'wv-tab--active': activeTab === 'layer' }"
          @click="activeTab = 'layer'"
        >分层预览</button>
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

    <!-- ToolTip -->
    <ToolTipBox
      v-if="hover && tooltipDisplayText"
      :text="tooltipDisplayText"
      :client-x="hover.clientX"
      :client-y="hover.clientY"
    />
  </div>
</template>

<style scoped>
.wv-root { width: 100%; height: 100%; position: relative; display: flex; flex-direction: column; }
.wv-viewport-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }

/* ===== 底部 Tab 控件栏 ===== */
.wv-bottom-dock {
  flex-shrink: 0;
  display: flex; flex-direction: column;
  background: var(--nei-inset-bg);
}
.wv-tab-row {
  display: flex; align-items: center;
  padding: 0 4px;
  background: var(--nei-bg-deep);
  border-bottom: 1px solid var(--nei-shadow);
}
.wv-tab {
  padding: 6px 14px 5px;
  font-size: 11px; font-family: ui-monospace, 'Cascadia Code', monospace;
  font-weight: 600;
  color: var(--nei-text-muted);
  background: none; border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer; user-select: none;
  white-space: nowrap;
  transition: color 0.15s, border-color 0.15s;
}
.wv-tab:hover { color: var(--nei-text); }
.wv-tab--active {
  color: var(--nei-text);
  border-bottom-color: var(--nei-accent);
}
.wv-tab-status {
  margin-left: auto;
  display: flex; align-items: center; gap: 14px;
  padding: 0 10px;
  font-size: 11px; font-family: ui-monospace, 'Cascadia Code', monospace;
  color: var(--nei-text-muted);
  text-shadow: 0 1px 0 rgba(0, 0, 0, 0.4);
  flex-shrink: 0;
}
.wv-tab-stat strong {
  color: var(--nei-text);
  font-weight: 600;
}
.wv-tab-panel {
  display: none;
  padding: 6px 10px;
  align-items: center; gap: 10px;
  height: 40px;
  background: var(--nei-inset-bg);
}
.wv-tab-panel--active { display: flex; }

/* 子组件嵌入 tab panel 时：拉伸填满，剥除外层边框背景 */
.wv-tab-panel :deep(.wm-wfs) {
  flex: 1; min-width: 0;
  background: transparent; border: none; padding: 0;
}
.wv-tab-panel :deep(.wm-wfp-controls) {
  background: transparent; border: none; padding: 0;
}
.wv-tab-panel :deep(.wm-layer-bar) {
  flex: 1; min-width: 0;
  background: transparent; border: none; padding: 0;
}
</style>
