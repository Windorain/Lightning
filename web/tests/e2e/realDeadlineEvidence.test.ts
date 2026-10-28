/**
 * 真实 deadline 证据解析器的单测（零 Playwright）。
 *
 * 重点不是"合法 fixture 能过"，而是**合成反例必须红**：
 *  - case1 缺 attribution、case2 有 ⇒ 若全局匹配就会误绿；逐 block 校验必须判 case1 红；
 *  - 重复 close / 缺 case / case 顺序错 / close 晚于 budget ⇒ 都必须红；
 *  - **close 子块**：close 只有 header、facts 落在同 case 后续 [boot-probe] ⇒ 必须红；
 *    close 子块自身完整、后续 error message 另有完整诊断 ⇒ 必须绿（不得因 case 级
 *    第二组字段假红）。
 */
import { describe, expect, it } from 'vitest'
import {
  REAL_DEADLINE_CASES,
  buildSyntheticDeadlineFixture,
  parseDeadlineCaseBlocks,
  syntheticValidatorSelfTest,
  validateDeadlineEvidence,
} from '../../e2e/helpers/realDeadlineEvidence.mjs'

const reporterText = REAL_DEADLINE_CASES.map((c: { timeout: RegExp }) => c.timeout.source).join('\n')

describe('deadline 证据：逐 case 校验', () => {
  it('合法 fixture ⇒ 2 个 block、逐 case 事实绑定正确', () => {
    const verdict = validateDeadlineEvidence({
      caseText: buildSyntheticDeadlineFixture(),
      reporterText,
    })
    expect(verdict.ok, verdict.errors.join(' | ')).toBe(true)
    expect(verdict.blocks).toBe(2)
    expect(verdict.cases).toHaveLength(2)
    expect(verdict.cases[0]!.facts.budget).toContain('basis=anchor-estimate')
    expect(verdict.cases[0]!.facts.attribution).toContain('WorkbenchRoot.vue')
    expect(verdict.cases[1]!.facts.attribution).toContain('document')
    expect(verdict.cases[1]!.facts.nav).toContain('commits=0 failures=1')
  })

  it('合成反例自测：6 个反例全部判红、4 个合法变体判绿', () => {
    const selfTest = syntheticValidatorSelfTest()
    expect(selfTest.ok, JSON.stringify(selfTest.checks, null, 2)).toBe(true)
    expect(selfTest.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([])
    expect(selfTest.checks.map((c: { name: string }) => c.name)).toEqual(
      expect.arrayContaining([
        'case1 缺 attribution 但 case2 有（全局匹配会误绿）',
        'case1 重复 close',
        '缺 case2',
        'case 顺序错',
        'close 晚于 budget（顺序错）',
        'close 只有 header，同 case 后续完整 [boot-probe] 提供 facts',
        '合法变体：close 子块完整，后续 error message 另有完整诊断',
        '合法变体：case1 source=late + close 模式',
        '合法变体：case2 close 模式（close 先于 goto reject）',
      ]),
    )
  })

  it('合法变体：case1 source=late + close 模式 ⇒ 绿（核心分类仍严格）', () => {
    const verdict = validateDeadlineEvidence({
      caseText: buildSyntheticDeadlineFixture({ case1LateCloseMode: true }),
      reporterText,
    })
    expect(verdict.ok, verdict.errors.join(' | ')).toBe(true)
    expect(verdict.cases[0]!.facts.budget).toContain('source=late ')
    expect(verdict.cases[0]!.facts.attribution).toContain('WorkbenchRoot.vue')
    expect(verdict.cases[0]!.facts.nav).toContain('commits=1')
  })

  it('合法变体：case2 close 模式 ⇒ 绿（core document/commits0/failures1 仍严格）', () => {
    const verdict = validateDeadlineEvidence({
      caseText: buildSyntheticDeadlineFixture({ case2CloseMode: true }),
      reporterText,
    })
    expect(verdict.ok, verdict.errors.join(' | ')).toBe(true)
    expect(verdict.cases[1]!.facts.close).toContain('页面在启动 pending 期间被关闭')
    expect(verdict.cases[1]!.facts.attribution).toContain('document')
    expect(verdict.cases[1]!.facts.nav).toContain('commits=0 failures=1')
  })

  it('合法变体：close 子块完整 + 后续完整诊断 ⇒ 绿（只认子块）', () => {
    const verdict = validateDeadlineEvidence({
      caseText: buildSyntheticDeadlineFixture({ closeFactsPlusLaterDiagnostic: true }),
      reporterText,
    })
    expect(verdict.ok, verdict.errors.join(' | ')).toBe(true)
    expect(verdict.cases[0]!.ok).toBe(true)
  })

  it('反例：close 只有 header、facts 在同 case 后续 [boot-probe] ⇒ 红在 close 子块', () => {
    const verdict = validateDeadlineEvidence({
      caseText: buildSyntheticDeadlineFixture({ closeHeaderOnlyThenFullDiagnostic: true }),
      reporterText,
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.cases[0]!.ok).toBe(false)
    expect(verdict.cases[1]!.ok).toBe(true)
    expect(verdict.cases[0]!.errors.join(' ')).toContain('close 子块内')
  })

  it('case1 缺 attribution 由 case2 补 ⇒ 必须红在 case1（禁止跨 block）', () => {
    const verdict = validateDeadlineEvidence({
      caseText: buildSyntheticDeadlineFixture({ omitCase1Attribution: true }),
      reporterText,
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.cases[0]!.ok).toBe(false)
    expect(verdict.cases[1]!.ok).toBe(true)
    expect(verdict.cases[0]!.errors.join(' ')).toContain('case1')
  })

  it('重复 close ⇒ 该 case 红', () => {
    const verdict = validateDeadlineEvidence({
      caseText: buildSyntheticDeadlineFixture({ duplicateClose: true }),
      reporterText,
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.cases[0]!.errors.join(' ')).toMatch(/close.*恰好 1 条/)
  })

  it('缺 case2 / 顺序错 ⇒ 红', () => {
    for (const opts of [{ omitCase2: true }, { swap: true }]) {
      const verdict = validateDeadlineEvidence({
        caseText: buildSyntheticDeadlineFixture(opts),
        reporterText,
      })
      expect(verdict.ok, JSON.stringify(opts)).toBe(false)
    }
  })

  it('marker 之前的行不参与分块（preamble 可忽略）', () => {
    const text = '[WebServer] noise\n' + buildSyntheticDeadlineFixture()
    expect(parseDeadlineCaseBlocks(text)).toHaveLength(2)
  })
})
