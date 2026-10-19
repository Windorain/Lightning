#!/usr/bin/env node
/**
 * 批次执行器：把**场景定义**翻成控制面用例，并（可选）提交给**常驻客户端**。
 *
 * 两种模式：
 *   --emit   只产出用例 JSON + 机位计划 + manifest（无需客户端，可在 CI 里跑）
 *   --submit 逐个用例提交到 CP（`POST /cp/v1/actions/case.run`，同一客户端进程内串行，不重启），
 *            作业完成后**实读** run 目录、逐件复核字节与 sha256，落运行清单 run.json
 *
 * 契约事实（以 docs/control-plane 为准，不猜）：
 *   - 用例 schema 是 `lightning.case/1`，`criteria` 与 `evidence` 必填；
 *   - 提交端点 `POST /cp/v1/actions/case.run`，参数 `{inline, confirm:true, totalTimeoutMs}`；
 *   - 含 `cameras` 段的用例按内容升格为 forensic ⇒ 必须用 forensic token；
 *   - 产物落 `<mcDataDir>/controlplane/runs/<runId>/`，清单 `manifest.json`（逐件 sha256）。
 *
 * 端到端纪律：run.json 是本批次的**唯一交付凭据**——判据只认清单里登记的图与导出件，
 * 历史文件即使放进同一路径也会因 sha256 不符被拒（judge.py 的端到端闸门）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { planForScene } from './camera-plan.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..')
export const DEFAULT_MC_DIR = path.resolve(ROOT, '..', '..', '..', 'mod', 'gtnh', 'run', 'client')

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

/**
 * 场景 → 选区（导出扫描区）：内容 bbox 各向外扩 1 格。
 *
 * 导出件的网格 = 这个选区，Web 侧的世界→局部映射以它为准（sceneFrame），
 * 所以它必须与场景定义机械对应——不准靠"记得选对范围"。
 */
export function selectionFor(scene) {
  const o = scene.world.origin
  const min = [0, 1, 2].map((i) => Math.min(...scene.blocks.map((b) => b.at[i])) + o[i])
  const max = [0, 1, 2].map((i) => Math.max(...scene.blocks.map((b) => b.at[i])) + o[i])
  return {
    from: [min[0] - 1, min[1] - 1, min[2] - 1],
    to: [max[0] + 1, max[1] + 1, max[2] + 1],
    clearFrom: [min[0] - 2, min[1] - 2, min[2] - 2],
    clearTo: [max[0] + 2, max[1] + 2, max[2] + 2],
    size: [max[0] + 1 - (min[0] - 1) + 1, max[1] + 1 - (min[1] - 1) + 1, max[2] + 1 - (min[2] - 1) + 1],
  }
}

/** 场景 → 控制面用例（纯函数，便于单测）。 */
export function caseForScene(scene, plan) {
  const o = scene.world.origin
  const sel = selectionFor(scene)
  const clearFrom = sel.clearFrom
  const clearTo = sel.clearTo

  const build = [{ op: 'clear', from: clearFrom, to: clearTo }]
  for (const b of scene.blocks) {
    build.push({ op: 'block', at: [o[0] + b.at[0], o[1] + b.at[1], o[2] + b.at[2]], id: blockOf(b, scene), meta: metaOf(b, scene) })
  }

  // 导出前置：站位 → 选区 → 起点 → 帧号 → 录制（缺一步 export.scene 会报「帧缓冲为空」）
  // `/sde pos1|pos2` **不接受坐标**（与 WorldEdit //pos1 一致，取玩家脚下方块）——实测传坐标会被静默忽略、
  // 两角都记成玩家所在格 ⇒ 导出网格退化成 1×1×1。故先 `scene.player.pose` 站到角点（allowFlying 默认开，
  // 全虚空世界不会坠落），再发命令。
  const footAt = (c) => [c[0] + 0.5, c[1], c[2] + 0.5]
  const action = [
    { action: 'scene.player.pose', params: { pos: footAt(sel.from), yaw: 0, pitch: 0 } },
    { action: 'cmd.exec', params: { command: '/sde sel cuboid' } },
    { action: 'cmd.exec', params: { command: '/sde pos1' } },
    { action: 'scene.player.pose', params: { pos: footAt(sel.to), yaw: 0, pitch: 0 } },
    { action: 'cmd.exec', params: { command: '/sde pos2' } },
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

  const [W, H] = scene.cameras.resolution
  // 游戏侧自检（不替代配对判定）：每张图必须存在、尺寸正确、非纯色——先排掉"没拍出来"的假证据。
  const criteria = [
    { id: 'export-exists', type: 'artifact-exists', params: { path: `export/${scene.export.name}.json` } },
    { id: 'export-nonempty', type: 'artifact-nonempty', params: { path: `export/${scene.export.name}.json`, minBytes: 256 } },
  ]
  for (const c of cameras) {
    criteria.push({ id: `shot-size-${c.name}`, type: 'image-size-equals', params: { path: `shots/${c.name}.png`, width: W, height: H } })
    criteria.push({ id: `shot-content-${c.name}`, type: 'image-not-uniform', params: { path: `shots/${c.name}.png`, maxSameColorRatio: 0.98 } })
  }

  return {
    schema: 'lightning.case/1',
    id: 'accept-' + scene.id,
    label: '验收：' + scene.title,
    world: { folder: 'cp_accept_' + scene.id.replace(/-/g, '_'), seed: 20261019, void: true, base: o, settleTicks: 60 },
    capture: { lighting: 'natural', renderMode: '本色', worldTime: scene.world.time },
    build,
    action,
    export: [{ action: 'export.scene', params: { name: scene.export.name, shape: scene.export.shape, frames: 'all' } }],
    cameras,
    criteria,
    evidence: {
      expect: [
        { path: 'observation.json', role: 'observation' },
        { path: 'criteria.json', role: 'criteria' },
        { path: `export/${scene.export.name}.json`, role: 'scene-export' },
      ],
    },
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

function readToken(mcDir, kind = 'forensic') {
  const p = path.join(mcDir, 'controlplane', 'tokens.json')
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'))
  const token = doc.tokens?.[kind]
  if (typeof token !== 'string' || token === '') throw new Error('tokens.json 缺 tokens.' + kind)
  return token
}

function cpUrl(mcDir, suffix) {
  return `http://127.0.0.1:${readServerPort(mcDir)}/cp/v1${suffix}`
}

async function cpCall(mcDir, suffix, init = {}, kind = 'forensic') {
  const res = await fetch(cpUrl(mcDir, suffix), {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + readToken(mcDir, kind), ...(init.headers ?? {}) },
  })
  const text = await res.text()
  let doc
  try { doc = JSON.parse(text) } catch { throw new Error(`CP 返回非 JSON（${res.status}）：${text.slice(0, 300)}`) }
  if (!res.ok || doc.ok === false) {
    const err = doc.error ?? {}
    throw new Error(`CP ${suffix} 失败 ${res.status} ${err.code ?? ''}：${err.message ?? text.slice(0, 300)}`)
  }
  return doc.data ?? doc
}

/** 提交并等作业结束（CP 默认异步：先拿 jobId，再轮询 jobs）。 */
export async function submitCaseRun(mcDir, caseDoc, { timeoutMs = 20 * 60 * 1000, pollMs = 1500, now = () => Date.now() } = {}) {
  const submitted = await cpCall(mcDir, '/actions/case.run', {
    method: 'POST',
    body: JSON.stringify({ inline: caseDoc, confirm: true, totalTimeoutMs: timeoutMs }),
  })
  const jobId = submitted.jobId
  if (!jobId) throw new Error('case.run 未返回 jobId：' + JSON.stringify(submitted).slice(0, 200))
  const deadline = now() + timeoutMs + 60_000
  for (;;) {
    const job = await cpCall(mcDir, '/jobs/' + jobId, {}, 'observe')
    if (job.state === 'done') return { jobId, job, result: job.result ?? null }
    if (job.state === 'failed') throw new Error(`case.run 作业失败 ${job.error?.code ?? ''}：${job.error?.message ?? JSON.stringify(job).slice(0, 300)}`)
    if (now() > deadline) throw new Error('等 case.run 作业超时：' + jobId)
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

/** 读导出件（信封 gzip+base64 则解包），返回内层文档。 */
export function readExportDocument(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (typeof doc.payload === 'string') {
    return { outer: doc, inner: JSON.parse(zlib.gunzipSync(Buffer.from(doc.payload, 'base64')).toString('utf8')) }
  }
  return { outer: doc, inner: doc }
}

/**
 * 导出网格必须等于场景声明的选区（内容 bbox 各外扩 1）。
 *
 * 为什么必须查：`/sde pos1|pos2` 取的是**玩家脚下体素**，站位错一格或命令被忽略时，
 * 导出件会静默变成 1×1×1（实测一次），Web 侧随后按错误网格取景，看起来"渲染不对"而真因在导出。
 * 这里用导出件自带的 provenance.selection 与 cellGrid 两个独立来源交叉核对。
 */
export function verifyExportGrid(runDir, scene) {
  const sel = selectionFor(scene)
  const file = path.join(runDir, 'export', scene.export.name + '.json')
  if (!fs.existsSync(file)) throw new Error('缺导出件：' + file)
  const { outer, inner } = readExportDocument(file)
  const prov = outer?.meta?.provenance?.selection ?? inner?.frames?.[0]?.structure?.provenance?.selection ?? null
  const grid = inner?.frames?.[0]?.structure?.cellGrid
  if (!grid) throw new Error('导出件缺 cellGrid：' + file)
  const dims = [grid[0][0].length, grid[0].length, grid.length]
  const bad = []
  if (dims[0] !== sel.size[0] || dims[1] !== sel.size[1] || dims[2] !== sel.size[2]) {
    bad.push(`网格尺寸 [${dims}] ≠ 选区 [${sel.size}]`)
  }
  if (prov) {
    const min = prov.min ?? null
    const max = prov.max ?? null
    if (min && (min[0] !== sel.from[0] || min[1] !== sel.from[1] || min[2] !== sel.from[2])) {
      bad.push(`选区 min [${min}] ≠ 期望 [${sel.from}]`)
    }
    if (max && (max[0] !== sel.to[0] || max[1] !== sel.to[1] || max[2] !== sel.to[2])) {
      bad.push(`选区 max [${max}] ≠ 期望 [${sel.to}]`)
    }
  }
  if (bad.length) throw new Error('导出网格与场景不符：' + bad.join('；') + '（导出件 ' + file + '）')
  return { dims, selection: prov, file }
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const get = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
  const outDir = get('--out', path.join(ROOT, '..', '..', '..', 'temp', 'accept-cases'))
  const ids = get('--scenes') ? get('--scenes').split(',') : null
  const submit = args.includes('--submit')
  const mcDir = path.resolve(get('--mc-dir', DEFAULT_MC_DIR))
  const scenes = loadScenes(ROOT, ids)
  if (scenes.length === 0) { console.error('没有匹配的场景'); process.exit(2) }
  fs.mkdirSync(outDir, { recursive: true })
  const manifest = { generatedAt: new Date().toISOString(), mcDir, scenes: [] }
  for (const scene of scenes) {
    const plan = planForScene(scene)
    const c = caseForScene(scene, plan)
    fs.writeFileSync(path.join(outDir, c.id + '.case.json'), JSON.stringify(c, null, 2) + '\n', 'utf8')
    fs.writeFileSync(path.join(outDir, scene.id + '.plan.json'), JSON.stringify(plan, null, 2) + '\n', 'utf8')
    if (!submit) {
      manifest.scenes.push({ scene: scene.id, case: c.id, cameras: c.cameras.length, blocks: scene.blocks.length, submitted: null })
      console.log('[batch]', scene.id, 'cameras=' + c.cameras.length, 'blocks=' + scene.blocks.length, 'emitted')
      continue
    }
    const { jobId, result } = await submitCaseRun(mcDir, c)
    const runId = result?.runId
    if (!runId) throw new Error('case.run 结果缺 runId：' + JSON.stringify(result).slice(0, 300))
    const runDir = path.join(mcDir, 'controlplane', 'runs', runId)
    const manifestPath = path.join(runDir, 'manifest.json')
    const cpManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    verifyArtifacts(runDir, cpManifest)
    const grid = verifyExportGrid(runDir, scene)
    const run = runRecordFor({ scene: scene.id, runId, caseId: c.id, runDir, manifest: cpManifest, manifestSha256: sha256(manifestPath) })
    fs.mkdirSync(path.join(outDir, 'runs'), { recursive: true })
    fs.writeFileSync(path.join(outDir, 'runs', scene.id + '.run.json'), JSON.stringify(run, null, 2) + '\n', 'utf8')
    fs.writeFileSync(path.join(outDir, 'runs', scene.id + '.job.json'), JSON.stringify({ jobId, overall: result?.overall ?? null, criteria: result?.criteria ?? null }, null, 2) + '\n', 'utf8')
    manifest.scenes.push({
      scene: scene.id, case: c.id, cameras: c.cameras.length, blocks: scene.blocks.length,
      jobId, runId, overall: result?.overall ?? null,
      run: path.join('runs', scene.id + '.run.json'),
    })
    console.log('[batch]', scene.id, 'run=' + runId, 'shots=' + Object.keys(run.shots).length, 'overall=' + (result?.overall ?? '?'))
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  console.log('[batch] 产物：' + outDir)
}
