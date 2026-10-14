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
 * | C5 段③ | **1**：`useKernelChannels` —— 其余三处已改写 |
 * | **R2/S3（本批）** | **0** —— 最后 1 处（`useKernelChannels`）改吃内核读面（声明 ← `Context#kernelMultiblockDeclaration`；body ← `Context#kernelMultiblockBody`；渲染投影 ← `kernelRenderViewFromFace`），随后**删除 `Context#legacyRenderSource()` 本体** |
 *
 * ⚠️ **口径扩展（R2/S3；Lead 裁决 ④）**：本文件此前的扫描范围只有 `src/`（排除 `__tests__/`），
 * 而 `e2e/` **不在 L0 的射程内**（不在 tsconfig include、vitest 不载）⇒ 一处留在 `e2e/` 的调用
 * 会让 L0/L1 全绿、只有 L2/L3 运行期炸。本批实测正是如此：
 * `e2e/helpers/multiblock/harness.ts:348,578` 两处当时不被任何判据看见。
 * ⇒ 现在**两条**判据：生产 = 0（原口径）+ **全仓 = 0**（`src` + `e2e` + `tests` + `scripts`），
 * 且各自带负对照（含"往 e2e 真实文件文本里注入一处 ⇒ 必红"）。
 *
 * 可推广的纪律：**"删除/退役"类判据的扫描范围必须覆盖 L0 看不见的目录**，
 * 否则"删干净了"这个结论本身建立在盲区上。
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

/** 递归收集 `dir` 下的 `.ts` / `.tsx` / `.mts` / `.vue`。 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sourceFiles(p, out)
    else if (e.isFile() && /\.(ts|tsx|mts|vue)$/.test(e.name)) out.push(p)
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

/**
 * **全仓**扫描根（R2/S3 扩展；Lead 裁决 ④：删除/退役类判据必须覆盖 **L0 看不见**的目录）。
 *
 * 为什么必须有这一条：`e2e/` **不在** `tsconfig.json` 的 `include` 里（`vue-tsc` 不查）、
 * vitest 只载 `src/**` ⇒ 一处 `ctx.legacyRenderSource()` 留在 `e2e/` 里，
 * L0/L1 全绿，只有 L2/L3 在**运行期**炸 `TypeError: ... is not a function`。
 * 本批实测就撞上了：`e2e/helpers/multiblock/harness.ts:348,578` 两处（当时不在任何判据的射程内）。
 */
const REPO_ROOTS = ['src', 'e2e', 'tests', 'scripts']

/** 单段文本里的调用点行号（与生产口径同一把尺子：先剥注释再剥字符串）。 */
function linesWithCall(text: string): number[] {
  const code = stripStrings(stripComments(text.replace(/\r\n/g, '\n')))
  return code.split('\n').flatMap((line, i) => (/\.legacyRenderSource\s*\(/.test(line) ? [i + 1] : []))
}

/** 全仓扫描到的文件清单（反空洞真用：必须真的含 `e2e/` 下的文件）。 */
function scannedRepoFiles(): string[] {
  return REPO_ROOTS.flatMap((root) => {
    const abs = path.join(process.cwd(), root)
    if (!fs.existsSync(abs)) return []
    return sourceFiles(abs).map((f) => path.relative(process.cwd(), f).replace(/\\/g, '/'))
  })
}

/** **全仓**（含 `src/` 测试、`e2e/`、`tests/`、`scripts/`）的调用点。 */
function allCallSites(): { file: string; line: number }[] {
  const hits: { file: string; line: number }[] = []
  for (const rel of scannedRepoFiles()) {
    const text = fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
    for (const line of linesWithCall(text)) hits.push({ file: rel, line })
  }
  return hits
}

/**
 * `domain/content.ts` 的源码文本（**CRLF 归一化**后；AGENTS.md 铁律 6：本仓新鲜检出是 CRLF）。
 */
function readContentSource(): string {
  return fs.readFileSync(path.join(SRC, 'domain', 'content.ts'), 'utf8').replace(/\r\n/g, '\n')
}

/**
 * **G1 的 DONE 判据本体**：`domain/content.ts` 是否具名承载多方块声明。
 *
 * 为什么抽成函数：负对照与正判据必须用**同一个判据**。两处各写一份正则，
 * 负对照验的就是"另一个判据"，它红了也不能说明本判据有区分力
 * （本项目已有"判据换了形态后负对照验的是旧形态"的教训）。
 *
 * 四条子判据各自对应一种**会被静默违反**的退化形态：
 *
 *  1. `readonly multiblock: MultiblockDeclaration` —— 字段在且**类型是复用来的承载**
 *     （退化形态：字段缺失，或写成 `unknown`/`Record<string, unknown>` 字段袋）；
 *  2. 从 `./multiblockDocument` 具名导入 —— 形状复用同一契约
 *     （退化形态：在 `content.ts` 里另立一份形状 ⇒ 出现第二套判据）；
 *  3. `EMPTY_CONTENT` 里**显式填**空值 （退化形态：字段可选、空值靠 `undefined` 冒充「无」）；
 *  4. `documentContent()` 的缺省也是**同一个常量**
 *     （退化形态：缺省写第二份"空对象" ⇒ 同一语义两条构造路径得到两种摘要）。
 */
function contentCarriesMultiblock(text: string): boolean {
  const declared = /^[ \t]*readonly multiblock: MultiblockDeclaration\b/m.test(text)
  const imported =
    /import \{[^}]*\bMultiblockDeclaration\b[^}]*\} from '\.\/multiblockDocument'/.test(text)
  const emptyFilled =
    /export const EMPTY_CONTENT: DocumentContent = Object\.freeze\(\{[\s\S]*?\bmultiblock: EMPTY_MULTIBLOCK_DECLARATION\b/.test(text)
  const defaulted =
    /export function documentContent\([\s\S]*?\bmultiblock: init\.multiblock \?\? EMPTY_MULTIBLOCK_DECLARATION\b/.test(text)
  return declared && imported && emptyFilled && defaulted
}

describe('R1-β① C5 · `Context#legacyRenderSource()` 的生产消费点计数（接缝 `legacy-render-source-document`）', () => {
  it('生产消费点 = **0**（接缝（乙）子句达成：消费者迁移数 = 0）', () => {
    const files = [...new Set(productionCallSites().map((h) => h.file))].sort()
    expect(
      files,
      'R2/S3 已把最后一个生产消费点（`src/shared/viewport/useKernelChannels.ts`）改吃内核读面 '
      + '⇒ 生产集合必须为空。**新增一处即判红**（那是把读面又请回来的形态）',
    ).toEqual([])
  })

  it('**全仓**消费点 = 0（含 `src/` 测试、`e2e/`、`tests/`、`scripts/` —— L0 看不见的目录也在内）', () => {
    // 反空洞真：扫描面必须真的含 `e2e/` 下的文件，否则"0"只是"没扫到"。
    const scanned = scannedRepoFiles()
    expect(scanned.some((f) => f.startsWith('e2e/')), '扫描面必须含 `e2e/**`（L0 的盲区）').toBe(true)
    expect(scanned.some((f) => f.startsWith('src/')), '扫描面必须含 `src/**`').toBe(true)
    expect(
      allCallSites().map((h) => `${h.file}:${h.line}`),
      '全仓不得再有该读面的调用（含 `e2e/` 与 `src/` 测试）—— 它已终删',
    ).toEqual([])
  })

  it('**负对照（L0 盲区）**：往 `e2e/` 的真实文件文本里注入一处调用 ⇒ 全仓判据必须判红', () => {
    // 与扫描口径**同一把尺子**（逐文件 → 剥注释 → 剥字符串 → 逐行匹配）作用在真实 e2e 文本上：
    // 注入后必须被计数（证明 e2e 真在射程内），而注释/字符串里的同一句话不得计入。
    const target = scannedRepoFiles().find((f) => f.startsWith('e2e/'))
    expect(target, '前提：扫描面里必须有一个 `e2e/` 文件可供注入').toBeTruthy()
    const text = fs.readFileSync(path.join(process.cwd(), target!), 'utf8').replace(/\r\n/g, '\n')
    expect(linesWithCall(text), '前提：该 e2e 文件此刻**不含**该调用（否则负对照无对象）').toEqual([])
    expect(
      linesWithCall(text + '\nconst probe = ctx.legacyRenderSource()\n'),
      '注入一处调用必须被计数（区分力）',
    ).toHaveLength(1)
    expect(linesWithCall('// ctx.legacyRenderSource() 是旧读面\n'), '注释不计').toEqual([])
    expect(linesWithCall('const note = "ctx.legacyRenderSource() 是旧读面"\n'), '字符串不计').toEqual([])
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

  it('**口径自检**：去字符串是承重的（调用形态可以被写在字符串里，那不是消费点）', () => {
    // 自检用**扫描器自己的输入形态**（不是产品载荷）：把调用形态分别放在
    // ① 代码位置、② 字符串位置，证明两者在扫描口径下**必须区分**。
    // 为什么要显式自检：C5 早期版本只去注释 ⇒ `composition/seams.ts` 的**登记文字**
    // （字符串里写着调用形态）被算成第 5 个消费点，计数从 4 变 5 —— 命中数不是结论。
    const inCode = 'const d = ctx.legacyRenderSource()'
    const inString = 'const note = "ctx.legacyRenderSource() 是旧读面"'
    expect(/\.legacyRenderSource\s*\(/.test(stripComments(inCode)), '代码位置的调用必须被认作消费点').toBe(true)
    expect(
      /\.legacyRenderSource\s*\(/.test(stripComments(inString)),
      '前提：不去字符串时该字符串会命中（故去字符串必须做）',
    ).toBe(true)
    expect(
      /\.legacyRenderSource\s*\(/.test(stripStrings(stripComments(inString))),
      '去字符串后**不得**命中（它是登记文字，不是消费者）',
    ).toBe(false)
    // 反空洞真：登记表本身仍在案（否则"剩余 1 处归 R2"这条登记会被静默删掉）。
    const seams = fs.readFileSync(path.join(SRC, 'composition', 'seams.ts'), 'utf8').replace(/\r\n/g, '\n')
    expect(seams.includes('legacy-render-source-document'), '登记条目必须仍在案').toBe(true)
    expect(
      /\.legacyRenderSource\s*\(/.test(stripStrings(stripComments(seams))),
      '登记表里**不得**出现调用形态（它只是文字）',
    ).toBe(false)
  })

  it('**DONE 信号**：内核 `DocumentContent` 已具名承载多方块声明（S3 的删除条件已满足并已执行）', () => {
    expect(
      contentCarriesMultiblock(readContentSource()),
      'DONE 信号 = 内核 `DocumentContent` 具名承载多方块声明（`useKernelChannels` 的迁移阻塞项已清）。'
      + 'R2/S3 已执行其后续步骤：改吃内核读面 → 全仓消费者集合 = 0（含 `e2e/`）→ 删除读面本体。'
      + '若本信号翻红（承载字段被删/被换成字段袋），则上面那些"消费者为 0"的判据失去前提',
    ).toBe(true)
  })

  it('**负对照**：删掉该承载字段 ⇒ 上一条判据必须判红（证明它有区分力，不是恒真）', () => {
    const source = readContentSource()
    // 注入 ①：删掉 `DocumentContent` 上的具名字段（正是"缺口复现"的形态）。
    const fieldRemoved = source.replace(/^[ \t]*readonly multiblock: MultiblockDeclaration[ \t]*$/m, '')
    // 注入的前提是"生产里有东西可删"。若生产**本来**就没有该承载（缺口态），上一条正断言
    // 已经判红 —— 此时负对照**无对象**，必须显式说出这一点，不得伪装成"验过了"。
    if (fieldRemoved === source) {
      throw new Error(
        '前置条件不成立：生产文本里已无 `readonly multiblock: MultiblockDeclaration` ⇒ '
        + '上一条 DONE 信号正断言已判红，本负对照无对象（不得据此认为判据有区分力）',
      )
    }
    expect(contentCarriesMultiblock(fieldRemoved), '删掉承载字段后必须判红').toBe(false)

    // 注入 ②：字段仍在，但缺省值改回裸 `init.multiblock`（即允许 `undefined` 冒充「无」）
    // ⇒ 同一语义会出现两种摘要。只验"字段存在"的判据抓不住这一形态。
    const undefinedLeak = source.replace(
      /multiblock: init\.multiblock \?\? EMPTY_MULTIBLOCK_DECLARATION/,
      'multiblock: init.multiblock',
    )
    expect(undefinedLeak, '前提：第二处注入必须真的改动了生产文本（缺省值形态变了）').not.toBe(source)
    expect(contentCarriesMultiblock(undefinedLeak), '缺省值允许 `undefined` 后必须判红').toBe(false)
  })
})
