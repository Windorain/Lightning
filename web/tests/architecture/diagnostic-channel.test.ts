/**
 * **诊断通道收口**的常驻判据（退役审计同族）。
 *
 * ## 它把两条纪律变成可执行断言
 *
 * | 判据 | 防什么 |
 * |---|---|
 * | `src/` 生产面不得有**未登记的** `console.*` 直写 | 用户可见失败只留在控制台（S0-B §4.3 第 5 条：32 处/13 文件） |
 * | 码表里每一码都有**代码行**里的发射点 | 码表变成许愿单（S0-B §4.2：18 码只有类型、无生产者） |
 *
 * ## 两条判据都带负对照
 *
 * - console：给扫描器喂一段**注入样本**（含一处直写）⇒ 扫描器必须报出它；例外表条目若无对应命中 ⇒ 判"例外条目无对应命中"（同 `export-purity` 的 `EXPORT_LIVE_VIEWPORT_EXCEPTIONS` 形态）。
 * - 码表：用一个不存在的码去查 ⇒ 必须零命中（证明"每码都有发射点"不是恒真）。
 *
 * ## 为什么扫描要**先剥注释**
 *
 * 本仓多处注释在解释"旧形态是 console.error(...)"与"某码曾被借用"；把注释算成命中会让
 * 判据逼着作者删掉历史说明（那是把审计面变成文案警察）。剥注释后只判**代码行**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DIAGNOSTIC_CODES } from '@/application/diagnostics'

const SRC_ROOT = path.resolve(__dirname, '../../src')
const DIAGNOSTICS_FILE = 'application/diagnostics.ts'

/** 读源码并归一化为 LF（铁律 6：`core.autocrlf=true`，新鲜检出是 CRLF）。 */
function readSource(absPath: string): string {
  return fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n')
}

/** 递归列出 `src/` 下的生产源文件（排除 `__tests__`）。 */
function productionFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue
        walk(abs)
        continue
      }
      if (/\.(ts|tsx|vue)$/.test(entry.name)) out.push(path.relative(SRC_ROOT, abs).replace(/\\/g, '/'))
    }
  }
  walk(SRC_ROOT)
  return out.sort()
}

/**
 * 把源码剥成"只有代码"的行（块注释与行注释替换为空白，保留换行以便报行号）。
 *
 * 局限（已知、可接受）：不识别字符串字面量里的 `//`（本仓没有把 URL 写进代码行的用法；
 * 若日后出现，最坏结果是**多算**一次命中 ⇒ 判红，而非静默放行）。
 */
function codeOnly(text: string): string[] {
  const withoutBlock = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  return withoutBlock.split('\n').map((line) => {
    const idx = line.indexOf('//')
    return idx < 0 ? line : line.slice(0, idx)
  })
}

interface ConsoleHit {
  readonly file: string
  readonly line: number
  readonly text: string
}

/** 一处 `console.<method>(` 直写。 */
const CONSOLE_CALL = /console\.(?:error|warn|log|debug|info)\s*\(/

/** 扫描一段源码里的 console 直写（代码行；注释已剥）。 */
export function consoleWritesIn(file: string, text: string): ConsoleHit[] {
  const out: ConsoleHit[] = []
  const lines = codeOnly(text)
  for (let i = 0; i < lines.length; i += 1) {
    if (CONSOLE_CALL.test(lines[i]!)) out.push({ file, line: i + 1, text: lines[i]!.trim() })
  }
  return out
}

/**
 * **明示例外表**（仿 `EXPORT_LIVE_VIEWPORT_EXCEPTIONS`）。
 *
 * 表里只允许放**按结构**就不该走诊断面的写点：
 *
 * | 类别 | 为什么 |
 * |---|---|
 * | 日志中心自身的 DEV 镜像 | 它就是日志；再走诊断面会自指递归，且只在 import.meta.env.DEV 下发生 |
 * | 挂载入口（embed/mount）失败 | 发生在**任何实例/Context 存在之前**：没有诊断面可写；失败已由返回值 + 容器内占位两面承载 |
 * | presentation 层的不变量哨兵 | presentation 不得 import runtime/application（presentation-purity/boundary-scan）⇒ 没有诊断端口；事实另有读面 |
 * | 渲染循环的帧钩子抛错 | 同属 presentation 层；抛错已被隔离（其它钩子与绘制继续），钩子主人自己报（如 overlay ⇒ effect.failed） |
 * | dev/e2e 专用入口 | 不是产品装配的一部分 |
 *
 * 每条都必须**有对应命中**（hits），否则"例外条目无对应命中"判红 —— 例外表不是免死金牌。
 */
interface ConsoleException {
  readonly file: string
  /** 命中行的特征（用于把同文件的多条写点区分开）。 */
  readonly lineMatch: RegExp
  /** 该文件里应命中的条数（防"随手加一条"被旧条目兜住）。 */
  readonly hits: number
  readonly why: string
  /** 同一事实的用户/判据读面（例外必须说明"那用户看什么"）。 */
  readonly readFace: string
}

export const CONSOLE_EXCEPTIONS: readonly ConsoleException[] = [
  {
    file: 'logging/LogCenter.ts',
    lineMatch: /console\.(warn|debug|info)\(\.\.\.args\)/,
    hits: 3,
    why: '日志中心自身的 DEV 镜像：它就是日志系统的最后一级出口（再走诊断面会自指递归），且仅在 import.meta.env.DEV 下发生。',
    readFace: 'window.__log__.recent() / entries（生产构建不执行这三行）',
  },
  {
    file: 'embed/mount.ts',
    lineMatch: /console\.(warn|error)\('\[StructureRenderer\] (mount|unmount):'/,
    hits: 4,
    why: '库入口在**任何实例/Context 存在之前**运行：挂载点缺失、装配抛错、卸载抛错时没有诊断面可写。',
    readFace: '返回的 EmbedMountFailure（code/message）+ 容器内占位块（用户可见）',
  },
  {
    file: 'presentation/presenter.ts',
    lineMatch: /console\.(warn|error)\(/,
    hits: 2,
    why: 'presentation 层按分层禁令不得 import runtime/application（没有诊断端口）；两条都是实现不变量哨兵（混合未实现 / 重放改了世代）。',
    readFace: 'blendedSamples 计数（混合缺口）/ session.generation 与 appliedContentIdentity（世代漂移）',
  },
  {
    file: 'runtime/renderEngine.ts',
    lineMatch: /console\.error\('\[RenderEngine\] frameHook'/,
    hits: 1,
    why: '渲染循环里的帧钩子抛错已被隔离（其它钩子与绘制继续）；钩子主人各自上报（overlay ⇒ effect.failed），引擎自身无 Context 端口。',
    readFace: '钩子主人写下的结构诊断（如 overlay 的 effect.failed）+ 画面本身',
  },
  {
    file: 'dev/DevApp.vue',
    lineMatch: /console\.error\('\[StructureRenderer\] WorkbenchRoot'/,
    hits: 1,
    why: 'dev 预览壳（dev/）不是产品装配的一部分；它的错误处理只在开发时可见。',
    readFace: '不适用（dev-only）',
  },
  {
    file: 'e2e/embed-mobile-main.ts',
    lineMatch: /console\.error\('\[e2e-embed-mobile\]'/,
    hits: 1,
    why: 'e2e 夹具页面入口（测试进程的替身页），不是产品代码。',
    readFace: '不适用（e2e 专用）',
  },
]

/** 在给定文件集合里找出**未被例外覆盖**的 console 直写。 */
export function uncoveredConsoleWrites(
  files: readonly string[],
  exceptions: readonly ConsoleException[] = CONSOLE_EXCEPTIONS,
): ConsoleHit[] {
  const violations: ConsoleHit[] = []
  for (const rel of files) {
    const hits = consoleWritesIn(rel, readSource(path.join(SRC_ROOT, rel)))
    if (hits.length === 0) continue
    const allowed = exceptions.filter((e) => e.file === rel)
    for (const hit of hits) {
      const matched = allowed.some((e) => e.lineMatch.test(hit.text))
      if (!matched) violations.push(hit)
    }
  }
  return violations
}

describe('通道收口：console 直写归零（或落在明示例外表）', () => {
  it('生产面不存在未登记的 console 直写', () => {
    const files = productionFiles()
    expect(files.length, '反空洞真：必须真的扫到了源文件').toBeGreaterThan(200)
    const violations = uncoveredConsoleWrites(files)
    expect(
      violations.map((v) => `${v.file}:${v.line}: ${v.text}`),
      '⚠️ 生产面的 console 直写必须改走诊断面 / 删除 / 进 CONSOLE_EXCEPTIONS（带理由与读面）',
    ).toEqual([])
  });

  it('例外表每条都有对应命中，且条数吻合（例外不是免死金牌）', () => {
    const problems: string[] = []
    for (const e of CONSOLE_EXCEPTIONS) {
      const hits = consoleWritesIn(e.file, readSource(path.join(SRC_ROOT, e.file))).filter((h) => e.lineMatch.test(h.text))
      if (hits.length !== e.hits) {
        problems.push(`${e.file}：例外声明 ${e.hits} 条，实测 ${hits.length} 条`)
      }
      if (e.why.length < 20) problems.push(`${e.file}：例外必须写清理由（why 太短）`)
      if (e.readFace.length < 8) problems.push(`${e.file}：例外必须写清\"那用户看什么\"（readFace 太短）`)
    }
    expect(problems).toEqual([])
  });

  it('负对照：注入一处 console 直写 ⇒ 扫描器判违规（有分辨力）', () => {
    const synthetic = [
      "import { ref } from 'vue'",
      'export function f() {',
      "  console.error('[injected] boom')",
      '}',
    ].join('\n')
    const hits = consoleWritesIn('runtime/__injected__.ts', synthetic)
    expect(hits, '扫描器必须抓到注入的直写').toHaveLength(1)
    expect(hits[0]!.line).toBe(3)
    // 同一判定：给一个**空例外表**跑同一段源码 ⇒ 违规（这正是"删掉例外条目就判红"的机制）
    expect(uncoveredConsoleWritesFromSource('runtime/__injected__.ts', synthetic, [])).toHaveLength(1)
    expect(
      uncoveredConsoleWritesFromSource('runtime/__injected__.ts', synthetic, [
        { file: 'runtime/__injected__.ts', lineMatch: /console\.error/, hits: 1, why: 'x'.repeat(24), readFace: 'x'.repeat(10) },
      ]),
    ).toHaveLength(0)
  });
});

describe('码表对账：每一码都有代码行里的发射点', () => {
  /**
   * 一个码的**生产发射点**（代码行，排除定义文件本体与"按码分派"的策略表）。
   *
   * 为什么不能"出现即算"：
   *  - `application/diagnostics.ts` 是码表本体；
   *  - `runtime/diagnosticProjection.ts` 是**按码分派**的严重级/采样表（它必须提到每个码，
   *    但它不发射任何记录）—— 若不排除它，删掉某码的发射点后仍会"命中"，
   *    对账就退化成恒真（本判据的负对照实测抓到的正是这个形态）。
   *  - 纯比较行（`code === '<码>'`）同样不算发射点：比较是**读**，不是发。
   */
  const DECLARATION_ONLY_FILES = new Set([DIAGNOSTICS_FILE, 'runtime/diagnosticProjection.ts'])

  function producerHits(code: string, files: readonly string[]): string[] {
    const needle = `'${code}'`
    const comparisons = [ `=== ${needle}` , `!== ${needle}` ]
    const out: string[] = []
    for (const rel of files) {
      if (DECLARATION_ONLY_FILES.has(rel)) continue
      const lines = codeOnly(readSource(path.join(SRC_ROOT, rel)))
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!
        if (!line.includes(needle)) continue
        if (comparisons.some((c) => line.includes(c))) continue
        out.push(`${rel}:${i + 1}`)
      }
    }
    return out
  }

  it('每码至少一个生产发射点（静态可达）', () => {
    const files = productionFiles()
    const orphans: string[] = []
    for (const code of DIAGNOSTIC_CODES) {
      if (producerHits(code, files).length === 0) orphans.push(code)
    }
    expect(
      orphans,
      '⚠️ 码表每码要么有生产发射点（静态可达），要么从码表删除（码表不是许愿单）',
    ).toEqual([])
  });

  it('码表清单与联合类型不漂移；已按事实删除的码不得复活', () => {
    expect(new Set(DIAGNOSTIC_CODES).size, '码表不得有重复项').toBe(DIAGNOSTIC_CODES.length)
    expect(DIAGNOSTIC_CODES.length).toBeGreaterThanOrEqual(38)
    for (const removed of [
      'effect.started',
      'effect.cancelRequested',
      'effect.cancelled',
      'effect.succeeded',
      'evaluation.invalidated',
      'evaluation.stale',
    ]) {
      expect(DIAGNOSTIC_CODES as readonly string[], `已删除的码不得复活：${removed}`).not.toContain(removed)
    }
  });

  it('负对照：不存在的码零命中，真实码必有命中（对账有分辨力）', () => {
    const files = productionFiles().filter((f) => f !== DIAGNOSTICS_FILE)
    expect(producerHits('command.__injected_no_producer__', files)).toEqual([])
    expect(producerHits('command.rejected', files).length).toBeGreaterThan(0)
  });
});

/** 同一判定，但输入是**内存里的源码**（负对照用；不依赖文件存在）。 */
function uncoveredConsoleWritesFromSource(
  file: string,
  text: string,
  exceptions: readonly ConsoleException[],
): ConsoleHit[] {
  const hits = consoleWritesIn(file, text)
  const allowed = exceptions.filter((e) => e.file === file)
  return hits.filter((hit) => !allowed.some((e) => e.lineMatch.test(hit.text)))
}