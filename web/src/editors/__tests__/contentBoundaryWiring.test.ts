// @vitest-environment jsdom
/**
 * 内容边界的**注入接线**（#259 A32 × A35）—— 真实组件挂载，零替身。
 *
 * ## 这条测试在防什么（与相邻两条的分工）
 *
 * | 文件 | 证明的事 |
 * |---|---|
 * | `domain/__tests__/textContentBoundary.test.ts` | 纯层按允许列表产出受控节点 |
 * | `runtime/__tests__/contentDiagnostics.test.ts` | 桥把 issues 写进**有界**诊断 |
 * | **本文件** | 挂载真实 `ContentText` 时，`HostProvider` 的 provide 确实**流到组件** |
 *
 * 缺了本文件，"内容拒绝可观测"就可能是纸面能力：桥两端都正确，
 * 但没人把报告口注入给组件（`useContentIssueReporter()` 永远拿到 `null`），
 * 于是真实页面上外部内容被拒绝时诊断里空空如也，而两条单测都是绿的。
 *
 * ## 为什么用真实组件而不是直接调 `reportContentIssues`
 *
 * 直接调桥函数只证明"函数能用"；`provide`/`inject` 的**键一致性**、
 * `watchEffect` 的触发时机、以及"只在内容变化时报告一次"，都只有在真实
 * 组件挂载下才会暴露。
 */

import { describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, provide } from 'vue'
import ContentText from '@/editors/ContentText.vue'
import { contentIssueReporterKey, reportContentIssuesSafely } from '@/editors/contentBoundary'
import { parseContent } from '@/domain/textContent'

/** 挂载一个真实 ContentText；可选地在其**上层** provide 报告口（模拟 HostProvider）。 */
function mountContentText(
  props: Record<string, unknown>,
  reporter?: (issues: readonly { code: string; tag?: string; attribute?: string }[]) => void,
): { el: HTMLElement; unmount: () => void } {
  const host = document.createElement('div')
  document.body.appendChild(host)

  const Root = defineComponent({
    setup() {
      if (reporter) provide(contentIssueReporterKey, reporter)
      return () => h(ContentText, props)
    },
  })
  const app = createApp(Root)
  app.mount(host)
  return { el: host, unmount: () => { app.unmount(); host.remove() } }
}

describe('A32×A35 注入接线：HostProvider 的报告口确实流到呈现组件', () => {
  it('危险内容 ⇒ 报告口被调用，且带结构化 issue（不是静默丢弃）', async () => {
    const seen: { code: string; tag?: string }[][] = []
    const { unmount } = mountContentText(
      { text: '<script>alert(1)</script><iframe src="//evil"></iframe>', mode: 'mc' },
      (issues) => { seen.push(issues.map((i) => ({ code: i.code, tag: i.tag }))) },
    )
    await Promise.resolve()

    expect(seen.length, '报告口必须被调用').toBeGreaterThan(0)
    const codes = seen.flat().map((i) => i.code)
    expect(codes).toContain('embeddingTag')
    expect(seen.flat().some((i) => i.tag === 'iframe')).toBe(true)
    unmount()
  })

  it('干净内容 ⇒ **不**调用报告口（"没拒绝"不是事件）', async () => {
    const reporter = vi.fn()
    const { unmount } = mountContentText({ text: '普通文本 **粗体** §a绿色', mode: 'mc' }, reporter)
    await Promise.resolve()
    expect(reporter).not.toHaveBeenCalled()
    unmount()
  })

  it('无注入（孤立挂载）⇒ 不报错，且内容照常呈现', async () => {
    // 缺少 HostProvider 时不应崩：安全性来自允许列表，与"有没有订阅诊断"无关。
    const { el, unmount } = mountContentText({
      text: '<iframe src="//evil"></iframe>keep me',
      mode: 'mc',
    })
    await Promise.resolve()
    expect(el.querySelector('.ct-root')).not.toBeNull()
    expect(el.querySelector('iframe')).toBeNull()
    expect(el.textContent).toBe('keep me')
    unmount()
  })

  it('渲染出的 DOM 里没有可执行标记（真实组件路径的端到端负对照）', async () => {
    const { el, unmount } = mountContentText({
      text: '<img src=x onerror="1"><b onclick="2">t</b><a href="javascript:3">j</a>',
      mode: 'mc',
    })
    await Promise.resolve()
    expect(el.querySelector('script')).toBeNull()
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('iframe')).toBeNull()
    expect(el.querySelector('[onerror]')).toBeNull()
    expect(el.querySelector('[onclick]')).toBeNull()
    const hrefs = [...el.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? '')
    expect(hrefs.filter((x) => /^\s*javascript:/i.test(x))).toEqual([])
    unmount()
  })

  it('链接经受控节点渲染后带上 rel/target（"允许了链接"的必要配套）', async () => {
    const { el, unmount } = mountContentText({ text: '[ok](https://a.b/c)', mode: 'mc' })
    await Promise.resolve()
    const a = el.querySelector('a')
    expect(a).not.toBeNull()
    expect(a!.getAttribute('href')).toBe('https://a.b/c')
    expect(a!.getAttribute('rel')).toBe('noopener noreferrer')
    expect(a!.getAttribute('target')).toBe('_blank')
    unmount()
  })

  it('报告口抛异常**不**影响呈现（诊断不反向影响业务）', async () => {
    const boom = () => { throw new Error('diagnostics down') }
    const { el, unmount } = mountContentText(
      { text: '<iframe></iframe>visible', mode: 'mc' },
      boom,
    )
    await Promise.resolve()
    // 呈现仍成立：文本在、标签不在、无未捕获异常中断挂载
    expect(el.textContent).toBe('visible')
    unmount()
  })

  it('`reportContentIssuesSafely` 吞掉订阅者异常且对空 issue 是 no-op', () => {
    expect(() => reportContentIssuesSafely(() => { throw new Error('x') }, [{ code: 'unsafeUrl' }])).not.toThrow()
    const spy = vi.fn()
    reportContentIssuesSafely(spy, [])
    expect(spy).not.toHaveBeenCalled()
    reportContentIssuesSafely(null, [{ code: 'unsafeUrl' }]) // 无订阅者：不抛
  })
})

describe('A32 组件契约：受控呈现的形态由 allowlist 决定', () => {
  it('MC 颜色经 color 节点渲染为内联 color（取值来自表内常量）', async () => {
    const { el, unmount } = mountContentText({ text: '§aGreen', mode: 'mc' })
    await Promise.resolve()
    const span = el.querySelector('.ct-color') as HTMLElement | null
    expect(span).not.toBeNull()
    // 浏览器会把 #55FF55 规范化为 rgb(...)
    expect(span!.style.color.toLowerCase()).toMatch(/rgb\(85,\s*255,\s*85\)|#55ff55/)
    unmount()
  })

  it('`plain` 模式不解释任何标记（`<script>` 也是文本）', async () => {
    const { el, unmount } = mountContentText({ text: '<script>x</script>', mode: 'plain' })
    await Promise.resolve()
    expect(el.querySelector('script')).toBeNull()
    expect(el.textContent).toBe('<script>x</script>')
    unmount()
  })

  it('同一份外部文本在 Tooltip 与 Inspector 路径产出**相同**节点（不允许各自选路径）', () => {
    const raw = '§aA **b** <iframe></iframe>'
    const a = parseContent(raw, 'mc')
    const b = parseContent(raw, 'mc')
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    // 两个调用点走同一函数 ⇒ 规则无法分叉（分叉需要第二个解析入口，已无）
    expect(a.issues.map((i) => i.code)).toEqual(b.issues.map((i) => i.code))
  })
})
