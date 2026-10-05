#!/usr/bin/env node
/**
 * 清单锚点自查（#39 阶段二，独立入口，**不是** 14 阶段之一）：
 * 把 `lib/parts-checklist.mjs` 里全部 `caseSummary(<json>, '<标题片段>')` 锚点，逐一对照
 * 某轮运行目录 `<run>/web/*.json` 的两份 playwright 报告（`l2-real-export.json` /
 * `parts-fixtures.json`），列出**缺失锚点**。
 *
 * 为什么需要它：清单项读 playwright 报告是**按用例标题片段检索**的；用例一旦改名/删除，
 * 检索落空 ⇒ `found=false` ⇒ 该清单项判 `fail`（退出码 9），而失败信息看起来像"断言失败"。
 * `p39-b2-itemindex-r7` 实测：两条清单项因此判红（README finding F10）。
 *
 * 用法：
 *   node scripts/parts-acceptance/check-checklist-anchors.mjs --run-dir <run 目录>
 * 退出码：0 = 全部锚点命中；1 = 有缺失锚点（或报告不可读）。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { parseArgs, REPO_ROOT, rel } from './lib/parts-io.mjs'

/** 清单文件里 `caseSummary(<which>, '<needle>')` 的 which → playwright 报告文件名。 */
const REPORT_OF = {
  l2Real: 'l2-real-export.json',
  partsFixtures: 'parts-fixtures.json',
}

/** 收集 playwright json 报告里全部用例标题（`suite › suite › spec`）。 */
function collectTitles(json) {
  const out = []
  const walk = (suite, trail) => {
    const t = suite.title ? [...trail, suite.title] : trail
    for (const spec of suite.specs ?? []) out.push([...t, spec.title].join(' › '))
    for (const child of suite.suites ?? []) walk(child, t)
  }
  for (const s of json?.suites ?? []) walk(s, [])
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args['run-dir']) {
    console.error('用法：node scripts/parts-acceptance/check-checklist-anchors.mjs --run-dir <run 目录>')
    process.exit(1)
  }
  const runDir = path.resolve(args['run-dir'])
  const webDir = path.join(runDir, 'web')
  const checklistPath = path.join(REPO_ROOT, 'scripts/parts-acceptance/lib/parts-checklist.mjs')
  const source = fs.readFileSync(checklistPath, 'utf8')

  const titles = {}
  for (const [which, file] of Object.entries(REPORT_OF)) {
    const p = path.join(webDir, file)
    titles[which] = fs.existsSync(p) ? collectTitles(JSON.parse(fs.readFileSync(p, 'utf8'))) : null
  }

  const re = /caseSummary\((l2Real|partsFixtures),\s*'([^']+)'\)/g
  const anchors = []
  let m
  while ((m = re.exec(source))) anchors.push({ which: m[1], needle: m[2] })

  const missing = []
  for (const a of anchors) {
    const known = titles[a.which]
    if (!known) {
      missing.push(`[${a.which}] 报告不可读（${rel(path.join(webDir, REPORT_OF[a.which]))}）—— 锚点「${a.needle}」无法判定`)
      continue
    }
    const hits = known.filter((t) => t.includes(a.needle)).length
    console.log(`   ${hits > 0 ? 'OK  ' : 'MISS'} [${a.which}] "${a.needle}" → ${hits} 条`)
    if (hits === 0) missing.push(`[${a.which}] 锚点「${a.needle}」在报告里 0 命中（用例可能已改名/删除）`)
  }

  console.log('')
  if (missing.length > 0) {
    for (const x of missing) console.log(`   XX ${x}`)
    console.log(`[check-checklist-anchors] FAIL —— ${missing.length}/${anchors.length} 个锚点缺失`)
    process.exit(1)
  }
  console.log(`[check-checklist-anchors] PASS —— ${anchors.length} 个锚点全部命中`)
}

main()
