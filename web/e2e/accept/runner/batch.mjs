#!/usr/bin/env node
/**
 * 批次执行器：把**场景定义**翻成控制面用例，并（可选）提交给**常驻客户端**。
 *
 * 两种模式：
 *   --emit   只产出用例 JSON + 机位计划 + manifest（无需客户端，可在 CI 里跑）
 *   --submit 逐个作业提交到 CP 的 HTTP 服务（同一客户端进程内串行，不重启），
 *            作业跑完后从 run 目录**实读产物**、逐件复核 sha256，落运行清单 run.json
 *
 * 客户端是常驻服务：一个批次 = 同一进程内的多个作业；单个作业失败只算该场景红。
 * 端口从 `<mc-dir>/controlplane/server.json` 读，永不假设。
 *
 * 端到端纪律：run.json 是本批次的**唯一交付凭据**——判据只认清单里登记的图与导出件，
 * 历史文件即使放进同一路径也会因 sha256 不符被拒（judge.py 的端到端闸门）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { planForScene } from './camera-plan.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..')
export const DEFAULT_MC_DIR = path.resolve(ROOT, '..', '..', '..', 'mod', 'gtnh', 'run', 'client')

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

/** 场景 → 控制面用例（纯函数，便于单测）。 */
export function caseForScene(scene, plan) {
  const o = scene.world.origin
  const min = [0, 1, 2].map((i) => Math.min(...scene.blocks.map((b) => b.at[i])) + o[i])
  const max = [0, 1, 2].map((i) => Math.max(...scene.blocks.map((b) => b.at[i])) + o[i])
  const clearFrom = [min[0] - 2, min[1] - 2, min[2] - 2]
  const clearTo = [max[0] + 2, max[1] + 2, max[2] + 2]

  const build = [{ op: 'clear', from: clearFrom, to: clearTo }]
  for (const b of scene.blocks) {
    build.push({ op: 'block', at: [o[0] + b.at[0], o[1] + b.at[1], o[2] + b.at[2]], id: blockOf(b, scene), meta: metaOf(b, scene) })
  }

  // 导出前置：选区 → 两角 → 起点 → 帧号 → 录制（缺一步 export.scene 会报「帧缓冲为空」）
  const action = [
    { action: 'cmd.exec', params: { command: '/sde sel cuboid' } },
    { action: 'cmd.exec', params: { command: `/sde pos1 ${clearFrom[0]} ${clearFrom[1]} ${clearFrom[2]}` } },
    { action: 'cmd.exec', params: { command: `/sde pos2 ${clearTo[0]} ${clearTo[1]} ${clearTo[2]}` } },
    { action: 'cmd.exec', params: { command: '/sde start' } },
    { action: 'cmd.exec', params: { command: '/sde setframe 0' } },
    { action: 'cmd.exec', params: { command: '/sde record' } },
  ].map((a, i) => ({ ...a, path: `action/${i}-${a.action}.json` }))

  const cameras = plan.cameras.map((c) => ({
    name: c.name,
    pos: c.game.pos,
    yaw: c.game.yaw,
    pitch: c.game.pitch,
    projection: { type: 'ortho', orthoHeight: c.game.orthoHeight },
    resolution: c.game.resolution,
  }))

  return {
    schema: 'lightning.controlplane.case/1',
    id: 'accept-' + scene.id,
    label: '验收：' + scene.title,
    world: { folder: 'cp_accept_' + scene.id.replace(/-/g, '_'), seed: 20261019, void: true, base: o, settleTicks: 60 },
    build,
    export: [{ action: 'export.scene', params: { name: scene.export.name, shape: scene.export.shape } }],
    cameras,
    action,
  }
}

/** 方块库（id → registryId/meta）；缺库直接抛错，绝不猜。 */
export function loadBlocks(root = ROOT) {
  const doc = JSON.parse(fs.readFileSync(path.join(root, 'blocks', 'blocks.json'), 'utf8'))
  const map = new Map()
  for (const b of doc.blocks) map.set(b.id, b)
  return map
}

function blockOf(b, scene, blocks = loadBlocks()) {
  const e = blocks.get(b.block)
  if (!e) throw new Error(`场景 ${scene.id} 引用了未登记的方块：${b.block}`)
  return e.registryId
}
function metaOf(b, scene, blocks = loadBlocks()) {
  const e = blocks.get(b.block)
  if (!e) throw new Error(`场景 ${scene.id} 引用了未登记的方块：${b.block}`)
  return e.meta ?? 0
}

export function loadScenes(root = ROOT, ids = null) {
  const dir = path.join(root, 'scenes')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  return files
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter((s) => ids === null || ids.includes(s.id))
}

export function readServerPort(mcDir) {
  const p = path.join(mcDir, 'controlplane', 'server.json')
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'))
  if (typeof doc.port !== 'number') throw new Error('server.json 缺 port：' + p)
  return doc.port
}

function readToken(mcDir, kind = 'scene') {
  const p = path.join(mcDir, 'controlplane', 'tokens.json')
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'))
  const token = doc.tokens?.[kind]
  if (typeof token !== 'string' || token === '') throw new Error('tokens.json 缺 tokens.' + kind)
  return token
}

export async function submitCase(mcDir, caseDoc, outPath) {
  const port = readServerPort(mcDir)
  const token = readToken(mcDir, 'scene')
  const url = `http://127.0.0.1:${port}/cp/v1/cases`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(caseDoc),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`提交失败 ${res.status}：${text.slice(0, 400)}`)
  const doc = JSON.parse(text)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  return doc
}

/** cp 的 run 目录：`<mc-dir>/controlplane/runs/<runId>/`。 */
export function runsDirOf(mcDir) {
  return path.join(mcDir, 'controlplane', 'runs')
}

export function listRunIds(mcDir) {
  try { return fs.readdirSync(runsDirOf(mcDir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) }
  catch { return [] }
}

/** 运行清单 → 交付记录（纯函数：输入 manifest 原文 + 目录，输出 run.json 内容，不读盘）。 */
export function runRecordFor({ scene, runId, caseId, runDir, manifest, manifestSha256 }) {
  const shots = {}
  let exportArtifact = null
  for (const a of manifest.artifacts ?? []) {
    const abs = path.join(runDir, a.path)
    if (a.role === 'shot') shots[path.basename(a.path, '.png')] = { path: abs, sha256: a.sha256, bytes: a.bytes }
    else if (a.role === 'scene-export') exportArtifact = { path: abs, sha256: a.sha256, bytes: a.bytes }
  }
  if (Object.keys(shots).length === 0) throw new Error('运行清单没有截图（shot）产物：' + runId)
  if (exportArtifact === null) throw new Error('运行清单没有导出件（scene-export）：' + runId)
  return {
    schema: 'lightning.accept.run/1',
    scene,
    caseId,
    runId,
    runDir,
    startedAt: manifest.createdAt ?? null,
    shots,
    export: exportArtifact,
    manifestSha256,
  }
}

/** 逐件复核：清单里每件的字节与 sha256 必须与磁盘一致（缺件/被替换立刻失败）。 */
export function verifyArtifacts(runDir, manifest) {
  const bad = []
  for (const a of manifest.artifacts ?? []) {
    const abs = path.join(runDir, a.path)
    if (!fs.existsSync(abs)) { bad.push(a.path + '：缺失'); continue }
    const bytes = fs.statSync(abs).size
    if (a.bytes != null && bytes !== a.bytes) bad.push(a.path + `：字节 ${bytes} ≠ 清单 ${a.bytes}`)
    if (a.sha256 && sha256(abs) !== a.sha256) bad.push(a.path + '：sha256 不符')
  }
  if (bad.length) throw new Error('运行产物校验失败：\n  ' + bad.join('\n  '))
  return true
}

/** 等本次提交对应的 run 落盘并稳定（manifest 可解析 + 含截图/导出件 + 两次轮询不变）。 */
export async function waitForRun(mcDir, caseId, { before = [], timeoutMs = 20 * 60 * 1000, pollMs = 3000, now = () => Date.now() } = {}) {
  const deadline = now() + timeoutMs
  const seen = new Map()
  for (;;) {
    for (const id of listRunIds(mcDir)) {
      if (before.includes(id)) continue
      const runDir = path.join(runsDirOf(mcDir), id)
      const mf = path.join(runDir, 'manifest.json')
      if (!fs.existsSync(mf)) continue
      let stable
      try { stable = fs.statSync(mf).mtimeMs } catch { continue }
      const prev = seen.get(id)
      if (prev === undefined) { seen.set(id, stable); continue }
      if (prev !== stable) { seen.set(id, stable); continue }   // 还在写
      let manifest
      try { manifest = JSON.parse(fs.readFileSync(mf, 'utf8')) } catch { continue }
      if (manifest.caseId !== caseId) continue
      const roles = new Set((manifest.artifacts ?? []).map((a) => a.role))
      if (!roles.has('shot') || !roles.has('scene-export')) continue
      return { runId: id, runDir, manifest, manifestSha256: sha256(mf) }
    }
    if (now() > deadline) throw new Error('等运行超时（' + Math.round(timeoutMs / 1000) + 's）：caseId=' + caseId)
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const get = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
  const outDir = get('--out', path.join(ROOT, '..', '..', '..', 'temp', 'accept-cases'))
  const ids = get('--scenes') ? get('--scenes').split(',') : null
  const submit = args.includes('--submit')
  const mcDir = get('--mc-dir', DEFAULT_MC_DIR)
  const scenes = loadScenes(ROOT, ids)
  if (scenes.length === 0) { console.error('没有匹配的场景'); process.exit(2) }
  fs.mkdirSync(outDir, { recursive: true })
  const manifest = { generatedAt: new Date().toISOString(), mcDir, scenes: [] }
  for (const scene of scenes) {
    const plan = planForScene(scene)
    const c = caseForScene(scene, plan)
    fs.writeFileSync(path.join(outDir, c.id + '.case.json'), JSON.stringify(c, null, 2) + '\n', 'utf8')
    fs.writeFileSync(path.join(outDir, scene.id + '.plan.json'), JSON.stringify(plan, null, 2) + '\n', 'utf8')
    let run = null
    if (submit) {
      const before = listRunIds(mcDir)
      const submitted = await submitCase(mcDir, c, path.join(outDir, scene.id + '.submit.json'))
      const found = await waitForRun(mcDir, c.id, { before })
      verifyArtifacts(found.runDir, found.manifest)
      run = runRecordFor({ scene: scene.id, runId: found.runId, caseId: c.id, runDir: found.runDir, manifest: found.manifest, manifestSha256: found.manifestSha256 })
      fs.mkdirSync(path.join(outDir, 'runs'), { recursive: true })
      fs.writeFileSync(path.join(outDir, 'runs', scene.id + '.run.json'), JSON.stringify(run, null, 2) + '\n', 'utf8')
      manifest.scenes.push({ scene: scene.id, case: c.id, cameras: c.cameras.length, blocks: scene.blocks.length, submitted, runId: run.runId, run: path.join(outDir, 'runs', scene.id + '.run.json') })
      console.log('[batch]', scene.id, 'run=' + run.runId, 'shots=' + Object.keys(run.shots).length, 'export=' + run.export.path)
      continue
    }
    manifest.scenes.push({ scene: scene.id, case: c.id, cameras: c.cameras.length, blocks: scene.blocks.length, submitted: null })
    console.log('[batch]', scene.id, 'cameras=' + c.cameras.length, 'blocks=' + scene.blocks.length, 'emitted')
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  console.log('[batch] 产物：' + outDir)
}
