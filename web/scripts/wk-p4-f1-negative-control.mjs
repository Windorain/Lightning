#!/usr/bin/env node
/**
 * **P4 F1/F4 负对照与退役证据采集**（Gitea #255；#249 §7 §15）。
 *
 * ## 为什么是一个脚本而不是只写进 vitest
 *
 * `npm test` 里的断言会在别人改测试时一起被改掉；而本脚本是**只读、可独立复跑**
 * 的证据产物，输出即为可上传 Gitea 的文本。它回答两个 #255 明文要求：
 *
 *  1. **F1**：「至少一条离散通道轨道经通用架构运行；**无专用多方块播放调度器**」
 *  2. **F4**：「依赖图**无调用方手动 refresh**」
 *
 * ## 判据的二分（与 `boundary-rules.mjs` 同一口径）
 *
 * 把"新层必须 0"与"旧层仍然存在"混在一个红/绿里会产生两种错误：
 *  - **假红**：旧机制的既有事实（`render/`、旧 `runtime/` 里的播放调度）被判成本批不合格；
 *  - **假绿**：因为遗留太多而干脆不查新层。
 *
 * 故本脚本把事实分成两组：`NEW_LAYER`（必须 0）与 `LEGACY_OWNED`（计数 + 归属）。
 * 后者是给 P5/P6 的删除点清单的**独立复核**（与 `retirementRegistry.test.ts` 互为对照）。
 *
 * ## 负对照
 *
 * 「负对照必须证明确实破坏了目标保证，不能只令测试主动抛错」（#249 §14）。
 * 故每个判据都先喂入**合成违规事实**，要求它判红；判绿即视为判据失效（脚本 FAIL）。
 *
 * 用法：`node scripts/wk-p4-f1-negative-control.mjs`
 * 退出码：0 = 全部符合预期（含负对照被判红）；1 = 有未登记事实或负对照失效。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC_ROOT = path.join(WEB_ROOT, 'src')

const NEW_LAYER_FILES = [
  'domain/identity.ts',
  'domain/errors.ts',
  'domain/scene.ts',
  'domain/document.ts',
  'domain/editing.ts',
  'domain/animation.ts',
  'domain/materials.ts',
  'domain/multiblock.ts',
  'application/state.ts',
  'application/commands.ts',
  'application/queries.ts',
  'application/evaluation.ts',
  'runtime/execution.ts',
  'runtime/scheduling.ts',
  'runtime/effects.ts',
  'runtime/evaluation.ts',
]

/** 旧机制所在（归 P5/P6 删除；本批只计数与归属，不判 FAIL）。 */
const LEGACY_OWNED = [
  { file: 'runtime/drwMeshPipeline.ts', owner: 'P5', mechanism: 'setTimeout 自续的世界帧播放调度' },
  { file: 'runtime/renderEngine.ts', owner: 'P5', mechanism: 'renderEngine tick + 材质库 tick 前推' },
  { file: 'runtime/main.ts', owner: 'P5', mechanism: 'currentFrameIndex / framesPlaybackIsPlaying（旧权威 Ref）' },
  { file: 'render/materials/simpleMaterialLibrary.ts', owner: 'P5', mechanism: 'dtMs 累积（accMs）前推纹理帧偏移' },
  { file: 'render/interaction/blockIconCache.ts', owner: 'P5', mechanism: '固定 dt 前推（library.tick(16)）' },
  { file: 'shared/viewport/useMultiblockChannels.ts', owner: 'P6', mechanism: '每视口通道暂存 + revision 手动重建链' },
  { file: 'shared/viewport/WorldFramePlayerControls.vue', owner: 'P6', mechanism: '旧帧播放控件' },
  { file: 'shared/viewport/WorldFrameScrubber.vue', owner: 'P6', mechanism: '旧帧定位控件' },
]

/** 一行代码是否命中某类指纹（**排除注释行** —— 退役说明里提到旧名是有价值的记录）。 */
function codeLines(text) {
  return text
    .split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => !/^\s*(\*|\/\/|\/\*)/.test(line))
}

/** 播放调度指纹（新层必须 0）。 */
const SCHEDULER_PATTERNS = [
  { id: 'raf', re: /\brequestAnimationFrame\s*\(/, why: 'requestAnimationFrame：新层不得自持绘制/播放循环' },
  { id: 'interval', re: /\bsetInterval\s*\(/, why: 'setInterval：新层不得自持定时推进' },
  { id: 'timeout', re: /\bsetTimeout\s*\(/, why: 'setTimeout：新层不得自持定时推进' },
  { id: 'accumulate', re: /\b\w*(elapsed|accMs|accum)\w*\s*\+=/, why: '时间累积：新层不得累积 tick（应直接按显式时间采样）' },
  { id: 'playback-flag', re: /\bframesPlaybackIsPlaying\b/, why: '旧专用播放标志：新层不得引用' },
  { id: 'mf-special-case', re: /if\s*\([^)]*multiblock[^)]*\)\s*\{[^}]*\b(play|tick|schedule)/i, why: '「若 multiblock 则另一套播放」：新层不得存在' },
]

/** 手动刷新入口指纹（新层必须 0 —— 它们必须是**导出名**，故只在 export 行上判）。 */
const REFRESH_PATTERNS = [
  { id: 'refresh', re: /export\s+(?:async\s+)?(?:function|const|class)\s+(refresh|refreshAll|refreshViewport|markDirty|invalidate|invalidateAll|bumpStructEpoch|bumpEpoch)\b/, why: '不得导出调用方手动刷新入口' },
]

function scan(files, patterns, label) {
  const hits = []
  for (const rel of files) {
    const abs = path.join(SRC_ROOT, rel)
    if (!fs.existsSync(abs)) continue
    const text = fs.readFileSync(abs, 'utf8')
    for (const { line, no } of codeLines(text)) {
      for (const p of patterns) {
        if (p.re.test(line)) hits.push({ file: rel, line: no, pattern: p.id, why: p.why, text: line.trim().slice(0, 140), label })
      }
    }
  }
  return hits
}

/** 合成违规事实（负对照）：证明判据不是恒绿。 */
function negativeControls() {
  const out = []
  for (const p of SCHEDULER_PATTERNS) {
    const sample =
      p.id === 'raf'
        ? 'const h = requestAnimationFrame(step)'
        : p.id === 'interval'
          ? 'setInterval(() => advance(), 16)'
          : p.id === 'timeout'
            ? 'setTimeout(step, 50)'
            : p.id === 'accumulate'
              ? 'elapsed += delta'
              : p.id === 'playback-flag'
                ? 'if (!framesPlaybackIsPlaying.value) return'
                : 'if (isMultiblock) { play() }'
    out.push({ pattern: p.id, sample, caught: p.re.test(sample) })
  }
  for (const p of REFRESH_PATTERNS) {
    const sample = 'export function refreshViewport() {}'
    out.push({ pattern: p.id, sample, caught: p.re.test(sample) })
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 运行
// ─────────────────────────────────────────────────────────────────────────────

const sha = process.env.P4_SHA ?? '(unset)'
const lines = []
const say = (s = '') => lines.push(s)

say('# P4 F1/F4 证据采集（#255）')
say(`# 树: ${WEB_ROOT}`)
say(`# 提交: ${sha}`)
say(`# 时间: ${new Date().toISOString()}`)
say()

const schedulerHits = scan(NEW_LAYER_FILES, SCHEDULER_PATTERNS, 'new-layer')
const refreshHits = scan(NEW_LAYER_FILES, REFRESH_PATTERNS, 'new-layer')

say('## F1：新层不得存在播放调度 / 时间累积指纹')
say(`受检文件: ${NEW_LAYER_FILES.length}`)
if (schedulerHits.length === 0) {
  say('✅ 新层 0 命中（无 requestAnimationFrame / setInterval / setTimeout / 时间累积 / 专用播放标志 / multiblock 专用分支）')
} else {
  say(`❌ 新层命中 ${schedulerHits.length} 处：`)
  for (const h of schedulerHits) say(`   ${h.file}:${h.line} [${h.pattern}] ${h.text}  ← ${h.why}`)
}
say()

say('## F1/F4：新层不得导出调用方手动刷新入口')
if (refreshHits.length === 0) {
  say('✅ 新层 0 命中（无 refresh / invalidate / markDirty / bumpStructEpoch 导出）')
} else {
  say(`❌ 命中 ${refreshHits.length} 处：`)
  for (const h of refreshHits) say(`   ${h.file}:${h.line} [${h.pattern}] ${h.text}  ← ${h.why}`)
}
say()

say('## 负对照：判据必须能抓到违规（不是恒绿）')
let ncFail = 0
for (const nc of negativeControls()) {
  if (nc.caught) {
    say(`✅ [${nc.pattern}] 抓到合成违规: ${nc.sample}`)
  } else {
    ncFail++
    say(`❌ [${nc.pattern}] **未抓到**合成违规（判据失效）: ${nc.sample}`)
  }
}
say()

say('## 遗留债务（归 P5/P6；本批只计数与归属，不判 FAIL）')
say('| 文件 | 归属 | 旧机制 | 现况 |')
say('|---|---|---|---|')
let legacyPresent = 0
for (const l of LEGACY_OWNED) {
  const abs = path.join(SRC_ROOT, l.file)
  const present = fs.existsSync(abs)
  if (present) legacyPresent++
  say(`| ${l.file} | ${l.owner} | ${l.mechanism} | ${present ? '存在（待该区批次删除）' : '**已不存在**'} |`)
}
say()
say(`遗留文件存在数: ${legacyPresent} / ${LEGACY_OWNED.length}`)
say('（对照登记见 web/src/application/__tests__/retirementRegistry.test.ts；两者互为镜像）')
say()

const ok = schedulerHits.length === 0 && refreshHits.length === 0 && ncFail === 0
say(`## 判定：${ok ? 'PASS' : 'FAIL'}`)
say()

const text = lines.join('\n')
process.stdout.write(text)

// 证据落盘位置：**工作树之外**（仓库树里零未跟踪文件 —— AGENTS.md 铁律 1）。
// 默认写到工作区根的 `temp/`；可用 `P4_EVIDENCE_DIR` 覆盖。
const outDir = process.env.P4_EVIDENCE_DIR ?? path.resolve(WEB_ROOT, '..', '..', '..', 'temp', 'wk-p4', 'evidence')
try {
  const outPath = path.join(outDir, `${sha}-p4-f1-f4-negative-control.txt`)
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(outPath, text, 'utf8')
  process.stderr.write(`\n[evidence] 已写 ${outPath}\n`)
} catch {
  // 证据落盘失败不影响判定（stdout 已给出全文）
}
process.exit(ok ? 0 : 1)
