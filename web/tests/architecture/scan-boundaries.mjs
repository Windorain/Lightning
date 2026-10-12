#!/usr/bin/env node
/**
 * 架构边界扫描器 —— **可执行入口**（#249 §14 A01 设施本体）。
 *
 * ```
 * node web/tests/architecture/scan-boundaries.mjs            # 扫描本树，人读报告
 * node web/tests/architecture/scan-boundaries.mjs --json     # 机器可读报告到 stdout
 * node web/tests/architecture/scan-boundaries.mjs --out <p>  # 报告落盘
 * ```
 *
 * 退出码：`0` = 闸门全绿；`1` = 有闸门 finding（判红）；`2` = 设施自身出错。
 *
 * ## 与测试的关系
 *
 * 本文件是**设施**（可单独跑、可进 CI）；`boundary-scan.test.ts` 是它的 vitest 接线，
 * 使 `npm test` 自动覆盖。负对照见 `boundary-scan-negative-control.test.ts` ——
 * 注入一条合成的违规**类型导入**，断言规则确实判红（#249 A01「注入一条违规类型导入也失败」）。
 *
 * ## 两类输出的纪律
 *
 * - **闸门（GATE）**：新边界，必须 0 finding；否则 FAIL 且退出码 1。
 * - **债务（DEBT）**：#249 §15 的既有待退役事实，**只计数与归属**，不影响退出码。
 *   把它算进 FAIL 会把"后续批次的活"误报成本批不合格；把它藏起来则是掩盖。
 *
 * ## 空洞真的显式披露
 *
 * 闸门规则的执行面是**新分层目录**，而本批（P0）不建它们（#249 §4）。
 * 于是"无违规"与"无物可违"数值相同 —— 报告给每条规则 `evaluatedFiles`，
 * 为 0 时标 `vacuous: true`，摘要里明说"不构成边界已生效的证据"。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  GATE_RULES,
  LAYER_DESTINATIONS,
  LAYERS,
  RETIREMENT_OWNERS,
  collectLegacyDebt,
  corePurityFileSet,
  isGateFile,
  resolveGateLayers,
  topLayer,
} from './boundary-rules.mjs'
import { buildAstIndex, buildModuleGraph, WEB_ROOT, SRC_ROOT } from './module-graph.mjs'

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const outIdx = argv.indexOf('--out')
const outPath = outIdx >= 0 ? argv[outIdx + 1] : null

function isProductionRel(rel) {
  if (rel.startsWith('..')) return false
  if (rel.split('/').slice(0, -1).includes('__tests__')) return false
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)) return false
  if (/\.d\.ts$/.test(rel)) return false
  return true
}

function main() {
  const { files, facts } = buildModuleGraph()

  const produced = (f) => isProductionRel(path.relative(SRC_ROOT, f).replace(/[\\/]+/g, '/'))
  const productionFiles = files.filter(produced)
  const productionFacts = facts.filter((f) => produced(f.fromFile))

  const { active, absent, legacyCollisions } = resolveGateLayers(SRC_ROOT)
  const gateFiles = new Set(active)
  const coreFiles = corePurityFileSet(SRC_ROOT)
  const ctx = { srcRoot: SRC_ROOT, webRoot: WEB_ROOT, gateFiles, gateLayers: LAYERS, coreFiles, layerCollisions: legacyCollisions }

  const isGate = (f) => isGateFile(path.relative(SRC_ROOT, f).replace(/[\\/]+/g, '/'), gateFiles)

  // ── 闸门 ──
  const gateReports = []
  const findings = []
  for (const rule of GATE_RULES) {
    const evaluatedFiles = rule.needsAst
      ? productionFiles.filter(isGate).length
      // 纯核心规则（`gate/core-*`）的执行面是 `coreFiles`，其余是 `gateFiles`。
      // 用前缀而不是逐个 id 列举：新增 `gate/core-*` 规则时自动落在正确的面上。
      : productionFiles.filter((f) => (rule.id.startsWith('gate/core-') ? coreFiles.has(path.relative(SRC_ROOT, f).replace(/[\\/]+/g, '/')) : isGate(f))).length
    const hits = rule.check(productionFacts, ctx)
    findings.push(...hits)
    gateReports.push({
      id: rule.id,
      title: rule.title,
      criterion: rule.criterion,
      findings: hits.length,
      evaluatedFiles,
      vacuous: evaluatedFiles === 0,
    })
  }

  // AST 类闸门规则
  const astIndex = buildAstIndex(productionFiles)
  for (const rule of GATE_RULES) {
    if (!rule.needsAst) continue
    const hits = rule.checkWithAst(astIndex, ctx)
    findings.push(...hits)
    const rec = gateReports.find((r) => r.id === rule.id)
    if (rec) {
      rec.findings = hits.length
      rec.evaluatedFiles = productionFiles.filter((f) => coreFiles.has(path.relative(SRC_ROOT, f).replace(/[\\/]+/g, '/'))).length
      rec.vacuous = rec.evaluatedFiles === 0
    }
  }

  // ── 事实摘要 ──
  const factsByKind = {}
  for (const f of productionFacts) factsByKind[f.kind] = (factsByKind[f.kind] ?? 0) + 1
  const externalByPackage = {}
  for (const f of productionFacts) {
    if (/^[.@]|^\//.test(f.specifier)) continue
    const pkg = f.specifier.startsWith('@')
      ? f.specifier.split('/').slice(0, 2).join('/')
      : f.specifier.split('/')[0]
    externalByPackage[pkg] = (externalByPackage[pkg] ?? 0) + 1
  }

  // ── 债务 ──
  const debt = collectLegacyDebt(productionFacts, ctx, astIndex)

  const report = {
    facility: 'architecture-boundaries',
    criterion: '#249 §14 A01；§4 导入规则；§15 退役矩阵',
    scannedAt: new Date().toISOString(),
    webRoot: WEB_ROOT,
    sourceFiles: files.length,
    productionFiles: productionFiles.length,
    importFacts: productionFacts.length,
    factsByKind,
    externalByPackage,
    gateFiles: active,
    absentLayers: absent,
    layerCollisions: legacyCollisions,
    layerDestinations: LAYER_DESTINATIONS,
    gate: {
      rules: gateReports,
      findings,
      verdict: findings.length === 0 ? 'pass' : 'fail',
      vacuousRules: gateReports.filter((r) => r.vacuous).map((r) => r.id),
    },
    debt: {
      counts: Object.fromEntries(Object.entries(debt).map(([k, v]) => [k, v.length])),
      items: debt,
      owners: RETIREMENT_OWNERS,
    },
    verdict: findings.length === 0 ? 'pass' : 'fail',
  }

  const text = renderText(report)
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true })
    fs.writeFileSync(path.resolve(outPath), asJson ? JSON.stringify(report, null, 2) : text, 'utf8')
  }
  process.stdout.write((asJson ? JSON.stringify(report, null, 2) : text) + '\n')
  process.exit(report.verdict === 'pass' ? 0 : 1)
}

function renderText(r) {
  const L = []
  L.push('架构边界扫描（#249 §14 A01 设施本体）')
  L.push('='.repeat(76))
  L.push(`web 根              : ${r.webRoot}`)
  L.push(`源文件              : ${r.sourceFiles}（生产文件 ${r.productionFiles}）`)
  L.push(`导入事实            : ${r.importFacts}  ${JSON.stringify(r.factsByKind)}`)
  L.push(`闸门执行面（新实现文件）: ${r.gateFiles.length ? `${r.gateFiles.length} 个` : '(无)'}`)
  for (const g of r.gateFiles) L.push(`  · src/${g}`)
  L.push(`尚未建成的目标分层  : ${r.absentLayers.join(', ') || '(无)'}`)
  if (r.layerCollisions.length) {
    L.push(`目录名撞车（不算新层）:`)
    for (const c of r.layerCollisions) L.push(`  - ${c.layer}：${c.because}`)
  }
  L.push('')
  L.push('── 闸门（必须 0 finding）' + '─'.repeat(50))
  for (const rule of r.gate.rules) {
    const mark = rule.findings > 0 ? '✗ 红  ' : rule.vacuous ? '○ 空洞' : '✓ 绿  '
    L.push(`${mark} ${rule.id}`)
    L.push(`        ${rule.title}`)
    L.push(`        依据 ${rule.criterion}`)
    L.push(`        finding ${rule.findings}｜受检文件 ${rule.evaluatedFiles}`)
    if (rule.vacuous) {
      L.push('        ⚠ 受检文件 = 0：本规则在当前目录结构下**无执行面**，"绿"是空洞真，')
      L.push('          不构成"边界已生效"的证据。建层后本标记自动消失。')
    }
  }
  L.push('')
  if (r.gate.findings.length === 0) {
    L.push(`闸门判定：${r.gate.verdict.toUpperCase()}（0 finding）`)
    if (r.gate.vacuousRules.length) {
      L.push(`注意：${r.gate.vacuousRules.length} 条规则为空洞真（${r.gate.vacuousRules.join(', ')}）——`)
      L.push('      它们的执行面（新分层目录）尚不存在，本次扫描**没有**检验这些边界。')
    }
  } else {
    L.push(`闸门判定：${r.gate.verdict.toUpperCase()}（${r.gate.findings.length} 条 finding）`)
    L.push('-'.repeat(76))
    for (const f of r.gate.findings) {
      L.push(`• [${f.rule}] ${f.file}:${f.line}:${f.column}`)
      L.push(`    ${f.detail}`)
      L.push(`    语句：${f.syntax}`)
    }
  }
  L.push('')
  L.push('── 遗留债务（#249 §15；只计数与归属，不影响退出码）' + '─'.repeat(28))
  for (const [k, n] of Object.entries(r.debt.counts)) {
    L.push(`  ${k.padEnd(26)} ${n}`)
  }
  if (r.debt.counts['dynamic-import-opaque']) {
    L.push('')
    L.push('  不可静态解析的动态导入（边界无法由模块图证明）：')
    for (const d of r.debt.items['dynamic-import-opaque']) {
      L.push(`    • ${d.file}:${d.line}  ${d.syntax}`)
    }
  }
  L.push('')
  L.push('  注：本设施只测量模块图能判定的那几类。#249 §15 的其余条目需要语义判据，')
  L.push('      由其负责批次的验收承担（A05/A11/A13/A16/A19/A21/A23 等），归属见')
  L.push('      RETIREMENT_OWNERS / B5 附件，本设施不假装覆盖。')
  return L.join('\n')
}

try {
  main()
} catch (err) {
  console.error(`[边界扫描] 设施自身出错：${err && err.stack ? err.stack : err}`)
  process.exit(2)
}
