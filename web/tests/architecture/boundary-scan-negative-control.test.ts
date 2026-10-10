/**
 * A01 **负对照** —— 「注入一条违规类型导入也判红」。
 *
 * #249 §14 A01 的"负对照必须判红"列原文：**注入一条违规类型导入也失败**。
 * 这是本设施最关键的一条自证：如果扫描器只会对"明显的运行时能力导入"判红，
 * 却对 `import type { Ref } from 'vue'` 视而不见，那么 #249 §4 规则 6
 * 「**类型导入同样计入**边界检查。…Vue/Three 类型也不得泄入纯核心」就形同虚设 ——
 * 而这正是纯核心最容易被悄悄污染的方式。
 *
 * ## 负对照的两条纪律（#249 §14 测试维护要求）
 *
 * 1. **必须证明确实破坏了目标保证**，不能只令测试主动抛错。
 *    ⇒ 本文件不 mock 规则、不 stub 判据：它**真的**在临时目录里造出一个
 *    `src/domain/` 层文件，写一条真的 `import type … from 'vue'`，然后用**同一个**
 *    `extractImports` + **同一个** `ruleCoreNoVueThree.check` 去扫，断言它被判红。
 * 2. **正对照必须同跑**：只证明"能判红"会诱导出"永远判红"的假设施。
 *    ⇒ 同一用例内先断言合规样本判绿，再断言违规样本判红。
 *
 * ## 为什么用临时树而不是往本树里塞违规文件
 *
 * 往 `web/src/` 写一个故意的违规文件会让本树**永远带着一个已知违规**（污染 A01 的正报告），
 * 且一旦测试未清理就会把后续批次的红都算到这个文件头上。
 * 临时树（`os.tmpdir()`）既真实（走完整的 AST 路径）又零污染，且**可精确控制**
 * 注入的形态（类型导入 / barrel 转出口 / DOM 全局），从而逐条覆盖 A01 的判据面。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ruleCoreNoDomGlobals, ruleCoreNoVueThree, ruleNoBarrelSmuggling } from './boundary-rules.mjs'
import { buildAstIndex, buildModuleGraph, extractImports } from './module-graph.mjs'

let tmpRoot = null
let srcRoot = null

/** 造一棵最小 src 树；`files` 是 `相对 src 的路径 → 内容`。 */
function makeTree(files) {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-a01-neg-'))
  srcRoot = path.join(tmpRoot, 'src')
  fs.mkdirSync(srcRoot, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(srcRoot, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
  }
  return { tmpRoot, srcRoot }
}

/**
 * 在临时树上跑规则（走与 `scan-boundaries.mjs` 相同的路径）。
 *
 * P1 起 ctx 的执行面是**文件级**（`gateFiles`）而非层名前缀，
 * 故这里按"全部生产文件都是新实现"构造 —— 这正是负对照想要的：
 * 判据本身（不是登记表）必须在违规时判红。
 */
function run(files, rule) {
  const { srcRoot: root } = makeTree(files)
  const { files: scanned, facts } = buildModuleGraph(root)
  const gateFiles = new Set(scanned.filter((f) => /\.(ts|tsx|mts|vue)$/.test(f)).map((f) => path.relative(root, f).replace(/[\\/]+/g, '/')))
  const ctx = {
    srcRoot: root,
    webRoot: tmpRoot,
    gateFiles,
    gateLayers: ['domain', 'application'],
    coreFiles: gateFiles,
    layerCollisions: [],
  }
  return { hits: rule.check(facts, ctx), scanned, facts, root, ctx }
}

beforeEach(() => {
  tmpRoot = null
  srcRoot = null
})

afterEach(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
  tmpRoot = null
  srcRoot = null
})

describe('A01 负对照：注入违规**类型导入**必须判红', () => {
  it('正对照：合规的 domain 层判绿（同一条规则、同一路径）', () => {
    const { hits } = run(
      {
        'domain/scene.ts': [
          "import type { Vec3 } from './vec'",
          "import { add } from './vec'",
          'export function f(a: Vec3): Vec3 { return add(a, a) }',
        ].join('\n'),
        'domain/vec.ts': 'export type Vec3 = readonly [number, number, number]\nexport const add = (a: Vec3) => a',
      },
      ruleCoreNoVueThree,
    )
    expect(hits, '合规 domain 层不应有 finding（正对照）').toEqual([])
  })

  it('负对照 1：`import type { Ref } from \'vue\'` 注入 domain ⇒ 判红（§4 规则 6）', () => {
    const { hits } = run(
      {
        'domain/scene.ts': [
          "import type { Ref } from 'vue'",
          'export type X = Ref<number>',
        ].join('\n'),
      },
      ruleCoreNoVueThree,
    )
    expect(hits, '违规**类型导入**必须被判红（A01 负对照原文）').toHaveLength(1)
    expect(hits[0].rule).toBe('gate/core-no-vue-three')
    expect(hits[0].file).toMatch(/domain\/scene\.ts$/)
    expect(hits[0].line).toBe(1)
    expect(hits[0].isTypeOnly, 'finding 必须如实标出这是类型导入').toBe(true)
    expect(hits[0].detail).toContain('类型导入')
  })

  it('负对照 2：`import type { Object3D } from \'three\'` 注入 application ⇒ 判红', () => {
    const { hits } = run(
      {
        'application/commands.ts': [
          "import type { Object3D } from 'three'",
          'export type Y = Object3D',
        ].join('\n'),
      },
      ruleCoreNoVueThree,
    )
    expect(hits).toHaveLength(1)
    expect(hits[0].isTypeOnly).toBe(true)
    expect(hits[0].detail).toContain('three')
  })

  it('负对照 3：运行时而不仅是类型导入，同样判红（两种形态都覆盖）', () => {
    const { hits } = run(
      { 'domain/bad.ts': "import { ref } from 'vue'\nexport const r = ref(1)\n" },
      ruleCoreNoVueThree,
    )
    expect(hits).toHaveLength(1)
    expect(hits[0].isTypeOnly).toBe(false)
  })

  it('负对照 4：`export type { … } from \'vue\'` 也算越界（转出口不得漏判）', () => {
    const { hits } = run(
      { 'domain/barrel.ts': "export type { Ref } from 'vue'\n" },
      ruleCoreNoVueThree,
    )
    expect(hits).toHaveLength(1)
    expect(hits[0].kind).toBe('export-from')
  })

  it('负对照 5：barrel 偷渡（跨目录转出口未登记）判红；同目录转出口不判红', () => {
    const cross = run(
      {
        'domain/index.ts': "export * from './scene'\nexport { x } from './../pure/other'\n",
        'domain/scene.ts': 'export const x = 1\n',
        'pure/other.ts': 'export const x = 2\n',
      },
      ruleNoBarrelSmuggling,
    )
    // `./scene` 是同目录 → 不判；`./../pure/other` 跨目录 → 判红
    expect(cross.hits).toHaveLength(1)
    expect(cross.hits[0].specifier).toBe('./../pure/other')
  })

  it('负对照 6：domain 层引用浏览器全局 `document` 判红（AST 级，非关键词）', () => {
    const { srcRoot: root } = makeTree({
      'domain/leaky.ts': ['export function f(): number {', '  return document.body.clientWidth', '}'].join('\n'),
      'application/leaky2.ts': ['export function g(): string {', '  return window.location.href', '}'].join('\n'),
      // 这个文件**在注释里**提到 document/window，不得被计入（证明是 AST 而非关键词计数）
      'domain/comment-only.ts': ['// 这里提到 document 与 window，但从未引用它们', 'export const ok = 1'].join('\n'),
    })
    const { files } = buildModuleGraph(root)
    const astIndex = buildAstIndex(files)
    const gateFiles = new Set(files.map((f) => path.relative(root, f).replace(/[\\/]+/g, '/')))
    const ctx = { srcRoot: root, webRoot: tmpRoot, gateFiles, gateLayers: ['domain', 'application'], coreFiles: gateFiles, layerCollisions: [] }
    const hits = ruleCoreNoDomGlobals.checkWithAst(astIndex, ctx)
    const names = hits.map((h) => h.specifier).sort()
    expect(names).toEqual(['document', 'window'])
    expect(hits.every((h) => h.file.includes('leaky'))).toBe(true)
    expect(hits.some((h) => h.file.includes('comment-only')), '注释里的关键词不得计入').toBe(false)
  })
})

describe('A01 负对照的元保证：判据不是"恒红"也不是"恒绿"', () => {
  it('同一份合规样本对全部闸门规则均判绿（防"永远判红"的假设施）', () => {
    const files = {
      'domain/scene.ts': "import type { Vec3 } from './vec'\nexport type S = Vec3\n",
      'domain/vec.ts': 'export type Vec3 = readonly [number, number, number]\n',
      'application/commands.ts': "import type { Vec3 } from '../domain/vec'\nexport type C = Vec3\n",
    }
    const { srcRoot: root } = makeTree(files)
    const { files: scanned, facts } = buildModuleGraph(root)
    const gateFiles = new Set(scanned.map((f) => path.relative(root, f).replace(/[\\/]+/g, '/')))
    const ctx = { srcRoot: root, webRoot: tmpRoot, gateFiles, gateLayers: ['domain', 'application'], coreFiles: gateFiles, layerCollisions: [] }
    for (const rule of [ruleCoreNoVueThree, ruleNoBarrelSmuggling]) {
      expect(rule.check(facts, ctx), `${rule.id} 不应在合规样本上判红`).toEqual([])
    }
    const astIndex = buildAstIndex(scanned)
    expect(ruleCoreNoDomGlobals.checkWithAst(astIndex, ctx)).toEqual([])
  })

  it('注入的违规**确实**破坏了目标保证（不是靠测试主动抛错）', () => {
    // 证明方式：同一个文件，只改动"是否从 vue 做类型导入"这一个事实，判定随风向翻转。
    const clean = "import type { Vec3 } from './vec'\nexport type S = Vec3\n"
    const dirty = "import type { Ref } from 'vue'\nexport type S = Ref<number>\n"

    const a = run({ 'domain/s.ts': clean, 'domain/vec.ts': 'export type Vec3 = readonly [number,number,number]\n' }, ruleCoreNoVueThree)
    const b = run({ 'domain/s.ts': dirty }, ruleCoreNoVueThree)

    expect(a.hits, '干净样本判绿').toEqual([])
    expect(b.hits, '同一文件仅多一条 vue 类型导入即判红').toHaveLength(1)
    // 逐字确认被判红的是那条注入的导入，而不是别的什么
    expect(b.hits[0].syntax).toContain("from 'vue'")
  })
})

describe('A01 设施对非生产文件的态度（避免把测试文件计入边界）', () => {
  it('__tests__ 与 *.test.ts 不计入生产模块图的规则判定', () => {
    // 本树实况：pure/__tests__/partMask.test.ts 为了断言导入了 three。
    // 若扫描把测试算进生产图，A01 会凭空多出一批假红。这里钉住该口径。
    const { srcRoot: root } = makeTree({
      'domain/__tests__/x.test.ts': "import * as THREE from 'three'\nexport const t = THREE\n",
      'domain/real.ts': 'export const r = 1\n',
    })
    const { files } = buildModuleGraph(root)
    const isProd = (f) => {
      const rel = path.relative(root, f).replace(/[\\/]+/g, '/')
      if (rel.split('/').slice(0, -1).includes('__tests__')) return false
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)) return false
      return true
    }
    const prodFacts = buildModuleGraph(root).facts.filter((f) => isProd(f.fromFile))
    const gateFiles = new Set(files.filter(isProd).map((f) => path.relative(root, f).replace(/[\\/]+/g, '/')))
    const ctx = { srcRoot: root, webRoot: tmpRoot, gateFiles, gateLayers: ['domain'], coreFiles: gateFiles, layerCollisions: [] }
    expect(files.length).toBe(2)
    expect(ruleCoreNoVueThree.check(prodFacts, ctx), '测试文件里的 three 导入不得计入生产边界').toEqual([])
  })
})
