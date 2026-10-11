import * as THREE from 'three'
import { View3DRenderer } from '@/render/viewport/renderViewport'
import type { LayerPreviewMode } from '@/render/data/layerPreview'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import type { StructureDefinition } from '@/render/schema/types'
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
}

/**
 * WebGL 视口引擎：场景、RAF、resize。不监听 DOM 指针（hover 走 WM）。
 *
 * ## P10 #261 退役改造（B5 #6 `multi-raf-business` / #11 `material-viewport-tick`）
 *
 * ## 被删除的机制
 *
 * 旧 `mount()` 里的 RAF **同时**做两件事：
 *
 * ```ts
 * const clock = new THREE.Clock()
 * const tick = () => {
 *   requestAnimationFrame(tick)
 *   opts.materialLibrary.tick(clock.getDelta() * 1000)   // ← 业务：每材质自行累计时间
 *   for (const hook of this.frameHooks) hook()            // ← 业务：视口帧钩子
 *   vp.renderMain(); vp.renderOverlay(…); vp.renderGizmo() // ← 绘制
 * }
 * ```
 *
 * 那是 #249 §15 第 6 条要退役的"多 RAF 分别推进业务"的**最典型形态**：
 * 全树唯一的帧时钟在绘制循环里，于是"业务推进可枚举"不成立
 * （没人能列出"下一次纹理动画推进从哪来"）。
 *
 * ## 替代（**本文件不再持有时间语义**）
 *
 *  - **时间**：`EditContext.time`（内核）→ `sceneSeconds()` →
 *    `materialLibrary.setSceneTime(seconds)`。谁调用见下一条；
 *  - **推进**：宿主的帧时钟（`composition/kernelRuntime`）每帧注入 delta，
 *    并在 `onFrame` 里更新材质库的场景时间 —— **不**在本 RAF 里；
 *  - **本 RAF 只做绘制**：`renderMain` / `renderOverlay` / `renderGizmo`
 *    与内容组重挂。它**不**读时钟、**不**推进任何业务状态。
 *
 * ## `frameHooks` 的语义收窄（一条真实的口径变化）
 *
 * 旧钩子在"材质 tick **之后**、绘制**之前**"执行，于是钩子可以依赖
 * "动画已经推进"这一事实。新形态下动画推进**不在本循环里**（它在宿主的
 * 帧时钟里），故钩子不再保证"动画已推进"。
 *
 * 唯一的消费者（`WorkbenchViewport.vue` 的 `updateOverlay`）不依赖动画状态
 * ——它只同步 overlay 场景的可见性/尺寸。⇒ 这个收窄**不**造成行为回退。
 * 若将来有钩子确实需要"动画已推进"，正确做法是订阅宿主的 `FrameClock.onFrame`
 * （那里有明确的顺序保证），而不是回到"在绘制循环里偷偷推进业务"。
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

    /**
     * **绘制循环**（P10 #261：不再持有时间语义）。
     *
     * 与旧实现的逐行差别：删掉了 `const clock = new THREE.Clock()` 与
     * `opts.materialLibrary.tick(clock.getDelta() * 1000)`。剩下的是纯粹的
     * 绘制 + 内容组重挂 —— 时间推进归宿主的帧时钟（见类头说明）。
     *
     * 函数名从 `tick` 改为 `drawFrame`：旧名字暗示"这一帧推进了什么"，
     * 而它现在**只画不算**。名字与职责一致，读者才不会以为时间还在这里走。
     */
    const drawFrame = () => {
      this.animationId = requestAnimationFrame(drawFrame)
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
    drawFrame()

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
  }

  resetView(): void {
    // 由 OPERATOR_VIEW_RESET 写 Main.cameras；DRW 同步 THREE
  }

  screenshot(): void {
    const vp = this.renderer
    const canvas = vp?.domElement
    if (!canvas || !vp || !this.mainScene || !this.overlayScene) return

    const gl = vp.webglRenderer
    const prevBg = this.mainScene.background
    const prevClear = new THREE.Color()
    const prevClearAlpha = gl.getClearAlpha()
    gl.getClearColor(prevClear)

    this.mainScene.background = null
    gl.setClearColor(0x000000, 0)

    vp.renderMain()
    vp.renderOverlay(this.overlayScene)

    const dataUrl = canvas.toDataURL('image/png')

    this.mainScene.background = prevBg
    gl.setClearColor(prevClear, prevClearAlpha)
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
