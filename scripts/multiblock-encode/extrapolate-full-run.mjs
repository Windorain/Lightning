/**
 * T1.5 风险 7（全量导出耗时）的**实测依据工具**：把一次抽样式全量运行的实测单台耗时，
 * 外推到 221 台全量。
 *
 *   node scripts/multiblock-encode/extrapolate-full-run.mjs <export-report.json> <machines.json> \
 *        [--json out.json] [--md out.md]
 *
 * 做法（全部基于实测，不猜）：
 *   ① 从 `export-report.json.capturePerMachine[]` 取每台的 `variants` 与 `phaseTiming.totalMs`（T1.3 实测）；
 *   ② 用同一套**规划规则**（与 MultiblockExportRunner.planSample / VariantCaptureRunner 的 tier 抽样一致）
 *      算出全量 221 台在给定配置下各自的变体数；
 *   ③ 用最小二乘拟合 `ms ≈ a + b·variants`（以及"纯线性"口径 `b' = Σms/Σvariants`）；
 *   ④ 输出两种配置下的全量时长外推 + 单台成本明细。
 *
 * 口径声明：耗时 = T1.3 的 `phaseTiming.totalMs`（构建 + 进态 + 几何捕获），不含客户端启动、
 * 不含纹理嵌入与文件落盘；因此外推是**下界**，报告里另给启动开销的实测值。
 */

import { readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const reportPath = argv[0]
const machinesPath = argv[1]
if (!reportPath || !machinesPath) {
  console.error(
    '用法: node scripts/multiblock-encode/extrapolate-full-run.mjs <export-report.json> <machines.json> [--json out.json] [--md out.md]',
  )
  process.exit(2)
}
function opt(name) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const all = JSON.parse(readFileSync(machinesPath, 'utf8')).machines

const cfg = report.config ?? {}
const capVariants = report.effectiveMaxVariantsPerMachine ?? cfg.maxVariantsPerMachine ?? 20000
const maxChannelValues = report.effectiveMaxChannelValues ?? cfg.maxChannelValues ?? 0
const runstates = report.structuralOnly ? 1 : 2

/** 与 MultiblockExportRunner.planSample + VariantCaptureRunner 的 tier 抽样同规则。 */
function plan(m, cap, maxChannelValues, runstates) {
  const chs = (m.channels ?? []).filter((c) => c.kind !== 'hatch')
  const realMax = (c) => Math.max(0, c.domain?.max ?? c.max ?? 0)
  const dom = new Map()
  for (const c of chs) {
    const real = realMax(c)
    dom.set(c.key ?? c.id, maxChannelValues > 0 ? Math.min(real, maxChannelValues) : real)
  }
  const product = () => [...dom.values()].reduce((p, d) => p * (d + 1), 1)
  const full = product()
  let combos = full
  while (combos * runstates > Math.max(1, cap)) {
    let pick = null
    let best = 1
    for (const c of chs) {
      const k = c.key ?? c.id
      const d = dom.get(k)
      if (d <= 1) continue
      if (d > best) {
        best = d
        pick = k
      }
    }
    if (pick === null) break
    dom.set(pick, Math.max(1, Math.floor(best / 2)))
    combos = product()
  }
  const narrowed = [...dom.entries()].filter(([k, d]) => d < realMax(chs.find((c) => (c.key ?? c.id) === k)))
  const narrowedMin = narrowed.length > 0 ? Math.min(...narrowed.map(([, d]) => d)) : -1
  let hi = Math.max(1, m.totalTier?.maxTotalTier ?? 1)
  if (narrowedMin >= 0) hi = Math.min(hi, narrowedMin)
  const keep = Math.max(1, Math.floor(Math.max(1, cap) / runstates / Math.max(1, combos)))
  const tiers = Math.min(hi, keep)
  return {
    name: m.simpleName,
    channels: chs.length,
    fullCombos: full,
    plannedCombos: combos,
    tiers,
    narrowed: narrowed.map(([k, d]) => `${k}<=${d}`),
    variants: combos * runstates * tiers,
  }
}

const plans = all.map((m) => plan(m, capVariants, maxChannelValues, runstates))
const totalVariants = plans.reduce((s, p) => s + p.variants, 0)

// ---- 实测样本（本次抽样式运行） ----
const sample = (report.capturePerMachine ?? []).map((r) => ({
  name: r.simpleName,
  variants: r.variants,
  ms: r.phaseTiming?.totalMs ?? 0,
  buildMs: r.phaseTiming?.buildMs ?? 0,
  captureMs: r.phaseTiming?.captureMs ?? 0,
}))
const sumN = sample.reduce((s, r) => s + r.variants, 0)
const sumMs = sample.reduce((s, r) => s + r.ms, 0)
const rate = sumN > 0 ? sumMs / sumN : 0

// ---- 最小二乘 a + b·N ----
let a = 0
let b = rate
if (sample.length >= 2 && sumN > 0) {
  const n = sample.length
  const sx = sample.reduce((s, r) => s + r.variants, 0)
  const sy = sample.reduce((s, r) => s + r.ms, 0)
  const sxx = sample.reduce((s, r) => s + r.variants * r.variants, 0)
  const sxy = sample.reduce((s, r) => s + r.variants * r.ms, 0)
  const den = n * sxx - sx * sx
  if (den !== 0) {
    b = (n * sxy - sx * sy) / den
    a = (sy - b * sx) / n
  }
}
const r2 = (() => {
  if (sample.length < 2) return null
  const mean = sumMs / sample.length
  let ssTot = 0
  let ssRes = 0
  for (const r of sample) {
    ssTot += (r.ms - mean) ** 2
    ssRes += (r.ms - (a + b * r.variants)) ** 2
  }
  return ssTot === 0 ? null : 1 - ssRes / ssTot
})()

const extrapolation = {
  perVariantRateMs: rate,
  linearFit: { a, b, r2 },
  totalVariantsAtConfiguredCap: totalVariants,
  fullRunMs_PureLinear: rate * totalVariants,
  fullRunMs_LinearFit: Math.max(0, a) * plans.length + b * totalVariants,
  machinesNarrowed: plans.filter((p) => p.narrowed.length > 0).length,
  machinesUnnarrowed: plans.filter((p) => p.narrowed.length === 0).length,
  capSweep: [20000, 10000, 5000, 4000, 2000, 1000].map((cap) => {
    const rows = all.map((m) => plan(m, cap, maxChannelValues, runstates))
    const tot = rows.reduce((s, r) => s + r.variants, 0)
    return {
      cap,
      machinesNarrowed: rows.filter((r) => r.narrowed.length > 0).length,
      plannedVariants: tot,
      hoursPureLinear: Number(((rate * tot) / 3600000).toFixed(2)),
      hoursLinearFit: Number((((Math.max(0, a) * rows.length + b * tot) / 3600000).toFixed(2))),
    }
  }),
  topByVariants: [...plans].sort((x, y) => y.variants - x.variants).slice(0, 15),
  sample: sample.sort((x, y) => y.variants - x.variants),
  config: { capVariants, maxChannelValues, runstates },
}

const out = {
  source: { report: reportPath, machines: machinesPath },
  measured: {
    sampleMachines: sample.length,
    sampleVariants: sumN,
    sampleMs: sumMs,
    sampleMsPerVariant: rate,
  },
  extrapolation,
}
const jsonPath = opt('json')
if (jsonPath) writeFileSync(jsonPath, JSON.stringify(out, null, 1))

const mdPath = opt('md')
if (mdPath) {
  const h = (ms) => `${(ms / 1000).toFixed(1)} s（${(ms / 3600000).toFixed(2)} h）`
  const lines = []
  lines.push('# T1.5 全量耗时外推（风险 7 的实测依据）')
  lines.push('')
  lines.push(`- 实测样本：${sample.length} 台 / ${sumN} 变体 / ${sumMs} ms（${rate.toFixed(1)} ms/变体）`)
  lines.push(`- 线性拟合：ms ≈ ${a.toFixed(0)} + ${b.toFixed(2)}·N（R²=${r2 === null ? 'n/a' : r2.toFixed(4)}）`)
  lines.push(`- 配置：maxVariantsPerMachine=${capVariants}，maxChannelValues=${maxChannelValues}，运行态 ${runstates} 态`)
  lines.push(`- 全量 ${plans.length} 台在该配置下共 ${totalVariants.toLocaleString()} 变体`)
  lines.push(`- 外推（纯线性）：${h(rate * totalVariants)}`)
  lines.push(`- 外推（含截距）：${h(Math.max(0, a) * plans.length + b * totalVariants)}`)
  lines.push(`- 其中被安全上限收窄的机器：${extrapolation.machinesNarrowed} 台，零收窄 ${extrapolation.machinesUnnarrowed} 台`)
  lines.push('')
  lines.push('| maxVariantsPerMachine | 收窄机器 | 全量规划变体 | 外推 h（纯线性） | 外推 h（含截距） |')
  lines.push('|---:|---:|---:|---:|---:|')
  for (const row of extrapolation.capSweep) {
    lines.push(
      `| ${row.cap} | ${row.machinesNarrowed} | ${row.plannedVariants.toLocaleString()} | ${row.hoursPureLinear} | ${row.hoursLinearFit} |`,
    )
  }
  lines.push('')
  lines.push('| 机器 | 通道 | 全量组合 | 规划后组合 | tier 档 | 规划变体 |')
  lines.push('|---|---:|---:|---:|---:|---:|')
  for (const p of extrapolation.topByVariants) {
    lines.push(
      `| ${p.name} | ${p.channels} | ${p.fullCombos.toLocaleString()} | ${p.plannedCombos.toLocaleString()} | ${p.tiers} | ${p.variants.toLocaleString()} |`,
    )
  }
  lines.push('')
  lines.push('| 实测机器 | 变体 | 构建 ms | 捕获 ms | 合计 ms | ms/变体 |')
  lines.push('|---|---:|---:|---:|---:|---:|')
  for (const s of extrapolation.sample) {
    lines.push(
      `| ${s.name} | ${s.variants} | ${s.buildMs} | ${s.captureMs} | ${s.ms} | ${s.variants ? (s.ms / s.variants).toFixed(1) : '-'} |`,
    )
  }
  writeFileSync(mdPath, lines.join('\n') + '\n')
}

console.log(JSON.stringify({
  sampleVariants: sumN,
  sampleMs: sumMs,
  msPerVariant: Number(rate.toFixed(2)),
  fit: { a: Number(a.toFixed(1)), b: Number(b.toFixed(3)), r2: r2 === null ? null : Number(r2.toFixed(4)) },
  totalVariantsAtConfiguredCap: totalVariants,
  fullRunHours_pureLinear: Number((rate * totalVariants / 3600000).toFixed(2)),
  fullRunHours_linearFit: Number(((Math.max(0, a) * plans.length + b * totalVariants) / 3600000).toFixed(2)),
  machinesNarrowed: extrapolation.machinesNarrowed,
}, null, 1))
