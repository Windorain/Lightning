import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { DEFAULT_MC_DIR, caseForScene, loadScenes, loadBlocks, runRecordFor, verifyArtifacts } from './batch.mjs'
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
      assert.equal(W, 1920)
      assert.equal(H, 1080)
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

/** 造一个假的 run 目录，验证运行清单的读取与逐件复核。 */
function fakeRun(tmp, { tamper = null } = {}) {
  const runDir = path.join(tmp, 'runs', '20261019-000000-accept-x-1')
  fs.mkdirSync(path.join(runDir, 'shots'), { recursive: true })
  fs.mkdirSync(path.join(runDir, 'export'), { recursive: true })
  const files = { 'shots/front.png': 'PNG-front', 'export/x.json': '{"a":1}' }
  const artifacts = Object.entries(files).map(([rel, body]) => {
    const abs = path.join(runDir, rel)
    fs.writeFileSync(abs, body, 'utf8')
    return { path: rel, bytes: fs.statSync(abs).size, sha256: crypto.createHash('sha256').update(body).digest('hex'), role: rel.endsWith('.png') ? 'shot' : 'scene-export' }
  })
  const manifest = { schema: 'lightning.cp-manifest/1', runId: '20261019-000000-accept-x-1', caseId: 'accept-x', createdAt: '2026-10-19T00:00:00+08:00', artifacts }
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  if (tamper) fs.writeFileSync(path.join(runDir, tamper), 'EVIL', 'utf8')
  return { runDir, manifest }
}

test('运行清单 → 交付记录：截图与导出件登记绝对路径 + sha256', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-run-'))
  const { runDir, manifest } = fakeRun(tmp)
  const rec = runRecordFor({ scene: 'x', runId: manifest.runId, caseId: 'accept-x', runDir, manifest, manifestSha256: 'deadbeef' })
  assert.equal(rec.schema, 'lightning.accept.run/1')
  assert.deepEqual(Object.keys(rec.shots), ['front'])
  assert.ok(rec.shots.front.path.endsWith('front.png'))
  assert.equal(rec.shots.front.path, path.join(runDir, 'shots', 'front.png'))
  assert.match(rec.shots.front.sha256, /^[0-9a-f]{64}$/)
  assert.ok(rec.export.path.endsWith('x.json'))
  assert.equal(rec.manifestSha256, 'deadbeef')
})

test('产物被替换/缺件必须在复核阶段失败（不靠人记得）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-run-'))
  const clean = fakeRun(tmp)
  assert.equal(verifyArtifacts(clean.runDir, clean.manifest), true)
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-run-'))
  const dirty = fakeRun(tmp2, { tamper: 'shots/front.png' })
  assert.throws(() => verifyArtifacts(dirty.runDir, dirty.manifest), /校验失败/)
})

test('运行清单缺截图或导出件必须抛错', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-run-'))
  const { runDir, manifest } = fakeRun(tmp)
  const noShot = { ...manifest, artifacts: manifest.artifacts.filter((a) => a.role !== 'shot') }
  assert.throws(() => runRecordFor({ scene: 'x', runId: 'r', caseId: 'c', runDir, manifest: noShot, manifestSha256: 'x' }), /没有截图/)
  const noExport = { ...manifest, artifacts: manifest.artifacts.filter((a) => a.role !== 'scene-export') }
  assert.throws(() => runRecordFor({ scene: 'x', runId: 'r', caseId: 'c', runDir, manifest: noExport, manifestSha256: 'x' }), /没有导出件/)
})

test('场景不得复用历史产物：文件名与内容都不许出现 legacy/evidence 痕迹', () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'scenes')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  assert.ok(files.length > 0)
  const banned = /legacy|evidence\/|历史实拍|既有实拍|不是新采集/i
  for (const file of files) {
    const body = fs.readFileSync(path.join(dir, file), 'utf8')
    assert.doesNotMatch(file, /legacy/i, '场景文件名不得带 legacy：' + file)
    assert.doesNotMatch(body, banned, '场景不得引用历史产物：' + file)
  }
})

test('默认客户端目录必须是 mod/gtnh/run/client（仓库布局，不是 gtn）', () => {
  assert.ok(DEFAULT_MC_DIR.endsWith(path.join('mod', 'gtnh', 'run', 'client')), DEFAULT_MC_DIR)
  assert.ok(fs.existsSync(path.join(DEFAULT_MC_DIR, '..', '..', '..')), '仓库 mod/gtnh 目录应存在')
})
