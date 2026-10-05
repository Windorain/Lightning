#!/usr/bin/env node
/**
 * 归档 T3.2 的体积曲线数据到 `docs/plan/volume-profile-result.md`。
 *
 * 设计：**模板由编排生成，实际数据随终验填入** ——
 *   · `--mode template`：写"判据说明 + 表格骨架 + 填数命令"，若文件已存在则除非 `--force` 否则不动
 *     （避免样例/分段运行把终验数据覆盖掉）；
 *   · `--mode data`：用真实 `volume-curve.json`（+ acceptance-report.json）生成完整归档文档。
 *
 * 用法：
 *   node scripts/acceptance/volume-doc.mjs --mode template [--out docs/plan/volume-profile-result.md] [--force]
 *   node scripts/acceptance/volume-doc.mjs --mode data --run-dir <runDir> [--out <doc>]
 * 退出码：0 成功；2 输入不可用。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { ensureDir, readJsonIfExists, rel, REPO_ROOT, writeText } from './lib/evidence.mjs'

const DEFAULT_OUT = path.join(REPO_ROOT, 'docs/plan/volume-profile-result.md')

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

function header(mode) {
  return [
    '# T3.2 体积增长曲线 —— 结果归档',
    '',
    '> **本文件的模板由编排生成**（`scripts/acceptance/volume-doc.mjs`），**实际数据随终验填入**。',
    '> 判据真源：`docs/contracts/format-multiblock-doc.md` §9.2/§9.3/§9.4（留白 #9 定稿）+ §10 对计划 §T3.2 建议式的修正。',
    `> 生成时间：${new Date().toISOString()}；模式：\`${mode}\``,
    '',
    '## 判据（机器判定，λ=1.35 / R²≥0.95 / b≤2048 B/组合 / 常数项下限 4096 B）',
    '',
    '| 记号 | 定义 |',
    '|---|---|',
    '| `N` | 文档声明的变体数（= ∏各通道域 × \\|tierSample\\| × 运行态数），即"组合数" |',
    '| `S` | 轴展维度和 = 总 Tier 域长度 + Σ(每通道域长度)（不含组合） |',
    '| `G` | 内层 body JSON 的 gzip 字节数（level 9） |',
    '| `V` | 组合展开体积 = `blockPalette`×1 + Σ(每变体完整 `cellGrid`) |',
    '| `κ` | `V / G`（展开比） |',
    '',
    '- **R1**：`κ` 随 `N` 同步增长（相邻点 `κ` 增长 ≥ 1/√λ）——在**真实编码器对照组**上判。',
    '- **R2**：`G ≈ a + b·N` 线性拟合，`R² ≥ 0.95`、`b ≤ 2048 B/组合`、常数项闸门；',
    '  正式判定落在**契约 k 序列**（T0.5 参考实现对 fixture 做通道域 ×1/×2/×4/×8 放大）——',
    '  真实对照序列 `N≤60` 时变量部分 `b·N_max < 4096 B`，按契约 §9.3 属"该点无判定意义"。',
    '- **R3**：`size(backbone)+size(rules)+size(blockPalette)` 的增长 < 2λ ×（`S` 的增长）——在真实序列上判。',
    '- **风险 4**：调色板并集体量占比（`blockPalette` 占内层字节比 ≥40% 标红、≥25% 标黄）+ 并集去重率。',
  ]
}

function templateBody(outPath) {
  return [
    '',
    '## 数据（**待终验填入**）',
    '',
    '> 终验跑一条命令即可填满本节：',
    '> ```powershell',
    '> npm run acceptance:multiblock',
    '> ```',
    '> 编排会调用本工具的 `--mode data`，把该次运行的 `volume/volume-curve.json`（机读真源）、',
    '> `volume/volume-curve.svg`（曲线图）、`volume/profile.md`（T0.1 分桶）与验收报告的判定一并写进本文件。',
    '',
    '| 序列 | 轴 | 判定 | N 范围 | R1 | R2 | R3 | G ≈ a + b·N | R² | B/组合（声明部分） |',
    '|---|---|---|---|---|---|---|---|---|---|',
    '| `encoder-values` | EBF coil 取值数 +1 ×3 档 | 【待填】 | | | | | | | |',
    '| `encoder-channels` | QFT 通道数 +1（含退化对照） | 【待填】 | | | | | | | |',
    '| 契约 k 序列 | fixture 通道域 ×1/×2/×4/×8 | 【待填】 | | — | — | — | | | — |',
    '',
    '**风险 4（调色板并集体量占比）**：【待填】',
    '',
    '**无组合展开的其它机器证据**（终验报告里带出）：聚合 `κ = ΣV/ΣG`、`frames[].ops/cellGrid` 零出现、',
    '契约校验器 `frames/*` 全绿、每组合边际 < 单变体完整网格。',
    '',
    '## 产物位置（终验）',
    '',
    '- 机读数据：`scripts/acceptance/.out/acceptance-<label>/volume/volume-curve.json`',
    '- 曲线图：`…/volume/volume-curve.svg`（左：`G vs N` + 拟合线；右：`κ vs N`，log10）',
    '- 人读表格：`…/volume/volume-curve.md`',
    '- T0.1 分桶：`…/volume/profile.md`（每台产物的字节桶占比）',
    '- 验收报告：`…/acceptance-report.json`（`volumeCurve` 段）',
    '',
    '## 已知边界（判据适用性，需知悉）',
    '',
    '1. **R2 的常数项闸门在真实产物上不可满足**：每文件 `materialPalette+textureBlobs` 池 ≈40 KB gzip',
    '   （T1.4 开放项 2：未按机剪枝），而契约 §9.4 的 4096 B 下限是按"信封头 300–400 B"设的。',
    '   故 R2 的正式判定落在契约 k 序列；真实序列上如实记录斜率/拟合度/边际与补充判据。',
    '2. **对照组是"域子集重编码"不是"多轮游戏内导出"**（调度者裁决）：与生产同一 Java 编码器',
    '   （`MultiblockFactorizeTool`），避免 2.5 min/轮 ×N 的游戏内空转与同路径重复。',
    '3. **`validate-multiblock-fixtures.mjs --volume` 只能跑 fixture**：对真实产物（含 `size` 通道）会抛',
    '   `装配越界`（`scaleDocument` 的合成下标不适用于真实骨架）。',
    '',
    `> 模板文件：\`${rel(outPath)}\``,
  ]
}

function dataBody(runDir, outPath) {
  const curve = readJsonIfExists(path.join(runDir, 'volume/volume-curve.json'))
  const report = readJsonIfExists(path.join(runDir, 'acceptance-report.json'))
  if (!curve) {
    console.error(`找不到 ${path.join(runDir, 'volume/volume-curve.json')}（先跑编排的 volume-curve 阶段）`)
    return null
  }
  const L = ['', '## 数据（本次运行）', '']
  L.push(`> 运行目录：\`${rel(runDir)}\`；判定：**${curve.verdict.status}**（${report ? `验收总判定 ${report.verdict.status}` : '无验收报告'}）`)
  L.push('')
  L.push('| 序列 | 轴 | 判定 | N 范围 | R1 | R2 | R3 | G ≈ a + b·N | R² | 声明部分 B/组合 |')
  L.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const s of curve.series) {
    const ns = s.points.map((p) => p.N)
    const fit = s.R2.fit ? `G ≈ ${s.R2.fit.a.toFixed(0)} + ${s.R2.fit.b.toFixed(2)}·N` : '—'
    const r2 = s.R2.fit ? s.R2.fit.r2.toFixed(4) : '—'
    const decl = s.R2.marginalDeclarationBytesPerVariant != null ? s.R2.marginalDeclarationBytesPerVariant.toFixed(1) : '—'
    L.push(
      `| \`${s.id}\` | ${s.axis} | **${s.status}** | ${Math.min(...ns)}–${Math.max(...ns)} | ${s.R1.status} | ${s.R2.status}${s.R2.branch ? `（${s.R2.branch}）` : ''} | ${s.R3.status} | ${fit} | ${r2} | ${decl} |`,
    )
  }
  for (const c of curve.contractKSequence ?? []) {
    L.push(`| 契约 k 序列 \`${c.file}\` | fixture 通道域 ×1/×2/×4/×8 | **${c.pass ? 'pass' : 'fail'}** | ${c.points.map((p) => p.N).join('/')} | — | ${c.pass ? 'pass' : 'fail'} | — | G ≈ ${c.fit ? `${c.fit.a.toFixed(0)} + ${c.fit.b.toFixed(2)}·N` : '—'} | ${c.fit ? c.fit.r2.toFixed(4) : '—'} | — |`)
  }
  L.push('')
  L.push('### 逐点数据（对照组）')
  L.push('')
  L.push('| 文档 | 类 | N | S | G(gzip 内层) | V(展开) | κ | B/组合 | 单变体完整网格 B |')
  L.push('|---|---|---:|---:|---:|---:|---:|---:|---:|')
  for (const s of curve.series) {
    for (const p of s.points) {
      const doc = (curve.documents ?? []).find((d) => d.file.endsWith(p.file))
      const perGrid = doc && doc.N > 0 ? (doc.gridBytes / doc.N).toFixed(1) : '—'
      L.push(`| ${p.file} | 对照 | ${p.N} | ${p.S} | ${p.G} | ${p.V} | ${p.kappa.toFixed(3)} | ${(p.G / p.N).toFixed(1)} | ${perGrid} |`)
    }
    for (const p of s.extended) {
      const doc = (curve.documents ?? []).find((d) => d.file.endsWith(p.file))
      const perGrid = doc && doc.N > 0 ? (doc.gridBytes / doc.N).toFixed(1) : '—'
      L.push(`| ${p.file} | 全量域 | ${p.N} | ${p.S} | ${p.G} | ${p.V} | ${p.kappa.toFixed(3)} | ${(p.G / p.N).toFixed(1)} | ${perGrid} |`)
    }
  }
  L.push('')
  L.push('### R1/R2/R3 逐条读数')
  L.push('')
  for (const s of curve.series) {
    L.push(`**${s.id}**（${s.status}）`)
    L.push('')
    for (const p of s.R1.pairs) {
      L.push(
        p.skipped
          ? `- R1 N ${p.fromN}→${p.toN}：跳过（${p.reason}）`
          : `- R1 N ${p.fromN}→${p.toN}：κ ×${p.kappaGrowth.toFixed(3)} ≥ ${p.limit.toFixed(3)} → ${p.ok ? '✔' : '✘'}；边际 ${p.marginalBytesPerVariant.toFixed(1)} B/组合（声明部分 ${p.marginalDeclarationBytesPerVariant.toFixed(1)} B/组合）`,
      )
    }
    if (s.R2.fit) L.push(`- R2：${s.R2.status}（${s.R2.branch}）G ≈ ${s.R2.fit.a.toFixed(0)} + ${s.R2.fit.b.toFixed(2)}·N，R²=${s.R2.fit.r2.toFixed(4)}；b·N_max=${s.R2.variablePart.toFixed(0)} B，闸门 ${s.R2.gateRequired.toFixed(0)} B（满足=${s.R2.gateSatisfied}）`)
    if (s.R2.reason) L.push(`- ${s.R2.reason}`)
    for (const p of s.R3.pairs) L.push(`- R3 N ${p.fromN}→${p.toN}：spart ${p.spartA}→${p.spartB} B（×${p.spartGrowth.toFixed(3)}）≤ ${p.limit.toFixed(3)} → ${p.ok ? '✔' : '✘'}`)
    L.push('')
  }
  L.push('### 风险 4：调色板并集体量占比')
  L.push('')
  L.push(`判定：**${curve.risk4.status}**（依据：${curve.risk4.basis}；阈值 warn ${curve.risk4.thresholds.warn} / red ${curve.risk4.thresholds.red}）`)
  L.push('')
  L.push('| 文件 | 调色板条目 | 未引用条目 | 并集字节 | 内层字节 | 占比 | 固定池占比 |')
  L.push('|---|---:|---:|---:|---:|---:|---:|')
  for (const r of curve.risk4.rows) {
    L.push(`| ${r.file} | ${r.paletteEntries} | ${r.paletteUnusedEntries} | ${r.paletteBytes} | ${r.innerCompact} | ${(r.paletteShare * 100).toFixed(1)}% | ${(r.poolShare * 100).toFixed(1)}% |`)
  }
  L.push('')
  if (curve.risk4.dedup) {
    L.push(
      `去重率证据（mod 捕获统计）：变体 ${curve.risk4.dedup.variants} → 并集条目 ${curve.risk4.dedup.paletteEntries}（每条目服务 ${curve.risk4.dedup.variantsPerPaletteEntry.toFixed(1)} 个变体）；` +
        `抑制重复捕获 ${curve.risk4.dedup.duplicateCapturesSuppressed} 次 → ${curve.risk4.dedup.ok ? '✔ 真去重' : '✘'}`,
    )
    L.push('')
  }
  L.push('### 判据说明（机器生成）')
  L.push('')
  for (const n of curve.criterionNotes ?? []) L.push(`- ${n}`)
  L.push('')
  L.push('### 产物位置')
  L.push('')
  L.push(`- 机读数据：\`${rel(path.join(runDir, 'volume/volume-curve.json'))}\``)
  L.push(`- 曲线图：\`${rel(path.join(runDir, 'volume/volume-curve.svg'))}\``)
  L.push(`- 人读表格：\`${rel(path.join(runDir, 'volume/volume-curve.md'))}\``)
  L.push(`- T0.1 分桶：\`${rel(path.join(runDir, 'volume/profile.md'))}\``)
  L.push(`- 验收报告：\`${rel(path.join(runDir, 'acceptance-report.json'))}\`（\`volumeCurve\` 段）`)
  L.push('')
  if ((report?.openItems ?? []).length > 0) {
    L.push('### 本次运行的开放项')
    L.push('')
    for (const o of report.openItems) L.push(`- **${o.id}**（${o.severity}）：${o.text}`)
    L.push('')
  }
  return L
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const mode = String(args.mode ?? 'template')
  const outPath = path.resolve(args.out ?? DEFAULT_OUT)
  if (args.force !== true && mode === 'template' && fs.existsSync(outPath)) {
    console.log(`[volume-doc] 已存在，模板模式不覆盖：${outPath}（用 --force 覆盖）`)
    return
  }
  ensureDir(path.dirname(outPath))
  let body
  if (mode === 'data') {
    const runDir = path.resolve(args['run-dir'] ?? path.join(REPO_ROOT, 'scripts/acceptance/.out/acceptance-latest'))
    if (!fs.existsSync(runDir)) {
      console.error(`运行目录不存在：${runDir}`)
      process.exitCode = 2
      return
    }
    body = dataBody(runDir, outPath)
    if (!body) {
      process.exitCode = 2
      return
    }
  } else {
    body = templateBody(outPath)
  }
  writeText(outPath, [...header(mode), ...body, ''].join('\n'))
  console.log(`[volume-doc] 已写出（${mode}）：${outPath}`)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) main()
