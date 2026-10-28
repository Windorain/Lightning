/**
 * **SFC 结构校验闸门**。
 *
 * ## 为什么需要它（实测缺口）
 *
 * 变基解冲突时我用脚本按行区间拼接 `WorkbenchRoot.vue` 的模板，结果拼出了**两个连续的
 * `<HostProvider>` 开标签**（只有一个闭标签）⇒ Vue 编译期报
 * `Element is missing end tag` ⇒ **整个工作台白屏**。
 *
 * 当时**所有静态套件都通过了**：
 *  - `vitest` 1202 条用例全绿（用例大多不经 SFC 编译，且工作台根不在其覆盖内）；
 *  - `vue-tsc` 报 4 项既有错误，**不含**模板配平问题（本仓 `.vue` 的模板结构不在这条校验面内）；
 *  - `test:arch` 的模块图/文本指纹判据与模板无关。
 *
 * **只有 e2e 抓到**（vite dev server 的编译错误让 20 条用例超时）。
 * 按"单测全绿 ≠ 结构正确"的教训，若"单测全绿即交付"，这个白屏会直接进集成树。
 *
 * ⇒ 本闸门把"模板能否编译"提到**静态面**：成本极低（纯编译期解析），
 * 却覆盖了一类目前**只有 e2e 能发现**的缺陷。
 *
 * ## 判据
 *
 * 全量扫描 `src/**\/*.vue`（不依赖 git 状态 —— 免除"新增文件忘了纳入"的盲区），
 * 逐个用 `@vue/compiler-sfc` 的 `parse()` 解析，任何 `errors` 即判红。
 *
 * ## 为什么用 `parse()` 而不是自己配平标签
 *
 * 自写标签配平正则**必然误判**：`<template v-if>` 的嵌套 slot、
 * 自闭合组件、`v-html` 里的 HTML 字符串、模板里的比较运算符 `a < b`…
 * 而 `parse()` 就是 vite/`@vitejs/plugin-vue` 实际使用的同一个编译器入口 ——
 * **判据与运行时同源**，不会出现"闸门绿而构建红"。
 *
 * ## 独立于 `vue-tsc`
 *
 * `vue-tsc` 的问题是**类型**；本闸门的问题是**结构可解析性**。两者不重叠：
 * 一个文件可以类型完全正确却无法编译。故本闸门不因 `vue-tsc` 已有既有错误而失去价值。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from '@vue/compiler-sfc'

const SRC_ROOT = path.join(import.meta.dirname, '..', '..', 'src')

/** 递归收集全部 `.vue` 单文件组件（`src/` 相对路径）。 */
function vueFiles(dir: string = SRC_ROOT, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      vueFiles(full, out)
      continue
    }
    if (e.name.endsWith('.vue')) out.push(path.relative(SRC_ROOT, full).replace(/\\/g, '/'))
  }
  return out.sort()
}

// ─────────────────────────────────────────────────────────────────────────────

describe('SFC 结构校验闸门（模板必须可编译）', () => {
  it('全量 `src/**/*.vue` 都能被 `@vue/compiler-sfc` 解析（无 "Element is missing end tag" 一类错误）', () => {
    const files = vueFiles()
    const failures: string[] = []
    for (const rel of files) {
      const source = fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8')
      const { errors } = parse(source, { filename: rel })
      if (errors.length === 0) continue
      const msgs = errors
        .map((e) => {
          const line = e.loc?.start?.line
          return `${line === undefined ? '' : `L${line}: `}${e.message}`
        })
        .join(' | ')
      failures.push(`${rel} —— ${msgs}`)
    }
    expect(
      failures,
      `以下 SFC **无法编译**（工作台/组件会白屏，且这条缺陷静态面此前只有 e2e 能发现）：\n` +
        `${failures.join('\n')}\n\n` +
        `常见原因：模板标签未配平（多开/少闭）、插值括号不匹配、slot 嵌套错位。`,
    ).toEqual([])
  })

  it('**反空洞真**：确实扫描到了 `.vue` 文件（否则上一条的"0 违规"毫无意义）', () => {
    const files = vueFiles()
    expect(files.length, '必须扫描到 .vue 组件').toBeGreaterThan(20)
    // 且包含改动过的那几个（证明扫描面覆盖到了风险点）
    expect(files, '必须覆盖 WorkbenchRoot.vue').toContain('workbench/WorkbenchRoot.vue')
    expect(files, '必须覆盖 WorkbenchShell.vue').toContain('workbench/layout/WorkbenchShell.vue')
    expect(files, '必须覆盖 MenubarWikiStatus.vue').toContain('workbench/components/MenubarWikiStatus.vue')
  })

  it('**负对照**：模板标签不配平被同一判据抓到（证明判据非空转）', () => {
    // 复现真实缺陷的形态：两个连续开标签、一个闭标签
    const broken = `<template>\n  <HostProvider :host="host" :ctx="ctx">\n  <HostProvider :host="host" :ctx="ctx">\n    <div>x</div>\n  </HostProvider>\n</template>\n`
    const { errors } = parse(broken, { filename: 'probe.vue' })
    expect(errors.length, '未配平的模板必须被判红').toBeGreaterThan(0)
    expect(errors.map((e) => e.message).join(' '), '错误信息应指向缺失的结束标签').toMatch(/missing end tag/i)

    // 而配平后必须通过（否则判据会把正确代码也拦下）
    const fixed = `<template>\n  <HostProvider :host="host" :ctx="ctx">\n    <div>x</div>\n  </HostProvider>\n</template>\n`
    expect(parse(fixed, { filename: 'probe.vue' }).errors, '配平的模板不得判红').toEqual([])
  })
})
