#!/usr/bin/env node
/**
 * 机位权威（唯一）。
 *
 * 输入：场景定义里的机位口径（游戏 yaw/pitch、正交高度、分辨率）+ 内容包围盒。
 * 输出：两侧**同一份**机位计划 —— 游戏侧相机参数、Web 侧 orbit 参数、每格像素数。
 *
 * 约定（与客户端一致，两侧共用）：
 *   - 游戏 yaw = 视线方位角：0 朝 +Z，90 朝 -X，180 朝 -Z，270 朝 +X；
 *   - 游戏 pitch = 俯角，向下为正；
 *   - 正交高度 = 画面**竖直**方向覆盖的世界格数；每格像素数 = 分辨率高 / 正交高度；
 *   - Web 侧 orbit：yawDeg 是**机位**方位角（`pure/camera` 的 atan2(px,pz)），故 `yawDeg = 180 - yaw`；
 *     elevationDeg = pitch；缩放取 `zoom = 10 / orthoHeight`（内核正交相机固定 top=5/bottom=-5）。
 *
 * 本模块只有纯函数；任何 spec/脚本不得另算机位。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** 六视图的相机侧（相机所在方向 + 朝向）。 */
export const VIEW_SPECS = {
  front: { axis: '-z', yaw: 0, pitch: 0 },
  back: { axis: '+z', yaw: 180, pitch: 0 },
  left: { axis: '-x', yaw: 270, pitch: 0 },
  right: { axis: '+x', yaw: 90, pitch: 0 },
  top: { axis: '+y', yaw: 180, pitch: 90 },
  bottom: { axis: '-y', yaw: 180, pitch: -90 },
}

export function contentBounds(scene) {
  const o = scene.world.origin
  let min = [Infinity, Infinity, Infinity]
  let max = [-Infinity, -Infinity, -Infinity]
  for (const b of scene.blocks) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], o[i] + b.at[i])
      max[i] = Math.max(max[i], o[i] + b.at[i] + 1)
    }
  }
  return { min, max, center: [0, 1, 2].map((i) => (min[i] + max[i]) / 2) }
}

/** 正交高度 = 内容最大跨度 × (1+margin)，向上取到 0.5；保证两侧同一取景。 */
export function autoOrthoHeight(bounds, margin = 0.25) {
  const span = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2])
  return Math.ceil((span * (1 + margin)) * 2) / 2
}

/** 相机外推距离：正交投影不影响缩放，取远一点以避开近平面裁剪。 */
export function cameraDistance(bounds) {
  const span = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2])
  return span * 2 + 4
}

export function cameraForView(view, bounds, orthoHeight) {
  const spec = VIEW_SPECS[view]
  if (!spec) throw new Error('未知视图：' + view)
  const d = cameraDistance(bounds)
  const c = bounds.center
  const pos = [...c]
  if (spec.axis === '-z') pos[2] = bounds.min[2] - d
  else if (spec.axis === '+z') pos[2] = bounds.max[2] + d
  else if (spec.axis === '-x') pos[0] = bounds.min[0] - d
  else if (spec.axis === '+x') pos[0] = bounds.max[0] + d
  else if (spec.axis === '+y') pos[1] = bounds.max[1] + d
  else if (spec.axis === '-y') pos[1] = bounds.min[1] - d
  return { name: view, pos, yaw: spec.yaw, pitch: spec.pitch, orthoHeight }
}

export function cameraForAxonometric(a, bounds, orthoHeight) {
  const d = cameraDistance(bounds)
  const yawRad = (a.yaw * Math.PI) / 180
  const pitchRad = (a.pitch * Math.PI) / 180
  // 游戏口径：视线方向 dir = (-sinYaw·cosPitch, -sinPitch, cosYaw·cosPitch) ⇒ 机位 = 目标 - dir·d
  const c = bounds.center
  const pos = [
    c[0] + Math.sin(yawRad) * Math.cos(pitchRad) * d,
    c[1] + Math.sin(pitchRad) * d,
    c[2] - Math.cos(yawRad) * Math.cos(pitchRad) * d,
  ]
  return { name: a.name, pos, yaw: a.yaw, pitch: a.pitch, orthoHeight }
}

/** 游戏侧：世界点 → 像素坐标（正交）。 */
export function projectGame(camera, resolution, point) {
  const [W, H] = resolution
  const yaw = (camera.yaw * Math.PI) / 180
  const pitch = (camera.pitch * Math.PI) / 180
  const dir = [-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)]
  // right = dir × up（yaw 0 朝 +Z 时 right = -X，与游戏内左右一致）
  const up = [0, 1, 0]
  let right = [dir[1] * up[2] - dir[2] * up[1], dir[2] * up[0] - dir[0] * up[2], dir[0] * up[1] - dir[1] * up[0]]
  const rl = Math.hypot(...right) || 1
  right = right.map((v) => v / rl)
  const camUp = [right[1] * dir[2] - right[2] * dir[1], right[2] * dir[0] - right[0] * dir[2], right[0] * dir[1] - right[1] * dir[0]]
  const rel = [point[0] - camera.pos[0], point[1] - camera.pos[1], point[2] - camera.pos[2]]
  const pxPerBlock = H / camera.orthoHeight
  const u = rel[0] * right[0] + rel[1] * right[1] + rel[2] * right[2]
  const v = rel[0] * camUp[0] + rel[1] * camUp[1] + rel[2] * camUp[2]
  return { x: W / 2 + u * pxPerBlock, y: H / 2 - v * pxPerBlock, pxPerBlock }
}

/** Web 侧 orbit 参数（与游戏机位一一对应）。 */
export function orbitForGameCamera(camera, bounds, orthoHeight) {
  return {
    targetWorld: bounds.center,
    yawDeg: (180 - camera.yaw + 720) % 360,
    elevationDeg: camera.pitch,
    distance: Math.hypot(
      camera.pos[0] - bounds.center[0],
      camera.pos[1] - bounds.center[1],
      camera.pos[2] - bounds.center[2],
    ),
    zoom: 10 / orthoHeight,
  }
}

/** 场景 → 机位计划（唯一的机位来源）。 */
export function planForScene(scene) {
  const bounds = contentBounds(scene)
  const orthoHeight = scene.cameras.orthoHeight === 'auto' ? autoOrthoHeight(bounds) : scene.cameras.orthoHeight
  const resolution = scene.cameras.resolution
  const cams = []
  for (const v of scene.cameras.views) cams.push(cameraForView(v, bounds, orthoHeight))
  for (const a of scene.cameras.axonometric) cams.push(cameraForAxonometric(a, bounds, orthoHeight))
  return {
    scene: scene.id,
    resolution,
    orthoHeight,
    pxPerBlock: resolution[1] / orthoHeight,
    bounds,
    cameras: cams.map((c) => ({
      name: c.name,
      game: { pos: c.pos, yaw: c.yaw, pitch: c.pitch, orthoHeight: c.orthoHeight, resolution },
      web: orbitForGameCamera(c, bounds, orthoHeight),
    })),
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2]
  if (!file) { console.error('用法：node runner/camera-plan.mjs <scene.json>'); process.exit(2) }
  const scene = JSON.parse(fs.readFileSync(file, 'utf8'))
  console.log(JSON.stringify(planForScene(scene), null, 2))
}
