import * as THREE from 'three'

const DEFAULT_SIZE_PX = 104
const FRUSTUM = 2.2

export class WorldAxesGizmo extends THREE.Object3D {
  private readonly ortho: THREE.OrthographicCamera
  private readonly viewportBackup = new THREE.Vector4()

  private _visible = true

  constructor(axisLength = 1.35) {
    super()
    this.name = 'WorldAxesGizmo'

    const axes = new THREE.AxesHelper(axisLength)
    axes.frustumCulled = false
    const mat = axes.material as THREE.LineBasicMaterial
    mat.depthTest = false
    axes.renderOrder = 999
    this.add(axes)

    this.ortho = new THREE.OrthographicCamera(-FRUSTUM, FRUSTUM, FRUSTUM, -FRUSTUM, 0.1, 8)
    this.ortho.position.set(0, 0, 3)
    this.ortho.lookAt(0, 0, 0)
  }

  get enabled(): boolean {
    return this._visible
  }

  set enabled(v: boolean) {
    this._visible = v
  }

  renderOverlay(
    renderer: THREE.WebGLRenderer,
    camera: THREE.Camera,
    width: number,
    height: number,
    sizePx: number = DEFAULT_SIZE_PX,
  ): void {
    if (!this._visible) return

    const w = Math.max(width, 1)
    const h = Math.max(height, 1)
    const d = Math.max(32, Math.min(sizePx, Math.floor(Math.min(w, h) * 0.35)))

    this.quaternion.copy(camera.quaternion).invert()
    this.updateMatrixWorld(true)

    renderer.getViewport(this.viewportBackup)
    const prevAutoClear = renderer.autoClear
    try {
      renderer.autoClear = false
      renderer.clearDepth()

      const margin = 8
      const x = w - d - margin
      const y = h - d - margin

      renderer.setViewport(x, y, d, d)
      renderer.setScissor(x, y, d, d)
      renderer.setScissorTest(true)
      renderer.render(this, this.ortho)
    } finally {
      renderer.setScissorTest(false)
      renderer.autoClear = prevAutoClear
      renderer.setViewport(
        this.viewportBackup.x,
        this.viewportBackup.y,
        this.viewportBackup.z,
        this.viewportBackup.w,
      )
    }
  }

  dispose(): void {
    const axes = this.children[0] as THREE.AxesHelper | undefined
    if (axes) {
      axes.geometry.dispose()
      ;(axes.material as THREE.Material).dispose()
    }
  }
}
