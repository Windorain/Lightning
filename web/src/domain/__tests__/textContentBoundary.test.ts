/**
 * A32 `content-boundary` —— 外部文本 / Markdown / MC 颜色码的受控呈现边界。
 *
 * 覆盖 #249 §14 A32 的 Given/When/断言/负对照四列，以及 #259 J3
 * 「纯转换函数同样执行内容允许规则（纯性不是安全性的替代品）」。
 *
 * ## 负对照怎么"证明确实破坏了目标保证"
 *
 * A32 的负对照原文是「将未经处理字符串直接传 innerHTML/v-html」。本文件里它落成
 * 两件事，缺一不可：
 *
 * 1. **正对照**：`parseContent` 对同样的串产出受控节点，且**不含**任何可执行形态；
 * 2. **负对照**：用**真实浏览器语义**（jsdom 的 `innerHTML`）把"旧路径的输出"
 *    注入一个元素，断言它**确实**产生了 `script`/`img`/事件属性 —— 即
 *    "直接传 innerHTML"这条路径**真的**有注入能力，而不是本测试凭空声称。
 *
 * 只有第 2 步成立，第 1 步的"没有注入能力"才是可归因的证据（#249 §14
 * 「负对照必须证明确实破坏了目标保证，不能只令测试主动抛错」）。
 */

// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  CONTENT_POLICY,
  contentPlainText,
  isContentNode,
  isSafeLinkHref,
  parseContent,
  type ContentNode,
} from '@/domain/textContent'

/** 收集节点树里出现的所有节点类型。 */
function types(nodes: readonly ContentNode[]): string[] {
  const out: string[] = []
  const walk = (list: readonly ContentNode[]): void => {
    for (const n of list) {
      out.push(n.type)
      if (n.type === 'list') n.items.forEach(walk)
      else if ('children' in n) walk(n.children)
    }
  }
  walk(nodes)
  return out
}

/** 节点树里所有链接的 href。 */
function hrefs(nodes: readonly ContentNode[]): string[] {
  const out: string[] = []
  const walk = (list: readonly ContentNode[]): void => {
    for (const n of list) {
      if (n.type === 'link') out.push(n.href)
      else if (n.type === 'list') n.items.forEach(walk)
      else if ('children' in n) walk(n.children)
    }
  }
  walk(nodes)
  return out
}

/** 序列化整棵树（用于"不含可执行形态"的强断言）。 */
function serialize(nodes: readonly ContentNode[]): string {
  return JSON.stringify(nodes)
}

describe('A32 正对照：普通文本保持语义', () => {
  it('plain 模式不解释任何标记：`<script>` 也是文本，且无 issue', () => {
    const raw = '<script>alert(1)</script>'
    const r = parseContent(raw, 'plain')
    expect(r.nodes).toEqual([{ type: 'text', value: raw }])
    expect(r.issues).toEqual([])
    expect(r.text).toBe(raw)
  })

  it('plain 模式的特殊字符不触发任何解析（`§a` / `**b**` 原样）', () => {
    const raw = '§a green **bold** [x](javascript:alert(1))'
    const r = parseContent(raw, 'plain')
    expect(r.nodes).toEqual([{ type: 'text', value: raw }])
    expect(r.issues).toEqual([])
  })

  it('空输入 ⇒ 空节点、空 issue、空文本（不抛异常）', () => {
    expect(parseContent('')).toEqual({ nodes: [], issues: [], text: '' })
    expect(parseContent('', 'mc')).toEqual({ nodes: [], issues: [], text: '' })
  })

  it('合法 Markdown 保持语义：`**b**` / `_em_` / `~~del~~` / `` `code` ``', () => {
    const r = parseContent('**b** _em_ ~~del~~ `code`', 'mc')
    expect(r.text).toBe('b em del code')
    // 顶层是**并列**的兄弟节点（不是层层嵌套）：嵌套会让 `</strong>` 之后的文本
    // 仍留在 strong 里 —— 这正是实现里被本断言抓出的错。
    expect(r.nodes.map((n) => n.type)).toEqual([
      'strong', 'text', 'em', 'text', 'del', 'text', 'code',
    ])
    // 递归类型序列里，每个行内节点各自带一个 text 子节点
    expect(types(r.nodes)).toEqual([
      'strong', 'text', 'text', 'em', 'text', 'text', 'del', 'text', 'text', 'code', 'text',
    ])
    // 每个格式节点只包住自己的内容（不是包住后续所有文本）
    expect(r.nodes[0]).toEqual({ type: 'strong', children: [{ type: 'text', value: 'b' }] })
    expect(r.nodes[2]).toEqual({ type: 'em', children: [{ type: 'text', value: 'em' }] })
  })

  it('列表与标题保持结构（不是拍平成 HTML 串）', () => {
    const list = parseContent('- a\n- b', 'mc')
    expect(list.nodes).toHaveLength(1)
    const first = list.nodes[0]!
    expect(first.type).toBe('list')
    if (first.type === 'list') {
      expect(first.ordered).toBe(false)
      expect(first.items).toHaveLength(2)
      // 相邻项不得被合并（`<li>a</li><li>b</li>` ⇒ [["a"]] [["b"]]，不是 "ab"）
      expect(JSON.stringify(first.items)).toBe(
        '[[{"type":"text","value":"a"}],[{"type":"text","value":"b"}]]',
      )
    }
    const ordered = parseContent('1. a\n2. b', 'mc')
    expect(ordered.nodes[0]!.type).toBe('list')
    if (ordered.nodes[0]!.type === 'list') expect(ordered.nodes[0]!.ordered).toBe(true)

    const h = parseContent('# H1', 'mc')
    expect(h.nodes[0]).toEqual({
      type: 'heading',
      level: 1,
      children: [{ type: 'text', value: 'H1' }],
    })
  })

  it('合法链接通过协议允许列表并保留 href', () => {
    const r = parseContent('[ok](https://a.b/c)', 'mc')
    expect(hrefs(r.nodes)).toEqual(['https://a.b/c'])
    expect(r.issues).toEqual([])
  })

  it('换行按 Markdown 词法的实际语义表达（单个 `\\n` 是文本，空行才 `<br />`）', () => {
    // snarkdown 2.0 的词法：单个换行保留为字面 `\n`，空行才转 `<br />`。
    // 这里钉住"词法不变、权限收紧"：文本投影与旧渲染一致。
    const single = parseContent('a\nb', 'mc')
    expect(single.text).toBe('a\nb')
    expect(types(single.nodes)).toEqual(['text'])

    const blank = parseContent('a\n\nb', 'mc')
    expect(types(blank.nodes)).toEqual(['text', 'linebreak', 'text'])
    expect(blank.text).toBe('a\nb')
  })
})

describe('A32 MC 颜色码经共同边界输出受控节点', () => {
  it('颜色码 ⇒ color 节点，取值为表内常量（不是外部样式串）', () => {
    const r = parseContent('§aGreen', 'mc')
    expect(r.nodes).toEqual([
      { type: 'color', color: '#55FF55', children: [{ type: 'text', value: 'Green' }] },
    ])
    // 关键：树里**没有** style 字符串这条通道
    expect(serialize(r.nodes)).not.toContain('style')
  })

  it('格式码 ⇒ 结构化节点；`§r` 重置颜色与格式', () => {
    const r = parseContent('§lBold §cRed§r plain', 'mc')
    const found = types(r.nodes)
    expect(found).toContain('strong')
    expect(found).toContain('color')
    expect(r.text).toBe('Bold Red plain')
  })

  it('颜色码重置此前格式（MC 语义，与旧渲染一致）', () => {
    // `§l` 后接 `§a`：颜色码重置所有格式 ⇒ 不产出 strong
    const r = parseContent('§l§aGreen', 'mc')
    expect(types(r.nodes)).not.toContain('strong')
    expect(types(r.nodes)).toContain('color')
  })

  it('未知码原样保留（既有行为，不静默吞字符）', () => {
    const r = parseContent('§zunknown', 'mc')
    expect(r.text).toBe('§zunknown')
    expect(r.issues).toEqual([])
  })

  it('MC 码与 Markdown 走**同一**边界（不是两条路径）', () => {
    const r = parseContent('§a**bold**', 'mc')
    const t = types(r.nodes)
    expect(t).toContain('color')
    expect(t).toContain('strong')
    expect(r.text).toBe('bold')
  })

  it('多行 MC 文本按行处理并保留换行', () => {
    const r = parseContent('§aA\n§cB', 'mc')
    expect(r.text).toBe('A\nB')
    expect(types(r.nodes)).toContain('linebreak')
  })
})

describe('A32 负对照：未处理字符串直传 innerHTML/v-html 必须判红', () => {
  it('负对照前提：真实 jsdom 的 innerHTML 确实执行标记（证明确有目标保证可破）', () => {
    const host = document.createElement('div')
    host.innerHTML = '<img src=x onerror="window.__pwned=1">hi<script>window.__pwned=2</script>'
    // 注入能力是真的：元素与事件属性都进了 DOM
    expect(host.querySelector('img')).not.toBeNull()
    expect(host.querySelector('img')!.getAttribute('onerror')).toBe('window.__pwned=1')
    expect(host.querySelector('script')).not.toBeNull()
    expect(host.querySelector('script')!.textContent).toBe('window.__pwned=2')
  })

  it('同一串经 parseContent ⇒ 无 img/script，无事件属性，且有结构化 issue', () => {
    const raw = '<img src=x onerror="alert(1)">hi<script>alert(2)</script>'
    const r = parseContent(raw, 'mc')
    const s = serialize(r.nodes)
    expect(s).not.toContain('img')
    expect(s).not.toContain('script')
    expect(s).not.toContain('onerror')
    expect(s).not.toContain('<')
    // 标签被拒绝的事实以稳定码记录（供 §19.9 诊断），不是静默丢弃
    expect(r.issues.map((i) => i.code)).toContain('embeddingTag')
    expect(r.issues.find((i) => i.tag === 'img')?.attribute).toBe('onerror')
    // script 的内容是代码不是文案 ⇒ 整体丢弃；img 无内容 ⇒ 只剩 "hi"
    expect(r.text).toBe('hi')
  })

  it('渲染受控节点后 DOM 里不存在任何脚本/事件属性（端到端负对照）', () => {
    // 用与生产同一份规则产出节点，再模拟渲染层能做的唯一动作（文本节点 + 允许的元素），
    // 断言 DOM 干净。生产渲染器见 ContentText.vue（同一条允许列表）。
    const r = parseContent('<b onclick="x()">t</b><iframe src="//evil"></iframe>', 'mc')
    const host = document.createElement('div')
    const render = (nodes: readonly ContentNode[]): void => {
      for (const n of nodes) {
        if (n.type === 'text') host.appendChild(document.createTextNode(n.value))
        else if (n.type === 'linebreak') host.appendChild(document.createElement('br'))
        else if (n.type === 'link') {
          const a = document.createElement('a')
          a.setAttribute('href', n.href)
          a.setAttribute('rel', 'noopener noreferrer')
          host.appendChild(a)
          render(n.children)
        } else if (n.type === 'list') {
          const l = document.createElement(n.ordered ? 'ol' : 'ul')
          host.appendChild(l)
          n.items.forEach(() => { const li = document.createElement('li'); l.appendChild(li) })
        } else {
          const el = document.createElement(n.type === 'color' ? 'span' : n.type === 'underline' ? 'u' : n.type)
          host.appendChild(el)
          if ('children' in n) render(n.children)
        }
      }
    }
    render(r.nodes)
    expect(host.querySelector('script')).toBeNull()
    expect(host.querySelector('iframe')).toBeNull()
    expect(host.querySelector('[onclick]')).toBeNull()
    expect(host.textContent).toBe('t')
  })

  it('危险 URL 协议被拒绝：链接降级为文本，且记录 unsafeUrl', () => {
    for (const bad of [
      '[x](javascript:alert(1))',
      '[x](JaVaScRiPt:alert(1))',
      '[x](data:text/html,<script>alert(1)</script>)',
      '[x](vbscript:msgbox)',
      '[x](//evil.example/x)',
    ]) {
      const r = parseContent(bad, 'mc')
      expect(hrefs(r.nodes), bad).toEqual([])
      expect(r.issues.map((i) => i.code), bad).toContain('unsafeUrl')
      expect(serialize(r.nodes), bad).not.toContain('javascript')
      expect(serialize(r.nodes), bad).not.toContain('vbscript')
    }
  })

  it('事件属性无论值为何一律拒绝（`on*` 单独分类）', () => {
    const r = parseContent('<b onmouseover="x" onload="y">t</b>', 'mc')
    const evts = r.issues.filter((i) => i.code === 'eventAttribute')
    expect(evts.map((i) => i.attribute).sort()).toEqual(['onload', 'onmouseover'])
    expect(serialize(r.nodes)).not.toContain('onmouseover')
  })

  it('`style` 属性被拒绝：外部文本无法写入任意 CSS', () => {
    // `span` 不在允许标签表内 ⇒ 标签本身即被拒（unsupportedTag），
    // 其属性不可能生效；`style` 也不在任何允许属性表内。
    const r = parseContent('<span style="background:url(javascript:1)">x</span>', 'mc')
    expect(r.issues.map((i) => i.code)).toContain('unsupportedTag')
    expect(r.issues.find((i) => i.tag === 'span')).toBeTruthy()
    expect(serialize(r.nodes)).not.toContain('url(')
    expect(serialize(r.nodes)).not.toContain('style')
    // 文本不丢（标签拒绝，内容保留）
    expect(r.text).toBe('x')

    // `style` 也**不**在任何允许属性表内（防被悄悄加进允许列表）
    const allAttrs = Object.values(CONTENT_POLICY.allowedAttrs).flat()
    expect(allAttrs).not.toContain('style')
  })

  it('外部内容不得自带颜色声明：`span[data-mc-color]` 不可绕过 `§` 码通道', () => {
    const r = parseContent('<span data-mc-color="#FF0000">red</span>', 'mc')
    expect(r.issues.map((i) => i.code)).toContain('unsupportedTag')
    // 树上没有 color 节点：颜色只能来自 `§` 码
    expect(types(r.nodes)).not.toContain('color')
    expect(r.text).toBe('red')
    const viaMc = parseContent('§c red', 'mc')
    expect(types(viaMc.nodes)).toContain('color')
    expect(viaMc.issues).toEqual([])
  })

  it('嵌入类标签被单独分类（不是"不支持"，而是明确的注入面）', () => {
    for (const t of ['iframe', 'object', 'embed', 'svg', 'form', 'img', 'video']) {
      const r = parseContent(`<${t}></${t}>`, 'mc')
      expect(r.issues.map((i) => i.code), t).toContain('embeddingTag')
      expect(r.issues.find((i) => i.tag === t), t).toBeTruthy()
    }
  })

  it('未知（非嵌入）标签 ⇒ unsupportedTag，标签丢弃而文本保留', () => {
    const r = parseContent('<div class="x">keep me</div>', 'mc')
    expect(r.issues.map((i) => i.code)).toContain('unsupportedTag')
    expect(r.issues.find((i) => i.tag === 'div')?.attribute).toBe('class')
    expect(r.text).toBe('keep me')
  })

  it('畸形标记按文本处理，不猜测意图', () => {
    const r = parseContent('</b>stray', 'mc')
    expect(r.issues.map((i) => i.code)).toContain('malformedMarkup')
    expect(r.text).toBe('stray')
  })
})

describe('A32 允许列表是"允许什么"的单一来源（可审计、可对账）', () => {
  it('允许列表快照与实现的表一致（防表被悄悄放宽）', () => {
    expect(CONTENT_POLICY.linkProtocols).toEqual(['http:', 'https:', 'mailto:'])
    expect(CONTENT_POLICY.allowedAttrs.a).toEqual(['href'])
    // `span` 不在允许标签内（颜色只能经 `§` 码通道产生）
    expect(CONTENT_POLICY.allowedTags).not.toContain('span')
    expect(CONTENT_POLICY.allowedAttrs.span).toBeUndefined()
    // 嵌入标签**永远**不在允许标签里
    for (const t of CONTENT_POLICY.embeddingTags) {
      expect(CONTENT_POLICY.allowedTags, t).not.toContain(t)
    }
    // 表里没有 style / on* / src / srcdoc 这类属性
    const allAttrs = Object.values(CONTENT_POLICY.allowedAttrs).flat()
    for (const bad of ['style', 'src', 'srcdoc', 'href2']) expect(allAttrs).not.toContain(bad)
    expect(allAttrs.some((a) => a.startsWith('on'))).toBe(false)
  })

  it('`isSafeLinkHref` 的前缀口径（不宽容、不可绕过）', () => {
    expect(isSafeLinkHref('https://a.b')).toBe(true)
    expect(isSafeLinkHref('  HTTP://A.B  ')).toBe(true)
    expect(isSafeLinkHref('mailto:a@b')).toBe(true)
    expect(isSafeLinkHref('javascript:1')).toBe(false)
    expect(isSafeLinkHref('java\nscript:1')).toBe(false)
    expect(isSafeLinkHref('/rel/path')).toBe(false)
    expect(isSafeLinkHref('//evil')).toBe(false)
    expect(isSafeLinkHref('')).toBe(false)
  })
})

describe('A32/J3 纯性不是安全性的替代品', () => {
  it('parseContent 不改输入、可重复（同输入同输出）、不依赖 DOM', () => {
    const raw = '<img src=x onerror=1>§aText **b**'
    const before = raw
    const a = parseContent(raw, 'mc')
    const b = parseContent(raw, 'mc')
    expect(raw).toBe(before)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('contentPlainText 与解析结果的 text 一致（无障碍/对账投影同源）', () => {
    const r = parseContent('§aA **b** [c](https://d.e)', 'mc')
    expect(contentPlainText(r.nodes)).toBe(r.text)
  })

  it('节点的 type 全部落在受控清单内（渲染层分派面封闭）', () => {
    const r = parseContent('<b>b</b>§aC\n# H\n- l\n[z](https://q.r)', 'mc')
    for (const t of types(r.nodes)) {
      expect(isContentNode({ type: t })).toBe(true)
    }
    // issue 值被截断（生产不记录完整文档）
    const long = parseContent(`<img src="${'x'.repeat(500)}">`, 'mc')
    for (const i of long.issues) {
      expect((i.value ?? '').length).toBeLessThanOrEqual(65)
    }
  })
})
