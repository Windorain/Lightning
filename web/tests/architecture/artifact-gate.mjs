/**
 * **真实产物的声明式门控**（比照 `web/e2e/real-artifact-gate.ts` 的形态）。
 *
 * ## 为什么需要它
 *
 * 旧形态里，产物缺失的判据用 `if (!hasArtifacts/!hasBundle) return` 静默通过；
 * 本树 `web/` 在没有 `dist*` 的时候，这些判据就是**空洞真**（形似判据、实际零断言）。
 * 「空洞真」比「无判据」更危险：它在测试报告里**以通过的形式出现**。
 * 本模块把那种形态换掉 —— 与 e2e 的产物门控**同一形态**：
 *
 * | 情形 | 处置 |
 * |---|---|
 * | **产物就绪** | 该组判据**真跑**（`test.runIf(ready)`，没有静默跳过） |
 * | **产物缺失** | 该组判据**显式跳过**（在报告里显示为 skipped，**不是 passed**）+ 启动横幅列出「缺什么、怎么再生」+ 落 `test-results/a34-artifact-gate.json` |
 *
 * 与 e2e 侧的差别只有一处：Playwright 有 `testIgnore` 可在 collection 期排除 spec，
 * 而 vitest 的等价物是 `test.runIf/skipIf`（同样在 collection 期决定，同样在报告里可见）。
 *
 * ## 一处必须写清的纪律：**门控本身也要被判据把守**
 *
 * 门控设施自己可能腐烂（声明了不存在的产物组、漏写再生命令、把"未就绪"写成"就绪"）。
 * 故 `artifact-host.test.ts` 里有一组**永远运行**的元判据：
 * ① 声明的每个文件路径都有 `requires` 与 `regenerate`；
 * ② `ready` 与 `missing` 自洽（ready ⇔ missing 为空）；
 * ③ 落盘的 JSON 与内存结论逐项一致；
 * ④ 横幅**点名**每一份缺失产物；
 * ⑤ 负对照：注入一个缺文件的合成组 ⇒ 门控判"未就绪"并列出缺什么
 *    （证明它不是恒"就绪"，也不是恒"未就绪"）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** `web/`（本文件在 `web/tests/architecture/`）。 */
export const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 产物根目录（**可选覆盖**）。
 *
 * 保留 `LIGHTNING_P09_ARTIFACT_ROOT` 环境变量：它让"在别处构建、把根指过来"
 * 成为可能。
 */
export const ARTIFACT_ROOT = process.env.LIGHTNING_P09_ARTIFACT_ROOT ?? path.join(WEB_ROOT, 'dist-wiki-workbench')

/** 一组需要真实产物的判据。 */
/**
 * @typedef {object} ArtifactGroup
 * @property {string} id 稳定标识（判据按它取用）
 * @property {string} root 产物根（绝对路径）
 * @property {readonly string[]} files 期望存在的文件（相对 `root`，正斜杠）
 * @property {string} requires 人读的产物要求
 * @property {string} regenerate 再生命令（产物缺失时的处置指引）
 */

/** @type {readonly ArtifactGroup[]} */
export const ARTIFACT_GROUPS = Object.freeze([
  Object.freeze({
    id: 'wiki-workbench-dist',
    root: ARTIFACT_ROOT,
    files: Object.freeze(['index.html', 'bundled/StructureWorkbench.bundle.js', 'bundled/StructureWorkbench.css']),
    requires: 'wiki-workbench 真实构建产物（`index.html` + `bundled/` 下的 JS/CSS 与字体）',
    regenerate: 'cd web && npm run build:wiki-workbench  # 产物落 web/dist-wiki-workbench',
  }),
  Object.freeze({
    id: 'wiki-workbench-bundle',
    root: ARTIFACT_ROOT,
    files: Object.freeze(['bundled/StructureWorkbench.bundle.js']),
    requires: 'wiki-workbench 的 JS bundle（ZIP 补丁的**字节级**判据对象）',
    regenerate: 'cd web && npm run build:wiki-workbench  # 产物落 web/dist-wiki-workbench',
  }),
])

/** 一组的门控结论。 */
/**
 * @typedef {object} GroupVerdict
 * @property {string} id
 * @property {boolean} ready
 * @property {readonly string[]} missing 缺失文件（相对 root）
 * @property {readonly string[]} present 已存在文件（相对 root）
 * @property {string} requires
 * @property {string} regenerate
 * @property {string} root
 */

/** 评估一组（纯读文件系统；缺根即整组缺）。 */
function evaluateGroup(group) {
  const present = []
  const missing = []
  for (const rel of group.files) {
    if (fs.existsSync(path.join(group.root, rel))) present.push(rel)
    else missing.push(rel)
  }
  return Object.freeze({
    id: group.id,
    ready: missing.length === 0,
    missing: Object.freeze(missing),
    present: Object.freeze(present),
    requires: group.requires,
    regenerate: group.regenerate,
    root: group.root,
  })
}

/**
 * 评估全部门控组。
 *
 * @param {readonly ArtifactGroup[]} groups
 * @returns {{readonly groups: readonly GroupVerdict[]; readonly readyIds: readonly string[]; readonly missingIds: readonly string[]; readonly allReady: boolean; readonly anyReady: boolean}}
 */
export function evaluateArtifactGate(groups = ARTIFACT_GROUPS) {
  const verdicts = groups.map(evaluateGroup)
  const readyIds = verdicts.filter((v) => v.ready).map((v) => v.id)
  const missingIds = verdicts.filter((v) => !v.ready).map((v) => v.id)
  return Object.freeze({
    groups: Object.freeze(verdicts),
    readyIds: Object.freeze(readyIds),
    missingIds: Object.freeze(missingIds),
    allReady: missingIds.length === 0,
    anyReady: readyIds.length > 0,
  })
}

/** 按 id 取一组的结论（未登记 ⇒ 抛错，不返回 `undefined` 让调用方悄悄跳过）。 */
export function verdictOf(gate, id) {
  const v = gate.groups.find((g) => g.id === id)
  if (v === undefined) throw new Error(`产物门控：未登记的组 ${id}（拼错 id 会让判据静默不跑）`)
  return v
}

/**
 * 启动横幅（人读；**在 collection 之前**打印，避免"悄悄少跑了 5 条判据"）。
 *
 * @param {ReturnType<typeof evaluateArtifactGate>} gate
 */
export function artifactGateBanner(gate) {
  const lines = ['', '─'.repeat(78)]
  if (gate.allReady) {
    lines.push('[产物门控] 声明的产物组 **全部就绪** ⇒ 所有产物判据真跑（无跳过）。')
  } else {
    lines.push(`[产物门控] ${gate.missingIds.length}/${gate.groups.length} 组产物未就绪 ⇒ 对应判据**显式跳过**（报告中显示为 skipped，不是 passed）：`)
    for (const g of gate.groups) {
      if (g.ready) continue
      lines.push(`  · 组 ${g.id.padEnd(24)} 缺 ${g.missing.length} 个文件：${g.missing.join(', ')}`)
      lines.push(`    需要：${g.requires}`)
      lines.push(`    再生：${g.regenerate}`)
      lines.push(`    根目录：${g.root}`)
    }
    lines.push('  说明：这不是"通过"——本设施把"缺产物"如实登记为跳过 + 机器可读记录')
    lines.push('        （web/test-results/a34-artifact-gate.json），无任何静默 return。')
  }
  lines.push('─'.repeat(78), '')
  return lines.join('\n')
}

/**
 * 落一份机器可读的门控记录（证据纪律：结论要能落盘并可机械对账）。
 *
 * @param {ReturnType<typeof evaluateArtifactGate>} gate
 * @param {string} webRoot
 * @returns {string} 落盘路径
 */
export function writeArtifactGateRecord(gate, webRoot = WEB_ROOT) {
  const dir = path.join(webRoot, 'test-results')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'a34-artifact-gate.json')
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        note: '真实产物门控（缺产物 ⇒ 显式跳过 + 本记录；产物就绪 ⇒ 判据真跑）',
        declared: ARTIFACT_GROUPS.map((g) => ({ id: g.id, files: g.files, requires: g.requires, regenerate: g.regenerate })),
        groups: gate.groups,
        readyIds: gate.readyIds,
        missingIds: gate.missingIds,
        checkedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  return file
}
