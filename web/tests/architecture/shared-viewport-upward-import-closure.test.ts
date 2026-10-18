/**
 * **接缝 `shared-viewport-upward-imports-assembly-root` 核销的常驻判据**
 * （R1-β① C10 收口；E 区，本批）。
 *
 * ## 为什么核销了还要有常驻判据
 *
 * 核销把该条从 `composition/seams.ts` 的 `SEAMS` 里**删除**（表的语义是"双轨**剩余**数、
 * 只应减少"）—— 但删掉登记之后，**这张表就再也看不住它了**：一份被改回去的
 * `import { PresenterSession } from '@/composition/presenterSession'` 会静静地
 * 重新长出来，而没有任何判据会响。这与 `seams.test.ts` 对 P6 核销项的处理同形：
 * 登记在表里时由表看管，核销之后由**测试里的回归断言**看管。
 *
 * ## 判据的两条与负对照（都不是"看着像"，各自可判红）
 *
 * | 子句 | 判据 | 负对照 |
 * |---|---|---|
 * | 乙 该文件对 `@/composition/` 的**值导入 = 0** | 剥注释后按 import 声明计数 = 0 | 注入 1 条值导入 ⇒ 计数 1（有区分力）；注释里的同一句话 ⇒ 计数 0（口径不是裸 grep） |
 * | 甲 具名装配面 + 必填注入 | `Host#createViewportPresenter` 存在、两个生产调用方都经它接线、options 成员**非可选** | 把 `createPresenter:` 改成 `createPresenter?:` ⇒ 判据判红；消费者少接线 ⇒ 判据判红 |
 *
 * ## 口径（#387 评论 7486 一 / 7167）
 *
 * 把行注释与块注释**置换为空白**后，按
 * `^\s*import\s+(?!type\b)…from '@/composition/…'` 匹配 **import 声明**。
 * 字符串字面量**保留** —— 模块说明符本身就是字符串字面量，剥掉它就没有判据可言；
 * 也正因如此，本文件头注释里出现的 `@/composition/` 字样**必须**被剥掉后不计。
 *
 * **口径边界（如实登记）**：匹配只看**行首**（允许前导空格/制表符）的 `import` 声明，
 * 故"字符串字面量里**非行首**的 import 形态文本"不计（已配负对照）；而"**多行**字符串
 * 字面量里**行首**的 import 形态文本"会被计数 —— 那对本判据是**误报方向**（宁可严、
 * 不会漏报），且 `useViewportRuntime.ts` 里不存在这种文本。
 *
 * ## 不受本判据管的残余（如实登记，不假装已闭合）
 *
 * `useViewportRuntime.ts:15` 的 `import type { PresenterSession }`（type-only，1 条）**仍在**：
 * 它不进运行时依赖图，但**不是**永久保留项 —— 归属（能否注入形状 / type-only 是否计入值导入）
 * 由契约 v1.10 裁定（#387 评论 7489 一）。故本判据把它**逐字记下**当作已登记的残余：
 * 新增任何一条 `@/composition/` 导入（不管值还是类型）都会让第二条判据判红。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const WEB_ROOT = path.join(import.meta.dirname, '..', '..')
const SRC_ROOT = path.join(WEB_ROOT, 'src')

const SEAM_ID = 'shared-viewport-upward-imports-assembly-root'
/** 本条接缝唯一声明的文件（原 `SEAMS` 条目的 `files`）。 */
const TARGET_REL = 'src/shared/viewport/useViewportRuntime.ts'
/**
 * **生产调用方（M7-4 段 B 更新）**：合壳前是两份视口实现各接一次线
 * (`EmbedViewport.vue` + `WorkbenchViewport.vue`)；合壳后视口粘合只有一份
 * (`EditorViewportHost.vue`)，两个壳已不再直接消费 `useViewportRuntime`。
 *
 * 判据本身没有放宽：仍然是"**全部**生产调用方都必须经 `Host#createViewportPresenter`"。
 * 区别只是调用方集合从 2 变成 1 —— 若有人再加一处就地 `new PresenterSession`，
 * 它仍然要进这个清单才可能通过，而清单里只有这一处。
 */
const CONSUMERS = [
  'src/shared/viewport/EditorViewportHost.vue',
]

/** 读源码并**归一化行尾**（铁律 6：本仓 `core.autocrlf=true`，新鲜检出是 CRLF）。 */
function readNorm(rel: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}

/** 把注释置换为等长空白（**保留换行与字符串字面量**），避免说明文字被算成使用点。 */
function maskComments(src: string): string {
  const text = src.replace(/\r\n/g, '\n')
  let out = ''
  let i = 0
  let mode: 'code' | 'line' | 'block' | 'str' = 'code'
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; out += '  '; i += 2; continue }
      if (c === '/' && n === '*') { mode = 'block'; out += '  '; i += 2; continue }
      if (c === "'" || c === '"' || c === '`') { mode = 'str'; out += c; i++; continue }
      out += c; i++; continue
    }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c } else out += ' '; i++; continue }
    if (mode === 'block') {
      if (c === '*' && n === '/') { mode = 'code'; out += '  '; i += 2; continue }
      out += c === '\n' ? c : ' '; i++; continue
    }
    // mode === 'str'
    if (c === '\\') { out += c + (n ?? ''); i += 2; continue }
    out += c
    if (c === "'" || c === '"' || c === '`') mode = 'code'
    i++
  }
  return out
}

/** 值导入的 import 声明（`import type` 与 `import(` 都不匹配）。 */
const VALUE_IMPORT = /^[ \t]*import[ \t]+(?!type\b)([\s\S]*?)from[ \t]*['"]([^'"]+)['"]/gm
/** 全部 import 声明（含 `import type`）。 */
const ANY_IMPORT = /^[ \t]*import([\s\S]*?)from[ \t]*['"]([^'"]+)['"]/gm
/** 动态 `import('…')`（静态字符串字面量参数）。 */
const DYNAMIC_IMPORT = /import\([ \t]*['"]([^'"]+)['"]/g

function specifiersOf(src: string, re: RegExp): string[] {
  return [...maskComments(src).matchAll(re)].map((m) => m[2])
}

/** （乙）的核心判据：该文件对 `@/composition/` 的**值导入**集合。 */
function compositionValueImports(src: string): string[] {
  return specifiersOf(src, VALUE_IMPORT).filter((s) => s.startsWith('@/composition/'))
}

/** 含 `import type` 的**全部** `@/composition/` 导入（残余登记面）。 */
function allCompositionImports(src: string): string[] {
  return specifiersOf(src, ANY_IMPORT).filter((s) => s.startsWith('@/composition/'))
}

/** （甲）的判据：装配面存在、注入**必填**、两个生产调用方都接线。 */
function presenterInjectionIsMandatory(src: string): boolean {
  return (
    src.includes('createPresenter: (regionId: string) => ViewportPresenterBundle') &&
    !/\bcreatePresenter\s*\?:/.test(src)
  )
}

function consumersWirePresenter(): string[] {
  return CONSUMERS.filter((rel) => {
    const code = readNorm(rel)
    return code.includes('createPresenter:') && code.includes('createViewportPresenter(')
  })
}

describe('接缝核销判据 · `shared-viewport-upward-imports-assembly-root`（甲 + 乙）', () => {
  it('**反空洞真**：判据的对象在场（目标文件非空、装配面确实存在）', () => {
    const target = readNorm(TARGET_REL)
    expect(target.length, '目标文件必须存在且非空（否则下面的 0 是"没扫到"而不是"没有"）').toBeGreaterThan(2000)
    expect(target).toContain('useViewportRuntime')
    const host = readNorm('src/runtime/host.ts')
    expect(host, '`Host` 必须声明装配面方法').toContain(
      'createViewportPresenter(regionId: string): ViewportPresenterBundle',
    )
    expect(host, '包形状必须含创建与释放同源的 `dispose()`').toContain('dispose(): void')
  })

  it('**（乙）值导入 = 0**：`useViewportRuntime.ts` 不得再值导入 `@/composition/`', () => {
    const target = readNorm(TARGET_REL)
    expect(
      compositionValueImports(target),
      '值导入必须为 0（呈现会话/纹理端口/场景时间一律由装配边注入）',
    ).toEqual([])
    // 旁路也要计：动态 `import('@/composition/…')` 同样是一条向上值依赖
    const dynamic = [...maskComments(target).matchAll(DYNAMIC_IMPORT)]
      .map((m) => m[1])
      .filter((s) => s.startsWith('@/composition/'))
    expect(dynamic, '不得用动态 import 绕过本判据').toEqual([])
  })

  it('**残余逐字记下**：含 `import type` 的全量恰为 1 条（新增任何一条都判红）', () => {
    // 这不是"允许一条"，而是"残余已被登记、且此后只应减少"（#387 评论 7489 一）。
    expect(allCompositionImports(readNorm(TARGET_REL))).toEqual(['@/composition/presenterSession'])
  })

  it('**负对照（计数有区分力）**：注入值导入 ⇒ 判红；注释里的同一句话 ⇒ 不误判', () => {
    const target = readNorm(TARGET_REL)
    const injected = target.replace(
      /^([ \t]*import[\s\S]*?\n)/m,
      "$1import { seamProbeSymbol } from '@/composition/kernelAssembly'\n",
    )
    expect(compositionValueImports(injected), '注入 1 条值导入必须被计数').toHaveLength(1)
    expect(injected === target, '注入必须真的改了文本（否则本负对照是空转）').toBe(false)

    // 口径自检：**注释里**的同一句话不得被算成使用点（本文件头就有这种文字）
    const commented = "// import { seamProbeSymbol } from '@/composition/kernelAssembly'\n"
    expect(compositionValueImports(commented), '注释必须被剥掉').toEqual([])
    // 口径加固（#387 裁决一）：**字符串字面量里**的假导入（**非行首**）不得被算成使用点
    // —— 证明"保留字符串字面量"没有把假导入算进来（行首锚点在此把守）。
    const inString = `const s = "import { seamProbeSymbol } from '@/composition/kernelAssembly'"`
    expect(compositionValueImports(inString), '字符串字面量里的假导入不得计数').toEqual([])

    // 而同一句话在注释外必须被计数（证明上面那条不是"剥得太狠"）
    expect(compositionValueImports("import { seamProbeSymbol } from '@/composition/kernelAssembly'\n"))
      .toEqual(['@/composition/kernelAssembly'])
  })

  it('**（甲）必填注入**：`createPresenter` 非可选，省略即类型错误（无退回就地构造的旁路）', () => {
    const target = readNorm(TARGET_REL)
    expect(presenterInjectionIsMandatory(target), '`createPresenter` 必须是必填成员').toBe(true)
    // 负对照：改回可选（＝"省略参数就悄悄退回就地构造"的那条旁路）⇒ 判据必须判红
    const downgraded = target.replace('createPresenter: (regionId: string)', 'createPresenter?: (regionId: string)')
    expect(downgraded === target, '负对照必须真的改了文本').toBe(false)
    expect(presenterInjectionIsMandatory(downgraded), '可选成员必须被同一条判据抓到').toBe(false)
  })

  it('**（甲）生产接线**：两个生产调用方都经 `Host#createViewportPresenter` 提供', () => {
    expect(consumersWirePresenter(), '两个生产宿主都必须接线（否则视口退回就地构造）').toEqual(CONSUMERS)
  })

  it('**登记表口径**：本 id 不得再占用 `SEAMS`（表 = 双轨剩余数，只应减少）', async () => {
    const mod = await import(path.join(SRC_ROOT, 'composition', 'seams.ts').replace(/\\/g, '/'))
    const seams = mod.SEAMS as ReadonlyArray<{ id: string }>
    expect(seams.length, '反空洞真：核销不能让表变空').toBeGreaterThan(0)
    expect(
      seams.some((s) => s.id === SEAM_ID),
      '本接缝已核销（两个子句同时成立）⇒ 不得留在表里，否则是空转登记',
    ).toBe(false)
    // 表本身仍然在册（证明上面的断言查的是真表，不是空数组）
    expect(seams.some((s) => s.id === 'legacy-render-source-document')).toBe(true)
    expect(mod.seamById(SEAM_ID), '`seamById` 也必须查不到它').toBeUndefined()
  })
})
