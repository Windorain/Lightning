/**
 * T1.4 闭环验证器 —— 编码产物 → **参考装配器**（scripts/multiblock-fixtures/lib.mjs）装配
 * → 与 T1.3 数据集 ground-truth `cellGrid` **逐格 diff**。
 *
 *   node scripts/multiblock-encode/verify-encoded.mjs <encodedDir> <datasetDir>
 *
 * 判据（全部硬失败）：
 *   1. 每份文档用 lib.mjs 的 `readFixtureDocument` 读通（生产形态 = base64(gzip(json)) 信封）；
 *   2. 声明的变体集合 = 数据集（或其子集 ground-truth）的**全部**变体 —— 不得丢变体；
 *   3. 每个变体装配成功且 **逐格 diff = 0**；
 *   4. `frames[]` 覆盖每个变体、不含内联 `ops`、生产产物不含 `frames[].cellGrid`；
 *   5. 调色板无未引用条目（air 除外）、下标不越界；
 *   6. 体积：V（§9.2 口径）/ G 的 κ、每变体边际成本、gzip 字节。
 *
 * 退出码：0 = 全绿；1 = 有硬失败；2 = 路径错误。
 */

import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { gzipSync } from 'node:zlib'

import {
  assembleVariant,
  channelBounds,
  entrySignature,
  enumerateVariants,
  expectedCombinationKeys,
  readFixtureDocument,
  tierSample,
} from '../multiblock-fixtures/lib.mjs'

const argv = process.argv.slice(2)
const encodedDir = argv[0]
const datasetDir = argv[1]
if (!encodedDir || !datasetDir) {
  console.error('用法: node scripts/multiblock-encode/verify-encoded.mjs <encodedDir> <datasetDir>')
  process.exit(2)
}

const failures = []
const warnings = []
const docs = []

function fail(where, msg) {
  failures.push(`[${where}] ${msg}`)
}

function warn(where, msg) {
  warnings.push(`[${where}] ${msg}`)
}

// ---------------------------------------------------------------------------
// 数据集（ground truth 的独立来源）
// ---------------------------------------------------------------------------

/** 全局并集调色板（数据集口径）：下标 → 条目内容签名。 */
const datasetPalette = JSON.parse(readFileSync(join(datasetDir, 'palette.json'), 'utf8')).blockPalette
const datasetPaletteSig = datasetPalette.map((e) => entrySignature(e))

/**
 * ground-truth 的 cellGrid 用的是**全局并集调色板下标**，而产物文档用的是**本机剪枝后**的下标
 * （契约 §6.1 第 4 条：不得有未被引用的条目）。因此逐格 diff 必须在**内容层**做：
 * 把全局下标经「条目内容签名」映射到产物的下标空间，再逐格比较。
 * 这一步同时验证了"剪枝/重编号没有改变任何方块状态的内容"。
 */
function buildGlobalToDocMap(docPalette) {
  const bySig = new Map()
  docPalette.forEach((e, i) => {
    const sig = entrySignature(e)
    if (!bySig.has(sig)) bySig.set(sig, i)
  })
  const map = new Array(datasetPalette.length).fill(-1)
  for (let i = 0; i < datasetPalette.length; i++) {
    const to = bySig.get(datasetPaletteSig[i])
    map[i] = to === undefined ? -1 : to
  }
  return map
}

function translateGrid(grid, map) {
  const out = []
  for (const slice of grid) {
    const s = []
    for (const row of slice) {
      const r = new Array(row.length)
      for (let i = 0; i < row.length; i++) r[i] = map[row[i]]
      s.push(r)
    }
    out.push(s)
  }
  return out
}

const datasetVariants = new Map() // slug -> [{key, values, totalTier, runstate, cellGrid}]
const datasetFiles = readdirSync(join(datasetDir, 'machines')).filter((f) => f.endsWith('.json'))
for (const f of datasetFiles) {
  const slug = basename(f, '.json')
  const j = JSON.parse(readFileSync(join(datasetDir, 'machines', f), 'utf8'))
  const list = j.variants.map((v) => ({
    key: v.key,
    values: { ...(v.values ?? {}) },
    totalTier: v.totalTier,
    runstate: v.runstate,
    cellGrid: v.grid.cellGrid,
  }))
  datasetVariants.set(slug, list)
}

function valuesTuple(values) {
  return Object.keys(values)
    .sort()
    .map((k) => `${k}:${values[k]}`)
    .join(',')
}

/**
 * 在数据集里找「同一取值组合」的变体：只比较 ground-truth 自己声明的通道，
 * 其余通道必须为 0（未设置）—— 这样"丢通道的子集重编码"也能与数据集本体核对。
 */
function findDatasetVariant(slug, gtVariant) {
  const list = datasetVariants.get(slug)
  if (!list) return null
  const gtKeys = Object.keys(gtVariant.values)
  for (const v of list) {
    if (v.totalTier !== gtVariant.totalTier || v.runstate !== gtVariant.runstate) continue
    let ok = true
    for (const k of gtKeys) {
      if ((v.values[k] ?? 0) !== (gtVariant.values[k] ?? 0)) {
        ok = false
        break
      }
    }
    if (!ok) continue
    for (const k of Object.keys(v.values)) {
      if (gtKeys.includes(k)) continue
      if ((v.values[k] ?? 0) !== 0) {
        ok = false
        break
      }
    }
    if (ok) return v
  }
  return null
}

// ---------------------------------------------------------------------------
// 逐文档验证
// ---------------------------------------------------------------------------

function gridEquals(a, b) {
  if (a.length !== b.length) return 'z 长度不同'
  for (let z = 0; z < a.length; z++) {
    if (a[z].length !== b[z].length) return `z=${z} 行数不同`
    for (let y = 0; y < a[z].length; y++) {
      if (a[z][y].length !== b[z][y].length) return `z=${z},y=${y} 列数不同`
      for (let x = 0; x < a[z][y].length; x++) {
        if (a[z][y][x] !== b[z][y][x]) {
          return `首格不同 @ (x=${x},y=${y},z=${z})：装配=${a[z][y][x]} ground-truth=${b[z][y][x]}`
        }
      }
    }
  }
  return null
}

function verifyDoc(file) {
  const name = basename(file, '.multiblock.json')
  const raw = readFileSync(file, 'utf8')
  const fileBytes = Buffer.byteLength(raw, 'utf8')
  let envelope
  try {
    envelope = JSON.parse(raw)
  } catch (e) {
    fail(name, `信封 JSON 解析失败: ${e.message}`)
    return null
  }
  let doc
  try {
    doc = readFixtureDocument(envelope)
  } catch (e) {
    fail(name, `readFixtureDocument 失败: ${e.message}`)
    return null
  }
  if (doc.documentShape !== 'multiblock') fail(name, `documentShape 必须为 "multiblock"（实际 ${doc.documentShape}）`)
  if (envelope.payloadEncoding !== 'gzip+base64') {
    fail(name, `生产产物 payloadEncoding 必须为 gzip+base64（实际 ${envelope.payloadEncoding}）`)
  }
  if (doc.multiblockCount !== 1) fail(name, `multiblockCount 必须为 1（实际 ${doc.multiblockCount}）`)
  if (Array.isArray(doc.cellGrid)) fail(name, '多方块文档不得带根级 cellGrid')
  const mb = doc.multiblock
  if (!mb) {
    fail(name, '缺 multiblock 对象')
    return null
  }

  // ---- ground truth ----
  let groundTruth
  let gtSource
  const slug = mb.sourceSlug ?? name
  if (datasetVariants.has(name)) {
    groundTruth = datasetVariants.get(name)
    gtSource = `数据集 machines/${name}.json`
  } else {
    const gtFile = file.replace(/\.multiblock\.json$/, '.groundtruth.json')
    try {
      const gt = JSON.parse(readFileSync(gtFile, 'utf8'))
      groundTruth = gt.variants.map((v) => ({
        key: v.key,
        values: { ...(v.values ?? {}) },
        totalTier: v.totalTier,
        runstate: v.runstate,
        cellGrid: v.cellGrid,
      }))
      gtSource = `${basename(gtFile)}（对照组：工具落盘的输入子集）`
      // 独立性核对：每个子集变体必须与数据集里同 (values,tt,rs) 的变体逐格一致
      if (!datasetVariants.has(gt.sourceSlug)) {
        fail(name, `对照组声明的 sourceSlug=${gt.sourceSlug} 在数据集里不存在`)
      } else {
        let mismatch = 0
        for (const v of groundTruth) {
          const ref = findDatasetVariant(gt.sourceSlug, v)
          if (!ref || gridEquals(v.cellGrid, ref.cellGrid)) mismatch++
        }
        if (mismatch > 0) {
          fail(name, `对照组 ground-truth 有 ${mismatch} 个变体与数据集本体不一致（子集投影不可信）`)
        }
      }
    } catch (e) {
      fail(name, `缺对照组 ground-truth（${gtFile}）: ${e.message}`)
      return null
    }
  }

  // ---- 变体声明完备性 ----
  const declaredVariants = enumerateVariants(doc)
  const declaredKeys = declaredVariants.map((v) => v.key)
  const gtKeys = groundTruth.map((v) => v.key)
  const missing = gtKeys.filter((k) => !declaredKeys.includes(k))
  const extra = declaredKeys.filter((k) => !gtKeys.includes(k))
  if (missing.length > 0) fail(name, `少声明 ${missing.length} 个 ground-truth 变体（禁止靠丢变体换体积）：${missing.slice(0, 3).join(', ')}`)
  if (extra.length > 0) fail(name, `多声明 ${extra.length} 个非 ground-truth 变体：${extra.slice(0, 3).join(', ')}`)
  const expected = expectedCombinationKeys(doc).map((v) => v.key)
  const expMissing = expected.filter((k) => !declaredKeys.includes(k))
  if (expMissing.length > 0) {
    fail(name, `声明集合 ≠ 笛卡尔组合集（缺 ${expMissing.length}）：${expMissing.slice(0, 3).join(', ')}`)
  }

  // ---- 帧完整性 ----
  const frames = doc.frames ?? []
  const frameByVariant = new Map()
  for (const f of frames) {
    if (f.ops !== undefined) fail(name, `frame ${f.index} 携带内联 ops（组合展开形态，硬失败）`)
    if (f.cellGrid !== undefined) fail(name, `frame ${f.index} 携带 cellGrid（生产产物必须省略）`)
    if (!frameByVariant.has(f.variant)) frameByVariant.set(f.variant, [])
    frameByVariant.get(f.variant).push(f)
  }
  const noFrame = gtKeys.filter((k) => !frameByVariant.has(k))
  if (noFrame.length > 0) fail(name, `${noFrame.length} 个变体没有 frame`)

  // ---- 逐变体装配 + 逐格 diff（内容层：全局下标 → 产物下标）----
  const palette = doc.blockPalette ?? []
  const globalToDoc = buildGlobalToDocMap(palette)
  const missingEntries = new Set()
  let diffs = 0
  let cells = 0
  let gridBytesTotal = 0
  let firstDiff = null
  const dimsSeen = new Set()
  const usedAssembled = new Set()
  for (const gt of groundTruth) {
    const expectedGrid = translateGrid(gt.cellGrid, globalToDoc)
    for (const slice of expectedGrid) for (const row of slice) for (const v of row) if (v < 0) missingEntries.add(v)
    let missingHere = false
    for (const slice of expectedGrid) {
      for (const row of slice) {
        for (const v of row) {
          if (v < 0) missingHere = true
        }
      }
    }
    if (missingHere) {
      fail(name, `变体 ${gt.key} 的 ground-truth 含产物调色板里不存在的方块状态（剪枝丢条目）`)
      diffs++
      continue
    }
    let res
    try {
      res = assembleVariant(doc, gt.key)
    } catch (e) {
      fail(name, `变体 ${gt.key} 装配失败: ${e.message}`)
      diffs++
      continue
    }
    const d = gridEquals(res.cellGrid, expectedGrid)
    if (d) {
      diffs++
      if (!firstDiff) firstDiff = `${gt.key}: ${d}`
    }
    cells += res.dims.w * res.dims.h * res.dims.d
    gridBytesTotal += Buffer.byteLength(JSON.stringify(gt.cellGrid), 'utf8')
    dimsSeen.add(`${res.dims.w}x${res.dims.h}x${res.dims.d}`)
    for (const slice of res.cellGrid) for (const row of slice) for (const v of row) usedAssembled.add(v)
  }
  if (diffs > 0) fail(name, `逐格 diff 非零：${diffs}/${groundTruth.length} 个变体不一致；首个差异 ${firstDiff}`)

  // ---- 调色板（用**装配结果**的取值域，即文档自己的下标空间）----
  const unused = []
  for (let i = 0; i < palette.length; i++) if (i > 0 && !usedAssembled.has(i)) unused.push(i)
  if (unused.length > 0) warn(name, `调色板有 ${unused.length} 条从未出现在任何变体装配结果中（air 除外）`)
  let maxIndex = 0
  for (const v of usedAssembled) maxIndex = Math.max(maxIndex, v)
  if (maxIndex >= palette.length) fail(name, `装配结果出现越界下标 ${maxIndex}（调色板长度 ${palette.length}）`)

  // ---- 体积 ----
  const paletteBytes = Buffer.byteLength(JSON.stringify(palette), 'utf8')
  const innerBytes = Buffer.byteLength(JSON.stringify(doc), 'utf8')
  const V = paletteBytes + gridBytesTotal
  const honestExpanded = innerBytes - gridBytesTotal / groundTruth.length + gridBytesTotal
  const payload = envelope.payload ?? ''
  const gzipBytes = Buffer.from(payload, 'base64').length
  const rules = mb.rules ?? []

  // indexTable 长度 / 越界（契约 §4.5；与校验器同口径）
  const channelByKey = new Map((mb.channels ?? []).map((c) => [c.key, c]))
  for (const r of rules) {
    if (r.indexTable) {
      const ch = channelByKey.get(r.channel)
      if (!ch) fail(name, `规则 ${r.id} 的 indexTable 引用未声明通道 ${r.channel}`)
      else {
        const need = (ch.domain?.max ?? 0) + 1
        if (r.indexTable.length < need) fail(name, `规则 ${r.id} 的 indexTable 长度 ${r.indexTable.length} < ${need}`)
        for (const ix of r.indexTable) {
          if (!Number.isInteger(ix) || ix < 0 || ix >= palette.length) fail(name, `规则 ${r.id} 的 indexTable 含越界下标 ${ix}`)
        }
      }
    }
    if (r.indexAliases) {
      for (const [from, to] of Object.entries(r.indexAliases)) {
        if (!Number.isInteger(to) || to < 0 || to >= palette.length) fail(name, `规则 ${r.id} 的 indexAliases[${from}]=${to} 越界`)
      }
    }
  }

  const info = {
    name,
    kind: datasetVariants.has(name) ? 'product' : 'control',
    gtSource,
    variants: groundTruth.length,
    declaredVariants: declaredKeys.length,
    expectedCombinations: expected.length,
    frames: frames.length,
    steps: (mb.backbone?.sizeSteps ?? []).length,
    channels: (mb.channels ?? []).map((c) => `${c.key}:${c.kind}`),
    tierSample: tierSample(doc),
    rules: rules.length,
    rulesByPhase: rules.reduce((a, r) => ((a[r.phase] = (a[r.phase] ?? 0) + 1), a), {}),
    rulesByKind: rules.reduce((a, r) => ((a[r.kind] = (a[r.kind] ?? 0) + 1), a), {}),
    rulesWithIndexTable: rules.filter((r) => r.indexTable).length,
    rulesWithAliases: rules.filter((r) => r.indexAliases).length,
    paletteEntries: palette.length,
    dims: [...dimsSeen],
    cellsTotal: cells,
    diffs,
    fileBytes,
    payloadBase64Chars: payload.length,
    gzipBytes,
    innerJsonBytes: innerBytes,
    paletteJsonBytes: paletteBytes,
    variantGridBytesTotal: gridBytesTotal,
    V_expanded: V,
    kappaContract: V / fileBytes,
    honestExpandedBytes: honestExpanded,
    kappaValidator: honestExpanded / fileBytes,
    bytesPerVariant: fileBytes / groundTruth.length,
    marginals: {
      gzipPerVariant: gzipBytes / groundTruth.length,
      filePerVariant: fileBytes / groundTruth.length,
      expandedGridPerVariant: gridBytesTotal / groundTruth.length,
    },
  }
  return info
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (e.endsWith('.multiblock.json')) out.push(p)
  }
  return out
}

const files = walk(encodedDir).sort()
if (files.length === 0) {
  console.error(`未找到 <name>.multiblock.json（目录 ${encodedDir}）`)
  process.exit(2)
}

const products = files.filter((f) => datasetVariants.has(basename(f, '.multiblock.json')))
const controls = files.filter((f) => !datasetVariants.has(basename(f, '.multiblock.json')))

const results = []
for (const f of files) {
  const info = verifyDoc(f)
  if (info) results.push(info)
}
const allDocs = results
const controlDocs = results.filter((d) => d.kind === 'control')

// ---- 842 变体的合计核对（4 台产物）----
const productDocs = allDocs.filter((d) => d.kind === 'product')
const totalProductVariants = productDocs.reduce((a, d) => a + d.variants, 0)
const datasetTotal = [...datasetVariants.values()].reduce((a, l) => a + l.length, 0)
if (productDocs.length === datasetFiles.length) {
  if (totalProductVariants !== datasetTotal) {
    fail('total', `产物覆盖变体数 ${totalProductVariants} ≠ 数据集变体数 ${datasetTotal}`)
  }
}

// ---- 值级增量的线性拟合（EBF 取值序列，为 T3.2 备料）----
function leastSquares(xs, ys) {
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my)
    sxx += (xs[i] - mx) ** 2
  }
  const b = sxx === 0 ? 0 : sxy / sxx
  const a = my - b * mx
  let ssRes = 0
  let ssTot = 0
  for (let i = 0; i < n; i++) {
    ssRes += (ys[i] - (a + b * xs[i])) ** 2
    ssTot += (ys[i] - my) ** 2
  }
  return { a, b, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot }
}

const valueSeries = controlDocs
  .filter((d) => d.name.startsWith('ctl-values-'))
  .map((d) => ({ name: d.name, values: Number(d.name.match(/ctl-values-(\d+)values/)[1]), bytes: d.fileBytes, n: d.variants }))
  .sort((x, y) => x.values - y.values)
const valueFits = []
for (let i = 1; i < valueSeries.length; i++) {
  const a = valueSeries[i - 1]
  const b = valueSeries[i]
  valueFits.push({
    from: a.values,
    to: b.values,
    deltaValues: b.values - a.values,
    deltaBytes: b.bytes - a.bytes,
    deltaVariants: b.n - a.n,
    bytesPerAddedValue: (b.bytes - a.bytes) / (b.values - a.values),
    bytesPerAddedVariant: (b.bytes - a.bytes) / (b.n - a.n),
  })
}
const valueSeriesFit =
  valueSeries.length >= 2 ? leastSquares(valueSeries.map((p) => p.n), valueSeries.map((p) => p.bytes)) : null

// ---- 通道数对照 ----
const byName = new Map(controlDocs.map((d) => [d.name, d]))
const channelCompare = {}
const chanShield = byName.get('ctl-chan-1-shielding')
const chanManip = byName.get('ctl-chan-1-manipulator')
const chanBoth = byName.get('ctl-chan-2-both')
const chanDeg = byName.get('ctl-chan-2-degenerate')
if (chanShield && chanManip && chanBoth && chanDeg) {
  channelCompare.sameN_addOneChannelBytes = chanDeg.fileBytes - chanShield.fileBytes
  channelCompare.both_minus_shield = chanBoth.fileBytes - chanShield.fileBytes
  channelCompare.both_minus_manip = chanBoth.fileBytes - chanManip.fileBytes
  channelCompare.interactionResidual =
    chanBoth.fileBytes - chanShield.fileBytes - (chanManip.fileBytes - chanDeg.fileBytes)
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

console.log('═'.repeat(96))
console.log('T1.4 闭环验证：编码产物 → lib.mjs 参考装配 → 与 T1.3 ground-truth 逐格 diff')
console.log('═'.repeat(96))
const head = [
  'doc'.padEnd(30),
  'N'.padStart(5),
  '阶'.padStart(3),
  '规则'.padStart(5),
  '调色板'.padStart(6),
  'diff'.padStart(5),
  '文件B'.padStart(9),
  'gzipB'.padStart(8),
  'V(展开)'.padStart(11),
  'κ=V/G'.padStart(8),
  'B/组合'.padStart(8),
]
console.log(head.join(' '))
for (const d of allDocs) {
  console.log(
    [
      d.name.padEnd(30),
      String(d.variants).padStart(5),
      String(d.steps).padStart(3),
      String(d.rules).padStart(5),
      String(d.paletteEntries).padStart(6),
      String(d.diffs).padStart(5),
      String(d.fileBytes).padStart(9),
      String(d.gzipBytes).padStart(8),
      String(d.V_expanded).padStart(11),
      d.kappaContract.toFixed(2).padStart(8),
      d.bytesPerVariant.toFixed(1).padStart(8),
    ].join(' '),
  )
}
console.log('─'.repeat(96))
console.log(
  `4 台产物覆盖变体 ${totalProductVariants} / 数据集 ${datasetTotal}；逐格 diff 合计 ${productDocs.reduce((a, d) => a + d.diffs, 0)}`,
)
if (valueFits.length > 0) {
  console.log('\n「取值数 +1」对照（EBF，tierSample 固定 [1,2]）')
  for (const f of valueFits) {
    console.log(
      `  ${f.from} → ${f.to} 取值：Δ文件 ${String(f.deltaBytes).padStart(6)} B（Δ组合 ${f.deltaVariants}）` +
        ` → ${f.bytesPerAddedValue.toFixed(0)} B/新增取值，${f.bytesPerAddedVariant.toFixed(0)} B/新增组合`,
    )
  }
  if (valueSeriesFit) {
    console.log(
      `  线性拟合 文件B ≈ ${valueSeriesFit.a.toFixed(0)} + ${valueSeriesFit.b.toFixed(1)}·N   R²=${valueSeriesFit.r2.toFixed(4)}`,
    )
  }
}
if (Object.keys(channelCompare).length > 0) {
  console.log('\n「通道数 +1」对照（QFT，tierSample=[1]）')
  console.log(
    `  组合数不变（N=10）加一条通道：Δ文件 ${channelCompare.sameN_addOneChannelBytes} B（通道声明 + 键串开销）`,
  )
  console.log(`  加 manipulator（N 10→50）：Δ文件 ${channelCompare.both_minus_shield} B`)
  console.log(`  加 shielding（N 10→50）：Δ文件 ${channelCompare.both_minus_manip} B`)
  console.log(`  交互残差（可加性）：${channelCompare.interactionResidual} B`)
}

// ---- 调色板重编号两种实现对照 ----
const directRenumber = controlDocs.find((d) => d.name === 'ctl-renumber-direct-ebf')
const ebfProduct = productDocs.find((d) => d.name === 'mteelectricblastfurnace')
const renumberCompare =
  directRenumber && ebfProduct
    ? {
        aliasRuleBytes: ebfProduct.fileBytes - directRenumber.fileBytes,
        aliasFileBytes: ebfProduct.fileBytes,
        directFileBytes: directRenumber.fileBytes,
        aliasRules: ebfProduct.rules,
        directRules: directRenumber.rules,
      }
    : null
if (renumberCompare) {
  console.log('\n调色板重编号两种实现（EBF 全量，其余完全相同）')
  console.log(
    `  indexAliases 规则：规则 ${renumberCompare.aliasRules} 条 / 文件 ${renumberCompare.aliasFileBytes} B；` +
      `编码期直接换下标：规则 ${renumberCompare.directRules} 条 / 文件 ${renumberCompare.directFileBytes} B` +
      ` → indexAliases 代价 ${renumberCompare.aliasRuleBytes > 0 ? '+' : ''}${renumberCompare.aliasRuleBytes} B`,
  )
}

console.log('\n' + '─'.repeat(96))
if (warnings.length > 0) {
  console.log(`▲ 警告 ${warnings.length}`)
  for (const w of warnings) console.log('  ' + w)
}
if (failures.length > 0) {
  console.log(`✘ 硬失败 ${failures.length}`)
  for (const f of failures) console.log('  ' + f)
} else {
  console.log('✅ 全绿：全部变体装配成功且逐格 diff = 0')
}

const report = {
  tool: 'verify-encoded.mjs (T1.4)',
  encodedDir,
  datasetDir,
  ranAt: new Date().toISOString(),
  products: productDocs.length,
  controls: controlDocs.length,
  totalProductVariants,
  datasetTotalVariants: datasetTotal,
  docs: allDocs,
  valueSeries,
  valueFits,
  valueSeriesFit,
  channelCompare,
  renumberCompare,
  failures,
  warnings,
}
const reportPath = join(encodedDir, 'verification-report.json')
writeFileSync(reportPath, JSON.stringify(report, null, 1), 'utf8')
console.log(`报告落盘：${reportPath}`)
process.exit(failures.length === 0 ? 0 : 1)

