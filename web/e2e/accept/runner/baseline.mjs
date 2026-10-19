#!/usr/bin/env node
/**
 * 基线登记（棘轮）：把一对确定过的图 + 判据报告 + 输入哈希写进 `baselines/`。
 *
 * 规则：基线只增不减；同一路径再次登记必须显式 `--force`，并在提交说明里写原因。
 * 哈希覆盖：两侧图、报告、场景定义、判据定义、**本批次运行清单（runId/sha256）**。
 *
 * `--run` 必填：基线必须能追溯到**哪一次运行**；截图 sha256 与清单不符直接拒绝
 * （历史图顶替同一路径会被挡在这里，不靠人记得）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = process.env.ACCEPT_ROOT ? path.resolve(process.env.ACCEPT_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

function main() {
  const args = process.argv.slice(2)
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null }
  const scene = get('--scene'); const camera = get('--camera')
  const game = get('--game'); const web = get('--web'); const report = get('--report'); const runPath = get('--run')
  if (!scene || !camera || !game || !web || !runPath) {
    console.error('用法：node runner/baseline.mjs --run <run.json> --scene <id> --camera <name> --game <png> --web <png> [--report <json>] [--force]')
    process.exit(2)
  }
  const run = JSON.parse(fs.readFileSync(runPath, 'utf8'))
  if (run.scene !== scene) {
    console.error('运行清单场景=' + run.scene + ' 与 --scene ' + scene + ' 不一致')
    process.exit(1)
  }
  const wantShot = run.shots?.[camera]?.sha256
  if (!wantShot) { console.error('运行清单缺机位 ' + camera + ' 的截图'); process.exit(1) }
  const gotShot = sha(game)
  if (gotShot !== wantShot) {
    console.error('截图与运行清单不一致（game=' + gotShot.slice(0, 12) + '… 清单=' + wantShot.slice(0, 12) + '…）：拒绝登记历史图')
    process.exit(1)
  }

  const dir = path.join(ROOT, 'baselines', scene, camera)
  if (fs.existsSync(dir) && !args.includes('--force')) {
    console.error('基线已存在：' + dir + '（要改请显式 --force 并写明原因）')
    process.exit(1)
  }
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(game, path.join(dir, 'game.png'))
  fs.copyFileSync(web, path.join(dir, 'web.png'))
  if (report) fs.copyFileSync(report, path.join(dir, 'report.json'))

  const manifestPath = path.join(ROOT, 'baselines', scene, 'manifest.json')
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { scene, cameras: {} }
  const entry = {
    camera,
    registeredAt: new Date().toISOString(),
    run: { runId: run.runId, manifestSha256: run.manifestSha256, exportSha256: run.export?.sha256 ?? null },
    sha256: {
      game: sha(path.join(dir, 'game.png')),
      web: sha(path.join(dir, 'web.png')),
      ...(report ? { report: sha(path.join(dir, 'report.json')) } : {}),
      ...(fs.existsSync(path.join(ROOT, 'scenes', scene + '.json')) ? { scene: sha(path.join(ROOT, 'scenes', scene + '.json')) } : {}),
      ...(fs.existsSync(path.join(ROOT, 'expect', scene + '.json')) ? { expect: sha(path.join(ROOT, 'expect', scene + '.json')) } : {}),
    },
  }
  manifest.cameras[camera] = entry
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  console.log('[baseline] 登记 ' + scene + '/' + camera + ' ← run ' + run.runId)
  console.log(JSON.stringify(entry.sha256, null, 2))
}

main()
