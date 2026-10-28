/**
 * 文本内容边界（`editors/ui` 文本呈现边界）。
 *
 * ## 为什么需要一个「内容模型」而不是一个 HTML 串
 *
 * 旧路径是 `pure/renderTooltipHtml.ts`：把外部文本（MC 颜色码 + Markdown）拼成
 * **HTML 字符串**，再由各组件的 `v-html` 注入 DOM。这条路径有两个结构性缺陷：
 *
 * 1. **字符串即权限**：只要某个字段进了 `v-html`，它写什么标签、什么属性、什么 URL 都生效。
 *    `snarkdown` **不**转义原始 HTML —— 实测 `<script>alert(1)</script>` 原样透出
 *    （见 `__tests__/textContentBoundary.test.ts` 的正/负对照）。也就是说
 *    "外部内容"与"可执行标记"当时在同一条通道上。
 * 2. **每个组件各自选路径**：`ToolTipBox`、`ToolTipPreview`、注解预览、Inspector 各自
 *    `v-html="renderTooltipHtml(...)"`，于是"允许什么"这个问题在代码里没有唯一答案。
 *
 * ## 本模块的立场（硬约束）
 *
 * - 领域模型只存**文本语义或受限格式数据**：`ContentNode` 就是那份受限格式数据；
 *   `parseContent` 是"字符串 → 受限格式数据"的**唯一**转换口。
 * - Markdown 与 MC 颜色码经**同一**解析边界输出**受控节点**（不是 HTML 串）。
 * - 若使用 HTML，须经**允许列表**处理后以专门类型（`ContentNode`）传递；
 *   任意字符串**不**直接进 `v-html`/`innerHTML`。
 * - URL 协议、事件属性、嵌入标签的处理是**显式**的（见 `ALLOWED_TAGS` / `ALLOWED_ATTRS` /
 *   `LINK_PROTOCOLS` / `EMBEDDING_TAGS`），被拒绝的事实以稳定代码记录（`ContentIssue`），
 *   供结构化诊断使用。
 * - **纯转换函数同样执行内容允许规则**：`parseContent` 是纯函数
 *   （显式输入、不改输入、不读全局时钟/随机/DOM），且它的输出**已经**是受控节点 ——
 *   纯性不是安全性的替代品，这里两者同时成立。
 *
 * ## 分层与依赖
 *
 * 本文件在 `domain/` 层：不依赖 Vue / Three / DOM / IO（导入规则 1/2/6，
 * 由 `web/tests/architecture/` 的闸门规则静态检查）。唯一运行时依赖是 Markdown
 * 词法库 `snarkdown`。
 *
 * ## 为什么仍然复用 `snarkdown`
 *
 * MC 工具tip 的既有渲染行为（`**bold**` / `_em_` / `` `code` `` / 列表 / 标题）由
 * `snarkdown` 决定，已被大量单测与 e2e 文案断言锁定。本模块**保留**它的词法结果，
 * 但把它的**输出字符串**当成"待审文本"再走一遍允许列表解析 —— 于是行为不变、
 * 权限收紧。这就是"HTML 须经允许列表处理后以专门类型传递"的落地形态。
 */

import snarkdown from 'snarkdown'

// ─────────────────────────────────────────────────────────────────────────────
// 受限格式数据（领域模型接受的唯一"格式化"表示）
// ─────────────────────────────────────────────────────────────────────────────

/** 内容模式：`plain` = 普通文本（不解释任何标记）；`mc` = MC 颜色码 + Markdown。 */
export type ContentMode = 'plain' | 'mc'

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

/**
 * 受控呈现节点。
 *
 * **不变量**：`ContentNode` 里没有"原始标记"这一形态 —— 没有 `rawHtml`、没有
 * `innerHTML`、没有 `tagName`+`attributes` 的自由组合。渲染层能做的只有"按 `type` 分派"，
 * 因此"允许什么"由本文件的允许列表唯一决定，渲染层无从放宽。
 */
export type ContentNode =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'linebreak' }
  | { readonly type: 'strong'; readonly children: readonly ContentNode[] }
  | { readonly type: 'em'; readonly children: readonly ContentNode[] }
  | { readonly type: 'del'; readonly children: readonly ContentNode[] }
  | { readonly type: 'underline'; readonly children: readonly ContentNode[] }
  | { readonly type: 'code'; readonly children: readonly ContentNode[] }
  /** MC 颜色码：`color` 是**本模块表内**的 `#rrggbb`，不是外部传入的样式串。 */
  | { readonly type: 'color'; readonly color: string; readonly children: readonly ContentNode[] }
  /** 已通过协议允许列表的链接；渲染层**必须**补 `rel`/`target`（见 `ContentText.vue`）。 */
  | { readonly type: 'link'; readonly href: string; readonly children: readonly ContentNode[] }
  | { readonly type: 'heading'; readonly level: HeadingLevel; readonly children: readonly ContentNode[] }
  | { readonly type: 'paragraph'; readonly children: readonly ContentNode[] }
  | { readonly type: 'quote'; readonly children: readonly ContentNode[] }
  | { readonly type: 'list'; readonly ordered: boolean; readonly items: readonly (readonly ContentNode[])[] }

/** 被拒绝事实的**稳定代码**（错误用稳定错误码 + 参数；语言改变不改断言）。 */
export type ContentIssueCode =
  /** 标签不在允许列表内（如 `<div>`）。 */
  | 'unsupportedTag'
  /** 嵌入类标签：单独分类，便于诊断区分"渲染噪声"与"注入尝试"（iframe/object/svg…）。 */
  | 'embeddingTag'
  /** 事件属性（`on*`）—— 无论值为何一律拒绝。 */
  | 'eventAttribute'
  /** URL 协议不在允许列表内（`javascript:` / `data:` / 相对协议绕过）。 */
  | 'unsafeUrl'
  /** 属性不在允许列表内（如 `style` / `src` / `srcdoc`）。 */
  | 'unsafeAttribute'
  /** 标签闭合不匹配等畸形标记：按纯文本处理，不猜测意图。 */
  | 'malformedMarkup'

/** 结构化拒绝事实（供诊断关联；值经截断，不携带完整文档）。 */
export interface ContentIssue {
  readonly code: ContentIssueCode
  readonly tag?: string
  readonly attribute?: string
  /** 已截断的证据片段（≤ `ISSUE_VALUE_MAX`）。 */
  readonly value?: string
}

/** `ContentIssue.value` 的最大长度（生产不记录完整文档）。 */
export const ISSUE_VALUE_MAX = 64

/** 解析结果。`nodes` 是**唯一**可交给渲染层的东西。 */
export interface ParsedContent {
  readonly nodes: readonly ContentNode[]
  readonly issues: readonly ContentIssue[]
  /** 纯文本投影：无障碍标签、e2e 文案对账、导出用。 */
  readonly text: string
}

// ─────────────────────────────────────────────────────────────────────────────
// 允许列表（「HTML 须经允许列表」的单一来源）
// ─────────────────────────────────────────────────────────────────────────────

/** 允许的标签 → 内部节点类型。表外标签一律拒绝（标签丢弃、文本保留）。 */
const ALLOWED_TAGS: Readonly<Record<string, string>> = {
  a: 'link',
  strong: 'strong', b: 'strong',
  em: 'em', i: 'em',
  del: 'del', s: 'del', strike: 'del',
  u: 'underline', ins: 'underline',
  code: 'code',
  pre: 'pre',
  p: 'paragraph',
  blockquote: 'quote',
  ul: 'ul', ol: 'ol', li: 'li',
  br: 'br',
}

/** 标题标签（`h1`–`h6`）单独处理：级别来自标签名。 */
const HEADING_RE = /^h([1-6])$/

/**
 * 嵌入类标签：**不是**"不支持"，而是"明确的注入面"。
 *
 * 单列一张表有两个用处：(1) 诊断能区分"渲染噪声"与"注入尝试"；
 * (2) 允许列表演进时，这些标签**永远**不会被误加进去（测试逐条钉住）。
 */
const EMBEDDING_TAGS = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'svg', 'math', 'template', 'noscript', 'link', 'meta', 'base', 'form', 'input',
  'button', 'select', 'textarea', 'audio', 'video', 'source', 'track', 'canvas',
  'img', 'picture', 'portal', 'slot',
])

/**
 * 允许的属性：标签 → 允许的属性集合。
 *
 * 刻意**只有** `a[href]` 与词法器产物 `pre[class]`。
 * - `style` 不允许：MC 颜色由 `§` 码经 `color` 节点表达（取值来自本模块的常量表），
 *   于是外部文本无法写入任意 CSS。这正是旧实现的注入面之一：
 *   旧路径把外部串里的 `<span style="…">` 原样透给 `v-html`。
 * - `class`/`id` 不允许（`pre` 的**词法器指纹**除外，见 `LEXER_PRE_CLASS`）：
 *   外部内容不得参与选择器与 DOM 标识（「DOM/ARIA 标识不冲突」）。
 * - `on*` 在表外，且被**单独**分类为 `eventAttribute`（便于逐条断言）。
 *
 * 注意 `span` **不在允许标签表内**：颜色只能经 `§` 码产生，
 * 不能由外部内容自带 `data-mc-color` 自行声明（否则等于给外部文本一条
 * "自己决定呈现属性"的通道）。
 */
const ALLOWED_ATTRS: Readonly<Record<string, readonly string[]>> = {
  a: ['href'],
  pre: ['class'],
}

/**
 * `snarkdown` 对围栏代码块自造的 `class` 值（`<pre class="code ">`）。
 *
 * 它不是"外部内容携带的属性"，而是**词法器的输出指纹**：只接受这一枚精确值，
 * 其它任何 `class` 一律 `unsafeAttribute`。这样既不必为词法器产物放宽
 * "class 不允许"这条通则，又不会让合法围栏代码块产生假诊断。
 */
const LEXER_PRE_CLASS = 'code '

/** 允许的 URL 协议（`a[href]`）。表外协议一律拒绝，链接降级为纯文本。 */
export const LINK_PROTOCOLS: readonly string[] = ['http:', 'https:', 'mailto:']

/** MC 颜色码 → `#rrggbb`（表内常量；外部无法影响）。 */
const MC_COLORS: Readonly<Record<string, string>> = {
  '0': '#000000', '1': '#0000AA', '2': '#00AA00', '3': '#00AAAA',
  '4': '#AA0000', '5': '#AA00AA', '6': '#FFAA00', '7': '#AAAAAA',
  '8': '#555555', '9': '#5555FF', 'a': '#55FF55', 'b': '#55FFFF',
  'c': '#FF5555', 'd': '#FF55FF', 'e': '#FFFF55', 'f': '#FFFFFF',
}

/** MC 格式码 → 节点类型（`§r` 是重置，单独处理）。 */
const MC_FORMATS: Readonly<Record<string, 'strong' | 'del' | 'underline' | 'em'>> = {
  l: 'strong', m: 'del', n: 'underline', o: 'em',
}

/** `data-mc-color` 形态的常量颜色校验已无消费者：颜色只经 `§` 码产生。
 * 保留此常量仅用于诊断值的合法性说明，避免误把外部颜色串当合法输入。 */
const MC_COLOR_ATTR_RE = /^#[0-9a-fA-F]{6}$/

/** 该值是否形如本模块表内的 `#rrggbb`（供诊断与测试核对，不构成注入通道）。 */
export function isKnownMcColor(value: string): boolean {
  return MC_COLOR_ATTR_RE.test(value) && Object.values(MC_COLORS).includes(value.toUpperCase())
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML 允许列表解析（把 snarkdown 的输出当"待审文本"）
// ─────────────────────────────────────────────────────────────────────────────

interface RawAttr { readonly name: string; readonly value: string }
interface RawTag {
  readonly name: string
  readonly closing: boolean
  readonly selfClosing: boolean
  readonly attrs: readonly RawAttr[]
}

/** 扫描一个标签：从 `<` 起；返回标签与下一个下标。畸形 ⇒ `null`（按文本处理）。 */
function readTag(html: string, start: number): { tag: RawTag; next: number } | null {
  const end = html.indexOf('>', start)
  if (end < 0) return null
  let inner = html.slice(start + 1, end).trim()
  if (inner.startsWith('!--')) return null
  const closing = inner.startsWith('/')
  if (closing) inner = inner.slice(1).trim()
  const selfClosing = inner.endsWith('/')
  if (selfClosing) inner = inner.slice(0, -1).trim()

  const nameMatch = /^[A-Za-z][A-Za-z0-9:-]*/.exec(inner)
  if (!nameMatch) return null
  const name = nameMatch[0].toLowerCase()
  const rest = inner.slice(nameMatch[0].length)

  const attrs: RawAttr[] = []
  // 属性词法：`name` | `name=value` | `name="value"` | `name='value'`
  const attrRe = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  let m: RegExpExecArray | null
  while ((m = attrRe.exec(rest)) !== null) {
    attrs.push({ name: m[1]!.toLowerCase(), value: m[2] ?? m[3] ?? m[4] ?? '' })
  }
  return { tag: { name, closing, selfClosing, attrs }, next: end + 1 }
}

/** `snarkdown` 的少量实体转义；只做反向映射，不引入解析器。 */
const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'", nbsp: '\u00a0',
}

function decodeEntities(s: string): string {
  return s.replace(/&(#?[A-Za-z0-9]+);/g, (whole, name: string) =>
    ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? whole)
}

/** 截断证据值（生产不记录完整文档）。 */
function clip(value: string): string {
  return value.length <= ISSUE_VALUE_MAX ? value : `${value.slice(0, ISSUE_VALUE_MAX)}…`
}

/**
 * `href` 是否安全：**必须以允许列表里的协议开头**。
 *
 * 刻意不做宽容处理：归一化只有 `trim()` + `toLowerCase()` 后按前缀匹配，
 * 因此 `java\nscript:`、大小写混写都不能绕过；任何不匹配（含相对路径、
 * 协议相对 `//evil.example`）都判不安全。宁可降级为文本，
 * 不给"看起来像链接"的近似语义。
 */
export function isSafeLinkHref(href: string): boolean {
  const normalized = href.trim().toLowerCase()
  if (normalized === '') return false
  return LINK_PROTOCOLS.some((p) => normalized.startsWith(p))
}

interface ParseState { issues: ContentIssue[] }

interface Frame {
  readonly kind: string
  readonly tagName: string
  readonly extra: Readonly<Record<string, unknown>>
  children: ContentNode[]
}

/** `b`/`strong` 等别名族：闭合标签允许跨别名配对（`<b>x</strong>` 视为配对）。 */
function tagFamily(name: string): string {
  return ALLOWED_TAGS[name] ?? name
}

function attributeEvidence(tag: RawTag): { attribute?: string } {
  const on = tag.attrs.find((a) => a.name.startsWith('on'))
  if (on) return { attribute: on.name }
  const first = tag.attrs[0]
  return first ? { attribute: first.name } : {}
}

/** 属性审计：`on*` 单独分类；允许列表外一律 `unsafeAttribute`。 */
function auditAttributes(tag: RawTag, state: ParseState): void {
  const allowed = ALLOWED_ATTRS[tag.name] ?? []
  for (const a of tag.attrs) {
    if (a.name.startsWith('on')) {
      state.issues.push({ code: 'eventAttribute', tag: tag.name, attribute: a.name, value: clip(a.value) })
      continue
    }
    if (!allowed.includes(a.name)) {
      state.issues.push({ code: 'unsafeAttribute', tag: tag.name, attribute: a.name, value: clip(a.value) })
      continue
    }
    if (tag.name === 'pre' && a.name === 'class' && a.value !== LEXER_PRE_CLASS) {
      state.issues.push({ code: 'unsafeAttribute', tag: 'pre', attribute: 'class', value: clip(a.value) })
    }
  }
}

/** 合并相邻文本节点、去掉空文本（让节点树可稳定比较）。 */
function mergeText(nodes: readonly ContentNode[]): ContentNode[] {
  const out: ContentNode[] = []
  for (const n of nodes) {
    if (n.type === 'text') {
      if (n.value === '') continue
      const last = out[out.length - 1]
      if (last && last.type === 'text') {
        out[out.length - 1] = { type: 'text', value: last.value + n.value }
        continue
      }
    }
    out.push(n)
  }
  return out
}

/** 容器语义收编：单子节点上提，其余包成段落。 */
function passthrough(children: readonly ContentNode[]): ContentNode {
  const kids = mergeText(children)
  if (kids.length === 1 && kids[0]) return kids[0]
  return { type: 'paragraph', children: kids }
}

/** 把一个收束的帧变成节点；`link` 未通过协议审计 ⇒ 退化为纯文本容器。 */
function buildNode(f: Frame): ContentNode | null {
  const kids = mergeText(f.children)
  switch (f.kind) {
    case 'strong': case 'em': case 'del': case 'underline': case 'code':
      return { type: f.kind, children: kids }
    case 'paragraph':
      return { type: 'paragraph', children: kids }
    case 'quote':
      return { type: 'quote', children: kids }
    case 'heading':
      return { type: 'heading', level: (f.extra.level as HeadingLevel) ?? 1, children: kids }
    case 'color':
      return { type: 'color', color: f.extra.color as string, children: kids }
    case 'link':
      if (f.extra.linkOk === true) return { type: 'link', href: f.extra.href as string, children: kids }
      // 协议审计未通过：容器保留、链接语义丢弃（文本不丢）
      return passthrough(kids)
    case 'pre':
      // 围栏代码块：`pre` 是词法器容器，语义由内部 `code` 承担
      return passthrough(kids)
    case 'ul': case 'ol': {
      const items: (readonly ContentNode[])[] = []
      for (const c of kids) {
        // `li` 在 buildNode 里已着床为 `paragraph` 载体（见 case 'li'），
        // 取它的 children 作为该项内容；其它子节点（畸形）按单项处理。
        if (c.type === 'paragraph') items.push(c.children)
        else items.push([c])
      }
      return { type: 'list', ordered: f.kind === 'ol', items }
    }
    case 'li':
      // 列表项**必须**有自己的节点边界，否则相邻项的文本会被 mergeText 合并
      // （`<li>a</li><li>b</li>` 会退化成单个 "ab"）。用 paragraph 作载体，
      // `list` 构建时取出它的 children 作为该项内容。
      return { type: 'paragraph', children: kids }
    // 未通过审计的 `span` / 未知容器：容器语义丢弃，子节点上提
    default:
      return passthrough(kids)
  }
}

/**
 * 把（可能含标记的）字符串按允许列表转成受控节点。
 *
 * 处理规则（「URL 协议、事件属性、嵌入标签处理明确」）：
 * - 允许列表内的标签 ⇒ 对应节点；
 * - `EMBEDDING_TAGS` ⇒ `embeddingTag`，标签丢弃、文本内容保留
 *   （`script`/`style` 连同**内容**整体丢弃 —— 其内容是代码而非文案）；
 * - 其它未知标签 ⇒ `unsupportedTag`，标签丢弃、文本保留；
 * - `on*` 属性 ⇒ `eventAttribute`（无论值为何）；
 * - `a[href]` 非允许协议 ⇒ `unsafeUrl`，该 `a` 降级为纯文本容器（不产出 `link` 节点）；
 * - 其它属性 ⇒ `unsafeAttribute`；
 * - 闭合不匹配 ⇒ `malformedMarkup`，按文本处理。
 */
function parseMarkup(input: string, state: ParseState): ContentNode[] {
  const root: Frame = { kind: 'root', tagName: '', extra: {}, children: [] }
  const stack: Frame[] = [root]
  const top = (): Frame => stack[stack.length - 1]!

  let i = 0
  let buffer = ''

  const flushText = (): void => {
    if (buffer === '') return
    top().children.push({ type: 'text', value: decodeEntities(buffer) })
    buffer = ''
  }

  /**
   * 收束第 `index` 帧**及其之上**的全部帧（含 `index` 本身）。
   *
   * 注意必须**含** `index`：闭合标签 `</strong>` 的语义是"把 `strong` 帧收束成节点
   * 挂到父帧"，不是"只收束它内部的帧、把 `strong` 留在栈上继续吸收后续文本"。
   * 后者会让 `<strong>x</strong> y` 变成"整串都在 strong 里"。
   *
   * 根帧（下标 0）**永不**被收束：调用方以 `closeTo(1)` 收尾，且此处有
   * `stack.length > 0` 守卫 —— 否则会试图把根节点的内容挂到不存在的父帧上。
   */
  const closeTo = (index: number): void => {
    while (stack.length - 1 >= index) {
      const f = stack.pop()!
      const built = buildNode(f)
      if (built && stack.length > 0) stack[stack.length - 1]!.children.push(built)
    }
  }

  while (i < input.length) {
    if (input[i] !== '<') {
      buffer += input[i]
      i++
      continue
    }
    const read = readTag(input, i)
    if (read === null) {
      if (/^<\/?[A-Za-z]/.test(input.slice(i))) {
        state.issues.push({ code: 'malformedMarkup', value: clip(input.slice(i, i + ISSUE_VALUE_MAX)) })
      }
      buffer += input[i]
      i++
      continue
    }
    const { tag, next } = read
    i = next

    const headingMatch = HEADING_RE.exec(tag.name)
    const isAllowed = tag.name in ALLOWED_TAGS || headingMatch !== null

    if (!isAllowed) {
      flushText()
      if (!tag.closing) {
        const isEmbedding = EMBEDDING_TAGS.has(tag.name)
        state.issues.push({
          code: isEmbedding ? 'embeddingTag' : 'unsupportedTag',
          tag: tag.name,
          ...attributeEvidence(tag),
        })
        if (tag.name === 'script' || tag.name === 'style') {
          // 内容是可执行片段/样式表，不是文案：连同内容整体丢弃，
          // 否则它会被当作文本展示，并在复制/导出时扩散。
          const close = new RegExp(`</${tag.name}\\s*>`, 'i')
          const found = close.exec(input.slice(i))
          i = found ? i + found.index + found[0].length : input.length
        }
      }
      continue
    }

    if (tag.closing) {
      flushText()
      let idx = -1
      for (let s = stack.length - 1; s >= 1; s--) {
        if (tagFamily(stack[s]!.tagName) === tagFamily(tag.name)) { idx = s; break }
      }
      if (idx < 0) {
        state.issues.push({ code: 'malformedMarkup', tag: tag.name, value: clip(`</${tag.name}>`) })
        continue
      }
      closeTo(idx)
      continue
    }

    flushText()

    if (headingMatch) {
      stack.push({ kind: 'heading', tagName: tag.name, extra: { level: Number(headingMatch[1]) }, children: [] })
    } else {
      const kind = ALLOWED_TAGS[tag.name]!
      if (kind === 'br') {
        top().children.push({ type: 'linebreak' })
        continue
      }
      const extra: Record<string, unknown> = {}
      if (kind === 'ol') extra.ordered = true
      if (kind === 'ul') extra.ordered = false
      if (kind === 'link') {
        const href = tag.attrs.find((a) => a.name === 'href')?.value ?? ''
        if (isSafeLinkHref(href)) {
          extra.href = href.trim()
          extra.linkOk = true
        } else {
          if (href.trim() !== '') {
            state.issues.push({ code: 'unsafeUrl', tag: 'a', attribute: 'href', value: clip(href) })
          }
          extra.linkOk = false
        }
      }
      auditAttributes(tag, state)
      stack.push({ kind, tagName: tag.name, extra, children: [] })
    }

    if (tag.selfClosing) {
      const f = stack.pop()!
      const built = buildNode(f)
      if (built) top().children.push(built)
    }
  }

  flushText()
  closeTo(1)
  return root.children
}

// ─────────────────────────────────────────────────────────────────────────────
// MC 颜色码 → 结构化节点（不再产出 `<span style="...">` 串）
// ─────────────────────────────────────────────────────────────────────────────

interface McRun {
  readonly color: string | null
  readonly formats: readonly ('strong' | 'del' | 'underline' | 'em')[]
  readonly text: string
  /**
   * 本 run 是**换行**而不是文本。
   *
   * 为什么把换行做成显式 run，而不是让 `\n` 留在文本里交给 Markdown 词法：
   * `snarkdown` 会吃掉行首/行尾的空白（包括 `\n`），于是 `§aA\n§cB` 的换行
   * 会**静默消失**（本文件的"多行 MC 文本保留换行"断言抓出过这个行为）。
   * MC 工具tip 是行导向的，换行是**语义**而不是排版细节，必须显式表达。
   */
  readonly linebreak?: boolean
}

/** 按 MC 码切分文本为"样式 run"；`\n` 产出显式 `linebreak` run。未知码原样保留（既有行为）。 */
function splitMcRuns(text: string): McRun[] {
  const runs: McRun[] = []
  let color: string | null = null
  let formats: ('strong' | 'del' | 'underline' | 'em')[] = []
  let buf = ''

  const push = (): void => {
    if (buf === '') return
    runs.push({ color, formats: [...formats], text: buf })
    buf = ''
  }
  const pushBreak = (): void => {
    push()
    runs.push({ color: null, formats: [], text: '', linebreak: true })
  }

  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\n') {
      pushBreak()
      i++
      continue
    }
    if (ch === '§' && i + 1 < text.length) {
      const lower = text[i + 1]!.toLowerCase()
      if (MC_COLORS[lower]) {
        push()
        // MC 规则：颜色码重置之前所有格式（粗/斜/删除/下划线）
        color = MC_COLORS[lower]!
        formats = []
        i += 2
        continue
      }
      const fmt = MC_FORMATS[lower]
      if (fmt) {
        push()
        formats.push(fmt)
        i += 2
        continue
      }
      if (lower === 'r') {
        push()
        color = null
        formats = []
        i += 2
        continue
      }
    }
    buf += ch
    i++
  }
  push()
  return runs
}

/** 给 run 的节点套上格式与颜色（颜色在外、格式在内，与旧渲染的层级一致）。 */
function wrapRunNodes(run: McRun, state: ParseState): ContentNode[] {
  if (run.linebreak === true) return [{ type: 'linebreak' }]
  let nodes: ContentNode[] = parseMarkup(markdownToHtml(run.text), state)
  for (const fmt of [...run.formats].reverse()) {
    nodes = [{ type: fmt, children: mergeText(nodes) }]
  }
  if (run.color !== null) {
    nodes = [{ type: 'color', color: run.color, children: mergeText(nodes) }]
  }
  return nodes
}

function markdownToHtml(text: string): string {
  return snarkdown(text)
}

// ─────────────────────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解析外部文本为受控节点 —— **唯一**入口。
 *
 * - `mode: 'plain'`：不解释任何标记。整串成为一个文本节点（`<script>` 也是文本）。
 *   这是"普通文本"契约：安全性来自"从不解释"，而不是来自过滤。
 * - `mode: 'mc'`：MC 颜色码 → `color` 节点；Markdown → 允许列表节点；
 *   HTML → 允许列表；其余按纯文本。
 *
 * 纯函数：不改输入、不读 DOM/全局时钟/随机、不抛异常（畸形输入降级为文本 + issue）。
 */
export function parseContent(input: string, mode: ContentMode = 'plain'): ParsedContent {
  const text = typeof input === 'string' ? input : ''
  if (text === '') return { nodes: [], issues: [], text: '' }

  if (mode === 'plain') {
    return { nodes: [{ type: 'text', value: text }], issues: [], text }
  }

  const state: ParseState = { issues: [] }
  let nodes: ContentNode[]

  if (!text.includes('§')) {
    // 无 MC 码：整串走 Markdown + 允许列表（与旧 `snarkdown(text)` 词法一致）
    nodes = parseMarkup(markdownToHtml(text), state)
  } else {
    // 有 MC 码：**整串**切样式 run（格式状态跨行延续，与旧实现在整串上拼 HTML 一致），
    // 每个 run 的文本再走 Markdown + 允许列表。
    //
    // 与旧实现的一处**已知差异**（记录在案，不隐瞒）：旧实现把
    //「文本 + 颜色 span + 格式标签」拼成一整串后调**一次** `snarkdown`，
    // 因此一个 Markdown 构造可以跨越颜色码边界；本实现按 run 分别走词法，
    // 跨边界的 Markdown 构造不再连接。对 MC 工具tip（`§` 码按行重置样式）而言
    // 两者等价，而"每个 run 独立"让"文本语义"与"呈现属性"不再互相渗透。
    const out: ContentNode[] = []
    for (const run of splitMcRuns(text)) out.push(...wrapRunNodes(run, state))
    nodes = mergeText(out)
  }

  return { nodes, issues: state.issues, text: contentPlainText(nodes) }
}

/**
 * 逐行解析（行间以 `linebreak` 分隔）—— **不**让 Markdown/格式状态跨行延续。
 *
 * 用于调用方本来就持有"行数组"的场景（Inspector 的 tooltip 预览、侧栏多行说明）：
 * 旧实现在那些地方逐行调用渲染函数再以 `\n` 拼接，本函数保持该语义。
 */
export function parseContentLines(lines: readonly string[], mode: ContentMode = 'mc'): ParsedContent {
  const state: ParseState = { issues: [] }
  const out: ContentNode[] = []
  const useMarkdown = mode === 'mc'

  lines.forEach((line, idx) => {
    if (idx > 0) out.push({ type: 'linebreak' })
    if (line === '') return
    if (!useMarkdown) {
      out.push({ type: 'text', value: line })
      return
    }
    if (!line.includes('§')) {
      out.push(...parseMarkup(markdownToHtml(line), state))
      return
    }
    for (const run of splitMcRuns(line)) out.push(...wrapRunNodes(run, state))
  })

  const nodes = mergeText(out)
  return { nodes, issues: state.issues, text: contentPlainText(nodes) }
}

/** 纯文本投影（用于无障碍标签 / e2e 文案对账 / 导出）。 */
export function contentPlainText(nodes: readonly ContentNode[]): string {
  let out = ''
  const walk = (list: readonly ContentNode[]): void => {
    for (const n of list) {
      switch (n.type) {
        case 'text': out += n.value; break
        case 'linebreak': out += '\n'; break
        case 'list':
          n.items.forEach((item, i) => {
            if (i > 0) out += '\n'
            walk(item)
          })
          break
        default: walk(n.children)
      }
    }
  }
  walk(nodes)
  return out
}

const CONTENT_NODE_TYPES = new Set<string>([
  'text', 'linebreak', 'strong', 'em', 'del', 'underline', 'code',
  'color', 'link', 'heading', 'paragraph', 'quote', 'list',
])

/** 受限格式数据的类型守卫：只有本模块能产出 `ContentNode`（外部无法手搓"自由节点"）。 */
export function isContentNode(value: unknown): value is ContentNode {
  if (typeof value !== 'object' || value === null) return false
  return CONTENT_NODE_TYPES.has((value as { type?: string }).type ?? '')
}

/** 节点类型清单（供渲染层分派与测试对账）。 */
export const CONTENT_NODE_TYPE_LIST: readonly string[] = [...CONTENT_NODE_TYPES]

/** 允许列表快照（供测试与诊断核对"允许什么"这一事实）。 */
export const CONTENT_POLICY = Object.freeze({
  allowedTags: Object.keys(ALLOWED_TAGS).concat(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']),
  allowedAttrs: ALLOWED_ATTRS,
  linkProtocols: LINK_PROTOCOLS,
  embeddingTags: [...EMBEDDING_TAGS],
  mcColors: MC_COLORS,
})
