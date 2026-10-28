/**
 * 内容边界闸门（A32）—— vitest 接线。
 *
 * 与 `boundary-scan.test.ts` 的分工：那个文件驱动 `GATE_RULES`
 * （导入图/纯核心层）；本文件驱动**内容边界**判据
 * （`content-boundary-gate.mjs`，自包含，不改共享规则文件）。
 *
 * `vitest.architecture.config.ts` 的 include 是 `tests/architecture/**\/*.test.ts`，
 * 因此本文件**自动**纳入 `npm run test:arch`，无需改动任何共享配置。
 *
 * ## 负对照（必须证明确实破坏了目标保证）
 *
 * "未处理字符串直传 innerHTML/v-html 判红"这条负对照的实证方式：
 * 在临时树里造出真实的违规文件，断言扫描器**确实**抓住它们并指出文件与行号；
 * 同一文件只改"是否含注入"这一个事实，判定随之翻转（非恒红、非恒绿）。
 * 另外验证注释不被误判（否则会逼实现者删掉交接信息）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CONTENT_MARKUP_ALLOWLIST,
  scanContentBoundary,
  stripCommentsForScan,
  summarizeContentBoundary,
} from './content-boundary-gate.mjs'
import { SRC_ROOT } from './module-graph.mjs'

let tmpRoot = null

/** 造一棵最小 src 树；`files` 是 `相对 src 的路径 → 内容`。 */
function makeTree(files) {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-p08-content-'))
  const srcRoot = path.join(tmpRoot, 'src')
  fs.mkdirSync(srcRoot, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(srcRoot, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
  }
  return srcRoot
}

beforeEach(() => { tmpRoot = null })
afterEach(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
  tmpRoot = null
})

describe('A32 内容边界闸门：本树实况', () => {
  it('本树 0 finding（6 条直通路径已收编，仅白名单内的 TrustedIcon 保留 v-html）', () => {
    const report = summarizeContentBoundary(SRC_ROOT)
    expect(report.verdict, JSON.stringify(report.findings, null, 2)).toBe('pass')
    expect(report.findings).toEqual([])
    expect(report.scannedFiles).toBeGreaterThan(200)
    // 白名单必须**非空**：全仓零 v-html 是不可能的（内联 SVG 需要它），
    // 若白名单为空则本规则是"恒绿"的假设施。
    expect(report.allowlist).toEqual(['src/editors/TrustedIcon.vue'])
  })

  it('白名单条目的文件**确实存在**且确实用了 v-html（防白名单腐烂）', () => {
    for (const entry of CONTENT_MARKUP_ALLOWLIST) {
      const abs = path.join(path.dirname(SRC_ROOT), entry.file)
      expect(fs.existsSync(abs), `${entry.file} 不存在（白名单应随实现更新）`).toBe(true)
      const text = fs.readFileSync(abs, 'utf8')
      expect(/v-html/.test(text), `${entry.file} 已不用 v-html，应从白名单移除`).toBe(true)
      expect(entry.because.length, '白名单必须写明理由').toBeGreaterThan(10)
    }
  })
})

describe('A32 负对照：新增标记注入必须判红', () => {
  it('正对照：合规文件（用受控呈现组件）判绿', () => {
    const srcRoot = makeTree({
      'editors/Good.vue': [
        '<script setup lang="ts">',
        "import ContentText from '@/editors/ContentText.vue'",
        'const raw = "<b>x</b>"',
        '</script>',
        '<template>',
        '  <ContentText :text="raw" mode="mc" />',
        '</template>',
      ].join('\n'),
    })
    expect(scanContentBoundary(srcRoot)).toEqual([])
  })

  it('负对照 1：模板里新增 `v-html` ⇒ 判红并指出文件与行号', () => {
    const srcRoot = makeTree({
      'editors/Leaky.vue': [
        '<script setup lang="ts">',
        "import { ref } from 'vue'",
        'const html = ref("<b>x</b>")',
        '</script>',
        '<template>',
        '  <div v-html="html" />',
        '</template>',
      ].join('\n'),
    })
    const hits = scanContentBoundary(srcRoot)
    expect(hits, '新增 v-html 必须判红').toHaveLength(1)
    expect(hits[0].rule).toBe('gate/content-boundary')
    expect(hits[0].file).toBe('src/editors/Leaky.vue')
    expect(hits[0].line).toBe(6)
    expect(hits[0].detail).toContain('受控呈现边界')
  })

  it('负对照 2：命令式 `el.innerHTML = …` 同样判红（不只是模板指令）', () => {
    const srcRoot = makeTree({
      'workbench/ux/Bad.ts': [
        'export function paint(el: HTMLElement, raw: string): void {',
        '  el.innerHTML = raw',
        '}',
      ].join('\n'),
    })
    const hits = scanContentBoundary(srcRoot)
    expect(hits).toHaveLength(1)
    expect(hits[0].syntax).toContain('innerHTML')
  })

  it('负对照 3：`insertAdjacentHTML` 与 `outerHTML=` 也判红（覆盖四种形态）', () => {
    const srcRoot = makeTree({
      'a.ts': 'export const f = (el: HTMLElement, s: string) => { el.insertAdjacentHTML("beforeend", s) }',
      'b.ts': 'export const g = (el: HTMLElement, s: string) => { el.outerHTML = s }',
    })
    const hits = scanContentBoundary(srcRoot)
    expect(hits.map((h) => h.file).sort()).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('负对照 4：豁免是**精确文件**而非目录（同目录兄弟文件仍判红）', () => {
    const srcRoot = makeTree({
      // 白名单文件（相对 src 的路径与白名单登记一致）
      'editors/TrustedIcon.vue': [
        '<script setup lang="ts">',
        'const markup = "<svg/>"',
        '</script>',
        '<template>',
        '  <span v-html="markup" />',
        '</template>',
      ].join('\n'),
      // 同目录的另一个文件**不在**白名单内 ⇒ 必须判红
      'editors/Sibling.vue': [
        '<script setup lang="ts">',
        'const h = "<b/>"',
        '</script>',
        '<template>',
        '  <span v-html="h" />',
        '</template>',
      ].join('\n'),
    })
    const hits = scanContentBoundary(srcRoot)
    expect(hits.map((h) => h.file)).toEqual(['src/editors/Sibling.vue'])
  })

  it('负对照 5：注释里的 `v-html` / `innerHTML` **不**算违规', () => {
    const srcRoot = makeTree({
      'domain/notes.ts': [
        '// 旧实现用 v-html 直通，已收编到受控呈现边界',
        '/* 同理 el.innerHTML = raw 也已退役 */',
        'export const ok = 1',
      ].join('\n'),
      // .vue 模板里的多行 HTML 注释（跨行注释必须一起剥掉）
      'editors/Doc.vue': [
        '<script setup lang="ts">',
        'export const x = 1',
        '</script>',
        '<template>',
        '  <!--',
        '    这里说明旧路径：v-html 与 el.innerHTML = raw 都已退役。',
        '  -->',
        '  <div>x</div>',
        '</template>',
      ].join('\n'),
    })
    expect(scanContentBoundary(srcRoot)).toEqual([])
  })
})

describe('A32 闸门的元保证：判据非恒红、非恒绿', () => {
  it('同一文件只改"是否含注入"这一个事实，判定随之翻转', () => {
    const clean = [
      '<script setup lang="ts">',
      'const v = "<b>x</b>"',
      '</script>',
      '<template>',
      '  <div>{{ v }}</div>',
      '</template>',
    ].join('\n')
    const dirty = clean.replace('{{ v }}', 'v-html="v"')

    const a = makeTree({ 'editors/X.vue': clean })
    expect(scanContentBoundary(a), '干净样本判绿').toEqual([])
    const b = makeTree({ 'editors/X.vue': dirty })
    expect(scanContentBoundary(b), '同一文件仅多 v-html 即判红').toHaveLength(1)
  })

  it('`stripCommentsForScan` 保留行号（报告能对到真实文件）', () => {
    // 块注释跨 2 行 ⇒ 剥离后仍是 6 行（行号必须与原文一一对应，
    // 否则报告指出的行号会把读者带到错误位置）
    const src = ['a', '// v-html', 'b', '/* v-html', 'v-html */', 'c'].join('\n')
    const out = stripCommentsForScan(src).split('\n')
    expect(out).toHaveLength(6)
    expect(out[0]).toBe('a')
    expect(out[2]).toBe('b')
    expect(out[5]).toBe('c')
    expect(out.join('\n')).not.toContain('v-html')
  })

  it('`https://` 里的 `//` 不被当成行注释（避免把代码整段吞掉）', () => {
    const src = "const u = 'https://a.b/c'\nconst h = v-html"
    const out = stripCommentsForScan(src)
    expect(out).toContain('https://a.b/c')
    expect(out).toContain('v-html')
  })

  it('扫描结果稳定排序（同一树两次运行逐项一致，可对账）', () => {
    const srcRoot = makeTree({
      'z.ts': 'export const z = (el: HTMLElement, s: string) => { el.innerHTML = s }',
      'a.ts': 'export const a = (el: HTMLElement, s: string) => { el.innerHTML = s }',
    })
    const first = scanContentBoundary(srcRoot)
    const second = scanContentBoundary(srcRoot)
    expect(first.map((f) => f.file)).toEqual(['src/a.ts', 'src/z.ts'])
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })
})
