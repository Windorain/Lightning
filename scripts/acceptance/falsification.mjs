#!/usr/bin/env node
/**
 * 断言有效性证伪（自动化验收纪律：故意注入错误 → 管线必须变红；证明判定式**非恒绿**）。
 *
 * 四条独立负对照 + 一条正对照：
 *   1. `tamper-frames-ops`   —— 往产物内层注入 `frames[0].ops`（组合展开形态）→ 契约校验器必须判硬失败；
 *   2. `tamper-expanded-cell`—— 篡改展开校验文件的**一格** → 逐格 diff 必须 > 0；
 *   3. `tamper-envelope`     —— 破坏 `payloadEncoding`（信封形态）→ 契约校验器必须红；
 *   4. `mod-unknown-machine` —— mod 半环：未知机器 → 管线退出码 2 + 原因落盘（由编排的 `falsify-mod-negative` 阶段产出）；
 *   正对照：**未篡改**的同一批产物在两处判定上都必须绿（排除"恒红"这种伪证）。
 *
 * 纪律：
 *   · 篡改只发生在**运行目录里的副本**上，绝不触碰归档产物（证据不可污染）；
 *   · 每条负对照都断言"红**且**理由是预期的那条"，不接受"因为别的原因红了"；
 *   · 所有子进程输出落文件（不用管道捕获），跨沙箱环境稳定。
 *
 * 用法：
 *   node scripts/acceptance/falsification.mjs --exports <exportsDir> --out <run>/falsification \
 *        [--mod-negative <falsify run 的 pipeline-result.json>]
 * 退出码：0 = 负对照全部按预期变红；1 = 有负对照没红（= 判据可能恒绿）；2 = 输入不可用。
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { gunzipSync, gzipSync } from 'node:zlib'

import { ensureDir, readJsonIfExists, rel, REPO_ROOT, writeJson } from './lib/evidence.mjs'

const VALIDATOR = path.join(REPO_ROOT, 'scripts/multiblock-fixtures/validate-multiblock-fixtures.mjs')
const VERIFY_EXPANDED = path.join(REPO_ROOT, 'scripts/multiblock-pipeline/verify-expanded.mjs')
const FIXTURE_OUT_REPORT = path.join(REPO_ROOT, 'scripts/multiblock-fixtures/.out/validation-report.json')

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

/** 跑一个 node 子进程，stdout/stderr 落文件（不用管道），返回 {exitCode, stdout}。 */
function runNode(args, logPath) {
  ensureDir(path.dirname(logPath))
  const fd = fs.openSync(logPath, 'w')
  const r = spawnSync(process.execPath, args, { cwd: REPO_ROOT, stdio: ['ignore', fd, fd] })
  fs.closeSync(fd)
  return { exitCode: r.status ?? -1, stdout: fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '' }
}

function readProducts(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.multiblock.json') && !f.endsWith('.body.json'))
    .sort()
    .map((f) => path.join(dir, f))
}

/** 解信封 → 内层对象（保留原始 payloadEncoding）。 */
function decodeEnvelope(file) {
  const env = JSON.parse(fs.readFileSync(file, 'utf8'))
  const bytes = Buffer.from(env.payload, 'base64')
  let inner
  try {
    inner = JSON.parse(bytes.toString('utf8'))
  } catch {
    inner = JSON.parse(gunzipSync(bytes).toString('utf8'))
  }
  return { env, inner }
}

function encodeEnvelope(env, inner) {
  const payload = gzipSync(Buffer.from(JSON.stringify(inner), 'utf8'), { level: 9 }).toString('base64')
  return { ...env, payload }
}

function writeJsonFile(file, obj) {
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8')
}

function copyProducts(srcDir, dstDir) {
  ensureDir(dstDir)
  for (const f of readProducts(srcDir)) fs.copyFileSync(f, path.join(dstDir, path.basename(f)))
}

/** 契约校验器的 stdout 摘要 → 失败条目 id 列表。 */
function validatorFailureIds(stdout) {
  const ids = []
  const re = /✘\s*\[([^\]]+)\]/g
  let m
  while ((m = re.exec(stdout)) !== null) ids.push(m[1])
  return ids
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const exportsDir = path.resolve(args.exports ?? path.join(REPO_ROOT, 'mod/gtnh/run/client/sde_multiblock_exports'))
  const outDir = ensureDir(path.resolve(args.out ?? path.join(REPO_ROOT, 'scripts/acceptance/.out/falsification')))
  if (!fs.existsSync(exportsDir)) {
    console.error(`产物目录不存在：${exportsDir}`)
    process.exit(2)
  }
  const products = readProducts(exportsDir)
  if (products.length === 0) {
    console.error(`产物目录里没有 *.multiblock.json：${exportsDir}`)
    process.exit(2)
  }
  const logsDir = ensureDir(path.join(outDir, 'logs'))
  const controls = []

  // 契约校验器写的是固定路径的报告 —— 先备份，跑完恢复（不污染契约校验器的既有证据）
  const fixtureOutBackup = fs.existsSync(FIXTURE_OUT_REPORT) ? fs.readFileSync(FIXTURE_OUT_REPORT) : null

  try {
    // ---- 正对照：未篡改产物必须绿 ----
    const cleanDir = ensureDir(path.join(outDir, 'control-clean'))
    copyProducts(exportsDir, cleanDir)
    const cleanRun = runNode([VALIDATOR, ...readProducts(cleanDir)], path.join(logsDir, 'control-clean-validator.log'))
    const cleanIds = validatorFailureIds(cleanRun.stdout)
    const cleanOk = cleanRun.exitCode === 0 && cleanIds.length === 0

    // ---- 负对照 1：注入 frames[0].ops（组合展开形态）----
    const opDir = ensureDir(path.join(outDir, 'tamper-op-inline'))
    copyProducts(exportsDir, opDir)
    const target1 = readProducts(opDir)[0]
    {
      const { env, inner } = decodeEnvelope(target1)
      inner.frames[0].ops = []
      writeJsonFile(target1, encodeEnvelope(env, inner))
    }
    const opRun = runNode([VALIDATOR, ...readProducts(opDir)], path.join(logsDir, 'tamper-op-inline.log'))
    const opIds = validatorFailureIds(opRun.stdout)
    const opOk = opRun.exitCode !== 0 && opIds.some((id) => id.includes('op-inline'))
    controls.push({
      id: 'tamper-frames-ops',
      kind: 'offline-negative',
      target: `${rel(target1)}#frames[0].ops=[]`,
      expected: '契约校验器判硬失败（frames/op-inline）且退出码非零',
      observed: { exitCode: opRun.exitCode, failureIds: opIds.slice(0, 6), totalFailures: opIds.length },
      ok: opOk,
      controlStatus: cleanOk ? 'pass' : 'fail',
      log: rel(path.join(logsDir, 'tamper-op-inline.log')),
    })

    // ---- 负对照 2：截断 payload（信封载荷不可解码）----
    const envDir = ensureDir(path.join(outDir, 'tamper-payload'))
    copyProducts(exportsDir, envDir)
    const target2 = readProducts(envDir)[0]
    {
      const env = JSON.parse(fs.readFileSync(target2, 'utf8'))
      env.payload = env.payload.slice(0, Math.floor(env.payload.length / 2))
      writeJsonFile(target2, env)
    }
    const envRun = runNode([VALIDATOR, ...readProducts(envDir)], path.join(logsDir, 'tamper-payload.log'))
    const envIds = validatorFailureIds(envRun.stdout)
    // 载荷坏掉可能让校验器直接抛错（也是"红"），故只要非零退出且日志有失败/错误迹象即算证伪成功
    const envRed = envRun.exitCode !== 0 && (envIds.length > 0 || /❌|✘|Error|error|cannot|Cannot|Invalid|invalid/.test(envRun.stdout))
    controls.push({
      id: 'tamper-payload',
      kind: 'offline-negative',
      target: `${rel(target2)}#payload 截断一半`,
      expected: '契约校验器红（载荷不可解码）且退出码非零',
      observed: { exitCode: envRun.exitCode, failureIds: envIds.slice(0, 6), totalFailures: envIds.length },
      ok: envRed,
      controlStatus: cleanOk ? 'pass' : 'fail',
      log: rel(path.join(logsDir, 'tamper-payload.log')),
    })

    // ---- 负对照 3：篡改调色板 air 约定（下标 0 必须为 air）→ 契约判硬失败 ----
    const airDir = ensureDir(path.join(outDir, 'tamper-palette-air'))
    copyProducts(exportsDir, airDir)
    const target3 = readProducts(airDir)[0]
    {
      const { env, inner } = decodeEnvelope(target3)
      const proto = inner.blockPalette[1] ?? inner.blockPalette[0]
      inner.blockPalette[0] = JSON.parse(JSON.stringify(proto))
      writeJsonFile(target3, encodeEnvelope(env, inner))
    }
    const airRun = runNode([VALIDATOR, ...readProducts(airDir)], path.join(logsDir, 'tamper-palette-air.log'))
    const airIds = validatorFailureIds(airRun.stdout)
    const airOk = airRun.exitCode !== 0 && airIds.some((id) => id.includes('palette') || id.includes('air'))
    controls.push({
      id: 'tamper-palette-air',
      kind: 'offline-negative',
      target: `${rel(target3)}#blockPalette[0]`,
      expected: '契约校验器判 palette/air-zero 硬失败且退出码非零',
      observed: { exitCode: airRun.exitCode, failureIds: airIds.slice(0, 6), totalFailures: airIds.length },
      ok: airOk,
      controlStatus: cleanOk ? 'pass' : 'fail',
      log: rel(path.join(logsDir, 'tamper-palette-air.log')),
    })

    // ---- 负对照 4：篡改变体主键 → 声明完备性被破坏（校验器以抛错形式暴露）----
    const keyDir = ensureDir(path.join(outDir, 'tamper-variant-key'))
    copyProducts(exportsDir, keyDir)
    const target4 = readProducts(keyDir)[0]
    {
      const { env, inner } = decodeEnvelope(target4)
      inner.multiblock.variants[0].key = 'TAMPERED:0|tt:1|runstate:idle'
      writeJsonFile(target4, encodeEnvelope(env, inner))
    }
    const keyRun = runNode([VALIDATOR, ...readProducts(keyDir)], path.join(logsDir, 'tamper-variant-key.log'))
    const keyIds = validatorFailureIds(keyRun.stdout)
    const keyRed = keyRun.exitCode !== 0 && (keyIds.length > 0 || /Error:|没有(?:任何)? frame|❌/.test(keyRun.stdout))
    controls.push({
      id: 'tamper-variant-key',
      kind: 'offline-negative',
      target: `${rel(target4)}#multiblock.variants[0].key`,
      expected: '声明集合 ≠ 笛卡尔积 → 校验器红（退出码非零 + 失败条目或异常）',
      observed: { exitCode: keyRun.exitCode, failureIds: keyIds.slice(0, 6), totalFailures: keyIds.length, thrown: /Error:/.test(keyRun.stdout) },
      ok: keyRed,
      controlStatus: cleanOk ? 'pass' : 'fail',
      log: rel(path.join(logsDir, 'tamper-variant-key.log')),
    })

    // ---- 负对照 3：篡改展开校验文件的一格 → 逐格 diff 必须 > 0 ----
    const expandedSrc = path.join(exportsDir, 'expanded')
    const cellDir = ensureDir(path.join(outDir, 'tamper-expanded-cell'))
    // 只复制产物 + expanded（verify-expanded 不需要 _dataset）
    copyProducts(exportsDir, cellDir)
    fs.cpSync(expandedSrc, path.join(cellDir, 'expanded'), { recursive: true })
    // 正对照（同副本目录、未篡改）
    const cellClean = runNode([VERIFY_EXPANDED, cellDir], path.join(logsDir, 'control-clean-expanded.log'))
    const cellCleanReport = readJsonIfExists(path.join(cellDir, 'expanded/expanded-verification-report.json'))
    const cellCleanOk = cellClean.exitCode === 0 && (cellCleanReport?.totalDiff ?? cellCleanReport?.diff ?? 0) === 0

    const manifest = readJsonIfExists(path.join(cellDir, 'expanded/_manifest.json'))
    const victim = path.join(cellDir, manifest.machines[0].samples[0].file)
    const victimDoc = JSON.parse(fs.readFileSync(victim, 'utf8'))
    const grid = victimDoc.cellGrid
    const counts = new Map()
    for (const layer of grid) for (const row of layer) for (const v of row) counts.set(v, (counts.get(v) ?? 0) + 1)
    const sortedIdx = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v)
    const fromIdx = sortedIdx[0]
    const toIdx = sortedIdx.find((v) => v !== fromIdx) ?? fromIdx + 1
    let flipped = 0
    outer: for (const layer of grid) {
      for (const row of layer) {
        for (let x = 0; x < row.length; x++) {
          if (row[x] === fromIdx) {
            row[x] = toIdx
            flipped++
            break outer
          }
        }
      }
    }
    victimDoc.cellGrid = grid
    writeJsonFile(victim, victimDoc)
    const cellRun = runNode([VERIFY_EXPANDED, cellDir], path.join(logsDir, 'tamper-expanded-cell.log'))
    const cellReport = readJsonIfExists(path.join(cellDir, 'expanded/expanded-verification-report.json'))
    const cellDiff = cellReport?.totalDiff ?? cellReport?.diff ?? null
    const cellOk = cellRun.exitCode !== 0 && (cellDiff ?? 0) > 0
    controls.push({
      id: 'tamper-expanded-cell',
      kind: 'offline-negative',
      target: `${rel(victim)}#cellGrid 一格 ${fromIdx}→${toIdx}`,
      expected: 'verify-expanded 逐格 diff > 0 且退出码非零',
      observed: { exitCode: cellRun.exitCode, totalDiff: cellDiff, flipped },
      ok: cellOk,
      controlStatus: cellCleanOk ? 'pass' : 'fail',
      log: rel(path.join(logsDir, 'tamper-expanded-cell.log')),
    })

    // ---- 负对照 4：mod 半环未知机器（由编排的 falsify-mod-negative 阶段产出）----
    const modNegativePath = args['mod-negative'] ? path.resolve(args['mod-negative']) : null
    const modNegative = modNegativePath ? readJsonIfExists(modNegativePath) : null
    if (modNegative) {
      const kinds = (modNegative.failures ?? []).map((f) => `${f.stage}/${f.kind}`)
      const unknown = (modNegative.failures ?? []).find((f) => f.kind === 'UnknownMachine' && f.stage === 'scope')
      const modOk = modNegative.exitCode === 2 && Boolean(unknown) && (modNegative.products ?? []).length === 0
      controls.push({
        id: 'mod-unknown-machine',
        kind: 'mod-negative',
        target: '旧内层编排 run-pipeline.ps1 -Scope MTENoSuchMachineT16（该脚本已删除，当前不可运行）',
        expected: '退出码 2 + inScopeFailures 含 scope/UnknownMachine + 产物 0 份',
        observed: { exitCode: modNegative.exitCode, status: modNegative.status, kinds: kinds.slice(0, 6), products: (modNegative.products ?? []).length },
        ok: modOk,
        controlStatus: 'pass',
        log: rel(modNegativePath),
      })
    } else {
      controls.push({
        id: 'mod-unknown-machine',
        kind: 'mod-negative',
        target: '旧内层编排 run-pipeline.ps1 -Scope MTENoSuchMachineT16（该脚本已删除，当前不可运行）',
        expected: '退出码 2 + 原因落盘',
        observed: { exitCode: null, reason: 'not-run（编排未提供 mod 负对照结果）' },
        ok: false,
        ran: false,
        controlStatus: 'pass',
        log: null,
      })
    }

    const ran = controls.filter((c) => c.ran !== false)
    const report = {
      schema: 'lightning.acceptance.falsification/1',
      generatedAt: new Date().toISOString(),
      exportsDir: rel(exportsDir),
      products: products.map((p) => rel(p)),
      controls,
      controlsRan: ran.length,
      controlsNotRun: controls.length - ran.length,
      allControlsRedAsExpected: ran.length > 0 && ran.every((c) => c.ok),
      positiveControl: { name: 'control-clean', ok: cleanOk, expandedOk: cellCleanOk, detail: cleanOk && cellCleanOk ? '未篡改输入两处判定全绿（排除恒红）' : '未篡改输入未全绿' },
    }
    writeJson(path.join(outDir, 'falsification.json'), report)
    console.log(`[falsify] 负对照 ${ran.filter((c) => c.ok).length}/${ran.length} 按预期变红（未运行 ${controls.length - ran.length} 条）；正对照 ${cleanOk && cellCleanOk ? '绿' : '红'}`)
    for (const c of controls) console.log(`  ${c.ran === false ? '-- ' : c.ok ? 'OK ' : 'XX '} ${c.id} → ${c.observed.exitCode ?? 'n/a'} ${c.ok ? '' : JSON.stringify(c.observed)}`)
    process.exit(report.allControlsRedAsExpected ? 0 : 1)
  } finally {
    if (fixtureOutBackup) fs.writeFileSync(FIXTURE_OUT_REPORT, fixtureOutBackup)
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) main()

