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
  parsePBatch,
  resolveGateLayers,
  resolveInternalTarget,
  topLayer,
} from './boundary-rules.mjs'
import { WEB_ROOT, buildAstIndex, buildModuleGraph, extractImports } from './module-graph.mjs'

const SRC_ROOT = path.join(WEB_ROOT, 'src')

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
      fs.writeFileSync(
        file,
        ["import type { Ref } from 'vue'", "import { ref } from 'vue'"].join('\n'),
        'utf8',
      )
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
      fs.writeFileSync(
        file,
        ["const a = await import('./static-target')", 'const b = await import(someVar)', "const c = require('fs')"].join(
          '\n',
        ),
        'utf8',
      )
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
  it('扫描本树：闸门规则全部 0 finding，且报告如实标注空洞真', () => {
    const { files, facts } = buildModuleGraph()
    const produced = (f) => {
      const rel = path.relative(SRC_ROOT, f).replace(/[\\/]+/g, '/')
      if (rel.startsWith('..')) return false
      if (rel.split('/').slice(0, -1).includes('__tests__')) return false
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)) return false
      return true
    }
    const productionFiles = files.filter(produced)
    const productionFacts = facts.filter((f) => produced(f.fromFile))
    const { present: gateLayers, legacyCollisions } = resolveGateLayers(SRC_ROOT)
    const ctx = { srcRoot: SRC_ROOT, webRoot: WEB_ROOT, gateLayers, layerCollisions: legacyCollisions }

    // 本批（P0）不建新层 ⇒ 执行面为空，闸门"绿"是空洞真。#249 §4。
    expect(gateLayers).toEqual([])

    for (const rule of GATE_RULES) {
      expect(rule.check(productionFacts, ctx), `规则 ${rule.id} 不应有 finding`).toEqual([])
    }
    const astIndex = buildAstIndex(productionFiles)
    expect(rulesWithAst().flatMap((r) => r.checkWithAst(astIndex, ctx))).toEqual([])
    expect(productionFiles.length).toBeGreaterThan(200)
  })

  it('目录名撞车被识别：旧 runtime/ 不得被当成新 runtime 层（防假绿）', () => {
    const { legacyCollisions } = resolveGateLayers(SRC_ROOT)
    const layers = legacyCollisions.map((c) => c.layer)
    // web/src/runtime 确实存在，但它承载旧实现（#249 §17 抽查点 renderEngine/sessionStore/chromeBinder）
    expect(fs.existsSync(path.join(SRC_ROOT, 'runtime'))).toBe(true)
    expect(layers).toContain('runtime')
  })

  it('债务清单可复现：旧目录跨目录 barrel 转出口被计数且带文件行号', () => {
    const { files, facts } = buildModuleGraph()
    const productionFacts = facts.filter((f) => !/__tests__|\.test\.|\.spec\./.test(f.fromRel))
    const { present: gateLayers, legacyCollisions } = resolveGateLayers(SRC_ROOT)
    const ctx = { srcRoot: SRC_ROOT, webRoot: WEB_ROOT, gateLayers, layerCollisions: legacyCollisions }
    const debt = collectLegacyDebt(productionFacts, ctx, [])
    expect(debt['legacy-barrel-reexport'].length).toBeGreaterThan(0)
    for (const item of debt['legacy-barrel-reexport']) {
      expect(item.file).toMatch(/^src\//)
      expect(item.line).toBeGreaterThan(0)
      expect(typeof item.syntax).toBe('string')
    }
    // 稳定排序 ⇒ 两次运行的清单逐项一致（可对账）
    const again = collectLegacyDebt(productionFacts, ctx, [])
    expect(JSON.stringify(again['legacy-barrel-reexport'])).toBe(
      JSON.stringify(debt['legacy-barrel-reexport']),
    )
  })

  it('#249 §15 十三条退役条目均有负责批次与退出阶段', () => {
    const entries = Object.entries(RETIREMENT_OWNERS)
    expect(entries).toHaveLength(13)
    for (const [slug, owner] of entries) {
      expect(slug, 'slug 必须是非空稳定标识').toMatch(/^[a-z0-9-]+$/)
      expect(owner.entries.length, `${slug} 必须标注覆盖的 §15 行号`).toBeGreaterThan(0)
      expect(owner.owners.length, `${slug} 必须至少有一个负责批次`).toBeGreaterThan(0)
      expect(owner.exitStage, `${slug} 缺退出阶段`).toMatch(/^P\d+ 交付同批/)
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
        expect(
          o.issue,
          `${slug}：${o.p} 必须对应 #${P_TO_ISSUE_OFFSET + p}，实得 #${o.issue}`,
        ).toBe(P_TO_ISSUE_OFFSET + p)
        // ② P ↔ 职责名（逐字对 #250 表）
        expect(
          o.duty,
          `${slug}：${o.p} 的职责应为「${P_DUTIES[o.p]}」，实得「${o.duty}」`,
        ).toBe(P_DUTIES[o.p])
      }
    }
  })

  it('P_DUTIES 表覆盖 P1–P11 且与被断言引用的批次名一一对应（防表本身写错）', () => {
    expect(Object.keys(P_DUTIES)).toEqual([
      'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11',
    ])
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
})

describe('A01 目标分层清单与 #249 §4 一致', () => {
  it('LAYERS 覆盖 #249 §4 的全部九个分层', () => {
    expect(LAYERS).toEqual([
      'domain',
      'application',
      'runtime',
      'presentation',
      'editors',
      'shells',
      'adapters',
      'composition',
      'entries',
    ])
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
    })
    expect(resolveInternalTarget(mk('@/pure/vec'), SRC_ROOT)).toBe('pure/vec')
    expect(resolveInternalTarget(mk('../pure/vec'), SRC_ROOT)).toBe('pure/vec')
    expect(resolveInternalTarget(mk('vue'), SRC_ROOT)).toBeNull()
    expect(resolveInternalTarget(mk('three'), SRC_ROOT)).toBeNull()
    expect(resolveInternalTarget(mk('«dynamic:x»'), SRC_ROOT)).toBeNull()
    expect(topLayer('pure/vec')).toBe('pure')
  })
})

function rulesWithAst() {
  return GATE_RULES.filter((r) => r.needsAst)
}
