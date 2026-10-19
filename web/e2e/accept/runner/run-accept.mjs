#!/usr/bin/env node
/**
 * 一次批次的端到端驱动（真端到端纪律的执行入口）。
 *
 * 顺序固定，任何一步失败都**不会**让后面的步骤拿旧产物顶上：
 *   1. batch --submit：现场搭世界 → 导出 → 按机位实拍 → 逐件复核 sha256 → 落 run.json
 *   2. Web 侧复渲：**只用本批次的导出件**（ACCEPT_DOC = run.export.path），机位来自 plan
 *   3. 判据：judge 必带 --run/--doc，来源对不上直接 blocked
 *   4. 汇总：每场景每机位 pass/fail/blocked + 数值，落 summary.json
 *
 * 用法：
 *   node e2e/accept/runner/run-accept.mjs --out <dir> [--scenes a,b] [--mc-dir <run/client>]
 *                                        [--no-submit]   # 复用已提交的 run（调试用，仍走 sha 闸门）
 *                                        [--baseline]    # 判定通过后登记棘轮基线
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ROOT, DEFAULT_MC_DIR, loadScenes } from './batch.mjs'
import { planForScene } from './camera-plan.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = path.resolve(ROOT, '..', '..')
const PY = process.env.ACCEPT_PYTHON || 'python'

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: 'inherit', ...opts })
  if (r.error) throw r.error
  return r.status ?? 1
}

function arg(name, dflt = null) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : dflt
}

function main() {
  const outDir = path.resolve(arg('--out', path.join(ROOT, '..', '..', '..', 'temp', 'accept-run')))
  const ids = arg('--scenes') ? arg('--scenes').split(',') : null
  const mcDir = path.resolve(arg('--mc-dir', DEFAULT_MC_DIR))
  const skipSubmit = process.argv.includes('--no-submit')
  const doBaseline = process.argv.includes('--baseline')
  const port = process.env.PLAYWRIGHT_PORT || '5213'
  fs.mkdirSync(outDir, { recursive: true })

  const scenes = loadScenes(ROOT, ids)
  if (scenes.length === 0) { console.error('没有匹配场景'); process.exit(2) }

  if (!skipSubmit) {
    const args = [path.join(HERE, 'batch.mjs'), '--submit', '--out', outDir, '--mc-dir', mcDir]
    if (ids) args.push('--scenes', ids.join(','))
    const code = sh(process.execPath, args)
    if (code !== 0) { console.error('[accept] 批次提交失败，退出码 ' + code + '（不进入渲染/判定）'); process.exit(code) }
  }

  const summary = { startedAt: new Date().toISOString(), mcDir, port, scenes: [] }

  for (const scene of scenes) {
    const plan = path.join(outDir, scene.id + '.plan.json')
    const runPath = path.join(outDir, 'runs', scene.id + '.run.json')
    if (!fs.existsSync(runPath)) { console.error('[accept] 缺运行清单：' + runPath); process.exit(3) }
    const run = JSON.parse(fs.readFileSync(runPath, 'utf8'))
    if (run.scene !== scene.id) { console.error('[accept] 运行清单场景不符：' + run.scene); process.exit(3) }

    const webOut = path.join(outDir, 'web', scene.id)
    const code = sh(process.execPath, [
      path.join(WEB_ROOT, 'node_modules', 'playwright', 'cli.js'), 'test',
      '--config=playwright.accept.config.ts',
      'e2e/accept/renderer/replay.spec.ts', '--project=accept-replay', '--workers=1',
      '--reporter=line',
    ], {
      cwd: WEB_ROOT,
      env: { ...process.env, PLAYWRIGHT_PORT: port, ACCEPT_PLAN: plan, ACCEPT_DOC: run.export.path, ACCEPT_OUT: webOut },
    })
    const metaPath = path.join(webOut, 'shot-meta.json')
    const sceneReport = { scene: scene.id, runId: run.runId, export: run.export.path, webRenderExit: code, cameras: {} }
    if (!fs.existsSync(metaPath)) {
      sceneReport.verdict = 'blocked'
      sceneReport.reason = 'Web 复渲未产出 shot-meta.json（退出码 ' + code + '）'
      summary.scenes.push(sceneReport)
      continue
    }
    for (const cam of planForScene(scene).cameras.map((c) => c.name)) {
      const shot = run.shots[cam]
      if (!shot) { sceneReport.cameras[cam] = { verdict: 'blocked', reason: '运行清单缺该机位截图' }; continue }
      const reportPath = path.join(outDir, 'reports', scene.id, cam + '.json')
      fs.mkdirSync(path.dirname(reportPath), { recursive: true })
      const jcode = sh(PY, [
        path.join(ROOT, 'verify', 'judge.py'),
        '--scene', path.join(ROOT, 'scenes', scene.id + '.json'),
        '--expect', path.join(ROOT, 'expect', scene.id + '.json'),
        '--plan', plan, '--camera', cam,
        '--game', shot.path,
        '--web', path.join(webOut, cam + '.png'),
        '--shot-meta', metaPath,
        '--run', runPath,
        '--doc', run.export.path,
        '--out', reportPath,
      ], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
      let rep = null
      try { rep = JSON.parse(fs.readFileSync(reportPath, 'utf8')) } catch { rep = null }
      sceneReport.cameras[cam] = rep
        ? { verdict: rep.verdict, counts: rep.counts, content_ratio: rep.content_ratio, judgeExit: jcode }
        : { verdict: 'blocked', reason: '判据执行器无输出（退出码 ' + jcode + '）' }
      if (doBaseline && rep && rep.verdict === 'pass') {
        sh(process.execPath, [
          path.join(HERE, 'baseline.mjs'), '--run', runPath, '--scene', scene.id, '--camera', cam,
          '--game', shot.path, '--web', path.join(webOut, cam + '.png'), '--report', reportPath,
        ])
      }
    }
    const verdicts = Object.values(sceneReport.cameras).map((c) => c?.verdict ?? 'blocked')
    sceneReport.verdict = verdicts.includes('fail') ? 'fail' : verdicts.includes('blocked') ? 'blocked' : 'pass'
    summary.scenes.push(sceneReport)
    console.log('[accept]', scene.id, '→', sceneReport.verdict, JSON.stringify(Object.fromEntries(Object.entries(sceneReport.cameras).map(([k, v]) => [k, v?.verdict]))))
  }

  summary.finishedAt = new Date().toISOString()
  summary.verdict = summary.scenes.some((s) => s.verdict === 'fail') ? 'fail'
    : summary.scenes.some((s) => s.verdict === 'blocked') ? 'blocked' : 'pass'
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8')
  console.log('[accept] 总判定：' + summary.verdict + ' → ' + path.join(outDir, 'summary.json'))
  process.exit(summary.verdict === 'pass' ? 0 : 1)
}

main()
