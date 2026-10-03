#!/usr/bin/env node
/**
 * P3.4 —— 部件验收的**证伪（负对照）**：篡改必须让管线变红（`falsification.mjs`）。
 *
 * 三条纪律（与多方块轮 `scripts/acceptance/falsification.mjs` 一致）：
 *  1. **仓库原件一字不改**：所有篡改都发生在运行目录下的**临时副本**上
 *     （`<out>/tmp/<control>/`），canonical oracle 与归档导出文件只读；
 *  2. **红色必须来自判定式本身**：每个负对照都**真的跑一遍验证器进程**
 *     （`verify-oracle.mjs`，与 L1 阶段用的是同一个 CLI），断言其**非零退出**
 *     且失败信息里出现预期的键/部件 —— 不允许"用 Python 判断一下"代替；
 *  3. **正对照必须绿**：未篡改的 (canonical oracle, 归档导出) 跑同一验证器必须退出 0
 *     —— 否则"全部负对照都红了"只能说明验证器恒红，等于没有判定力。
 *
 * 负对照清单（计划 §5 P3.4 逐项）：
 *  - `oracle-tamper-count`：篡改 canonical oracle 一个 `expectedCounts[].count`（+1）⇒ 必红；
 *  - `oracle-tamper-localid`：篡改 canonical oracle 一个格的部件 `localId` ⇒ 必红（身份维度）；
 *  - `export-drop-parts`：**"敲掉测试结构一个部件重导出"的等价注入** —— 在导出文件里
 *    删掉一个多部件格的部件条目（实际侧缺陷）⇒ 必红；
 *  - `export-drop-cell`：把某非满格的 `cellPartsGrid` 置 -1（整格部件消失）⇒ 必红；
 *  - `export-tamper-count`：改一个部件 `items[0].count`（1→2）⇒ 必红（计数维度）；
 *  - `fake-provider-tolerance`（P1.1 expB 引用）：必抛异常的假提供者已被证过；
 *    本项机器核对**探针归档证据**：expB 每格 `providerFailures` 非空、且档位结果与
 *    无该提供者的基线（expC）一致、导出流程完成 ⇒ "容错不是摆设"。
 *
 * 用法：
 *   node scripts/parts-acceptance/falsification.mjs [--archive <dir>] [--out <dir>]
 *     [--only negatives|fake-provider] [--probe-dump <path>] [--probe-result <path>]
 *
 * 退出码：
 *   默认（负对照 + 正对照）：0 = 全部如期；1 = 有对照未如期；2 = 输入不可用
 *   `--only fake-provider`：0 = 证据齐全且通过；2 = **探针证据缺失**（编排记 not-run，不静默算通过）；
 *                          1 = 证据在但不通过
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {
  ORACLE_FILES,
  REAL_EXPORT_FILES,
  REPO_ROOT,
  SCRIPTS_DIR,
  ensureDir,
  parseArgs,
  readJson,
  readJsonIfExists,
  rel,
  resolveArchive,
  writeJson,
} from './lib/parts-io.mjs'

const VERIFIER = path.join(SCRIPTS_DIR, 'verify-oracle.mjs')

/** 跑一次验证器进程；返回 `{exitCode, stdout, stderr}`。 */
function runVerifier(oraclePath, exportPath, label, outPath) {
  const args = [
    VERIFIER,
    '--oracle',
    oraclePath,
    '--export',
    exportPath,
    '--label',
    label,
  ]
  if (outPath) args.push('--out', outPath)
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: REPO_ROOT })
  return { exitCode: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const archiveDir = resolveArchive(args.archive)
  const outDir = args.out ? path.resolve(args.out) : path.join(archiveDir, 'falsification')
  const tmpDir = path.join(outDir, 'tmp')
  ensureDir(tmpDir)
  const only = typeof args.only === 'string' ? args.only : 'all'

  const oracleFullPath = path.join(archiveDir, ORACLE_FILES.full)
  const exportFullPath = path.join(archiveDir, REAL_EXPORT_FILES.full)
  if (!fs.existsSync(oracleFullPath) || !fs.existsSync(exportFullPath)) {
    console.error(`输入不可用：${oracleFullPath} / ${exportFullPath}`)
    process.exit(2)
  }

  const controls = []
  const pushControl = (c) => {
    controls.push(c)
    console.log(`   ${c.ok ? 'OK ' : 'XX '} ${c.id}：${c.detail}`)
  }

  // ── 正对照：未篡改 ⇒ 必须绿 ────────────────────────────────────────────
  const posDir = ensureDir(path.join(tmpDir, 'positive'))
  const pos = only === 'fake-provider'
    ? { exitCode: 0 }
    : runVerifier(oracleFullPath, exportFullPath, 'positive-control', path.join(posDir, 'verify.json'))
  const positiveControl = {
    id: 'positive-control',
    ok: only === 'fake-provider' ? null : pos.exitCode === 0,
    exitCode: pos.exitCode,
    detail:
      only === 'fake-provider'
        ? '（本次只跑假提供者引用，未跑正/负对照）'
        : `未篡改 (canonical oracle, 归档导出) ⇒ 验证器退出码 ${pos.exitCode}（期望 0）`,
  }
  console.log(`   ${positiveControl.ok === false ? 'XX ' : 'OK '} positive-control：${positiveControl.detail}`)
  if (positiveControl.ok === false) {
    // 正对照红 ⇒ 后面所有"负对照红了"都没有判定力，直接失败（不静默继续）
    writeJson(path.join(outDir, 'falsification.json'), {
      schema: 'lightning.parts-falsification/1',
      archive: archiveDir,
      pass: false,
      positiveControl,
      controls: [],
      note: '正对照未绿 ⇒ 负对照结论无判定力，提前失败',
    })
    console.error('[falsification] 正对照未绿：验证器恒红，负对照无意义')
    process.exit(1)
  }

  /** 通用负对照：篡改 → 跑验证器 → 期望非零退出 + 失败信息含预期片段。 */
  const negative = ({ id, intent, tamperDir, mutate, expectSubstring, writeFiles }) => {
    const dir = ensureDir(path.join(tmpDir, tamperDir))
    const oracleCopy = path.join(dir, ORACLE_FILES.full)
    const exportCopy = path.join(dir, REAL_EXPORT_FILES.full)
    const oracleObj = readJson(oracleFullPath)
    const exportObj = readJson(exportFullPath)
    const mutation = mutate(oracleObj, exportObj)
    fs.writeFileSync(oracleCopy, JSON.stringify(oracleObj), 'utf8')
    fs.writeFileSync(exportCopy, JSON.stringify(exportObj), 'utf8')
    if (writeFiles) writeFiles(dir, oracleObj, exportObj)
    const outPath = path.join(dir, 'verify.json')
    const r = runVerifier(oracleCopy, exportCopy, id, outPath)
    const blob = `${r.stdout}\n${r.stderr}`
    const sawExpected = !expectSubstring || blob.includes(expectSubstring)
    const ok = r.exitCode !== 0 && sawExpected
    pushControl({
      id,
      intent,
      mutation,
      ok,
      exitCode: r.exitCode,
      expectedRed: true,
      sawExpectedSubstring: sawExpected,
      expectSubstring: expectSubstring ?? null,
      evidence: { tamperedOracle: rel(oracleCopy), tamperedExport: rel(exportCopy), verifyReport: rel(outPath) },
      detail:
        `篡改（${mutation}）⇒ 验证器退出码 ${r.exitCode}（期望非零）` +
        (expectSubstring ? `，失败信息含「${expectSubstring}」=${sawExpected}` : ''),
      failureSample: (blob.match(/XX .*/g) ?? []).slice(0, 3),
    })
  }

  // ① oracle 一个计数被篡改
  if (only !== 'fake-provider') {
  negative({
    id: 'oracle-tamper-count',
    intent: '篡改 canonical oracle 一个 expectedCounts 计数 ⇒ L1/脚本验证器必须红',
    tamperDir: 'oracle-tamper-count',
    mutate: (oracle) => {
      const e = oracle.expectedCounts[0]
      const before = e.count
      e.count = before + 1
      return `expectedCounts[${e.typeKey}] ${before}→${e.count}`
    },
    expectSubstring: 'expectedCounts[',
  })

  // ② oracle 一个格的部件身份被篡改
  negative({
    id: 'oracle-tamper-localid',
    intent: '篡改 canonical oracle 一个格的部件 localId ⇒ 必红（身份维度）',
    tamperDir: 'oracle-tamper-localid',
    mutate: (oracle) => {
      const cell = oracle.cells.find((c) => (c.parts ?? []).length > 0)
      const p = cell.parts[0]
      const before = p.localId
      p.localId = `${before}-TAMPERED`
      return `cell ${JSON.stringify(cell.pos)} ${before}→${p.localId}`
    },
    expectSubstring: 'TAMPERED',
  })

  // ③ 敲掉一个部件（等价注入：导出侧删部件条目）
  negative({
    id: 'export-drop-parts',
    intent: '"敲掉测试结构一个部件重导出"的等价注入：删掉一个多部件格的部件条目 ⇒ 必红',
    tamperDir: 'export-drop-parts',
    mutate: (_oracle, exportObj) => {
      // 取部件最多的格（真实产物 = AE2 5 部件格），删掉 2 个部件
      let best = { z: -1, r: -1, c: -1, n: -1 }
      const grid = exportObj.cellPartsGrid
      for (let z = 0; z < grid.length; z++) {
        for (let r = 0; r < grid[z].length; r++) {
          for (let c = 0; c < grid[z][r].length; c++) {
            const idx = grid[z][r][c]
            if (idx < 0) continue
            const n = exportObj.partLists[idx].length
            if (n > best.n) best = { z, r, c, n }
          }
        }
      }
      const idx = grid[best.z][best.r][best.c]
      const removed = exportObj.partLists[idx].splice(0, 2).map((p) => p.localId)
      return `格[${best.z}][${best.r}][${best.c}] 删除部件 ${removed.join(',')}（原 ${best.n} 个）`
    },
    expectSubstring: '部件数应为',
  })

  // ④ 整格部件消失（cellPartsGrid → -1）
  negative({
    id: 'export-drop-cell',
    intent: '把一个非满格的 cellPartsGrid 置 -1（整格部件消失）⇒ 必红',
    tamperDir: 'export-drop-cell',
    mutate: (oracle, exportObj) => {
      const cell = oracle.cells.find((c) => !c.expectFullCube && (c.parts ?? []).length > 0)
      const [zi, ri, ci] = cell.grid
      exportObj.cellPartsGrid[zi][ri][ci] = -1
      return `格[${zi}][${ri}][${ci}] cellPartsGrid -1（原 ${cell.parts.length} 部件）`
    },
    expectSubstring: '应有 partLists 下标',
  })

  // ⑤ 物品计数被篡改（计数维度）
  negative({
    id: 'export-tamper-count',
    intent: '改一个部件 items[0].count（1→2）⇒ 必红（计数维度，计数单位 = 可合成物品）',
    tamperDir: 'export-tamper-count',
    mutate: (_oracle, exportObj) => {
      // 找一个 items 非空的部件（池内改一处即被多格引用的聚合放大）
      for (const list of exportObj.partLists) {
        for (const p of list) {
          if ((p.items ?? []).length > 0 && p.items[0].count === 1) {
            const before = p.items[0].count
            p.items[0].count = before + 1
            return `${p.localId} items[0].count ${before}→${p.items[0].count}`
          }
        }
      }
      throw new Error('找不到可篡改的物品条目')
    },
    expectSubstring: 'expectedCounts[',
  })
  } // end negatives（--only fake-provider 时跳过）

  // ── ⑥ 假提供者容错（P1.1 expB 引用）───────────────────────────────────
  const probeDumpPath = args['probe-dump']
    ? path.resolve(args['probe-dump'])
    : path.join(REPO_ROOT, 'mod/gtnh/run/client/sde_parts_probe_dump.json')
  const probeResultPath = args['probe-result']
    ? path.resolve(args['probe-result'])
    : path.join(REPO_ROOT, 'mod/gtnh/run/client/sde_parts_probe_result.json')
  const fake = { id: 'fake-provider-tolerance', ok: false, ran: false }
  if (only === 'negatives') {
    fake.skipped = true
    fake.detail = '（本阶段只跑负对照；假提供者引用由 reference-fake-provider 阶段负责）'
  } else {
  const dump = readJsonIfExists(probeDumpPath)
  const probeResult = readJsonIfExists(probeResultPath)
  if (!dump || !probeResult) {
    fake.detail =
      `探针归档缺失（P1.1 expB 证据不可得）：dump=${rel(probeDumpPath)} 存在=${!!dump}；` +
      `result=${rel(probeResultPath)} 存在=${!!probeResult} —— 记 not-run（不静默算通过）`
    fake.missingEvidence = true
  } else {
    fake.ran = true
    const expB = dump.partsPipeline?.['expB-throwingProvider']
    const expC = dump.partsPipeline?.['expC-genericBaseline']
    const family = (probeResult.families ?? []).find((f) => f.family === 'partsPipeline')
    const probs = []
    if (!expB) probs.push('dump.partsPipeline.expB-throwingProvider 缺失')
    if (!expC) probs.push('dump.partsPipeline.expC-genericBaseline 缺失（无对照基线）')
    if (!family) probs.push('probe result 缺 partsPipeline 家族条目')
    else if (!String(family.detail).includes('expB-throwingProvider')) {
      probs.push(`probe result detail 未记录 expB：${family.detail}`)
    }
    const cells = expB?.cells ?? []
    const withFailures = cells.filter((c) => (c.result?.providerFailures ?? []).length > 0)
    // 满方块格走快速否定路径（零开销、不派发提供者）⇒ 本就不该有失败记录；
    // 非满格必须**每格**记录假提供者的异常（降级记录落盘）。
    const nonFullCells = cells.filter((c) => c.result?.hostFullCube === false)
    const nonFullWithFailures = nonFullCells.filter((c) => (c.result?.providerFailures ?? []).length > 0)
    if (cells.length === 0) probs.push('expB 格子集为空')
    if (nonFullCells.length === 0) probs.push('expB 无任何非满格（无法证明容错路径被行使）')
    if (nonFullWithFailures.length !== nonFullCells.length) {
      probs.push(
        `expB 只有 ${nonFullWithFailures.length}/${nonFullCells.length} 个非满格记录了 providerFailures` +
          `（降级记录必须每格落盘；满方块格走快速否定路径不算）`,
      )
    }
    if (expB && expB.pass !== true) probs.push('expB.pass ≠ true（容错测试本身未通过）')
    // 容错等价性：假提供者抛异常，但结果必须与"无该提供者"的基线逐格一致
    const baseline = new Map((expC?.cells ?? []).map((c) => [JSON.stringify(c.pos), c]))
    let mismatched = 0
    for (const c of cells) {
      const base = baseline.get(JSON.stringify(c.pos))
      if (!base) continue
      const strip = (r) => JSON.stringify({ tier: r?.tier, parts: r?.parts })
      if (strip(c.result) !== strip(base.result)) mismatched++
    }
    if (mismatched > 0) probs.push(`${mismatched} 格结果与 expC 基线不一致（异常影响了产出）`)
    fake.ok = probs.length === 0
    fake.problems = probs
    fake.evidence = {
      probeDump: rel(probeDumpPath),
      probeResult: rel(probeResultPath),
      cells: cells.length,
      nonFullCells: nonFullCells.length,
      cellsWithProviderFailures: withFailures.length,
      nonFullCellsWithProviderFailures: nonFullWithFailures.length,
      sampleFailure: (withFailures[0]?.result?.providerFailures ?? [])[0] ?? null,
      baselineComparedCells: cells.length - mismatched,
    }
    fake.detail =
      `expB 必抛假提供者：${nonFullWithFailures.length}/${nonFullCells.length} 个非满格记录 providerFailures（示例：` +
      `${(fake.evidence.sampleFailure ?? '').split('@')[0].trim()}），且 ${fake.evidence.baselineComparedCells} 格结果与` +
      `无该提供者的 expC 基线一致 ⇒ 导出完成、静默降级、记录落盘`
    if (!fake.ok) fake.detail += `｜问题：${probs.join('；')}`
  }
  }
  if (!fake.skipped) pushControl(fake)

  // ── `--only fake-provider`：只写假提供者引用报告（独立阶段，缺证据 ⇒ 退出码 2 = not-run）
  if (only === 'fake-provider') {
    const report = {
      schema: 'lightning.parts-falsification-fake-provider/1',
      archive: archiveDir,
      controls: [fake],
      pass: fake.ok === true,
      evidenceMissing: fake.missingEvidence === true,
    }
    writeJson(path.join(outDir, 'fake-provider.json'), report)
    console.log(
      `[falsification] fake-provider：${fake.ok ? 'OK' : fake.missingEvidence ? 'NOT-RUN（证据缺失）' : 'FAIL'} —— ${fake.detail}`,
    )
    process.exit(fake.missingEvidence ? 2 : fake.ok ? 0 : 1)
  }

  const redControls = controls.filter((c) => c.expectedRed)
  const redOk = redControls.filter((c) => c.ok)
  const pass =
    positiveControl.ok === true &&
    redOk.length === redControls.length &&
    redControls.length >= 5 &&
    (only === 'negatives' || fake.ok === true)

  const report = {
    schema: 'lightning.parts-falsification/1',
    archive: archiveDir,
    verifier: rel(VERIFIER),
    positiveControl,
    controls,
    summary: {
      negatives: redControls.length,
      negativesRed: redOk.length,
      fakeProviderReference: only === 'negatives' ? null : fake.ok,
    },
    pass,
  }
  writeJson(path.join(outDir, 'falsification.json'), report)
  console.log(
    `[falsification] ${pass ? 'PASS' : 'FAIL'} —— 负对照 ${redOk.length}/${redControls.length} 如期变红；` +
      `正对照 ${positiveControl.ok ? '绿' : '红'}` +
      (only === 'negatives' ? '；假提供者引用由独立阶段负责' : `；假提供者引用 ${fake.ok ? 'ok' : fake.missingEvidence ? '缺证据' : 'FAIL'}`),
  )
  process.exit(pass ? 0 : 1)
}

main()
