/**
 * **P10e 段② 浏览器侧探针**（e2e 专用；经 vite 转译加载）。
 *
 * ## 为什么必须有这个文件（而不是在 `page.evaluate` 里 `import('three')`）
 *
 * Playwright 把传给 `page.evaluate` 的**函数**序列化成源码在页面里**裸执行**
 * —— 裸说明符 `three` 没有 import map 可解析，实测报
 * `Failed to resolve module specifier 'three'`（本批实测：10 条用例因此全红）。
 *
 * 只有经 **vite dev server 转译**的模块才会被重写说明符。故探针放在 `web/e2e/` 下
 * （在 vite root 之内），spec 用**静态绝对路径**动态 import 它 —— 与产品代码
 * 同一台 dev server、**同一份** three 实例、同一套路径别名。
 *
 * 这与 `e2e/helpers/presentation/probe.ts`（P5 交付）是同一手法，理由也同一。
 * 不复用那个文件：它 import 的是 `presentation/` 的内部实现与测试夹具
 * （`presentation/__tests__/fixtures`），而本探针要的是**真实工作台里的视口会话**
 * —— 两者的输入面不同，混在一起会让"探针读了测试夹具"污染生产判据。
 */

import * as THREE from 'three'

/** 两链离屏渲染的读数。 */
export interface OffscreenChainStats {
  readonly nonBackground: number
  readonly coverage: number
  readonly bbox: readonly [number, number, number, number]
  /**
   * 该链这次离屏渲染的 PNG data URL（#387 C6 的**画面取证**用）。
   *
   * 为什么要它：材质判据（"贴图真的接上了"）若只读 `material.map !== null`，
   * 证的是**对象图**而不是**画面**。截图使"有贴图 / 无贴图"两次渲染可**逐像素**对照
   * （`preserveDrawingBuffer: true` 已开，故 `toDataURL` 拿到的是刚渲染的那一帧）。
   */
  readonly png: string
}

export interface OffscreenBothResult {
  readonly presenter: OffscreenChainStats
  readonly legacy: OffscreenChainStats
  readonly negativeEmpty: boolean
  readonly width: number
  readonly height: number
  readonly note: string
}

/** 从 `window.__vm__` 取一个**已装配呈现会话**的视口槽。 */
function slotWithSurface(): {
  surface: { object3d: THREE.Object3D; pickAtNdc: (c: THREE.Camera, n: THREE.Vector2) => { kind: string; resolution?: unknown } } | null
  camera: THREE.Camera | null
  legacyGroup: THREE.Object3D | null
} {
  const ctx = (window as unknown as { __vm__?: Record<string, any> }).__vm__
  const slots = ctx?.viewports
  if (slots === undefined) return { surface: null, camera: null, legacyGroup: null }
  const candidates: any[] = []
  const active = slots.active?.value
  if (active) candidates.push(active)
  for (const id of ['r-viewport', 'r-wiki-preview', 'r-workbench-viewport', 'r-embed']) {
    const s = slots.get?.(id)
    if (s) candidates.push(s)
  }
  const hit = candidates.find((s) => s?.presenterSurface != null && s?.camera?.value != null)
  if (hit === undefined) return { surface: null, camera: null, legacyGroup: null }
  return {
    surface: hit.presenterSurface,
    camera: hit.camera.value,
    legacyGroup: hit.contentGroup?.value ?? null,
  }
}

/**
 * 同一相机下**离屏渲染两链**并逐像素统计。
 *
 * ## 为什么必须离屏、且必须同一相机
 *
 * 本批**不**切换渲染链（见 `composition/presenterSession` 文件头：切一半 = 半成品）。
 * 于是"呈现层画出了与既有链一样的画面"这句话**不能**靠"截实时视口图"来证
 * —— 实时视口里画的是 **legacy 链**，与呈现层无关。
 *
 * 正确判据是**同一相机、同一份内核内容、两条链各自渲染**再统计：
 *
 * ```
 *                同一 ViewportCamera
 *                        │
 *         ┌──────────────┴──────────────┐
 *         ▼                             ▼
 *   呈现链（本批）                 legacy 链（既有）
 *   presenterSurface.object3d      vpSlot.contentGroup
 *         └──────────────┬──────────────┘
 *                        ▼
 *          独立 WebGLRenderer 离屏渲染 + readPixels
 * ```
 *
 * ## 为什么不是"逐像素完全相等"
 *
 * 两链的**几何数值**已被 P10d 证明逐位一致，但**材质**不同（呈现层是
 * `MeshBasicMaterial` + 顶点色；legacy 走 `simpleMaterialLibrary` 的贴图材质）。
 * ⇒ 像素**不会**逐位相等，而那**不是**本批缺口（材质统一归 #301 渲染链终切）。
 * 故读数是**结构性**的：非空 / 覆盖率 / 包围盒。
 *
 * ## 负对照为什么必须在这里
 *
 * "非空"这条判据若不加负对照就是恒真的（任何渲染器吐出的图都"非空"）。
 * 负对照（**不加任何对象**渲染一次必须为空）证明"非空"确实在检测"画了东西"。
 */
export async function renderBothChainsOffscreen(): Promise<OffscreenBothResult> {
  const { surface, camera, legacyGroup } = slotWithSurface()
  const empty: OffscreenChainStats = { nonBackground: 0, coverage: 0, bbox: [0, 0, 0, 0], png: '' }
  if (surface === null || camera === null) {
    return { presenter: empty, legacy: empty, negativeEmpty: true, width: 0, height: 0, note: 'no-surface-or-camera' }
  }
  const presenterRoot = surface.object3d as THREE.Object3D
  if (legacyGroup === null) {
    return { presenter: empty, legacy: empty, negativeEmpty: true, width: 0, height: 0, note: 'legacy-group-missing' }
  }

  const W = 320
  const H = 240
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true })
  renderer.setSize(W, H, false)
  const scene = new THREE.Scene()
  // 固定深色背景（与工作台视口同族），使"非背景"可判定
  scene.background = new THREE.Color(0x0b1217)

  const readStats = (): OffscreenChainStats => {
    const gl = renderer.getContext()
    const px = new Uint8Array(W * H * 4)
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px)
    // 背景色 (0x0b,0x12,0x17)；容差吸收抗锯齿/色彩空间抖动
    let nonBg = 0
    let minX = W
    let minY = H
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        const d =
          Math.abs(px[i]! - 0x0b) + Math.abs(px[i + 1]! - 0x12) + Math.abs(px[i + 2]! - 0x17)
        if (d <= 24) continue
        nonBg += 1
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    return {
      nonBackground: nonBg,
      coverage: nonBg / (W * H),
      bbox: (maxX < 0 ? [0, 0, 0, 0] : [minX, minY, maxX, maxY]) as [number, number, number, number],
      // 画面取证：刚渲染的那一帧（`preserveDrawingBuffer: true` 保证它还在）
      png: canvas.toDataURL('image/png'),
    }
  }

  /**
   * **两支共用的取景相机**（本判据的关键决定之一）。
   *
   * ## 为什么不复用实时视口的相机（第一版那样做，实测两支都读出 0 像素）
   *
   * 实测（本批诊断）：实时相机是**正交**相机，且其 `near/far` 被 legacy 链
   * **收紧到刚好裹住它自己的内容**（实测 25.18 … 54.04，内容沿视向跨约
   * 25.8 … 53.4）。那是"视口自己那一次渲染"的取景参数，换个渲染目标/场景后
   * 几何会落到裁剪面**之外** ⇒ `readPixels` 全背景。
   *
   * 更根本的问题：复用实时相机让判据依赖"那个相机此刻恰好对准两链"这一偶然事实
   * —— 而判据要的是"**同一相机下**两条链是否画出同一片东西"。
   *
   * ⇒ 本函数**自建**一个把两链包围盒都框住的透视相机，**两支都用它**。
   * 这仍然满足"同一相机"（甚至更强：相机由被测内容自己导出，可复现）。
   */
  const boxOf = (o: THREE.Object3D): THREE.Box3 => {
    o.updateMatrixWorld(true)
    return new THREE.Box3().setFromObject(o)
  }
  const boxP = boxOf(presenterRoot)
  const boxL = boxOf(legacyGroup)
  const union = boxP.clone().union(boxL)
  if (union.isEmpty()) {
    renderer.dispose()
    return { presenter: empty, legacy: empty, negativeEmpty: true, width: W, height: H, note: 'empty-bounds' }
  }
  const center = union.getCenter(new THREE.Vector3())
  const size = union.getSize(new THREE.Vector3())
  const radius = Math.max(size.length() / 2, 1e-3)
  // 距离取 2.6×半径：留足余量使**整份包围盒**在锥体内（含对角）
  const dist = radius * 2.6
  const view = new THREE.PerspectiveCamera(45, W / H, Math.max(dist / 100, 1e-4), dist + radius * 4)
  view.position.set(center.x + dist * 0.6, center.y + dist * 0.6, center.z + dist * 0.6)
  view.lookAt(center)
  view.updateMatrixWorld(true)

  const renderAndRead = (obj: THREE.Object3D | null): OffscreenChainStats => {
    // 两链都挂在实时场景树上但**不被这次渲染驱动**，故必须显式刷新世界矩阵
    // —— 否则 `matrixWorld` 停在别处，渲染出的是错位/空的图。
    if (obj !== null) {
      obj.updateMatrixWorld(true)
      scene.add(obj)
    }
    renderer.render(scene, view)
    const st = readStats()
    if (obj !== null) scene.remove(obj)
    return st
  }

  const presenterView = renderAndRead(presenterRoot)
  const legacyView = renderAndRead(legacyGroup)

  // **负对照**：什么都不加 ⇒ 必须为空
  renderer.clear()
  renderer.render(scene, view)
  const nothing = readStats()
  renderer.dispose()

  return {
    presenter: presenterView,
    legacy: legacyView,
    negativeEmpty: nothing.nonBackground === 0,
    width: W,
    height: H,
    note: 'ok',
  }
}

export interface DiagnosticResult {
  readonly note: string
  readonly camera: { readonly x: number; readonly y: number; readonly z: number; readonly near: number; readonly far: number; readonly type: string } | null
  readonly presenterBounds: readonly number[] | null
  readonly legacyBounds: readonly number[] | null
  readonly presenterChildren: number
  readonly legacyChildren: number
  readonly presenterVisible: boolean
  readonly legacyVisible: boolean
  readonly activeRegionId: string | null
  readonly slotIds: readonly string[]
}

/** 诊断：把相机与两链的包围盒如实报出来（定位"为什么没画出像素"）。 */
export function diagnose(): DiagnosticResult {
  const { surface, camera, legacyGroup } = slotWithSurface()
  const ctx = (window as unknown as { __vm__?: Record<string, any> }).__vm__
  const slots = ctx?.viewports
  const slotIds: string[] = []
  if (slots !== undefined) {
    for (const id of ['r-viewport', 'r-wiki-preview', 'r-workbench-viewport', 'r-embed']) {
      if (slots.get?.(id)) slotIds.push(id)
    }
  }
  const boxOf = (o: THREE.Object3D | null): number[] | null => {
    if (o === null) return null
    o.updateMatrixWorld(true)
    const b = new THREE.Box3().setFromObject(o)
    if (b.isEmpty()) return null
    return [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map((v) => Number(v.toFixed(3)))
  }
  const cam = camera as (THREE.Camera & { near?: number; far?: number }) | null
  return {
    note: surface === null ? 'no-surface' : camera === null ? 'no-camera' : 'ok',
    camera: cam === null ? null : {
      x: Number(cam.position.x.toFixed(3)),
      y: Number(cam.position.y.toFixed(3)),
      z: Number(cam.position.z.toFixed(3)),
      near: cam.near ?? -1,
      far: cam.far ?? -1,
      type: cam.type,
    },
    presenterBounds: surface === null ? null : boxOf(surface.object3d as THREE.Object3D),
    legacyBounds: boxOf(legacyGroup),
    presenterChildren: surface === null ? 0 : (surface.object3d as THREE.Object3D).children.length,
    legacyChildren: legacyGroup?.children.length ?? 0,
    presenterVisible: surface === null ? false : (surface.object3d as THREE.Object3D).visible,
    legacyVisible: legacyGroup?.visible ?? false,
    activeRegionId: slots?.active?.value?.id ?? null,
    slotIds,
  }
}

export interface PickScanResult {
  readonly hits: number
  readonly stale: number
  readonly cells: readonly string[]
  readonly sample: readonly { readonly objectId: string; readonly cell: string; readonly quadIndex: number }[]
  readonly note: string
}

/**
 * 在视口屏幕上扫一片 NDC 网格，收集**拾取到的格**。
 *
 * ## 为什么判据是"格集合的大小"而不是"某一次拾取的结果"
 *
 * 后者对点击位置极敏感（打在背景上就什么都没解出），会做出一条**间歇性假红**
 * 的判据。扫一片网格则稳定地覆盖到结构体，且"解出的格多于一个"才真正证明
 * **逐格层有区分力**（否则任何点击都解到同一格 —— 那正是本批要补的缺口形态）。
 */
export function pickCellsAcrossViewport(): PickScanResult {
  const { surface, camera } = slotWithSurface()
  if (surface === null || camera === null) {
    return { hits: 0, stale: 0, cells: [], sample: [], note: 'no-surface-or-camera' }
  }

  /**
   * **取景相机由被测内容的包围盒导出**（而不是复用实时视口相机）。
   *
   * ## 为什么（本批诊断实测）
   *
   * 实时相机是**正交**相机且 `near/far` 被 legacy 链收紧到刚好裹住它自己的内容
   * （实测 25.18…54.04）。呈现链的对象虽然与之几何重合，但**射线**只要有一点
   * 数值差异就会全落在裁剪面外 ⇒ 实测 81 个采样点**全部 miss**
   * （`hits: 0`）。
   *
   * 更根本：复用实时相机让判据依赖"那个相机此刻恰好对准"这一偶然事实，
   * 而判据要证的是"**逐格层能解出格**"。自建相机后，"多发屏幕位置 ⇒ 多个不同的格"
   * 成为被测实现本身的属性，与视口取景无关。
   */
  const view = framingCameraOf(surface.object3d as THREE.Object3D)
  if (view === null) {
    return { hits: 0, stale: 0, cells: [], sample: [], note: 'empty-bounds' }
  }

  const cells: string[] = []
  const sample: { objectId: string; cell: string; quadIndex: number }[] = []
  let hits = 0
  let stale = 0
  for (let nx = -0.8; nx <= 0.81; nx += 0.2) {
    for (let ny = -0.8; ny <= 0.81; ny += 0.2) {
      const res = surface.pickAtNdc(view, new THREE.Vector2(nx, ny)) as {
        kind: string
        resolution?: {
          objectId: string
          cell?: { column: number; row: number; zSlice: number; quadIndex: number }
        }
      }
      if (res.kind === 'stale') {
        stale += 1
        continue
      }
      if (res.kind !== 'hit' || res.resolution === undefined) continue
      hits += 1
      const c = res.resolution.cell
      if (c === undefined) continue
      const key = `${c.column},${c.row},${c.zSlice}`
      cells.push(key)
      if (sample.length < 5) {
        sample.push({ objectId: res.resolution.objectId, cell: key, quadIndex: c.quadIndex })
      }
    }
  }
  return { hits, stale, cells, sample, note: 'ok' }
}

/**
 * 由对象包围盒导出一个把它整份框住的透视相机（**两支共用**）。
 *
 * 判据"同一相机下比较"因此是**可复现**的：相机完全由被测内容决定，
 * 不含任何时刻相关的参数（机位/尺寸/裁剪）。
 */
function framingCameraOf(obj: THREE.Object3D): THREE.PerspectiveCamera | null {
  obj.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(obj)
  if (box.isEmpty()) return null
  const center = box.getCenter(new THREE.Vector3())
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3)
  const dist = radius * 2.6
  const cam = new THREE.PerspectiveCamera(45, 4 / 3, Math.max(dist / 100, 1e-4), dist + radius * 4)
  // 斜视（不是正对某轴）：正对会把整个结构压成一个面，扫不出多个格
  cam.position.set(center.x + dist * 0.6, center.y + dist * 0.6, center.z + dist * 0.6)
  cam.lookAt(center)
  cam.updateMatrixWorld(true)
  return cam
}
