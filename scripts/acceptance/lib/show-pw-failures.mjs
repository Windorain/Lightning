import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * 诊断工具：从 playwright json 报告抽失败用例与错误消息。
 *   node scripts/acceptance/lib/show-pw-failures.mjs <playwright.json>
 */

export function showFailures(reportPath) {
  const j = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  const out = []
  function walk(suite, file) {
    const f = suite.file ?? file ?? null
    for (const spec of suite.specs ?? []) {
      if (spec.ok) continue
      const sf = spec.file ?? f
      const results = (spec.tests ?? []).flatMap((t) => t.results ?? [])
      const errs = results.map((r) => r.error?.message ?? r.errors?.map((e) => e.message).join('\n')).filter(Boolean)
      out.push({ file: sf, title: spec.title, project: (spec.tests ?? []).map((t) => t.projectName).join(','), errors: errs })
    }
    for (const s of suite.suites ?? []) walk(s, f)
  }
  for (const s of j.suites ?? []) walk(s, null)
  for (const e of out) {
    console.log(`\n=== ${e.project} :: ${e.file}\n    ${e.title}`)
    for (const msg of e.errors) console.log('    ' + String(msg).split('\n').slice(0, 14).join('\n    '))
  }
  console.log(`\nfailed specs: ${out.length}`)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) showFailures(process.argv[2])
