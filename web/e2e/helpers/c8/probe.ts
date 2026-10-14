/**
 * R1-β① C8 · **浏览器侧画面归属探针**（e2e 专用；经 vite 转译加载）。
 *
 * ## 为什么必须有这个文件（而不是在 `page.evaluate` 里 `import('three')`）
 *
 * Playwright 把传给 `page.evaluate` 的函数**序列化成源码在页面里裸执行**
 * —— 裸说明符 `three` 没有 import map 可解析。只有经 **vite dev server 转译**的
 * 模块才会被重写说明符。故探针放在 `web/e2e/` 下（在 vite root 之内），
 * spec 用**静态绝对路径**动态 import 它（与 `helpers/p10e/probe.ts` 同一手法）。
 *
 * ## 它读什么、注入什么
 *
 *  - `readPictureCensus`：一次往返读回"画面生产者是谁"的两条独立事实
 *    （呈现根在场景树里 / 场景里有没有 legacy 解格网格）；
 *  - `injectLegacyPicture`：**负对照**用的注入 —— 新建一个含
 *    `userData.triangleMap` 的 legacy 网格组并把它设为结构层（等价于"绘制交回 DRW"）。
 *
 * 两者都**只**读/写公开面（`window.__vm__` 的视口槽字段），不 import 产品内部模块。
 */

import * as THREE from 'three'

/** 画面归属读数（字段语义见 spec 的同名 interface）。 */
export interface PictureCensus {
  readonly hasSlot: boolean
  readonly hasSurface: boolean
  readonly contentGroupIsPresenterRoot: boolean
  readonly presenterRootInScene: boolean
  readonly presenterMeshes: number
  readonly triangleMapInContentGroup: number
  readonly triangleMapInScene: number
  readonly meshesInScene: number
}

function slotOf(regionId: string): any {
  const ctx = (window as unknown as { __vm__?: Record<string, any> }).__vm__
  return ctx?.viewports?.get(regionId) ?? null
}

/** 沿 `parent` 链找承载这棵子树的 `Scene`（找不到 ⇒ `null`，即"没进场景树"）。 */
function sceneOf(obj: THREE.Object3D): THREE.Scene | null {
  let cursor: THREE.Object3D | null = obj
  while (cursor !== null) {
    if ((cursor as THREE.Scene).isScene === true) return cursor as THREE.Scene
    cursor = cursor.parent
  }
  return null
}

const isMeshLike = (o: THREE.Object3D): boolean => (o as THREE.Mesh).isMesh === true
const hasTriangleMap = (o: THREE.Object3D): boolean =>
  isMeshLike(o) && o.userData !== undefined && o.userData.triangleMap !== undefined

export function readPictureCensus(regionId: string): PictureCensus {
  const slot = slotOf(regionId)
  const blank: PictureCensus = {
    hasSlot: slot !== null,
    hasSurface: false,
    contentGroupIsPresenterRoot: false,
    presenterRootInScene: false,
    presenterMeshes: 0,
    triangleMapInContentGroup: 0,
    triangleMapInScene: 0,
    meshesInScene: 0,
  }
  if (slot === null) return blank
  const surface = slot.presenterSurface ?? null
  const group = (slot.contentGroup?.value ?? null) as THREE.Object3D | null
  if (surface === null) return blank
  if (group === null) return { ...blank, hasSurface: true }

  const root = surface.object3d as THREE.Object3D
  let presenterMeshes = 0
  root.traverse((o) => {
    if (isMeshLike(o)) presenterMeshes += 1
  })

  let triangleMapInContentGroup = 0
  group.traverse((o) => {
    if (hasTriangleMap(o)) triangleMapInContentGroup += 1
  })

  // `sceneOf(group ?? root)`：负对照把结构层改指 legacy 组后，**呈现根会被 RenderEngine
  // 从场景树里摘掉**（它按"结构层引用变了"重挂）⇒ 若仍从呈现根找场景，就会得到
  // "场景里 0 个网格"的假读数（判据②会看不出 legay 网格在场）。故从**当前结构层**找。
  const scene = sceneOf(group ?? root)
  let triangleMapInScene = 0
  let meshesInScene = 0
  if (scene !== null) {
    scene.traverse((o) => {
      if (!isMeshLike(o)) return
      meshesInScene += 1
      if (hasTriangleMap(o)) triangleMapInScene += 1
    })
  }

  return {
    hasSlot: true,
    hasSurface: true,
    contentGroupIsPresenterRoot: group === root,
    presenterRootInScene: scene !== null,
    presenterMeshes,
    triangleMapInContentGroup,
    triangleMapInScene,
    meshesInScene,
  }
}

/**
 * **负对照注入**：把"绘制交回 legacy `blockMesh`"的等价形态装回现场。
 *
 * 为什么这是等价形态（而不是随便加个物体）：旧画面路径的两个可观察性质是
 * ①结构层指向 legacy 网格组；②该组里的 Mesh 挂 `userData.triangleMap`
 * （`scenePick#pickAtPointer` 解格读的就是它）。本函数把两条都安上。
 *
 * @returns 注入是否成功（找不到场景/会话 ⇒ `false`，调用方据此判红而不是静默跳过）
 */
export function injectLegacyPicture(regionId: string): boolean {
  const slot = slotOf(regionId)
  const root = slot?.presenterSurface?.object3d as THREE.Object3D | null
  if (root === null || root === undefined) return false
  const scene = sceneOf(root)
  if (scene === null) return false

  const group = new THREE.Group()
  group.name = 'c8-negative-control-legacy-mesh'
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3))
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial())
  mesh.name = 'c8-negative-control-legacy-triangle-mesh'
  // 旧解格路径的**指纹字段**
  mesh.userData.triangleMap = [{ col: 0, row: 0, zSlice: 0 }]
  group.add(mesh)
  scene.add(group)
  // 结构层改指这个组（= "画面由 legacy 网格产出"的等价形态）
  slot.contentGroup.value = group
  return true
}

/** 一次拾取链的**诊断读数**（不是判据；判据失败时用来定位"哪一环断了"）。 */
export interface PickDiagnosis {
  readonly hasSlot: boolean
  readonly hasSurface: boolean
  readonly generation: string | null
  readonly cameraType: string | null
  readonly ndc: { readonly x: number; readonly y: number } | null
  /** 内核链的原始拾取结果（`pickAtNdc` 的返回）。 */
  readonly rawPick: unknown
  /** 公开悬停状态（`hoverHandler` 写入）。 */
  readonly hover: unknown
}

/**
 * 把「格内局部坐标」经**视口实际相机**投影到 NDC 后调内核拾取链，并读回公开悬停状态。
 *
 * 为什么需要它：拾取判据失败时，"是画面没内容 / 相机不对 / 内核解不出格 / 悬停没写状态"
 * 四种原因是**完全不同的处置**，而黑盒断言只报"超时"。本函数把那条链逐环报出来。
 * 投影数学与 `helpers/parts/hover#injectHoverAtCellLocal` **同一口径**（列主序矩阵乘）。
 */
export function diagnosePick(
  regionId: string,
  pt: { col: number; row: number; z: number; lx: number; ly: number; lz: number },
): PickDiagnosis {
  const slot = slotOf(regionId)
  const surface = slot?.presenterSurface ?? null
  const cam = slot?.camera?.value ?? null
  const def = slot?.definition?.value ?? null
  const hover = (window as unknown as { __vm__?: Record<string, any> }).__vm__?.region?.(regionId)?.state?.hover
  const hoverBlock = hover?.viewportBlock?.value ?? null
  const base: PickDiagnosis = {
    hasSlot: slot !== null,
    hasSurface: surface !== null,
    generation: surface === null ? null : (surface.generation ?? null),
    cameraType: cam === null ? null : String(cam.type),
    ndc: null,
    rawPick: null,
    hover: hoverBlock,
  }
  if (slot === null || surface === null || cam === null || def === null) return base

  const grid = def.cellGrid as number[][][]
  const d = grid.length
  const h = grid[0]!.length
  const w = grid[0]![0]!.length
  const worldY = h - 1 - pt.row
  const p = { x: pt.col - w / 2 + pt.lx, y: worldY - h / 2 + pt.ly, z: pt.z - d / 2 + pt.lz }
  const mul = (m: number[], v: [number, number, number, number]): [number, number, number, number] => [
    m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2] + m[12]! * v[3],
    m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2] + m[13]! * v[3],
    m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2] + m[14]! * v[3],
    m[3]! * v[0] + m[7]! * v[1] + m[11]! * v[2] + m[15]! * v[3],
  ]
  cam.updateMatrixWorld()
  const view = mul(cam.matrixWorldInverse.elements, [p.x, p.y, p.z, 1])
  const clip = mul(cam.projectionMatrix.elements, view)
  const ndc = { x: clip[0]! / clip[3]!, y: clip[1]! / clip[3]! }
  const rawPick = surface.pickAtNdc(cam, new THREE.Vector2(ndc.x, ndc.y))
  return { ...base, ndc: { x: Number(ndc.x.toFixed(4)), y: Number(ndc.y.toFixed(4)) }, rawPick }
}

/**
 * **射线诊断**（不是判据）：把"为什么解不出格"逐环报出来。
 *
 * 读的是呈现会话的**内部**批次对象（`surface.presenter.pickTargets()`，生产代码里
 * 由 `PresenterSession.pickAt` 使用的那一份），因为黑盒的 `pickAtNdc` 只答
 * "miss"，答不出"是没目标 / 射线没打中 / 打中了解不出身份"。仅限 e2e 探针使用。
 */
export interface RaycastDiagnosis {
  readonly targets: number
  readonly targetWorldPositions: readonly (readonly number[]) []
  readonly cameraType: string | null
  readonly cameraPos: readonly number[] | null
  readonly cameraForward: readonly number[] | null
  /** 用**视口相机**在 ndc(0,0) 的命中数。 */
  readonly realHits: number
  /** 用**内容包围盒导出的取景相机**在同一 ndc 的命中数（对照组）。 */
  readonly framingHits: number
  readonly realDistances: readonly number[]
  readonly framingDistances: readonly number[]
  /** 逐目标的 `raycast` 直击读数（绕开 `intersectObjects` 的分发逻辑）。 */
  readonly targetProbes: readonly Readonly<Record<string, unknown>>[]
  /**
   * **手构中心射线**的命中数：origin = 相机世界位置，direction = 指向
   * 几何包围球中心（逐目标）。用于区分"`setFromCamera` 的射线不对"与"几何不在那儿"。
   */
  readonly manualCenterRayHits: number
  /**
   * 投影往返一致性：把一个几何顶点 `project(cam)` 再按三的 ortho 公式 `unproject(cam)`，
   * 报出与原始世界点的距离（> 0 说明相机的投影逆矩阵与投影矩阵**不一致**）。
   */
  readonly projectionRoundTripError: number | null
}

export function diagnoseRaycast(regionId: string): RaycastDiagnosis {
  const slot = slotOf(regionId)
  const surface = slot?.presenterSurface ?? null
  const cam = (slot?.camera?.value ?? null) as THREE.Camera | null
  const out: RaycastDiagnosis = {
    targets: 0,
    targetWorldPositions: [],
    cameraType: cam === null ? null : cam.type,
    cameraPos: null,
    cameraForward: null,
    realHits: 0,
    framingHits: 0,
    realDistances: [],
    framingDistances: [],
  }
  if (surface === null || cam === null) return out
  const root = surface.object3d as THREE.Object3D
  root.updateMatrixWorld(true)
  const targets = (surface.presenter?.pickTargets?.() ?? []) as THREE.Object3D[]
  const camPos = new THREE.Vector3()
  const camDir = new THREE.Vector3()
  cam.updateMatrixWorld(true)
  cam.getWorldPosition(camPos)
  cam.getWorldDirection(camDir)

  // 对照组：由内容包围盒导出的取景相机（`helpers/p10e/probe` 的同一手法）
  const box = new THREE.Box3().setFromObject(root)
  let framing: THREE.PerspectiveCamera | null = null
  if (!box.isEmpty()) {
    const center = box.getCenter(new THREE.Vector3())
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3)
    const dist = radius * 2.6
    framing = new THREE.PerspectiveCamera(45, 4 / 3, Math.max(dist / 100, 1e-4), dist + radius * 4)
    framing.position.set(center.x + dist * 0.6, center.y + dist * 0.6, center.z + dist * 0.6)
    framing.lookAt(center)
    framing.updateMatrixWorld(true)
  }

  const cast = (camera: THREE.Camera): THREE.Intersection[] => {
    const rc = new THREE.Raycaster()
    rc.setFromCamera(new THREE.Vector2(0, 0), camera)
    return rc.intersectObjects(targets, true)
  }
  const real = cast(cam)
  const fram = framing === null ? [] : cast(framing)

  const rcProbe = new THREE.Raycaster()
  rcProbe.setFromCamera(new THREE.Vector2(0, 0), cam)
  /** 逐对象报出"能不能被射线命中"的**结构前提**（几何/材质/矩阵/包围球）。 */
  const probeOne = (o: THREE.Object3D): Record<string, unknown> => {    const anyO = o as unknown as {
      visible?: boolean
      isInstancedMesh?: boolean
      isMesh?: boolean
      count?: number
      material?: unknown
      geometry?: { attributes?: Record<string, { count?: number }>; index?: unknown; boundingSphere?: unknown }
      boundingSphere?: { center?: { x: number; y: number; z: number }; radius?: number } | null
      raycast?: (r: THREE.Raycaster, out: THREE.Intersection[]) => void
    }
    const out: THREE.Intersection[] = []
    try { anyO.raycast?.(rcProbe, out) } catch (e) { out.length = 0; void e }
    const geo = anyO.geometry ?? {}
    const bs = anyO.boundingSphere ?? null
    return {
      name: o.name,
      type: o.type,
      visible: anyO.visible ?? null,
      isMesh: anyO.isMesh ?? null,
      isInstancedMesh: anyO.isInstancedMesh ?? null,
      count: anyO.count ?? null,
      hasMaterial: anyO.material !== undefined && anyO.material !== null,
      positionCount: geo.attributes?.position?.count ?? null,
      hasIndex: geo.index !== undefined && geo.index !== null,
      geoHasBoundingSphere: geo.boundingSphere !== undefined && geo.boundingSphere !== null,
      instancedSphere: bs === null ? null : {
        radius: bs.radius === undefined ? null : Number(bs.radius.toFixed(2)),
      },
      directRaycastHits: out.length,
      /** 命中失败的头号嫌疑：几何的 `boundingBox` 过时/退化成空盒（三的 `Mesh.raycast` 先查它）。 */
      boundingBoxInfo: (() => {
        const g = (o as unknown as { geometry?: THREE.BufferGeometry }).geometry
        if (g === undefined) return null
        const before = g.boundingBox === null ? null : {
          min: [g.boundingBox.min.x, g.boundingBox.min.y, g.boundingBox.min.z].map((v) => Number(v.toFixed(2))),
          max: [g.boundingBox.max.x, g.boundingBox.max.y, g.boundingBox.max.z].map((v) => Number(v.toFixed(2))),
        }
        const rayHitsBoxBefore = g.boundingBox === null ? null : rcProbe.ray.intersectsBox(g.boundingBox)
        const hadBox = g.boundingBox !== null
        g.computeBoundingBox()
        const rayHitsBoxAfter = g.boundingBox === null ? null : rcProbe.ray.intersectsBox(g.boundingBox)
        const after = g.boundingBox === null ? null : {
          min: [g.boundingBox.min.x, g.boundingBox.min.y, g.boundingBox.min.z].map((v) => Number(v.toFixed(2))),
          max: [g.boundingBox.max.x, g.boundingBox.max.y, g.boundingBox.max.z].map((v) => Number(v.toFixed(2))),
        }
        // 强制重算后再打一次（若此时命中了，根因就是过时的 boundingBox）
        const out2: THREE.Intersection[] = []
        try { (o as unknown as { raycast?: (r: THREE.Raycaster, x: THREE.Intersection[]) => void }).raycast?.(rcProbe, out2) } catch { out2.length = 0 }
        return { hadBox, before, after, rayHitsBoxBefore, rayHitsBoxAfter, hitsAfterRecompute: out2.length }
      })(),
      matrixWorld: (() => {
        o.updateMatrixWorld(true)
        return Array.from(o.matrixWorld.elements).map((v) => Number(v.toFixed(3)))
      })(),
      geoSphere: (() => {
        const g = (o as unknown as { geometry?: THREE.BufferGeometry }).geometry
        if (g === undefined) return null
        if (g.boundingSphere === null) g.computeBoundingSphere()
        const s = g.boundingSphere
        if (s === null) return null
        return {
          center: [s.center.x, s.center.y, s.center.z].map((v) => Number(v.toFixed(2))),
          radius: Number(s.radius.toFixed(2)),
        }
      })(),
      rayInfo: (() => {
        const r = rcProbe.ray
        const g = (o as unknown as { geometry?: THREE.BufferGeometry }).geometry
        if (g === undefined) return null
        if (g.boundingSphere === null) g.computeBoundingSphere()
        const s = g.boundingSphere
        const world = s === null ? null : s.clone().applyMatrix4(o.matrixWorld)
        return {
          origin: [r.origin.x, r.origin.y, r.origin.z].map((v) => Number(v.toFixed(2))),
          direction: [r.direction.x, r.direction.y, r.direction.z].map((v) => Number(v.toFixed(3))),
          near: rcProbe.near,
          far: String(rcProbe.far),
          distToSphereCenter: world === null ? null : Number(r.distanceToPoint(world.center).toFixed(2)),
          intersectsSphere: world === null ? null : r.intersectsSphere(world),
          materialType: (() => {
            const m = (o as unknown as { material?: { type?: string; side?: number } }).material
            return m === undefined ? null : `${m.type}/side=${m.side}`
          })(),
        }
      })(),
      worldPos: (() => {
        o.updateMatrixWorld(true)
        const p = new THREE.Vector3()
        o.getWorldPosition(p)
        return [p.x, p.y, p.z].map((v) => Number(v.toFixed(2)))
      })(),
    }
  }
  const targetProbes: Record<string, unknown>[] = []
  for (const t of targets.slice(0, 2)) {
    targetProbes.push(probeOne(t))
    for (const c of t.children.slice(0, 2)) targetProbes.push(probeOne(c))
  }

  // ── 手构中心射线（绕开 `setFromCamera`） ──
  let manualCenterRayHits = 0
  for (const t of targets) {
    const mesh = (t.isMesh === true ? t : t.children.find((c) => (c as THREE.Mesh).isMesh === true)) as
      | THREE.Mesh
      | undefined
    const g = mesh?.geometry
    if (mesh === undefined || g === undefined) continue
    if (g.boundingSphere === null) g.computeBoundingSphere()
    if (g.boundingSphere === null) continue
    mesh.updateMatrixWorld(true)
    const center = g.boundingSphere.center.clone().applyMatrix4(mesh.matrixWorld)
    const rc = new THREE.Raycaster()
    rc.ray.origin.copy(camPos)
    rc.ray.direction.copy(center).sub(camPos).normalize()
    manualCenterRayHits += rc.intersectObjects([t], true).length
  }

  // ── 投影往返一致性 ──
  let projectionRoundTripError: number | null = null
  {
    const mesh = (targets[0]?.isMesh === true
      ? targets[0]
      : targets[0]?.children.find((c) => (c as THREE.Mesh).isMesh === true)) as THREE.Mesh | undefined
    const pos = mesh?.geometry?.getAttribute?.('position')
    if (mesh !== undefined && pos !== undefined && pos !== null && pos.count > 0) {
      const world = new THREE.Vector3(pos.getX(0), pos.getY(0), pos.getZ(0)).applyMatrix4(mesh.matrixWorld)
      const ndc = world.clone().project(cam)
      const back = new THREE.Vector3(
        ndc.x,
        ndc.y,
        ((cam as THREE.OrthographicCamera).near + (cam as THREE.OrthographicCamera).far)
          / ((cam as THREE.OrthographicCamera).near - (cam as THREE.OrthographicCamera).far),
      ).unproject(cam)
      projectionRoundTripError = Number(back.distanceTo(world).toFixed(3))
    }
  }

  return {
    targets: targets.length,
    targetWorldPositions: targets.slice(0, 4).map((t) => {
      t.updateMatrixWorld(true)
      const p = new THREE.Vector3()
      t.getWorldPosition(p)
      return [Number(p.x.toFixed(3)), Number(p.y.toFixed(3)), Number(p.z.toFixed(3))]
    }),
    cameraType: cam.type,
    cameraPos: [Number(camPos.x.toFixed(3)), Number(camPos.y.toFixed(3)), Number(camPos.z.toFixed(3))],
    cameraForward: [Number(camDir.x.toFixed(3)), Number(camDir.y.toFixed(3)), Number(camDir.z.toFixed(3))],
    realHits: real.length,
    framingHits: fram.length,
    realDistances: real.slice(0, 3).map((h) => Number(h.distance.toFixed(4))),
    framingDistances: fram.slice(0, 3).map((h) => Number(h.distance.toFixed(4))),
    targetProbes,
    manualCenterRayHits,
    projectionRoundTripError,
  }
}

/** 扫一片 NDC 后的拾取读数 + 第一个命中点的 **client 坐标**（供真实指针注入）。 */
export interface PickScan {
  readonly hasSurface: boolean
  readonly generation: string | null
  /** 命中的采样点数。 */
  readonly hits: number
  /** 解出的不同格（`col,row,z`），去重。 */
  readonly cells: readonly string[]
  /** 第一个命中点的 NDC。 */
  readonly ndc: { readonly x: number; readonly y: number } | null
  /** 第一个命中点换算出的 client 坐标（页面视口坐标；`null` = 没命中）。 */
  readonly client: { readonly x: number; readonly y: number } | null
  /** 诊断：各分支的采样计数（`hit`/`miss`/`stale`/其他）。 */
  readonly kinds: Readonly<Record<string, number>>
  /** 诊断：呈现器统计（批次数等）。 */
  readonly stats: unknown
  /** 诊断：呈现根的世界包围盒（`null` = 空）。 */
  readonly bounds: readonly number[] | null
  /** 诊断：包围盒中心投影到 NDC（看它是否落在采样范围/视锥内）。 */
  readonly centerNdc: { readonly x: number; readonly y: number } | null
}

/**
 * 在视口屏幕上扫一片 NDC 网格，收集**内核链解出的格**，并给出第一个命中点的 client 坐标。
 *
 * ## 为什么判据是"格集合"而不是"某一次拾取"
 *
 * 单点拾取对点击位置极敏感（打在空气上就解不出），会做出一条**间歇性假红**的判据。
 * 扫一片则稳定覆盖结构体，且"解出的格多于一个"才证明**逐格层有区分力**。
 * （与 `helpers/p10e/probe#pickCellsAcrossViewport` 同一口径；此处额外把命中点换算成
 *  client 坐标，使下游能注入**真实指针事件**而非只在页面内调 API。）
 */
export function scanPickAndClientOfFirstHit(regionId: string): PickScan {
  const slot = slotOf(regionId)
  const surface = slot?.presenterSurface ?? null
  const cam = slot?.camera?.value ?? null
  const el = (slot?.domElement?.value ?? null) as HTMLElement | null
  const blank: PickScan = {
    hasSurface: surface !== null,
    generation: surface === null ? null : (surface.generation ?? null),
    hits: 0,
    cells: [],
    ndc: null,
    client: null,
    kinds: {},
    stats: null,
    bounds: null,
    centerNdc: null,
  }
  if (surface === null || cam === null || el === null) return blank

  const cells: string[] = []
  const kinds: Record<string, number> = {}
  let hits = 0
  let first: { x: number; y: number } | null = null
  let stats: unknown = null
  try { stats = surface.statsSnapshot() } catch { stats = 'stats-threw' }

  let bounds: number[] | null = null
  let centerNdc: { x: number; y: number } | null = null
  try {
    const root = surface.object3d as THREE.Object3D
    root.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(root)
    if (!box.isEmpty()) {
      bounds = [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z].map((v) => Number(v.toFixed(2)))
      const c = box.getCenter(new THREE.Vector3()).project(cam)
      centerNdc = { x: Number(c.x.toFixed(3)), y: Number(c.y.toFixed(3)) }
    }
  } catch { bounds = null }

  /**
   * **先打真实几何的顶点**（而不是盲扫 NDC 网格）。
   *
   * 为什么：盲扫的采样点可能全部落在结构体的**空心处/屏幕空白处**（本批实测：
   * 81 个 NDC 采样点全 miss，而结构体确实在视锥里且能被射线命中）。
   * 把批次几何的顶点投影回 NDC 再打，命中点**必然**落在三角形上 ——
   * 于是"打不中"只可能是拾取链本身的问题，而不是探针选点不幸。
   */
  const targets = (surface.presenter?.pickTargets?.() ?? []) as THREE.Object3D[]
  const candidateNdcs: { x: number; y: number }[] = []
  const v = new THREE.Vector3()
  for (const t of targets) {
    t.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.isMesh !== true) return
      const pos = mesh.geometry?.getAttribute?.('position')
      if (pos === undefined || pos === null) return
      const stride = Math.max(1, Math.floor(pos.count / 12))
      for (let i = 0; i < pos.count; i += stride) {
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i))
        mesh.updateMatrixWorld(true)
        v.applyMatrix4(mesh.matrixWorld)
        v.project(cam)
        if (v.x < -1 || v.x > 1 || v.y < -1 || v.y > 1) continue
        candidateNdcs.push({ x: Number(v.x.toFixed(4)), y: Number(v.y.toFixed(4)) })
      }
    })
  }

  const consider = (nx: number, ny: number): boolean => {
    const res = surface.pickAtNdc(cam, new THREE.Vector2(nx, ny)) as {
      kind: string
      resolution?: { cell?: { column: number; row: number; zSlice: number } }
    }
    const kind = String(res?.kind ?? 'undefined')
    kinds[kind] = (kinds[kind] ?? 0) + 1
    if (res.kind !== 'hit' || res.resolution?.cell === undefined) return false
    hits += 1
    const c = res.resolution.cell
    cells.push(`${c.column},${c.row},${c.zSlice}`)
    if (first === null) first = { x: nx, y: ny }
    return true
  }

  for (const p of candidateNdcs.slice(0, 60)) consider(p.x, p.y)
  if (hits === 0) {
    for (let nx = -0.8; nx <= 0.81; nx += 0.2) {
      for (let ny = -0.8; ny <= 0.81; ny += 0.2) consider(nx, ny)
    }
  }
  if (first === null) return { ...blank, hits, cells: [...new Set(cells)], kinds, stats, bounds, centerNdc }
  const rect = el.getBoundingClientRect()
  return {
    hasSurface: true,
    generation: surface.generation ?? null,
    hits,
    cells: [...new Set(cells)],
    ndc: first,
    client: {
      x: rect.left + ((first.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - first.y) / 2) * rect.height,
    },
    kinds,
    stats,
    bounds,
    centerNdc,
  }
}
