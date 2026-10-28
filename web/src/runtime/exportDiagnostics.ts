/**
 * **导出 → 诊断通道的桥**。
 *
 * ## 为什么需要这一层
 *
 * `application/exportSemantics` 是**纯**的：它把"目标格式表达不了什么"写成结构化事实
 * 并**返回**，不自己写日志（纯函数不记日志）。而 SPEC §9 要求这些事实
 * **可被观测**（今天导出只有 UI 文案与 `log.warn`）。两者之间的接线就是本文件：
 * 把纯层返回的事实挂到 runtime 的**有界**记录器上，并补上关联身份。
 *
 * 形态照 `runtime/contentDiagnostics`（同一分层、同一"按批次去重"的动机）。
 *
 * ## 分层
 *
 * 本文件在 `runtime/`（接线层）：允许持有实例的诊断记录器；**不做**规则判断
 * ——判断在 `application/exportSemantics` 与 `application/exportPlan`，这里只搬运。
 *
 * ## 为什么按"码 + 对象"去重
 *
 * 一次导出可能产出几十条同码事实（例如 20 个对象都有形变）。逐条记录会把环形缓冲
 * 挤爆，且用户读不出"到底几处"。故同码同对象合并、`params.count` 计数，
 * 并对单次导出设一个上限（`EXPORT_DIAGNOSTIC_BURST_MAX`）；被合并/被截断的条数
 * 自身也进 `params`（`suppressed`）—— "少报了多少"必须是可读的事实。
 */

import type { DiagnosticRecorder } from '@/application/diagnostics'
import type { ExportSemanticFinding } from '@/application/exportSemantics'

/** 单次导出最多写多少条导出诊断（防一次导出挤掉其它通道的记录）。 */
export const EXPORT_DIAGNOSTIC_BURST_MAX = 24

/** 导出诊断的关联身份（命令/作业/文档版本；全部可缺省）。 */
export interface ExportDiagnosticCorrelation {
  readonly commandId?: string
  readonly jobId?: string
  readonly documentVersion?: number
}

/** 单条被合并后的事实（供判据与 UI 共用同一形状）。 */
export interface ExportDiagnosticBucket {
  readonly code: ExportSemanticFinding['code']
  readonly params: Readonly<Record<string, string | number | boolean>>
  readonly objectId?: string
  readonly count: number
}

/**
 * 事实 → **合并后的桶**（纯函数；判据可直接断言它，不必经过记录器）。
 *
 * 合并键 = `code + objectId`。同码同对象的多条合并为一条并累计 `count` ——
 * 保留首条的参数（它们在同码同对象下通常只差名字，逐条参数已由纯层证据覆盖）。
 */
export function bucketExportFindings(
  findings: readonly ExportSemanticFinding[],
): readonly ExportDiagnosticBucket[] {
  const order: string[] = []
  const byKey = new Map<string, { code: ExportSemanticFinding['code']; params: Readonly<Record<string, string | number | boolean>>; objectId?: string; count: number }>()
  for (const f of findings) {
    const key = f.code + '\u0000' + (f.objectId ?? '')
    const cur = byKey.get(key)
    if (cur !== undefined) {
      cur.count += 1
      continue
    }
    order.push(key)
    byKey.set(key, {
      code: f.code,
      params: f.params,
      ...(f.objectId === undefined ? {} : { objectId: f.objectId }),
      count: 1,
    })
  }
  return Object.freeze(order.map((k) => Object.freeze(byKey.get(k)!)))
}

/**
 * 把一批导出事实写进诊断通道；返回**实际写入**的条数。
 *
 * - 空数组 ⇒ 不写（"没有不可表达语义"不是事件，不制造噪声）；
 * - 同码同对象合并；超过上限的桶**不静默消失**：最后一条带 `suppressed` 计数。
 */
export function reportExportSemantics(
  recorder: DiagnosticRecorder,
  findings: readonly ExportSemanticFinding[],
  correlation: ExportDiagnosticCorrelation = {},
): number {
  const buckets = bucketExportFindings(findings)
  if (buckets.length === 0) return 0
  const limit = Math.max(1, EXPORT_DIAGNOSTIC_BURST_MAX)
  const kept = buckets.slice(0, limit)
  const suppressed = buckets.length - kept.length
  let written = 0
  const base = {
    ...(correlation.commandId === undefined ? {} : { commandId: correlation.commandId }),
    ...(correlation.jobId === undefined ? {} : { jobId: correlation.jobId }),
    ...(correlation.documentVersion === undefined ? {} : { documentVersion: correlation.documentVersion }),
  }
  for (const b of kept) {
    recorder.record({
      channel: 'export',
      code: b.code,
      params: { ...b.params, count: b.count },
      correlation: { ...base, ...(b.objectId === undefined ? {} : { objectId: b.objectId }) },
    })
    written++
  }
  if (suppressed > 0) {
    recorder.record({
      channel: 'export',
      code: 'export.failed',
      params: { reason: 'diagnosticsTruncated', suppressed, bucketCount: buckets.length },
      correlation: base,
    })
    written++
  }
  return written
}
