import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * 诊断工具：逐条打印某清单项的 **gates**（定位"为什么红"）。
 *   node scripts/acceptance/lib/show-gates.mjs <report.json> [checkId…]
 */

export function showGates(reportPath, ids = []) {
  const j = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  for (const c of j.checks) {
    if (ids.length > 0 && !ids.includes(c.id)) continue
    console.log(`\n=== ${c.id} [${c.status}] ${c.detail ?? ''}`)
    for (const g of c.gates ?? []) console.log(`   ${g.ok ? 'OK ' : 'XX '} ${g.name}${g.detail ? ` :: ${g.detail}` : ''}`)
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) showGates(process.argv[2], process.argv.slice(3))
