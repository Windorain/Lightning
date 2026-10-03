#!/usr/bin/env node
/**
 * P3.2/P3.3 —— 部件验收的**静态/文件级**机器判据（`check-static.mjs`）。
 *
 * 与 `verify-oracle.mjs` 的分工：后者是「oracle ↔ 导出逐格核对」；本脚本判的是
 * **跨文件的静态性质**（降级档位、推断永不当主来源、无部件文件字节干净、旧格式兼容），
 * 全部只读归档产物 + 仓库 fixture，不启动游戏、不跑浏览器。
 *
 * 判据（每条都在报告里留证据路径）：
 *  A. **推断永不当主来源**（契约 §7.2 硬约束，P3.3）：
 *     - 任何 `family=inferred` 部件的 `tier` 必须为 3；
 *     - **格级**：任一格只要含 tier 1/2 部件，该格就不得含 `family=inferred` 部件
 *       （档 1/2 有结果时档 3 不执行）；
 *     对 full / degraded_ae2 / degraded_all 三个产物各判一遍。
 *  B. **降级档位正确**（P3.3 三档来源标记）：
 *     - full：AE2 区格有 tier 1 `ae2` 族部件；火把格落 tier 3 `inferred`（§7.3 档 2 不产出）；
 *     - degraded_ae2（只关 ae2）：AE2 区格不再有 `ae2` 族部件，且落到 **tier 2 generic**
 *       （fallback=true / boxProvenance=both）；同期 eio/fmp 格仍为 tier 1（关族只影响该族）；
 *     - degraded_all（全关）：**全部**部件 tier 3 `inferred` / fallback=true，且部件格数不减少
 *       （"任何降级路径不中断导出"的产物级证据）。
 *  C. **无部件文件字节干净**（契约 §2 硬约束"无部件信息 ⇒ 行为与今天完全一致"）：
 *     - `sde_parts_acceptance_export_fullcube_only.json` 不得含
 *       `cellPartsGrid` / `partLists` / `partIconTextures` / `statsTemplate`（满方块-only 结构）；
 *     - L1 的结构化结果里 `fullCubeByteClean.pass === true`（开启部件链路 vs 关闭的 sha256 相等）
 *       —— **引用其结论**，不在脚本侧重算（重算需要两次游戏内导出）。
 *  D. **旧格式兼容**（P3.2）：仓库里既有无部件 fixture（`minimal-v2.json` /
 *     `structuredata-exported-envelope.json`）不含任何部件字段（解析侧回归由 vitest/playwright 覆盖）。
 *
 * 用法：
 *   node scripts/parts-acceptance/check-static.mjs [--archive <dir>] [--out <report.json>]
 *
 * 退出码：0 = 全绿；1 = 有违例；2 = 输入不可用（显式失败）。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import zlib from 'node:zlib'

import {
  ORACLE_FILES,
  REAL_EXPORT_FILES,
  REPO_ROOT,
  parseArgs,
  readJson,
  readJsonIfExists,
  rel,
  resolveArchive,
  writeJson,
} from './lib/parts-io.mjs'

const PARTS_KEYS = ['cellPartsGrid', 'partLists', 'partIconTextures', 'statsTemplate', 'statsOverride']

/** 取某格部件（按 cellPartsGrid 下标）。 */
function partsAt(exportRoot, zi, ri, ci) {
  const idx = exportRoot.cellPartsGrid?.[zi]?.[ri]?.[ci]
  if (typeof idx !== 'number' || idx < 0) return []
  return exportRoot.partLists?.[idx] ?? []
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const archiveDir = resolveArchive(args.archive)
  const violations = []
  const sections = {}

  const full = readJson(path.join(archiveDir, REAL_EXPORT_FILES.full))
  const degradedAe2 = readJson(path.join(archiveDir, REAL_EXPORT_FILES.degradedAe2))
  const degradedAll = readJson(path.join(archiveDir, REAL_EXPORT_FILES.degradedAll))
  const oracleFull = readJson(path.join(archiveDir, ORACLE_FILES.full))
  const oracleDegradedAll = readJson(path.join(archiveDir, ORACLE_FILES.degradedAll))
  const l1Result = readJsonIfExists(path.join(archiveDir, REAL_EXPORT_FILES.result))

  // ── A. 推断永不当主来源 ────────────────────────────────────────────────
  const inferredNeverPrimary = { checked: [], violations: [] }
  for (const [name, doc] of [
    ['full', full],
    ['degraded_ae2', degradedAe2],
    ['degraded_all', degradedAll],
  ]) {
    let parts = 0
    let inferred = 0
    let cellsWithTier12AndInferred = 0
    for (let z = 0; z < (doc.cellPartsGrid?.length ?? 0); z++) {
      for (let r = 0; r < (doc.cellPartsGrid?.[z]?.length ?? 0); r++) {
        for (let c = 0; c < (doc.cellPartsGrid?.[z]?.[r]?.length ?? 0); c++) {
          const list = partsAt(doc, z, r, c)
          if (list.length === 0) continue
          parts += list.length
          const inf = list.filter((p) => p.source?.family === 'inferred')
          const primary = list.filter((p) => p.source?.tier === 1 || p.source?.tier === 2)
          inferred += inf.length
          if (inf.length > 0 && primary.length > 0) {
            cellsWithTier12AndInferred++
            violations.push(
              `${name} 格[${z}][${r}][${c}] 同时含 tier1/2 与 inferred 部件（推断不得当主来源，契约 §7.2）`,
            )
          }
          for (const p of inf) {
            if (p.source?.tier !== 3) {
              violations.push(`${name} ${p.localId} family=inferred 但 tier=${p.source?.tier}（必须为 3）`)
            }
            if (p.source?.fallback !== true) {
              violations.push(`${name} ${p.localId} family=inferred 但 fallback=${p.source?.fallback}（兜底档必须 true）`)
            }
          }
        }
      }
    }
    inferredNeverPrimary.checked.push({ file: name, parts, inferred, cellsWithTier12AndInferred })
    inferredNeverPrimary.violations.push(...violations.splice(0))
  }
  inferredNeverPrimary.pass = inferredNeverPrimary.violations.length === 0
  sections.inferredNeverPrimary = inferredNeverPrimary

  // ── B. 降级档位正确性 ─────────────────────────────────────────────────
  const tierDegradation = { checks: [], violations: [] }
  const pushB = (ok, msg) => {
    tierDegradation.checks.push({ ok, msg })
    if (!ok) tierDegradation.violations.push(msg)
  }
  /** oracle 中某分区的格下标（有部件者）。 */
  const zoneCells = (oracle, zone) =>
    (oracle.cells ?? [])
      .filter((c) => c.zone === zone && (c.parts ?? []).length > 0)
      .map((c) => c.grid)

  // full：AE2 区 tier 1 ae2 族 + 火把格 tier 3
  let fullAe2Tier1 = 0
  for (const [z, r, c] of zoneCells(oracleFull, 'ae2')) {
    for (const p of partsAt(full, z, r, c)) {
      if (p.source?.family === 'ae2' && p.source?.tier === 1 && p.source?.fallback === false) fullAe2Tier1++
    }
  }
  pushB(fullAe2Tier1 > 0, `full：AE2 区应有 tier1/非兜底的 ae2 族部件（实际 ${fullAe2Tier1}）`)
  let fullTorchTier3 = 0
  let fullTorchTotal = 0
  for (const [z, r, c] of zoneCells(oracleFull, 'single-box')) {
    for (const p of partsAt(full, z, r, c)) {
      if (p.typeKey !== 'minecraft:torch:0') continue
      fullTorchTotal++
      if (p.source?.family === 'inferred' && p.source?.tier === 3) fullTorchTier3++
    }
  }
  pushB(fullTorchTotal > 0, 'full：火把格部件存在（档 3 退化情形的样本）')
  pushB(
    fullTorchTier3 === fullTorchTotal && fullTorchTotal > 0,
    `full：火把类必须落档 3（档 2 不产出，契约 §7.3）—— 实际 ${fullTorchTier3}/${fullTorchTotal}`,
  )

  // degraded_ae2：AE2 区无 ae2 族、落 tier 2 generic；eio/fmp 区仍 tier 1
  let ae2FamilyLeft = 0
  let ae2Tier2Generic = 0
  for (const [z, r, c] of zoneCells(oracleFull, 'ae2')) {
    for (const p of partsAt(degradedAe2, z, r, c)) {
      if (p.source?.family === 'ae2') ae2FamilyLeft++
      if (p.source?.family === 'generic' && p.source?.tier === 2 && p.source?.fallback === true) ae2Tier2Generic++
    }
  }
  pushB(ae2FamilyLeft === 0, `degraded_ae2：关 ae2 族后 AE2 区不应再有 ae2 族部件（实际 ${ae2FamilyLeft}）`)
  pushB(ae2Tier2Generic > 0, `degraded_ae2：AE2 区应落 tier2 generic（实际 ${ae2Tier2Generic}）`)
  let eioFmpTier1 = 0
  for (const zone of ['enderio', 'fmp']) {
    for (const [z, r, c] of zoneCells(oracleFull, zone)) {
      for (const p of partsAt(degradedAe2, z, r, c)) {
        if (p.source?.tier === 1 && ['eio', 'fmp'].includes(p.source?.family)) eioFmpTier1++
      }
    }
  }
  pushB(eioFmpTier1 > 0, `degraded_ae2：未关的 eio/fmp 族仍应 tier1（实际 ${eioFmpTier1}）`)

  // degraded_all：全 tier 3 inferred，部件格数不减
  let allParts = 0
  let allInferred = 0
  const countPartCells = (doc) => {
    let n = 0
    for (let z = 0; z < (doc.cellPartsGrid?.length ?? 0); z++) {
      for (let r = 0; r < (doc.cellPartsGrid?.[z]?.length ?? 0); r++) {
        for (let c = 0; c < (doc.cellPartsGrid?.[z]?.[r]?.length ?? 0); c++) {
          if (partsAt(doc, z, r, c).length > 0) n++
        }
      }
    }
    return n
  }
  for (let z = 0; z < (degradedAll.cellPartsGrid?.length ?? 0); z++) {
    for (let r = 0; r < (degradedAll.cellPartsGrid?.[z]?.length ?? 0); r++) {
      for (let c = 0; c < (degradedAll.cellPartsGrid?.[z]?.[r]?.length ?? 0); c++) {
        for (const p of partsAt(degradedAll, z, r, c)) {
          allParts++
          if (p.source?.family === 'inferred' && p.source?.tier === 3 && p.source?.fallback === true) allInferred++
        }
      }
    }
  }
  pushB(allParts > 0, 'degraded_all：全族关闭后仍必须产出部件（永远降级，契约 §7.1）')
  pushB(allInferred === allParts, `degraded_all：全部部件应为 tier3/inferred/fallback（实际 ${allInferred}/${allParts}）`)
  const fullPartCells = countPartCells(full)
  const degradedPartCells = countPartCells(degradedAll)
  pushB(
    degradedPartCells === fullPartCells,
    `degraded_all：部件格数应与 full 一致（降级不中断导出）—— full ${fullPartCells} / degraded ${degradedPartCells}`,
  )
  // 哨兵语义：退化档格数一致性（oracle 侧交叉）
  pushB(
    (oracleDegradedAll.cells ?? []).filter((c) => (c.parts ?? []).length > 0).length ===
      (oracleFull.cells ?? []).filter((c) => (c.parts ?? []).length > 0).length,
    'degraded_all oracle：部件格集合与 full oracle 一致（同一建造产物 + 期望档位变换）',
  )
  tierDegradation.pass = tierDegradation.violations.length === 0
  sections.tierDegradation = tierDegradation

  // ── C. 无部件文件字节干净 ─────────────────────────────────────────────
  const fullcubePath = path.join(archiveDir, REAL_EXPORT_FILES.fullcubeOnly)
  const fullcubeRaw = fs.existsSync(fullcubePath) ? fs.readFileSync(fullcubePath, 'utf8') : null
  const fullCubeByteClean = { file: rel(fullcubePath), present: fullcubeRaw !== null, violations: [] }
  if (fullcubeRaw === null) {
    fullCubeByteClean.violations.push(`满方块-only 产物缺失：${fullcubePath}`)
  } else {
    const doc = JSON.parse(fullcubeRaw)
    for (const k of PARTS_KEYS) {
      if (k in doc) fullCubeByteClean.violations.push(`满方块-only 产物含部件字段 ${k}（必须字节干净）`)
    }
    fullCubeByteClean.cells = (doc.cellGrid ?? []).length
    fullCubeByteClean.blockPalette = (doc.blockPalette ?? []).length
    fullCubeByteClean.nonFullCubeCells = (() => {
      // 满方块-only 结构：cellGrid 里出现的调色板条目都应 renderMode=BakedModel 整格
      let n = 0
      for (const slice of doc.cellGrid ?? []) for (const row of slice) for (const v of row) if (v !== 0) n++
      return n
    })()
  }
  // L1 结论引用（不在脚本侧重算：需要两次游戏内导出）
  const l1Clean = l1Result?.fullCubeByteClean ?? null
  fullCubeByteClean.l1Reference = l1Clean
    ? {
        pass: l1Clean.pass === true,
        enabledSha256: l1Clean.enabledSha256 ?? null,
        disabledSha256: l1Clean.disabledSha256 ?? null,
        what: l1Clean.what ?? null,
      }
    : null
  if (!fullCubeByteClean.l1Reference) {
    fullCubeByteClean.violations.push('L1 结果文件缺 fullCubeByteClean（无法引用"满方块-only 字节干净"结论）')
  } else if (fullCubeByteClean.l1Reference.pass !== true) {
    fullCubeByteClean.violations.push(
      `L1 fullCubeByteClean.pass=${fullCubeByteClean.l1Reference.pass}（开启 vs 关闭部件链路 sha256 不等）`,
    )
  }
  fullCubeByteClean.pass = fullCubeByteClean.violations.length === 0
  sections.fullCubeByteClean = fullCubeByteClean
  violations.push(...fullCubeByteClean.violations)

  // ── D. 旧格式兼容（无部件文件不得含部件字段）────────────────────────────
  const legacy = { files: [], violations: [] }
  const legacyFiles = [
    path.join(REPO_ROOT, 'web/e2e/fixtures/minimal-v2.json'),
    path.join(REPO_ROOT, 'web/e2e/fixtures/structuredata-exported-envelope.json'),
  ]
  for (const f of legacyFiles) {
    if (!fs.existsSync(f)) {
      legacy.violations.push(`旧格式 fixture 缺失：${rel(f)}`)
      continue
    }
    const text = fs.readFileSync(f, 'utf8')
    let inner = text
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed?.payload === 'string') {
        const buf = Buffer.from(parsed.payload, 'base64')
        inner = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8')
      }
    } catch {
      /* 原样文本判据 */
    }
    const hit = PARTS_KEYS.filter((k) => inner.includes(`"${k}"`))
    if (hit.length > 0) legacy.violations.push(`旧格式文件 ${rel(f)} 含部件字段 ${hit.join(',')}（向后兼容硬约束）`)
    legacy.files.push({ file: rel(f), hasPartsKeys: hit })
  }
  legacy.pass = legacy.violations.length === 0
  sections.legacyNoPartsKeys = legacy
  violations.push(...legacy.violations)

  // ── E. L1 结构化结果引用（ID/退化套件/开关被行使）────────────────────────
  const l1 = {
    present: l1Result !== null,
    violations: [],
    status: l1Result?.status ?? null,
    exitCode: l1Result?.exitCode ?? null,
    suites: (l1Result?.suites ?? []).map((s) => ({
      suite: s.suite,
      pass: s.pass === true,
      failedChecks: s.failedChecks,
      disabledFamilies: s.disabledFamilies ?? null,
    })),
    idempotencyFull: l1Result?.idempotencyFull
      ? { identical: l1Result.idempotencyFull.identical === true, a: l1Result.idempotencyFull.runASha256, b: l1Result.idempotencyFull.runBSha256 }
      : null,
    intentCells: l1Result?.intentCells ?? null,
  }
  if (!l1.present) l1.violations.push('L1 结构化结果文件缺失（sde_parts_acceptance_result.json）')
  else {
    if (l1.status !== 'ok' || l1.exitCode !== 0) l1.violations.push(`L1 结果 status=${l1.status} exitCode=${l1.exitCode}`)
    if (l1.suites.length !== 3) l1.violations.push(`L1 应有三套件（full/degraded_ae2/degraded_all），实际 ${l1.suites.length}`)
    for (const s of l1.suites) if (!s.pass) l1.violations.push(`L1 套件 ${s.suite} 未通过（failedChecks=${s.failedChecks}）`)
    const degraded = l1.suites.filter((s) => (s.disabledFamilies ?? '').length > 0)
    if (degraded.length < 2) {
      l1.violations.push(`退化套件应至少 2 套（关 ae2 / 全关），实际 ${degraded.length} —— 提供者开关未被行使`)
    }
    if (!l1.idempotencyFull || l1.idempotencyFull.identical !== true) {
      l1.violations.push('L1 同轮双导出幂等证据不足（idempotencyFull.identical ≠ true）')
    }
  }
  l1.pass = l1.violations.length === 0
  sections.l1ResultReference = l1
  violations.push(...l1.violations)

  // ── F. web 端不重放游戏逻辑 / 不重算盒（契约 §12 硬约束）──────────────────
  const webSrc = { scanned: [], boxConstructionHits: [], gameLogicHits: [], violations: [] }
  const srcRoot = path.join(REPO_ROOT, 'web/src')
  const tsFiles = []
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === '__tests__' || ent.name === 'node_modules') continue
        walk(full)
      } else if (/\.(ts|vue)$/.test(ent.name)) tsFiles.push(full)
    }
  }
  if (!fs.existsSync(srcRoot)) {
    webSrc.violations.push(`web/src 不存在：${srcRoot}`)
  } else {
    walk(srcRoot)
    webSrc.scanned = tsFiles.map((f) => rel(f))
    for (const f of tsFiles) {
      const text = fs.readFileSync(f, 'utf8')
      text.split(/\r?\n/).forEach((line, i) => {
        // 端上构造部件盒（`kind: 'visual'|'collision'` 字面量）—— 盒必须来自文件
        if (/kind:\s*['"](visual|collision)['"]/.test(line)) {
          webSrc.boxConstructionHits.push(`${rel(f)}:${i + 1}: ${line.trim().slice(0, 120)}`)
        }
        // 端上调用游戏取盒 API（1.7.10 侧不存在于 web；出现即为"重放游戏逻辑"）
        if (/setBlockBounds|getSelectedBoundingBox|CollisionBoundingBox|renderAsNormalBlock/.test(line)) {
          webSrc.gameLogicHits.push(`${rel(f)}:${i + 1}: ${line.trim().slice(0, 120)}`)
        }
      })
    }
    if (webSrc.boxConstructionHits.length > 0) {
      webSrc.violations.push(`web 端出现部件盒构造 ${webSrc.boxConstructionHits.length} 处（盒必须来自文件，契约 §12）`)
    }
    if (webSrc.gameLogicHits.length > 0) {
      webSrc.violations.push(`web 端出现游戏取盒 API 调用 ${webSrc.gameLogicHits.length} 处（不得重放游戏逻辑）`)
    }
  }
  webSrc.pass = webSrc.violations.length === 0
  sections.webNoBoxConstruction = webSrc
  violations.push(...webSrc.violations)

  // ── G. proto 契约字段在册（契约 §10.1/§10.2 拍板口径的机器证据）────────────
  const protoRel = 'protocol/lightning/v2/plain_v2.proto'
  const protoPath = path.join(REPO_ROOT, protoRel)
  const requiredProtoFields = [
    'message BlockPart',
    'repeated PartBox boxes',
    'repeated PartItem items',
    'string display_name',
    'PartSource source',
    'message PartBox',
    'message PartItem',
    'message PartSource',
    'part_type_key',
  ]
  const proto = { path: protoRel, present: fs.existsSync(protoPath), missingFields: [], violations: [] }
  if (!proto.present) {
    proto.violations.push(`proto 缺失：${protoRel}`)
    proto.missingFields = requiredProtoFields
  } else {
    const text = fs.readFileSync(protoPath, 'utf8')
    for (const f of requiredProtoFields) {
      if (!text.includes(f)) proto.missingFields.push(f)
    }
    if (proto.missingFields.length > 0) {
      proto.violations.push(`proto 缺契约 §10.2 字段：${proto.missingFields.join(', ')}`)
    }
  }
  proto.pass = proto.violations.length === 0
  sections.protoContractFields = proto
  violations.push(...proto.violations)

  const report = {
    schema: 'lightning.parts-static-checks/1',
    archive: archiveDir,
    pass: violations.length === 0,
    violations,
    sections,
  }
  if (args.out) writeJson(path.resolve(args.out), report)

  console.log(
    `[check-static] ${report.pass ? 'PASS' : 'FAIL'} —— 归档 ${archiveDir}` +
      `（推断永不当主来源 ${sections.inferredNeverPrimary.pass ? 'ok' : 'FAIL'}；` +
      `降级档位 ${sections.tierDegradation.pass ? 'ok' : 'FAIL'}；` +
      `满方块字节干净 ${sections.fullCubeByteClean.pass ? 'ok' : 'FAIL'}；` +
      `旧格式兼容 ${sections.legacyNoPartsKeys.pass ? 'ok' : 'FAIL'}；` +
      `L1 结果引用 ${sections.l1ResultReference.pass ? 'ok' : 'FAIL'}；` +
      `web 不重算盒 ${sections.webNoBoxConstruction.pass ? 'ok' : 'FAIL'}；` +
      `proto 契约字段 ${sections.protoContractFields.pass ? 'ok' : 'FAIL'}）`,
  )
  for (const v of violations) console.log(`   XX ${v}`)
  process.exit(report.pass ? 0 : 1)
}

main()
