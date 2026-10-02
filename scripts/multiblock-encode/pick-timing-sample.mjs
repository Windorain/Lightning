/**
 * 选一组**分层代表**机器做全量耗时的抽样实测（T1.5 风险 7 的实测样本）。
 *
 *   node scripts/multiblock-encode/pick-timing-sample.mjs <machines.json> [--n 20] [--cap 4000] [--budget 4000]
 *
 * 选法（确定性、可复现）：
 *   ① 复算每台在给定上限下的规划变体数（与 MultiblockExportRunner.planSample 同规则）；
 *   ② 按「通道数 × 是否有尺寸型通道 × 规划变体数量级」分层，每层取代表；
 *   ③ 在总变体预算（--budget）内尽量铺开层，保证样本既有"仅总 Tier"的小机器，也有多通道的中等机器。
 *
 * 输出：一行 JSON（`machines` 数组 + 每台的规划信息），可直接粘进 sde_multiblock.json。
 * 说明：**不会**选取规划变体数 > budget 的机器（避免抽样运行本身跑不完）；因此外推时
 * 大机器的时间由拟合式外推，这在报告里作为已知限制写明。
 */

import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const machinesPath = argv[0]
if (!machinesPath) {
  console.error('用法: node scripts/multiblock-encode/pick-timing-sample.mjs <machines.json> [--n 20] [--cap 4000]')
  process.exit(2)
}
function opt(name, dflt) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length ? Number(argv[i + 1]) : dflt
}
const n = opt('n', 20)
const capVariants = opt('cap', 4000)
const budget = opt('budget', 4000)
const maxChannelValues = opt('maxChannelValues', 0)

const all = JSON.parse(readFileSync(machinesPath, 'utf8')).machines

function plan(m, cap, maxChannelValues) {
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
  while (combos * 2 > Math.max(1, cap)) {
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
  const narrowed = [...dom.entries()].filter(
    ([k, d]) => d < realMax(chs.find((c) => (c.key ?? c.id) === k)),
  )
  const narrowedMin = narrowed.length > 0 ? Math.min(...narrowed.map(([, d]) => d)) : -1
  let hi = Math.max(1, m.totalTier?.maxTotalTier ?? 1)
  if (narrowedMin >= 0) hi = Math.min(hi, narrowedMin)
  // 契约 §9.4 的 tierSample 抽样（与 VariantCaptureRunner 同规则）：
  // keep = ⌊(上限/运行态)/组合数⌋，sampleEvenly(1, hi, keep) 取 keep 个不同档；keep=1 时取 1 档。
  const keep = Math.max(1, Math.floor(Math.max(1, cap) / 2 / Math.max(1, combos)))
  const tiers = Math.min(hi, keep)
  return {
    simpleName: m.simpleName,
    fqcn: m.fqcn,
    channels: chs.length,
    sizeChannels: chs.filter((c) => c.kind === 'dimension' || c.kind === 'size').length,
    fullCombos: full,
    plannedCombos: combos,
    tiers,
    variants: combos * 2 * tiers,
  }
}

const plans = all.map((m) => plan(m, capVariants, maxChannelValues))
const strat = (p) =>
  `${p.channels}c${p.sizeChannels > 0 ? 'S' : '-'}` +
  (p.variants <= 50 ? 'b1' : p.variants <= 300 ? 'b2' : p.variants <= 1500 ? 'b3' : 'b4')

const byStrat = new Map()
for (const p of plans) {
  const k = strat(p)
  if (!byStrat.has(k)) byStrat.set(k, [])
  byStrat.get(k).push(p)
}
for (const list of byStrat.values()) list.sort((a, b) => a.variants - b.variants)

// 轮询各层取机器，直到达到台数或变体预算
const picked = []
const seen = new Set()
let used = 0
const keys = [...byStrat.keys()].sort()
let progress = true
while (picked.length < n && progress) {
  progress = false
  for (const k of keys) {
    if (picked.length >= n) break
    const list = byStrat.get(k)
    while (list.length > 0 && seen.has(list[0].simpleName)) list.shift()
    if (list.length === 0) continue
    const cand = list.shift()
    if (cand.variants > budget - used && picked.length > 0) continue
    seen.add(cand.simpleName)
    picked.push(cand)
    used += cand.variants
    progress = true
  }
}

const out = {
  machines: picked.map((p) => p.simpleName),
  plannedVariants: used,
  stratum: Object.fromEntries(keys.map((k) => [k, byStrat.get(k).length])),
  detail: picked,
}
console.log(JSON.stringify(out, null, 1))
