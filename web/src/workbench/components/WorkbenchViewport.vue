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
import { MoveGizmo } from '@/workbench/tools/gizmos'
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
  try { await store.reloadFromConfig(cfg) } catch (e) { console.error('[Workbench] reloadFromConfig', e) }
})

const { hover, setHover, clearHover } = usePreviewTooltip()

let toolCtx: ThreeToolContext | null = null
let sceneRef: THREE.Scene | null = null
let moveGizmo: MoveGizmo | null = null
let gizmoDragPart: string | null = null
let gizmoDragOrigin: THREE.Vector3 | null = null

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
async function onViewportReady(scene: THREE.Scene): Promise<void> {
  store.registerScene(scene)
  sceneRef = scene
  try { await store.rebuildContentMesh() } catch (e) { console.error('[Workbench] onViewportReady', e) }

  // Create tool context when scene + viewport are ready
  const vp = store as any
  const camera: THREE.Camera | undefined = vp._camera ?? /* fallback */ scene.children.find(c => c instanceof THREE.Camera) as THREE.Camera | undefined
  const canvas: HTMLElement | undefined = vp._domElement ?? vp._canvas

  if (camera && canvas) {
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

    // Attach pointer listeners to canvas
    canvas.addEventListener('pointerdown', handlePointerDown)
    canvas.addEventListener('pointermove', handlePointerMove)
    canvas.addEventListener('pointerup', handlePointerUp)
    canvas.addEventListener('contextmenu', handleContextMenu)

    // Create and add MoveGizmo to scene
    moveGizmo = new MoveGizmo()
    scene.add(moveGizmo.root)

    // Register per-frame gizmo update via requestAnimationFrame wrapper
    const origAnimate = (vp as any)._animate as (() => void) | undefined
    if (origAnimate) {
      const wrapped = () => {
        origAnimate()
        updateGizmo()
      }
      ;(vp as any)._animate = wrapped
    } else {
      // Fallback: run updateGizmo via setInterval if animate hook isn't accessible
      const interval = setInterval(updateGizmo, 16) // ~60fps
      ;(vp as any)._gizmoInterval = interval
    }
  }
}

let annotPreviewMesh: THREE.LineSegments | null = null

function updateAnnotationPreview(): void {
  if (annotPreviewMesh) {
    sceneRef?.remove(annotPreviewMesh)
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
  sceneRef?.add(annotPreviewMesh)
}

function updateGizmo(): void {
  if (!moveGizmo || !toolCtx) return

  const tool = toolRegistry.activeTool.value
  const showMoveGizmo = tool?.id === 'move'
  moveGizmo.setVisible(showMoveGizmo)

  if (showMoveGizmo) {
    // Position gizmo at selection center
    const items = selection.items.value
    if (items.size > 0) {
      let cx = 0, cy = 0, cz = 0
      for (const item of items) {
        cx += item.pos.x
        cy += item.pos.y
        cz += item.pos.z
      }
      cx /= items.size; cy /= items.size; cz /= items.size
      moveGizmo.setPosition(new THREE.Vector3(cx, cy, cz))
    }
  }

  // Call active tool's renderOverlay
  tool?.renderOverlay?.(toolCtx)

  // Update annotation preview wireframe
  updateAnnotationPreview()
}

function handlePointerDown(event: PointerEvent): void {
  if (!toolCtx) return
  toolCtx._selectStart = { x: event.clientX, y: event.clientY }

  // Check gizmo hit for drag initiation
  if (moveGizmo && toolRegistry.activeTool.value?.id === 'move') {
    const cam = (store as any)._camera as THREE.Camera | undefined
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

  // Hover-highlight gizmo parts for Move tool
  if (moveGizmo && toolRegistry.activeTool.value?.id === 'move') {
    const cam = (store as any)._camera as THREE.Camera | undefined
    if (cam) {
      const raycaster = new THREE.Raycaster()
      const rect = (event.target as HTMLElement)?.getBoundingClientRect?.()
      if (rect) {
        const x = ((event.clientX - rect.left) / rect.width) * 2 - 1
        const y = -((event.clientY - rect.top) / rect.height) * 2 + 1
        raycaster.setFromCamera(new THREE.Vector2(x, y), cam)
        const hit = moveGizmo.hitTest(raycaster)
        moveGizmo.setHighlight(hit)
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

const selectedVoxel = computed(() => {
  if (selection.items.value.size === 0) return null
  const first = selection.items.value.values().next().value
  if (!first) return null
  return { column: first.pos.x, row: first.pos.y, zSlice: first.pos.z }
})

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
  if (annotPreviewMesh) {
    sceneRef?.remove(annotPreviewMesh)
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
