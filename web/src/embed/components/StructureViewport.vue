<script setup lang="ts">
/**
 * Scene + RenderViewport + 灯光 + RAF；悬停拾取 + 点击选取 emit 到父级（不持有 tooltip 状态）。
 * 编辑模式下 pointerdown 触发 select-block。
 */
import { inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'

import { PreviewSceneContextKey } from '@/preview/sceneStore'
import {
  applyDiagonalOrbitView,
  applyInitialCamera,
  STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG,
} from '@/render/interaction/initialCamera'
import type { LayerPreviewMode } from '@/render/data/layerPreview'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import { pickVoxelFromPointer } from '@/render/interaction/voxelPick'
import type { StructureDefinition } from '@/render/schema/types'
import {
  RenderViewport,
} from '@/render/viewport/renderViewport'

/** 与历史上「先摆透视再同步正交」时采用的参考半视场角一致（原透视 FOV 50° 的一半），用于由距离推正交视锥高度 */
const ORTHO_FRUSTUM_REF_HALF_FOV_DEG = 25

const props = withDefaults(
  defineProps<{
    definition: StructureDefinition
    materialLibrary: MaterialLibraryApi
    contentGroup: THREE.Group | null
    layerPreviewMode: LayerPreviewMode
    sceneBackground?: number
    /** 编辑模式：pointerdown 触发 select-block 而非仅 hover */
    editMode?: boolean
    /** 选中的体素坐标，用于渲染高亮线框 */
    selectedVoxel?: { column: number; row: number; zSlice: number } | null
    /** 显示右上角世界坐标轴 Gizmo */
    showAxesGizmo?: boolean
  }>(),
  {
    sceneBackground: 0x111827,
    editMode: false,
    selectedVoxel: null,
    showAxesGizmo: true,
  },
)

const emit = defineEmits<{
  ready: [scene: THREE.Scene, camera: THREE.Camera, canvas: HTMLElement, orbitTarget: THREE.Vector3]
  'hover-block': [
    payload: {
      blockId: string
      clientX: number
      clientY: number
      source: 'viewport'
      voxel: { column: number; row: number; zSlice: number }
    } | null,
  ]
  'select-block': [
    payload: {
      blockId: string
      clientX: number
      clientY: number
      voxel: { column: number; row: number; zSlice: number }
    } | null,
  ]
}>()

const store = inject(PreviewSceneContextKey)

/** 正交相机 zoom（与 OrbitControls 滚轮一致）；非法值回落为 1 */
function clampOrthoZoom(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1
}

const container = ref<HTMLDivElement | null>(null)

let viewport: RenderViewport | null = null
let animationId = 0
let layoutResizeRaf: number | null = null
let resizeObserver: ResizeObserver | null = null
let onResize: (() => void) | null = null
let onVisibilityToGl: (() => void) | null = null

let canvasEl: HTMLElement | null = null
let rafHoverPending = false
let lastPointer: { clientX: number; clientY: number } | null = null
let activeScene: THREE.Scene | null = null
let clickDownAt: { x: number; y: number } | null = null
/** 分层 / 网格重建会先清空 {@link PreviewSceneContextKey} 的 contentGroup，`null→Group` 并非首次进入场景 */
let skipNextContentGroupAutoFit = false

function runPick(): void {
  const vp = viewport
  const g = props.contentGroup
  const dom = canvasEl
  if (!vp || !g || !dom || !lastPointer) return

  const picked = pickVoxelFromPointer({
    clientX: lastPointer.clientX,
    clientY: lastPointer.clientY,
    domElement: dom,
    camera: vp.activeCamera,
    contentGroup: g,
    def: props.definition,
    layerPreview: props.layerPreviewMode,
  })

  if (picked) {
    const { blockId, column, row, zSlice } = picked
    emit('hover-block', {
      blockId,
      clientX: lastPointer.clientX,
      clientY: lastPointer.clientY,
      source: 'viewport',
      voxel: { column, row, zSlice },
    })
  } else {
    emit('hover-block', null)
  }
}

function onPointerMove(e: PointerEvent): void {
  lastPointer = { clientX: e.clientX, clientY: e.clientY }
  if (rafHoverPending) return
  rafHoverPending = true
  requestAnimationFrame(() => {
    rafHoverPending = false
    runPick()
  })
}

function onPointerLeave(): void {
  lastPointer = null
  emit('hover-block', null)
}

/** 编辑模式：区分拖拽（旋转）与点击（选取） */
function onPointerDown(e: PointerEvent): void {
  if (!props.editMode) return
  clickDownAt = { x: e.clientX, y: e.clientY }
}

function onPointerUp(e: PointerEvent): void {
  if (!props.editMode || !clickDownAt) return
  const dx = e.clientX - clickDownAt.x
  const dy = e.clientY - clickDownAt.y
  clickDownAt = null
  // 移动超过阈值视为拖拽（旋转/平移），不触发选取
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) return
  // 点击：执行选取
  lastPointer = { clientX: e.clientX, clientY: e.clientY }
  const vp = viewport
  const g = props.contentGroup
  const dom = canvasEl
  if (!vp || !g || !dom) return
  const picked = pickVoxelFromPointer({
    clientX: e.clientX,
    clientY: e.clientY,
    domElement: dom,
    camera: vp.activeCamera,
    contentGroup: g,
    def: props.definition,
    layerPreview: props.layerPreviewMode,
  })
  if (picked) {
    emit('select-block', {
      blockId: picked.blockId,
      clientX: e.clientX,
      clientY: e.clientY,
      voxel: { column: picked.column, row: picked.row, zSlice: picked.zSlice },
    })
  }
  // 点击空地：不取消已选方块
}

/** 选中体素 → 世界坐标（体素中心） */
function voxelToWorld(
  v: { column: number; row: number; zSlice: number },
  def: StructureDefinition,
): THREE.Vector3 {
  const sCol = def.cellGrid[0]?.[0]?.length ?? 1
  const sRow = def.cellGrid[0]?.length ?? 1
  const sZ = def.cellGrid.length ?? 1
  return new THREE.Vector3(
    v.column - sCol / 2 + 0.5,
    sRow / 2 - 0.5 - v.row,
    v.zSlice - sZ / 2 + 0.5,
  )
}

let highlightLine: THREE.LineSegments | null = null

function updateHighlight(): void {
  const scene = activeScene
  if (!scene) return
  const sel = props.selectedVoxel
  if (!sel) {
    if (highlightLine) {
      scene.remove(highlightLine)
      highlightLine.geometry.dispose()
      ;(highlightLine.material as THREE.Material).dispose()
      highlightLine = null
    }
    return
  }
  const pos = voxelToWorld(sel, props.definition)
  if (highlightLine) {
    highlightLine.position.copy(pos)
  } else {
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.001, 1.001, 1.001))
    const mat = new THREE.LineBasicMaterial({ color: 0xfbbf24, linewidth: 2, transparent: true, opacity: 0.9 })
    highlightLine = new THREE.LineSegments(geo, mat)
    highlightLine.position.copy(pos)
    scene.add(highlightLine)
  }
}

watch(() => props.selectedVoxel, () => updateHighlight(), { flush: 'post' })
watch(() => props.definition, () => updateHighlight(), { flush: 'post' })

/**
 * 多帧 World：各帧体素在局部坐标中包围盒常不同，仍用首帧/definition 的 initialCamera 或固定 fallback
 * 时，某些帧的 mesh 会整体落在视锥外（scene 中仍有 group，表现为「全空」与 gizmo 一起像消失）。
 * 在 content 挂好后按当前 Group 的 AABB 对心并拉远等轴相机。
 */
function fitIsometricOrbitToContentGroup(vp: RenderViewport, group: THREE.Group): void {
  group.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(group)
  if (box.isEmpty() || !Number.isFinite(box.min.x)) {
    return
  }
  const center = new THREE.Vector3()
  const size = new THREE.Vector3()
  box.getCenter(center)
  box.getSize(size)
  const maxDim = Math.max(size.x, size.y, size.z, 0.1)
  const dist = Math.max(8, maxDim * 2.2)
  const cam = store?.config.value?.initialCamera
  const finalDist = cam?.distance ?? dist
  const o = vp.orthographicCamera
  vp.controls.target.copy(center)
  applyDiagonalOrbitView(o, vp.controls, {
    yawDeg: cam?.yawDeg ?? 225,
    elevationFromHorizontalDeg: cam?.elevationDeg ?? STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG,
    distance: finalDist,
  })
  const orthoHeight = 2 * Math.abs(finalDist) * Math.tan(THREE.MathUtils.degToRad(ORTHO_FRUSTUM_REF_HALF_FOV_DEG))
  const dom = vp.renderer.domElement
  const aspect = dom.clientWidth / Math.max(dom.clientHeight, 1)
  const halfH = orthoHeight / 2
  o.top = halfH
  o.bottom = -halfH
  o.left = -halfH * aspect
  o.right = halfH * aspect
  o.zoom = clampOrthoZoom(cam?.zoom)
  o.updateProjectionMatrix()
  vp.controls.update()
}

watch(
  () => props.contentGroup,
  (g, prev) => {
    const vp = viewport
    if (!vp) return
    if (!g) {
      if (prev) skipNextContentGroupAutoFit = true
      return
    }
    if (!prev) {
      if (skipNextContentGroupAutoFit) {
        skipNextContentGroupAutoFit = false
        return
      }
      fitIsometricOrbitToContentGroup(vp, g)
    }
  },
  { flush: 'post' },
)

/** 嵌入/Wiki 配置变更 `initialCamera.zoom` 时同步视口（拟合仅在首帧执行） */
watch(
  () => store?.config.value?.initialCamera?.zoom,
  (z) => {
    const vp = viewport
    if (!vp) return
    vp.orthographicCamera.zoom = clampOrthoZoom(z)
    vp.orthographicCamera.updateProjectionMatrix()
  },
  { flush: 'post' },
)

watch(
  () => props.showAxesGizmo,
  (v) => {
    if (viewport) viewport.showAxesGizmo = v
  },
)

watch(
  [() => props.contentGroup, () => props.layerPreviewMode],
  () => {
    if (lastPointer) runPick()
  },
)

onMounted(() => {
  const el = container.value
  if (!el) return

  const scene = new THREE.Scene()
  activeScene = scene
  scene.background = new THREE.Color(props.sceneBackground)

  /** 回调 IBL 后保持原始偏保守灯光，避免室内/玻璃过曝 */
  const ambient = new THREE.AmbientLight(0xffffff, 0.55)
  const dir = new THREE.DirectionalLight(0xffffff, 0.9)
  dir.position.set(6, 10, 8)
  scene.add(ambient, dir)

  const vp = new RenderViewport({
    container: el,
    width: el.clientWidth,
    height: el.clientHeight,
  })
  viewport = vp
  vp.showAxesGizmo = props.showAxesGizmo
  canvasEl = vp.renderer.domElement
  canvasEl.addEventListener('pointermove', onPointerMove)
  canvasEl.addEventListener('pointerleave', onPointerLeave)
  canvasEl.addEventListener('pointerdown', onPointerDown)
  canvasEl.addEventListener('pointerup', onPointerUp)

  const def = props.definition
  const fallbackTarget = new THREE.Vector3(0, 2, 0)
  const fallbackPosition = new THREE.Vector3(8, 6, 10)

  const o = vp.orthographicCamera
  applyInitialCamera(o, vp.controls, def, fallbackTarget, fallbackPosition)
  applyDiagonalOrbitView(o, vp.controls, {
    yawDeg: 225,
    elevationFromHorizontalDeg: STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG,
  })
  const d0 = Math.max(0.1, o.position.distanceTo(vp.controls.target))
  const orthoHeight0 = 2 * d0 * Math.tan(THREE.MathUtils.degToRad(ORTHO_FRUSTUM_REF_HALF_FOV_DEG))
  const aspect0 = el.clientWidth / Math.max(el.clientHeight, 1)
  const halfH0 = orthoHeight0 / 2
  o.top = halfH0
  o.bottom = -halfH0
  o.left = -halfH0 * aspect0
  o.right = halfH0 * aspect0
  o.updateProjectionMatrix()
  vp.controls.update()

  /**
   * 拖动预览高度时 ResizeObserver 会连续触发，若对 WebGL 每事件 setSize 可能触发驱动/context 异常
   *（白屏、裂图；见用户 div 变化后纯白）。合并到 rAF 并忽略过渡中的极小尺寸。
   */
  let lastSafeW = 0
  let lastSafeH = 0
  const applySizeFromEl = (): void => {
    layoutResizeRaf = null
    const w = el.clientWidth
    const h = el.clientHeight
    if (w < 4 || h < 4) {
      return
    }
    if (w === lastSafeW && h === lastSafeH) {
      return
    }
    lastSafeW = w
    lastSafeH = h
    vp.resize(w, h)
  }
  onResize = () => {
    if (layoutResizeRaf !== null) {
      cancelAnimationFrame(layoutResizeRaf)
    }
    layoutResizeRaf = requestAnimationFrame(applySizeFromEl)
  }
  window.addEventListener('resize', onResize)
  resizeObserver = new ResizeObserver(() => onResize?.())
  resizeObserver.observe(el)
  /** 与 Vite 全量 HMR/手动刷新一样：从后台/睡眠回到前台时重同步 drawing buffer，减少「白画直至刷新」的偶发。 */
  onVisibilityToGl = () => {
    if (document.hidden) {
      return
    }
    onResize?.()
  }
  document.addEventListener('visibilitychange', onVisibilityToGl)
  const domCanvas = vp.renderer.domElement
  domCanvas.addEventListener(
    'webglcontextlost',
    (ev) => {
      ev.preventDefault()
    },
    false,
  )
  domCanvas.addEventListener('webglcontextrestored', () => {
    onResize?.()
  })
  applySizeFromEl()

  const clock = new THREE.Clock()
  const tick = () => {
    animationId = requestAnimationFrame(tick)
    props.materialLibrary.tick(clock.getDelta() * 1000)
    vp.controls.update()
    vp.render(scene)
  }
  tick()

  emit('ready', scene, vp.activeCamera, domCanvas, vp.controls.target)
})

onBeforeUnmount(() => {
  if (canvasEl) {
    canvasEl.removeEventListener('pointermove', onPointerMove)
    canvasEl.removeEventListener('pointerleave', onPointerLeave)
    canvasEl.removeEventListener('pointerdown', onPointerDown)
    canvasEl.removeEventListener('pointerup', onPointerUp)
    canvasEl = null
  }
  cancelAnimationFrame(animationId)
  if (layoutResizeRaf !== null) {
    cancelAnimationFrame(layoutResizeRaf)
    layoutResizeRaf = null
  }
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  if (onResize) {
    window.removeEventListener('resize', onResize)
    onResize = null
  }
  if (onVisibilityToGl) {
    document.removeEventListener('visibilitychange', onVisibilityToGl)
    onVisibilityToGl = null
  }
  store?.detachAndDisposeMesh()
  viewport?.dispose()
  viewport = null
})
</script>

<template>
  <div
    ref="container"
    class="wm-viewport"
    style="overflow: hidden"
  >
    <button type="button" class="wm-reset-btn" title="复位视角" @click="viewport && props.contentGroup ? fitIsometricOrbitToContentGroup(viewport, props.contentGroup) : null">⟲</button>
  </div>
</template>

<style scoped>
.wm-viewport {
  flex: 1;
  min-height: 320px;
  min-width: 0;
  border-radius: 0;
  background: var(--nei-viewport-bg);
  overflow: hidden;
  position: relative;
}
.wm-reset-btn {
  position: absolute;
  top: 6px; right: 6px;
  z-index: 10;
  width: 28px; height: 28px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 16px; font-weight: 700;
  font-family: ui-monospace, 'Cascadia Code', monospace;
  color: var(--nei-text); text-shadow: var(--nei-label-shadow);
  background: var(--nei-bg);
  border: var(--nei-bevel-w) solid;
  border-color: var(--nei-highlight) var(--nei-shadow) var(--nei-shadow) var(--nei-highlight);
  border-radius: 0; cursor: pointer; user-select: none; box-sizing: border-box;
}
.wm-reset-btn:hover { filter: brightness(1.06); }
.wm-reset-btn:active {
  border-color: var(--nei-shadow) var(--nei-highlight) var(--nei-highlight) var(--nei-shadow);
  padding-top: 1px; padding-left: 1px;
}
</style>
