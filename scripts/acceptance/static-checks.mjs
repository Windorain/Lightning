#!/usr/bin/env node
/**
 * 静态机器判据（§6「web 渲染」与「工程纪律」的可机器判定部分）。
 *
 * 判什么：
 *  1. **装配路径零游戏逻辑**（计划 §T2.2 硬约束 / §6「装配路径零游戏逻辑」）：
 *     `web/src/context/multiblock/**` 与多方块 parser 不得
 *       · import 任何 GT / StructureLib / GT5U 知识；
 *       · 出现任何**游戏内通道 id 字面量**（`'coil'`/`'glass'`/`'manipulator'`…）—— 那是"按通道 id 分支"的地基；
 *       · 使用 `eval` / `new Function` 等动态求值；
 *       · 出现按等级推导尺寸的算术（`Math.pow` / `**`）—— 尺寸只允许来自声明的骨架阶。
 *  2. **未在 web 端重放 GT/StructureLib 逻辑**（§6「工程纪律」）：全 `web/src`（排除测试与 fixture）
 *     不得 import GT 运行时、不得硬编码游戏通道 id 常量表、不得有等级→结构推导。
 *
 * 通道 id 全集来源：T1.2 枚举事实层 `mod/gtnh/run/client/multiblock_scan/<run>/machines.json` 的
 * `channels[].id` 去重（实测 23 个）+ T0.4 报告记录的舱口布局通道 `gt_hatch`。
 *
 * 用法：node scripts/acceptance/static-checks.mjs --out <run>/static-checks.json
 * 退出码：0 = 全绿；1 = 有发现（**报告仍落盘**，判定交给 acceptance-report 的清单项）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

import { listFiles, rel, REPO_ROOT, writeJson } from './lib/evidence.mjs'

const ASSEMBLY_DIRS = ['web/src/context/multiblock', 'web/src/context/parsers/multiblockParser.ts', 'web/src/context/parsers/multiblockDocument.ts']

/** 游戏内通道 id 全集（证据：T1.2 machines.json 的 channels[].id + T0.4 的 gt_hatch）。 */
const GT_CHANNEL_IDS = [
  'antenna',
  'capacitor',
  'casing',
  'cell',
  'chassis',
  'coil',
  'component_casing',
  'field',
  'glass',
  'gt_hatch',
  'height',
  'item_pipe',
  'length',
  'machine_casing',
  'manipulator',
  'pipe',
  'piston_block',
  'shielding',
  'solenoid',
  'spacetime_compression',
  'stabilisation',
  'super_chest',
  'time_dilation',
  'unit_casing',
]

const GT_IMPORT_RE = /(?:from|require\()\s*['"][^'"]*(gregtech|structurelib|gt5u|BlockRenderer|GTStructureChannels|metaTileEntity)[^'"]*['"]/i
const DYNAMIC_EVAL_RE = /\b(eval\s*\(|new\s+Function\s*\(|Function\s*\(\s*['"])/
/** 等级→尺寸推导的算术（只认与 tier 直接相关的形态；普通进制换算如 Math.pow(10, exp) 不算）。 */
const GAME_FORMULA_RE = /Math\.pow\(\s*2\s*,|\*\*\s*(?:tier|totalTier|tierIndex)|\b(?:tier|totalTier|tierIndex)\s*\*\*/
/**
 * 通道 id 字面量的**违规上下文**：出现在分支/比较/查表语境里才算"按游戏通道 id 分支"。
 * （`readInlinePx(el, 'height')` 这类 CSS 属性、`if ('field' in c)` 这类类型收窄都不算。）
 */
const CHANNEL_ID_CONTEXT_RE = /\bcase\b|===|!==|(?<![=!])==(?!=)|!=|includes\(|indexOf\(|switch\b|channel/i
const SIMPLE_IMPORT_RE = /^\s*import\b.*?\bfrom\s*['"]([^'"]+)['"]/gm

function isComment(line) {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

function scanFile(file) {
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  const out = { gtImports: [], channelIds: [], dynamicEval: [], gameFormulas: [] }
  lines.forEach((line, i) => {
    const lineNo = i + 1
    if (GT_IMPORT_RE.test(line) && /\bimport\b|require\(/.test(line)) out.gtImports.push({ file: rel(file), line: lineNo, text: line.trim() })
    if (DYNAMIC_EVAL_RE.test(line) && !isComment(line)) out.dynamicEval.push({ file: rel(file), line: lineNo, text: line.trim() })
    if (GAME_FORMULA_RE.test(line) && !isComment(line)) out.gameFormulas.push({ file: rel(file), line: lineNo, text: line.trim() })
    if (isComment(line)) return
    if (!CHANNEL_ID_CONTEXT_RE.test(line)) return
    for (const id of GT_CHANNEL_IDS) {
      const re = new RegExp(`['"\`]${id}['"\`]`)
      if (re.test(line)) {
        out.channelIds.push({ file: rel(file), line: lineNo, text: line.trim(), channelId: id })
      }
    }
  })
  return out
}

function scanFiles(files) {
  const acc = { gtImports: [], channelIds: [], dynamicEval: [], gameFormulas: [] }
  for (const f of files) {
    const r = scanFile(f)
    acc.gtImports.push(...r.gtImports)
    acc.channelIds.push(...r.channelIds)
    acc.dynamicEval.push(...r.dynamicEval)
    acc.gameFormulas.push(...r.gameFormulas)
  }
  return acc
}

function main() {
  const args = {}
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]
    if (a.startsWith('--')) {
      const [k, v] = a.includes('=') ? a.slice(2).split(/=(.*)/s) : [a.slice(2), undefined]
      args[k] = v !== undefined ? v : process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true
    }
  }
  const outPath = path.resolve(args.out ?? path.join(REPO_ROOT, 'scripts/acceptance/.out/static-checks.json'))

  // ---- 1. 装配路径 ----
  const assemblyFiles = ASSEMBLY_DIRS.flatMap((d) => {
    const abs = path.join(REPO_ROOT, d)
    if (!fs.existsSync(abs)) return []
    if (fs.statSync(abs).isFile()) return [abs]
    return listFiles(abs, { filter: (f) => f.endsWith('.ts') })
  }).sort()
  const a = scanFiles(assemblyFiles)
  const assemblyPath = {
    scannedFiles: assemblyFiles.map((f) => rel(f)),
    findings: {
      noGtImports: a.gtImports,
      noChannelIdBranching: a.channelIds,
      noDynamicEval: a.dynamicEval,
      noGameFormulas: a.gameFormulas,
      total: a.gtImports.length + a.channelIds.length + a.dynamicEval.length + a.gameFormulas.length,
    },
  }

  // ---- 2. 全 web/src 的 GT 逻辑重放 ----
  const webSrc = path.join(REPO_ROOT, 'web/src')
  const all = listFiles(webSrc, {
    filter: (f) =>
      (f.endsWith('.ts') || f.endsWith('.vue')) &&
      !f.includes(`${path.sep}__tests__${path.sep}`) &&
      !f.includes(`${path.sep}fixtures${path.sep}`) &&
      !/\.(test|spec)\./.test(f),
  })
  const b = scanFiles(all)
  const gtReplay = {
    scannedFiles: all.map((f) => rel(f)),
    findings: {
      noGtImports: b.gtImports,
      noChannelIdConstants: b.channelIds,
      noGameFormulas: b.gameFormulas,
      total: b.gtImports.length + b.channelIds.length + b.gameFormulas.length,
    },
  }

  const report = {
    schema: 'lightning.acceptance.static-checks/1',
    generatedAt: new Date().toISOString(),
    gtChannelIdsSource: 'T1.2 machines.json channels[].id 去重 + T0.4 gt_hatch（23+1 个）',
    assemblyPath,
    gtReplay,
    verdict: assemblyPath.findings.total === 0 && gtReplay.findings.total === 0 ? 'pass' : 'fail',
  }
  writeJson(outPath, report)
  console.log(`[static] 装配路径：扫描 ${assemblyFiles.length} 文件，发现 ${assemblyPath.findings.total} 处`)
  console.log(`[static] 全 web/src：扫描 ${all.length} 文件，发现 ${gtReplay.findings.total} 处`)
  console.log(`[static] 报告：${outPath}`)
  process.exit(report.verdict === 'pass' ? 0 : 1)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) main()

