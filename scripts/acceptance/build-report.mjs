#!/usr/bin/env node
/**
 * 验收报告汇总 —— `acceptance-report.json`（机器可读）+ `acceptance-report.md`（人读摘要）。
 *
 * 输入 = 一次运行的运行目录（由 `run-acceptance.ps1` 建立）：
 *   stages/*.json            各阶段片段（唯一接口，见 lib/evidence.mjs#stageFragment）
 *   pipeline-result.json     结构化结果（产物哈希 / 捕获统计 / 展开校验清单 / 配置面）
 *   exports/                 产物归档（含 expanded/ 与 _dataset/）
 *   web/*.json               playwright（json reporter）与 vitest 结果
 *   volume/*.json            体积曲线与 volume-profile 分桶
 *   interop/*.json           /sde export 互不干扰
 *   falsification/*.json     断言有效性证伪
 *   static-checks.json       静态判据（web 装配零游戏逻辑 / 无 GT 逻辑重放）
 *   screenshots/manifest.json 截图证据链
 *
 * 本工具**不跑任何东西**（纯读 + 判定），因此可以在任意时刻重算报告。
 *
 * 用法：
 *   node scripts/acceptance/build-report.mjs --run-dir <dir> [--compare-with <report.json>]
 *                                            [--out <report.json>] [--label <label>]
 * 退出码：0 = 报告算完；1 = 判定含 fail/not-run（**报告仍然落盘**）；2 = 运行目录不可用。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

import { assembleVariant, entrySignature, expectedCombinationKeys, readFixtureDocument } from '../multiblock-fixtures/lib.mjs'
import {
  compareProducts,
  ensureDir,
  fmtBytes,
  readJsonIfExists,
  readStageFragments,
  rel,
  REPO_ROOT,
  sha256File,
  snapshotDir,
  snapshotSummary,
  writeJson,
  writeText,
} from './lib/evidence.mjs'
import { CHECK_STAGE_DEPS, runChecklist } from './lib/checklist.mjs'

// ---------------------------------------------------------------------------
// 内层 body（**不合并 meta** —— 键白名单判据需要原始内层）
// ---------------------------------------------------------------------------
function decodeInner(envelope) {
  if (typeof envelope?.payload !== 'string') return null
  const bytes = Buffer.from(envelope.payload, 'base64')
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    try {
      return JSON.parse(gunzipSync(bytes).toString('utf8'))
    } catch {
      return null
    }
  }
}

const INNER_ALLOWED_KEYS = [
  'schemaVersion',
  'multiblockCount',
  'multiblock',
  'blockPalette',
  'materialPalette',
  'textureBlobs',
  'tooltipPalette',
  'frames',
]

const MULTIBLOCK_ALLOWED_KEYS = [
  'id',
  'displayName',
  'sourceClass',
  'hasScopeOverlap',
  'scopeOverlapNote',
  'totalTierDomain',
  'tierSample',
  'channels',
  'runstates',
  'couplingMode',
  'couplings',
  'notes',
  'viewerSemantics',
  'paletteSource',
  'geometryEncoding',
  'opsLegend',
  'backbone',
  'rules',
  'variants',
]

const FRAME_ALLOWED_KEYS = ['index', 'variant', 'runstate', 'stepIndex', 'rules', 'label', 'durationMs', 'cellGrid']

function unknownKeys(obj, allowed) {
  return Object.keys(obj ?? {}).filter((k) => !allowed.includes(k))
}

/** 单台产物的机器判据分析（信封 / 形态 / 帧 / 调色板并集 / 键白名单 / 声明完备性）。 */
export function analyzeProduct(filePath) {
  const envelope = readJsonIfExists(filePath)
  const inner = readFixtureDocument(envelope)
  const rawInner = decodeInner(envelope) ?? {}
  const mb = inner.multiblock
  const frames = inner.frames ?? []
  const palette = inner.blockPalette ?? []

  // 调色板并集：装配每个变体，收集用到的下标 + 内容签名重复
  const used = new Set()
  let cells = 0
  let assembleErrors = 0
  for (const v of mb.variants ?? []) {
    try {
      const r = assembleVariant(inner, v.key)
      cells += r.dims.w * r.dims.h * r.dims.d
      for (const layer of r.cellGrid) for (const row of layer) for (const idx of row) used.add(idx)
    } catch {
      assembleErrors++
    }
  }
  const sigs = new Set()
  let duplicateSignatures = 0
  for (const e of palette) {
    const s = entrySignature(e)
    if (sigs.has(s)) duplicateSignatures++
    else sigs.add(s)
  }

  // 声明完备性：声明集合必须恰好等于 笛卡尔积
  let declaredEqualsCartesian = false
  try {
    const expected = expectedCombinationKeys(inner).map((e) => e.key)
    const actual = (mb.variants ?? []).map((v) => v.key)
    declaredEqualsCartesian = expected.length === actual.length && actual.every((k) => expected.includes(k))
  } catch {
    declaredEqualsCartesian = false
  }

  return {
    file: rel(filePath),
    fileName: path.basename(filePath),
    slug: path.basename(filePath).replace(/\.multiblock\.json$/, ''),
    machine: mb.id ?? null,
    displayName: mb.displayName ?? null,
    N: (mb.variants ?? []).length,
    frames: frames.length,
    rules: (mb.rules ?? []).length,
    cells,
    runstates: (mb.runstates ?? []).map((r) => r.id),
    channels: (mb.channels ?? []).map((c) => ({ key: c.key, id: c.id, enum: c.enum ?? null, name: c.name ?? null, kind: c.kind, max: c.domain?.max ?? null })),
    couplingMode: mb.couplingMode ?? null,
    couplingsCount: (mb.couplings ?? []).length,
    couplingsIsArray: Array.isArray(mb.couplings),
    notesCount: (mb.notes ?? []).length,
    paletteEntries: palette.length,
    paletteUsed: used.size,
    paletteUnusedExcludingAir: palette.filter((_, i) => i !== 0 && !used.has(i)).length,
    paletteUnusedEntries: palette.filter((_, i) => i !== 0 && !used.has(i)).length,
    paletteAirUsed: used.has(0),
    duplicateSignatures,
    assembleErrors,
    declaredEqualsCartesian,
    framesWithOps: frames.filter((f) => f.ops !== undefined).length,
    framesWithCellGrid: frames.filter((f) => f.cellGrid !== undefined).length,
    frameKeysSubset: frames.every((f) => unknownKeys(f, FRAME_ALLOWED_KEYS).length === 0),
    frameKeysUnknown: [...new Set(frames.flatMap((f) => unknownKeys(f, FRAME_ALLOWED_KEYS)))],
    rootCellGrid: Object.prototype.hasOwnProperty.call(rawInner, 'cellGrid'),
    unknownInnerKeys: unknownKeys(rawInner, INNER_ALLOWED_KEYS),
    unknownMultiblockKeys: unknownKeys(mb, MULTIBLOCK_ALLOWED_KEYS),
    envelope: {
      documentFormat: envelope.documentFormat ?? null,
      payloadEncoding: envelope.payloadEncoding ?? null,
      documentShape: envelope.meta?.documentShape ?? null,
      payloadDecoded: Boolean(rawInner),
      innerHasMultiblock: Boolean(rawInner.multiblock),
      innerHasFrames: Array.isArray(rawInner.frames),
      innerHasPalette: Array.isArray(rawInner.blockPalette),
      innerKeys: Object.keys(rawInner),
      metaKeys: Object.keys(envelope.meta ?? {}),
      innerSha256: sha256File(filePath),
    },
  }
}

// ---------------------------------------------------------------------------
// playwright / vitest 结果摘要
// ---------------------------------------------------------------------------
export function summarizePlaywright(json) {
  const specs = {}
  const projects = {}
  let passed = 0
  let failed = 0
  let skipped = 0
  function walk(suite, inheritedFile) {
    const file = suite.file ?? inheritedFile ?? null
    for (const spec of suite.specs ?? []) {
      const f = spec.file ?? file ?? '(unknown)'
      const ok = spec.ok === true
      const entry = (specs[f] ??= { passed: 0, failed: 0, skipped: 0, titles: [], projects: {} })
      entry.titles.push(spec.title)
      if (ok) {
        entry.passed++
        passed++
      } else if ((spec.tests ?? []).every((t) => (t.results ?? []).every((r) => r.status === 'skipped'))) {
        entry.skipped++
        skipped++
      } else {
        entry.failed++
        failed++
      }
      for (const t of spec.tests ?? []) {
        const proj = t.projectName ?? '(default)'
        entry.projects[proj] = entry.projects[proj] ?? { passed: 0, failed: 0 }
        const projAll = projects[proj] ??= { passed: 0, failed: 0 }
        if (ok) {
          entry.projects[proj].passed++
          projAll.passed++
        } else {
          entry.projects[proj].failed++
          projAll.failed++
        }
      }
    }
    for (const s of suite.suites ?? []) walk(s, file)
  }
  for (const s of json?.suites ?? []) walk(s, null)
  return { present: Boolean(json), passed, failed, skipped, specs, projects, stats: json?.stats ?? null }
}

/** 帧为主的「warn/样例」语料也算通过（playwright 的 retries 会让结果带 flaky）。 */
function summarizeVitest(logText) {
  const text = logText ?? ''
  const m = /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed(?:\s*\((\d+)\))?/.exec(text)
  const files = /Test Files\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/.exec(text)
  const failedTests = m?.[1] ? Number(m[1]) : 0
  const passedTests = m?.[2] ? Number(m[2]) : null
  const failedFiles = files?.[1] ? Number(files[1]) : 0
  const passedFiles = files?.[2] ? Number(files[2]) : null
  return { present: text.length > 0, passedTests, failedTests, passedFiles, failedFiles, tail: text.split(/\r?\n/).slice(-12).join('\n') }
}

// ---------------------------------------------------------------------------
// 幂等：与最近一次历史归档的产物/展开文件哈希对比
// ---------------------------------------------------------------------------
export function previousArchives(pipelineOutRoot, currentLabel) {
  if (!fs.existsSync(pipelineOutRoot)) return []
  const out = []
  for (const name of fs.readdirSync(pipelineOutRoot)) {
    if (name === currentLabel || name.startsWith('_prev-') || name.startsWith('.')) continue
    const dir = path.join(pipelineOutRoot, name)
    const pr = path.join(dir, 'pipeline-result.json')
    if (!fs.existsSync(pr)) continue
    const j = readJsonIfExists(pr)
    if (!j || (j.products ?? []).length === 0) continue
    out.push({ label: name, dir, resultPath: pr, result: j, mtime: fs.statSync(pr).mtimeMs })
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

function buildIdempotency({ pipelineResult, exportRunLabel, compareWithPath, checks }) {
  const outRoot = path.join(REPO_ROOT, 'scripts/multiblock-pipeline/.out')
  const archives = previousArchives(outRoot, exportRunLabel)
  const prior = archives[0] ?? null
  const res = {
    exportRunLabel,
    priorRun: null,
    priorRunArtifact: prior?.resultPath ?? null,
    comparedWith: compareWithPath ?? null,
    verdictsMatch: null,
    perCheck: null,
  }
  if (prior) {
    const pc = compareProducts(pipelineResult?.products, prior.result.products)
    const A = (pipelineResult?.products ?? []).map((p) => ({ file: p.file, bytes: p.bytes, sha256: p.sha256 }))
    const B = (prior.result.products ?? []).map((p) => ({ file: p.file, bytes: p.bytes, sha256: p.sha256 }))
    const expandedA = pipelineResult?.expanded?.filesSha256 ?? []
    const expandedB = prior.result?.expanded?.filesSha256 ?? []
    const expMapB = new Map(expandedB.map((e) => [e.file, e.sha256]))
    const expandedAllSame =
      expandedA.length > 0 && expandedA.length === expandedB.length && expandedA.every((e) => expMapB.get(e.file) === e.sha256)
    res.priorRun = {
      label: prior.label,
      archiveDir: rel(prior.dir),
      productsA: A.length,
      productsB: B.length,
      allSame: pc.allSame,
      rows: pc.rows,
      expandedFilesA: expandedA.length,
      expandedFilesB: expandedB.length,
      expandedAllSame,
    }
  }
  if (compareWithPath && fs.existsSync(compareWithPath)) {
    const other = readJsonIfExists(compareWithPath)
    const otherById = new Map((other?.checks ?? []).map((c) => [c.id, c.status]))
    const perCheck = (checks ?? []).map((c) => ({
      id: c.id,
      statusA: c.status,
      statusB: otherById.get(c.id) ?? null,
      same: otherById.get(c.id) === c.status,
    }))
    res.perCheck = perCheck
    res.verdictsMatch = perCheck.length > 0 && perCheck.every((p) => p.same)
    res.otherVerdict = other?.verdict?.status ?? null
    res.otherGeneratedAt = other?.generatedAt ?? null
  }
  return res
}

// ---------------------------------------------------------------------------
// 报告主体
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const [k, v] = a.includes('=') ? a.slice(2).split(/=(.*)/s) : [a.slice(2), undefined]
    if (v !== undefined) out[k] = v
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i]
    else out[k] = true
  }
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const runDir = path.resolve(args['run-dir'] ?? path.join(REPO_ROOT, 'scripts/acceptance/.out/acceptance-latest'))
  if (!fs.existsSync(runDir)) {
    console.error(`运行目录不存在：${runDir}`)
    process.exit(2)
  }
  const outPath = args.out ? path.resolve(args.out) : path.join(runDir, 'acceptance-report.json')
  ensureDir(path.dirname(outPath))

  const fragments = readStageFragments(runDir)
  const stages = Object.fromEntries(fragments.map((f) => [f.id, f]))
  const runState = readJsonIfExists(path.join(runDir, 'run-state.json')) ?? {}

  const paths = {
    runDir,
    runState: path.join(runDir, 'run-state.json'),
    pipelineResult: path.join(runDir, 'pipeline-result.json'),
    exportsDir: path.join(runDir, 'exports'),
    verifyExpandedJson: path.join(runDir, 'verify-expanded.json'),
    contractReport: path.join(runDir, 'contract-validation.json'),
    volumeCurveJson: path.join(runDir, 'volume/volume-curve.json'),
    volumeCurveSvg: path.join(runDir, 'volume/volume-curve.svg'),
    volumeCurveMd: path.join(runDir, 'volume/volume-curve.md'),
    volumeProfileMd: path.join(runDir, 'volume/profile.md'),
    volumeProfileJson: path.join(runDir, 'volume/profile.json'),
    webRealJson: path.join(runDir, 'web/real-acceptance.json'),
    webSyntheticJson: path.join(runDir, 'web/synthetic.json'),
    webCrossJson: path.join(runDir, 'web/web-parser-cross-check.json'),
    vitestLog: path.join(runDir, 'logs/web-unit-vitest.log'),
    buildModLog: path.join(runDir, 'logs/build-mod-gtnh.log'),
    buildWebLog: path.join(runDir, 'logs/build-web.log'),
    staticChecksJson: path.join(runDir, 'static-checks.json'),
    falsificationJson: path.join(runDir, 'falsification/falsification.json'),
    interopJson: path.join(runDir, 'interop/interop.json'),
    reportJson: outPath,
    reportMd: path.join(runDir, 'acceptance-report.md'),
  }

  const pipelineResult = readJsonIfExists(paths.pipelineResult)

  // ---- 产物分析 ----
  const productFiles = fs.existsSync(paths.exportsDir)
    ? fs
        .readdirSync(paths.exportsDir)
        .filter((f) => f.endsWith('.multiblock.json') && !f.endsWith('.body.json'))
        .sort()
        .map((f) => path.join(paths.exportsDir, f))
    : []
  const productAnalysis = productFiles.map(analyzeProduct)

  // ---- web 结果 ----
  const realJson = readJsonIfExists(paths.webRealJson)
  const synthJson = readJsonIfExists(paths.webSyntheticJson)
  const vitestLog = fs.existsSync(paths.vitestLog) ? fs.readFileSync(paths.vitestLog, 'utf8') : ''
  const web = {
    realAcceptance: realJson ? { ...summarizePlaywright(realJson), exitCode: stages['web-real-acceptance']?.exitCode ?? null } : { present: false },
    synthetic: synthJson ? summarizePlaywright(synthJson) : { present: false },
    vitest: summarizeVitest(vitestLog),
    crossCheck: readJsonIfExists(paths.webCrossJson) ?? null,
  }
  if (web.crossCheck) {
    const r = web.crossCheck
    const docs = r.docs ?? []
    const diffTotal = docs.reduce((s, d) => s + (d.webDiffs ?? 0), 0)
    const variants = docs.reduce((s, d) => s + (d.variants ?? 0), 0)
    web.crossCheck = {
      ok: (r.failures ?? []).length === 0 && diffTotal === 0 && docs.length > 0,
      diffTotal,
      variants,
      documents: docs.length,
      failures: (r.failures ?? []).length,
      warnings: (r.warnings ?? []).length,
      tool: r.tool ?? null,
    }
  }

  // ---- 展开校验 / 契约校验 ----
  const verifyExpandedRaw = readJsonIfExists(paths.verifyExpandedJson)
  const verifyExpanded = verifyExpandedRaw
    ? {
        ok: (verifyExpandedRaw.failures ?? []).length === 0 && (verifyExpandedRaw.totalDiff ?? verifyExpandedRaw.diff ?? 0) === 0,
        diffTotal: verifyExpandedRaw.totalDiff ?? verifyExpandedRaw.diff ?? null,
        samples: verifyExpandedRaw.totalSamples ?? verifyExpandedRaw.samples ?? null,
        cells: verifyExpandedRaw.totalCells ?? verifyExpandedRaw.cells ?? null,
        signatureMapMisses: verifyExpandedRaw.signatureMapMisses ?? 0,
        signatureCollapsed: verifyExpandedRaw.signatureCollapsed ?? null,
        machines: verifyExpandedRaw.machines ?? null,
        raw: verifyExpandedRaw,
      }
    : null

  const contractRaw = readJsonIfExists(paths.contractReport)
  const contractValidation = contractRaw
    ? {
        exitCode: stages['contract-validate']?.exitCode ?? null,
        failures: contractRaw.failures ?? 0,
        warnings: contractRaw.warnings ?? 0,
        checksByPrefix: (() => {
          const byPrefix = {}
          for (const c of contractRaw.checks ?? []) {
            const prefix = String(c.id ?? '').split('/')[0]
            byPrefix[prefix] ??= { ok: 0, fail: 0 }
            if (c.status === 'fail') byPrefix[prefix].fail++
            else byPrefix[prefix].ok++
          }
          return byPrefix
        })(),
        shapeChecksOk: true,
        frameChecksOk: true,
        channelChecksOk: true,
        ruleChecksOk: true,
        volume: contractRaw.volume ?? [],
        raw: contractRaw,
      }
    : null
  if (contractValidation) {
    const p = contractValidation.checksByPrefix
    const okOrAbsent = (prefix) => (p[prefix] ? p[prefix].fail === 0 : true)
    contractValidation.shapeChecksOk = okOrAbsent('shape')
    contractValidation.frameChecksOk = okOrAbsent('frames')
    contractValidation.channelChecksOk = okOrAbsent('channels')
    contractValidation.ruleChecksOk = okOrAbsent('rules')
    contractValidation.backboneChecksOk = okOrAbsent('backbone')
  }

  const staticChecks = readJsonIfExists(paths.staticChecksJson)
  const volumeCurve = readJsonIfExists(paths.volumeCurveJson)
  const falsification = readJsonIfExists(paths.falsificationJson)
  const interop = readJsonIfExists(paths.interopJson)
  const shotsManifest = readJsonIfExists(path.join(runDir, 'screenshots/manifest.json'))
  const screenshots = shotsManifest
    ? { ...shotsManifest, archiveRel: rel(path.join(runDir, 'screenshots')), manifest: path.join(runDir, 'screenshots/manifest.json') }
    : null

  const exportsSnapshot = fs.existsSync(paths.exportsDir)
    ? snapshotDir(paths.exportsDir, { base: paths.exportsDir, filter: (f) => !f.includes(`${path.sep}_dataset${path.sep}`) })
    : []

  const ctx = {
    mode: runState.mode ?? 'acceptance',
    runDir,
    paths,
    productFiles,
    productAnalysis,
    pipelineResult,
    verifyExpanded,
    contractValidation,
    staticChecks,
    volumeCurve,
    falsification,
    interop,
    web,
    screenshots,
    stages,
    stageList: fragments,
    interactivity: runState.interactivity ?? null,
    idempotency: null,
    checks: [],
  }

  // 先跑一遍清单（幂等判据需要 checks 参与 -CompareWith 的逐条比对）
  ctx.checks = runChecklist(ctx)
  /**
   * 依赖阶段缺失 → 该清单项记 `not-run`（**不静默算通过**，也不误报为"违反判据"）。
   * 对 `pass` 与 `fail` 都适用：输入没跑出来时，红的原因应是"阶段未运行"，而不是"判据被违反"。
   * `na` 保持不动（它是"本子集/本编排无法行使"的显式声明）。
   */
  const applyStageDeps = (checks) => {
    for (const c of checks) {
      if (c.status === 'na') continue
      const deps = CHECK_STAGE_DEPS[c.id] ?? []
      const missing = deps.filter((d) => !stages[d] || stages[d].status === 'not-run')
      if (missing.length === 0) continue
      const original = c.status
      c.status = 'not-run'
      c.detail = `依赖阶段未运行：${missing.join(', ')}（原判据结论 ${original}：${c.detail ?? ''}）`
    }
  }
  applyStageDeps(ctx.checks)

  ctx.idempotency = buildIdempotency({
    pipelineResult,
    exportRunLabel: runState.exportRunLabel ?? runState.label ?? null,
    compareWithPath: args['compare-with'] ? path.resolve(args['compare-with']) : null,
    checks: ctx.checks,
  })
  // 幂等项依赖 checks（-CompareWith 的逐条比对），故重跑一次
  ctx.checks = runChecklist(ctx)
  applyStageDeps(ctx.checks)

  const redChecks = ctx.checks.filter((c) => c.status === 'fail' || c.status === 'not-run')
  const naChecks = ctx.checks.filter((c) => c.status === 'na')
  const counts = {
    pass: ctx.checks.filter((c) => c.status === 'pass').length,
    fail: ctx.checks.filter((c) => c.status === 'fail').length,
    na: naChecks.length,
    notRun: ctx.checks.filter((c) => c.status === 'not-run').length,
  }
  const isSample = ctx.mode === 'sample'
  const verdictStatus = isSample ? 'sample' : redChecks.length === 0 ? 'pass' : 'fail'
  const exitCode = isSample ? 0 : verdictStatus === 'pass' ? 0 : 1

  const stageTimings = Object.fromEntries(fragments.map((f) => [f.id, f.durationMs ?? null]))
  const totalMs = fragments.reduce((s, f) => s + (f.durationMs ?? 0), 0)

  const report = {
    schema: 'lightning.acceptance.multiblock/1',
    generatedAt: new Date().toISOString(),
    label: runState.label ?? path.basename(runDir),
    mode: ctx.mode,
    verdict: {
      status: verdictStatus,
      exitCode,
      counts,
      redChecks: redChecks.map((c) => ({ id: c.id, status: c.status, detail: c.detail })),
      naChecks: naChecks.map((c) => ({ id: c.id, detail: c.detail })),
      note: isSample
        ? '样例模式：报告由既有产物回放生成，仅用于校验报告 schema 与判据实现，**不构成验收结论**。'
        : verdictStatus === 'pass'
          ? '全部 23 条把关清单项由机器判据给出，无 fail / not-run。'
          : '存在 fail / not-run 条目（见 redChecks），不得以"人工看过"替代。',
    },
    scope: {
      mode: runState.scopeMode ?? 'default-subset-5',
      explicitNonFull: true,
      machines: (pipelineResult?.products ?? []).map((p) => p.slug),
      variants: pipelineResult?.variantsTested ?? (pipelineResult?.products ?? []).reduce((s, p) => s + (p.variants ?? 0), 0),
      fullRunEstimate: runState.fullRunEstimate ?? {
        basis: '实测：279.5 ms/变体，全量不裁剪 5,551,258 变体 ≈ 431 h；默认上限下 ≈ 32 h',
        uncappedHours: 431,
        cappedHours: 32,
        note: '验收范围 = 默认子集 5 台（非全量）；全量验收范围待用户裁定',
      },
      adjudications: runState.adjudications ?? [],
    },
    stages: fragments.map((f) => ({
      id: f.id,
      name: f.name,
      command: f.command,
      exitCode: f.exitCode,
      status: f.status,
      durationMs: f.durationMs,
      startedAt: f.startedAt,
      endedAt: f.endedAt,
      gates: f.gates,
      artifacts: f.artifacts,
      evidence: f.evidence,
      notes: f.notes,
      data: f.data,
    })),
    checks: ctx.checks,
    products: (pipelineResult?.products ?? []).map((p) => ({
      file: p.file,
      slug: p.slug,
      machine: p.machine,
      variants: p.variants,
      bytes: p.bytes,
      sha256: p.sha256,
    })),
    productsTotalBytes: (pipelineResult?.products ?? []).reduce((s, p) => s + (p.bytes ?? 0), 0),
    exportsSnapshotSummary: snapshotSummary(exportsSnapshot),
    expanded: pipelineResult?.expanded
      ? {
          enabled: pipelineResult.expanded.enabled,
          machines: pipelineResult.expanded.machines,
          samples: pipelineResult.expanded.samples,
          files: pipelineResult.expanded.files,
          manifest: rel(pipelineResult.expanded.manifest),
          fileHashes: (pipelineResult.expanded.filesSha256 ?? []).length,
          sampleList: pipelineResult.expanded.sampleList ?? [],
        }
      : null,
    capture: pipelineResult?.timing?.captureTotals ?? null,
    diff: {
      verifyExpanded: verifyExpanded
        ? { ok: verifyExpanded.ok, diffTotal: verifyExpanded.diffTotal, samples: verifyExpanded.samples, cells: verifyExpanded.cells, report: rel(paths.verifyExpandedJson) }
        : null,
      webRealAcceptance: web.realAcceptance?.present
        ? { passed: web.realAcceptance.passed, failed: web.realAcceptance.failed, report: rel(paths.webRealJson) }
        : null,
      webAssemblyCrossCheck: web.crossCheck,
      screenshotPixels: web.realAcceptance?.present ? { spec: 'multiblock-real-acceptance', report: rel(paths.webRealJson) } : null,
    },
    contractValidation: contractValidation
      ? { failures: contractValidation.failures, warnings: contractValidation.warnings, checksByPrefix: contractValidation.checksByPrefix, report: rel(paths.contractReport) }
      : null,
    volumeCurve: volumeCurve
      ? {
          verdict: volumeCurve.verdict,
          criterion: volumeCurve.criterion,
          kappaStepLimit: volumeCurve.kappaStepLimit,
          series: volumeCurve.series.map((s) => ({
            id: s.id,
            name: s.name,
            axis: s.axis,
            status: s.status,
            points: s.points,
            extended: s.extended,
            R1: { status: s.R1.status, pairs: s.R1.pairs },
            R2: { status: s.R2.status, branch: s.R2.branch, fit: s.R2.fit, variablePart: s.R2.variablePart, gateRequired: s.R2.gateRequired, gateSatisfied: s.R2.gateSatisfied, reason: s.R2.reason, marginalDeclarationBytesPerVariant: s.R2.marginalDeclarationBytesPerVariant },
            R3: { status: s.R3.status, pairs: s.R3.pairs },
          })),
          risk4: volumeCurve.risk4,
          products: volumeCurve.products,
          contractKSequence: volumeCurve.contractKSequence,
          criterionNotes: volumeCurve.criterionNotes,
          artifacts: { json: rel(paths.volumeCurveJson), svg: rel(paths.volumeCurveSvg), md: rel(paths.volumeCurveMd), profile: rel(paths.volumeProfileMd) },
        }
      : null,
    falsification: falsification
      ? { controls: falsification.controls, webSpec: web.synthetic?.specs?.['multiblock-falsification.spec.ts'] ?? null, report: rel(paths.falsificationJson) }
      : null,
    interop: interop ?? null,
    idempotency: ctx.idempotency,
    web: {
      realAcceptance: web.realAcceptance?.present
        ? { passed: web.realAcceptance.passed, failed: web.realAcceptance.failed, projects: web.realAcceptance.projects, specs: web.realAcceptance.specs, report: rel(paths.webRealJson) }
        : { present: false, reason: stages['web-real-acceptance']?.notes?.join('; ') ?? 'spec 未运行' },
      synthetic: web.synthetic?.present
        ? { passed: web.synthetic.passed, failed: web.synthetic.failed, projects: web.synthetic.projects, specs: web.synthetic.specs, report: rel(paths.webSyntheticJson) }
        : { present: false },
      vitest: web.vitest,
    },
    staticChecks: staticChecks ?? null,
    screenshots: screenshots
      ? {
          archiveDir: screenshots.archiveRel,
          convention: screenshots.convention,
          count: screenshots.count,
          bytes: screenshots.bytes,
          manifest: rel(screenshots.manifest),
          byStage: screenshots.byStage ?? null,
        }
      : null,
    sampling: {
      expandedSampleList: pipelineResult?.expanded?.sampleList ?? null,
      volumeSeries: volumeCurve?.series?.map((s) => ({ id: s.id, points: s.points.map((p) => p.file) })) ?? null,
      webRealSampling: web.realAcceptance?.present ? { report: rel(paths.webRealJson) } : null,
      falsificationControls: falsification?.controls?.map((c) => c.id) ?? null,
    },
    timings: { totalMs, perStage: stageTimings, pipelineResult: pipelineResult?.timing ?? null },
    environment: {
      cofhConf: pipelineResult?.environment?.cofhConfCheck?.found ?? null,
      world: pipelineResult?.environment?.world?.folder ?? null,
      fmlQueryResult: pipelineResult?.environment?.fmlQueryResult ?? null,
      os: pipelineResult?.environment?.os ?? null,
      git: runState.git ?? null,
      node: process.version,
      interactivity: ctx.interactivity,
    },
    openItems: runState.openItems ?? [],
    criterionNotes: volumeCurve?.criterionNotes ?? [],
    evidenceLayout: {
      runDir: rel(runDir),
      report: rel(outPath),
      stages: rel(path.join(runDir, 'stages')),
      logs: rel(path.join(runDir, 'logs')),
      exports: rel(paths.exportsDir),
      screenshots: rel(path.join(runDir, 'screenshots')),
      volume: rel(path.join(runDir, 'volume')),
      web: rel(path.join(runDir, 'web')),
      interop: rel(path.join(runDir, 'interop')),
      falsification: rel(path.join(runDir, 'falsification')),
    },
  }

  writeJson(outPath, report)
  writeText(paths.reportMd, mdSummary(report) + '\n')

  console.log(`[acceptance] 报告：${outPath}`)
  console.log(`  判定：${verdictStatus}（pass ${counts.pass} / fail ${counts.fail} / na ${counts.na} / not-run ${counts.notRun}）`)
  for (const c of redChecks) console.log(`  XX [${c.status}] ${c.id} — ${c.detail}`)
  for (const c of naChecks) console.log(`  -- [na] ${c.id} — ${c.detail}`)
  console.log(`  人读摘要：${paths.reportMd}`)
  process.exit(isSample ? 0 : verdictStatus === 'pass' ? 0 : 1)
}

function mdSummary(report) {
  const L = []
  L.push(`# 多方块验收报告（${report.label}）`)
  L.push('')
  L.push(`> schema \`${report.schema}\`；生成 ${report.generatedAt}；模式 \`${report.mode}\``)
  L.push(`> 判定 **${report.verdict.status}** —— ${report.verdict.note}`)
  L.push('')
  L.push(`范围：${report.scope.mode}（**非全量**），机器 ${report.scope.machines.length} 台 / 变体 ${report.scope.variants}；全量估算 ${report.scope.fullRunEstimate.cappedHours}h@上限、${report.scope.fullRunEstimate.uncappedHours}h@不裁剪。`)
  L.push('')
  L.push('## 把关清单逐条映射')
  L.push('')
  L.push('| # | 段落 | 清单项 | 判定 | 摘要 | 证据 |')
  L.push('|---:|---|---|---|---|---|')
  report.checks.forEach((c, i) => {
    L.push(
      `| ${i + 1} | ${c.section} | ${c.text} | **${c.status}** | ${(c.detail ?? '').replace(/\|/g, '\\|').slice(0, 220)} | ${(c.evidence ?? []).map((e) => `\`${e}\``).join('<br>')} |`,
    )
  })
  L.push('')
  L.push('## 阶段与耗时')
  L.push('')
  L.push('| 阶段 | 状态 | 退出码 | 耗时 | 命令 |')
  L.push('|---|---|---:|---:|---|')
  for (const s of report.stages) {
    L.push(`| ${s.id} | ${s.status} | ${s.exitCode ?? '—'} | ${s.durationMs ? `${(s.durationMs / 1000).toFixed(1)}s` : '—'} | \`${(s.command ?? '').replace(/\|/g, '\\|')}\` |`)
  }
  L.push('')
  L.push(`总耗时（阶段之和）：${(report.timings.totalMs / 1000 / 60).toFixed(1)} min`)
  L.push('')
  if (report.volumeCurve) {
    L.push('## 体积曲线')
    L.push('')
    L.push(`总判定 **${report.volumeCurve.verdict.status}**（安全系数 λ=${report.volumeCurve.criterion.safetyFactor}）`)
    L.push('')
    for (const s of report.volumeCurve.series) {
      L.push(`- \`${s.id}\`（${s.axis}）：${s.status}；R1=${s.R1.status} R2=${s.R2.status}${s.R2.fit ? `（G ≈ ${s.R2.fit.a.toFixed(0)} + ${s.R2.fit.b.toFixed(2)}·N，R²=${s.R2.fit.r2.toFixed(4)}）` : ''} R3=${s.R3.status}`)
    }
    if (report.volumeCurve.risk4) {
      L.push(`- 风险 4（调色板并集占比）：${report.volumeCurve.risk4.status}；最高 ${report.volumeCurve.risk4.worst?.file} = ${(report.volumeCurve.risk4.worst?.paletteShare * 100).toFixed(1)}%`)
    }
    L.push(`- 产物：\`${report.volumeCurve.artifacts.json}\`、\`${report.volumeCurve.artifacts.svg}\`、\`${report.volumeCurve.artifacts.md}\``)
    L.push('')
  }
  L.push('## 产物哈希')
  L.push('')
  L.push('| 文件 | 变体 | 字节 | SHA-256 |')
  L.push('|---|---:|---:|---|')
  for (const p of report.products) L.push(`| ${p.file} | ${p.variants} | ${p.bytes} | \`${p.sha256.slice(0, 32)}…\` |`)
  L.push('')
  if (report.idempotency?.priorRun) {
    L.push(`幂等：与归档 \`${report.idempotency.priorRun.label}\` 对比 —— 产物 ${report.idempotency.priorRun.allSame ? '逐字节一致' : '**有差异**'}；展开文件 ${report.idempotency.priorRun.expandedAllSame ? '逐字节一致' : '**有差异**'}`)
    L.push('')
  }
  if (report.screenshots) {
    L.push(`截图证据链：${report.screenshots.count} 张 / ${fmtBytes(report.screenshots.bytes)} → \`${report.screenshots.archiveDir}\`（清单 \`${report.screenshots.manifest}\`）`)
    L.push('')
  }
  if ((report.openItems ?? []).length > 0) {
    L.push('## 开放项')
    L.push('')
    for (const o of report.openItems) L.push(`- **${o.id}**（${o.severity}）：${o.text}`)
    L.push('')
  }
  return L.join('\n')
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) main()

export { main as buildAcceptanceReport }
