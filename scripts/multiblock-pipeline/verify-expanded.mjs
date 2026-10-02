/**
 * T1.6 自检 3 / T3.3 的 mod 半环 —— **展开形态校验文件 vs 产物经 lib.mjs 装配结果逐格 diff**。
 *
 *   node scripts/multiblock-pipeline/verify-expanded.mjs <产物目录>
 *
 * `<产物目录>` = `mod/gtnh/run/client/sde_multiblock_exports`（或其归档副本），内含：
 *   - `expanded/_manifest.json` + `expanded/<slug>.multiblock__<variant>.json`（T1.6 留白 #10 的产出）
 *   - `<slug>.multiblock.json`（T1.5 产物，gzip+base64 信封）
 *   - `_dataset/run-NNNN/palette.json`（全局并集调色板，展开网格的下标空间）
 *
 * 判据（全部硬失败）：
 *   1. 每个抽样组合的 `dims` 与 `cellGrid` 形状一致、`variant` 在产物里已声明；
 *   2. 展开网格的**每个全局下标**都能经「内容签名」映射到产物剪枝/重编号后的下标空间 —— 映射不上 = 硬失败
 *      （**不允许**把映射不上的格子当作 air 静默放过）；
 *   3. `lib.mjs#assembleVariant(产物, variant)` 的结果与展开网格 **逐格 diff = 0**（主门禁，下标空间同一）；
 *   4. `idMeta`（`name:meta`，air → `''`）投影口径同样 diff = 0（与
 *      `web/e2e/helpers/multiblock/referenceGrids.ts` 的门禁口径一致）；两者同时记录，
 *      `full` 口径更强、`idMeta` 是渲染侧真实携带的身份；
 *   5. 抽样清单**覆盖策略**可机器核对：每条具名通道都能找到「最小取值」与「最大取值」的抽样，
 *      每个声明运行态都有一例。
 *
 * 退出码：0 = 全绿；1 = 有硬失败；2 = 路径/清单错误。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { assembleVariant, entrySignature, readFixtureDocument } from '../multiblock-fixtures/lib.mjs'

const outDir = process.argv[2]
if (!outDir) {
  console.error('用法: node scripts/multiblock-pipeline/verify-expanded.mjs <产物目录>')
  process.exit(2)
}
const manifestPath = join(outDir, 'expanded', '_manifest.json')
if (!existsSync(manifestPath)) {
  console.error(`找不到展开校验清单: ${manifestPath}\n（先跑 scripts/multiblock-pipeline/run-pipeline.ps1）`)
  process.exit(2)
}

const failures = []
const warnings = []
const fail = (where, msg) => failures.push(`[${where}] ${msg}`)
const warn = (where, msg) => warnings.push(`[${where}] ${msg}`)

/** `name@meta` → `idMeta` 口径（`name:meta`，air → ''）——与 referenceGrids.paletteSignatures 同口径。 */
function idMetaOf(label) {
  const at = label.lastIndexOf('@')
  const name = at >= 0 ? label.slice(0, at) : label
  const meta = at >= 0 ? label.slice(at + 1) : '0'
  if (name === '' || name === 'air' || name === 'Air') return ''
  return `${name}:${meta}`
}

function gridDims(grid) {
  const d = grid.length
  const h = d === 0 ? 0 : grid[0].length
  const w = h === 0 ? 0 : grid[0][0].length
  return { w, h, d }
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (manifest.schema !== 'lightning.multiblock.expanded/1') {
  fail('manifest', `schema 必须为 lightning.multiblock.expanded/1（实际 ${manifest.schema}）`)
}

const results = []
let totalCells = 0
let totalDiff = 0
let totalSamples = 0

for (const m of manifest.machines) {
  const where = m.slug
  const productPath = join(outDir, m.productFile)
  if (!existsSync(productPath)) {
    fail(where, `产物不存在: ${productPath}`)
    continue
  }
  const envelope = JSON.parse(readFileSync(productPath, 'utf8'))
  const doc = readFixtureDocument(envelope)
  const palette = doc.blockPalette ?? []
  if (palette.length === 0) fail(where, '产物缺 blockPalette')

  // 内容签名 → 产物下标（同 verify-encoded.mjs 的 buildGlobalToDocMap 口径；并列取首个）
  const docIndexBySig = new Map()
  const docLabelByIdx = palette.map((e, i) => {
    const sig = entrySignature(e)
    if (!docIndexBySig.has(sig)) docIndexBySig.set(sig, i)
    const rid = typeof e.registryId === 'string' ? e.registryId : ''
    const colon = rid.indexOf(':')
    const name = colon >= 0 ? rid.slice(colon + 1) : rid
    return `${name}@${Number(e.meta ?? 0)}`
  })

  // 已知盲区（记录，不门禁）：不同 full 签名但同 idMeta —— 渲染管线按 name:meta 归并
  const firstByIdMeta = new Map()
  const signatureCollapsed = []
  docLabelByIdx.forEach((label, i) => {
    const idm = idMetaOf(label)
    if (idm === '') return
    const sig = entrySignature(palette[i])
    const prev = firstByIdMeta.get(idm)
    if (prev === undefined) firstByIdMeta.set(idm, { i, sig })
    else if (prev.sig !== sig) signatureCollapsed.push({ a: prev.i, b: i, idMeta: idm })
  })

  let machineCells = 0
  let machineDiff = 0
  const details = []

  for (const s of m.samples) {
    totalSamples++
    const sw = `${where}/${s.variant}`
    const f = join(outDir, s.file)
    if (!existsSync(f)) {
      fail(sw, `展开文件不存在: ${f}`)
      machineDiff++
      continue
    }
    const ex = JSON.parse(readFileSync(f, 'utf8'))
    if (ex.variant !== s.variant) fail(sw, `展开文件的 variant=${ex.variant} 与清单不一致`)
    const dims = gridDims(ex.cellGrid)
    if (dims.w !== ex.dims.w || dims.h !== ex.dims.h || dims.d !== ex.dims.d) {
      fail(sw, `dims 与实际形状不符：声明 ${ex.dims.w}×${ex.dims.h}×${ex.dims.d}，实际 ${dims.w}×${dims.h}×${dims.d}`)
    }

    // 全局下标 → 产物下标（内容签名对齐；映射不上 = 硬失败）
    const sigByIdx = ex.palette?.signatures ?? {}
    const labelByIdx = ex.palette?.labels ?? {}
    const translate = new Map()
    let unmapped = 0
    const collect = (grid) => {
      for (const slice of grid) for (const row of slice) for (const idx of row) {
        if (translate.has(idx)) continue
        const sig = sigByIdx[String(idx)]
        if (sig === undefined) {
          fail(sw, `展开网格用了下标 ${idx}，但文件内联签名表里没有它（展开文件自洽性破损）`)
          translate.set(idx, -1)
          unmapped++
          continue
        }
        const to = docIndexBySig.get(sig)
        if (to === undefined) {
          fail(sw, `全局下标 ${idx}（签名 ${sig.slice(0, 80)}…）在产物调色板里找不到同内容条目 —— 剪枝/重编号丢了方块状态`)
          translate.set(idx, -1)
          unmapped++
          continue
        }
        translate.set(idx, to)
      }
    }
    collect(ex.cellGrid)

    const expected = ex.cellGrid.map((slice) => slice.map((row) => row.map((idx) => translate.get(idx))))
    if (unmapped > 0) {
      machineDiff++
      totalDiff++
      continue
    }

    // 逐格 diff 的格数按**期望形状**统计（与 referenceGrids.diffSignatureGrids 同口径）
    machineCells += dims.w * dims.h * dims.d
    totalCells += dims.w * dims.h * dims.d

    let res
    try {
      res = assembleVariant(doc, s.variant)
    } catch (e) {
      fail(sw, `lib.mjs 装配失败: ${e.message}`)
      machineDiff++
      continue
    }

    // ---- 主门禁：同一下标空间逐格 diff（全签名口径） ----
    const got = res.cellGrid
    let shapeBad = false
    if (got.length !== expected.length) shapeBad = true
    else {
      for (let z = 0; z < expected.length && !shapeBad; z++) {
        if (got[z].length !== expected[z].length) { shapeBad = true; break }
        for (let y = 0; y < expected[z].length && !shapeBad; y++) {
          if (got[z][y].length !== expected[z][y].length) { shapeBad = true; break }
        }
      }
    }
    if (shapeBad) {
      const gd = gridDims(got)
      fail(sw, `形状不一致：装配 ${gd.w}×${gd.h}×${gd.d} vs 展开 ${dims.w}×${dims.h}×${dims.d}`)
      machineDiff++
      continue
    }

    let diff = 0
    let first = null
    for (let z = 0; z < expected.length; z++) {
      for (let y = 0; y < expected[z].length; y++) {
        for (let x = 0; x < expected[z][y].length; x++) {
          const a = got[z][y][x]
          const b = expected[z][y][x]
          if (a !== b) {
            diff++
            if (!first) {
              first = `(x=${x},row=${y},z=${z}) 装配=${a}(${docLabelByIdx[a]}) 展开=${b}(全局)→产物=${b}(${docLabelByIdx[b]})`
            }
          }
        }
      }
    }
    if (diff > 0) {
      machineDiff++
      totalDiff += diff
      details.push(`${s.variant}: diff ${diff} 格，首格 ${first}`)
      continue
    }

    // ---- 次门禁：idMeta 投影（与 referenceGrids 的门禁口径一致） ----
    let idMetaDiff = 0
    for (let z = 0; z < expected.length; z++) {
      for (let y = 0; y < expected[z].length; y++) {
        for (let x = 0; x < expected[z][y].length; x++) {
          const a = idMetaOf(docLabelByIdx[got[z][y][x]])
          const b = idMetaOf(labelByIdx[String(ex.cellGrid[z][y][x])] ?? '')
          if (a !== b) idMetaDiff++
        }
      }
    }
    if (idMetaDiff > 0) {
      fail(sw, `idMeta 口径 diff=${idMetaDiff} 格（与 referenceGrids 门禁口径不一致）`)
      machineDiff++
    }
  }

  // ---- 抽样策略覆盖核对（机器判据，不靠人看） ----
  const sampleValues = m.samples.map((s) => ({ variant: s.variant, values: s.values, runstate: s.runstate }))
  for (const c of m.channels) {
    if (c.kind === 'hatch') continue
    const hasMin = sampleValues.some((s) => (s.values[c.key] ?? 0) === 0)
    const hasMax = sampleValues.some((s) => (s.values[c.key] ?? 0) === c.domainMax)
    if (!hasMin) fail(where, `抽样清单没有覆盖通道 ${c.key} 的最小取值 0`)
    if (!hasMax) fail(where, `抽样清单没有覆盖通道 ${c.key} 的最大取值 ${c.domainMax}`)
  }
  for (const rs of m.runstates) {
    if (!sampleValues.some((s) => s.runstate === rs)) fail(where, `抽样清单没有覆盖运行态 ${rs}`)
  }
  // 每通道最小/最大是否**精确命中**（就近匹配会记录在 why 里）
  for (const s of m.samples) {
    const hit = (s.why ?? []).filter((w) => w.includes('就近匹配'))
    if (hit.length > 0) warn(where, `抽样 ${s.variant} 是就近匹配（域/抽样收窄后目标组合不存在）：${hit.join(' ; ')}`)
  }

  results.push({
    slug: m.slug,
    machine: m.machine,
    samples: m.samples.length,
    variantTotal: m.variantTotal,
    cells: machineCells,
    diff: machineDiff,
    details,
    signatureCollapsed,
    file: m.productFile,
  })
  if (machineDiff > 0) fail(where, `逐格 diff 非零：${machineDiff}/${m.samples.length} 个抽样组合不一致；${details.slice(0, 2).join(' | ')}`)
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
console.log('═'.repeat(100))
console.log('T1.6 展开形态校验：expanded/*.json（ground-truth）vs <slug>.multiblock.json 经 lib.mjs 装配 —— 逐格 diff')
console.log('═'.repeat(100))
console.log(
  ['machine'.padEnd(30), '抽样'.padStart(5), '变体总'.padStart(7), '格数'.padStart(8), 'diff'.padStart(6), '签名塌缩'.padStart(9)].join(' '),
)
for (const r of results) {
  console.log(
    [
      String(r.slug).padEnd(30),
      String(r.samples).padStart(5),
      String(r.variantTotal).padStart(7),
      String(r.cells).padStart(8),
      String(r.diff).padStart(6),
      String(r.signatureCollapsed.length).padStart(9),
    ].join(' '),
  )
}
console.log('─'.repeat(100))
console.log(`合计：${results.length} 台 / ${totalSamples} 个抽样组合 / ${totalCells} 格；逐格 diff = ${totalDiff}`)
if (warnings.length > 0) {
  console.log(`\n▲ 警告 ${warnings.length}`)
  for (const w of warnings) console.log('  ' + w)
}
if (failures.length > 0) {
  console.log(`\n✘ 硬失败 ${failures.length}`)
  for (const f of failures) console.log('  ' + f)
} else {
  console.log('\n✅ 全绿：全部抽样组合装配成功且逐格 diff = 0（full 与 idMeta 两个口径都 0）')
}
const report = {
  tool: 'verify-expanded.mjs (T1.6)',
  outDir,
  ranAt: new Date().toISOString(),
  manifest: manifestPath,
  machines: results.length,
  samples: totalSamples,
  cells: totalCells,
  totalDiff,
  results,
  failures,
  warnings,
}
const reportPath = join(outDir, 'expanded', 'expanded-verification-report.json')
writeFileSync(reportPath, JSON.stringify(report, null, 1), 'utf8')
console.log(`报告落盘：${reportPath}`)
process.exit(failures.length === 0 ? 0 : 1)
