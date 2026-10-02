import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * 诊断工具：打一份 `acceptance-report.json` 的摘要（判定 / 清单逐条 / 阶段 / 曲线 / 开放项）。
 *   node scripts/acceptance/lib/show-report.mjs <report.json>
 */

export function showReport(p) {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'))
  console.log('schema', j.schema, '| label', j.label, '| mode', j.mode)
  console.log('verdict', j.verdict.status, JSON.stringify(j.verdict.counts))
  console.log('checks:')
  for (const c of j.checks) console.log('  ', c.status.padEnd(9), c.id.padEnd(34), (c.detail || '').replace(/\n/g, ' ').slice(0, 140))
  console.log(
    'idempotency:',
    JSON.stringify(
      j.idempotency?.priorRun
        ? { label: j.idempotency.priorRun.label, allSame: j.idempotency.priorRun.allSame, expandedAllSame: j.idempotency.priorRun.expandedAllSame, productsA: j.idempotency.priorRun.productsA }
        : null,
    ),
  )
  if (j.volumeCurve) {
    console.log('volumeCurve verdict:', JSON.stringify(j.volumeCurve.verdict))
    console.log('series:', j.volumeCurve.series.map((s) => `${s.id}:${s.status}(R1=${s.R1.status},R2=${s.R2.status},R3=${s.R3.status})`).join(' '))
    if (j.volumeCurve.risk4) console.log('risk4:', j.volumeCurve.risk4.status, 'worst', j.volumeCurve.risk4.worst?.file, j.volumeCurve.risk4.worst?.paletteShare?.toFixed(3))
  }
  console.log('stages:', j.stages.map((s) => `${s.id}=${s.status}`).join(' '))
  console.log('screenshots:', JSON.stringify(j.screenshots))
  console.log('openItems:', JSON.stringify(j.openItems))
  console.log('evidenceLayout:', JSON.stringify(j.evidenceLayout))
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) showReport(process.argv[2])
