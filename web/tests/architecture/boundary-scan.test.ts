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
  classifyExternal,
  collectLegacyDebt,
  corePurityFileSet,
  isGateFile,
  parsePBatch,
  resolveGateLayers,
  resolveInternalTarget,
  ruleCoreNoDomGlobals,
  topLayer,
  unconsumedExternalClasses,
} from './boundary-rules.mjs'
import { WEB_ROOT, buildAstIndex, buildModuleGraph, collectSourceFiles, extractGlobalRefs, extractImports, extractMethodCallSites } from './module-graph.mjs'

const SRC_ROOT = path.join(WEB_ROOT, 'src')

/**
 * 读源码并**归一化行尾为 LF**（EOL 脆性的治本处，见 `freeze-convergence.test.ts` 的长注释）。
 *
 * 本仓 `core.autocrlf=true` ⇒ 新鲜检出是 CRLF、执行者工具写出的工作树常是 LF。
 * 凡断言里用裸 `\n` 字面量（正则、`indexOf('\n\n')`、按行切片），判据就会随检出
 * 口径变化。在唯一读入口归一化后，"用 `\n` 写字面量"重新安全。
 *
 * 2026-10-11 合流事故：集成树 `96b2e3b` 上 `freeze-convergence.test.ts:303` 因
 * `\n\n` 失配判红（该测试在 LF 树上绿）。
 */
function readSource(absPath: string): string {
  return fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n')
}

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

    // ── 不变量 1b：执行面只由 #249 §4 的目标分层构成 ──
    // P2（#253）在 P1 的文件级口径上补一条：`gateFiles` 的每一项都必须落在某个
    // 目标分层的 `src/<层>/` 前缀下。这防的是「执行面里混进一个不属于任何层的路径」
    // （例如误把 `pure/x.ts` 登记成新实现）——那种项会让闸门在错误的面上判绿。
    // 注：**不**断言「执行面为空」（那是 P0 的目录快照，已被 P1 的文件级口径取代）；
    // 空洞真的披露义务由不变量 3 承担。
    for (const f of gateFiles) {
      const layer = topLayer(f)
      expect(LAYERS, `执行面路径 ${f} 必须属于目标分层之一`).toContain(layer)
    }

    // ── 不变量 2：闸门规则 0 finding（无论执行面是否为空）──
    for (const rule of GATE_RULES) {
      expect(rule.check(productionFacts, ctx), `规则 ${rule.id} 不应有 finding`).toEqual([])
    }
    const astIndex = buildAstIndex(productionFiles)
    expect(GATE_RULES.filter((r) => r.needsAst).flatMap((r) => r.checkWithAst(astIndex, ctx))).toEqual([])
    expect(productionFiles.length).toBeGreaterThan(200)

    // ── 不变量 3：空洞真必须被**如实披露**，不得冒充"边界已生效" ──
    //
    // P1 把执行面升级为**文件级**（`gateFiles`）后，「空洞」的含义也随之变化：
    // 不再是「执行面为空」，而是「**某条规则实际受检的文件数为 0**」。
    // 与 `scan-boundaries.mjs` 用**同一口径**计算 `evaluatedFiles`
    // （`ruleCoreNoVueThree`/`ruleCoreNoDomGlobals` 按 `coreFiles` 过滤，
    // 其余规则按 `isGateFile` 过滤），故这里的结论与扫描器报告逐项一致。
    const evaluatedFor = (rule: { id: string; layerDependent?: boolean }) => {
      if (rule.layerDependent !== true) return productionFiles.length
      return productionFiles.filter((f) => {
        const rel = path.relative(SRC_ROOT, f).replace(/[\\/]+/g, '/')
        // 纯核心规则（禁 Vue/Three、禁 DOM 全局、禁 Node IO）以 `coreFiles` 为判定面；
        // 其余以 `gateFiles`。⚠️ 新增 `gate/core-*` 规则必须同批登记到本清单 ——
        // 否则空洞真判定会按 `gateFiles` 计数，从而掩盖"该规则其实无执行面"。
        const isCoreRule = rule.id.startsWith('gate/core-')
        return isCoreRule ? ctx.coreFiles.has(rel) : isGateFile(rel, gateFiles)
      }).length
    }
    for (const rule of GATE_RULES) {
      const vacuous = rule.layerDependent === true && evaluatedFor(rule) === 0
      if (vacuous) {
        // 空洞真只允许出现在「该规则的判定面**真的**没有任何生产文件」时。
        // 本树非空洞（见下方断言），故此分支是**不可能被走到**的兜底 ——
        // 一旦某批把执行面登记错了导致某规则变空洞，这里会立刻炸出来。
        expect(gateFiles.size, `规则 ${rule.id} 空洞 ⇒ 该规则的判定面必须确实为空`).toBe(0)
      }
    }
    // 关键断言（**非空洞**）：本树至少有一条执行面文件被真正受检，
    // 且 P2 新建的 `application/`、`editors/` 都在执行面内 ——
    // 于是「闸门全绿」构成"边界已生效"的证据，而不是空洞真。
    expect(gateFiles.size, '执行面必须非空').toBeGreaterThan(0)
    expect(evaluatedFor({ id: 'gate/no-barrel-smuggling', layerDependent: true })).toBeGreaterThan(0)
    expect([...gateFiles]).toContain('application/properties.ts')
    expect([...gateFiles]).toContain('editors/property-controls.ts')
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

// ─────────────────────────────────────────────────────────────────────────────
// A01（P11-E #262）· **分类器与消费者的对账**（防"写好了没人用"的漏网复发）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ## 这组用例的由来（P11-B1 审计 → P11-E 接线）
 *
 * B1 的 A01 定性逐字：`boundary-rules.mjs` 的 `classifyExternal` **已产出**
 * `'node-io'`，"但全树仅这 2 处命中、**无任何 GATE_RULE 消费它** ⇒「无 IO 依赖」
 * 这一子句的**前置件已写好却未挂上**。⇒ 今天 `import fs from 'node:fs'`
 * 可以进 `domain/` 而全绿。"
 *
 * P11-E 的处置是**接上**（而不是删分类器）：新增 `ruleCoreNoNodeIo` 并登记
 * `consumesExternalClasses`。本组把这个接线本身变成判据 —— 它要在**没有**
 * 具体违规样本的情况下也能发现"分类器无人消费"这一类缺口。
 */
describe('A01 设施自检：分类器的每个分类都必须有闸门规则消费（P11-E 接线守卫）', () => {
  it('`gate/core-no-node-io` 必须**在** `GATE_RULES` 里（A01 的 IO 子句不得再次脱线）', () => {
    // 这条断言的直接反例就是 B1 抓到的那个状态：分类器产出 `'node-io'`，
    // 但 GATE_RULES 里没有任何规则看它 ⇒ 扫描全绿而边界其实没执行。
    expect(
      GATE_RULES.map((r: { id: string }) => r.id),
      '`gate/core-no-node-io` 必须在闸门规则集内（P11-E 的 A01 接线点）',
    ).toContain('gate/core-no-node-io')
  })

  it('`unconsumedExternalClasses()` 必须为空 —— 分类器能产出的分类都有人消费', () => {
    const unconsumed = unconsumedExternalClasses()
    expect(
      unconsumed,
      `以下外部包分类**没有**任何 GATE_RULE 消费 ⇒ 它们对应的边界子句形同虚设：`
        + `${unconsumed.join(', ')}。处置二选一：①在对应规则上登记 `
        + `\`consumesExternalClasses: [...]\` 并真的判定它；②删掉该分类（须给出`
        + `"已由其他规则覆盖"的证据）。`,
    ).toEqual([])
  })

  it('**反空洞真**：分类器对三类包名给出**不同**分类（否则"都有人消费"可以靠一个桶蒙过去）', () => {
    expect(classifyExternal('vue')).toBe('vue')
    expect(classifyExternal('three')).toBe('three')
    expect(classifyExternal('node:fs')).toBe('node-io')
    expect(classifyExternal('fs')).toBe('node-io')
    expect(classifyExternal('pako')).toBe('other-external')
    // 分类器本身的判别力：同一族（IO）的两种写法必须同归一类
    expect(classifyExternal('node:path')).toBe(classifyExternal('path'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 暂存双轨登记（#250 GF-5 收敛项 4）：`composition/seams.ts`
// ─────────────────────────────────────────────────────────────────────────────

describe('暂存双轨登记：每条接缝都有负责人与**可判定**的退出条件', () => {
  it('`composition/seams.ts` 存在且可加载（装配层承载接缝声明）', async () => {
    const seams = await import(path.join(SRC_ROOT, 'composition', 'seams.ts').replace(/\\/g, '/'))
    expect(Array.isArray(seams.SEAMS), '`SEAMS` 必须是数组').toBe(true)
    expect(seams.SEAMS.length, '本批至少登记一条（属性写双轨）').toBeGreaterThan(0)
  })

  it('每条接缝字段完整，且 `owner` 是**已登记的真实批次**（P1–P11 或 P10b/P10d）', async () => {
    const { SEAMS } = await import(path.join(SRC_ROOT, 'composition', 'seams.ts').replace(/\\/g, '/'))
    /**
     * **P10b（#282）**：R-WK-04（#250，2026-10-11）新设的批次。
     *
     * ## 为什么它不在 `P_TO_ISSUE_OFFSET` 的算术表里
     *
     * `P<N> → #(251+N)` 是 #250 立项时给 **P1–P11** 定的映射。P10b 是本批
     * （#261）执行中实测发现"文档内容面无法在 P10 内完成"后由 Lead **新设**的
     * 续接批次（R-WK-04），它的 issue 号不落在那条算术序列上。
     *
     * ## 为什么不把它写成 `P10`（那会是一条假绿）
     *
     * 若把这几条接缝的 owner 写成 `P10`，本条断言会通过，但登记表就在说
     * "P10 会做这件事"——而 P10（#261）**已明确不做**（R-WK-04 裁决）。
     * 那正是本工程反复禁止的"用登记表掩盖实际未交付"。
     * ⇒ 显式登记 P10b 及其 issue/职责，并让它接受**同一套**一致性检查。
     */
    const EXTRA_BATCHES: Readonly<Record<string, { readonly issue: number; readonly duty: string }>> = Object.freeze({
      P10b: Object.freeze({ issue: 282, duty: '旧文档→内核场景装配与呈现接线' }),
      /**
       * **P10d（#289）**：R-WK-06（#250，2026-10-12）新设的续接批次。
       *
       * 与 P10b 同一处境：`P<N> → #(251+N)` 那条算术映射容不下它 —— P10c（#286）
       * 实测"内核内容面不承载几何/注解/部件"后，Lead 把内容面补全与渲染链终切
       * 拆成独立执行单。写成 `P10` 会让断言通过而登记表说谎（P10c 已明确**不**做
       * 这件事，见 R-WK-06），故与 P10b 同法显式登记，并接受**同一套**一致性检查。
       */
      P10d: Object.freeze({ issue: 289, duty: '内核内容面补全与呈现消费、渲染链终切' }),
      /**
       * **P10f（#301）**：R-WK-07（#250，2026-10-12）新设的续接批次。
       *
       * 与 P10b/P10d 同一处境：`P<N> → #(251+N)` 那条算术映射容不下它 ——
       * P10e（#299）段① 侦察实测"D4（`raw-authority-object` 终删）的 113 处命中里
       * 只有 38 处可机械替换，75 处需新能力（网格读面 / `Command` 联合扩展 /
       * 9 条未装配加载路径 / 导出面端口）"后，Lead 把 D4 + G-6 + 导出面
       * 卷出为独立执行单（子批 A–E）。
       *
       * 写成 `P10` 会让断言通过而登记表说谎（P10/#261 已关闭；P10e/#299 已明确
       * **不**做 D4，见 R-WK-07），故与前两者同法显式登记，接受**同一套**一致性检查。
       */
      P10f: Object.freeze({ issue: 301, duty: 'D4 终退统战：RuntimeDocument 退出生产、G-6 三段与导出面端口' }),
    })
    for (const s of SEAMS) {
      expect(s.id, 'id 必须是非空 kebab-case 稳定标识').toMatch(/^[a-z0-9-]+$/)
      expect(s.files.length, `${s.id} 必须列出涉及文件`).toBeGreaterThan(0)
      expect(s.newTrack, `${s.id} 缺新轨描述`).toBeTruthy()
      expect(s.oldTrack, `${s.id} 缺旧轨描述`).toBeTruthy()
      expect(s.blocker, `${s.id} 缺"为何本批不能退"的具体阻塞`).toBeTruthy()
      expect(s.exitCondition, `${s.id} 缺退出条件`).toBeTruthy()
      const extra = EXTRA_BATCHES[s.owner.p]
      if (extra !== undefined) {
        // 新设批次：P↔issue↔职责名三者仍必须自洽（与 P1–P11 同一口径）
        expect(s.owner.issue, `${s.id}：${s.owner.p} 必须对应 #${extra.issue}`).toBe(extra.issue)
        expect(s.owner.duty, `${s.id}：${s.owner.p} 的职责应为「${extra.duty}」`).toBe(extra.duty)
        continue
      }
      const p = parsePBatch(s.owner.p)
      expect(p, `${s.id} 的 owner.p 必须形如 PN（或已登记的续接批次 ${Object.keys(EXTRA_BATCHES).join('/')}）`).not.toBeNull()
      expect(p!).toBeGreaterThanOrEqual(1)
      expect(p!).toBeLessThanOrEqual(11)
      // P ↔ issue ↔ 职责名三者一致（与 RETIREMENT_OWNERS 同一套判据）
      expect(s.owner.issue, `${s.id}：${s.owner.p} 必须对应 #${P_TO_ISSUE_OFFSET + p!}`).toBe(P_TO_ISSUE_OFFSET + p!)
      expect(s.owner.duty, `${s.id}：${s.owner.p} 的职责应为「${P_DUTIES[s.owner.p]}」`).toBe(P_DUTIES[s.owner.p])
    }
  })

  it('退出条件是**可判定的**：不得是"迁移完成后"这类空话（含文件名或可测断言）', async () => {
    const { SEAMS } = await import(path.join(SRC_ROOT, 'composition', 'seams.ts').replace(/\\/g, '/'))
    for (const s of SEAMS) {
      // 空话清单：这些短语无法核对，出现即判红。
      for (const vague of ['完成后', '后续处理', '待定', 'TODO', '视情况']) {
        expect(s.exitCondition, `${s.id} 的退出条件含空话「${vague}」`).not.toContain(vague)
      }
      // 必须指名**可核对的对象**：至少一个涉及文件在退出条件里被点名。
      const named = s.files.some((f: string) => s.exitCondition.includes(f))
      expect(named, `${s.id} 的退出条件必须点名可核对的产物（文件路径）`).toBe(true)
    }
  })

  it('**反空洞真**：登记的旧轨在代码里**确实存在**（否则登记表是空转）', async () => {
    const { SEAMS } = await import(path.join(SRC_ROOT, 'composition', 'seams.ts').replace(/\\/g, '/'))
    const entry = SEAMS.find((s: { id: string }) => s.id === 'kernel-property-write-dual-track')
    expect(entry, '必须登记属性写双轨').toBeTruthy()

    // ## ⚠️ 本断言已**翻转**（#301 P10f D3 的终删落点）
    //
    // 原断言是 **failure-closed** 的："`workbench-rna.ts` 必须**仍**经
    // `ctx.getDoc()` 读旧文档 + `getDoc()` 的类型必须仍是 `Ref<RuntimeDocument | null>`"
    // —— 它描述的是"双轨仍在"这一事实，故 D3 完成后**必然**要先改它，否则交付时恒红。
    //
    // D3 之后的事实分两半（各自都要有判据，不能只留"删干净了"）：
    //
    // | 事实 | 判据 |
    // |---|---|
    // | ① 旧轨的**读入口**已消失 | `getDoc()` 全树 0 命中（含声明位与引用位） |
    // | ② 旧轨的**数据模型**仍在（`DocumentState.document` 仍是旧文档，因为它要交付给 `applySetProperty`） | `workbench-rna` 经**具名**取值口 `legacyDocumentModel()` 取，且**不得**再直读 `main.doc` |
    //
    // ② 是"双轨仍登记在案"的真实依据（登记表不能空转），而它**不是**"读入口回来了"：
    // `legacyDocumentModel()` 的调用者由下一条判据（白名单闭集）钉死为**恰好两处**。
    const rna = readSource(path.join(SRC_ROOT, 'editors', 'workbench-rna.ts'))
    const codeOnly = rna
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n')
    expect(codeOnly, '`getDoc()` 访问器已终删 ⇒ 面板侧不得再出现').not.toContain('.getDoc(')
    expect(codeOnly, '旧轨的**数据模型**仍需要旧文档 ⇒ 经具名取值口').toContain('legacyDocumentModel()')
    //  ② 该访问器**确实**在 `runtime/context.ts` 声明（否则上面的 toContain 是空转）
    const ctxSrc = readSource(path.join(SRC_ROOT, 'runtime', 'context.ts'))
    expect(ctxSrc, '`legacyDocumentModel()` 必须在 `Context` 上声明').toMatch(
      /legacyDocumentModel\(\):\s*RuntimeDocument \| null/,
    )
    expect(
      /getDoc\(\):\s*Ref<RuntimeDocument \| null>/.test(ctxSrc),
      '`getDoc()` 的签名必须**已不存在**（D3 终删）',
    ).toBe(false)

    // 登记项声明的阻塞点也必须真实：内核侧写入口已在（新轨已交付）。
    expect(
      fs.existsSync(path.join(SRC_ROOT, 'application', 'kernel-properties.ts')),
      '新轨（内核属性注册）必须已交付，否则"双轨"说法不成立',
    ).toBe(true)
    // 且新轨**真的**被 `reduceSetProperty` 用上（不是"有个文件摆着"）。
    const commands = readSource(path.join(SRC_ROOT, 'application', 'commands.ts'))
    expect(commands, '新轨必须真实接入命令层').toContain('kernelPropertyRegistry()')
  })

  /**
   * ## G-6（#286 P10c 扫尾）：`fidelity-record-transport-unwired` 的**反空洞真**
   *
   * 这条接缝是本批**新登记**的（P9 的 G-6 缺口此前只活在临时目录里的报告散文中）。
   * 一条新登记的接缝若"旧轨"在代码里查不到，那它就是空转 —— 登记表会显得
   * 管着一件事，而实际没有。故逐条核对它声明的三段缺口**当下确实成立**：
   * 记录机制存在、生产者缺失、产物侧挂点零调用方。
   *
   * 这三条同时是**退出条件的判据面**：任何一个翻转（有人接上生产者/挂点），
   * 就说明该接缝可以核销，本组断言会判红并要求同批更新登记 —— 这正是
   * "登记表 = 现状清单"该有的性质。
   */
  it('**反空洞真（G-6）**：`fidelity-record-transport-unwired` 的 (a)(b)(c-接线) 已闭合、(c-终切) 仍登记', async () => {
    const { SEAMS } = await import(path.join(SRC_ROOT, 'composition', 'seams.ts').replace(/\\/g, '/'))
    const entry = SEAMS.find((s: { id: string }) => s.id === 'fidelity-record-transport-unwired')
    expect(entry, 'G-6 的传输缺口必须登记（否则它只活在报告散文里，P11 无法机械核对）').toBeTruthy()
    // ## #301 P10f D1：owner 从 P10d 转到 P10f
    //
    // P10d（#289）只做登记、未做三段中的任何一段；D1 做了 (a)+(b)，
    // 剩下的 (c) 也是本批 D2 的范围 ⇒ 迁移职责整体归 P10f。
    // ⚠️ 这条断言**不是**为了变绿而改：owner 必须指向"真正会做迁移的批次"，
    // 否则 seam 会挂在一个不动的批次名下而**永无退出**（P10c 的 P11 误登记同族教训）。
    expect(entry.owner.p, 'G-6 已转入 P10f（D1 做了 a+b，c 归 D2）').toBe('P10f')

    // 新轨（记录机制）**确实存在**：不是"登记了一个没实现的机制"。
    const fidelity = readSource(path.join(SRC_ROOT, 'adapters', 'files', 'fidelityRecord.ts'))
    for (const needle of ['captureFidelity', 'serializeFidelity', 'fidelityStorageKey', 'judgeFidelityAfterEdit']) {
      expect(fidelity, `新轨必须真的提供 ${needle}`).toContain(needle)
    }
    // (b) ✅ D1 已闭合：键口径并入 recovery/save 家族（有解析器 + 被分类器识别）。
    const recovery = readSource(path.join(SRC_ROOT, 'application', 'recovery.ts'))
    expect(recovery, 'D1(b)：保真键的权威构造器必须在 recovery 家族里').toContain('fidelityStoreKey')
    expect(recovery, 'D1(b)：必须有解析器（旧方案结构上不可逆）').toContain('parseFidelityStoreKey')
    expect(recovery, 'D1(b)：必须被制品分类器识别').toContain('FIDELITY_ARTIFACT')

    // (a) 生产者：**D1(a) 已接线**（原先是"唯一消费者只数数"）。
    //
    // ## P10d（#289）D1：锚点**搬家**（不是缺口消失）
    //
    // D1 把装配实现从 `docLifecycleOperators.ts` 移进 `composition/documentLoad`
    // （统一两条加载脊柱），于是"只数数"的那一行也随之搬走。
    // 当时缺口**仍成立**，故本条改为在**新家**断言，并补一条全树判据。
    //
    // ## #301 P10f D1(a)：缺口**已闭合**（本条再次改判据，而不是删判据）
    //
    // 采集已接线 ⇒ "只数数"的描述不再成立。本条现在守的是：
    // ① 计数日志**保留**（诊断对账价值不变）；② 采集调用**存在**；
    // ③ 全树接线点**精确等于**两个文件（多一个 = 有人绕过采集入口）。
    const lifecycle = readSource(path.join(SRC_ROOT, 'composition', 'documentLoad.ts'))
    // ## #301 P10f D1(a)：本条已从"只被计数"改为"**同时**被计数与采集"
    //
    // 原先断言的是「`unknownFields` 必须**仍只**被计数」—— 那描述的是**缺口**
    // （生产者未接线）。D1(a) 接线后该描述不再成立，故本条改为断言**新事实**：
    // 计数日志**保留**（它对账价值不变）+ 采集调用**存在**。
    // ⚠️ 不是"删掉判据"：判据仍在，只是它现在守的是"两者都在"。
    expect(lifecycle, '计数日志必须保留（诊断对账价值不变）').toContain(
      'Object.keys(value.unknownFields).length',
    )
    expect(lifecycle, 'D1(a)：未装配产物的未知字段必须被**采集**（不只是计数）').toContain(
      'captureFidelityFieldMap(',
    )
    // 全树：生产者**已**接线 ⇒ 显式列出接线的两个文件（而不是判空）。
    const srcFilesForProducer: string[] = []
    const walkProducer = (dir: string): void => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name)
        if (ent.isDirectory()) {
          if (ent.name === '__tests__' || ent.name === 'node_modules') continue
          walkProducer(full)
        } else if (/\.(ts|vue)$/.test(ent.name)) {
          srcFilesForProducer.push(full)
        }
      }
    }
    walkProducer(SRC_ROOT)
    /** 剥注释**与字符串**（与下面 (c) 段的 `codeOnly` 同一把尺子；本段自带一份）。 */
    const stripForProducer = (text: string): string =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    const producerCallers = srcFilesForProducer
      .filter((abs) => !abs.endsWith(path.join('adapters', 'files', 'fidelityRecord.ts')))
      .filter((abs) => stripForProducer(readSource(abs)).includes('captureFidelity'))
      .map((abs) => path.relative(SRC_ROOT, abs).replace(/\\/g, '/'))
    // ## #301 P10f D1(a)：从"判空"改为"**精确等值**"（不是放松，是换守的对象）
    //
    // 原断言 `toEqual([])` 守的是"(a) 尚未接线"。D1(a) 接线后它**必然**判红 ——
    // 闸门用"要求同批更新登记"的方式提醒，而不是静默通过（这正是它该有的性质）。
    // 新的精确等值把"接线点"钉死：多出第三个调用方 = 有人绕过了采集入口 ⇒ 判红。
    expect(
      producerCallers.sort(),
      '(a) 生产接线点必须**恰好**是这两个：深度 2 的扁平模块 + 装配路径',
    ).toEqual(['adapters/fidelityCapture.ts', 'composition/documentLoad.ts'])

    // 且文件选择器路径不再持有它（D1 的另一半：实现已移出该文件）
    const operatorFile = readSource(path.join(SRC_ROOT, 'operators', 'builtin', 'docLifecycleOperators.ts'))
    expect(operatorFile, 'D1 后 operator 不再持有装配实现（只转发）').not.toContain(
      'Object.keys(value.unknownFields).length',
    )

    // (c) 产物侧挂点零生产调用方：只被定义处与**登记表自己的散文**引用。
    const projection = readSource(path.join(SRC_ROOT, 'composition', 'kernelProjection.ts'))
    expect(projection, '产物侧既定挂点必须存在（否则"缺口"的说法不成立）').toContain('fidelityFields')
    // 自己走一遍 `src/`（不用测试内的局部 `productionFiles`，那在另一条用例里）：
    // 只看**生产**文件（排除 `__tests__`），且排除定义处本身。
    const srcFiles: string[] = []
    const walk = (dir: string): void => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name)
        if (ent.isDirectory()) {
          if (ent.name === '__tests__' || ent.name === 'node_modules') continue
          walk(full)
        } else if (/\.(ts|vue)$/.test(ent.name)) {
          srcFiles.push(full)
        }
      }
    }
    walk(SRC_ROOT)
    /**
     * 剥注释**与字符串**（本仓 `seams.test.ts` 的 `codeOf` 同一把尺子）。
     *
     * 为什么必须这么做：接缝登记表**就是**用字符串描述旧轨的，其中必然出现
     * `projectKernelDocument` 这个名字。"提到某函数名"不等于"调用它" ——
     * 若用原文匹配，本条断言会因**自己的登记说明**而恒红（P6 实测过的假红同族）。
     */
    const codeOnly = (text: string): string =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    const projectionImporters = srcFiles
      .filter((abs) => !abs.endsWith(path.join('composition', 'kernelProjection.ts')))
      .filter((abs) => codeOnly(readSource(abs)).includes('projectKernelDocument'))
      .map((abs) => path.relative(SRC_ROOT, abs).replace(/\\/g, '/'))
    /**
     * ## P10d D2 的语义更正（本条原先用的判据已不再等价于缺口）
     *
     * 原断言是「`projectKernelDocument` 生产零调用方」—— 那是 (c) 的**代理判据**：
     * 当时它零调用方，故"挂点没接上"显然成立。
     *
     * D2（#289）让**渲染路径**经 `composition/kernelRenderView` 调它
     * （`renderView` 模式：内核求值 → 渲染视图文档）。于是那个代理判据不再等价 ——
     * 有了调用方，但 (c) 说的**不是**"没人调投影"，而是
     * 「保真记录**随产物一起传**」那条路没接上。
     *
     * ⇒ 改为直接判**缺口本身**：`fidelityFields` 有没有生产调用方在**产物侧**传入。
     * 这既更准确，也不会因"投影被别的用途用上了"而误判缺口闭合。
     */
    const fidelityCallers = srcFiles
      .filter((abs) => !abs.endsWith(path.join('composition', 'kernelProjection.ts')))
      .filter((abs) => codeOnly(readSource(abs)).includes('fidelityFields'))
      .map((abs) => path.relative(SRC_ROOT, abs).replace(/\\/g, '/'))
    // ## #301 P10f D2：从"判空"改为"**精确等值**"（不是放松，是换守的对象）
    //
    // 原断言 `toEqual([])` 守的是"(c) 产物侧挂点无生产传值方"。D2 把 12 处产字节
    // 节点改吃 `ctx.plainForSave()` ⇒ 挂点**已接线**，本条**必然**判红 —— 闸门用
    // "要求同批更新登记"的方式提醒，而不是静默通过（这正是它该有的性质）。
    //
    // ⚠️ 新的精确等值把"接线点"钉死：**只能**是 `composition/saveProjection.ts`
    // （保存读面的唯一装配点）。多出第二个 = 有人绕过唯一装配点自己拼 `fidelityFields`
    // ⇒ 判红（那正是"漏一样就静默产出错误产物"的复发形态）。
    //
    // ⚠️ 并且：**接线 ≠ 缺口闭合**。seam `fidelity-record-transport-unwired` 的
    // `exitCondition` 保持登记（保存路径的 legacy 回落分支仍在，"`RuntimeDocument`
    // 退出生产"未达成）—— 核销会让"保存路径尚未终切"失去登记。
    expect(
      fidelityCallers,
      `(c) 产物侧 fidelityFields 的传值方必须**恰好**是"保存读面的唯一装配点"（多一个 = 有人绕过了它）`,
    ).toEqual(['composition/saveProjection.ts'])
    // 反空洞真：投影**确实**已被生产调用（D2 的渲染路径）—— 故上面那条判据
    // 测的是"保真挂点未接"，不是"没人用投影"。少了这条，本组会退化成恒真。
    expect(
      projectionImporters,
      '前提：投影已被生产调用（D2 渲染路径）⇒ 本组测的是保真挂点，不是"投影没人用"',
    ).toEqual(['composition/kernelRenderView.ts'])
  })

  /**
   * ## D-7：删访问器后的**防绕过**闸门（#301 P10f D3；Lead 裁决 D-7）
   *
   * ### 为什么"`getDoc(` 零命中"**不够**
   *
   * `Context.main` 是 `public readonly`（读面都要读 `main.doc` —— 它是**响应式依赖**
   * 的唯一来源，见 `hasLoadedDocument` 的长注释）。⇒ 删掉访问器之后，一行
   * `ctx.main.doc.value` 就能把"权威读入口"原样拿回来，而"`getDoc(` 零命中"
   * 这个判据**完全看不见它** —— 那是"机械代理"而不是"判据本意"
   *（D 批映射表 §一 已澄清：删的是"以 `getDoc()` 为**权威读入口**这条路"）。
   *
   * ### 本闸门的形态：**闭集**（多一处即后门，少一处即腐烂）
   *
   * 逐个扫 `src/` 生产文件找出所有直接读 `main.doc` 的位置，与白名单逐条对账。
   * 白名单每条都写清"为什么它必须读本体而不能用某个读面"—— 于是这张表本身就是
   * "旧数据模型还剩几处欠账、各自归谁"的可核对面。
   */
  it('**D-7 防绕过**：`main.doc` 直接读取点恰为白名单闭集；`legacyDocumentModel()` 调用者恰两处', () => {
    /** 剥注释与**字符串**（与 `retirementRegistry` 的 `stripNonCode` 同一把尺子）。 */
    const codeOf = (text: string): string =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``')

    /**
     * 白名单（`src/` 相对路径 → 该文件允许出现直接读 `main.doc` 的理由）。
     *
     * ⚠️ 每条都必须能回答："为什么这里不能用 `hasLoadedDocument()` / `kernelGrid()` /
     * `frameDeclarations()` / `plainForSave()` …？"答不上来的条目就是**后门**。
     */
    const ALLOWED: Record<string, string> = {
      'runtime/context.ts':
        '读面本体：`hasLoadedDocument`/`frameDeclarations`/`plainForSave`/`kernelAnnotations`/'
        + '`kernelMaterials`/`kernelGrid`/`cellTooltips`/`documentMetadata`/`legacyDocumentModel`/'
        + '`legacyGridForEdit`/`legacyRenderSource`/`setDocument` 都在此文件内读 `main.doc`'
        + '（响应式依赖 + 唯一写入口的落点）。',
      // ⚠️ `runtime/main.ts` **不**在本表内（实测）：它写的是 `this.doc.value = doc`
      //（**赋值**，不是读 `main.doc`）⇒ 本闸门的正则（`.main.doc`）看不见它。
      // 它的"唯一赋值点"性质由另一条既有判据把守
      //（`p10fExistenceReadFace.test.ts` 的"`main.doc.value =` 只在 `runtime/main.ts`"）。
      // 我第一版把它登记进来 ⇒ **被本判据的"腐烂"半边当场判红**
      //（"白名单里有已不存在的登记"）—— 这正是闭集双向对账该有的性质。
    }

    const walkSrc = (fn: (rel: string, abs: string) => void): void => {
      const walk = (dir: string): void => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, ent.name)
          if (ent.isDirectory()) {
            if (ent.name === '__tests__' || ent.name === 'node_modules') continue
            walk(full)
            continue
          }
          if (!/\.(ts|vue)$/.test(ent.name)) continue
          if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(ent.name) || /\.d\.ts$/.test(ent.name)) continue
          fn(path.relative(SRC_ROOT, full).replace(/\\/g, '/'), full)
        }
      }
      walk(SRC_ROOT)
    }

    const hits: string[] = []
    const modelCallers: string[] = []
    walkSrc((rel, abs) => {
      const code = codeOf(readSource(abs))
      if (/\.main\s*\.\s*doc\b/.test(code)) hits.push(rel)
      if (rel !== 'runtime/context.ts' && /legacyDocumentModel\s*\(/.test(code)) modelCallers.push(rel)
    })

    const allowed = Object.keys(ALLOWED)
    const unexpected = hits.filter((h) => !allowed.includes(h)).sort()
    const rotten = allowed.filter((f) => !hits.includes(f)).sort()
    expect(
      unexpected,
      '`main.doc` 出现**未登记**的直接读取点 ⇒ 它是绕过具名读面的后门：\n' + unexpected.join('\n'),
    ).toEqual([])
    expect(rotten, '白名单里有**已不存在**的登记 ⇒ 清单腐烂，请同步核销：\n' + rotten.join('\n')).toEqual([])
    expect(
      modelCallers.sort(),
      '`Context#legacyDocumentModel()` 的调用者**恰为两处**'
        + '（`property-write-legacy-document-model` 与 `legacy-document-in-place-edit`）；'
        + '多一处即为绕过具名读面的后门。',
    ).toEqual(['context/captureEmbedInitialView.ts', 'editors/workbench-rna.ts'])
  })

  it('**负对照**：上一条判据能抓到绕过（`ctx.main.doc.value` 必被判红）', () => {
    const codeOf = (text: string): string =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    const isHit = (src: string): boolean => /\.main\s*\.\s*doc\b/.test(codeOf(src))
    expect(isHit('const d = ctx.main.doc.value'), 'ctx.main.doc.value 必须判红').toBe(true)
    expect(isHit('const d = this.main.doc.value'), 'this.main.doc.value 必须判红').toBe(true)
    expect(isHit('const d = ctx.main . doc .value'), '空白变体必须判红').toBe(true)
    // 真判据**不得**被散文或字符串骗过（否则登记表本身就是自己的假红来源）
    expect(isHit('// 见 ctx.main.doc.value 的说明'), '注释不算绕过').toBe(false)
    expect(isHit("const s = 'ctx.main.doc.value'"), '字符串不算绕过').toBe(false)
  })

  it('**负对照**：未登记的接缝判据能抓到"旧轨仍在但没有登记"', async () => {
    const { SEAMS } = await import(path.join(SRC_ROOT, 'composition', 'seams.ts').replace(/\\/g, '/'))
    const claim = (oldTrackPresent: boolean, registered: boolean): boolean =>
      oldTrackPresent && !registered // 「有旧轨但没登记」= 违规
    expect(claim(true, false), '有旧轨且未登记 ⇒ 必须判红').toBe(true)
    expect(claim(true, true), '有旧轨且已登记 ⇒ 不判红').toBe(false)
    expect(claim(false, false), '无旧轨 ⇒ 不判红').toBe(false)
    // 现实核对：当下确实是"有旧轨 + 已登记"。
    expect(SEAMS.some((s: { id: string }) => s.id === 'kernel-property-write-dual-track')).toBe(true)
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

// ─────────────────────────────────────────────────────────────────────────────
// #301 P10f A′：文档替换的**唯一写入口**（机械拒绝绕过）
// ─────────────────────────────────────────────────────────────────────────────

describe('#301 A′：`Main.replaceDoc` 只允许被 `Context.setDocument` 调用', () => {
  /**
   * 白名单：允许出现 `.replaceDoc(` **调用位**的生产文件（`src/` 相对）。
   *
   * ## 为什么只有这两个（各自的理由不同）
   *
   * | 文件 | 为什么允许 |
   * |---|---|
   * | `runtime/context.ts` | `Context.setDocument` 的**实现本体** —— 它就是那个唯一入口 |
   * | `runtime/main.ts` | `Main.replaceDoc` 的**定义**所在。⚠️ 定义位是**无点号**的类成员声明（`replaceDoc(doc): void {`），AST 按"属性访问调用"判定时**不会**命中它；此处列出是为**可读性**（读者一眼看到"定义与调用各在哪"），不是判据需要 |
   *
   * ## 为什么这条闸门值得存在（A′ 存在的全部理由）
   *
   * A′ 把 21 处裸调收口成 `ctx.setDocument`，而 `setDocument` 会同时镜像内核的
   * 装载状态（GF-15）。若将来有人新写一处 `ctx.main.replaceDoc(...)`：
   *  - legacy 照常工作（**不会**报错）；
   *  - 内核装载状态悄悄错位 ⇒ 后续批次把 `getDoc().value !== null` 换成
   *    `hasLoadedDocument()` 时，那处会**静默**改行为。
   *
   * 那种失效正是"机械替换换错语义"的形态，且**只会在很晚才暴露**。
   * ⇒ 在收口的同时把"绕过"变成**判红**，而不是靠评审记得。
   */
  const ALLOWED = ['runtime/context.ts', 'runtime/main.ts']

  it('生产里 `.replaceDoc(` 的调用位只出现在白名单文件（注释/字符串不计）', () => {
    const files = collectSourceFiles(SRC_ROOT)
    const offenders: string[] = []
    for (const abs of files) {
      const rel = path.relative(SRC_ROOT, abs).replace(/[\\/]+/g, '/')
      if (!isProductionRel(rel)) continue
      for (const site of extractMethodCallSites(abs, 'replaceDoc')) {
        if (!ALLOWED.includes(rel)) offenders.push(`${rel}:${site.line}  ${site.text}`)
      }
    }
    expect(
      offenders,
      '文档替换必须经 `Context.setDocument`（它同时镜像内核装载状态，GF-15）。\n' +
        '绕过会让内核装载状态静默错位，而 legacy 照常工作 ⇒ 不会报错。\n' +
        `违例：\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('**反空洞真**：`setDocument` 本体确实调用它（否则上一条是空转）', () => {
    // 若哪天 `setDocument` 改成不调 `replaceDoc`（例如自己直接写 `main.doc`），
    // 上一条会**照样绿**（白名单里没有命中）—— 而那是判据失去对象，不是合规。
    const sites = extractMethodCallSites(path.join(SRC_ROOT, 'runtime', 'context.ts'), 'replaceDoc')
    expect(sites.length, '`Context.setDocument` 必须真的调用 `main.replaceDoc`').toBeGreaterThan(0)
  })

  it('**负对照**：AST 判据不把注释与字符串算成调用位（正则版会）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-replacedoc-'))
    try {
      const file = path.join(dir, 'sample.ts')
      fs.writeFileSync(
        file,
        [
          '// ctx.main.replaceDoc(x)   ← 注释，不得计入',
          'const s = "ctx.main.replaceDoc(y)"   // 字符串，不得计入',
          'export function replaceDoc(doc: unknown): void { void doc }   // 定义位（无点号），不得计入',
          'export function ok(ctx: any, z: unknown): void { ctx.main.replaceDoc(z) }   // 真调用，必须计入',
        ].join('\n'),
        'utf8',
      )
      const sites = extractMethodCallSites(file, 'replaceDoc')
      expect(sites.map((s) => s.line), '只允许最后一行（真调用）命中').toEqual([4])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
