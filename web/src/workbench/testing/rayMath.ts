/**
 * 纯数学 3D 工具 — 无 Three.js 依赖。
 *
 * 供 mock queries 使用：屏幕↔世界坐标转换、射线-AABB 求交。
 * 对标 Three.js 的 orthographicCamera + Raycaster 行为。
 */

/* —— 类型 —— */

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface CameraParams {
  position: Vec3
  target: Vec3
  up: Vec3
  left: number
  right: number
  top: number
  bottom: number
  near: number
  far: number
  viewportWidth: number
  viewportHeight: number
}

/* —— Vec3 helpers —— */

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z }
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

export function scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s }
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

export function norm(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
}

export function normalize(v: Vec3): Vec3 {
  const n = norm(v)
  if (n === 0) return { x: 0, y: 0, z: 0 }
  return { x: v.x / n, y: v.y / n, z: v.z / n }
}

export function negate(v: Vec3): Vec3 {
  return { x: -v.x, y: -v.y, z: -v.z }
}

/* —— Camera frame —— */

export interface CameraFrame {
  /** 相机右方向（世界系） */
  xAxis: Vec3
  /** 相机上方向（世界系） */
  yAxis: Vec3
  /** 相机视线方向（世界系，指向目标）= -z_axis_local */
  zAxis: Vec3
}

/** 从 position/target/up 计算相机坐标系 */
export function computeCameraFrame(position: Vec3, target: Vec3, up: Vec3): CameraFrame {
  const zAxis = normalize(sub(position, target))   // 正交相机视线 = target → position（远离视锥体）
  const xAxis = normalize(cross(up, zAxis))
  const yAxis = cross(zAxis, xAxis)
  return { xAxis, yAxis, zAxis }
}

/* —— 正交投影 —— */

/** 屏幕坐标 → NDC */
export function screenToNDC(screenX: number, screenY: number, viewportWidth: number, viewportHeight: number): { x: number; y: number } {
  const x = (screenX / viewportWidth) * 2 - 1
  const y = -(screenY / viewportHeight) * 2 + 1
  return { x, y }
}

/**
 * 正交相机：屏幕坐标 → 射线。
 *
 * 与 Three.js OrthographicCamera Raycaster.setFromCamera 行为一致：
 *  - 所有射线平行，方向 = camera.getWorldDirection() = normalize(target - position)
 *  - 原点 = 相机位置 + ndcX * (right-left)/2 * xAxis + ndcY * (top-bottom)/2 * yAxis
 */
export function screenToRay(
  screenX: number,
  screenY: number,
  cam: CameraParams,
): { origin: Vec3; dir: Vec3 } {
  const ndc = screenToNDC(screenX, screenY, cam.viewportWidth, cam.viewportHeight)
  const frame = computeCameraFrame(cam.position, cam.target, cam.up)

  const halfW = (cam.right - cam.left) / 2
  const halfH = (cam.top - cam.bottom) / 2

  const offsetX = ndc.x * halfW
  const offsetY = ndc.y * halfH

  const origin = add(
    add(cam.position, scale(frame.xAxis, offsetX)),
    scale(frame.yAxis, offsetY),
  )

  const dir = negate(frame.zAxis)  // 视线方向：position → target

  return { origin, dir }
}

/** 世界坐标 → 屏幕坐标（正交投影），屏幕外返回 null */
export function worldToScreen(
  worldPos: Vec3,
  cam: CameraParams,
): { x: number; y: number } | null {
  const frame = computeCameraFrame(cam.position, cam.target, cam.up)

  // 世界 → 相机空间
  const rel = sub(worldPos, cam.position)
  const camX = dot(rel, frame.xAxis)
  const camY = dot(rel, frame.yAxis)
  const camZ = dot(rel, frame.zAxis)

  // 检查是否在 near/far 之间（视线方向 zAxis = position→target = -camera_local_z）
  if (camZ > 0 || camZ < -(cam.far - cam.near)) return null

  // 相机空间 → NDC（正交）
  const halfW = (cam.right - cam.left) / 2
  const halfH = (cam.top - cam.bottom) / 2

  const ndcX = camX / halfW
  const ndcY = camY / halfH

  if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) return null

  // NDC → 屏幕
  return {
    x: ((ndcX + 1) / 2) * cam.viewportWidth,
    y: ((-ndcY + 1) / 2) * cam.viewportHeight,
  }
}

/* —— 射线-AABB 求交 —— */

/**
 * Ray vs Axis-Aligned Bounding Box (slab method)。
 * 返回 tMin（命中参数），不命中返回 null。
 */
export function rayAABB(
  origin: Vec3,
  dir: Vec3,
  aabbMin: Vec3,
  aabbMax: Vec3,
): number | null {
  let tMin = -Infinity
  let tMax = Infinity

  // X slab
  if (dir.x !== 0) {
    let t1 = (aabbMin.x - origin.x) / dir.x
    let t2 = (aabbMax.x - origin.x) / dir.x
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp }
    if (t1 > tMin) tMin = t1
    if (t2 < tMax) tMax = t2
  } else if (origin.x < aabbMin.x || origin.x > aabbMax.x) {
    return null
  }

  // Y slab
  if (dir.y !== 0) {
    let t1 = (aabbMin.y - origin.y) / dir.y
    let t2 = (aabbMax.y - origin.y) / dir.y
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp }
    if (t1 > tMin) tMin = t1
    if (t2 < tMax) tMax = t2
  } else if (origin.y < aabbMin.y || origin.y > aabbMax.y) {
    return null
  }

  // Z slab
  if (dir.z !== 0) {
    let t1 = (aabbMin.z - origin.z) / dir.z
    let t2 = (aabbMax.z - origin.z) / dir.z
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp }
    if (t1 > tMin) tMin = t1
    if (t2 < tMax) tMax = t2
  } else if (origin.z < aabbMin.z || origin.z > aabbMax.z) {
    return null
  }

  if (tMin > tMax || tMax < 0) return null
  return tMin >= 0 ? tMin : tMax
}
