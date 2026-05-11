import * as THREE from 'three'
import { MOUSE } from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { WorldAxesGizmo } from './worldAxesGizmo'

const DEFAULT_FRUSTUM_SIZE = 10

export interface RenderViewportOptions {
  /** 挂载 canvas 的容器（内部会 append renderer.domElement） */
  container: HTMLElement
  width: number
  height: number
}

/**
 * 视口：仅使用正交相机 + {@link OrbitControls}（旋转目标为轨道中心，滚轮缩放正交视锥）。
 */
export class RenderViewport {
  readonly renderer: THREE.WebGLRenderer

  readonly orthographicCamera: THREE.OrthographicCamera

  readonly controls: OrbitControls

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

    this.controls = new OrbitControls(this.orthographicCamera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.rotateSpeed = 0.9
    /** 中键拖动平移轨道目标（相机对准中心），默认中键为缩放 DOLLY，此处改为 PAN */
    this.controls.enablePan = true
    this.controls.mouseButtons = {
      LEFT: MOUSE.ROTATE,
      MIDDLE: MOUSE.PAN,
      RIGHT: MOUSE.DOLLY,
    }

    const el = this.renderer.domElement
    /**
     * Windows 等环境下中键会启动浏览器「滚动模式」并伴随额外 wheel/合成事件；
     * 释放后 `OrbitControls` 在 `state === NONE` 时处理 wheel 会误判为缩放，相机沿视线突进。
     * 阻止中键默认行为，保留中键平移（与 OrbitControls 的 pointer 监听不冲突）。
     */
    el.addEventListener(
      'pointerdown',
      (e: PointerEvent) => {
        if (e.button === 1) e.preventDefault()
      },
      { capture: true },
    )

    options.container.appendChild(el)
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
    this.controls.dispose()
    this.renderer.dispose()
    const el = this.renderer.domElement
    if (el.parentNode === this.container) {
      this.container.removeChild(el)
    }
  }
}
