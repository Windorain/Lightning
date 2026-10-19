#!/usr/bin/env node
/**
 * 基线登记（棘轮）：把一对确定过的图 + 判据报告 + 输入哈希写进 `baselines/`。
 *
 * 规则：基线只增不减；同一路径再次登记必须显式 `--force`，并在提交说明里写原因。
 * 哈希覆盖：两侧图、报告、场景定义、判据定义、机位计划 —— 任一变化都能一眼看出。
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
  const game = get('--game'); const web = get('--web'); const report = get('--report')
  if (!scene || !camera || !game || !web) {
    console.error('用法：node runner/baseline.mjs --scene <id> --camera <name> --game <png> --web <png> [--report <json>] [--force]')
    process.exit(2)
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
  console.log('[baseline] 登记 ' + scene + '/' + camera)
  console.log(JSON.stringify(entry.sha256, null, 2))
}

main()
