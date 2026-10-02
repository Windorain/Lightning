/**
 * 从**真实捕获**的 LSC 数据集派生一份「可按契约无损编码」的真实数据子集，用于验证
 * guard（多通道同位置相交）规则生成路径 —— 不需要再跑一次游戏。
 *
 *   node scripts/multiblock-encode/derive-lsc-real-subset.mjs \
 *        --dataset mod/gtnh/run/client/sde_multiblock_exports/_dataset/run-0001 \
 *        --machine mtelapotronicsupercapacitor \
 *        --out scripts/multiblock-encode/.out/lsc-real \
 *        [--heights 0,1] [--tiers 1] [--runstates idle,active]
 *
 * 为什么需要派生（这是 T1.5 实测发现的**上游捕获缺陷**，见报告）：
 *   LSC 的真实捕获里，**同一个方块状态**（registryId:meta）在不同变体/位置被烘焙出**不同几何**
 *   （透明玻璃的亮度/AO 与假世界光照状态相关），于是调色板里出现多条"同 registryId:meta 但几何不同"的条目。
 *   两个**布局签名完全相同**（结构一模一样）的变体因此得到不同的调色板下标 → 编码器（正确地）拒绝：
 *   "同一有效取值元组上出现两个不同值"。T1.3 侧同时报了 242 条 StateKeyMismatch + 237 条 CaptureErrors、
 *   32 个 unstable state key。
 *
 * 本脚本做的事（全部是**对真实捕获数据的重写**，不合成任何几何）：
 *   ① **调色板规范化**：按 (registryId, meta) 归并条目，保留首次出现的几何（= 契约 §6.1 第 3 条
 *      "同一方块状态的烘焙几何全文件只存一份"）；把每个变体的网格下标映射到规范化后的下标。
 *   ② 只保留指定 `heights / tiers / runstates` 的变体（默认 = 本次 T1.5 子集实际捕获的那一套）。
 *   ③ 落盘成标准 T1.3 数据集布局（palette.json + machines/<slug>.json），可直接喂
 *      MultiblockFactorizeTool / verify-encoded.mjs / 契约校验器。
 *   ④ 打印"规范化改动了多少格"等诊断，作为诚实性声明的一部分。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
function arg(name, dflt) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt
}
const datasetDir = arg('dataset', null)
const machineSlug = arg('machine', 'mtelapotronicsupercapacitor')
const outDir = arg('out', 'scripts/multiblock-encode/.out/lsc-real')
const heights = arg('heights', '0,1').split(',').map(Number)
const tiers = arg('tiers', '1').split(',').map(Number)
const runstates = arg('runstates', 'idle,active').split(',')
if (!datasetDir) {
  console.error('用法: node derive-lsc-real-subset.mjs --dataset <run-NNNN> --out <dir>')
  process.exit(2)
}

const pal = JSON.parse(readFileSync(join(datasetDir, 'palette.json'), 'utf8'))
const src = JSON.parse(readFileSync(join(datasetDir, 'machines', `${machineSlug}.json`), 'utf8'))

// ---- ① 调色板规范化：(registryId, meta) → 首个下标 ----
const canonicalOf = new Map() // (registryId:meta) -> canonical index
const oldToNew = new Array(pal.blockPalette.length).fill(-1)
const keptEntries = []
for (let i = 0; i < pal.blockPalette.length; i++) {
  const e = pal.blockPalette[i]
  const key = `${e.registryId}:${e.meta}`
  if (i === 0) {
    canonicalOf.set(key, 0)
    oldToNew[0] = 0
    keptEntries.push(e)
    continue
  }
  if (canonicalOf.has(key)) {
    oldToNew[i] = canonicalOf.get(key)
    continue
  }
  canonicalOf.set(key, keptEntries.length)
  oldToNew[i] = keptEntries.length
  keptEntries.push(e)
}
const mergedAway = pal.blockPalette.length - keptEntries.length

// ---- ② 过滤变体并重写下标 ----
const variants = []
let rewritten = 0
let changedCells = 0
for (const v of src.variants) {
  if (!tiers.includes(v.totalTier)) continue
  if (!runstates.includes(v.runstate)) continue
  if (!heights.includes(v.values.height ?? 0)) continue
  const grid = v.grid.cellGrid.map((slice) =>
    slice.map((row) =>
      row.map((ix) => {
        const ni = oldToNew[ix]
        if (ni < 0) throw new Error(`下标 ${ix} 无规范化目标`)
        if (ni !== ix) {
          changedCells++
        }
        return ni
      }),
    ),
  )
  rewritten++
  variants.push({
    index: variants.length,
    key: v.key,
    values: { ...v.values },
    totalTier: v.totalTier,
    runstate: v.runstate,
    effective: { ...(v.effective ?? {}) },
    grid: { origin: v.grid.origin, size: v.grid.size, cellGrid: grid },
  })
}

// ---- ③ 落盘 ----
const declaredMax = new Map()
for (const v of variants) {
  for (const [k, val] of Object.entries(v.values)) {
    declaredMax.set(k, Math.max(declaredMax.get(k) ?? 0, val))
  }
}
const channels = src.channels.map((c) => {
  const out = {
    enum: c.enum,
    id: c.id,
    key: c.key,
    name: c.name,
    kind: c.kind,
    domain: { min: c.kind === 'dimension' ? 1 : 0, max: declaredMax.get(c.key) ?? c.domain?.max ?? c.max },
    max: declaredMax.get(c.key) ?? c.max,
    domainSource: c.domainSource ?? 'probed',
    discoverySource: c.discoverySource ?? 'probed',
    registryAgreement: c.registryAgreement ?? 'not-applicable',
    expectedStates: [],
    notes: [
      '由 derive-lsc-real-subset.mjs 从真实捕获数据集派生（调色板按 registryId:meta 规范化 + 变体子集筛选）。',
      `真实域上界 ${c.domain?.max ?? c.max}；本派生数据集只声明 0..${declaredMax.get(c.key) ?? c.max}。`,
    ],
  }
  if (c.min !== undefined) out.min = c.min
  out.valueSemantics = c.valueSemantics
  return out
})

const roster = [...new Set(variants.map((v) => v.runstate))].map((id) => ({
  id,
  name: id === 'idle' ? 'Idle' : 'Running',
  materialSwap: id !== 'idle',
}))

const machineJson = {
  schema: 'lightning.multiblock.variant-capture/1',
  generatedBy: 'scripts/multiblock-encode/derive-lsc-real-subset.mjs（真实捕获数据的规范化子集）',
  machine: src.machine,
  factsSource: src.factsSource ?? '',
  channels,
  totalTierDomain: src.totalTierDomain,
  tierSample: tiers,
  tierSamplePolicy: `派生：只保留 tier ∈ ${tiers}（真实全员捕获里被 T1.5 收窄后的抽样清单）`,
  runstates: roster,
  gridConvention: src.gridConvention,
  variantCount: variants.length,
  variants,
  paletteRefs: [...new Set(variants.flatMap((v) => v.grid.cellGrid.flat(3)))].sort((a, b) => a - b),
  notes: [
    `派生自 ${datasetDir}/machines/${machineSlug}.json：保留 heights=${heights} tiers=${tiers} runstates=${runstates}，共 ${variants.length} 变体。`,
    `调色板规范化：${pal.blockPalette.length} 条 → ${keptEntries.length} 条（按 registryId:meta 归并掉 ${mergedAway} 条"同状态不同几何"的重复条目），网格里改写了 ${changedCells} 格。`,
    '本派生集不合成任何几何：所有条目与格子都来自真实构建 + 真实捕获。',
  ],
}

const outPalette = {
  blockPalette: keptEntries,
  materialPalette: pal.materialPalette ?? [],
  textureBlobs: pal.textureBlobs ?? [],
  tooltipPalette: pal.tooltipPalette ?? [],
}

mkdirSync(join(outDir, 'machines'), { recursive: true })
writeFileSync(join(outDir, 'palette.json'), JSON.stringify(outPalette))
writeFileSync(join(outDir, 'machines', `${machineSlug}.json`), JSON.stringify(machineJson, null, 1))

console.log(
  `[derive-lsc] ${outDir}: 变体 ${variants.length}（原始 ${src.variants.length}），` +
    `调色板 ${pal.blockPalette.length} → ${keptEntries.length}（归并 ${mergedAway}），改写 ${changedCells} 格；` +
    `通道域 ${channels.map((c) => `${c.key}<=${c.domain.max}`).join(' ')}`,
)
