/**
 * `presentation/offscreenCamera` —— **冻结取景值 → Three 相机**（#301 P10f/E）。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | 导出器自建相机并**借用/旋转实时视口机位** | `workbench/exportIsometricImage.ts:153-168` 自建 `PerspectiveCamera` 后手抄 `ortho.position/quaternion/up`，且取景来自"当前视口" | 由**冻结的** `CameraSpec`（值）纯映射出相机；本模块**没有**任何"取当前相机"的入口 |
 *
 * ## 为什么必须有它（而不是让端口实现自己 new 一个相机）
 *
 * 取景口径是**政策**而非接线：`projection` 两态（perspective/orthographic）、
 * `up` 的处理、正交盒的 halfHeight 由垂直视场与距离导出 —— 这些判定若散在
 * 端口实现里，第二个消费者就会再写一份，两份漂移的表现是"同一 request 导出的
 * 取景与预览不一致"（正是 D7 同族的缺陷形态）。
 *
 * 故它是**纯函数**（值进、相机出，不读全局、不碰 DOM/视口），放在 `presentation/`
 * —— 该层按 `LAYER_DESTINATIONS` 是**整层执行面**（无 `activeSubpaths`），
 * 新文件自动受 `gate/no-private-cross-layer` 等闸门约束，**无需改任何共享登记**。
 *
 * ## 与 A29（#249 §14）的关系
 *
 * A29 的负对照原文是「导出**借用并旋转实时相机**」。本模块的类型签名里
 * **没有** `THREE.Camera` 入参、没有 `Viewport`、没有回调 —— "借用"在类型上不可表达；
 * 唯一的输入是 `CameraSpec`（捕获时已复制完毕的值）。
 *
 * ## 纯度边界（如实标注）
 *
 * 本模块 import `three`（构造 `THREE.PerspectiveCamera`/`OrthographicCamera`），
 * 故**不是** `corePurity` 面 —— `presentation` 层本就不在 `corePurityFileSet` 里
 * （见 `boundary-rules.mjs`：只 `domain`/`application` 与声明 `corePurity` 的执行面
 * 禁 Vue/Three）。它**不得**放进 `domain/`/`application/`（那会被闸门判红），
 * 也不得 import 任何实时视口实现（`export-purity.test.ts` 的 `FORBIDDEN_LIVE_VIEWPORT`
 * 面 —— 不过那条判据的判定面当前只含三个 P9 文件，本文件的同族约束由本批的
 * `export-port-implementation.test.ts` 承担）。
 */

import * as THREE from 'three'
import type { CameraSpec } from '@/domain/captureSpec'

/**
 * 冻结取景值 → Three 相机。
 *
 * ## 两态的取舍（逐条说明，因为它是**政策**）
 *
 * | 态 | 参数来源 |
 * |---|---|
 * | `perspective` | `fovDegrees` 直接进 `PerspectiveCamera`；`aspect` 由**渲染设置**（宽/高）给，不由相机自己猜 |
 * | `orthographic` | **halfHeight 由距离与垂直视场导出**：`d·tan(fov/2)`，其中 `d = |position - target|`。这样"正交"与"透视"在同一 `CameraSpec` 下**框住同一片内容**（同一取景语义的两种投影），而不是各用一套凭空的盒尺寸 |
 *
 * `orthographic` 的 `halfHeight` 若直接取 `fovDegrees`（把它当"半个盒高"）会得到
 * 一个与透视支**完全没有关系**的取景 —— 表现为"切投影就跳到另一个尺度"。
 * 导出侧的 `CameraSpec` 只承诺"垂直视场角（度）"，故由它**导出**盒高是唯一
 * 与另一支同源的做法。
 *
 * `near`/`far` 直接取 spec（它们是**捕获时**的裁剪面，属取景的一部分）。
 * 若 `near >= far`（非法捕获值），**显式夹取到最小合法区间**而不是产出
 * 一个"永远画不出东西"的相机 —— 后者会表现为"导出成功但图是空的"，属假成功。
 *
 * ## 朝向
 *
 * `lookAt(target)` 之后设置 `up`。`up` 与视线**共线**时 `lookAt` 会退化
 * （Three 内部叉乘得零向量 ⇒ 相机矩阵含 NaN ⇒ 渲染出空白）。故显式检测并
 * 换一个正交的 `up`（这是"不产出 NaN 矩阵"的必要处理，不是过度防御）。
 */
export function threeCameraOf(spec: CameraSpec, render: { readonly width: number; readonly height: number }): THREE.Camera {
  const position = new THREE.Vector3(spec.position.x, spec.position.y, spec.position.z)
  const target = new THREE.Vector3(spec.target.x, spec.target.y, spec.target.z)
  const up = new THREE.Vector3(spec.up.x, spec.up.y, spec.up.z)

  const viewDirection = new THREE.Vector3().subVectors(target, position)
  const distance = viewDirection.length()

  // `up` 与视线共线 ⇒ `lookAt` 的叉乘退化（NaN 相机矩阵 ⇒ 空白产物）。
  if (up.lengthSq() === 0 || isCollinear(up, viewDirection)) up.set(0, 1, 0)
  if (isCollinear(up, viewDirection)) up.set(0, 0, 1)

  // 裁剪面：必须是 `0 < near < far` 的合法区间（非法捕获值不"静默出空图"）。
  const near = Math.max(spec.near, 1e-4)
  const far = Math.max(spec.far, near + 1e-3)

  const aspect = render.height > 0 ? render.width / render.height : 1
  const fovDegrees = normalizeFov(spec.fovDegrees)

  let camera: THREE.Camera
  if (spec.projection === 'orthographic') {
    // halfHeight 由「距离 × tan(垂直半视场)」导出 —— 与透视支同源（见上文）。
    const halfHeight = Math.max(distance * Math.tan(THREE.MathUtils.degToRad(fovDegrees) / 2), 1e-4)
    const halfWidth = halfHeight * aspect
    camera = new THREE.OrthographicCamera(-halfWidth, halfWidth, halfHeight, -halfHeight, near, far)
  } else {
    camera = new THREE.PerspectiveCamera(fovDegrees, aspect, near, far)
  }

  camera.position.copy(position)
  camera.up.copy(up)
  camera.lookAt(target)
  // 世界矩阵必须**显式**刷新：离屏端口读的是 `camera.matrixWorldInverse`，
  // 而它只在 `updateMatrixWorld` 时更新。少这一步的表现是"导出图与 request 取景不符"
  // （静默错位，不报错）—— 与 `presenterSession.pickAt` 撞过的是同一族坑。
  camera.updateMatrixWorld(true)
  return camera
}

/** 视场角归一：非有限值或非正 ⇒ 用 50°（Three 的惯例默认），并夹到 (0,180)。 */
function normalizeFov(fovDegrees: number): number {
  if (!Number.isFinite(fovDegrees) || fovDegrees <= 0) return 50
  return Math.min(fovDegrees, 179.999)
}

/** 两个向量是否共线（含反向；零向量视为共线）。 */
function isCollinear(a: THREE.Vector3, b: THREE.Vector3): boolean {
  if (a.lengthSq() === 0 || b.lengthSq() === 0) return true
  const cos = a.dot(b) / (a.length() * b.length())
  return Math.abs(Math.abs(cos) - 1) < 1e-6
}
