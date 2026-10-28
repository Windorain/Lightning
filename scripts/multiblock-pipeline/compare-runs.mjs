/**
 * 自检 1 —— **两次无人值守导出的产物逐字节一致性**（幂等）机器判据。
 *
 *   node scripts/multiblock-pipeline/compare-runs.mjs <run1>/pipeline-result.json <run2>/pipeline-result.json
 *
 * 比对两份 `pipeline-result.json` 的：
 *   - `products[]`：文件名 → SHA-256（导出产物 `<slug>.multiblock.json`，gzip+base64 信封**全文**哈希）；
 *   - `expanded.filesSha256[]`：文件名 → SHA-256（展开形态校验文件）；
 * 并回显两次运行的总耗时（供 Phase 3 编排预算）。
 *
 * 为什么排除 `_manifest.json` / `pipeline-result.json`：它们**故意**带 `generatedAtEpochMs`
 * 与耗时（审计信息），不符「产物」定义。展开文件本身不含任何时间戳，因此参与逐字节比对。
 *
 * 退出码：0 = 逐字节一致；1 = 有差异；2 = 用法错误。
 */

import { readFileSync, existsSync } from 'node:fs'

const [a, b] = process.argv.slice(2)
if (!a || !b) {
  console.error('用法: node scripts/multiblock-pipeline/compare-runs.mjs <run1 的 pipeline-result.json> <run2 的 pipeline-result.json>')
  process.exit(2)
}
for (const p of [a, b]) {
  if (!existsSync(p)) {
    console.error(`找不到: ${p}`)
    process.exit(2)
  }
}

const r1 = JSON.parse(readFileSync(a, 'utf8'))
const r2 = JSON.parse(readFileSync(b, 'utf8'))

const problems = []
const rows = []

function mapOf(list, key = 'file', val = 'sha256') {
  const m = new Map()
  for (const e of list ?? []) m.set(e[key], e[val])
  return m
}

function compare(label, m1, m2, sizes1 = null, sizes2 = null) {
  const keys = [...new Set([...m1.keys(), ...m2.keys()])].sort()
  let same = 0
  for (const k of keys) {
    const x = m1.get(k)
    const y = m2.get(k)
    if (x === undefined) {
      problems.push(`${label}: 第 2 次多出 ${k}`)
      rows.push({ label, file: k, run1: '<缺失>', run2: y, verdict: 'DIFF' })
    } else if (y === undefined) {
      problems.push(`${label}: 第 2 次缺少 ${k}`)
      rows.push({ label, file: k, run1: x, run2: '<缺失>', verdict: 'DIFF' })
    } else if (x !== y) {
      problems.push(`${label}: ${k} 哈希不同 run1=${x} run2=${y}`)
      rows.push({ label, file: k, run1: x, run2: y, verdict: 'DIFF' })
    } else {
      same++
      rows.push({
        label,
        file: k,
        run1: x,
        run2: y,
        bytes: sizes1 && sizes2 ? `${sizes1.get(k) ?? '?'} / ${sizes2.get(k) ?? '?'}` : '',
        verdict: 'SAME',
      })
    }
  }
  return { total: keys.length, same }
}

const p1 = mapOf(r1.products)
const p2 = mapOf(r2.products)
const s1 = mapOf(r1.products, 'file', 'bytes')
const s2 = mapOf(r2.products, 'file', 'bytes')
const e1 = mapOf(r1.expanded?.filesSha256)
const e2 = mapOf(r2.expanded?.filesSha256)

const prod = compare('产物', p1, p2, s1, s2)
const exp = e1.size + e2.size > 0 ? compare('展开校验文件', e1, e2) : { total: 0, same: 0 }

console.log('═'.repeat(110))
console.log('自检 1：连续两次无人值守导出的产物逐字节一致性（SHA-256 对比）')
console.log('═'.repeat(110))
console.log(`run1: ${a}`)
console.log(`      label=${r1.label} status=${r1.status} exitCode=${r1.exitCode} 总耗时 ${(r1.timing.totalMs / 1000).toFixed(1)} s`)
console.log(`run2: ${b}`)
console.log(`      label=${r2.label} status=${r2.status} exitCode=${r2.exitCode} 总耗时 ${(r2.timing.totalMs / 1000).toFixed(1)} s`)
console.log('─'.repeat(110))
console.log(
  ['类别'.padEnd(14), '文件'.padEnd(46), '字节(1/2)'.padStart(16), '判定'.padStart(6), 'sha256(前 16)'.padStart(18)].join(' '),
)
for (const r of rows) {
  console.log(
    [
      String(r.label).padEnd(14),
      String(r.file).padEnd(46),
      String(r.bytes ?? '').padStart(16),
      String(r.verdict).padStart(6),
      String(String(r.run1).slice(0, 16)).padStart(18),
    ].join(' '),
  )
}
console.log('─'.repeat(110))
console.log(`产物：${prod.same}/${prod.total} 逐字节一致；展开校验文件：${exp.same}/${exp.total} 逐字节一致`)
console.log(
  `耗时：run1 ${(r1.timing.totalMs / 1000).toFixed(1)} s（进世界 ${(r1.timing.joinWorldMs / 1000).toFixed(1)} s，导出 ${((r1.timing.exportReport?.totalMs ?? 0) / 1000).toFixed(1)} s）` +
    ` | run2 ${(r2.timing.totalMs / 1000).toFixed(1)} s（进世界 ${(r2.timing.joinWorldMs / 1000).toFixed(1)} s，导出 ${((r2.timing.exportReport?.totalMs ?? 0) / 1000).toFixed(1)} s）`,
)

let code = 0
if (problems.length > 0) {
  console.log(`\n✘ 不一致 ${problems.length} 处`)
  for (const p of problems) console.log('  ' + p)
  code = 1
} else if (prod.total === 0) {
  console.log('\n✘ 产物清单为空：没有可比对的东西（视为失败）')
  code = 1
} else {
  console.log('\n✅ 幂等：两次无人值守导出的产物与展开校验文件全部逐字节一致')
}
process.exit(code)
