import test from 'node:test'
import assert from 'node:assert/strict'
import { planForScene, autoOrthoHeight, projectGame, cameraForView, contentBounds } from './camera-plan.mjs'

const scene = {
  id: 'unit', title: 'unit',
  world: { region: 'r', origin: [64, 12, 64], dim: 0, time: 6000, weather: 'clear' },
  blocks: [
    { block: 'stone', at: [0, 0, 0] },
    { block: 'glass', at: [2, 0, 0] },
    { block: 'glass', at: [0, 0, 2] },
  ],
  cameras: {
    views: ['front', 'back', 'left', 'right', 'top', 'bottom'],
    axonometric: [{ name: 'iso-ne', yaw: 225, pitch: 30 }],
    orthoHeight: 'auto',
    resolution: [1920, 1080],
  },
  export: { name: 'unit', shape: 'world' },
}

test('内容包围盒以格为单位（含右上边界 +1）', () => {
  const b = contentBounds(scene)
  assert.deepEqual(b.min, [64, 12, 64])
  assert.deepEqual(b.max, [67, 13, 67])
})

test('正交高度 = 最大跨度 ×1.25 向上取 0.5', () => {
  const b = contentBounds(scene)
  assert.equal(autoOrthoHeight(b), 4) // 跨度 3 → 3.75 → 4
})

test('每格像素数 = 分辨率高 / 正交高度（两侧同口径）', () => {
  const p = planForScene(scene)
  assert.equal(p.orthoHeight, 4)
  assert.equal(p.pxPerBlock, 1080 / 4)
})

test('六视图相机侧：front 在 -Z，back 在 +Z，top 在上方', () => {
  const b = contentBounds(scene)
  const d = 3 * 2 + 4
  assert.equal(cameraForView('front', b, 4).pos[2], b.min[2] - d)
  assert.equal(cameraForView('back', b, 4).pos[2], b.max[2] + d)
  assert.ok(cameraForView('top', b, 4).pos[1] > b.max[1])
  assert.ok(cameraForView('bottom', b, 4).pos[1] < b.min[1])
})

test('orbit 机位方位角 = 180 - 游戏 yaw', () => {
  const p = planForScene(scene)
  const by = Object.fromEntries(p.cameras.map((c) => [c.name, c]))
  assert.equal(by.front.web.yawDeg, 180)
  assert.equal(by.back.web.yawDeg, 0)
  assert.equal(by.left.web.yawDeg, 270)
  assert.equal(by.right.web.yawDeg, 90)
  assert.equal(by['iso-ne'].web.yawDeg, (180 - 225 + 720) % 360)
  assert.equal(by['iso-ne'].web.elevationDeg, 30)
})

test('缩放 = 10 / 正交高度（内核正交相机 height=10/zoom）', () => {
  const p = planForScene(scene)
  for (const c of p.cameras) assert.equal(c.web.zoom, 10 / p.orthoHeight)
})

test('游戏侧投影：PR109 north 机位复算（1280×720、正交高 6、每格 120 px）', () => {
  const camera = { pos: [66.5, 12.5, 57.5], yaw: 0, pitch: 0, orthoHeight: 6 }
  const stoneMin = [64, 12, 64]
  const got = projectGame(camera, [1280, 720], stoneMin)
  assert.equal(got.pxPerBlock, 120)
  assert.equal(got.x, 640 + 2.5 * 120) // right = -X ⇒ 石头的 x 偏右
  assert.equal(got.y, 360 - -0.5 * 120)
})
