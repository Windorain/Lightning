#!/usr/bin/env node
/**
 * 截图证据链归档（§6「验收报告要逐条映射」里"截图证据链归档目录约定"的落点）。
 *
 * 约定（报告里以 `screenshots.convention` 原样带出）：
 *   · playwright spec 的截图落 `web/e2e/screenshots/**`（两端 device 各一份，文件名自带 variant 键）；
 *   · playwright 的 trace/失败截图落 `web/test-results/**`；
 *   · 本工具按 **mtime ≥ 本阶段起始时刻** 挑出本次运行新产出的文件，**保持仓库相对路径**镜像到
 *     `<run>/screenshots/`，并写 `manifest.json`（路径 / 字节 / SHA-256 / 归属阶段 / 是否真实位图）。
 *   · 只归档"本次运行产生"的文件 —— 陈旧截图会污染证据链。
 *
 * 用法：
 *   node scripts/acceptance/screenshots.mjs archive --run-dir <run> --since <epochMs> [--label web-real-acceptance]
 * 退出码：0 = 归档完成；2 = 运行目录不可用。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

import { ensureDir, listFiles, rel, REPO_ROOT, sha256File, writeJson } from './lib/evidence.mjs'

const DEFAULT_DIRS = ['web/e2e/screenshots', 'web/test-results', 'web/test-artifacts']

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const [k, v] = a.includes('=') ? a.slice(2).split(/=(.*)/s) : [a.slice(2), undefined]
    if (v !== undefined) out[k] = v
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i]
    else out[k] = true
  }
  return out
}

/** PNG/GIF/JPEG 头部合法性（"截图不得全黑/全空"之外的**基础格式**断言）。 */
function pngInfo(file) {
  const buf = fs.readFileSync(file)
  if (buf.length < 24) return { valid: false, reason: 'too-short' }
  const sig = buf.slice(0, 8).toString('hex')
  if (sig !== '89504e470d0a1a0a') return { valid: false, reason: 'not-png' }
  return { valid: true, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._?.[0] ?? process.argv[2]
  void cmd
  const runDir = path.resolve(args['run-dir'] ?? path.join(REPO_ROOT, 'scripts/acceptance/.out/acceptance-latest'))
  if (!fs.existsSync(runDir)) {
    console.error(`运行目录不存在：${runDir}`)
    process.exit(2)
  }
  const since = Number(args.since ?? 0)
  const label = String(args.label ?? 'web')
  const dirs = args.dirs ? String(args.dirs).split(',').map((d) => path.resolve(d.trim())) : DEFAULT_DIRS.map((d) => path.join(REPO_ROOT, d))
  const destRoot = ensureDir(path.join(runDir, 'screenshots'))

  const files = []
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    for (const f of listFiles(dir)) {
      const st = fs.statSync(f)
      if (st.mtimeMs + 1 < since) continue
      files.push({ abs: f, mtimeMs: st.mtimeMs })
    }
  }
  files.sort((a, b) => a.abs.localeCompare(b.abs))

  const entries = []
  for (const { abs, mtimeMs } of files) {
    const r = rel(abs)
    const dst = path.join(destRoot, r)
    ensureDir(path.dirname(dst))
    fs.copyFileSync(abs, dst)
    const isPng = abs.toLowerCase().endsWith('.png')
    const info = isPng ? pngInfo(abs) : null
    entries.push({
      source: r,
      archived: rel(dst),
      bytes: fs.statSync(abs).size,
      sha256: sha256File(abs),
      mtimeMs: Math.round(mtimeMs),
      stage: label,
      kind: isPng ? 'png' : path.extname(abs).replace('.', '') || 'other',
      png: info,
    })
  }

  const manifest = {
    schema: 'lightning.acceptance.screenshots/1',
    generatedAt: new Date().toISOString(),
    convention:
      'playwright 截图 → web/e2e/screenshots/**（双 device，文件名含 variant 键）；playwright 失败现场 → web/test-results/**；' +
      '本工具按 mtime ≥ 阶段起始时刻挑选并保持仓库相对路径镜像到 <run>/screenshots/**，逐文件记 SHA-256；' +
      '像素级断言（非全黑/相邻等级有差异）由 multiblock-real-acceptance spec 承担，本清单是其**证据链归档**。',
    since,
    label,
    scannedDirs: dirs.map((d) => rel(d)),
    count: entries.length,
    bytes: entries.reduce((s, e) => s + e.bytes, 0),
    byStage: { [label]: entries.length },
    invalidPng: entries.filter((e) => e.kind === 'png' && e.png && !e.png.valid).map((e) => e.source),
    entries,
  }
  writeJson(path.join(destRoot, 'manifest.json'), manifest)
  console.log(`[shots] 归档 ${manifest.count} 个文件（${manifest.bytes} B）→ ${rel(destRoot)}`)
  if (manifest.invalidPng.length > 0) console.log(`[shots] !! 非法 PNG：${manifest.invalidPng.join(', ')}`)
  process.exit(0)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) main()

