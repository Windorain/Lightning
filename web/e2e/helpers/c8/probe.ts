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
 * ## 它读什么、注入什么（只此两件 —— 判据的最小面）
 *
 *  - `readPictureCensus`：一次往返读回"画面生产者是谁"的两条**独立**事实
 *    （呈现根在场景树里 / 场景里有没有 legacy 解格网格）；
 *  - `injectLegacyPicture`：**负对照**注入 —— 新建一个含
 *    `userData.triangleMap` 的 legacy 网格组并把它设为结构层（等价于"绘制交回 DRW"）。
 *
 * 两者都**只**读/写公开面（`window.__vm__` 的视口槽字段），不 import 产品内部模块。
 *
 * ## 追查期用过、未随判据留下的读数（如实记录，避免下次重造）
 *
 * 定位本批那条真实缺陷（`blockId` 取到 GF-7 短名）时，本文件曾有一组**射线诊断**
 * （逐目标 `raycast` 直击、几何包围盒/包围球、`setFromCamera` 的手构对照、
 * 顶点投影采样）。结论：稀疏几何上"盲扫 NDC"会给出**误导性的 0 命中**，
 * 真正有区分力的判据是**真实指针 + 已知可命中的探针点**
 * （`parts-hover-stats.spec.ts` 的格内局部坐标口径）—— 本 spec 因此改走那条路。
 * 那些诊断代码不留在交付里（需求已结）；重建它照上面四项写即可。
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

  // `sceneOf(group ?? root)`：负对照把结构层改指 legacy 组后，**呈现根会被
  // RenderEngine 从场景树里摘掉**（它按"结构层引用变了"重挂）⇒ 若仍从呈现根找场景，
  // 就会得到"场景里 0 个网格"的**假读数**（判据②会看不出 legacy 网格在场）。
  // 故从**当前结构层**找。
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
    presenterRootInScene: sceneOf(root) !== null,
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
