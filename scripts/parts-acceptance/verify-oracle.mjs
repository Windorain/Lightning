#!/usr/bin/env node
/**
 * P3.1/P3.4 —— oracle ↔ 导出文件**逐格核对**的脚本侧独立实现（`verify-oracle.mjs`）。
 *
 * 与 L1 内嵌验证器（`mod/.../parts/probe/PartsAcceptanceVerifier.java`，游戏内运行）的关系：
 * **同一契约口径、两个独立实现**。本脚本不参与建造/导出，只在归档产物上复算，
 * 因此它是 P3.4 证伪的天然靶子：篡改 oracle 或敲掉导出文件里的一个部件，
 * 本脚本**必须**非零退出（`falsification.mjs` 就是靠这一点证明"判定式不是恒绿"）。
 *
 * 判据（契约 §2/§3/§4/§6/§11）：
 *  1. 结构自洽（`checkPartStructure`）：五要素齐全、来源四元组齐全且与 localId 前缀自洽、
 *     盒静态合理（允许越界、不允许反向盒/全轴退化盒）、cellPartsGrid 与 cellGrid 同形；
 *  2. 逐格 oracle 比对（`verifyCells`，含退化哨兵语义）；
 *  3. `expectedCounts` 比对（`exact`；`countsScope=untransformed-cells-only` 时 `subset`，
 *     可用 `--counts-mode` 强制）；
 *  4. 池化去重证据（`--dedup-pair` 可传同构格对；缺省用 P1.8 实测的 enderio/overlay 5 导管束格对）。
 *
 * 用法：
 *   node scripts/parts-acceptance/verify-oracle.mjs \
 *     --oracle scripts/parts-acceptance/oracle/sde_parts_acceptance_oracle_full.json \
 *     --export <归档>/sde_parts_acceptance_export_full_a.json \
 *     [--label full] [--counts-mode auto|exact|subset] [--out <report.json>]
 *
 * 退出码：0 = 全绿；1 = 有 FAIL 判据；2 = 用法/输入不可用（**显式失败，不静默跳过**）。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {
  checkPartStructure,
  exportStats,
  gridValue,
  parseArgs,
  readJson,
  summarizeChecks,
  verifyCells,
  verifyDedup,
  verifyExpectedCounts,
  writeJson,
} from './lib/parts-io.mjs'

/** P1.8 实测的同构格对（enderio 区 5 导管束格 / overlay 区 5 导管束格 ⇒ 同 partLists 下标）。 */
const DEFAULT_DEDUP_PAIRS = [
  [
    [8, 1, 0],
    [12, 1, 0],
  ],
]

/** `cellPartsGrid[z][r][c]` 的池下标（越界/无部件 ⇒ -1）。 */
function gridCellIndex(exportRoot, z, r, c) {
  const v = gridValue(exportRoot.cellPartsGrid, z, r, c)
  return v < 0 ? -1 : v
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const oraclePath = args.oracle ? path.resolve(args.oracle) : null
  const exportPath = args.export ? path.resolve(args.export) : null
  const label = typeof args.label === 'string' ? args.label : 'oracle-verify'
  if (!oraclePath || !exportPath) {
    console.error('用法：verify-oracle.mjs --oracle <oracle.json> --export <export.json> [--label <id>] [--out <json>]')
    process.exit(2)
  }
  if (!fs.existsSync(oraclePath)) {
    console.error(`oracle 不存在：${oraclePath}`)
    process.exit(2)
  }
  if (!fs.existsSync(exportPath)) {
    console.error(`导出文件不存在：${exportPath}`)
    process.exit(2)
  }

  let oracle
  let exportRoot
  try {
    oracle = readJson(oraclePath)
    exportRoot = readJson(exportPath)
  } catch (e) {
    console.error(`读取失败（JSON 不可解析）：${e.message}`)
    process.exit(2)
  }
  if (!Array.isArray(oracle.cells)) {
    console.error(`oracle 缺 cells[]（契约 §11）：${oraclePath}`)
    process.exit(2)
  }

  // ① 结构自洽（独立于 oracle）
  const struct = checkPartStructure(exportRoot)
  /** @type {Array<{ok:boolean,msg:string}>} */
  const checks = []
  for (const v of struct.violations) checks.push({ ok: false, msg: `结构：${v}` })

  // ② 逐格 oracle 比对
  const cellChecks = verifyCells(oracle, exportRoot)
  checks.push(...cellChecks)

  // ③ expectedCounts
  const countsMode = typeof args['counts-mode'] === 'string' ? args['counts-mode'] : 'auto'
  const countChecks = verifyExpectedCounts(oracle, exportRoot, countsMode)
  checks.push(...countChecks)

  // ④ 池化去重
  const pairs = Array.isArray(oracle.cells) && oracle.gridIndex
    ? DEFAULT_DEDUP_PAIRS
    : []
  const dedupChecks = verifyDedup(oracle, exportRoot, pairs)
  checks.push(...dedupChecks)

  const summary = summarizeChecks(checks)
  const stats = exportStats(exportRoot)

  // ── 观测汇总（供报告 §6 清单逐条消费；全部从产物派生，不做判断）──────────
  const cat = (re) => struct.violations.filter((v) => re.test(v)).length
  const familiesSeen = new Set()
  const tiersSeen = new Set()
  const provenanceSeen = new Set()
  const typeKeys = new Set()
  const itemKeys = new Set()
  let itemsEmptyExplicit = 0
  let multiPartCells = 0
  let partsWithNoItems = 0
  /** 某轴零厚度的盒（平面类部件的如实快照；观测登记，非违例）。 */
  const degenerateBoxes = []
  for (const list of exportRoot.partLists ?? []) {
    for (const p of list) {
      for (const b of p.boxes ?? []) {
        const ext = [b.max?.[0] - b.min?.[0], b.max?.[1] - b.min?.[1], b.max?.[2] - b.min?.[2]]
        if (ext.some((e) => e === 0)) {
          const entry = `${p.localId}/${b.kind} min=[${b.min}] max=[${b.max}]`
          if (!degenerateBoxes.includes(entry)) degenerateBoxes.push(entry)
        }
      }
    }
  }
  const countCells = exportRoot.cellPartsGrid ?? []
  for (let z = 0; z < countCells.length; z++) {
    for (let r = 0; r < (countCells[z]?.length ?? 0); r++) {
      for (let c = 0; c < (countCells[z]?.[r]?.length ?? 0); c++) {
        const idx = countCells[z][r][c]
        if (typeof idx !== 'number' || idx < 0) continue
        const list = exportRoot.partLists?.[idx] ?? []
        if (list.length > 1) multiPartCells++
        for (const p of list) {
          familiesSeen.add(p.source?.family)
          tiersSeen.add(p.source?.tier)
          provenanceSeen.add(p.source?.boxProvenance)
          typeKeys.add(p.typeKey)
          if ((p.items ?? []).length === 0) {
            itemsEmptyExplicit++
            partsWithNoItems++
          }
          for (const it of p.items ?? []) {
            itemKeys.add(`${it.registry}:${it.damage}${it.nbtDiscriminator ? `#${it.nbtDiscriminator}` : ''}`)
          }
        }
      }
    }
  }
  // 单盒区（oracle `zone=single-box` 的非满格，且**不是**族权威档）的宿主种类：
  // 证明 slab / 火把 / 箱子 / 栅栏零族专用代码全覆盖（契约 §7 档 2/档 3）。
  const singleBoxHosts = new Set()
  for (const cell of oracle.cells ?? []) {
    if (cell.zone !== 'single-box' || cell.expectFullCube) continue
    const [zi, ri, ci] = cell.grid ?? []
    const list = exportRoot.partLists?.[gridCellIndex(exportRoot, zi, ri, ci)] ?? []
    if (list.length === 0) continue
    if (list.every((p) => p.source?.tier !== 1)) {
      const parts = String(cell.host).split(':')
      singleBoxHosts.add(parts.slice(0, 2).join(':'))
    }
  }

  const observations = {
    multiPartCells,
    familiesSeen: [...familiesSeen].filter(Boolean).sort(),
    tiersSeen: [...tiersSeen].filter(Boolean).sort((a, b) => a - b),
    provenanceSeen: [...provenanceSeen].filter(Boolean).sort(),
    distinctTypeKeys: typeKeys.size,
    distinctItemKeys: itemKeys.size,
    itemsEmptyExplicit,
    partsWithNoItems,
    singleBoxHosts: [...singleBoxHosts].sort(),
    degenerateBoxes,
    structureViolations: struct.violations.length,
    namespaceViolations: cat(/localId|族前缀|source\.family/),
    sourceViolations: cat(/source/),
    tooltipViolations: cat(/tooltip/),
    displayNameViolations: cat(/displayName/),
    itemsViolations: cat(/items/),
    boxViolations: cat(/盒|box/i),
    shapeViolations: cat(/形状/),
  }

  const report = {
    schema: 'lightning.parts-oracle-verification/1',
    label,
    oracle: { path: oraclePath, schema: oracle.schema ?? null, structure: oracle.structure ?? null, cells: oracle.cells.length, countsScope: oracle.countsScope ?? 'all' },
    export: { path: exportPath, ...stats, hasCellPartsGrid: Array.isArray(exportRoot.cellPartsGrid) },
    countsMode: countChecks.mode,
    cellsChecked: cellChecks.partCells ?? null,
    fullCubeCells: cellChecks.fullCubeCells ?? null,
    wildcardCells: cellChecks.wildcardCells ?? null,
    expectedCountEntries: countChecks.entries ?? null,
    keysInExport: countChecks.keysInExport ?? null,
    checks: summary.total,
    failedChecks: summary.failed,
    failures: summary.failedChecks.slice(0, 40),
    notes: struct.notes,
    observations,
    pass: summary.failed === 0,
  }
  if (args.out) writeJson(path.resolve(args.out), report)

  console.log(
    `[verify-oracle] ${label}：${report.pass ? 'PASS' : 'FAIL'} —— 判据 ${report.checks} 条 / 失败 ${report.failedChecks} 条` +
      `（格 ${report.cellsChecked} 部件格 + ${report.fullCubeCells} 满方块格 + ${report.wildcardCells} 哨兵格；` +
      `counts 口径 ${report.countsMode}）`,
  )
  for (const c of report.notes) console.log(`   · ${c}`)
  for (const f of report.failures) console.log(`   XX ${f}`)
  process.exit(report.pass ? 0 : 1)
}

main()
