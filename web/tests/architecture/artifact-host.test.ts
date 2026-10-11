/**
 * **A34 `artifact-host` 架构级闸门**（#260 / #249 §19.8；#253 P9 职责面的架构半边）。
 *
 * ## 为什么需要它，且为什么它**不**改 `boundary-rules.mjs`
 *
 * `boundary-rules.mjs` 的 `GATE_RULES` 判的是"新层内部的导入形状"（不得 vue/three/DOM、
 * 不得 barrel 偷渡、跨层须经公共出口）。本文件判的是一条它**判不了**的判据：
 *
 * > **构建产物的模块可达性** —— 某个 profile 的入口在**静态 import 图**上
 * > 到底能到达哪些模块。
 *
 * 这条判据是 A15「查看器裁剪」与 A34「各 profile 产物」的共同落点：
 * #249 A15 的负对照原文是「**只隐藏按钮仍导入编辑模块**」—— 它的可静态判定形式
 * 正是"入口的模块闭包**不含**某族模块"。
 *
 * Lead 裁决：**不碰 `GATE_RULES` 本体**。本文件与
 * `kernel-legacy-isolation.test.ts` / `presentation-purity.test.ts` 并列，
 * 由 `npm run test:arch` 的 include（`tests/architecture/**\/*.test.ts`）自动纳入，
 * **无需改动任何共享配置文件**。
 *
 * ## 本文件与单测的分工
 *
 * | 文件 | 判什么 |
 * |---|---|
 * | `src/adapters/host/__tests__/artifactTransport.test.ts` | 补丁的**字节级**行为与往返（真实产物片段 + 真实 JSZip） |
 * | `src/adapters/host/__tests__/hostCapabilities.test.ts` | 能力矩阵与启动/销毁**判定逻辑** |
 * | **本文件** | **真实构建产物**的路径/字体/ZIP 证据 + **静态模块可达性** + 本树证据登记 |
 *
 * ## 覆盖的 A34 判据（逐条）
 *
 * 1. 「资源路径」⇒ {@link describe} `A34 真实产物：资源基址与路径`
 * 2. 「字体资源」⇒ 同节：产物里的 woff2 **内容**与其源文件逐字节相同（不是"有引用"而已）
 * 3. 「ZIP 生成/读取的字节与行为证据」⇒ `A34 真实产物：ZIP 字节`
 * 4. 「缺能力有明确诊断」⇒ `A34 缺能力诊断`
 * 5. 「构建适配有前后字节与行为证据」⇒ `A34 构建适配前后字节`
 *
 * ## 铁律 6（CRLF）
 *
 * 凡读源码/产物做字节或正则断言的入口，都走 {@link readSource}/{@link readBytes}
 * 并在文本入口归一化行尾（本仓 `core.autocrlf=true`）。
 * **产物字节**不做行尾归一（那会改变被测对象）—— 见 {@link readBytes} 的说明。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SRC_ROOT, WEB_ROOT, buildModuleGraph } from './module-graph.mjs'

// ─────────────────────────────────────────────────────────────────────────────
// 读入口（铁律 6）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 读源码文本并**归一化行尾为 LF**（铁律 6）。
 *
 * 本仓 `core.autocrlf=true` ⇒ 新鲜检出是 CRLF、执行者工具写出的工作树常是 LF。
 * 凡断言里用裸 `\n` 字面量（正则、`indexOf('\n\n')`、按行切片），判据就会随检出
 * 口径变化。在唯一读入口归一化后，"用 `\n` 写字面量"重新安全。
 */
function readSource(absPath: string): string {
  return fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n')
}

/**
 * 读**产物**字节（**不**归一化行尾）。
 *
 * 与 {@link readSource} 的关键区别：产物字节是**被测对象本身**。
 * 对它做行尾归一等于"先修改证物再化验"—— 那会让"ZIP 头是不是 50 4B 03 04"
 * 这类字节级断言失去意义（例如产物里真有 `0D 0A` 时会被抹掉）。
 * ⇒ 产物走字节入口，源码走文本入口，两者**不得混用**。
 */
function readBytes(absPath: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(absPath))
}

/** 字节 → 小写 hex。 */
function hexOf(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

/** 字节 → latin1 文本（产物含真实控制字节 ⇒ latin1 是唯一安全口径，T-01）。 */
function bytesToLatin1(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return s
}

/** 从 `web/src` 下取一族的文件（相对路径、正斜杠、稳定排序）。 */
function filesUnder(rel: string, filter: (f: string) => boolean): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (filter(p)) out.push(path.relative(SRC_ROOT, p).replace(/[\\/]+/g, '/'))
    }
  }
  walk(path.join(SRC_ROOT, rel))
  return out.sort()
}

// ─────────────────────────────────────────────────────────────────────────────
// 本批新增的适配器路径（与父执行者的登记表同源）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 本批（P9 #260）新增的 `adapters/host` 实现文件。
 *
 * **不改 `boundary-rules.mjs`**（Lead 裁决）：路径登记由父执行者统一做。
 * 本常量只用于本文件的断言，并把"本批交付面"变成可核对的事实
 * （每一条都必须真实存在 —— 防"登记了不存在的文件"）。
 */
const P9_HOST_ADAPTER_FILES = [
  'adapters/host/hostCapabilities.ts',
  'adapters/host/artifactTransport.ts',
  'adapters/host/buildManifest.ts',
]

/** 本批的测试文件（同样必须存在，否则"已覆盖"是空话）。 */
const P9_HOST_TEST_FILES = [
  'adapters/host/__tests__/hostCapabilities.test.ts',
  'adapters/host/__tests__/artifactTransport.test.ts',
  'adapters/host/__tests__/buildManifest.test.ts',
]

// ─────────────────────────────────────────────────────────────────────────────
// 一、模块可达性（A15 静态面 + A34「各 profile 产物」）
// ─────────────────────────────────────────────────────────────────────────────

describe('A34 模块可达性：profile 入口的静态 import 闭包（A15 负对照的静态面）', () => {
  /**
   * 从某入口出发的**静态** import 闭包（相对 `src/` 的路径，无扩展名）。
   *
   * 实现：在 `buildModuleGraph()` 的导入事实上做 BFS，只走**可静态解析**的
   * 内部目标（`dynamic-import` 里参数不可解析的那些**不**计入 —— 本函数的诚实边界：
   * 它证明的是"静态可达性"，动态导入的能力隔离由运行时拒绝承担，见契约 §3.2）。
   *
   * ## 两个必须说清的实现细节（都是实测踩到的）
   *
   * 1. **键的形态**：`facts[].fromRel` 是**相对 `web/`** 的（`src/main.ts`），
   *    而 `specifier` 是相对 `fromFile` 的。初版把 BFS 的起点按 `src/` 相对写、
   *    键却按 `fromRel` 原样建 ⇒ 只走到起点一个节点（闭包大小 = 1）。
   *    ⇒ 统一用 `path.relative(SRC_ROOT, fromFile)` 作键，两侧口径一致。
   * 2. **目录形式的目标**（`./export` → `export/index.ts`）与 `.vue`：
   *    队列里同时压入 `<rel>` 与 `<rel>/index`，由"命中才展开"自然处理。
   */
  function importClosure(entryRel: string): { readonly reached: ReadonlySet<string>; readonly specs: readonly string[] } {
    const { facts } = buildModuleGraph()
    const norm = (p: string): string => p.replace(/\.(ts|tsx|mts|vue|js)$/, '')
    const srcRel = (abs: string): string => norm(path.relative(SRC_ROOT, abs).replace(/[\\/]+/g, '/'))

    const byFrom = new Map<string, Array<{ specifier: string }>>()
    for (const f of facts) {
      const key = srcRel(f.fromFile as string)
      const list = byFrom.get(key)
      if (list === undefined) byFrom.set(key, [{ specifier: f.specifier as string }])
      else list.push({ specifier: f.specifier as string })
    }

    const reached = new Set<string>()
    const specs: string[] = []
    const seen = new Set<string>()
    const queue = [norm(entryRel)]
    while (queue.length > 0) {
      const cur = queue.shift() as string
      if (seen.has(cur)) continue
      seen.add(cur)
      reached.add(cur)
      for (const f of byFrom.get(cur) ?? []) {
        const spec = f.specifier
        if (spec.startsWith('«')) continue // 不可静态解析的动态导入
        specs.push(spec)
        if (!spec.startsWith('.') && !spec.startsWith('@/')) continue
        const abs = spec.startsWith('@/')
          ? path.join(SRC_ROOT, spec.slice(2))
          : path.resolve(path.dirname(path.join(SRC_ROOT, cur)), spec)
        const rel = srcRel(abs)
        if (rel.startsWith('..')) continue
        queue.push(rel)
        queue.push(`${rel}/index`)
      }
    }
    return { reached, specs }
  }

  it('反空洞真：embed 入口的闭包**确实**非空且有真实内部导入（否则下面的"不含"是空转）', () => {
    const { reached } = importClosure('main.ts')
    expect(reached.size, 'embed 入口闭包必须有内容').toBeGreaterThan(20)
    expect([...reached].some((r) => r.startsWith('shared/') || r.startsWith('embed/') || r.startsWith('render/'))).toBe(true)
  })

  it('**T-06 主判据**：embed 入口（`main.ts`）闭包**不含**任何 import `jszip` 的模块', () => {
    const { reached } = importClosure('main.ts')
    // 找出源码里 import jszip 的模块（相对 src，无扩展名）。
    const jszipImporters = new Set<string>()
    for (const rel of filesUnder('.', (f) => /\.(ts|tsx|vue)$/.test(f))) {
      const text = readSource(path.join(SRC_ROOT, rel))
      if (/from\s+['"]jszip['"]/.test(text) || /require\(['"]jszip['"]\)/.test(text)) {
        jszipImporters.add(rel.replace(/\.(ts|tsx|mts|vue)$/, ''))
      }
    }
    // 前置：树里**确实**有 import jszip 的模块（否则"embed 不含"是空洞真）。
    expect(jszipImporters.size, '本树必须存在 import jszip 的模块（否则判据空转）').toBeGreaterThan(0)
    expect([...jszipImporters]).toContain('workbench/export/bundleMeshAssembly')

    const leaked = [...reached].filter((r) => jszipImporters.has(r))
    expect(
      leaked,
      'embed 产物的入口闭包含 import jszip 的模块 ⇒ 产物会带 ZIP 签名字节，' +
        `而 embed 的构建没有 JSZip 补丁（B1 T-06）。要么给 embed 加补丁，要么让导出能力只由 wiki-workbench 承担。泄漏：\n${leaked.join('\n')}`,
    ).toEqual([])
  })

  it('**负对照**：wiki-workbench 入口闭包**确实**含 jszip 模块（证明上一条的判据不是恒绿）', () => {
    // wiki-workbench 的构建入口是 `main-wiki-workbench.ts`，但它的构建产物含全套工作台
    // （A34 实测 1205309 B 的 bundle 里有 6 个签名）—— 这正是"有补丁的那个 profile"。
    const { reached } = importClosure('main-wiki-workbench.ts')
    const jszipImporters = [...reached].filter((r) => r === 'workbench/export/bundleMeshAssembly')
    expect(
      jszipImporters.length,
      'wiki-workbench 入口闭包必须真的含 jszip 消费方 —— 否则"它需要补丁"这件事无从谈起',
    ).toBeGreaterThan(0)
  })

  it('embed 入口闭包**确实**含 jszip 消费方？—— **否**，且这条事实是 T-06 的静态半边', () => {
    // 与下一条（wiki-workbench 的正对照）配对：同一个判据，两种 profile，结论相反。
    const { reached } = importClosure('main.ts')
    expect(reached.has('workbench/export/bundleMeshAssembly'), 'embed 不得可达 jszip 消费方').toBe(false)
  })

  it('**A15 遗留接缝（如实登记，非本批交付）**：embed 入口闭包经 `EmbedViewport` 可达 `runtime/context` / `runtime/renderEngine`', () => {
    // ## 为什么这条断言写的是"**可达**"而不是"不可达"
    //
    // A15 的负对照原文是「只隐藏按钮仍导入编辑模块」。按**最严读法**，
    // embed 的闭包不该含任何编辑/运行实例实现。**实测事实是它含**：
    //
    //   main → shared/viewport/EmbedViewport → runtime/context
    //   main → shared/viewport/EmbedViewport → runtime/renderEngine
    //
    // 这是 #249 §17 抽查点里就已存在的旧结构（`EmbedViewport` 是旧 `shared/` 层的组件，
    // 它同时承担呈现与运行时接线）。**本批（P9 #260）不拥有这些文件**：
    // 按 `boundary-rules.mjs` 的 `RETIREMENT_OWNERS`，`shared/viewport/*` 的退出归
    // **P6（#257，工作区/Area 生命周期）** 与 **P10（#261，集成闭环）**。
    //
    // ⇒ 本批的处置是**把事实登记成可核对的断言**（而不是假装它不存在、
    //    或写一条注定判红的断言把闸门搞坏）：
    //    - 事实被钉住：一旦有人**扩大**这个接缝（例如让 embed 再拉进 `operators/builtin/exportOperators`），
    //      下面的"不得超过当前集合"断言立刻判红；
    //    - 一旦 P6/P10 把它**收窄**，下面的"必须仍存在"断言也会判红 —— 逼它们同批更新本登记
    //      （与 `presentation-purity.test.ts` 的 RAF 双向登记同一手法）。
    //
    // 这一步的意义：把"未登记的不对称"变成"有守卫的、有归属的已知接缝"。
    const { reached } = importClosure('main.ts')
    const KNOWN_EMBED_RUNTIME_SEAM = ['runtime/context', 'runtime/renderEngine']
    for (const t of KNOWN_EMBED_RUNTIME_SEAM) {
      expect(
        reached.has(t),
        `${t} 已不再被 embed 闭包可达 —— 说明 P6/P10 收窄了接缝，请同批核销本登记（它现在是过期登记）`,
      ).toBe(true)
    }
    // **不得扩大**：embed 闭包里不允许出现导出/内容编辑的具体实现。
    const MUST_NOT_LEAK = [
      'operators/builtin/exportOperators',
      'operators/builtin/annotationOperators',
      'handlers/documentHandler',
      'workbench/components/ExportWorkspace',
      'workbench/WorkbenchRoot',
    ]
    const leaked = MUST_NOT_LEAK.filter((p) => reached.has(p))
    expect(
      leaked,
      `embed 闭包新增了内容编辑/导出实现（A15 负对照的扩大形态）:\n${leaked.join('\n')}`,
    ).toEqual([])
  })

  it('**负对照**：wiki-workbench 入口闭包**确实**含 jszip 模块（证明上一条的判据不是恒绿）', () => {
    // wiki-workbench 的构建入口是 `main-wiki-workbench.ts`，它的产物含全套工作台
    // （A34 实测 1205309 B 的 bundle 里有 6 个签名）—— 这正是"有补丁的那个 profile"。
    const { reached } = importClosure('main-wiki-workbench.ts')
    expect(
      reached.has('workbench/export/bundleMeshAssembly'),
      'wiki-workbench 入口闭包必须真的含 jszip 消费方 —— 否则"它需要补丁"这件事无从谈起',
    ).toBe(true)
    // 同理，它也含导出操作符与导出面板（这是"工作台"应有之义）。
    expect(reached.has('operators/builtin/exportOperators')).toBe(true)
    expect(reached.has('workbench/components/ExportWorkspace')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 二、真实构建产物的路径与字体证据
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 产物根目录（**可选**）。
 *
 * A34 的验收要求使用"实际发布产物"。但在**冷树/CI** 上 `dist*` 目录不存在
 * （`.gitignore` 三条规则，B1 B-11），而本批纪律**禁止**跑完整 `npm run build:*`
 * （共享瓶颈文件不可改）与在仓内留产物。
 *
 * ⇒ 本文件对产物的断言是**条件式**的：产物存在 ⇒ 全量断言；
 * 产物不存在 ⇒ 断言**降级为已登记的缺口**（并打印缺失路径），
 * **不**把它写成"通过"（#251「未实现的测试名称不得报告通过」）。
 *
 * 证据缺口由 `temp/p09/a34-artifact-host-evidence.md` 里的真实构建补足
 * （该文件记录了 3 次 `npx vite build` 到 temp 的原始输出与字节证据）。
 */
const ARTIFACT_ROOT = process.env.LIGHTNING_P09_ARTIFACT_ROOT ?? path.join(WEB_ROOT, 'dist-wiki-workbench')

/** 期望存在的产物文件（相对产物根/`web/`）。 */
const EXPECTED_ARTIFACTS = [
  { rel: 'bundled/StructureWorkbench.bundle.js', root: 'wiki' },
  { rel: 'bundled/StructureWorkbench.css', root: 'wiki' },
]

describe('A34 真实产物：资源基址与路径（B1 B-05/B-07）', () => {
  const hasArtifacts = fs.existsSync(ARTIFACT_ROOT)

  it(`产物目录存在性被**显式披露**（当前：${hasArtifacts ? '存在' : '（缺口，见证据文件）'}）`, () => {
    // 这条断言的作用是**披露**而不是要求：冷树上没有产物是正常事实（B-11）。
    // 但它必须可见 —— 不能静默跳过而让人以为"产物断言跑过了"。
    const dots = EXPECTED_ARTIFACTS.map((a) => path.join(ARTIFACT_ROOT, a.rel))
    const present = dots.filter((p) => fs.existsSync(p))
    if (!hasArtifacts) {
      // 缺口登记：证据在 temp/p09（真实构建）。
      expect(present, '没有产物目录时不得出现"部分产物"（那说明构建被中断）').toEqual([])
    } else {
      expect(present.length, `产物目录存在但缺文件：${dots.filter((p) => !fs.existsSync(p)).join(', ')}`).toBe(dots.length)
    }
  })

  it('产物 HTML 的资源引用是**相对路径**（`./bundled/...`，绝对基址会 404）', () => {
    if (!hasArtifacts) return
    const htmlPath = path.join(ARTIFACT_ROOT, 'index.html')
    if (!fs.existsSync(htmlPath)) return
    const html = readSource(htmlPath)
    expect(html, 'bundle 必须由相对路径引用').toMatch(/src="\.\/bundled\//)
    expect(html, 'CSS 必须由相对路径引用').toMatch(/href="\.\/bundled\//)
    expect(html, '不得出现站点根绝对引用').not.toMatch(/(?:src|href)="\/bundled\//)
  })

  it('产物 CSS 的字体引用是**相对路径**（`url(./X.woff2)`，B1 B-05 实测形态）', () => {
    if (!hasArtifacts) return
    const cssPath = path.join(ARTIFACT_ROOT, 'bundled/StructureWorkbench.css')
    if (!fs.existsSync(cssPath)) return
    const css = bytesToLatin1(readBytes(cssPath))
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1])
    const fonts = urls.filter((u) => u.includes('.woff2'))
    expect(fonts.length, 'CSS 必须引用字体资源').toBeGreaterThan(0)
    for (const u of fonts) {
      expect(u, `字体引用必须是相对路径（实得 ${u}）`).toMatch(/^\.\//)
    }
    // 且被引用的文件**真的存在**（"引用存在"与"资源可加载"是两件事）。
    for (const u of fonts) {
      const target = path.join(ARTIFACT_ROOT, 'bundled', u.replace(/^\.\//, '').split('?')[0].split('#')[0])
      expect(fs.existsSync(target), `CSS 引用的字体不存在：${target}`).toBe(true)
    }
  })

  it('字体产物与**源字体文件内容逐字节相同**（不是"有引用"而已）', () => {
    if (!hasArtifacts) return
    const bundled = filesUnderAbsolute(path.join(ARTIFACT_ROOT, 'bundled')).filter((f) => f.endsWith('.woff2'))
    if (bundled.length === 0) return
    // 源字体（web/src/assets/fonts/）的字节集合。
    const srcDir = path.join(SRC_ROOT, 'assets/fonts')
    const srcByName = new Map<string, string>()
    for (const e of fs.readdirSync(srcDir)) {
      srcByName.set(e, hexOf(readBytes(path.join(srcDir, e))))
    }
    expect(srcByName.size, '源字体目录必须有字体').toBeGreaterThan(0)
    const srcHashes = new Set(srcByName.values())
    for (const f of bundled) {
      const h = hexOf(readBytes(f))
      expect(srcHashes.has(h), `产物字体 ${path.basename(f)} 的内容不匹配任何源字体（疑似被截断/替换）`).toBe(true)
    }
  })
})

/** 递归列出某绝对目录下的文件（绝对路径）。 */
function filesUnderAbsolute(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(p)
    }
  }
  walk(dir)
  return out.sort()
}

// ─────────────────────────────────────────────────────────────────────────────
// 三、真实产物的 ZIP 字节证据
// ─────────────────────────────────────────────────────────────────────────────

/** 六个 ZIP 签名搜索串（与 `artifactTransport.ts` 逐字同源；此处独立列出以便断言"产物 vs 期望"）。 */
const ZIP_SIGNATURE_SEARCHES: ReadonlyArray<{ readonly name: string; readonly hex: string }> = [
  { name: 'LOCAL_FILE_HEADER', hex: '504b0304' },
  { name: 'CENTRAL_FILE_HEADER', hex: '504b0102' },
  { name: 'CENTRAL_DIRECTORY_END', hex: '504b0506' },
  { name: 'ZIP64_CENTRAL_DIRECTORY_END', hex: '504b0606' },
]

describe('A34 真实产物：ZIP 签名字节（B-21 判据 (a)）', () => {
  const bundlePath = path.join(ARTIFACT_ROOT, 'bundled/StructureWorkbench.bundle.js')
  const hasBundle = fs.existsSync(bundlePath)

  it('未补丁的 wiki bundle **确实**含 ZIP 签名字面量（前置：判据有对象）', () => {
    if (!hasBundle) return
    const bytes = readBytes(bundlePath)
    const text = bytesToLatin1(bytes)
    // 逐个真字节形态搜索（latin1 口径）。
    const hits: string[] = []
    for (const s of ZIP_SIGNATURE_SEARCHES) {
      const needle = bytesToLatin1(hexToBytesLocal(s.hex))
      if (text.includes(`"${needle}"`)) hits.push(s.name)
    }
    // 目录里**存的是已补丁**的产物（构建插件的 closeBundle 打的）⇒ 此时应 0 命中，
    // 但必须含 `atob(` 形态。两种状态都合法，**不允许的是"既无签名也无 atob"**。
    const hasAtobForm = text.includes(`atob('UEsDBA==')`)
    if (hits.length > 0) {
      expect(hasAtobForm, '既有未补丁签名又无 atob ⇒ 补丁完全没跑（产物形态矛盾）').toBe(false)
    } else {
      expect(hasAtobForm, '产物里既无 ZIP 签名字面量也无 atob 补丁形态 ⇒ 无法判断构建是否正常').toBe(true)
    }
  })

  it('产物里若含 `atob(\'UEsDBA==\')` ⇒ 不得被引号包住（历史事故形态的产物级断言）', () => {
    if (!hasBundle) return
    const text = bytesToLatin1(readBytes(bundlePath))
    // 语法错误形态：`"atob('UEsDBA==')"` —— 它会在浏览器里造成"第二个 " 提前闭合"。
    expect(text, '产物里不得出现被引号包住的 atob 表达式（obj-export-zip-fix.md:34-40）').not.toContain(`"atob('UEsDBA==')"`)
    expect(text, '不得出现双引号参数的 atob（第一版修复的错误形态）').not.toContain('atob("UEsDBA=='
    )
  })
})

function hexToBytesLocal(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 四、缺能力诊断（A34「缺能力有明确诊断」）
// ─────────────────────────────────────────────────────────────────────────────

describe('A34 缺能力诊断：生产模块可加载且给出结构化诊断', () => {
  it('`hostCapabilities.ts` / `artifactTransport.ts` / `buildManifest.ts` 都能被加载（不是空文件）', async () => {
    for (const rel of P9_HOST_ADAPTER_FILES) {
      const abs = path.join(SRC_ROOT, rel)
      expect(fs.existsSync(abs), `${rel} 必须存在`).toBe(true)
      const mod = await import(abs.replace(/\\/g, '/'))
      expect(Object.keys(mod).length, `${rel} 必须有导出`).toBeGreaterThan(0)
    }
  })

  it('缺必需能力 ⇒ `blocked` + `HostCapabilityMissing`；缺可选能力 ⇒ `launchable` + 降级说明', async () => {
    const abs = path.join(SRC_ROOT, 'adapters/host/hostCapabilities.ts').replace(/\\/g, '/')
    const m = await import(abs)
    const bare = m.probeHostCapabilities(m.BARE_HOST_ENVIRONMENT)
    const spec = m.hostProfileSpec('wiki-workbench')

    const blocked = m.assertHostRequirements(spec, bare, { requestedProfile: 'wiki-workbench' })
    expect(blocked.status).toBe('blocked')
    expect(blocked.diagnostics.map((d: { code: string }) => d.code)).toContain('HostCapabilityMissing')

    const full = m.probeHostCapabilities({
      hasDom: true,
      hasWebGL2: true,
      hasBlob: true,
      hasCreateObjectURL: true,
      hasAtob: true,
      hasTextEncoder: true,
      hasIndexedDB: false,
      hasClipboard: false,
      hasFileSystemAccess: false,
    })
    const ok = m.assertHostRequirements(spec, full, { requestedProfile: 'wiki-workbench' })
    expect(ok.status).toBe('launchable')
    expect(ok.degradations.map((d: { effect: string }) => d.effect).every((e: string) => e.length > 0)).toBe(true)
  })

  it('**负对照**：把能力报告写成"全有"但用的是**未知 profile** ⇒ 仍拒绝（诊断不依赖能力）', async () => {
    const abs = path.join(SRC_ROOT, 'adapters/host/hostCapabilities.ts').replace(/\\/g, '/')
    const m = await import(abs)
    const full = m.probeHostCapabilities({
      hasDom: true,
      hasWebGL2: true,
      hasBlob: true,
      hasCreateObjectURL: true,
      hasAtob: true,
      hasTextEncoder: true,
      hasIndexedDB: true,
      hasClipboard: true,
      hasFileSystemAccess: true,
    })
    const d = m.assertHostRequirements(undefined, full, { requestedProfile: 'nope' })
    expect(d.status).toBe('unknown-profile')
    expect(d.diagnostics[0].code).toBe('HostProfileUnknown')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 五、构建适配前后字节（A34「构建适配有前后字节与行为证据」）
// ─────────────────────────────────────────────────────────────────────────────

describe('A34 构建适配前后字节：补丁在真实产物形态上产生可核对的变化', () => {
  it('对真实产物片段跑生产补丁：长度增加、签名消失、atob 出现（前后字节都可核对）', async () => {
    const abs = path.join(SRC_ROOT, 'adapters/host/artifactTransport.ts').replace(/\\/g, '/')
    const T = await import(abs)

    // 用真实产物里的**真实区间**（与单测同一份证据；见 artifactTransport.test.ts 的 provenance 注释）。
    const spanHex =
      '22504b0304222c722e43454e5452414c5f46494c455f4845414445523d22504b0102222c722e43454e5452' +
      '414c5f4449524543544f52595f454e443d22504b0506222c722e5a495036345f43454e5452414c5f444952' +
      '4543544f52595f4c4f4341544f523d22504b065c783037222c722e5a495036345f43454e5452414c5f4449' +
      '524543544f52595f454e443d22504b0606222c722e444154415f44455343524950544f523d22504b5c7830' +
      '375c62227d2c'
    const span = bytesToLatin1(hexToBytesLocal(spanHex))
    const before = `r.LOCAL_FILE_HEADER=${span.endsWith(',') ? span.slice(0, -1) : span}`

    const outcome = T.applyJszipSignaturePatch(before)
    expect(outcome.verdict).toBe('patched-all')
    expect(outcome.diagnostics).toEqual([])

    // 前后字节都可见：
    expect(outcome.bytesAfter, '补丁使文本变长（atob(...) 比 "..." 长）').toBeGreaterThan(outcome.bytesBefore)
    const beforeHex = T.hexOfLatin1(before)
    const afterHex = T.hexOfLatin1(outcome.text)
    expect(beforeHex, '补丁前含真字节 504b0304').toContain('504b0304')
    expect(afterHex, '补丁后不得再含 504b0304').not.toContain('504b0304')
    expect(afterHex, '补丁后含 atob 表达式').toContain(T.hexOfLatin1("atob('UEsDBA==')"))

    // 行为证据：经宿主传输（含浏览器 UTF-8 解码那一段）后签名仍等价。
    const { script } = T.throughHostTransferAsScript(outcome.text)
    expect(script).toContain("atob('UEsDBA==')")
    // 且未补丁形态经同样传输后**不再**是好签名（负对照，证明传输模拟有实际作用）。
    const { script: badScript, replacedBytes } = T.throughHostTransferAsScript(before)
    expect(replacedBytes, '未补丁片段在传输中必须真有控制字节被替换').toBeGreaterThan(0)
    expect(badScript).toContain('PK\uFFFD\uFFFD')
    expect(badScript).not.toContain('atob(')
  })

  it('`findResidualZipSignatures`：补丁前 6 条残留、补丁后 0 条（同一函数、两种事实）', async () => {
    const abs = path.join(SRC_ROOT, 'adapters/host/artifactTransport.ts').replace(/\\/g, '/')
    const T = await import(abs)
    const spanHex =
      '22504b0304222c722e43454e5452414c5f46494c455f4845414445523d22504b0102222c722e43454e5452' +
      '414c5f4449524543544f52595f454e443d22504b0506222c722e5a495036345f43454e5452414c5f444952' +
      '4543544f52595f4c4f4341544f523d22504b065c783037222c722e5a495036345f43454e5452414c5f4449' +
      '524543544f52595f454e443d22504b0606222c722e444154415f44455343524950544f523d22504b5c7830' +
      '375c62227d2c'
    const span = bytesToLatin1(hexToBytesLocal(spanHex))
    const before = `r.LOCAL_FILE_HEADER=${span.endsWith(',') ? span.slice(0, -1) : span}`
    expect(T.findResidualZipSignatures(before)).toHaveLength(6)
    const after = T.applyJszipSignaturePatch(before).text
    expect(T.findResidualZipSignatures(after)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 六、本批交付面登记（防"登记了不存在的文件"）
// ─────────────────────────────────────────────────────────────────────────────

describe('A34 交付面登记：本批的适配器与测试文件都真实存在', () => {
  it('三个适配器实现文件存在且**都不是占位**（有实质内容与导出）', () => {
    for (const rel of P9_HOST_ADAPTER_FILES) {
      const abs = path.join(SRC_ROOT, rel)
      expect(fs.existsSync(abs), `${rel} 必须存在`).toBe(true)
      const text = readSource(abs)
      expect(text.length, `${rel} 不得是空文件/占位`).toBeGreaterThan(2000)
      expect(text, `${rel} 必须写清依据的 #249 章节（注释头）`).toMatch(/#249/)
      expect(text, `${rel} 必须有导出`).toMatch(/export (function|const|class|interface|type)/)
    }
  })

  it('三个测试文件存在（"已覆盖"不得是空话）', () => {
    for (const rel of P9_HOST_TEST_FILES) {
      expect(fs.existsSync(path.join(SRC_ROOT, rel)), `${rel} 必须存在`).toBe(true)
    }
  })

  it('三个适配器**不含**自驱时间来源（全树闸门 presentation-purity 的同款判据）', () => {
    const forbidden = ['requestAnimationFrame', 'setTimeout', 'setInterval', 'Date.now', 'performance.now']
    const hits: string[] = []
    for (const rel of P9_HOST_ADAPTER_FILES) {
      const text = readSource(path.join(SRC_ROOT, rel))
      for (const [i, line] of text.split('\n').entries()) {
        if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue // 注释里的退役记录不判红
        for (const needle of forbidden) {
          if (line.includes(needle)) hits.push(`${rel}:${i + 1} 出现 ${needle}`)
        }
      }
    }
    expect(hits, `适配器出现自驱时间来源（哈希必须用纯 FNV-1a，时间必须由调用方注入）:\n${hits.join('\n')}`).toEqual([])
  })

  it('三个适配器**不导入** Vue / Three / DOM 相关实现（适配器层不得夹带呈现）', () => {
    const banned = ["from 'vue'", 'from "vue"', "from 'three'", 'from "three"']
    const hits: string[] = []
    for (const rel of P9_HOST_ADAPTER_FILES) {
      const text = readSource(path.join(SRC_ROOT, rel))
      for (const b of banned) if (text.includes(b)) hits.push(`${rel}: ${b}`)
    }
    expect(hits, `adapters/host 不得依赖 Vue/Three（契约 §7.1 规则 4）:\n${hits.join('\n')}`).toEqual([])
  })

  it('跨层导入深度 ≤ 2（公共出口约束；不得钻进 `@/application/<子目录>/…`）', () => {
    const violations: string[] = []
    for (const rel of P9_HOST_ADAPTER_FILES) {
      const text = readSource(path.join(SRC_ROOT, rel))
      for (const m of text.matchAll(/from\s+'(@\/[^']+)'/g)) {
        const spec = m[1]
        const depth = spec.replace(/^@\//, '').split('/').length
        if (depth > 2) violations.push(`${rel} → ${spec}（深度 ${depth} > 2）`)
      }
    }
    expect(violations, `适配器跨层导入了深于公共出口的实现:\n${violations.join('\n')}`).toEqual([])
  })
})
