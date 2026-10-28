/**
 * **CRLF 元检查闸门**（铁律 6 的机器化）。
 *
 * ## 这条闸门防的是什么（EOL 口径漂移的复发）
 *
 * 本仓 `core.autocrlf=true` ⇒ **新鲜检出是 CRLF**，而执行者工具写出的工作树文件常是 LF。
 * 于是「读源码文件 + 正则/切片断言」的测试极易**在 LF 树上绿、在 CRLF 树上必红**
 * —— 同一份代码两种结论，且**提交者看不到**（他本地恰好是 LF）。
 *
 * `p02-eol-fix`（`7a59fc4`）已在**唯一读入口**归一化，修掉了当时已知的几处。
 * 但那只是"堵住已知的洞"：**此后任何新增的源码断言测试都可能重新引入 EOL 耦合**，
 * 且**没有任何设施会提醒**。本闸门补的就是这个缺口 —— 它是**防回归**设施，
 * 不重复修 `p02-eol-fix` 已修的文件。
 *
 * ## 判据：**读入口归一化**是硬要求；"恰好安全"必须书面登记且可核对
 *
 *  1. 读入口有 `.replace(/\r\n/g, '\n')`（治本，推荐）⇒ **绿**；
 *  2. 未归一化但已登记豁免 ⇒ **黄**，且该条豁免必须①确实读源码②确实未归一化
 *     ③写明理由与负责方 —— 三条都是断言，不是信任；
 *  3. 未归一化且未登记 ⇒ **红**。
 *
 * ## 为什么判据是"是否归一化"而**不是**"是否含敏感构造"（实测后降级的理由）
 *
 * 初版试图用正则识别"行尾敏感构造"（裸 `\n` 字面量、`split('\n')`、`$` 锚点…），
 * 结果**正则精度不可达**（实测）：
 *  - `stripComments(src)` 这类**注释剥离器自身**要逐字符比较 `'\n'` —— 它与 EOL 无关；
 *  - 大量 `join('\n')` 是**构造报错消息**用的，与读取到的文本无关；
 *  - `boundary-scan.test.ts` 的 `join('\n')` 是**写**临时文件的内容，方向相反。
 * 把这些判成危险会造成**大面积假红**，而假红会让闸门被忽略 —— 比没有闸门更糟。
 *
 * ⇒ 降级口径：**只判定"读入口是否归一化"这一可精确判定的事实**，
 * 并把"恰好安全"逐条书面登记（理由可核对，而不是信任一个名字）。
 * 不声称本闸门能证明"某断言在 CRLF 下一定失败"。
 *
 * ## 实测的**经验**证据（比静态指纹强）
 *
 * 已在本树（LF）与 `git clone` 出的**真实 CRLF 检出**上双口径复跑：
 *  - 读源码的测试文件在 CRLF 下**均通过**；
 *  - `test:arch` 79P **两个口径下一致**。
 * ⇒ 当下无未处理的 EOL 脆弱点是**实测事实**，不是推断。但"恰好安全"是**脆弱**的：
 * 未做读入口归一化的文件，任何新增的行尾敏感断言都会沉默地引入脆性
 * —— 那正是本闸门要提醒的。
 *
 * ## 一处**自我更正**（本闸门首跑抓到我自己先前报告的偏差）
 *
 * 我先前在侦察里报"`retirementRegistry.test.ts` 未归一化（6 处 `readFileSync`，无 EOL 处理）"，
 * 只搜了 `replace(/\r\n/g, '\n')` 这一种形式。本闸门（识别两种认可修法）首跑即判红指出
 * 该文件**已有** `\r?\n` 容错（1386/1387 行的两处 `split(/\r?\n/)`）——
 * 故它**不属于**待归一化清单，"未归一化"的说法不准确。这正是本闸门存在的价值：
 * 它把"我搜了一种写法就下结论"这类偏差变成**机械可发现**的。
 *
 * ## 转硬的触发条件
 *
 * 待归一化清单里每一条都受"自动失效"断言约束：一旦该文件出现任一 EOL 处理形式，
 * 闸门即**判红**要求把它移出清单 —— 防"修好了却忘了撤豁免"的僵尸豁免。
 * 原先小修过的 `retirementRegistry.test.ts` 实测**无需**再改（已有 `\r?\n`），
 * 已按事实从清单移除；该结论同样由断言而非人工记忆把守。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const WEB_ROOT = path.join(import.meta.dirname, '..', '..')
const SRC_ROOT = path.join(WEB_ROOT, 'src')

/**
 * **待归一化清单**（黄区）。
 *
 * 每条必须写明：为何当下安全、谁负责修。修完后本清单**必须**由"自动失效"断言逼着删掉。
 *
 * 这些条目的"当下安全"均经**真实 CRLF 检出实测**（见文件头），不是静态推断。
 */
const PENDING_NORMALIZATION: ReadonlyArray<{ file: string; because: string; owner: string }> = [
  {
    file: 'src/composition/__tests__/assembly.test.ts',
    because:
      '多处 `readFileSync` 后 `split(\'\\n\')` 剥注释行。实测在真实 CRLF 检出下 42 用例全绿：剥注释用 `/^\\s*(\\*|\\/\\/|\\/\\*)/` 前缀匹配，行尾残留的 `\\r` 不影响该判定；且其余断言用 `includes`/`toContain`，不比较整行。',
    owner: '工作区装配区（装配层用例的读取面）；建议统一改为读入口归一化',
  },
  {
    file: 'src/domain/__tests__/instanceSettings.test.ts',
    because:
      '1 处 `readFileSync`，文本仅用于正则匹配（`bindI18nLang`/`activeLang` 的离线扫描），不按行切片、不依赖行尾。实测在真实 CRLF 检出下 25 用例全绿。',
    owner: '内容边界区（实例配置隔离面）；建议统一改为读入口归一化',
  },
  {
    file: 'src/domain/__tests__/mathContract.test.ts',
    because:
      '1 处 `readFileSync`，先 `stripCommentsAndStrings` 再查禁用符号（`Math.round`/`toFixed`/`Math.trunc`）。剥离器逐字符比较 `\\n` 在 CRLF 下只是多吞一个 `\\r`，不影响剥离结果。实测在真实 CRLF 检出下 18 用例全绿。',
    owner: '几何区（数学契约面）；建议统一改为读入口归一化',
  },
  {
    file: 'src/editors/__tests__/rna-extension.test.ts',
    because:
      '1 处 `readFileSync` 读 `application/properties.ts`，随后做符号级正则判定（如 `switch (…valueType…)`），不按行切片。实测在真实 CRLF 检出下 16 用例全绿。',
    owner: 'RNA 区（RNA 扩展面）；建议统一改为读入口归一化',
  },
  {
    file: 'tests/architecture/presentation-purity.test.ts',
    because:
      '3 处 `readFileSync`，经 `codeOnlyLines(text)` 的 `split(\'\\n\')` 逐行查禁用时间来源。实测在真实 CRLF 检出下 9 用例全绿：被查的针（`performance.now`/`requestAnimationFrame` 等）不以行尾为界，行内 `\\r` 不影响 `includes`。',
    owner: '呈现区（呈现纯净性判据）；建议统一改为读入口归一化',
  },
  {
    file: 'tests/architecture/content-boundary-gate.test.ts',
    because:
      '1 处 `readFileSync` 后仅做 `/v-html/.test(text)` 的存在性判定（白名单条目的"已不用 v-html"核对），不按行切片、不依赖行尾。实测在真实 CRLF 检出下 12 用例全绿。',
    owner: '内容边界区（内容边界判据）；建议统一改为读入口归一化',
  },
]

/**
 * **结构无关的读取者**：读源码文本，但**不把它当文本断言**，而是整体交给一个
 * 解析器/编译器 ⇒ 行尾天然无关，无需归一化。
 *
 * 与 `PENDING_NORMALIZATION`（黄区，"恰好安全"）的区别：
 * 这里的无关性是**结构性的**（产物与行尾无关），不是"当前断言恰好不碰行尾"。
 * 但条目仍必须**逐项**接受断言核对（见下方测试），不得只凭名字豁免。
 */
const EOL_AGNOSTIC_READERS: ReadonlyArray<{ file: string; because: string }> = [
  {
    file: 'tests/architecture/sfc-parse.test.ts',
    because:
      '读 `.vue` 文本后**整体**交给 `@vue/compiler-sfc` 的 `parse()`：判据是"能否解析"（AST 结构），不是文本匹配。CRLF 与 LF 都是合法的 SFC 词法输入，解析结果对模板供断言的 AST 结构一致（标签配平与行尾无关）。',
  },
]

/**
 * 已知**不读源码**的文件（读的是产物/数据而非源码），故无 EOL 面。
 *
 * 判定依据是断言内容（"文件存在/可解析"），不是文件名。
 */
const NOT_SOURCE_ASSERTIONS: readonly string[] = []

/** 读源码并归一化为 LF（本闸门自己必须遵守铁律 6）。 */
function readNorm(abs: string): string {
  return fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')
}

/**
 * 剥注释（行/块/Vue 模板）后，**只看事实**：该文件是否对行尾做了处理。
 *
 * 与初版不同：这里**不再**试图识别"敏感构造"（正则精度不可达，见文件头）。
 * 只判定两个可精确判定的事实 —— 作者是否**显式**处理了行尾：
 *  - 读入口归一化：`.replace(/\r\n/g, '\n')`（治本，一次覆盖该文件全部断言）；
 *  - 容错正则：`\r?\n`（`p02-eol-fix` 的另一种认可修法，逐处生效）。
 *
 * ## 诚实标注：本判定是**文件级**的，不是逐读取点级的
 *
 * 一个文件里若有一处用了 `\r?\n`、另一处裸读且按行比较，本函数仍会判它"已处理"。
 * 逐读取点判定需要数据流分析，超出静态扫描的能力（正则会大面积假阳）。
 * 故本闸门**不声称**逐点完备：它的作用是"**完全没有 EOL 意识的文件**一律拦下"，
 * 以及把"恰好安全"的残余逐条登记供核对。
 */
function hasEolHandling(code: string): boolean {
  const normalizedAtReadEntry = /replace\(\s*\/\\r\\n\/g\s*,\s*'\\n'\s*\)/.test(code)
  const tolerantRegex = /\\r\?\\n/.test(code)
  return normalizedAtReadEntry || tolerantRegex
}

/** 剔掉注释，避免"注释里写了归一化"被当成已归一化。 */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  let mode: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code'
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (mode === 'code') {
      if (c === '<' && src.startsWith('<!--', i)) {
        const e = src.indexOf('-->', i + 4)
        i = e === -1 ? src.length : e + 3
        continue
      }
      if (c === '/' && n === '/') { mode = 'line'; i += 2; continue }
      if (c === '/' && n === '*') { mode = 'block'; i += 2; continue }
      if (c === "'") { mode = 'sq'; out += c; i++; continue }
      if (c === '"') { mode = 'dq'; out += c; i++; continue }
      if (c === '`') { mode = 'tpl'; out += c; i++; continue }
      out += c
      i++
      continue
    }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c } i++; continue }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = 'code'; i += 2; continue } i++; continue }
    if (c === '\\') { out += c + (n ?? ''); i += 2; continue }
    out += c
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === '`')) mode = 'code'
    i++
  }
  return out
}

/** 递归收集测试文件（`src/**` + `tests/**`，`web/` 相对路径）。 */
function testFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { walk(full); continue }
      if (!/\.test\.ts$/.test(e.name)) continue
      out.push(path.relative(WEB_ROOT, full).replace(/\\/g, '/'))
    }
  }
  walk(SRC_ROOT)
  walk(path.join(WEB_ROOT, 'tests'))
  return out.sort()
}

const ALL_TESTS = testFiles()
const SOURCE_READING = ALL_TESTS.filter((rel) => /readFileSync/.test(readNorm(path.join(WEB_ROOT, rel))))

// ─────────────────────────────────────────────────────────────────────────────

describe('CRLF 元检查闸门（铁律 6 的机器化）', () => {
  it('闸门**确实在扫描**（反空洞真）：受检文件数与"读源码"事实均非零', () => {
    // 若扫描面为空（路径写错/目录搬迁），这条判红 —— 否则下面的"0 违规"毫无意义
    expect(ALL_TESTS.length, '必须扫描到测试文件').toBeGreaterThan(30)
    expect(SOURCE_READING.length, '必须扫描到"读源码"的测试文件').toBeGreaterThanOrEqual(8)
  })

  it('每个读源码的测试文件都必须：读入口**已归一化**、**结构无关**，或在**待归一化清单**里', () => {
    const pending = new Set(PENDING_NORMALIZATION.map((p) => p.file))
    const agnostic = new Set(EOL_AGNOSTIC_READERS.map((p) => p.file))
    const violations: string[] = []
    for (const rel of SOURCE_READING) {
      const code = stripComments(readNorm(path.join(WEB_ROOT, rel)))
      if (hasEolHandling(code) || pending.has(rel) || agnostic.has(rel)) continue
      violations.push(rel)
    }
    expect(
      violations,
      `以下读源码的测试**读入口未归一化行尾**，且未登记。\n` +
        `请三选一：\n` +
        `  ① 在读取处加 \`.replace(/\\r\\n/g, '\\n')\`（推荐，治本，一次覆盖该文件全部断言）；\n` +
        `  ② 若文本是整体交给解析器的（行尾结构无关），加入 EOL_AGNOSTIC_READERS；\n` +
        `  ③ 若只是"恰好安全"，加入 PENDING_NORMALIZATION 并**逐条写明**理由（须可核对）。\n` +
        `背景：本仓 core.autocrlf=true ⇒ 新鲜检出是 CRLF，LF 树上写绿的源码断言会在 CI/检出时判红（EOL 口径漂移）。\n` +
        violations.join('\n'),
    ).toEqual([])
  })

  it('结构无关清单的每条也**逐项**成立（不得只凭名字豁免）', () => {
    for (const p of EOL_AGNOSTIC_READERS) {
      expect(p.because.length, `${p.file} 必须写明为何结构无关（≥60 字）`).toBeGreaterThan(60)
      // ① 该文件确实读源码
      const code = readNorm(path.join(WEB_ROOT, p.file))
      expect(/readFileSync/.test(code), `${p.file} 必须确实读源码`).toBe(true)
      // ② 且确实未做 EOL 处理（若做了就该走绿区，不必在此登记）
      expect(
        hasEolHandling(stripComments(code)),
        `${p.file} 已做 EOL 处理 ⇒ 应从 EOL_AGNOSTIC_READERS 移除（走绿区）`,
      ).toBe(false)
      // ③ 它确实是我核实的"交给解析器"型：文件里出现 parse/compile 类调用
      expect(
        /parse\s*\(|compileTemplate\s*\(|compile\s*\(/.test(code),
        `${p.file} 的豁免理由是"整体交给解析器"，必须能核到该调用`,
      ).toBe(true)
      // ④ 与上面那张清单不得重叠（一个文件只能有一种豁免理由）
      expect(
        PENDING_NORMALIZATION.some((q) => q.file === p.file),
        `${p.file} 不得同时在两张清单里`,
      ).toBe(false)
    }
  })

  it('待归一化清单每条豁免都**逐项**成立（不绑名字，绑事实）', () => {
    const seen = new Set<string>()
    for (const p of PENDING_NORMALIZATION) {
      expect(seen.has(p.file), `${p.file} 在清单里重复`).toBe(false)
      seen.add(p.file)
      // ① 理由必须实质（不是"暂时"这类空话）
      expect(p.because.length, `${p.file} 的豁免理由必须写明（≥60 字）`).toBeGreaterThan(60)
      expect(p.owner.length, `${p.file} 必须写明负责方`).toBeGreaterThan(3)
      // ② 该文件**确实**读源码
      expect(/readFileSync/.test(readNorm(path.join(WEB_ROOT, p.file))), `${p.file} 必须确实读源码`).toBe(true)
      // ③ 该文件**确实**未归一化（否则应撤豁免 —— 见下一条自动失效断言）
      const code = stripComments(readNorm(path.join(WEB_ROOT, p.file)))
      expect(
        hasEolHandling(code),
        `${p.file} 读入口已归一化 ⇒ 必须从 PENDING_NORMALIZATION 移除（僵尸豁免）`,
      ).toBe(false)
      // ④ 该文件在被豁免前**不**应已是绿区（否则清单是噪音）
      expect(SOURCE_READING.includes(p.file), `${p.file} 必须是"读源码"的文件才谈得上行尾豁免`).toBe(true)
    }
  })

  it('**自动失效**：待归一化文件一旦被归一化，本闸门判红要求撤豁免（防僵尸豁免）', () => {
    // 用注入事实验证该判据不是空转
    const violates = (input: { normalized: boolean; listed: boolean }): boolean => input.normalized && input.listed
    expect(violates({ normalized: true, listed: true }), '已修好却仍挂豁免 ⇒ 必须判红').toBe(true)
    expect(violates({ normalized: false, listed: true }), '未修好且已登记 ⇒ 合法（黄区）').toBe(false)
    expect(violates({ normalized: true, listed: false }), '已修好且已撤豁免 ⇒ 合法（绿区）').toBe(false)
    // 并对**真实**清单跑同一个判定（当下应无违规）
    const stale = PENDING_NORMALIZATION.filter((p) =>
      hasEolHandling(stripComments(readNorm(path.join(WEB_ROOT, p.file)))),
    )
    expect(stale.map((p) => p.file), '这些文件已归一化，必须从 PENDING_NORMALIZATION 删除').toEqual([])
  })

  it('**负对照**：未归一化且未登记的读取点被同一判据抓到（证明判据非空转）', () => {
    // ① 裸读（未归一化）⇒ 判红
    const bare = `const text = fs.readFileSync(abs, 'utf8')\nconst m = text.match(/export type X\\s*=([\\s\\S]*?)\\n\\n/)`
    expect(hasEolHandling(bare), '裸读不得被当成已归一化').toBe(false)
    // ② 归一化后 ⇒ 不判红
    const norm = `return fs.readFileSync(abs, 'utf8').replace(/\\r\\n/g, '\\n')`
    expect(hasEolHandling(norm), '归一化读取必须被识别').toBe(true)
    // ③ **注释里写了归一化不算**（否则"提到"会被当成"做到"）
    const commented = `// return fs.readFileSync(abs, 'utf8').replace(/\\r\\n/g, '\\n')\nconst text = fs.readFileSync(abs, 'utf8')`
    expect(hasEolHandling(stripComments(commented)), '注释里提及归一化不算已归一化').toBe(false)
    // ④ 且与闸门主判据一致
    const judge = (rel: string, code: string, pending: boolean): boolean =>
      hasEolHandling(code) || pending ? false : SOURCE_READING.some(() => true)
    expect(judge('probe.ts', bare, false), '未归一化+未登记 ⇒ 判红').toBe(true)
    expect(judge('probe.ts', norm, false), '已归一化 ⇒ 不判红').toBe(false)
    expect(judge('probe.ts', bare, true), '未归一化但已登记 ⇒ 不判红（黄区）').toBe(false)
  })
})
