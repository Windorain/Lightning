import * as THREE from 'three'
import { View3DRenderer } from '@/render/viewport/renderViewport'
import {
  applyDiagonalOrbitView,
  applyInitialCamera,
  fitCameraToGroup,
  ORTHO_FRUSTUM_REF_HALF_FOV_DEG,
  STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG,
} from '@/render/interaction/initialCamera'
import type { LayerPreviewMode } from '@/render/data/layerPreview'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import type { StructureDefinition } from '@/render/schema/types'
import type { InitialCamera } from '@/viewer/viewerConfig'
import type { SelectionOutlinePass } from '@/render/postprocessing/SelectionOutlinePass'

export interface RenderEngineReadyPayload {
  mainScene: THREE.Scene
  overlayScene: THREE.Scene
  layers: { structure: THREE.Group; decal: THREE.Group; overlay: THREE.Group }
  camera: THREE.Camera
  domElement: HTMLElement
  orbitTarget: THREE.Vector3
  renderer: View3DRenderer
}

export interface RenderEngineOptions {
  definition: StructureDefinition
  materialLibrary: MaterialLibraryApi
  contentGroup: THREE.Group | null
  layerPreviewMode: LayerPreviewMode
  sceneBackground?: number
  showAxesGizmo?: boolean
  initialCamera?: InitialCamera
}

function clampOrthoZoom(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1
}

/**
 * WebGL 视口引擎：场景、RAF、resize。不监听 DOM 指针（hover 走 WM）。
 */
export class RenderEngine {
  private renderer: View3DRenderer | null = null
  private mainScene: THREE.Scene | null = null
  private overlayScene: THREE.Scene | null = null
  private animationId = 0
  private layoutResizeRaf: number | null = null
  private resizeObserver: ResizeObserver | null = null
  private onResize: (() => void) | null = null
  private onVisibilityToGl: (() => void) | null = null
  private lastContentGroup: THREE.Group | null = null
  private opts: RenderEngineOptions | null = null
  private readonly frameHooks = new Set<() => void>()

  /** 注册每帧回调（在 render 前执行）；返回取消注册函数 */
  addFrameHook(fn: () => void): () => void {
    this.frameHooks.add(fn)
    return () => { this.frameHooks.delete(fn) }
  }

  mount(container: HTMLElement, opts: RenderEngineOptions, onReady: (payload: RenderEngineReadyPayload) => void): void {
    if (this.renderer) return
    this.opts = opts

    const mainScene = new THREE.Scene()
    mainScene.background = new THREE.Color(opts.sceneBackground ?? 0x0b1217)
    const overlayScene = new THREE.Scene()
    const layers = {
      structure: new THREE.Group(),
      decal: new THREE.Group(),
      overlay: new THREE.Group(),
    }
    mainScene.add(layers.structure, layers.decal)
    overlayScene.add(layers.overlay)

    const vp = new View3DRenderer(container, container.clientWidth, container.clientHeight)
    vp.showAxesGizmo = opts.showAxesGizmo ?? true

    const def = opts.definition
    const fallbackTarget = new THREE.Vector3(0, 2, 0)
    const fallbackPosition = new THREE.Vector3(8, 6, 10)
    const o = vp.camera
    const hasDefinedInitialCamera = !!def.initialCamera
    applyInitialCamera(o, vp.orbitTarget, def, fallbackTarget, fallbackPosition)
    if (!hasDefinedInitialCamera) {
      applyDiagonalOrbitView(o, vp.orbitTarget, {
        yawDeg: 225,
        elevationFromHorizontalDeg: STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG,
      })
    }
    const d0 = Math.max(0.1, o.position.distanceTo(vp.orbitTarget))
    const orthoHeight0 = 2 * d0 * Math.tan(THREE.MathUtils.degToRad(ORTHO_FRUSTUM_REF_HALF_FOV_DEG))
    const aspect0 = container.clientWidth / Math.max(container.clientHeight, 1)
    const halfH0 = orthoHeight0 / 2
    o.top = halfH0
    o.bottom = -halfH0
    o.left = -halfH0 * aspect0
    o.right = halfH0 * aspect0
    o.updateProjectionMatrix()

    let lastSafeW = 0
    let lastSafeH = 0
    const applySizeFromEl = (): void => {
      this.layoutResizeRaf = null
      const w = container.clientWidth
      const h = container.clientHeight
      if (w < 4 || h < 4) return
      if (w === lastSafeW && h === lastSafeH) return
      lastSafeW = w
      lastSafeH = h
      vp.resize(w, h)
    }
    this.onResize = () => {
      if (this.layoutResizeRaf !== null) cancelAnimationFrame(this.layoutResizeRaf)
      this.layoutResizeRaf = requestAnimationFrame(applySizeFromEl)
    }
    window.addEventListener('resize', this.onResize)
    this.resizeObserver = new ResizeObserver(() => this.onResize?.())
    this.resizeObserver.observe(container)
    this.onVisibilityToGl = () => {
      if (document.hidden) return
      this.onResize?.()
    }
    document.addEventListener('visibilitychange', this.onVisibilityToGl)
    const domCanvas = vp.domElement
    domCanvas.addEventListener('webglcontextlost', (ev) => { ev.preventDefault() }, false)
    domCanvas.addEventListener('webglcontextrestored', () => { this.onResize?.() })

    applySizeFromEl()
    vp.initComposer(mainScene)

    const clock = new THREE.Clock()
    const tick = () => {
      this.animationId = requestAnimationFrame(tick)
      opts.materialLibrary.tick(clock.getDelta() * 1000)
      for (const hook of this.frameHooks) {
        try { hook() } catch (e) { console.error('[RenderEngine] frameHook', e) }
      }
      if (opts.contentGroup !== this.lastContentGroup) {
        if (this.lastContentGroup) layers.structure.remove(this.lastContentGroup)
        this.lastContentGroup = opts.contentGroup
        if (opts.contentGroup) layers.structure.add(opts.contentGroup)
      }
      vp.renderMain()
      vp.renderOverlay(overlayScene)
      vp.renderGizmo()
    }
    tick()

    this.renderer = vp
    this.mainScene = mainScene
    this.overlayScene = overlayScene

    onReady({
      mainScene,
      overlayScene,
      layers,
      camera: vp.camera,
      domElement: vp.domElement,
      orbitTarget: vp.orbitTarget,
      renderer: vp,
    })
  }

  setOutlinePass(pass: SelectionOutlinePass | null): void {
    if (pass) this.renderer?.setOutlinePass(pass)
  }

  updateOptions(partial: Partial<RenderEngineOptions>): void {
    if (!this.opts || !this.renderer) return
    Object.assign(this.opts, partial)
    if (partial.sceneBackground != null && this.mainScene) {
      this.mainScene.background = new THREE.Color(partial.sceneBackground)
    }
    if (partial.showAxesGizmo != null) {
      this.renderer.showAxesGizmo = partial.showAxesGizmo
    }
    if (partial.initialCamera?.zoom != null) {
      this.renderer.camera.zoom = clampOrthoZoom(partial.initialCamera.zoom)
      this.renderer.camera.updateProjectionMatrix()
    }
    // contentGroup 变更不自动改相机；由各视口 slot.viewportCamera + DRW 同步
    if (partial.initialCamera?.yawDeg != null && this.opts.contentGroup) {
      const cam = this.opts.initialCamera
      applyDiagonalOrbitView(this.renderer.camera, this.renderer.orbitTarget, {
        yawDeg: partial.initialCamera.yawDeg,
        elevationFromHorizontalDeg: cam?.elevationDeg ?? 35,
      })
    }
    if (partial.initialCamera?.elevationDeg != null && this.opts.contentGroup) {
      const cam = this.opts.initialCamera
      applyDiagonalOrbitView(this.renderer.camera, this.renderer.orbitTarget, {
        yawDeg: cam?.yawDeg ?? 225,
        elevationFromHorizontalDeg: partial.initialCamera.elevationDeg,
      })
    }
  }

  resetView(): void {
    const vp = this.renderer
    const g = this.opts?.contentGroup
    if (!vp || !g) return
    const cam = this.opts?.initialCamera
    fitCameraToGroup(
      vp.camera,
      g,
      vp.orbitTarget,
      vp.domElement,
      {
        yawDeg: cam?.yawDeg,
        elevationDeg: cam?.elevationDeg,
        distance: cam?.distance,
        zoom: cam?.zoom,
      },
    )
  }

  screenshot(): void {
    const vp = this.renderer
    const canvas = vp?.domElement
    if (!canvas || !vp || !this.mainScene || !this.overlayScene) return
    vp.renderMain()
    vp.renderOverlay(this.overlayScene)
    const dataUrl = canvas.toDataURL('image/png')
    const a = document.createElement('a')
    a.href = dataUrl
    a.download = `lightning-screenshot-${Date.now()}.png`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  dispose(): void {
    this.frameHooks.clear()
    cancelAnimationFrame(this.animationId)
    if (this.layoutResizeRaf !== null) {
      cancelAnimationFrame(this.layoutResizeRaf)
      this.layoutResizeRaf = null
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
      this.resizeObserver = null
    }
    if (this.onResize) {
      window.removeEventListener('resize', this.onResize)
      this.onResize = null
    }
    if (this.onVisibilityToGl) {
      document.removeEventListener('visibilitychange', this.onVisibilityToGl)
      this.onVisibilityToGl = null
    }
    this.renderer?.dispose()
    this.renderer = null
    this.mainScene = null
    this.overlayScene = null
    this.opts = null
    this.lastContentGroup = null
  }
}
