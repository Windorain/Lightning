import * as THREE from 'three'
import { WorldAxesGizmo } from './worldAxesGizmo'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import type { SelectionOutlinePass } from '../postprocessing/SelectionOutlinePass'

const DEFAULT_FRUSTUM_SIZE = 10

/**
 * 自包含 3D 视口：持有 WebGLRenderer + OrthographicCamera + EffectComposer + WorldAxesGizmo。
 * 支持多 pass 渲染：renderMain() 走 EffectComposer（含后处理），renderOverlay() 直接渲染覆盖层。
 */
export class View3DRenderer {
  readonly camera: THREE.OrthographicCamera
  readonly orbitTarget: THREE.Vector3
  readonly domElement: HTMLCanvasElement

  private readonly renderer: THREE.WebGLRenderer
  private readonly container: HTMLElement
  private readonly gizmo: WorldAxesGizmo
  private readonly cssSize = new THREE.Vector2()

  private _composer: EffectComposer | null = null
  private _outlinePass: SelectionOutlinePass | null = null

  get showAxesGizmo(): boolean {
    return this.gizmo.enabled
  }

  set showAxesGizmo(v: boolean) {
    this.gizmo.enabled = v
  }

  get composer(): EffectComposer | null {
    return this._composer
  }

  get outlinePass(): SelectionOutlinePass | null {
    return this._outlinePass
  }

  constructor(container: HTMLElement, width: number, height: number) {
    this.container = container
    const w = Math.max(width, 1)
    const h = Math.max(height, 1)
    const aspect = w / h

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.renderer.setSize(w, h)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    const fs = DEFAULT_FRUSTUM_SIZE
    this.camera = new THREE.OrthographicCamera(
      (-fs * aspect) / 2,
      (fs * aspect) / 2,
      fs / 2,
      -fs / 2,
      0.1,
      500,
    )

    this.orbitTarget = new THREE.Vector3(0, 2, 0)
    this.domElement = this.renderer.domElement
    this.gizmo = new WorldAxesGizmo()

    container.appendChild(this.renderer.domElement)
  }

  initComposer(mainScene: THREE.Scene): void {
    if (this._composer) return
    this._composer = new EffectComposer(this.renderer)
    this._composer.addPass(new RenderPass(mainScene, this.camera))
    this._composer.addPass(new OutputPass())
  }

  setOutlinePass(pass: SelectionOutlinePass): void {
    if (!this._composer) return
    // Insert before the OutputPass (last pass)
    const passes = this._composer.passes
    const outputIdx = passes.length - 1 // OutputPass is always last

    // Remove old outline pass if any
    if (this._outlinePass) {
      const oldIdx = passes.indexOf(this._outlinePass as any)
      if (oldIdx >= 0) passes.splice(oldIdx, 1)
    }

    this._outlinePass = pass
    passes.splice(outputIdx, 0, pass as any)
    pass.setSize(
      (this._composer as any)._width * (this._composer as any)._pixelRatio,
      (this._composer as any)._height * (this._composer as any)._pixelRatio,
    )
  }

  renderMain(): void {
    if (!this.isGlUsable()) return
    if (this._composer) {
      this._composer.render()
    }
  }

  renderOverlay(overlayScene: THREE.Scene): void {
    if (!this.isGlUsable()) return
    this.renderer.autoClear = false
    // Clear depth buffer: main scene was rendered through EffectComposer
    // (internal RTs), so screen depth only has the OutputPass FSQ at z≈0.
    // Overlay objects with depthTest would fail against it.
    this.renderer.clearDepth()
    this.renderer.render(overlayScene, this.camera)
    this.renderer.autoClear = true
  }

  /** @deprecated Use renderMain() + renderOverlay() instead */
  render(scene: THREE.Scene): void {
    if (!this.isGlUsable()) return
    this.renderer.render(scene, this.camera)
  }

  renderGizmo(): void {
    if (!this.isGlUsable()) return
    this.renderer.getSize(this.cssSize)
    this.gizmo.renderOverlay(
      this.renderer,
      this.camera,
      this.cssSize.x,
      this.cssSize.y,
    )
  }

  resize(width: number, height: number): void {
    if (!this.isGlUsable()) return
    const w = Math.max(width, 1)
    const h = Math.max(height, 1)
    const aspect = w / h

    const cam = this.camera
    const halfH = cam.top > 0 && cam.bottom < 0 ? cam.top : DEFAULT_FRUSTUM_SIZE / 2
    cam.left = -halfH * aspect
    cam.right = halfH * aspect
    cam.top = halfH
    cam.bottom = -halfH
    cam.updateProjectionMatrix()

    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.renderer.setSize(w, h)

    if (this._composer) this._composer.setSize(w, h)
    if (this._outlinePass) this._outlinePass.setSize(w, h)
  }

  dispose(): void {
    if (this._composer) {
      this._composer.passes.forEach((p: any) => p.dispose?.())
      this._composer = null
    }
    this.gizmo.dispose()
    this.renderer.dispose()
    const el = this.renderer.domElement
    if (el.parentNode === this.container) {
      this.container.removeChild(el)
    }
  }

  private isGlUsable(): boolean {
    const gl = this.renderer.getContext() as WebGLRenderingContext
    return !gl.isContextLost()
  }
}
