import * as THREE from 'three'
import { WorldAxesGizmo } from './worldAxesGizmo'

const DEFAULT_FRUSTUM_SIZE = 10

/**
 * 自包含 3D 视口：持有 WebGLRenderer + OrthographicCamera + WorldAxesGizmo。
 * 不创建 Scene，不接触任何业务类型。接收 Scene 后一次 render 调用完成渲染。
 */
export class View3DRenderer {
  readonly camera: THREE.OrthographicCamera
  readonly orbitTarget: THREE.Vector3
  readonly domElement: HTMLCanvasElement

  private readonly renderer: THREE.WebGLRenderer
  private readonly container: HTMLElement
  private readonly gizmo: WorldAxesGizmo
  private readonly cssSize = new THREE.Vector2()

  get showAxesGizmo(): boolean {
    return this.gizmo.enabled
  }

  set showAxesGizmo(v: boolean) {
    this.gizmo.enabled = v
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
  }

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

  dispose(): void {
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
