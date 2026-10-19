/**
 * 内容边界 → 诊断通道的桥（#259 A32 × A35）。
 *
 * ## 这条测试在防什么
 *
 * 桥的两端各自已有测试（`textContentBoundary.test.ts` 证明纯层产出 issue；
 * `diagnosticsContract.test.ts` 证明记录器有界且脱敏）。但**两者之间**是否真的
 * 接上，是第三件事 —— 一个只被 `new` 出来却从不调用的桥，会让"内容拒绝可观测"
 * 变成纸面能力：纯层照常产出 issue，诊断里永远什么都没有。
 *
 * 本文件的断言对象因此是**调用链**：把纯层的 `issues` 交给桥，断言诊断里
 * 出现了对应的结构化记录。
 */

import { describe, expect, it } from 'vitest'
import { createDiagnosticRecorder } from '@/application/diagnostics'
import { parseContent } from '@/domain/textContent'
import { CONTENT_ISSUE_BURST_MAX, createContentBoundaryDiagnostics, reportContentIssues } from '@/runtime/contentDiagnostics'

function recorder() {
  let t = 0
  return createDiagnosticRecorder({ capacity: 64, now: () => ++t })
}

describe('内容拒绝 → 诊断通道（真实调用链）', () => {
  it('纯层产出的 issue 经桥进入诊断（不是只 new 不调用）', () => {
    const rec = recorder()
    const parsed = parseContent('<script>alert(1)</script><img src=x onerror=1>', 'mc')
    expect(parsed.issues.length, '前置：纯层确实产出了拒绝事实').toBeGreaterThan(0)

    const written = reportContentIssues(rec, parsed.issues, { objectId: 'anno-1' })
    expect(written).toBeGreaterThan(0)

    const records = rec.byCode('content.rejected')
    expect(records.length).toBe(written)
    expect(records[0]!.channel).toBe('content')
    expect(records[0]!.correlation.objectId).toBe('anno-1')
  })

  it('createContentBoundaryDiagnostics 返回的函数直接可用（HostProvider 的注入面）', () => {
    const rec = recorder()
    const report = createContentBoundaryDiagnostics(rec)
    const parsed = parseContent('<iframe src="//evil"></iframe>', 'mc')
    report(parsed.issues)
    expect(rec.byCode('content.rejected').length).toBeGreaterThan(0)
    expect(rec.byChannel('content').length).toBeGreaterThan(0)
  })

  it('无 issue 时**不**记录（"没拒绝"不是事件，不产生噪声）', () => {
    const rec = recorder()
    const parsed = parseContent('普通文本 **粗体** §a绿色', 'mc')
    expect(parsed.issues).toEqual([])
    expect(reportContentIssues(rec, parsed.issues)).toBe(0)
    expect(rec.size()).toBe(0)
  })

  it('同一稳定码聚合计数（一次解析里多个同类拒绝 → 一条记录 + count）', () => {
    const rec = recorder()
    const parsed = parseContent('<iframe></iframe><object></object><embed>', 'mc')
    const embedding = parsed.issues.filter((i) => i.code === 'embeddingTag')
    expect(embedding.length).toBeGreaterThan(1)

    reportContentIssues(rec, parsed.issues)
    const recs = rec.byCode('content.rejected')
    const embedRec = recs.find((r) => r.params.reason === 'embeddingTag')!
    expect(embedRec.params.count).toBe(embedding.length)
  })

  it('单次解析写入量有上限（不挤爆环形缓冲）', () => {
    const rec = recorder()
    // 造出多种不同码
    const parsed = parseContent(
      '<script>x</script><iframe></iframe><div onclick="1">t</div><a href="javascript:1">j</a>',
      'mc',
    )
    const written = reportContentIssues(rec, parsed.issues)
    expect(written).toBeLessThanOrEqual(CONTENT_ISSUE_BURST_MAX)
  })

  it('凭据经参数旁路也被脱敏（桥不绕过记录的脱敏）', () => {
    const rec = recorder()
    // 直接构造一条带敏感键名的 issue 形态是不可能的（ContentIssue 无自由字段），
    // 因此这里核对桥写入的参数键名都在允许集内，不会夹带文档内容。
    reportContentIssues(rec, [{ code: 'unsafeUrl', tag: 'a', attribute: 'href', value: 'javascript:1' }])
    const r = rec.byCode('content.rejected')[0]!
    expect(Object.keys(r.params).sort()).toEqual(['attribute', 'count', 'reason', 'tag'])
    // 值只带"哪一类"，不带被拒绝串的原文（原文在纯层已截断且不进参数）
    expect(JSON.stringify(r.params)).not.toContain('javascript:1')
  })

  it('关联身份（objectId/documentVersion）被搬运到记录上', () => {
    const rec = recorder()
    reportContentIssues(
      rec,
      [{ code: 'eventAttribute', tag: 'b', attribute: 'onclick' }],
      { objectId: 'obj-9', documentVersion: 12 },
    )
    const r = rec.byCode('content.rejected')[0]!
    expect(r.correlation.objectId).toBe('obj-9')
    expect(r.correlation.documentVersion).toBe(12)
  })
})
