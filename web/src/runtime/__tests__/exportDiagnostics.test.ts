/**
 * **导出诊断桥**（M6-4）：纯事实 → 有界诊断通道。
 *
 * 形态照 `runtime/__tests__/contentDiagnostics.test.ts`（同一分层、同一"按批次去重"）。
 * 判三件事：合并计数、上限不得静默截断、通道/关联字段可查。
 */
import { describe, expect, it } from 'vitest'
import { createDiagnosticRecorder } from '@/application/diagnostics'
import { EXPORT_DIAGNOSTIC_BURST_MAX, bucketExportFindings, reportExportSemantics } from '@/runtime/exportDiagnostics'
import type { ExportSemanticFinding } from '@/application/exportSemantics'

function recorder(capacity = 64) {
  let t = 0
  return createDiagnosticRecorder({ capacity, now: () => ++t })
}

function finding(code: ExportSemanticFinding['code'], objectId?: string, params: Record<string, string | number | boolean> = {}): ExportSemanticFinding {
  return Object.freeze({ code, params: Object.freeze(params), ...(objectId === undefined ? {} : { objectId }) })
}

describe('M6-4 导出诊断桥', () => {
  it('空事实 ⇒ 不写任何记录（"没有不可表达语义"不是事件）', () => {
    const rec = recorder()
    expect(reportExportSemantics(rec, [])).toBe(0)
    expect(rec.size()).toBe(0)
  })

  it('同码同对象合并计数；不同对象各自一条', () => {
    const rec = recorder()
    const written = reportExportSemantics(rec, [
      finding('export.capabilityUnsupported', 'o1', { category: 'deformation' }),
      finding('export.capabilityUnsupported', 'o1', { category: 'deformation' }),
      finding('export.capabilityUnsupported', 'o2', { category: 'text' }),
    ])
    expect(written).toBe(2)
    const records = rec.byChannel('export')
    expect(records.map((r) => r.correlation.objectId)).toEqual(['o1', 'o2'])
    expect(records[0]!.params.count).toBe(2)
    expect(records[1]!.params.count).toBe(1)
  })

  it('桶的键是 code + objectId（纯函数可单独断言）', () => {
    const buckets = bucketExportFindings([
      finding('export.firstFrameOnly'),
      finding('export.firstFrameOnly'),
      finding('export.geometrySkipped', 'o1'),
    ])
    expect(buckets.map((b) => [b.code, b.objectId ?? '', b.count])).toEqual([
      ['export.firstFrameOnly', '', 2],
      ['export.geometrySkipped', 'o1', 1],
    ])
  })

  it('超过上限**不得静默丢弃**：截断条数写进一条诊断', () => {
    const rec = recorder(128)
    const many: ExportSemanticFinding[] = []
    for (let i = 0; i < EXPORT_DIAGNOSTIC_BURST_MAX + 3; i += 1) {
      many.push(finding('export.capabilityUnsupported', 'o' + String(i)))
    }
    const written = reportExportSemantics(rec, many)
    expect(written).toBe(EXPORT_DIAGNOSTIC_BURST_MAX + 1)
    const trunc = rec.byChannel('export').find((r) => r.params.reason === 'diagnosticsTruncated')
    expect(trunc, '截断事实必须可见').toBeDefined()
    expect(trunc!.params.suppressed).toBe(3)
    expect(trunc!.params.bucketCount).toBe(EXPORT_DIAGNOSTIC_BURST_MAX + 3)
  })

  it('关联身份随记录带出（commandId/jobId/documentVersion）', () => {
    const rec = recorder()
    reportExportSemantics(rec, [finding('export.timeQuantized')], {
      commandId: 'OPERATOR_EXPORT_SCENE_GIF',
      jobId: 'job-1',
      documentVersion: 7,
    })
    const r = rec.byChannel('export')[0]!
    expect(r.correlation).toMatchObject({ commandId: 'OPERATOR_EXPORT_SCENE_GIF', jobId: 'job-1', documentVersion: 7 })
  })

  it('读面**无写权限**：导出通道的记录也只能经查询方法读', () => {
    const rec = recorder()
    reportExportSemantics(rec, [finding('export.failed', undefined, { reason: 'x' })])
    expect(rec.byCode('export.failed')).toHaveLength(1)
    expect(rec.byChannel('export')).toHaveLength(1)
  })
})
