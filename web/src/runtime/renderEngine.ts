import * as THREE from 'three'
import { View3DRenderer } from '@/render/viewport/renderViewport'
import type { LayerPreviewMode } from '@/render/data/layerPreview'
import type { StructureDefinition } from '@/render/schema/types'
import type { SelectionOutlinePass } from '@/render/postprocessing/SelectionOutlinePass'
import { syncClipPlanesToGroup } from '@/render/interaction/initialCamera'

export interface RenderEngineReadyPayload {
  mainScene: THREE.Scene
  overlayScene: THREE.Scene
  layers: { structure: THREE.Group; decal: THREE.Group; overlay: THREE.Group }
  camera: THREE.Camera
  domElement: HTMLElement
  orbitTarget: THREE.Vector3
  renderer: View3DRenderer
}

/**
 * 引擎的**装配期**选项。
 *
 * ## 为什么这里**没有**材质库
 *
 * 旧字段 `materialLibrary` 是"绘制循环里每材质累加时间"
 * （`materialLibrary.tick(delta)`）的遗留输入。那条 tick 删除后，本引擎**不再读**它：
 * 画面由呈现会话（`PresenterSession`）产出，贴图绑定走纹理端口，材质库只服务
 * 方块图标缓存（`runtime/drwMeshPipeline` 的 `textureCache`）。
 *
 * 留着这个字段的代价不是"多一个未用参数"：它让"画布寿命"看起来依赖材质库就绪，
 * 于是两个视口宿主都把 `materialLibrary` 写进 `v-if` ⇒ 资源重建期（编辑触发）宿主
 * 卸载重挂、canvas 被换掉。⇒ 一并删除字段与两处挂载条件
 * （SPEC §7.3「资源加载状态改变不得销毁正常视口宿主」、§7.4「保留已有画面」）。
 */
export interface RenderEngineOptions {
  definition: StructureDefinition
  contentGroup: THREE.Group | null
  layerPreviewMode: LayerPreviewMode
  sceneBackground?: number
  showAxesGizmo?: boolean
}

/**
 * WebGL 视口引擎：场景、RAF、resize。不监听 DOM 指针（hover 走 WM）。
 *
 * ## 退役改造（多 RAF 推进业务 / 每材质视口计时）
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
 * 那是要退役的"多 RAF 分别推进业务"的**最典型形态**：
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
  /**
   * 承载设备事件的画布（拆解时**必须**能注销，所以必须是具名引用）。
   *
   * 丢失监听的动作只有 `preventDefault()`（浏览器规范要求：不调用就永远不会恢复），
   * 真正的设备语义（放弃旧代次/诊断/重建）由 `runtime/deviceEvents` 接在**同一张画布**上
   * 转给呈现会话 —— 两处监听各司其职，不是第二套处置。
   */
  private contextCanvas: HTMLCanvasElement | null = null
  private readonly onContextLost = (ev: Event): void => { ev.preventDefault() }
  private readonly onContextRestored = (): void => { this.onResize?.() }
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
    this.contextCanvas = domCanvas
    domCanvas.addEventListener('webglcontextlost', this.onContextLost, false)
    domCanvas.addEventListener('webglcontextrestored', this.onContextRestored, false)

    applySizeFromEl()
    vp.initComposer(mainScene)

    /**
     * **绘制循环**（不再持有时间语义）。
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
      /**
       * **裁剪面跟随内容包围盒**（返工后）。
       *
       * 机位（框选）**不**在这里动 —— 内容变化不得重新框选（`viewportCameraInit` 的纪律）。
       * 但内容**变大**时（多方块拖 Height）旧 `near` 会把盒体切开，屏幕上出现
       * 一道斜切楔形。`syncClipPlanesToGroup` 只改 near/far，不动任何可见构图。
       *
       * 每帧算一次是 O(批次数)：`Box3.setFromObject` 走几何已缓存的 `boundingBox`，
       * 不遍历顶点；且 helper 在值未变时**不**写相机（不触发无用重算）。
       */
      if (opts.contentGroup) syncClipPlanesToGroup(vp.camera, opts.contentGroup)
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
    // 设备事件监听不得随画布"一起失去引用"就算注销 —— 显式摘除，
    // 否则将来复用同一 canvas 重挂引擎会出现重复监听（两次 preventDefault 无害、
    // 两次 onResize 浪费，而"谁还挂着"无从审计）。
    if (this.contextCanvas !== null) {
      this.contextCanvas.removeEventListener('webglcontextlost', this.onContextLost, false)
      this.contextCanvas.removeEventListener('webglcontextrestored', this.onContextRestored, false)
      this.contextCanvas = null
    }
    this.renderer?.dispose()
    this.renderer = null
    this.mainScene = null
    this.overlayScene = null
    this.opts = null
    this.lastContentGroup = null
  }
}