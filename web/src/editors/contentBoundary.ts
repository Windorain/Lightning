/**
 * 内容边界的**报告口**（注入式）。
 *
 * ## 为什么用注入而不是让 ContentText 直接拿记录器
 *
 * `editors/ContentText.vue` 是**呈现层**：它消费受控节点，不应当知道
 * "诊断记录器"这个 runtime 概念。分层纪律要求 `editors` 经**公开接口**
 * 接入而不获取私有状态；`presentation`/`editors` 反向依赖 `runtime` 的实现
 * 也会让层边界失效（由 `web/tests/architecture/` 的闸门规则判红）。
 *
 * 所以依赖方向是 **runtime → editors**：runtime（`HostProvider`）把报告函数
 * **注入**下来，editors 只声明"我需要一个能接收拒绝事实的回调"。
 *
 * ## 为什么是可选的
 *
 * 单测/孤立挂载（jsdom 里直接 `createApp(ContentText)`）没有 HostProvider。
 * 缺少注入时**不应**报错：内容边界的安全保证来自允许列表（纯层），
 * 与"有没有人订阅诊断"无关。`inject(..., null)` + 可选调用即表达这一点：
 * 诊断是**可观测性**，不是安全性的前提。
 */

import { inject, type InjectionKey } from 'vue'
import type { ContentIssue } from '@/domain/textContent'

/** 接收内容拒绝事实的回调。 */
export type ContentIssueReporter = (issues: readonly ContentIssue[]) => void

/** 注入键。`Symbol` 保证不会与宿主页面的 provide 冲突。 */
export const contentIssueReporterKey: InjectionKey<ContentIssueReporter> =
  Symbol('lk-content-issue-reporter')

/** 取报告口；无注入时返回 `null`（调用方须容忍）。 */
export function useContentIssueReporter(): ContentIssueReporter | null {
  return inject(contentIssueReporterKey, null)
}

/** 安全报告：无订阅者或订阅者抛错都**不影响**呈现（诊断不反向影响业务）。 */
export function reportContentIssuesSafely(
  reporter: ContentIssueReporter | null,
  issues: readonly ContentIssue[],
): void {
  if (!reporter || issues.length === 0) return
  try {
    reporter(issues)
  } catch {
    // 诊断失败不得冒泡到呈现路径（「不让日志成为额外业务驱动源」）
  }
}
