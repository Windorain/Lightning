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
 * ## 迁移进度（**分阶段读数**，不是完成句）
 *
 * | 阶段 | 生产消费点 |
 * |---|---|
 * | C5 之前 | **4**：`useViewportRuntime`(docRef 回落) · `useKernelChannels`(decl 源) · `EmbedViewport.vue`(tooltip 入参) · `workbench-rna.ts`(多方块生成态判定) |
 * | C5 段③（本段） | **1**：`useKernelChannels` —— 其余三处已改写：`EmbedViewport.vue` 改吃内核读面（元数据 + 注解行）；`useViewportRuntime` 的 `docOverride` 改为**必填** `renderDocRef`（回落删除）；`workbench-rna.ts` 的生成态判定改走 `Context#kernelWriteAuthority`（内核写权事实，见 `kernelWriteAuthorityFace.test.ts`） |
 *
 * ⚠️ **剩余 1 处的性质不同**（诚实登记）：`useKernelChannels` 需要**多方块声明的内层 body**
 * 来做「按当前通道取值重新装配」与「构造渲染视图文档」，而该 body 今天由旧文档承载
 * （`composition/kernelAssembly#assembleKernelDocument` 自己就吃 `RuntimeDocument`）
 * ⇒ 不是"渲染源回落"，而是**内核承载缺口**（最后一条断言把它钉成可判定事实）。
 * 删除 `Context#legacyRenderSource()` 本体**必须等它迁移完成**。
 *
 * ## 区分力（负对照）
 *
 * 第 2 条断言抓"已迁的那两处又长回来"（实测：把 `ctx.legacyRenderSource()` 加回
 * `EmbedViewport.vue` ⇒ 判红）。只证明"新路径能用"的判据抓不住"留了旁路"，
 * 故这里锁的是**消费者集合**本身。
 *
 * ## 口径的诚实边界
 *
 * 字符串剥离是**正则近似**：模板串里的 `${…}` 嵌套引号、以及正则字面量里的引号
 * 会让剥离结果偏离真实解析。本判据据此**不**声称"覆盖一切写法"，只声称
 * "在真实消费者都用 `ctx.legacyRenderSource()` 的成员调用形态下，集合被钉住"。
 * 第 3 条自检把这条边界**显式化**（证明去字符串确实承重、不是装饰）。
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
  it('生产消费点 = **1**，且**恰好**是这一处（新增一处即判红）', () => {
    const files = [...new Set(productionCallSites().map((h) => h.file))].sort()
    expect(
      files,
      '渲染链旧格式源的生产消费点集合已变 —— 该集合是接缝（乙）子句的机械口径，'
      + '改动必须同时更新本判据与 `seams.ts` 的登记',
    ).toEqual([
      'src/shared/viewport/useKernelChannels.ts',
    ])
  })

  it('**负对照**：已迁的三处不得再消费该读面（迁完又长回来即判红）', () => {
    const migrated = [
      'src/shared/viewport/EmbedViewport.vue',
      'src/shared/viewport/useViewportRuntime.ts',
      'src/editors/workbench-rna.ts',
    ]
    expect(
      productionCallSites().filter((h) => migrated.includes(h.file)),
      '`EmbedViewport.vue` 的 tooltip 入参必须来自内核读面（`documentMetadata()`/`kernelAnnotations()`）；'
      + '`useViewportRuntime` 的渲染源必须是**必填注入** `renderDocRef`（无回落）；'
      + '`workbench-rna.ts` 的生成态判定必须走内核写权读面 `kernelWriteAuthority`。恢复任一处即判红',
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

  it('**前置缺口登记**：内核 `DocumentContent` 不承载多方块声明 ⇒ 剩余 2 处的删除条件', () => {
    const content = fs
      .readFileSync(path.join(SRC, 'domain', 'content.ts'), 'utf8')
      .replace(/\r\n/g, '\n')
    // 反证式断言：只要 `DocumentContent` 还没有具名 `multiblock` 字段，
    // 剩余两处消费者**不可能**在不新建回落的前提下迁移。它把"缺口"钉成可判定事实。
    expect(
      /^\s*readonly multiblock\b/m.test(content),
      'DONE 信号：一旦 `DocumentContent` 承载多方块声明（具名 `multiblock` 字段），'
      + '本断言翻红即为"剩余 2 处可以迁了"的信号 —— 届时一并改写 '
      + '`useKernelChannels.ts` / `workbench-rna.ts`，把第 1 条断言改成 `toEqual([])`，'
      + '再删除 `Context#legacyRenderSource()` 本体',
    ).toBe(false)
  })
})
