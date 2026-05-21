<script setup lang="ts">
/**
 * ViewerCore — 自包含 3D 视口组件。
 * 创建 Scene + lights + 3 层 Group + View3DRenderer，管 RAF / 拾取 / 相机适配。
 * 不接触 BlockPaletteEntry / cellGrid / selection / operator。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'

import { View3DRenderer } from '@/render/viewport/renderViewport'
import {
  applyDiagonalOrbitView,
  applyInitialCamera,
  STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG,
} from '@/render/interaction/initialCamera'
import type { LayerPreviewMode } from '@/render/data/layerPreview'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import { scenePickFromPointer } from '@/render/interaction/scenePick'
import type { StructureDefinition } from '@/render/schema/types'
import type { InitialCamera } from '@/preview/previewConfig'

export interface ViewerCoreReadyPayload {
  scene: THREE.Scene
  layers: { structure: THREE.Group; decal: THREE.Group; overlay: THREE.Group }
  camera: THREE.Camera
  domElement: HTMLElement
  orbitTarget: THREE.Vector3
}

const ORTHO_FRUSTUM_REF_HALF_FOV_DEG = 25

const props = withDefaults(
  defineProps<{
    definition: StructureDefinition
    materialLibrary: MaterialLibraryApi
    contentGroup: THREE.Group | null
    layerPreviewMode: LayerPreviewMode
    sceneBackground?: number
    showAxesGizmo?: boolean
    initialCamera?: InitialCamera
  }>(),
  {
    sceneBackground: 0x0b1217,
    showAxesGizmo: true,
  },
)

const emit = defineEmits<{
  ready: [{
    scene: THREE.Scene
    layers: { structure: THREE.Group; decal: THREE.Group; overlay: THREE.Group }
    camera: THREE.Camera
    domElement: HTMLElement
    orbitTarget: THREE.Vector3
  }]
  'hover-block': [
    payload: {
      blockId: string; clientX: number; clientY: number
      source: 'viewport'; voxel: { column: number; row: number; zSlice: number }
    } | null,
  ]
  'open-settings': []
  'open-workbench': []
}>()

function onScreenshot(): void {
  const canvas = renderer?.domElement
  if (!canvas) return
  const dataUrl = canvas.toDataURL('image/png')
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = `lightning-screenshot-${Date.now()}.png`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

function onFullscreen(): void {
  container.value?.requestFullscreen?.()
}

function onResetView(): void {
  if (renderer && props.contentGroup) {
    fitCameraToGroup(renderer, props.contentGroup)
  }
}

function clampOrthoZoom(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1
}

const container = ref<HTMLDivElement | null>(null)

let renderer: View3DRenderer | null = null
let scene: THREE.Scene | null = null
let layers: { structure: THREE.Group; decal: THREE.Group; overlay: THREE.Group } | null = null
let animationId = 0
let layoutResizeRaf: number | null = null
let resizeObserver: ResizeObserver | null = null
let onResize: (() => void) | null = null
let onVisibilityToGl: (() => void) | null = null

let canvasEl: HTMLElement | null = null
let rafHoverPending = false
let lastPointer: { clientX: number; clientY: number } | null = null
let skipNextContentGroupAutoFit = false

function runPick(): void {
  const vp = renderer
  const g = props.contentGroup
  const dom = canvasEl
  if (!vp || !g || !dom || !lastPointer) return

  const picked = scenePickFromPointer({
    clientX: lastPointer.clientX, clientY: lastPointer.clientY,
    domElement: dom, camera: vp.camera,
    contentGroup: g, overlayGroup: layers?.overlay,
    def: props.definition,
    layerPreview: props.layerPreviewMode,
  })

  if (picked && picked.kind === 'block') {
    emit('hover-block', {
      blockId: picked.blockId,
      clientX: lastPointer.clientX, clientY: lastPointer.clientY,
      source: 'viewport',
      voxel: { column: picked.column, row: picked.row, zSlice: picked.zSlice },
    })
  } else {
    emit('hover-block', null)
  }
}

function onPointerMove(e: PointerEvent): void {
  lastPointer = { clientX: e.clientX, clientY: e.clientY }
  if (rafHoverPending) return
  rafHoverPending = true
  requestAnimationFrame(() => { rafHoverPending = false; runPick() })
}

function onPointerLeave(): void {
  lastPointer = null
  emit('hover-block', null)
}

function fitCameraToGroup(vp: View3DRenderer, group: THREE.Group): void {
  group.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(group)
  if (box.isEmpty() || !Number.isFinite(box.min.x)) return
  const center = new THREE.Vector3()
  const size = new THREE.Vector3()
  box.getCenter(center)
  box.getSize(size)
  const maxDim = Math.max(size.x, size.y, size.z, 0.1)
  const dist = Math.max(8, maxDim * 2.2)
  const cam = props.initialCamera
  const finalDist = cam?.distance ?? dist
  const o = vp.camera
  vp.orbitTarget.copy(center)
  applyDiagonalOrbitView(o, vp.orbitTarget, {
    yawDeg: cam?.yawDeg ?? 225,
    elevationFromHorizontalDeg: cam?.elevationDeg ?? STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG,
    distance: finalDist,
  })
  const orthoHeight = 2 * Math.abs(finalDist) * Math.tan(THREE.MathUtils.degToRad(ORTHO_FRUSTUM_REF_HALF_FOV_DEG))
  const dom = vp.domElement
  const aspect = dom.clientWidth / Math.max(dom.clientHeight, 1)
  const halfH = orthoHeight / 2
  o.top = halfH; o.bottom = -halfH
  o.left = -halfH * aspect; o.right = halfH * aspect
  o.zoom = clampOrthoZoom(cam?.zoom)
  o.updateProjectionMatrix()
}

watch(
  () => props.contentGroup,
  (g, prev) => {
    const vp = renderer
    if (!vp) return
    if (!g) { if (prev) skipNextContentGroupAutoFit = true; return }
    if (!prev) {
      if (skipNextContentGroupAutoFit) { skipNextContentGroupAutoFit = false; return }
      fitCameraToGroup(vp, g)
    }
  },
  { flush: 'post' },
)

watch(
  () => props.initialCamera?.zoom,
  (z) => {
    const vp = renderer
    if (!vp) return
    vp.camera.zoom = clampOrthoZoom(z)
    vp.camera.updateProjectionMatrix()
  },
  { flush: 'post' },
)

watch(() => props.showAxesGizmo, (v) => { if (renderer) renderer.showAxesGizmo = v })

watch(
  [() => props.contentGroup, () => props.layerPreviewMode],
  () => { if (lastPointer) runPick() },
)

onMounted(() => {
  const el = container.value
  if (!el) return

  scene = new THREE.Scene()
  scene.background = new THREE.Color(props.sceneBackground)


  layers = {
    structure: new THREE.Group(),
    decal: new THREE.Group(),
    overlay: new THREE.Group(),
  }
  scene.add(layers.structure, layers.decal, layers.overlay)

  const vp = new View3DRenderer(el, el.clientWidth, el.clientHeight)
  renderer = vp
  vp.showAxesGizmo = props.showAxesGizmo
  canvasEl = vp.domElement
  canvasEl.addEventListener('pointermove', onPointerMove)
  canvasEl.addEventListener('pointerleave', onPointerLeave)


  const def = props.definition
  const fallbackTarget = new THREE.Vector3(0, 2, 0)
  const fallbackPosition = new THREE.Vector3(8, 6, 10)
  const o = vp.camera
  applyInitialCamera(o, vp.orbitTarget, def, fallbackTarget, fallbackPosition)
  applyDiagonalOrbitView(o, vp.orbitTarget, {
    yawDeg: 225,
    elevationFromHorizontalDeg: STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG,
  })
  const d0 = Math.max(0.1, o.position.distanceTo(vp.orbitTarget))
  const orthoHeight0 = 2 * d0 * Math.tan(THREE.MathUtils.degToRad(ORTHO_FRUSTUM_REF_HALF_FOV_DEG))
  const aspect0 = el.clientWidth / Math.max(el.clientHeight, 1)
  const halfH0 = orthoHeight0 / 2
  o.top = halfH0; o.bottom = -halfH0
  o.left = -halfH0 * aspect0; o.right = halfH0 * aspect0
  o.updateProjectionMatrix()

  let lastSafeW = 0; let lastSafeH = 0
  const applySizeFromEl = (): void => {
    layoutResizeRaf = null
    const w = el.clientWidth; const h = el.clientHeight
    if (w < 4 || h < 4) return
    if (w === lastSafeW && h === lastSafeH) return
    lastSafeW = w; lastSafeH = h
    vp.resize(w, h)
  }
  onResize = () => {
    if (layoutResizeRaf !== null) cancelAnimationFrame(layoutResizeRaf)
    layoutResizeRaf = requestAnimationFrame(applySizeFromEl)
  }
  window.addEventListener('resize', onResize)
  resizeObserver = new ResizeObserver(() => onResize?.())
  resizeObserver.observe(el)
  onVisibilityToGl = () => {
    if (document.hidden) return
    onResize?.()
  }
  document.addEventListener('visibilitychange', onVisibilityToGl)
  const domCanvas = vp.domElement
  domCanvas.addEventListener('webglcontextlost', (ev) => { ev.preventDefault() }, false)
  domCanvas.addEventListener('webglcontextrestored', () => { onResize?.() })

  applySizeFromEl()

  let lastContentGroup: THREE.Group | null = null

  const clock = new THREE.Clock()
  const tick = () => {
    animationId = requestAnimationFrame(tick)
    props.materialLibrary.tick(clock.getDelta() * 1000)

    // 仅在 contentGroup 引用变化时挂载/卸载
    if (props.contentGroup !== lastContentGroup) {
      if (lastContentGroup) layers!.structure.remove(lastContentGroup)
      lastContentGroup = props.contentGroup
      if (props.contentGroup) layers!.structure.add(props.contentGroup)
    }

    vp.render(scene!)
    vp.renderGizmo()
  }
  tick()

  emit('ready', {
    scene,
    layers: layers!,
    camera: vp.camera,
    domElement: vp.domElement,
    orbitTarget: vp.orbitTarget,
  })
})

onBeforeUnmount(() => {
  if (canvasEl) {
    canvasEl.removeEventListener('pointermove', onPointerMove)
    canvasEl.removeEventListener('pointerleave', onPointerLeave)

    canvasEl = null
  }
  cancelAnimationFrame(animationId)
  if (layoutResizeRaf !== null) { cancelAnimationFrame(layoutResizeRaf); layoutResizeRaf = null }
  if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null }
  if (onResize) { window.removeEventListener('resize', onResize); onResize = null }
  if (onVisibilityToGl) { document.removeEventListener('visibilitychange', onVisibilityToGl); onVisibilityToGl = null }
  renderer?.dispose()
  renderer = null
})
</script>

<template>
  <div ref="container" class="vc-viewport" style="overflow: hidden">
    <div class="vc-toolbar">
      <!-- 操作组 -->
      <button type="button" class="vc-toolbar-btn" title="复位视角" @click="onResetView">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 3.1L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-3.1L3 16"/><path d="M3 21v-5h5"/></svg>
      </button>
      <button type="button" class="vc-toolbar-btn" title="截屏" @click="onScreenshot">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
      </button>
      <button type="button" class="vc-toolbar-btn" title="全屏" @click="onFullscreen">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
      </button>
      <span class="vc-toolbar-sep" />
      <button type="button" class="vc-toolbar-btn" title="在编辑器中打开 (TODO)" disabled @click="emit('open-workbench')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
      </button>
      <button type="button" class="vc-toolbar-btn" title="设置" @click="emit('open-settings')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.vc-viewport {
  flex: 1; min-height: 320px; min-width: 0;
  border-radius: 0; background: var(--nei-viewport-bg);
  overflow: hidden; position: relative;
}
.vc-toolbar {
  position: absolute; top: 6px; right: 6px; z-index: 10;
  display: flex; align-items: center; gap: 2px;
}
.vc-toolbar-btn {
  width: 28px; height: 28px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  color: #8a8e98;
  background: var(--nei-bg, #1a1e28);
  border: 3px solid;
  border-color: var(--nei-bevel-light, #555) var(--nei-bevel-dark, #2a2a2a) var(--nei-bevel-dark, #2a2a2a) var(--nei-bevel-light, #555);
  border-radius: 0; cursor: pointer; user-select: none; box-sizing: border-box;
  transition: color 0.15s, background 0.15s;
}
.vc-toolbar-btn:hover { color: #c0c0c0; background: #2a2e38; }
.vc-toolbar-btn:active {
  border-color: var(--nei-bevel-dark, #2a2a2a) var(--nei-bevel-light, #555) var(--nei-bevel-light, #555) var(--nei-bevel-dark, #2a2a2a);
}
.vc-toolbar-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.vc-toolbar-btn svg { width: 15px; height: 15px; }
.vc-toolbar-sep {
  width: 1px; height: 18px; background: #3a3e48; margin: 0 4px; flex-shrink: 0;
}
</style>
