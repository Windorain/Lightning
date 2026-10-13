/**
 * **渲染源迁移的机械口径与计数**（R1-β① C5）。
 *
 * ## 为什么需要它（而不只是"我数了一遍"）
 *
 * 本批的核心交付是「工作台双视口直接消费内核呈现契约」，而接缝
 * `legacy-render-source-document` 的（乙）子句是「**消费者迁移数 = 0**」。
 * 那条子句只有在一个**可机械重跑**的计数下才有意义 —— 否则"我改了 4 处"是自述，
 * 下一批无法判断它是否又长回来。
 *
 * ## 扫描口径（逐字可复跑）
 *
 * 1. 取 `src/` 下全部 `.ts` / `.vue`；**生产计数排除** `__tests__/` 与 `*.test.ts`；
 * 2. **去注释**（行注释 + 块注释）；
 * 3. **去字符串字面量**（`'…'` / `"…"` / 模板串）—— 本仓的接缝登记表把
 *    「`Context#legacyRenderSource()`」写在**字符串**里（`composition/seams.ts`），
 *    不去字符串就会把**登记文字**算成消费点（本批实测：不去则多出 `seams.ts`）；
 * 4. 匹配成员调用 `\.legacyRenderSource\s*\(` —— `Context` 上的**声明位**是
 *    `legacyRenderSource(): RuntimeDocument | null {`（无 `.` 前缀），故不计入；
 * 5. CRLF 归一化后匹配（AGENTS.md 铁律 6）。
 *
 * ## 现状与负对照
 *
 * C5 之前：生产调用点 **4 处**（`useViewportRuntime.ts` 的 `docRef`、
 * `useKernelChannels.ts` 的 `decl` 源、`EmbedViewport.vue` 的 tooltip 入参、
 * `workbench-rna.ts` 的多方块生成态判定）。
 * C5 之后：**3 处** —— `EmbedViewport.vue` 已改写为消费内核读面（元数据 + 注解行）。
 *
 * ⚠️ 本判据的**区分力**在第二条断言：把 `EmbedViewport.vue` 的
 * `ctx.legacyRenderSource()` 加回去 ⇒ 集合不符 ⇒ 判红（实测过）。
 * 只证明"新路径能用"的判据抓不住"留了旁路"，故这里锁的是**消费者集合**本身。
 *
 * ## 口径的诚实边界
 *
 * 字符串剥离是**正则近似**：模板串里的 `${…}` 嵌套引号、以及正则字面量里的引号
 * 会让剥离结果偏离真实解析。本判据据此**不**声称"覆盖一切写法"，只声称
 * "在真实消费者都用 `ctx.legacyRenderSource()` 的形态下，集合被钉住"。
 * 第三条自检把这条边界**显式化**（证明剥离确实承重、不是装饰）。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.join(process.cwd(), 'src')

/** 递归收集 `src/` 下的 `.ts` / `.vue`。 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sourceFiles(p, out)
    else if (e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.vue'))) out.push(p)
  }
  return out
}

/** 去注释（块注释 + 整行行注释）。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/** 去字符串字面量（单引号 / 双引号 / 模板串）。 */
function stripStrings(text: string): string {
  return text
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

/** 生产代码里 `X.legacyRenderSource(` 的调用点。 */
function productionCallSites(): { file: string; line: number }[] {
  const hits: { file: string; line: number }[] = []
  for (const abs of sourceFiles(SRC)) {
    const rel = path.relative(SRC, abs).replace(/\\/g, '/')
    if (/(^|\/)__tests__\//.test(rel) || /\.test\.ts$/.test(rel)) continue
    const code = stripStrings(stripComments(fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')))
    code.split('\n').forEach((line, i) => {
      if (/\.legacyRenderSource\s*\(/.test(line)) hits.push({ file: `src/${rel}`, line: i + 1 })
    })
  }
  return hits
}

describe('R1-β① C5 · `Context#legacyRenderSource()` 的生产消费点计数（接缝 `legacy-render-source-document`）', () => {
  it('生产消费点 = **3**，且**恰好**是这三处（新增一处即判红）', () => {
    const files = [...new Set(productionCallSites().map((h) => h.file))].sort()
    expect(
      files,
      '渲染链旧格式源的生产消费点集合已变 —— 该集合是接缝（乙）子句的机械口径，'
      + '改动必须同时更新本判据与 `seams.ts` 的登记',
    ).toEqual([
      'src/editors/workbench-rna.ts',
      'src/shared/viewport/useKernelChannels.ts',
      'src/shared/viewport/useViewportRuntime.ts',
    ])
  })

  it('**负对照**：`EmbedViewport.vue` 不得再消费该读面（C5 已把它的消费者改写为内核读面）', () => {
    expect(
      productionCallSites().filter((h) => h.file === 'src/shared/viewport/EmbedViewport.vue'),
      '该组件的 tooltip 入参必须来自内核读面（`documentMetadata()` / `kernelAnnotations()`）；'
      + '恢复 `ctx.legacyRenderSource()` 即判红',
    ).toEqual([])
  })

  it('**口径自检**：去字符串是承重的（登记表把调用形态写在字符串里）', () => {
    const raw = fs
      .readFileSync(path.join(SRC, 'composition', 'seams.ts'), 'utf8')
      .replace(/\r\n/g, '\n')
    // 反证①：原样（只去注释）时 `seams.ts` 会命中 ⇒ 说明"不去字符串"会把登记文字算成消费点。
    expect(
      /\.legacyRenderSource\s*\(/.test(stripComments(raw)),
      '前提：`seams.ts` 的**字符串**里确有该调用形态（故去字符串必须做）',
    ).toBe(true)
    // 反证②：去字符串后不得命中 ⇒ 它不是消费者。
    expect(
      /\.legacyRenderSource\s*\(/.test(stripStrings(stripComments(raw))),
      '去字符串后 `seams.ts` **不得**出现调用形态（它只是登记文字，不是消费者）',
    ).toBe(false)
  })
})
