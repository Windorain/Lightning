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
import { scenePickFromPointer, pickAnnotationsAABB } from '@/render/interaction/scenePick'
import type { StructureDefinition } from '@/render/schema/types'
import type { Annotation } from '@/render/data/annotationTypes'
import type { InitialCamera } from '@/preview/previewConfig'

export interface ViewerCoreReadyPayload {
  mainScene: THREE.Scene
  overlayScene: THREE.Scene
  layers: { structure: THREE.Group; decal: THREE.Group; overlay: THREE.Group }
  camera: THREE.Camera
  domElement: HTMLElement
  orbitTarget: THREE.Vector3
  renderer: View3DRenderer
}

const ORTHO_FRUSTUM_REF_HALF_FOV_DEG = 25

const props = withDefaults(
  defineProps<{
    definition: StructureDefinition
    materialLibrary: MaterialLibraryApi
    contentGroup: THREE.Group | null
    layerPreviewMode: LayerPreviewMode
    annotations?: Annotation[]
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
  ready: [ViewerCoreReadyPayload]
  'hover-block': [
    payload: {
      blockId: string; clientX: number; clientY: number
      source: 'viewport'; voxel: { column: number; row: number; zSlice: number }
    } | null,
  ]
  'hover-annotation': [
    payload: { annotationId: string; clientX: number; clientY: number } | null,
  ]
}>()

defineExpose({
  screenshot() {
    const canvas = renderer?.domElement
    if (!canvas) return
    if (renderer && mainScene && overlayScene) {
        renderer.renderMain()
        renderer.renderOverlay(overlayScene)
      }
    const dataUrl = canvas.toDataURL('image/png')
    const a = document.createElement('a')
    a.href = dataUrl
    a.download = `lightning-screenshot-${Date.now()}.png`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  },
  resetView() {
    if (renderer && props.contentGroup) {
      fitCameraToGroup(renderer, props.contentGroup)
    }
  },
})

function clampOrthoZoom(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1
}

const container = ref<HTMLDivElement | null>(null)

let renderer: View3DRenderer | null = null
let mainScene: THREE.Scene | null = null
let overlayScene: THREE.Scene | null = null
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
let lastAnnoId: string | null = null

function runPick(): void {
  const vp = renderer
  const g = props.contentGroup
  const dom = canvasEl
  if (!vp || !g || !dom || !lastPointer) return

  const meshPick = scenePickFromPointer({
    clientX: lastPointer.clientX, clientY: lastPointer.clientY,
    domElement: dom, camera: vp.camera,
    contentGroup: g, overlayGroup: layers?.overlay,
    def: props.definition,
    layerPreview: props.layerPreviewMode,
  })

  // AABB pick for box annotations (independent of mesh geometry)
  let annoAabb: { annotationId: string; distance: number } | null = null
  const annos = props.annotations
  if (annos && annos.length > 0 && vp.camera) {
    const rect = dom.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((lastPointer.clientX - rect.left) / rect.width) * 2 - 1,
      -((lastPointer.clientY - rect.top) / rect.height) * 2 + 1,
    )
    const rc = new THREE.Raycaster()
    rc.setFromCamera(ndc, vp.camera)
    annoAabb = pickAnnotationsAABB(rc.ray.origin, rc.ray.direction, annos)
  }

  // Box annotations: use AABB pick, ignore mesh hits on their frame bars
  const meshIsBoxAnno = meshPick?.kind === 'annotation'
    && annos?.some(a => a.id === meshPick.annotationId && a.type === 'box')
  const effPick = meshIsBoxAnno ? null : meshPick
  const effDist = effPick?.distance ?? Infinity
  const aabbDist = annoAabb?.distance ?? Infinity

  if (aabbDist < effDist && annoAabb) {
    // AABB box annotation wins
    if (annoAabb.annotationId !== lastAnnoId) {
      lastAnnoId = annoAabb.annotationId
      emit('hover-block', null)
      emit('hover-annotation', {
        annotationId: annoAabb.annotationId,
        clientX: lastPointer.clientX, clientY: lastPointer.clientY,
      })
    } else {
      emit('hover-annotation', {
        annotationId: annoAabb.annotationId,
        clientX: lastPointer.clientX, clientY: lastPointer.clientY,
      })
    }
    return
  }

  if (effPick?.kind === 'block') {
    lastAnnoId = null
    emit('hover-block', {
      blockId: effPick.blockId,
      clientX: lastPointer.clientX, clientY: lastPointer.clientY,
      source: 'viewport',
      voxel: { column: effPick.column, row: effPick.row, zSlice: effPick.zSlice },
    })
    emit('hover-annotation', null)
  } else if (effPick?.kind === 'annotation') {
    // Non-box annotation (point/line/text) from mesh pick
    if (effPick.annotationId !== lastAnnoId) {
      lastAnnoId = effPick.annotationId
      emit('hover-block', null)
      emit('hover-annotation', {
        annotationId: effPick.annotationId,
        clientX: lastPointer.clientX, clientY: lastPointer.clientY,
      })
    } else {
      emit('hover-annotation', {
        annotationId: effPick.annotationId,
        clientX: lastPointer.clientX, clientY: lastPointer.clientY,
      })
    }
  } else {
    lastAnnoId = null
    emit('hover-block', null)
    emit('hover-annotation', null)
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
  emit('hover-annotation', null)
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

watch(() => props.sceneBackground, (v) => {
  if (mainScene) mainScene.background = new THREE.Color(v)
})

watch(() => props.initialCamera?.yawDeg, (yaw) => {
  if (renderer && props.contentGroup && yaw != null) {
    const cam = props.initialCamera
    applyDiagonalOrbitView(renderer.camera, renderer.orbitTarget, {
      yawDeg: yaw,
      elevationFromHorizontalDeg: cam?.elevationDeg ?? 35,
    })
  }
})

watch(() => props.initialCamera?.elevationDeg, (elev) => {
  if (renderer && props.contentGroup && elev != null) {
    const cam = props.initialCamera
    applyDiagonalOrbitView(renderer.camera, renderer.orbitTarget, {
      yawDeg: cam?.yawDeg ?? 225,
      elevationFromHorizontalDeg: elev,
    })
  }
})

watch(
  [() => props.contentGroup, () => props.layerPreviewMode],
  () => { if (lastPointer) runPick() },
)

onMounted(() => {
  const el = container.value
  if (!el) return

  mainScene = new THREE.Scene()
  mainScene.background = new THREE.Color(props.sceneBackground)
  overlayScene = new THREE.Scene()

  layers = {
    structure: new THREE.Group(),
    decal: new THREE.Group(),
    overlay: new THREE.Group(),
  }
  mainScene.add(layers.structure, layers.decal)
  overlayScene.add(layers.overlay)

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

  vp.initComposer(mainScene!)

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

      vp.renderMain()
    vp.renderOverlay(overlayScene!)
    vp.renderGizmo()
  }
  tick()

  emit('ready', {
    mainScene: mainScene!,
    overlayScene: overlayScene!,
    layers: layers!,
    camera: vp.camera,
    domElement: vp.domElement,
    orbitTarget: vp.orbitTarget,
    renderer: vp,
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
  <div ref="container" class="vc-viewport" style="overflow: hidden" />
</template>

<style scoped>
.vc-viewport {
  flex: 1; min-height: 320px; min-width: 0;
  background: var(--nei-viewport-bg);
  overflow: hidden;
}
</style>
