/**
 * 编码 × web 交叉验证：**用 web 侧真实解析器与装配器**读因子化编码产物。
 *
 *   node scripts/multiblock-encode/verify-web-parser.mjs <encodedDir> <datasetDir>
 *
 * 做法：用 esbuild（web/node_modules 里已有）把 web 侧真实模块按 `@` 别名捆绑成临时 ESM，
 * 再在 Node 里调用 —— **不修改 web/ 下任何文件**（零写范围的越界）。
 *
 * 断言：
 *   1. `MultiblockParser.detect(envelope)`（形态判别）为 true；
 *   2. `readEnvelopeLayers`（既有信封解包：base64 → gzip → JSON + meta 合并）成功；
 *   3. `parseMultiblockDeclaration(inner)` 不抛错，通道/运行态/变体/帧条数与工具统计一致；
 *   4. `RuntimeDocument.fromV2Plain(plain, {multiblockSource: inner})` 承载多方块声明；
 *   5. **web 装配器**对全部变体装配出的 cellGrid 与捕获数据集 ground-truth 逐格一致
 *      （内容层：全局下标 → 产物下标，经条目内容签名映射）。
 *
 * 退出码：0 = 全绿；1 = 有硬失败；2 = 路径错误。
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { entrySignature } from '../multiblock-fixtures/lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const WEB = join(REPO, 'web')

const argv = process.argv.slice(2)
const encodedDir = argv[0]
const datasetDir = argv[1]
if (!encodedDir || !datasetDir) {
  console.error('用法: node scripts/multiblock-encode/verify-web-parser.mjs <encodedDir> <datasetDir>')
  process.exit(2)
}

const failures = []
const warnings = []
const fail = (w, m) => failures.push(`[${w}] ${m}`)
const warn = (w, m) => warnings.push(`[${w}] ${m}`)

// ---------------------------------------------------------------------------
// 1) 用 esbuild 把 web 侧真实模块捆成临时 ESM
// ---------------------------------------------------------------------------

const outDir = join(HERE, '.out')
mkdirSync(outDir, { recursive: true })
const bundlePath = join(outDir, 'web-parser-bundle.mjs')

const esbuildEntry = pathToFileURL(join(WEB, 'node_modules', 'esbuild', 'lib', 'main.js')).href
const esbuild = await import(esbuildEntry)
await esbuild.build({
  stdin: {
    contents: `
export { isMultiblockShapeDocument, isMultiblockDocument, parseMultiblockDeclaration, readDocumentShape, MULTIBLOCK_DOCUMENT_SHAPE } from '@/context/parsers/multiblockDocument'
export { MultiblockParser } from '@/context/parsers/multiblockParser'
export { readEnvelopeLayers, isEnvelopeDocument } from '@/render/data/compactSceneDocument'
export { RuntimeDocument } from '@/context/runtimeDocument'
export { assembleVariant, listChannels, listRunstates } from '@/context/multiblock'
`,
    resolveDir: WEB,
    sourcefile: 't14-web-parser-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  alias: { '@': join(WEB, 'src') },
  outfile: bundlePath,
  logLevel: 'warning',
})
const web = await import(pathToFileURL(bundlePath).href)
console.log(`[web] 已捆绑 web 侧真实模块 → ${bundlePath}`)

// ---------------------------------------------------------------------------
// 2) ground truth（与 verify-encoded.mjs 同口径）
// ---------------------------------------------------------------------------

const datasetPalette = JSON.parse(readFileSync(join(datasetDir, 'palette.json'), 'utf8')).blockPalette
const datasetPaletteSig = datasetPalette.map((e) => entrySignature(e))
const datasetBySlug = new Map()
for (const f of readdirSync(join(datasetDir, 'machines'))) {
  if (!f.endsWith('.json')) continue
  const j = JSON.parse(readFileSync(join(datasetDir, 'machines', f), 'utf8'))
  datasetBySlug.set(
    basename(f, '.json'),
    j.variants.map((v) => ({
      key: v.key,
      values: { ...(v.values ?? {}) },
      totalTier: v.totalTier,
      runstate: v.runstate,
      cellGrid: v.grid.cellGrid,
    })),
  )
}

function globalToDocMap(docPalette) {
  const bySig = new Map()
  docPalette.forEach((e, i) => {
    const sig = entrySignature(e)
    if (!bySig.has(sig)) bySig.set(sig, i)
  })
  return datasetPaletteSig.map((sig) => (bySig.has(sig) ? bySig.get(sig) : -1))
}

function translate(grid, map) {
  return grid.map((slice) => slice.map((row) => row.map((v) => map[v])))
}

function gridEquals(a, b) {
  if (a.length !== b.length) return 'z 长度不同'
  for (let z = 0; z < a.length; z++) {
    for (let y = 0; y < a[z].length; y++) {
      for (let x = 0; x < a[z][y].length; x++) {
        if (a[z][y][x] !== b[z][y][x]) {
          return `(x=${x},y=${y},z=${z})：web 装配=${a[z][y][x]} ground-truth=${b[z][y][x]}`
        }
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 3) 逐文档验证
// ---------------------------------------------------------------------------

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    try {
      if (readdirSync(p)) out.push(...walk(p))
    } catch {
      if (e.endsWith('.multiblock.json')) out.push(p)
    }
  }
  return out
}

const docs = []
for (const file of walk(encodedDir).sort()) {
  const name = basename(file, '.multiblock.json')
  const envelope = JSON.parse(readFileSync(file, 'utf8'))
  const row = { name, detect: false, parse: false, runtime: false, variants: 0, webDiffs: 0, notes: [] }

  // ---- 1. 形态判别（MultiblockParser.detect）----
  const detect = web.MultiblockParser.detect(envelope)
  row.detect = detect
  if (!detect) fail(name, 'MultiblockParser.detect(envelope) = false（web 判别器不认这份产物）')
  if (web.readDocumentShape(envelope) !== web.MULTIBLOCK_DOCUMENT_SHAPE) {
    fail(name, `readDocumentShape=${String(web.readDocumentShape(envelope))}，应为 "multiblock"（来自信封 meta）`)
  }
  if (!web.isEnvelopeDocument(envelope)) fail(name, 'isEnvelopeDocument = false（既有信封判定不认）')

  // ---- 2. 既有信封解包 + 声明解析 ----
  let layers
  try {
    layers = await web.readEnvelopeLayers(envelope)
  } catch (e) {
    fail(name, `readEnvelopeLayers 失败: ${e.message}`)
    docs.push(row)
    continue
  }
  const inner = layers.inner
  if (!inner.multiblock || inner.multiblockCount !== 1) {
    fail(name, `内层缺 multiblock/multiblockCount（inner keys: ${Object.keys(inner).join(',')}）`)
  }
  if (Array.isArray(inner.cellGrid)) fail(name, '内层带根级 cellGrid（形态互斥违反）')
  let decl
  try {
    decl = web.parseMultiblockDeclaration(inner)
    row.parse = true
  } catch (e) {
    fail(name, `parseMultiblockDeclaration 抛错: ${e.message}`)
    docs.push(row)
    continue
  }
  if (decl.decl.channels.length !== (inner.multiblock.channels ?? []).length) {
    fail(name, 'parseMultiblockDeclaration 通道数与原文不一致')
  }
  if (decl.warnings.length > 0) warn(name, `web 解析器警告 ${decl.warnings.length} 条：${decl.warnings.slice(0, 2).join(' / ')}`)
  row.channels = decl.decl.channels.map((c) => `${c.key}:${c.kind}`)
  row.runstates = decl.decl.runstates.map((r) => `${r.id}「${r.name}」`)
  row.variantCount = decl.decl.variants.length
  row.frameCount = decl.frames.length
  row.steps = decl.decl.backbone.sizeSteps.length

  // ---- 3. RuntimeDocument 承载 ----
  try {
    const rt = web.RuntimeDocument.fromV2Plain(layers.plain, { multiblockSource: inner })
    const mb = rt.multiblock ?? rt.getMultiblock?.()
    if (!mb) fail(name, 'RuntimeDocument 未承载 multiblock 声明（解析器接口）')
    else {
      row.runtime = true
      const rtVariants = mb.decl?.variants?.length ?? mb.variants?.length ?? 0
      if (rtVariants !== row.variantCount) {
        fail(name, `RuntimeDocument 变体数 ${rtVariants} ≠ 声明 ${row.variantCount}`)
      }
    }
  } catch (e) {
    fail(name, `RuntimeDocument.fromV2Plain 失败: ${e.message}`)
  }

  // ---- 4. web 装配器逐格比对 ----
  let groundTruth
  if (datasetBySlug.has(name)) {
    groundTruth = datasetBySlug.get(name)
  } else {
    const gt = JSON.parse(readFileSync(file.replace(/\.multiblock\.json$/, '.groundtruth.json'), 'utf8'))
    groundTruth = gt.variants.map((v) => ({
      key: v.key,
      values: { ...(v.values ?? {}) },
      totalTier: v.totalTier,
      runstate: v.runstate,
      cellGrid: v.cellGrid,
    }))
  }
  const map = globalToDocMap(inner.blockPalette ?? [])
  let diffs = 0
  let firstDiff = null
  for (const gt of groundTruth) {
    const expected = translate(gt.cellGrid, map)
    if (expected.some((s) => s.some((r) => r.some((v) => v < 0)))) {
      fail(name, `变体 ${gt.key} 的 ground-truth 含产物调色板里不存在的方块状态`)
      diffs++
      continue
    }
    let res
    try {
      res = web.assembleVariant(inner, gt.key)
    } catch (e) {
      fail(name, `web assembleVariant(${gt.key}) 抛错: ${e.message}`)
      diffs++
      continue
    }
    const cellGrid = res.cellGrid ?? res.grid?.cells?.map?.((s) => s.map((r) => r.map((c) => c?.paletteIndex ?? 0)))
    if (!cellGrid) {
      fail(name, `web assembleVariant 返回值里找不到 cellGrid（keys: ${Object.keys(res).join(',')}）`)
      diffs++
      continue
    }
    const d = gridEquals(cellGrid, expected)
    if (d) {
      diffs++
      if (!firstDiff) firstDiff = `${gt.key}: ${d}`
    }
  }
  row.variants = groundTruth.length
  row.webDiffs = diffs
  if (diffs > 0) fail(name, `web 装配器逐格 diff 非零：${diffs}/${groundTruth.length}；首个 ${firstDiff}`)
  docs.push(row)
  console.log(
    `  ${name.padEnd(30)} detect=${detect} parse=${row.parse} runtime=${row.runtime} ` +
      `通道=${row.channels?.length ?? 0} 变体=${row.variants} webDiff=${diffs}`,
  )
}

// ---------------------------------------------------------------------------
// 4) 报告
// ---------------------------------------------------------------------------

const totalVariants = docs.reduce((a, d) => a + d.variants, 0)
const totalDiffs = docs.reduce((a, d) => a + d.webDiffs, 0)
console.log('\n' + '─'.repeat(96))
console.log(`web 侧解析/装配合计：文档 ${docs.length} 份、变体 ${totalVariants} 个、逐格 diff ${totalDiffs}`)
if (warnings.length > 0) {
  console.log(`▲ 警告 ${warnings.length}`)
  for (const w of warnings) console.log('  ' + w)
}
if (failures.length > 0) {
  console.log(`✘ 硬失败 ${failures.length}`)
  for (const f of failures) console.log('  ' + f)
} else {
  console.log('✅ 全绿：web 判别/解析/RuntimeDocument/装配器全部与 ground-truth 一致')
}
writeFileSync(
  join(encodedDir, 'web-parser-report.json'),
  JSON.stringify({ tool: 'verify-web-parser.mjs（因子化编码）', docs, failures, warnings }, null, 1),
  'utf8',
)
process.exit(failures.length === 0 ? 0 : 1)
