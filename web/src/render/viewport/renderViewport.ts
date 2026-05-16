import * as THREE from 'three'
import { WorldAxesGizmo } from './worldAxesGizmo'

const DEFAULT_FRUSTUM_SIZE = 10

export interface RenderViewportOptions {
  /** 挂载 canvas 的容器（内部会 append renderer.domElement） */
  container: HTMLElement
  width: number
  height: number
}

/**
 * 视口：仅使用正交相机，相机变换由 operator 系统接管。
 */
export class RenderViewport {
  readonly renderer: THREE.WebGLRenderer

  readonly orthographicCamera: THREE.OrthographicCamera

  /** 轨道旋转目标点（view operator 围绕此点旋转） */
  readonly orbitTarget: THREE.Vector3

  private readonly container: HTMLElement

  readonly worldAxesGizmo = new WorldAxesGizmo()

  get showAxesGizmo(): boolean {
    return this.worldAxesGizmo.enabled
  }

  set showAxesGizmo(v: boolean) {
    this.worldAxesGizmo.enabled = v
  }

  /** `setViewport` / `setScissor` 使用 CSS 像素；勿用 `getDrawingBufferSize`（会乘 pixelRatio，导致小窗画到画布外） */
  private readonly rendererCssSize = new THREE.Vector2()

  constructor(options: RenderViewportOptions) {
    this.container = options.container
    const w = Math.max(options.width, 1)
    const h = Math.max(options.height, 1)
    const aspect = w / h

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.renderer.setSize(w, h)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    const fs = DEFAULT_FRUSTUM_SIZE
    this.orthographicCamera = new THREE.OrthographicCamera(
      (-fs * aspect) / 2,
      (fs * aspect) / 2,
      fs / 2,
      -fs / 2,
      0.1,
      500,
    )

    this.orbitTarget = new THREE.Vector3(0, 2, 0)

    options.container.appendChild(this.renderer.domElement)
  }

  get activeCamera(): THREE.OrthographicCamera {
    return this.orthographicCamera
  }

  private isGlContextUsable(): boolean {
    const gl = this.renderer.getContext() as WebGLRenderingContext
    return !gl.isContextLost()
  }

  /**
   * 随容器改变宽高比；保持当前垂直视锥半高（`top`）不变，仅重算 left/right。
   */
  resize(width: number, height: number): void {
    if (!this.isGlContextUsable()) {
      return
    }
    const w = Math.max(width, 1)
    const h = Math.max(height, 1)
    const aspect = w / h

    const o = this.orthographicCamera
    const halfH = o.top > 0 && o.bottom < 0 ? o.top : DEFAULT_FRUSTUM_SIZE / 2
    o.left = -halfH * aspect
    o.right = halfH * aspect
    o.top = halfH
    o.bottom = -halfH
    o.updateProjectionMatrix()

    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.renderer.setSize(w, h)
  }

  render(scene: THREE.Scene): void {
    if (!this.isGlContextUsable()) {
      return
    }
    this.renderer.render(scene, this.orthographicCamera)
    if (this.worldAxesGizmo.enabled) {
      this.renderer.getSize(this.rendererCssSize)
      this.worldAxesGizmo.renderOverlay(
        this.renderer,
        this.orthographicCamera,
        this.rendererCssSize.x,
        this.rendererCssSize.y,
      )
    }
  }

  dispose(): void {
    this.worldAxesGizmo.dispose()
    this.renderer.dispose()
    const el = this.renderer.domElement
    if (el.parentNode === this.container) {
      this.container.removeChild(el)
    }
  }
}
