/**
 * 内容边界闸门（A32）—— **自包含**规则与扫描器。
 *
 * ## 为什么单独一个文件，而不是加进 `boundary-rules.mjs`
 *
 * `boundary-rules.mjs` 是**共享瓶颈文件**（"边界扫描清单由各负责面按阶段拥有"）。
 * 本闸门的约束是"共享瓶颈文件不碰；确需改动在汇报中提出"。
 *
 * 于是本条规则采取**只增不改**的形态：
 *  - 规则、白名单、扫描器都在本文件（新增文件，由本闸门所有）；
 *  - 不修改 `boundary-rules.mjs` 的规则集，也不修改 `scan-boundaries.mjs` 入口；
 *  - 由 `vitest.architecture.config.ts` 的既有 include（`tests/architecture/**\/*.test.ts`）
 *    自动纳入 `npm run test:arch`，因此**不需要**改动任何共享配置。
 *
 * 这样"新层目录成为闸门执行面后 0 finding"这条要求由既有导入规则满足，
 * 而本闸门新增的"外部内容只能经受控边界进 DOM"由本文件满足 —— 两者并行，
 * 互不改写，也就不会让两个负责面抢同一个文件的编辑权。
 *
 * ## 这条规则判什么
 *
 * `v-html` / `innerHTML=` / `outerHTML=` / `insertAdjacentHTML(` 是**唯一**能静态
 * 判定的"外部内容直通 DOM"指纹。本闸门把 6 条直通路径收编到
 * `editors/ContentText.vue` 后，全仓应只剩 `editors/TrustedIcon.vue` 一处 ——
 * 它的输入是品牌类型 `TrustedIconTemplate`（只能由 `domain/trustedIcon.ts`
 * 的可信构造口产出），不是外部文本。
 *
 * 白名单是**精确文件**（不是目录级）：新增一条必须在 `CONTENT_MARKUP_ALLOWLIST`
 * 登记理由，否则判红。这正是「不允许组件各自选路径」的静态执行面。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 允许出现标记注入的**唯一**位置白名单（`web/` 相对路径）。 */
export const CONTENT_MARKUP_ALLOWLIST = [
  {
    file: 'src/editors/TrustedIcon.vue',
    because:
      '可信编译期图标（品牌类型 TrustedIconTemplate 的唯一消费者）；内联 SVG 必须经标记注入才能渲染',
  },
]

/** 匹配 `v-html` 绑定 / 命令式标记注入。 */
export const MARKUP_INJECTION_RE = /\bv-html\b|\.\s*innerHTML\s*=|\.\s*outerHTML\s*=|insertAdjacentHTML\s*\(/

/**
 * 剥掉注释，让扫描只看**可执行/可渲染的代码**。
 *
 * 必须跨行处理三类注释：
 *  - `/* … *​/`（块注释，本项目文档块大量使用）；
 *  - `// …`（行注释；用 `(^|[^:])` 避免误伤 `https://`）；
 *  - `<!-- … -->`（`.vue` 模板注释）。
 *
 * 为什么不逐行 `trim().startsWith('*')`：那会漏掉模板里的多行 HTML 注释
 * （`<!--` 与 `-->` 各占一行、内容行不以 `*` 开头），既产生假红，
 * 又让"在注释里保留交接说明"这条正当做法失效 —— 而退役纪律**要求**
 * 说明旧机制叫什么。替换字符保留换行，因此报告行号仍对得上真实文件。
 */
export function stripCommentsForScan(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

/** 收集 `src/` 下的生产源文件（相对 `src/`，正斜杠）—— 排除测试与声明文件。 */
export function collectProductionSourceFiles(srcRoot) {
  const out = []
  const walk = (dir, rel) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name === 'node_modules') continue
        walk(path.join(dir, e.name), childRel)
        continue
      }
      if (!/\.(ts|tsx|mts|vue)$/.test(e.name)) continue
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name)) continue
      if (/\.d\.ts$/.test(e.name)) continue
      out.push(childRel)
    }
  }
  walk(srcRoot, '')
  return out.sort()
}

/** 规则的稳定标识（与 `gate/*` 命名同族，便于报告聚合）。 */
export const CONTENT_BOUNDARY_RULE_ID = 'gate/content-boundary'

/**
 * 扫描一个 `src/` 根，返回 finding 清单。
 *
 * 纯函数式：只读文件系统，不改任何东西；同样的树给同样的结果（稳定排序）。
 */
export function scanContentBoundary(srcRoot) {
  const findings = []
  for (const rel of collectProductionSourceFiles(srcRoot)) {
    if (CONTENT_MARKUP_ALLOWLIST.some((a) => a.file === `src/${rel}`)) continue
    const raw = fs.readFileSync(path.join(srcRoot, rel), 'utf8')
    const lines = stripCommentsForScan(raw).split('\n')
    lines.forEach((line, i) => {
      if (!MARKUP_INJECTION_RE.test(line)) return
      findings.push({
        rule: CONTENT_BOUNDARY_RULE_ID,
        file: `src/${rel}`,
        line: i + 1,
        column: 1,
        specifier: 'v-html/innerHTML',
        syntax: line.trim().slice(0, 160),
        detail:
          '外部内容必须以受控呈现边界（editors/ContentText）+ 允许列表（domain/textContent）呈现；'
          + '若确需保留标记注入，在 content-boundary-gate.mjs 的 CONTENT_MARKUP_ALLOWLIST 登记理由',
      })
    })
  }
  return findings
}

/** 报告形态的摘要（供测试与证据对账）。 */
export function summarizeContentBoundary(srcRoot) {
  const findings = scanContentBoundary(srcRoot)
  return {
    rule: CONTENT_BOUNDARY_RULE_ID,
    scannedFiles: collectProductionSourceFiles(srcRoot).length,
    allowlist: CONTENT_MARKUP_ALLOWLIST.map((a) => a.file),
    findings,
    verdict: findings.length === 0 ? 'pass' : 'fail',
  }
}
