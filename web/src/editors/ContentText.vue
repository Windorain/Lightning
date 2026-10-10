/**
 * ContentText —— **内容呈现边界**（#249 §19.6；#259「`editors/ui` 文本呈现边界」）。
 *
 * ## 这个组件的存在理由：把"允许什么"从 6 个组件收敛成 1 个
 *
 * 改动前，外部文本到 DOM 有 6 条各自独立的直通路径
 * （ToolTipBox / ToolTipPreview / 注解预览 / Tooltip 编辑预览 / UIRenderer 的
 * `innerHTML` 元素 / OperatorBtn 与 ToolGroupButton 的图标注入），
 * 每条路径自己决定怎么把字符串变成 DOM。于是"允许什么标签/属性/URL"
 * 在代码里没有唯一答案，也无法被一处收紧。
 *
 * 现在**所有**外部文本都经由本组件：它消费 `domain/textContent.ts` 产出的
 * 受控节点（`ContentNode`），并且只做一件事 —— **按 `type` 分派到允许的元素**。
 * 组件内**没有** `v-html`、**没有** `innerHTML`、**没有**由数据决定的标签名：
 * 元素名来自下面的常量映射（编译期），属性来自节点上已通过审计的字段。
 *
 * ## 为什么是渲染函数而不是模板
 *
 * 模板加 `v-html` 是原本的注入面；模板加动态组件（`:is` 绑定数据）仍允许
 * "数据决定标签"。用 `h()` 显式列出每个分支，让"这个组件能产出哪些 DOM"
 * 在**代码结构上**封闭（`node.type` 是判别式联合，穷尽分支可被类型检查器核对），
 * 并由 `textContentBoundary.test.ts` 的"渲染后 DOM 无 script/事件属性"断言守住。
 *
 * ## 链接的 `rel`/`target`
 *
 * `href` 已由 `isSafeLinkHref` 审计过协议；这里**必须**再补
 * `rel="noopener noreferrer"` 与 `target="_blank"` —— 前者防 `window.opener`
 * 反向控制，后者让外部链接不在当前编辑上下文里导航（#259「URL 协议…处理明确」）。
 * 这是"允许了链接"的必要配套，不是可选修饰。
 */
<script lang="ts">
import { computed, defineComponent, h, watchEffect, type PropType, type VNode } from 'vue'
import { parseContent, parseContentLines, type ContentIssue, type ContentMode, type ContentNode } from '@/domain/textContent'
import { reportContentIssuesSafely, useContentIssueReporter } from '@/editors/contentBoundary'

/**
 * 节点类型 → 元素标签。
 *
 * **编译期常量**，不是从内容里读来的标签名：外部文本无法让本组件产出表外元素。
 * 缺 `link`/`list`/`heading` —— 它们需要额外属性/结构，单独分支处理。
 */
const TAG_BY_TYPE = {
  strong: 'strong',
  em: 'em',
  del: 'del',
  underline: 'u',
  code: 'code',
  color: 'span',
  paragraph: 'div',
  quote: 'blockquote',
} as const

const HEADING_TAGS = { 1: 'h1', 2: 'h2', 3: 'h3', 4: 'h4', 5: 'h5', 6: 'h6' } as const

function renderNodes(list: readonly ContentNode[]): VNode[] {
  return list.map((node, i) => renderNode(node, i))
}

function renderNode(node: ContentNode, key: number): VNode {
  switch (node.type) {
    case 'text':
      // 文本走 Vue 的文本子节点（等价 createTextNode），**不是** innerHTML
      return h('span', { key, class: 'ct-text' }, node.value)
    case 'linebreak':
      return h('br', { key })
    case 'link':
      return h(
        'a',
        {
          key,
          class: 'ct-link',
          href: node.href,
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        renderNodes(node.children),
      )
    case 'color':
      // 颜色是**本模块表内**的 `#rrggbb`（外部无法注入任意 CSS 值）
      return h('span', { key, class: 'ct-color', style: `color:${node.color}` }, renderNodes(node.children))
    case 'list':
      return h(
        node.ordered ? 'ol' : 'ul',
        { key, class: 'ct-list' },
        node.items.map((item, ii) => h('li', { key: ii }, renderNodes(item))),
      )
    case 'heading':
      return h(HEADING_TAGS[node.level] ?? 'h1', { key, class: 'ct-heading' }, renderNodes(node.children))
    default:
      return h(TAG_BY_TYPE[node.type], { key, class: `ct-${node.type}` }, renderNodes(node.children))
  }
}

export default defineComponent({
  name: 'ContentText',
  props: {
    /** 外部文本（原始串）。**永不**被当作标记直接注入。 */
    text: { type: String, default: undefined },
    /** 已经是受控节点的内容（调用方已解析；与 `text` 二选一）。 */
    nodes: { type: Array as PropType<readonly ContentNode[]>, default: undefined },
    /** 行数组：逐行解析、行间以 `linebreak` 分隔（等价旧"逐行渲染再 `\n` 拼接"）。 */
    lines: { type: Array as PropType<readonly string[]>, default: undefined },
    /** `plain`：不解释任何标记；`mc`：MC 颜色码 + Markdown（默认）。 */
    mode: { type: String as PropType<ContentMode>, default: 'mc' },
    /** 渲染容器元素（**常量白名单**，不是数据驱动的标签名）。 */
    as: { type: String as PropType<'div' | 'span' | 'p'>, default: 'div' },
  },
  setup(props) {
    // 内容拒绝事实的报告口（由 runtime 注入；无注入时静默 —— 见 contentBoundary.ts）。
    // 依赖方向是 runtime → editors：本组件**不**知道诊断记录器的存在。
    const reportIssues = useContentIssueReporter()

    const parsed = computed<{ nodes: readonly ContentNode[]; text: string; issues: readonly ContentIssue[] }>(() => {
      if (props.nodes) return { nodes: props.nodes, text: '', issues: [] }
      if (props.lines) {
        const r = parseContentLines(props.lines, props.mode)
        return { nodes: r.nodes, text: r.text, issues: r.issues }
      }
      const r = parseContent(props.text ?? '', props.mode)
      return { nodes: r.nodes, text: r.text, issues: r.issues }
    })

    /** 纯文本投影：`aria-label`、e2e 文案对账用（与视觉内容同源）。 */
    const plain = computed(() => parsed.value.text || (props.text ?? ''))

    /**
     * 报告被拒绝的构造（#259 A35：内容拒绝也要可观测）。
     *
     * 放在 `watchEffect` 里而不是渲染函数体内：渲染函数可能因父组件更新而重跑，
     * 在里面记录会让同一份内容被重复记入诊断（噪声，并挤掉其它通道）。
     * `watchEffect` 只在 `parsed` 真正变化时触发。
     */
    watchEffect(() => {
      reportContentIssuesSafely(reportIssues, parsed.value.issues)
    })

    return () =>
      h(
        props.as,
        { class: 'ct-root', 'aria-label': plain.value },
        renderNodes(parsed.value.nodes),
      )
  },
})
</script>

<template>
  <!--
    本 SFC **没有模板内容**：组件在 `<script>` 里以渲染函数实现（见上）。
    这样 `v-html` 无法在本文件出现 —— 唯一的标记来源是 `h()` 的显式分派。
    Vue 要求 SFC 至少有一个块；这里保留空 `<template>` 以满足编译期约束，
    但它**不参与渲染**（`defineComponent` 的 `setup` 返回渲染函数，优先于模板）。
  -->
</template>

<style scoped>
.ct-root { white-space: pre-line; overflow-wrap: break-word; }
.ct-heading { font-weight: 700; margin: 0; }
.ct-list { margin: 0; padding-left: 1.2em; }
.ct-quote { margin: 0; padding-left: 0.6em; border-left: 2px solid currentColor; opacity: 0.9; }
.ct-link { color: inherit; text-decoration: underline; }
</style>
