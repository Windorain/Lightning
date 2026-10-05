#!/usr/bin/env node
/**
 * P3.1–P3.4 —— 部件验收报告汇总：`acceptance-report.json`（机器可读）+ `.md`（人读摘要）。
 *
 * 本工具**不跑任何东西**（纯读阶段产物 + 判定），因此任何时刻都能重算报告：
 *   <run>/stages/*.json                 阶段片段（编排 ↔ 报告的唯一接口）
 *   <run>/l1/<label>/                    L1 归档（导出 + oracle + 结构化结果 + 日志）
 *   <run>/verify/*.json                  `verify-oracle.mjs` 三份逐格核对报告
 *   <run>/static-checks.json             `check-static.mjs`（降级/字节干净/旧格式/web 不重算/proto）
 *   <run>/falsification/falsification.json  `falsification.mjs`（负对照 + 正对照 + 假提供者引用）
 *   <run>/web/*.json                     playwright json 报告（L2 / fixture 回归 / 多方块交叉）
 *   <run>/web/l2-observations.json       L2 侧观测（F1/F2 已修复闭环；仅残留差异进 findings，如修复前登记的形状）
 *   <run>/logs/*.log                     各阶段 stdout/stderr
 *   <run>/idempotency.json               `-Runs 2` 的跨轮产物字节比对（编排写）
 *
 * 报告结构（`lightning.acceptance.parts/1`）：stages[] + checks[]（计划 §6 清单逐条机器判定，
 * 每条挂证据文件路径）+ verdict（含 redChecks/naChecks）+ findings[]（实现偏差/测量观察登记）
 * + idempotency + 开放项/裁决登记。
 *
 * 用法：
 *   node scripts/parts-acceptance/build-parts-report.mjs --run-dir <dir>
 *     [--compare-with <previous acceptance-report.json>] [--out <report.json>]
 *
 * 退出码：0 = 报告已产出；1 = 判定含 fail/not-run（**报告仍然落盘**）；2 = 运行目录不可用。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {
  ORACLE_FILES,
  REAL_EXPORT_FILES,
  parseArgs,
  readJsonIfExists,
  rel,
  writeJson,
  writeText,
} from './lib/parts-io.mjs'
import { PART_CHECK_STAGE_DEPS, caseSummary, runPartsChecklist } from './lib/parts-checklist.mjs'

// ---------------------------------------------------------------------------
// 定位 L1 归档
// ---------------------------------------------------------------------------

function findL1RunDirs(runDir) {
  const roots = []
  const l1Root = path.join(runDir, 'l1')
  if (fs.existsSync(l1Root)) roots.push(l1Root)
  // `-Runs 2`：L1 归档在 pass1/l1、pass2/l1 下（运行目录根本身没有 l1/）
  for (const e of fs.existsSync(runDir) ? fs.readdirSync(runDir) : []) {
    if (!/^pass\d+$/.test(e)) continue
    const p = path.join(runDir, e, 'l1')
    if (fs.existsSync(p)) roots.push(p)
  }
  const out = []
  for (const root of roots) {
    for (const e of fs.readdirSync(root)) {
      const p = path.join(root, e)
      try {
        if (fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, REAL_EXPORT_FILES.result))) out.push(p)
      } catch {
        /* 忽略 */
      }
    }
  }
  return [...new Set(out)].sort()
}

function summarizeVitest(logText) {
  const m = /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/.exec(logText ?? '')
  return {
    passed: m?.[2] ? Number(m[2]) : 0,
    failed: m?.[1] ? Number(m[1]) : 0,
    present: Boolean(m),
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const runDir = args['run-dir'] ? path.resolve(args['run-dir']) : null
  if (!runDir || !fs.existsSync(runDir)) {
    console.error(`运行目录不存在：${runDir ?? '<未给出>'}`)
    process.exit(2)
  }
  const outPath = args.out ? path.resolve(args.out) : path.join(runDir, 'acceptance-report.json')

  // ── 阶段片段 ──────────────────────────────────────────────────────────
  const stagesDir = path.join(runDir, 'stages')
  const fragments = fs.existsSync(stagesDir)
    ? fs
        .readdirSync(stagesDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => readJsonIfExists(path.join(stagesDir, f)))
        .filter(Boolean)
    : []
  const stages = Object.fromEntries(fragments.map((f) => [f.id, f]))
  const runState = readJsonIfExists(path.join(runDir, 'run-state.json')) ?? {}
  // 阶段顺序：优先用编排写入的 `stageOrder`（执行序），否则按文件名序（旧归档兼容）
  const order = Array.isArray(runState.stageOrder) ? runState.stageOrder : []
  const orderedFragments = [...fragments].sort((a, b) => {
    const ia = order.indexOf(a.id)
    const ib = order.indexOf(b.id)
    if (ia === -1 && ib === -1) return a.id.localeCompare(b.id)
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  })

  // ── L1 归档 ───────────────────────────────────────────────────────────
  const l1Dirs = findL1RunDirs(runDir)
  const l1Dir = l1Dirs[0] ?? null
  const l1SecondDir = l1Dirs[1] ?? null
  const l1Result = l1Dir ? readJsonIfExists(path.join(l1Dir, REAL_EXPORT_FILES.result)) : null

  const p = (relPath) => path.join(runDir, relPath)
  const paths = {
    runDir,
    runState: p('run-state.json'),
    l1Archive: l1Dir,
    l1ArchiveSecond: l1SecondDir,
    l1Result: l1Dir ? path.join(l1Dir, REAL_EXPORT_FILES.result) : null,
    l1ExportFull: l1Dir ? path.join(l1Dir, REAL_EXPORT_FILES.full) : null,
    l1ExportDegradedAll: l1Dir ? path.join(l1Dir, REAL_EXPORT_FILES.degradedAll) : null,
    verifyFull: p('verify/oracle-full.json'),
    verifyDegradedAe2: p('verify/oracle-degraded-ae2.json'),
    verifyDegradedAll: p('verify/oracle-degraded-all.json'),
    staticChecks: p('static-checks.json'),
    falsification: p('falsification/falsification.json'),
    fakeProvider: p('falsification/fake-provider.json'),
    playwrightL2: p('web/l2-real-export.json'),
    playwrightPartsFixtures: p('web/parts-fixtures.json'),
    playwrightMultiblockCross: p('web/multiblock-cross.json'),
    vitestLog: p('logs/regression-vitest.log'),
    buildModLog: p('logs/build-mod-gtnh.log'),
    buildWebLog: p('logs/build-web.log'),
    l2Observations: p('web/l2-observations.json'),
    idempotency: p('idempotency.json'),
  }

  const verify = {
    full: readJsonIfExists(paths.verifyFull),
    degradedAe2: readJsonIfExists(paths.verifyDegradedAe2),
    degradedAll: readJsonIfExists(paths.verifyDegradedAll),
  }
  const staticChecks = readJsonIfExists(paths.staticChecks)
  const falsification = readJsonIfExists(paths.falsification)
  const fakeProviderReport = readJsonIfExists(paths.fakeProvider)
  const l2Observations = readJsonIfExists(paths.l2Observations)
  const playwright = {
    l2RealExport: readJsonIfExists(paths.playwrightL2),
    partsFixtures: readJsonIfExists(paths.playwrightPartsFixtures),
    multiblockCross: readJsonIfExists(paths.playwrightMultiblockCross),
  }
  const vitestLog = fs.existsSync(paths.vitestLog) ? fs.readFileSync(paths.vitestLog, 'utf8') : ''
  const vitest = summarizeVitest(vitestLog)
  const idempotencyFile = readJsonIfExists(paths.idempotency)

  // checklist 用到的派生字段（把 verify 报告的 observations 摊平到顶层，便于判据直读）
  const flat = (r) => (r ? { ...r, ...(r.observations ?? {}) } : null)

  const ctx = {
    runDir,
    paths,
    stages,
    stageList: fragments,
    l1Result,
    verify: {
      full: flat(verify.full),
      degradedAe2: flat(verify.degradedAe2),
      degradedAll: flat(verify.degradedAll),
    },
    staticChecks,
    falsification,
    fakeProvider:
      (fakeProviderReport?.controls ?? []).find((c) => c.id === 'fake-provider-tolerance') ??
      (falsification?.controls ?? []).find((c) => c.id === 'fake-provider-tolerance') ??
      null,
    playwright,
    vitest,
    l2Observations,
    webSrcScan: staticChecks?.sections?.webNoBoxConstruction ?? null,
    protoScan: staticChecks?.sections?.protoContractFields ?? null,
    crossRunIdentical: idempotencyFile?.allSame ?? null,
    reportStable: null,
  }

  // ── 清单（跑三遍：前两遍用于"报告判定重算稳定"的幂等证据，第三遍是最终判定）──────
  ctx.reportStable = true
  const serialize = (list) => JSON.stringify(list.map((c) => [c.id, c.status, c.detail]))
  const firstPass = serialize(runPartsChecklist(ctx))
  const secondPass = serialize(runPartsChecklist(ctx))
  ctx.reportStable = firstPass === secondPass
  const checks = runPartsChecklist(ctx)

  /**
   * 依赖阶段未运行 ⇒ 该清单项记 `not-run`（**不计为通过**，也不误报"判据被违反"）。
   * `na` 保持不动（显式声明本编排无法行使）。
   */
  for (const c of checks) {
    if (c.status === 'na') continue
    const deps = PART_CHECK_STAGE_DEPS[c.id] ?? []
    const missing = deps.filter((d) => !stages[d] || stages[d].status === 'not-run')
    if (missing.length === 0) continue
    c.originalStatus = c.status
    c.status = 'not-run'
    c.detail = `依赖阶段未运行：${missing.join(', ')}（原判据结论 ${c.originalStatus}：${c.detail}）`
  }

  // ── 与上次报告逐条比对（幂等验收）──────────────────────────────────────
  let verdictsMatch = null
  let priorRun = null
  if (args['compare-with']) {
    const priorPath = path.resolve(args['compare-with'])
    const prior = readJsonIfExists(priorPath)
    if (prior && Array.isArray(prior.checks)) {
      const byId = new Map(prior.checks.map((c) => [c.id, c.status]))
      const perCheck = checks.map((c) => ({ id: c.id, now: c.status, prior: byId.get(c.id) ?? null, same: byId.get(c.id) === c.status }))
      verdictsMatch = perCheck.length > 0 && perCheck.every((x) => x.same)
      priorRun = {
        path: rel(priorPath),
        label: prior.label ?? null,
        verdict: prior.verdict?.status ?? null,
        perCheck,
        differing: perCheck.filter((x) => !x.same),
      }
    } else {
      verdictsMatch = false
      priorRun = { path: rel(priorPath), label: null, verdict: null, perCheck: [], differing: [], error: '上次报告不可读或缺 checks[]' }
    }
  }

  // ── findings（实现偏差 / 测量观察登记）──────────────────────────────────
  const findings = []
  for (const f of l2Observations?.findings ?? []) {
    findings.push({
      ...f,
      source: 'L2 真实导出渲染断言（web/e2e/parts-real-export.spec.ts 偏差锁）',
      evidence: [rel(paths.l2Observations), rel(paths.playwrightL2)].filter(Boolean),
    })
  }
  if ((verify.full?.degenerateBoxes ?? []).length > 0) {
    findings.push({
      id: 'M1',
      severity: 'measurement',
      title: '平面类部件（AE2 成形/破坏面板）碰撞盒在某轴零厚度',
      observed: verify.full.degenerateBoxes.join(' | '),
      expectedAfterFix: '（无需修）契约 §3/§6 未禁止零厚度盒；L1/L2 判据按「逐轴 min≤max + 非全轴退化」判定',
      codeAnchor: 'P1.3 AE2 提供者取 IBoxProvider 原始盒（如实快照）；web/src/pure/partHit.ts 闭区间+容差命中',
      evidence: [rel(paths.verifyFull)],
    })
  }
  if ((verify.full?.familiesSeen ?? []).includes('eio')) {
    findings.push({
      id: 'M2',
      severity: 'contract-text',
      title: '契约 §3 示例把 EnderIO 族写作 `enderio`，实现统一用 `eio`',
      observed: `产物 family 集合 {${(verify.full?.familiesSeen ?? []).join(',')}}；L1 开关族名与 localId 前缀同为 eio`,
      expectedAfterFix: '契约 §3/§4 文本改为 eio（或实现改名）—— 二者只要一致即可；本轮只登记不改契约文件（写范围外）',
      codeAnchor: 'contract §3/§4 文本 vs mod PartSource/PartProviderRegistry 开关；scripts/parts-acceptance/README.md',
      evidence: [rel(paths.verifyFull)],
    })
  }
  findings.push({
    id: 'M3',
    severity: 'known-limitation',
    title: '动画纹理物品图标的跨进程不确定性（EnderIO 导管 .mcmeta）',
    observed: 'L1 验收会话在 EXPORT 阶段起始将图集动画精灵复位到帧 0，保证跨轮字节幂等；长期方案（图标渲染确定性化）未定',
    expectedAfterFix: 'P1.7/P2 侧拍板长期方案；BlockThumbnailRenderer 对动画方块纹理有同款隐患（本结构未命中）',
    codeAnchor: 'scripts/parts-acceptance/README.md §契约缺口登记 0',
    evidence: [rel(paths.staticChecks)].filter(Boolean),
  })

  // F3：跨会话 FMP stale-tile 累积（本轮 P3.1 实测擒获；mod 侧，写范围外 ⇒ 只登记）
  const f3EvidenceDir = path.join(runDir, 'findings', 'F3')
  const f3Files = fs.existsSync(f3EvidenceDir) ? fs.readdirSync(f3EvidenceDir).sort() : []
  findings.push({
    id: 'F3',
    severity: 'deviation',
    title: '跨会话 FMP stale-tile 累积：同一世界的第二次客户端会话导出翻倍（同槽位 #2 重复部件）',
    observed:
      'P3.1 首轮实测：同一验收世界连续两次客户端会话，overlay 区 FMP 格 `cellPartsGrid[12][1][5]` 由 3 部件' +
      '（fmp:slot0/1/2）变为 6 部件（追加 fmp:slot0#2/slot1#2/slot2#2），L1 内嵌验证器 4 条判据红、' +
      'L1 退出码 2；两次会话的全量导出 sha256 不同（084feda3… vs c2faeb45…）。' +
      '同一"清场（resetWorld 逐部件 remPart）+ 重建"路径在随后单会话运行中又恢复正常（3 部件）⇒ **时序相关、偶发**。' +
      '与计划 §9 已登记的探针开放项同源（服务端清理未同步客户端 stale tile → 新一轮 addPart 追加 ⇒ 翻倍）；' +
      '探针世界的 remPart 解法在验收世界并非万无一失。',
    expectedAfterFix:
      '验收世界跨会话清场做到确定性（如清场后校验客户端 jPartList 为空、或每轮从世界快照恢复后再清场）；' +
      '在那之前：编排以 **每轮单会话（L1Runs=1）** 运行，跨轮幂等由编排级 -Runs 2 承担 —— 且 L1 判据会**照实报红**（本项即由此擒获，非静默通过）',
    codeAnchor:
      'mod/gtnh/src/main/java/com/lightning/mod/client/meshcapture/parts/probe/PartsAcceptanceBuilder.java#resetWorld（remPart 通道）' +
      ' + PartProviderRegistry 的族内重复 `#N` 后缀（契约 §4）',
    evidence: [
      ...f3Files.map((f) => rel(path.join(f3EvidenceDir, f))),
      paths.l1Result ? rel(paths.l1Result) : null,
    ].filter(Boolean),
  })

  // F5：AE2 线缆总线格偶发整格缺失（P3.1 实测；mod 侧，写范围外 ⇒ 只登记）
  const f5EvidenceDir = path.join(runDir, 'findings', 'F5')
  const f5Files = fs.existsSync(f5EvidenceDir) ? fs.readdirSync(f5EvidenceDir).sort() : []
  findings.push({
    id: 'F5',
    severity: 'deviation',
    title: 'AE2 线缆总线格偶发整格缺失（单次客户端会话里该格部件未落盘）',
    observed:
      'P3.1 实测两类样本：① overlay 区 AE2 格 `cellPartsGrid[12][1][3]`（世界 [68,12,76]，facade+线缆）' +
      '三套件同报 `FAIL: 部件格应有 partLists 下标（实际 -1）`，计数 `ItemMultiPart:16` 5→4、`ItemFacade:0` 2→1；' +
      '② variants 区两格 `[12][1][2]`/`[12][1][4]`（世界 [67,12,78]/[69,12,78]，异色玻璃线缆）同报 `-1`，' +
      '计数 `ItemMultiPart:14`/`:11` 1→缺。两次都在下一轮恢复正常 ⇒ 偶发、非确定性' +
      '（本轮 13 次客户端会话中共现 2 次）。可疑根因：客户端区块/图块装载发生在 build 之前或之后不确定，' +
      '而 `chunkWaitTicks` 不可由触发文件配置（只有 `syncWaitTicks` 可）。',
    expectedAfterFix:
      '把"客户端区块就绪"作为 build 的前置条件（或让 chunkWaitTicks 可由触发文件配置）；编排侧已缓解：' +
      '`-SyncWaitTicks` 默认加宽到 120（=6s，post-build 同步窗口）；判定式照实报红（不静默）',
    codeAnchor:
      'mod/gtnh/.../parts/probe/PartsAcceptanceAutomation.java#chunkWaitTicks（硬编码 60，触发文件不可配）' +
      ' + ae2/Ae2PartProvider.java',
    evidence: [...f5Files.map((f) => rel(path.join(f5EvidenceDir, f))), paths.l1Result ? rel(paths.l1Result) : null].filter(Boolean),
  })

  // M4：干净房世界不可用（P3.1 实测；给出 -ResetWorld 默认关闭的机器理由）
  findings.push({
    id: 'M4',
    severity: 'measurement',
    title: '从零生成验收世界时导出产物无效（客户端同步窗口不足）',
    observed:
      'P3.1 实测：清掉验收世界后重建，36 格意图建造 0 错误，但客户端在 WAIT_SYNC（60 tick）窗口内未收到新建方块 ⇒' +
      ' `measured` 全格 hostFullCube=true、导出文件无 cellPartsGrid/partLists，三套件全部 FAIL: 导出文件缺 cellPartsGrid/partLists',
    expectedAfterFix:
      '（编排侧已处置）`-ResetWorld` 默认关闭：复用既有世界（自动化自带 resetWorld 清场 + 重建）；' +
      '若需干净房，须先让世界生成完成再重跑（mod 侧同步窗口另议）',
    codeAnchor: 'run-parts-acceptance.ps1#Reset-AcceptanceWorld / PartsAcceptanceAutomation#WAIT_SYNC（syncWaitTicks）',
    evidence: [paths.l1Result ? rel(paths.l1Result) : null].filter(Boolean),
  })

  const redChecks = checks.filter((c) => c.status === 'fail' || c.status === 'not-run')
  const naChecks = checks.filter((c) => c.status === 'na')
  const counts = {
    pass: checks.filter((c) => c.status === 'pass').length,
    fail: checks.filter((c) => c.status === 'fail').length,
    na: naChecks.length,
    notRun: checks.filter((c) => c.status === 'not-run').length,
    total: checks.length,
  }
  const verdictStatus = redChecks.length === 0 ? 'pass' : 'fail'
  const deviations = findings.filter((f) => f.severity === 'deviation')

  const report = {
    schema: 'lightning.acceptance.parts/1',
    generatedAt: new Date().toISOString(),
    label: runState.label ?? path.basename(runDir),
    mode: runState.mode ?? 'acceptance',
    scope: {
      command: runState.command ?? null,
      plan: 'docs/plan/non-full-cube-parts-plan.md §5（P3.1–P3.4）',
      contract: 'docs/contracts/format-parts-contract.md',
      zones: runState.zones ?? null,
      l1Runs: l1Dirs.length,
      l1Archive: l1Dir ? rel(l1Dir) : null,
      intentCells: l1Result?.intentCells ?? null,
    },
    verdict: {
      status: verdictStatus,
      counts,
      redChecks: redChecks.map((c) => ({ id: c.id, status: c.status, detail: c.detail })),
      naChecks: naChecks.map((c) => ({ id: c.id, detail: c.detail })),
      deviations: deviations.map((f) => ({ id: f.id, title: f.title })),
      note:
        verdictStatus === 'pass'
          ? `计划 §6 把关清单 ${counts.total} 条全部由机器判据给出（pass ${counts.pass} / fail ${counts.fail} / na ${counts.na} / not-run ${counts.notRun}）；` +
            `实现偏差登记 ${deviations.length} 条（见 findings，不静默）`
          : '存在 fail / not-run 条目（见 redChecks），不得以"人工看过"替代',
    },
    stages: orderedFragments.map((f) => ({
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
    checks,
    checklistGroups: [...new Set(checks.map((c) => c.groupLabel))].map((g) => ({
      label: g,
      total: checks.filter((c) => c.groupLabel === g).length,
      pass: checks.filter((c) => c.groupLabel === g && c.status === 'pass').length,
      fail: checks.filter((c) => c.groupLabel === g && c.status === 'fail').length,
      notRun: checks.filter((c) => c.groupLabel === g && c.status === 'not-run').length,
    })),
    l1: l1Result
      ? {
          status: l1Result.status,
          exitCode: l1Result.exitCode,
          label: l1Result.label,
          intentCells: l1Result.intentCells,
          suites: l1Result.suites,
          idempotencyFull: l1Result.idempotencyFull,
          fullCubeByteClean: l1Result.fullCubeByteClean,
          warnings: l1Result.warnings ?? [],
          archive: rel(l1Dir),
        }
      : { present: false },
    l2: {
      spec: 'web/e2e/parts-real-export.spec.ts',
      report: rel(paths.playwrightL2),
      cases: Object.fromEntries(
        [
          ['parseAndRender', 'mesh 渲染、无 DataCloneError'],
          ['fastNegative', '满方块格必须无部件'],
          ['singleBoxHover', '单盒区（slab / 栅栏 / 箱子）'],
          ['ae2MultiPartHover', 'AE2 区同格多部件'],
          ['fullCubeHover', '满方块格：悬停不携带部件'],
          ['statsCounts', '默认视图行 = oracle expectedCounts'],
          ['deviationLock', '偏差锁 F1/F2'],
          ['degradedAllParse', 'degraded_all：全格落档 3'],
          ['degradedAllStats', 'degraded_all 统计'],
        ].map(([k, needle]) => [k, caseSummary(playwright.l2RealExport, needle)]),
      ),
      observations: l2Observations ?? null,
    },
    regression: {
      partsFixtures: {
        spec: 'web/e2e/parts-hover-stats.spec.ts + parts-falsification.spec.ts（P2.5 断言包）',
        report: rel(paths.playwrightPartsFixtures),
        threeViewSwitch: caseSummary(playwright.partsFixtures, '三视图切换：切宿主 = 旧口径行集'),
        legacyMinimalV2: caseSummary(playwright.partsFixtures, 'minimal-v2'),
        falsificationSpec: caseSummary(playwright.partsFixtures, '证伪'),
      },
      multiblockCross: {
        spec: runState.multiblockCrossSpec ?? 'web/e2e/multiblock-fixture-load.spec.ts',
        report: rel(paths.playwrightMultiblockCross),
        cases: caseSummary(playwright.multiblockCross, ''),
        note: runState.multiblockCrossNote ?? null,
      },
      vitest,
      builds: {
        mod: stages['build-mod-gtnh']?.status ?? 'missing',
        web: stages['build-web']?.status ?? 'missing',
      },
    },
    degradation: {
      staticChecks: staticChecks?.sections
        ? {
            inferredNeverPrimary: staticChecks.sections.inferredNeverPrimary,
            tierDegradation: staticChecks.sections.tierDegradation,
            fullCubeByteClean: staticChecks.sections.fullCubeByteClean,
            legacyNoPartsKeys: staticChecks.sections.legacyNoPartsKeys,
            webNoBoxConstruction: {
              pass: staticChecks.sections.webNoBoxConstruction?.pass,
              scanned: (staticChecks.sections.webNoBoxConstruction?.scanned ?? []).length,
              boxConstructionHits: staticChecks.sections.webNoBoxConstruction?.boxConstructionHits ?? [],
              gameLogicHits: staticChecks.sections.webNoBoxConstruction?.gameLogicHits ?? [],
            },
            protoContractFields: staticChecks.sections.protoContractFields,
          }
        : null,
      verify: {
        full: verify.full ? { pass: verify.full.pass, checks: verify.full.checks, failed: verify.full.failedChecks, countsMode: verify.full.countsMode, observations: verify.full.observations } : null,
        degradedAe2: verify.degradedAe2 ? { pass: verify.degradedAe2.pass, checks: verify.degradedAe2.checks, failed: verify.degradedAe2.failedChecks } : null,
        degradedAll: verify.degradedAll ? { pass: verify.degradedAll.pass, checks: verify.degradedAll.checks, failed: verify.degradedAll.failedChecks, observations: verify.degradedAll.observations } : null,
      },
    },
    falsification: falsification
      ? {
          pass: falsification.pass,
          positiveControl: falsification.positiveControl,
          summary: falsification.summary,
          controls: (falsification.controls ?? []).map((c) => ({
            id: c.id,
            intent: c.intent,
            ok: c.ok,
            exitCode: c.exitCode,
            expectedRed: c.expectedRed ?? false,
            detail: c.detail,
            evidence: c.evidence ?? null,
          })),
          report: rel(paths.falsification),
        }
      : null,
    idempotency: {
      l1SameRun: l1Result?.idempotencyFull ?? null,
      l1Runs: l1Dirs.map((d) => rel(d)),
      crossRun: idempotencyFile ?? null,
      reportStable: ctx.reportStable,
      verdictsMatch,
      priorRun: priorRun
        ? { path: priorRun.path, label: priorRun.label, verdict: priorRun.verdict, differing: priorRun.differing, error: priorRun.error ?? null }
        : null,
      excludedPatterns: idempotencyFile?.excludedPatterns ?? [
        'acceptance-report.json#generatedAt',
        'stages/*.json#startedAt/endedAt/durationMs',
        'l1/*/sde_parts_acceptance_result.json#startedAtEpochMs/finishedAtEpochMs',
        'logs/*.log（含真实时刻与耗时）',
      ],
      note:
        '幂等口径：结构与判定必须逐条一致；**时间戳字段除外**（上列模式已显式排除，报告中标注）。' +
        'L1 内部 `-Runs 2` 已提供"同轮双导出 + 跨轮产物 sha256"两级字节级证据。',
    },
    findings,
    openItems: runState.openItems ?? [],
    adjudications: runState.adjudications ?? [],
    environment: {
      git: runState.git ?? null,
      os: runState.os ?? null,
      node: process.version,
      interactivity: runState.interactivity ?? null,
      java: runState.java ?? null,
    },
    evidenceLayout: {
      runDir: rel(runDir),
      report: rel(outPath),
      stages: rel(stagesDir),
      logs: rel(path.join(runDir, 'logs')),
      l1: l1Dir ? rel(l1Dir) : null,
      verify: rel(path.join(runDir, 'verify')),
      staticChecks: rel(paths.staticChecks),
      falsification: rel(path.join(runDir, 'falsification')),
      web: rel(path.join(runDir, 'web')),
    },
  }

  writeJson(outPath, report)
  writeText(path.join(runDir, 'acceptance-report.md'), mdSummary(report) + '\n')

  console.log(`[parts-report] 报告：${outPath}`)
  console.log(
    `  判定：${verdictStatus}（pass ${counts.pass} / fail ${counts.fail} / na ${counts.na} / not-run ${counts.notRun}，共 ${counts.total} 条）`,
  )
  for (const c of redChecks) console.log(`  XX [${c.status}] ${c.id} — ${c.detail}`)
  for (const f of findings) console.log(`  !! [${f.severity}] ${f.id} — ${f.title}`)
  console.log(`  人读摘要：${path.join(runDir, 'acceptance-report.md')}`)
  process.exit(verdictStatus === 'pass' ? 0 : 1)
}

function mdSummary(report) {
  const L = []
  L.push(`# 部件验收报告（P3.1–P3.4）—— \`${report.label}\``)
  L.push('')
  L.push(`> 判定 **${report.verdict.status}** —— ${report.verdict.note}`)
  L.push(`> 生成时间：${report.generatedAt}（时间戳字段不参与幂等比对）`)
  L.push('')
  L.push('## 阶段')
  L.push('')
  L.push('| 阶段 | 状态 | 退出码 | 耗时 | 命令 |')
  L.push('|------|------|--------|------|------|')
  for (const s of report.stages) {
    L.push(`| ${s.id} | ${s.status} | ${s.exitCode ?? '-'} | ${s.durationMs != null ? Math.round(s.durationMs / 1000) + 's' : '-'} | \`${s.command ?? ''}\` |`)
  }
  L.push('')
  L.push('## 计划 §6 把关清单（机器判定）')
  L.push('')
  for (const g of report.checklistGroups) {
    L.push(`### ${g.label} —— pass ${g.pass}/${g.total}${g.fail ? ` / **fail ${g.fail}**` : ''}${g.notRun ? ` / not-run ${g.notRun}` : ''}`)
    L.push('')
    for (const c of report.checks.filter((x) => x.groupLabel === g.label)) {
      L.push(`- **${c.status === 'pass' ? '✔' : c.status === 'fail' ? '✘' : c.status === 'na' ? '–' : '·'} \`${c.id}\`** ${c.label}`)
      L.push(`  - ${c.detail}`)
      if (c.evidence?.length) L.push(`  - 证据：${c.evidence.slice(0, 4).map((e) => `\`${e}\``).join('、')}`)
    }
    L.push('')
  }
  L.push('## 证伪（负对照）')
  L.push('')
  for (const c of report.falsification?.controls ?? []) {
    L.push(`- ${c.ok ? '✔' : '✘'} \`${c.id}\`${c.expectedRed ? '（负对照，期望红）' : ''} — ${c.detail}`)
  }
  L.push('')
  L.push('## 实现偏差 / 测量观察登记')
  L.push('')
  for (const f of report.findings) {
    L.push(`- **[${f.severity}] ${f.id}** ${f.title}`)
    L.push(`  - 观测：${f.observed}`)
    L.push(`  - 期望：${f.expectedAfterFix}`)
    if (f.codeAnchor) L.push(`  - 锚点：${f.codeAnchor}`)
  }
  L.push('')
  L.push('## 幂等')
  L.push('')
  L.push(`- L1 同轮双导出 sha256 一致：${report.l1.idempotencyFull?.identical ?? 'n/a'}`)
  L.push(`- 报告判定重算稳定：${report.idempotency.reportStable}`)
  L.push(`- 跨轮（-Runs 2）：${report.idempotency.crossRun ? (report.idempotency.crossRun.allSame ? '产物逐字节一致' : '**有差异**') : '未启用'}`)
  if (report.idempotency.verdictsMatch !== null) {
    L.push(`- 与上次报告逐条判定比对：${report.idempotency.verdictsMatch ? '一致' : '**不一致**'}（${report.idempotency.priorRun?.path}）`)
  }
  L.push(`- 排除项：${(report.idempotency.excludedPatterns ?? []).map((x) => `\`${x}\``).join('、')}`)
  L.push('')
  if (report.openItems?.length) {
    L.push('## 开放项 / 裁决登记')
    L.push('')
    for (const o of report.openItems) L.push(`- [${o.severity}] \`${o.id}\` ${o.text}`)
    for (const a of report.adjudications ?? []) L.push(`- [裁决] \`${a.id}\` ${a.text}`)
    L.push('')
  }
  return L.join('\n')
}

main()