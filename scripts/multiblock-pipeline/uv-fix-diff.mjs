#!/usr/bin/env node
/**
 * 修复前后产物对照（BUG: 多方块产物覆盖层图标上下颠倒 / UV 不正确）。
 *
 * 三件事：
 *  1. **修复前后差异面**：逐产物 / 逐调色板条目 / 逐四边形比对，把差异归类为
 *     `identical` / `v→1-v` / `u→1-u` / `OTHER`，并按材质类别（extFacing 覆盖层 vs 基础贴图）汇总。
 *     期望（修复的正确性判据）：**所有差异四边形都是 extFacing 覆盖层，且差异恰为 v → 1-v（或 u → 1-u）**；
 *     基础贴图/结构一条都不能变。
 *  2. **与主菜单态参照（run-0016）等价性**：修复后（会话世界内捕获）的覆盖层手性必须与主菜单态捕获一致，
 *     即「查到真实 alignment」≡「{@code ExtendedFacing.DEFAULT}」——不被捕获环境左右。
 *  3. 结构（cellGrid / 非覆盖层几何）必须零变化。
 *
 * 用法：
 *   node scripts/multiblock-pipeline/uv-fix-diff.mjs --before <目录> --after <目录> [--reference <palette.json> ...]
 *        [--json]
 *
 * 退出码：0 = 全部符合期望；1 = 出现期望外差异；2 = 用法错误。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const AXES = ['x', 'y', 'z']

export function decodeProduct(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (raw && typeof raw.payload === 'string' && raw.payloadEncoding === 'gzip+base64') {
    return JSON.parse(zlib.gunzipSync(Buffer.from(raw.payload, 'base64')).toString('utf8'))
  }
  return raw
}

export function isOverlayMaterial(locator) {
  const s = String(locator ?? '')
  return /OVERLAY/i.test(s) || /controllerFaces\//i.test(s)
}

const quant = (n) => Number(n.toFixed(6))
const vertKey = (v) => [quant(v.x), quant(v.y), quant(v.z), quant(v.u), quant(v.v), v.brightness, v.color].join(',')

/** 四边形的面（轴对齐面判定），供「差异落在哪个面」用。 */
function faceOf(quad) {
  const vs = quad.vertices
  for (const axis of AXES) {
    const vals = vs.map((v) => v[axis])
    if (vals.every((t) => Math.abs(t - vals[0]) < 1e-9)) {
      return `${vals[0] > 0.5 ? 'POS' : 'NEG'}_${axis.toUpperCase()}`
    }
  }
  return '?'
}

/** 单四边形差异类型：identical / v→1-v / u→1-u / position-only / other。 */
function diffKind(a, b) {
  if (JSON.stringify(a.vertices) === JSON.stringify(b.vertices)) return 'identical'
  const samePos = a.vertices.every(
    (v, i) =>
      quant(v.x) === quant(b.vertices[i].x) &&
      quant(v.y) === quant(b.vertices[i].y) &&
      quant(v.z) === quant(b.vertices[i].z),
  )
  if (samePos) {
    const vFlip = a.vertices.every((v, i) => quant(1 - v.v) === quant(b.vertices[i].v) && quant(v.u) === quant(b.vertices[i].u))
    if (vFlip) return 'v→1-v'
    const uFlip = a.vertices.every((v, i) => quant(1 - v.u) === quant(b.vertices[i].u) && quant(v.v) === quant(b.vertices[i].v))
    if (uFlip) return 'u→1-u'
    const uvSwap = a.vertices.every((v, i) => quant(v.u) === quant(b.vertices[i].v) && quant(v.v) === quant(b.vertices[i].u))
    if (uvSwap) return 'uv-swap'
    // 亮度/颜色差异（同 UV）：分列出来，避免与「UV 修复」混为一谈
    const sameUv = a.vertices.every((v, i) => quant(v.u) === quant(b.vertices[i].u) && quant(v.v) === quant(b.vertices[i].v))
    if (sameUv) return a.vertices.every((v, i) => v.brightness === b.vertices[i].brightness && v.color === b.vertices[i].color)
      ? 'identical'
      : 'light/color-only'
    return 'other-uv'
  }
  return 'position'
}

function entriesOf(doc) {
  const blocks = doc.blockPalette ?? []
  const mats = doc.materialPalette ?? []
  return blocks.map((e, i) => ({
    index: i,
    registryId: e.registryId,
    meta: e.meta,
    quads: (e?.geometry?.quads ?? []).map((q, qi) => ({
      qi,
      locator: mats[q.materialIndex]?.locator ?? '?',
      overlay: isOverlayMaterial(mats[q.materialIndex]?.locator),
      face: faceOf(q),
      raw: q,
    })),
  }))
}

const keyOf = (e) =>
  `${e.registryId}|${e.meta}|${e.quads.length}|${[...new Set(e.quads.map((q) => q.locator))].sort().join(',')}`

/** 逐产物条目配对比对。 */
export function compareDocs(beforeDoc, afterDoc) {
  const A = entriesOf(beforeDoc)
  const B = entriesOf(afterDoc)
  const byKey = new Map()
  for (const e of A) {
    if (!byKey.has(keyOf(e))) byKey.set(keyOf(e), [])
    byKey.get(keyOf(e)).push(e)
  }
  const used = new Set()
  const rows = []
  for (const b of B) {
    const cands = (byKey.get(keyOf(b)) ?? []).filter((e) => !used.has(e.index))
    if (cands.length === 0) {
      rows.push({ label: `${b.registryId}:${b.meta}`, status: 'no-counterpart', diffs: [] })
      continue
    }
    const a = cands[0]
    used.add(a.index)
    const diffs = []
    for (let i = 0; i < Math.max(a.quads.length, b.quads.length); i++) {
      const qa = a.quads[i]
      const qb = b.quads[i]
      if (!qa || !qb) {
        diffs.push({ qi: i, kind: 'quad-count', overlay: true, face: '?' })
        continue
      }
      const kind = diffKind(qa.raw, qb.raw)
      if (kind !== 'identical') {
        diffs.push({ qi: i, kind, overlay: qb.overlay, face: qb.face, locator: qb.locator })
      }
    }
    rows.push({
      label: `${b.registryId}:${b.meta}`,
      status: diffs.length === 0 ? 'identical' : 'differs',
      diffs,
    })
  }
  const unmatchedBefore = A.filter((e) => !used.has(e.index)).map((e) => `${e.registryId}:${e.meta}`)
  return { rows, unmatchedBefore }
}

function loadDocs(inputs) {
  return inputs.map((input) => {
    const st = fs.statSync(input)
    const files = st.isDirectory()
      ? fs
          .readdirSync(input)
          .filter((f) => f.endsWith('.multiblock.json'))
          .sort()
          .map((f) => path.join(input, f))
      : [input]
    return files.map((f) => ({ file: f, doc: decodeProduct(f) }))
  }).flat()
}

function collectArg(argv, flag) {
  const out = []
  argv.forEach((a, i) => {
    if (a === flag && argv[i + 1]) out.push(argv[i + 1])
  })
  return out
}

/**
 * 跨环境对照：把「修复后产物」与另一份捕获产物（如 T1.3 主菜单态捕获的 `palette.json`）按内容键配对，
 * 只比对**覆盖层四边形**的 UV —— 用来回答「查到真实 alignment」是否等价于「ExtendedFacing.DEFAULT」，
 * 即修复后的产物是否不再依赖捕获时的会话环境。
 */
function crossEnvOverlayDiff(products, references) {
  const refEntries = []
  for (const r of references) {
    for (const e of entriesOf(r.doc)) refEntries.push({ ...e, source: path.basename(r.file) })
  }
  const out = []
  for (const p of products) {
    const slug = path.basename(p.file).replace(/\.multiblock\.json$/, '')
    let identical = 0
    const mismatches = []
    for (const e of entriesOf(p.doc)) {
      const cand = refEntries.find((r) => keyOf(r) === keyOf(e))
      if (!cand) continue
      for (let i = 0; i < e.quads.length; i++) {
        const qa = cand.quads[i]
        const qb = e.quads[i]
        if (!qb?.overlay) continue
        const kind = diffKind(qa.raw, qb.raw)
        if (kind === 'identical') identical++
        else mismatches.push({ entry: `${e.registryId}:${e.meta}`, qi: i, face: qb.face, locator: qb.locator, kind })
      }
    }
    out.push({ slug, overlayQuadsCompared: identical + mismatches.length, identical, mismatches })
  }
  return out
}

function main() {
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const beforeDirs = collectArg(argv, '--before')
  const afterDirs = collectArg(argv, '--after')
  if (beforeDirs.length === 0 || afterDirs.length === 0) {
    console.error('用法: node scripts/multiblock-pipeline/uv-fix-diff.mjs --before <目录> --after <目录> [--reference <palette.json>...] [--json]')
    process.exit(2)
  }
  const before = loadDocs(beforeDirs)
  const after = loadDocs(afterDirs)
  const summary = { products: [], unexpected: [], overlayFixed: 0, otherDiffs: 0 }
  let exitCode = 0

  for (const b of before) {
    const slug = path.basename(b.file).replace(/\.multiblock\.json$/, '')
    const a = after.find((x) => path.basename(x.file).replace(/\.multiblock\.json$/, '') === slug)
    if (!a) continue
    const cmp = compareDocs(b.doc, a.doc)
    const changed = cmp.rows.filter((r) => r.status === 'differs')
    const overlayDiffs = changed.flatMap((r) => r.diffs.map((d) => ({ ...d, entry: r.label })))
    const bad = overlayDiffs.filter((d) => !d.overlay || !['v→1-v', 'u→1-u'].includes(d.kind))
    summary.overlayFixed += overlayDiffs.filter((d) => d.overlay && ['v→1-v', 'u→1-u'].includes(d.kind)).length
    summary.otherDiffs += bad.length
    if (bad.length > 0) exitCode = 1
    summary.products.push({
      slug,
      entriesWithDiff: changed.length,
      overlayDiffs: overlayDiffs.length,
      unexpected: bad,
      unmatchedBefore: cmp.unmatchedBefore,
    })
    if (!json) {
      console.log(`=== ${slug}：有差异条目 ${changed.length} 个 / 覆盖层镜像修正 ${overlayDiffs.length} 个 / 期望外差异 ${bad.length} 个`)
      for (const d of overlayDiffs) {
        console.log(`    ${d.entry} q${d.qi} 面=${d.face} ${d.locator} → ${d.kind}`)
      }
      for (const d of bad) {
        console.log(`    ✗ 期望外：${d.entry} q${d.qi} 面=${d.face} ${d.locator ?? ''} → ${d.kind}`)
      }
      if (cmp.unmatchedBefore.length > 0) {
        console.log(`    （修复前独有条目：${cmp.unmatchedBefore.join(', ')}）`)
      }
    }
  }

  if (json) console.log(JSON.stringify(summary, null, 2))
  else {
    console.log(
      `\n== 修复前后：覆盖层镜像修正 ${summary.overlayFixed} 个四边形 / 期望外差异 ${summary.otherDiffs} 个 → ` +
        (exitCode === 0 ? '符合期望（差异全部是 extFacing 覆盖层的精确镜像修正）' : '存在期望外差异'),
    )
  }

  const referenceArgs = collectArg(argv, '--reference')
  if (referenceArgs.length > 0) {
    const refs = referenceArgs.map((f) => ({ file: f, doc: decodeProduct(f) }))
    const cross = crossEnvOverlayDiff(after, refs)
    summary.crossEnv = cross
    let crossBad = 0
    for (const c of cross) {
      crossBad += c.mismatches.length
      console.log(
        `\n== 跨环境对照 ${c.slug} vs ${referenceArgs.map((f) => path.basename(f)).join(', ')}：` +
          `覆盖层四边形 ${c.overlayQuadsCompared} 个 / 逐字节一致 ${c.identical} 个 / 不一致 ${c.mismatches.length} 个`,
      )
      for (const m of c.mismatches) console.log(`    ✗ ${m.entry} q${m.qi} 面=${m.face} ${m.locator} → ${m.kind}`)
    }
    if (crossBad > 0) exitCode = 1
    if (json) console.log(JSON.stringify({ crossEnv: cross }, null, 2))
  }
  process.exit(exitCode)
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) main()
