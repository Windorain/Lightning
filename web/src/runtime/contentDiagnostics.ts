/**
 * 内容边界 → 诊断通道的桥（#259 A32 × A35）。
 *
 * ## 为什么需要这一层
 *
 * `domain/textContent.ts` 是**纯**的：它把被拒绝的构造记录为 `ContentIssue`
 * 并**返回**，不自己写日志（#249 §2.1：纯函数不记日志）。而 #249 §19.9 要求
 * "内容拒绝"这类事实可被观测。两者之间的接线就是本文件：
 * 它把纯层返回的事实挂到 runtime 的**有界**记录器上，并补上关联身份。
 *
 * ## 分层
 *
 * 本文件在 `runtime/`（接线层）：允许持有实例的诊断记录器。它**不**做规则判断
 * ——判断在 `domain/textContent.ts`，这里只做搬运与关联。
 *
 * ## 为什么按"批次"而不是逐条
 *
 * 一次解析可能产出多条 issue（例如一段文本里多个危险标签）。逐条记录会让
 * 同一次解析在环形缓冲里占据多条，快速挤掉其它通道的记录。按"一次解析一条"
 * 记录（`params.count` + 首个码）在诊断可读性与缓冲利用之间更平衡；
 * 需要逐条证据时，测试直接断言纯层的 `issues` 数组（那是权威来源）。
 */

import type { DiagnosticRecorder } from '@/application/diagnostics'
import type { ContentIssue } from '@/domain/textContent'

/** 一条解析批次里最多的 issue 数（防单次解析写爆缓冲）。 */
export const CONTENT_ISSUE_BURST_MAX = 8

/**
 * 把一次解析的拒绝事实记入诊断。
 *
 * - 无 issue ⇒ **不**记录（不产生噪声；"没拒绝"不是事件）；
 * - 有 issue ⇒ 每个**稳定码**记一条（同一码的多条合并，`count` 计数），
 *   最多 `CONTENT_ISSUE_BURST_MAX` 条；
 * - 参数只带稳定码与计数（值与标签名已在纯层截断过，这里再取一次只读投影）。
 */
export function reportContentIssues(
  recorder: DiagnosticRecorder,
  issues: readonly ContentIssue[],
  correlation: { objectId?: string; documentVersion?: number } = {},
): number {
  if (issues.length === 0) return 0

  // 按稳定码聚合（同码合并计数），保持首次出现顺序 ⇒ 报告可复现
  const byCode = new Map<string, { count: number; tag?: string; attribute?: string }>()
  for (const issue of issues) {
    const cur = byCode.get(issue.code)
    if (cur) {
      cur.count++
      continue
    }
    byCode.set(issue.code, { count: 1, tag: issue.tag, attribute: issue.attribute })
  }

  let written = 0
  for (const [code, agg] of byCode) {
    if (written >= CONTENT_ISSUE_BURST_MAX) break
    recorder.record({
      channel: 'content',
      code: 'content.rejected',
      params: {
        reason: code,
        count: agg.count,
        ...(agg.tag !== undefined ? { tag: agg.tag } : {}),
        ...(agg.attribute !== undefined ? { attribute: agg.attribute } : {}),
      },
      correlation: {
        ...(correlation.objectId !== undefined ? { objectId: correlation.objectId } : {}),
        ...(correlation.documentVersion !== undefined
          ? { documentVersion: correlation.documentVersion }
          : {}),
      },
    })
    written++
  }
  return written
}

/**
 * 为运行时准备内容诊断接线 —— 供 `WM` 构造时调用。
 *
 * 返回值是"报告函数"，由 `HostProvider` 经 `editors/contentBoundary.ts` 的
 * `contentIssueReporterKey` **注入**给呈现组件。把它做成闭包
 * （而不是让 `ContentText` 直接持有记录器）的理由：`editors/` 是呈现层，
 * 不应依赖 `runtime/` 的实现；依赖方向是 runtime → editors（注入回调），
 * 不是 editors → runtime。
 */
export function createContentBoundaryDiagnostics(
  recorder: DiagnosticRecorder,
): (issues: readonly ContentIssue[]) => void {
  return (issues) => {
    reportContentIssues(recorder, issues)
  }
}
