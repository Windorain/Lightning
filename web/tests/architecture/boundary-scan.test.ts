/**
 * 架构边界扫描 —— **vitest 接线**。
 *
 * 使 `npm run test:arch` 自动覆盖 A01 设施；扫描逻辑本身在
 * `scan-boundaries.mjs`（可独立执行）+ `boundary-rules.mjs`（判据）+ `module-graph.mjs`（AST）。
 *
 * ## 为什么本设施单独一个 vitest 配置
 *
 * `web/vitest.config.ts` 的 `include` 是 `src/**\/*.test.ts` —— 它服务**产品单测**。
 * 把本目录挂进去会让 `npm test` 的用例数随本设施变动，于是 B6 的 trunk 基线与
 * "本批新增设施"再也无法逐项对账。故本设施走 `vitest.architecture.config.ts`，
 * 由 `npm run test:arch` 驱动；两者互不影响、各自可复现。
 *
 * ## P1 的口径变化（#250 裁决 2026-10-11）
 *
 * 闸门执行面从"层名前缀"升级为**文件级**（`gateFiles`）+ 纯核心前缀（`coreFiles`）。
 * 原因见 `boundary-rules.mjs` 的 `LAYER_DESTINATIONS.runtime.activeSubpaths`：
 * `runtime/` 是**部分迁移层**（旧 38 个文件与新 3 个文件同目录）。
 * 本文件为这次口径变化补两条负对照（Lead 裁决要求）：
 *  1. 混入一条**旧根目录**的违规仍判红；
 *  2. 新 `runtime/execution.ts` 里 import vue 判红。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  GATE_RULES,
  LAYERS,
  P_DUTIES,
  P_TO_ISSUE_OFFSET,
  RETIREMENT_OWNERS,
  collectLegacyDebt,
  corePurityFileSet,
  isGateFile,
  parsePBatch,
  resolveGateLayers,
  resolveInternalTarget,
  ruleCoreNoDomGlobals,
  topLayer,
} from './boundary-rules.mjs'
import { WEB_ROOT, buildAstIndex, buildModuleGraph, extractGlobalRefs, extractImports } from './module-graph.mjs'

const SRC_ROOT = path.join(WEB_ROOT, 'src')

/** 对任意文件路径抽自由标识符引用（负对照用临时文件）。 */
function extractGlobalRefsFor(absPath) {
  return extractGlobalRefs(absPath)
}

/** 构建与 scan-boundaries.mjs 相同的 ctx（避免测试与入口漂移）。 */
function buildCtx() {
  const { active, absent, legacyCollisions } = resolveGateLayers(SRC_ROOT)
  const gateFiles = new Set(active)
  return {
    ctx: {
      srcRoot: SRC_ROOT,
      webRoot: WEB_ROOT,
      gateFiles,
      gateLayers: LAYERS,
      coreFiles: corePurityFileSet(SRC_ROOT),
      layerCollisions: legacyCollisions,
    },
    gateFiles,
    absent,
    legacyCollisions,
  }
}

function isProductionRel(rel) {
  if (rel.startsWith('..')) return false
  if (rel.split('/').slice(0, -1).includes('__tests__')) return false
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)) return false
  return true
}

describe('A01 设施自检：AST 解析确实在解析 AST（不是关键词计数）', () => {
  it('导入事实只来自真实 Import/Export 节点：注释与字符串不产生事实', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-a01-'))
    try {
      const file = path.join(dir, 'sample.ts')
      fs.writeFileSync(
        file,
        [
          "// import { ref } from 'vue'   ← 注释里的导入，不得计入",
          "const s = \"import x from 'three'\"   // 字符串里的导入，不得计入",
          "import { something } from './real'",
          'export const y = 1',
        ].join('\n'),
        'utf8',
      )
      const facts = extractImports(file)
      expect(facts.map((f) => f.specifier)).toEqual(['./real'])
      expect(facts[0].kind).toBe('import')
      expect(facts[0].line).toBe(3)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('`import type` 被识别为类型导入，且**仍然计入**（#249 §4 规则 6）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-a01-'))
    try {
      const file = path.join(dir, 'sample.ts')
      fs.writeFileSync(file, ["import type { Ref } from 'vue'", "import { ref } from 'vue'"].join('\n'), 'utf8')
      const facts = extractImports(file)
      expect(facts).toHaveLength(2)
      expect(facts[0].isTypeOnly).toBe(true)
      expect(facts[1].isTypeOnly).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('`export * from` / `export {} from` 被识别为 barrel 转出口（§4 规则 6）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-a01-'))
    try {
      const file = path.join(dir, 'sample.ts')
      fs.writeFileSync(file, ["export * from './inner/a'", "export type { T } from './inner/b'"].join('\n'), 'utf8')
      const facts = extractImports(file)
      expect(facts.map((f) => f.kind)).toEqual(['export-from', 'export-from'])
      expect(facts[1].isTypeOnly).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('动态 import() 与 require() 被识别；不可静态解析的参数如实保留为事实', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-a01-'))
    try {
      const file = path.join(dir, 'sample.ts')
      fs.writeFileSync(file, ["const a = await import('./static-target')", 'const b = await import(someVar)', "const c = require('fs')"].join('\n'), 'utf8')
      const facts = extractImports(file)
      const kinds = facts.map((f) => f.kind)
      expect(kinds).toEqual(['dynamic-import', 'dynamic-import', 'require'])
      expect(facts[0].specifier).toBe('./static-target')
      expect(facts[1].specifier.startsWith('«dynamic:')).toBe(true)
      expect(facts[2].specifier).toBe('fs')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('A01 设施在当前树上的实况（含空洞真的显式披露）', () => {
  it('扫描本树：闸门规则全部 0 finding；P1 新建层不再空洞', () => {
    const { files, facts } = buildModuleGraph()
    const produced = (f) => isProductionRel(path.relative(SRC_ROOT, f).replace(/[\\/]+/g, '/'))
    const productionFiles = files.filter(produced)
    const productionFacts = facts.filter((f) => produced(f.fromFile))
    const { ctx, gateFiles } = buildCtx()

    // P1（#252）已建 domain/application/runtime 三个新层 ⇒ 执行面非空
    expect(gateFiles.size).toBeGreaterThan(0)
    // 且**必须**包含本批的新实现（否则闸门在"看着有内容"的假绿上）
    expect([...gateFiles]).toContain('runtime/execution.ts')
    expect([...gateFiles]).toContain('domain/document.ts')
    expect([...gateFiles]).toContain('application/commands.ts')
    // P8（#259）新增的层同样进入执行面：内容边界与诊断契约所在的 domain/、
    // application/、editors/ 都必须被闸门实际检验（不能只是目录存在）。
    expect([...gateFiles]).toContain('domain/textContent.ts')
    expect([...gateFiles]).toContain('application/diagnostics.ts')
    expect([...gateFiles]).toContain('editors/ContentText.vue')

    for (const rule of GATE_RULES) {
      expect(rule.check(productionFacts, ctx), `规则 ${rule.id} 不应有 finding`).toEqual([])
    }
    const astIndex = buildAstIndex(productionFiles)
    expect(GATE_RULES.filter((r) => r.needsAst).flatMap((r) => r.checkWithAst(astIndex, ctx))).toEqual([])
    expect(productionFiles.length).toBeGreaterThan(200)
  })

  it('目录名撞车被识别：旧 runtime/ 的未登记文件不得被当成新实现（防假绿）', () => {
    const { legacyCollisions, gateFiles } = buildCtx()
    void legacyCollisions
    // web/src/runtime 确实存在，且其中大部分文件承载旧实现（#249 §17 抽查点 renderEngine/sessionStore/chromeBinder）
    expect(fs.existsSync(path.join(SRC_ROOT, 'runtime', 'renderEngine.ts'))).toBe(true)
    expect(fs.existsSync(path.join(SRC_ROOT, 'runtime', 'sessionStore.ts'))).toBe(false)
    // 它们**不在**执行面内（否则会因撞名误红，见 boundary-rules 文件头）
    expect([...gateFiles]).not.toContain('runtime/renderEngine.ts')
    expect([...gateFiles]).not.toContain('runtime/host/workbenchHost.ts')
    // 而新实现**在**执行面内
    expect([...gateFiles]).toContain('runtime/effects.ts')
  })

  it('债务清单可复现：旧目录跨目录 barrel 转出口被计数且带文件行号', () => {
    const { files, facts } = buildModuleGraph()
    const productionFacts = facts.filter((f) => !/__tests__|\.test\.|\.spec\./.test(f.fromRel))
    const { ctx } = buildCtx()
    const debt = collectLegacyDebt(productionFacts, ctx, [])
    expect(debt['legacy-barrel-reexport'].length).toBeGreaterThan(0)
    for (const item of debt['legacy-barrel-reexport']) {
      expect(item.file).toMatch(/^src\//)
      expect(item.line).toBeGreaterThan(0)
      expect(typeof item.syntax).toBe('string')
    }
    // 稳定排序 ⇒ 两次运行的清单逐项一致（可对账）
    const again = collectLegacyDebt(productionFacts, ctx, [])
    expect(JSON.stringify(again['legacy-barrel-reexport'])).toBe(JSON.stringify(debt['legacy-barrel-reexport']))
  })

  it('#249 §15 十三条退役条目均有负责批次与退出阶段', () => {
    const entries = Object.entries(RETIREMENT_OWNERS)
    expect(entries).toHaveLength(13)
    for (const [slug, owner] of entries) {
      expect(slug, 'slug 必须是非空稳定标识').toMatch(/^[a-z0-9-]+$/)
      expect(owner.entries.length, `${slug} 必须标注覆盖的 §15 行号`).toBeGreaterThan(0)
      expect(owner.owners.length, `${slug} 必须至少有一个负责批次`).toBeGreaterThan(0)
      expect(owner.exitStage, `${slug} 缺退出阶段`).toMatch(/^P\d+/)
      expect(owner.role, `${slug} 缺负责人角色`).toMatch(/执行者/)
    }
  })

  it('**P 编号 ↔ issue 号 ↔ 职责名 三者一致**（#250 权威映射；#(251+N)）', () => {
    // 三重断言的理由：只查"P<N> ↔ #(251+N)"的**算术**一致，发现不了
    // "P 与 issue 配对正确、但职责张冠李戴"这类错位 ——
    // 初版 #7（工作台/嵌入分叉）写成 `P7 (#258)`，算术成立，但 P7 的职责是
    // **输入路由**而非 Area 生命周期。故职责名必须同为客户端的断言对象。
    for (const [slug, owner] of Object.entries(RETIREMENT_OWNERS)) {
      for (const o of owner.owners) {
        const p = parsePBatch(o.p)
        expect(p, `${slug} 的批次号 ${o.p} 必须形如 PN`).not.toBeNull()
        // ① P ↔ issue
        expect(o.issue, `${slug}：${o.p} 必须对应 #${P_TO_ISSUE_OFFSET + p}，实得 #${o.issue}`).toBe(P_TO_ISSUE_OFFSET + p)
        // ② P ↔ 职责名（逐字对 #250 表）
        expect(o.duty, `${slug}：${o.p} 的职责应为「${P_DUTIES[o.p]}」，实得「${o.duty}」`).toBe(P_DUTIES[o.p])
      }
    }
  })

  it('P_DUTIES 表覆盖 P1–P11 且与被断言引用的批次名一一对应（防表本身写错）', () => {
    expect(Object.keys(P_DUTIES)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11'])
    // 职责名必须与 #250「执行单与依赖」表逐字一致（本表是那份表的机器可读副本）
    expect(P_DUTIES.P6).toBe('工作区、Area 生命周期与模块装配')
    expect(P_DUTIES.P7).toBe('输入路由、焦点与文本草稿')
    expect(P_DUTIES.P8).toBe('内容边界、实例配置隔离与结构化诊断')
    expect(P_DUTIES.P9).toBe('持久化、固定快照导出与恢复')
    expect(P_DUTIES.P10).toBe('集成闭环与交叉验收')
    expect(P_DUTIES.P11).toBe('退役审计、全量回归、性能门槛与复杂度对账')
  })

  it('十三条 §15 行号被完整且不重复地覆盖（1..13）', () => {
    const covered = Object.values(RETIREMENT_OWNERS)
      .flatMap((o) => o.entries)
      .sort((a, b) => a - b)
    expect(covered).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
  })

  it('批次归属落在 #250 表内（P1–P11 = #252–#262），不含 P0 或越界', () => {
    for (const [slug, owner] of Object.entries(RETIREMENT_OWNERS)) {
      for (const o of owner.owners) {
        const p = parsePBatch(o.p)
        expect(p, `${slug}: ${o.p} 越界（退役只由 P1–P11 承担，P0 不执行退役）`).toBeGreaterThanOrEqual(1)
        expect(p, `${slug}: ${o.p} 越界`).toBeLessThanOrEqual(11)
      }
    }
  })

  it('（#250 裁决 2026-10-11）#1/#4/#6 的退出阶段已按消费者归口修正，并标出 P1 交付的那一半', () => {
    for (const slug of ['raw-authority-object', 'per-viewport-staging', 'multi-raf-business']) {
      const owner = RETIREMENT_OWNERS[slug]
      expect(owner, `${slug} 必须存在`).toBeTruthy()
      // 不再谎称"P1 交付同批"完成全部退役
      expect(owner.exitStage, `${slug} 须写明消费者归口与 P11 终局审计`).toMatch(/P11 终局审计/)
      expect(owner.p1Delivered, `${slug} 须标出 P1 交付的是"替代机制"`).toBe('替代机制')
      // P1 仍必须在这三条里有可交付面（否则就是"把活全推给别人"）
      expect(owner.owners.length, `${slug} 必须列出消费者归口批次`).toBeGreaterThanOrEqual(2)
    }
  })
})

describe('A01 目标分层清单与 #249 §4 一致', () => {
  it('LAYERS 覆盖 #249 §4 的全部九个分层', () => {
    expect(LAYERS).toEqual(['domain', 'application', 'runtime', 'presentation', 'editors', 'shells', 'adapters', 'composition', 'entries'])
  })
})

describe('说明符解析（规则的前提）', () => {
  it('@/ 别名与相对路径都能解析到 src 相对路径；外部包返回 null', () => {
    const mk = (specifier) => ({
      fromFile: path.join(SRC_ROOT, 'domain', 'a.ts'),
      specifier,
      kind: 'import',
      isTypeOnly: false,
      line: 1,
      column: 1,
      syntax: '',
      fromRel: 'web/src/domain/a.ts',
      fromSrcRel: 'domain/a.ts',
    })
    expect(resolveInternalTarget(mk('@/pure/vec'), SRC_ROOT)).toBe('pure/vec')
    expect(resolveInternalTarget(mk('../pure/vec'), SRC_ROOT)).toBe('pure/vec')
    expect(resolveInternalTarget(mk('vue'), SRC_ROOT)).toBeNull()
    expect(resolveInternalTarget(mk('three'), SRC_ROOT)).toBeNull()
    expect(resolveInternalTarget(mk('«dynamic:x»'), SRC_ROOT)).toBeNull()
    expect(topLayer('pure/vec')).toBe('pure')
  })
})

/**
 * #250 裁决要求的**两条负对照**：部分迁移层口径不得把两类不同的东西混为一谈。
 *
 * 为什么必须两条都有：
 *  - 只证明"新文件判红"会放过"旧文件因撞名误红"（假红，会淹没真信号）；
 *  - 只证明"旧文件不判红"会放过"新文件漏检"（假绿，闸门形同虚设）。
 */
describe('P1 部分迁移层的负对照（#250 裁决 2026-10-11）', () => {
  it('负对照 A：新登记文件 `runtime/execution.ts` 里 import vue ⇒ 判红', () => {
    const { ctx, gateFiles } = buildCtx()
    // 用本树**真实**的 gateFiles（即真实登记表），只把"违规文件"合成出来。
    const facts = [
      {
        fromFile: path.join(SRC_ROOT, 'runtime', 'execution.ts'),
        fromRel: 'web/src/runtime/execution.ts',
        fromSrcRel: 'runtime/execution.ts',
        specifier: 'vue',
        kind: 'import',
        isTypeOnly: true,
        line: 1,
        column: 1,
        syntax: "import type { Ref } from 'vue'",
      },
    ]
    expect(isGateFile('runtime/execution.ts', gateFiles), '前置：该文件必须在执行面内').toBe(true)
    const hits = GATE_RULES.find((r) => r.id === 'gate/core-no-vue-three').check(facts, ctx)
    expect(hits, '新层文件的违规类型导入必须判红').toHaveLength(1)
    expect(hits[0].isTypeOnly).toBe(true)
  })

  it('负对照 A′：新登记文件里引用 DOM 全局 ⇒ 判红（AST 级）', () => {
    const { ctx } = buildCtx()
    const astIndex = [
      {
        abs: path.join(SRC_ROOT, 'runtime', 'scheduling.ts'),
        rel: 'runtime/scheduling.ts',
        globalRefs: [{ name: 'window', line: 3, column: 5, syntax: 'window.location.href' }],
      },
    ]
    const hits = GATE_RULES.find((r) => r.id === 'gate/core-no-dom-globals').checkWithAst(astIndex, ctx)
    expect(hits).toHaveLength(1)
    expect(hits[0].specifier).toBe('window')
  })

  it('负对照 A″：**成员名**叫 `document` 的声明不判红，裸 `document` 引用仍判红（假红与漏判的分界）', () => {
    // 为什么必须钉住这条：P1 新建的 `application/queries.ts` 里有
    // `readonly document: () => Result<DocumentSummary>` —— 那是**成员名**，
    // 不是对 DOM 全局的引用。本批首跑时它被自己新建的闸门判红（假红）。
    // 修 AST 抽取必须精确到"名字位"，否则修掉假红的同时会漏掉真危险形态。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-dom-'))
    try {
      const declFile = path.join(dir, 'members.ts')
      fs.writeFileSync(
        declFile,
        [
          'export interface Queries {',
          '  readonly document: () => number',
          '  readonly window: string',
          '}',
          'export type Document = number',
          "export const ok = 1",
        ].join('\n'),
        'utf8',
      )
      const leakFile = path.join(dir, 'leak.ts')
      fs.writeFileSync(
        leakFile,
        ['export function f(): number {', '  return document.body.clientWidth + window.innerWidth', '}'].join('\n'),
        'utf8',
      )
      const { ctx } = buildCtx()
      const clean = GATE_RULES.find((r) => r.id === 'gate/core-no-dom-globals').checkWithAst(
        [{ abs: path.join(SRC_ROOT, 'application', 'queries.ts'), rel: 'application/queries.ts', globalRefs: extractGlobalRefsFor(declFile) }],
        ctx,
      )
      expect(clean, '成员名/类型名的声明不得被判为 DOM 引用（假红）').toEqual([])

      // 关键对照：走同一个抽取器，真实的 `document.body` / `window.innerWidth` 必须被抓到。
      // 若为了消除假红而把 `document`/`window` 整体豁免，这条会立刻变红。
      // 注意 rel 必须用一个**真实登记**的新实现路径（规则按执行面判定），
      // 故这里复用 `application/queries.ts` 这个 rel，但内容是泄漏样本的 AST 抽取结果。
      const dirty = ruleCoreNoDomGlobals.checkWithAst(
        [{ abs: path.join(SRC_ROOT, 'application', 'queries.ts'), rel: 'application/queries.ts', globalRefs: extractGlobalRefsFor(leakFile) }],
        ctx,
      )
      expect(dirty.map((h) => h.specifier).sort(), '真实 DOM 引用仍必须判红（不得为消假红而漏判）').toEqual(['document', 'window'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('负对照 B：**旧** runtime 根文件（未登记）不因撞名被判红，但仍进债务清单', () => {
    const { ctx, gateFiles } = buildCtx()
    const facts = [
      {
        fromFile: path.join(SRC_ROOT, 'runtime', 'renderEngine.ts'),
        fromRel: 'web/src/runtime/renderEngine.ts',
        fromSrcRel: 'runtime/renderEngine.ts',
        specifier: 'three',
        kind: 'import',
        isTypeOnly: false,
        line: 1,
        column: 1,
        syntax: "import * as THREE from 'three'",
      },
    ]
    expect(isGateFile('runtime/renderEngine.ts', gateFiles), '前置：旧文件不得在执行面内').toBe(false)
    const hits = GATE_RULES.find((r) => r.id === 'gate/core-no-vue-three').check(facts, ctx)
    expect(hits, '旧实现的 three 导入是 #249 §15 遗留债务（P5 退役），不是本批新边界的 finding').toEqual([])
  })

  it('负对照 C：旧→旧 的跨目录转出口不判红（它属债务，不属新边界）', () => {
    const { ctx } = buildCtx()
    // 取本树**真实存在**的一条旧→旧转出口（避免合成事实与实际形态漂移）
    // `web/src/workbench/ux/types/index.ts` 转出口旧的 `runtime/types`。
    const facts = buildModuleGraph().facts.filter((f) => f.fromRel === 'src/workbench/ux/types/index.ts' && f.kind === 'export-from')
    expect(facts.length, '前置：本树须存在该转出口（否则本用例失去对象）').toBeGreaterThan(0)
    const target = resolveInternalTarget(facts[0], SRC_ROOT)
    expect(topLayer(target)).toBe('runtime')
    expect(isGateFile(`${target}.ts`, ctx.gateFiles), '前置：目标是**旧** runtime 文件，不在执行面内').toBe(false)

    const hits = GATE_RULES.find((r) => r.id === 'gate/no-barrel-smuggling').check(facts, ctx)
    expect(hits, '旧→旧 转出口不得因 runtime 层名而判红（P0 实测会凭空多 1 条假红）').toEqual([])
    // 但它必须**仍被计数**（否则等于把债务藏起来）
    const debt = collectLegacyDebt(facts, ctx, [])
    expect(debt['legacy-barrel-reexport'].length).toBeGreaterThan(0)
    expect(debt['legacy-barrel-reexport'][0].toLayer).toBe('runtime')
    expect(debt['legacy-barrel-reexport'][0].fromLayer).toBe('workbench')
  })

  it('负对照 D：**新实现**→跨层深导入仍判红（且是真实的两个新层文件）', () => {
    const { ctx, gateFiles } = buildCtx()
    // 判定面在发起方（新实现）。这里不使用合成事实以外的假设：
    // 用本树真实登记的 `application/commands.ts` 发起，目标写一条深度 3 的路径。
    expect(isGateFile('application/commands.ts', gateFiles), '前置：发起方必须是登记的新实现').toBe(true)
    const intoGate = [
      {
        fromFile: path.join(SRC_ROOT, 'application', 'commands.ts'),
        fromRel: 'web/src/application/commands.ts',
        fromSrcRel: 'application/commands.ts',
        specifier: '../domain/scene/internal',
        kind: 'import',
        isTypeOnly: true,
        line: 1,
        column: 1,
        syntax: "import type { X } from '../domain/scene/internal'",
      },
    ]
    const hits = GATE_RULES.find((r) => r.id === 'gate/no-private-cross-layer').check(intoGate, ctx)
    expect(hits, '新实现跨层导入深于公共出口的实现必须判红（公共出口上限 = 2）').toHaveLength(1)
    expect(hits[0].detail).toContain('深度 3')
  })

  it('负对照 D0：公共出口本身（深度 2）不判红 —— 否则规则会退化成"禁止一切跨层导入"', () => {
    const { ctx } = buildCtx()
    const legal = [
      {
        fromFile: path.join(SRC_ROOT, 'application', 'commands.ts'),
        fromRel: 'web/src/application/commands.ts',
        fromSrcRel: 'application/commands.ts',
        specifier: '../domain/scene',
        kind: 'import',
        isTypeOnly: true,
        line: 1,
        column: 1,
        syntax: "import type { Scene } from '../domain/scene'",
      },
      {
        fromFile: path.join(SRC_ROOT, 'domain', 'editing.ts'),
        fromRel: 'web/src/domain/editing.ts',
        fromSrcRel: 'domain/editing.ts',
        specifier: './identity',
        kind: 'import',
        isTypeOnly: true,
        line: 1,
        column: 1,
        syntax: "import type { EntityRef } from './identity'",
      },
    ]
    const hits = GATE_RULES.find((r) => r.id === 'gate/no-private-cross-layer').check(legal, ctx)
    expect(hits, '同层导入与经公共出口的跨层导入都必须判绿').toEqual([])
  })

  it('负对照 D′：**旧**实现发起同一形态不判红（旧实现不受新边界约束，属债务）', () => {
    const { ctx } = buildCtx()
    const intoLegacy = [
      {
        fromFile: path.join(SRC_ROOT, 'workbench', 'components', 'WorkbenchViewport.vue'),
        fromRel: 'web/src/workbench/components/WorkbenchViewport.vue',
        fromSrcRel: 'workbench/components/WorkbenchViewport.vue',
        specifier: '@/runtime/host/workbenchHost',
        kind: 'import',
        isTypeOnly: true,
        line: 1,
        column: 1,
        syntax: "import type { X } from '@/runtime/host/workbenchHost'",
      },
    ]
    expect(isGateFile(intoLegacy[0].fromSrcRel, ctx.gateFiles), '前置：旧组件不得在执行面内').toBe(false)
    const hits = GATE_RULES.find((r) => r.id === 'gate/no-private-cross-layer').check(intoLegacy, ctx)
    expect(hits, '旧→旧 深导入是 #249 §15 遗留债务（P6 退役），不是本批新边界的 finding').toEqual([])
  })
})
