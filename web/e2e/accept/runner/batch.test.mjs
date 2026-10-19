import test from 'node:test'
import assert from 'node:assert/strict'
import { caseForScene, loadScenes, loadBlocks } from './batch.mjs'
import { planForScene } from './camera-plan.mjs'

const scenes = loadScenes()
const byId = Object.fromEntries(scenes.map((s) => [s.id, s]))

test('每个场景都能产出用例，且机位数 = 六视图 + 轴测', () => {
  for (const s of scenes) {
    const plan = planForScene(s)
    const c = caseForScene(s, plan)
    assert.equal(c.cameras.length, plan.cameras.length)
    for (const cam of c.cameras) {
      assert.equal(cam.projection.type, 'ortho')
      assert.ok(cam.projection.orthoHeight > 0)
      const [W, H] = cam.resolution
      assert.equal(W / H, 16 / 9)
      if (!/^pr(91|109)-/.test(s.id)) {
        assert.equal(cam.resolution[0], 1920)
        assert.equal(cam.resolution[1], 1080)
      }
    }
  }
})

test('用例结构：清区 + 每块一个 block op + 导出 + 六步前置', () => {
  const s = byId['glass-seam']
  const c = caseForScene(s, planForScene(s))
  assert.equal(c.build[0].op, 'clear')
  assert.equal(c.build.length, 1 + s.blocks.length)
  const b0 = c.build[1]
  assert.equal(b0.op, 'block')
  assert.equal(b0.id, 'minecraft:stone')
  assert.deepEqual(b0.at, [64, 12, 64])
  assert.equal(c.export[0].action, 'export.scene')
  assert.equal(c.action.length, 6)
  assert.ok(c.action.every((a) => typeof a.path === 'string' && a.path.length > 0))
})

test('未登记方块必须抛错（不猜 id）', () => {
  const bad = { ...byId['glass-seam'], blocks: [{ block: 'no-such-block', at: [0, 0, 0] }] }
  assert.throws(() => caseForScene(bad, planForScene(bad)), /未登记的方块/)
})

test('方块库可读且条目唯一', () => {
  const blocks = loadBlocks()
  assert.ok(blocks.size >= 10)
  assert.equal(blocks.get('glass').registryId, 'minecraft:glass')
})
