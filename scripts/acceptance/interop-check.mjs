#!/usr/bin/env node
/**
 * T3.4 · `/sde export`（wiki 路径）与 `/sde multiblock` **互不干扰**的机器判据。
 *
 * 调度者裁决（照此执行）：无头 `/sde export` 已实证可行（`tp` 到地面方块内 + `pos1/pos2` 构造确定性选区），
 * 编排为「同世界先后执行 `/sde export` 与 multiblock 导出」。本工具负责**跑完之后**的全部断言：
 *   1. `/sde export` 产物 SHA-256 = 基线（证据链：`scripts/multiblock-pipeline/.out/fix-thumb/sde_export_smoke.*.json`）；
 *   2. multiblock 产物目录在本阶段**逐字节未变**（两套产物目录互不影响）；
 *   3. 客户端日志证明加载的是**同一专用世界**（`sde_pipeline_world`），而不是玩家存档；
 *   4. 产物形态仍是既有 `/sde export` 形态（`base64(gzip(json))` 信封 + `blockPalette` + 缩略图字段在位）。
 *
 * 用法（两段式，编排按此调用）：
 *   node scripts/acceptance/interop-check.mjs snapshot --out <run>/interop/snapshot-before.json \
 *        --multiblock-exports <dir> --structure-exports <dir>
 *   node scripts/acceptance/interop-check.mjs compare  --run-dir <run> \
 *        --multiblock-exports <dir> --structure-exports <dir> \
 *        --log <client log> [--world sde_pipeline_world] [--baseline a,b,c] [--runs f1,f2]
 * 退出码：0 = 全绿；1 = 有硬失败；2 = 输入不可用。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { gunzipSync } from 'node:zlib'

import { diffSnapshots, ensureDir, readJsonIfExists, rel, REPO_ROOT, sha256File, sha256Text, snapshotDir, writeJson } from './lib/evidence.mjs'

const DEFAULT_BASELINES = [
  'scripts/multiblock-pipeline/.out/fix-thumb/sde_export_smoke.postfix.json',
  'scripts/multiblock-pipeline/.out/fix-thumb/sde_export_smoke.prefix-1.json',
  'scripts/multiblock-pipeline/.out/fix-thumb/sde_export_smoke.prefix-2.json',
]

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      out._.push(a)
      continue
    }
    const [k, v] = a.includes('=') ? a.slice(2).split(/=(.*)/s) : [a.slice(2), undefined]
    if (v !== undefined) out[k] = v
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i]
    else out[k] = true
  }
  return out
}

/** `/sde export` 产物形态（既有 wiki 路径）。 */
function describeSdeExport(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const env = JSON.parse(raw)
  const bytes = Buffer.from(env.payload, 'base64')
  let inner
  try {
    inner = JSON.parse(bytes.toString('utf8'))
  } catch {
    inner = JSON.parse(gunzipSync(bytes).toString('utf8'))
  }
  const palette = inner.blockPalette ?? []
  return {
    file: rel(file),
    bytes: fs.statSync(file).size,
    sha256: sha256File(file),
    documentFormat: env.documentFormat ?? null,
    payloadEncoding: env.payloadEncoding ?? null,
    metaId: env.meta?.id ?? null,
    paletteEntries: palette.length,
    entriesWithThumbnail: palette.filter((e) => e && e.thumbnailPNG).length,
    innerKeys: Object.keys(inner),
    cellGridDims: inner.cellGrid ? [inner.cellGrid.length, inner.cellGrid[0]?.length ?? 0, inner.cellGrid[0]?.[0]?.length ?? 0] : null,
    innerSha256: sha256Text(JSON.stringify(inner)),
    scanBounds: env.meta?.scanBounds ?? null,
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0] ?? 'compare'
  const multiblockExports = path.resolve(args['multiblock-exports'] ?? path.join(REPO_ROOT, 'mod/gtnh/run/client/sde_multiblock_exports'))
  const structureExports = path.resolve(args['structure-exports'] ?? path.join(REPO_ROOT, 'mod/gtnh/run/client/structure_exports'))

  if (cmd === 'snapshot') {
    const out = path.resolve(args.out ?? path.join(REPO_ROOT, 'scripts/acceptance/.out/interop/snapshot-before.json'))
    const snap = {
      schema: 'lightning.acceptance.interop-snapshot/1',
      generatedAt: new Date().toISOString(),
      multiblockExports: { dir: rel(multiblockExports), entries: snapshotDir(multiblockExports, { base: multiblockExports }) },
      structureExports: { dir: rel(structureExports), entries: snapshotDir(structureExports, { base: structureExports }) },
    }
    writeJson(out, snap)
    console.log(`[interop] 快照：multiblock ${snap.multiblockExports.entries.length} 文件 / structure_exports ${snap.structureExports.entries.length} 文件 → ${out}`)
    process.exit(0)
  }

  if (cmd !== 'compare') {
    console.error(`未知子命令：${cmd}（可用：snapshot | compare）`)
    process.exit(2)
  }

  const runDir = path.resolve(args['run-dir'] ?? path.join(REPO_ROOT, 'scripts/acceptance/.out/acceptance-latest'))
  const beforePath = path.join(runDir, 'interop/snapshot-before.json')
  const outPath = path.join(runDir, 'interop/interop.json')
  const before = readJsonIfExists(beforePath)
  if (!before) {
    console.error(`缺少阶段前快照：${beforePath}`)
    process.exit(2)
  }
  const world = String(args.world ?? 'sde_pipeline_world')
  const logPath = args.log ? path.resolve(args.log) : null
  const logText = logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''

  const afterMultiblock = snapshotDir(multiblockExports, { base: multiblockExports })
  const afterStructure = snapshotDir(structureExports, { base: structureExports })
  const multiblockDiff = diffSnapshots(before.multiblockExports.entries, afterMultiblock)
  const structureDiff = diffSnapshots(before.structureExports.entries, afterStructure)

  // 本次运行产出/改写的 /sde export 产物：**新增 ∪ 内容变化 ∪ 被重写（mtime 变）**都算
  // （同一固定选区会写同一个文件名，且产物逐字节一致 → 只能靠 mtime 证明"本阶段确实写过"）
  const touched = [...new Set([...(structureDiff?.added ?? []), ...(structureDiff?.changed ?? []), ...(structureDiff?.touched ?? [])])]
  const produced = touched
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      try {
        return describeSdeExport(path.join(structureExports, f))
      } catch (e) {
        return { file: rel(path.join(structureExports, f)), error: e.message }
      }
    })

  // 基线（三段归档证据里的任意一份都算基线；同一固定选区下三次运行逐字节相同）
  const baselinePaths = args.baseline
    ? String(args.baseline).split(',').map((p) => path.resolve(p.trim()))
    : DEFAULT_BASELINES.map((p) => path.join(REPO_ROOT, p))
  const baselines = baselinePaths
    .filter((p) => fs.existsSync(p))
    .map((p) => ({ file: rel(p), bytes: fs.statSync(p).size, sha256: sha256File(p) }))

  const hashMatch = produced.length > 0 && baselines.length > 0 && produced.every((p) => baselines.some((b) => b.sha256 === p.sha256))

  // 可选：本阶段连跑两次的自比对（没有归档基线时用）
  const runsArg = args.runs ? String(args.runs).split(',').map((p) => path.resolve(p.trim())) : []
  const twoRun = runsArg.length === 2 && runsArg.every((p) => fs.existsSync(p))
    ? (() => {
        const [a, b] = runsArg.map((p) => ({ file: rel(p), sha256: sha256File(p), bytes: fs.statSync(p).size }))
        return { run1: a, run2: b, same: a.sha256 === b.sha256 }
      })()
    : null

  // 世界断言：日志里必须出现「正在加载首个存档 folder=<专用世界>」
  const worldMatch = /\[SDE\] automation: 正在加载首个存档 folder=(\S+)/.exec(logText) ?? /\[SDE\] automation: .*folder=(\S+)/.exec(logText)
  const worldObserved = worldMatch ? worldMatch[1] : null
  const teleport = /Teleported .* to ([-\d.]+), ([-\d.]+), ([-\d.]+)/.exec(logText)
  const exported = /SDE: .*导出/.exec(logText)
  const commandRejected = /需要 OP 权限|Unknown command|命令/.test(logText)

  const gates = [
    { name: '/sde export 产出了新文件', ok: produced.length > 0 },
    { name: '/sde export 产物哈希 = 基线（同选区确定性）', ok: hashMatch },
    { name: 'multiblock 产物目录本阶段逐字节未变（互不影响）', ok: multiblockDiff === null, detail: multiblockDiff ? JSON.stringify(multiblockDiff).slice(0, 300) : '无增删/无内容变化/无重写' },
    {
      name: '阶段前 multiblock 产物目录非空（否则"互不影响"无意义）',
      ok: before.multiblockExports.entries.length > 0,
      detail: `before=${before.multiblockExports.entries.length} 文件`,
    },
    { name: `客户端加载的是专用世界 ${world}`, ok: worldObserved === world },
    { name: '产物形态仍是既有 /sde export 形态（Envelope + gzip+base64）', ok: produced.length > 0 && produced.every((p) => p.documentFormat === 'Envelope' && p.payloadEncoding === 'gzip+base64') },
    { name: '未出现权限/命令被拒迹象', ok: !commandRejected },
  ]
  if (twoRun) gates.push({ name: '本阶段两次运行自比对逐字节一致', ok: twoRun.same })

  const failed = gates.filter((g) => !g.ok)
  const report = {
    schema: 'lightning.acceptance.interop/1',
    generatedAt: new Date().toISOString(),
    world,
    log: logPath ? rel(logPath) : null,
    multiblockExports: { dir: rel(multiblockExports), filesBefore: before.multiblockExports.entries.length, filesAfter: afterMultiblock.length, diff: multiblockDiff },
    structureExports: {
      dir: rel(structureExports),
      filesBefore: before.structureExports.entries.length,
      filesAfter: afterStructure.length,
      added: structureDiff?.added ?? [],
      changed: structureDiff?.changed ?? [],
      touched,
      removed: structureDiff?.removed ?? [],
      changed: structureDiff?.changed ?? [],
    },
    produced,
    baselines,
    hashMatch,
    twoRun,
    worldObserved,
    teleportObserved: teleport ? teleport[0] : null,
    exportChatLine: exported ? exported[0] : null,
    gates,
    ok: failed.length === 0,
  }
  ensureDir(path.dirname(outPath))
  writeJson(outPath, report)
  console.log(`[interop] /sde export 互不干扰：${report.ok ? '全绿' : '红'}`)
  for (const g of gates) console.log(`  ${g.ok ? 'OK ' : 'XX '} ${g.name}`)
  if (!report.ok) for (const p of produced) console.log(`     产物: ${JSON.stringify(p)}`)
  process.exit(report.ok ? 0 : 1)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) main()

