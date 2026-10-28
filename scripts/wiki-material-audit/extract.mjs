/**
 * extract.mjs —— 从页面 wikitext 里找出「这个页面嵌入了哪些结构」
 * ============================================================================
 *
 * 嵌入方式经站内侦察确认有两种（详见 README「侦察结论」）：
 *
 *   1. 模板调用（主流，41 个页面经 template links 索引）：
 *        {{渲染器
 *        |结构名称=工业高炉四共
 *        |宽度=750px }}
 *      模板本体（Template:渲染器）产出 <div class="web-structure-renderer"
 *      data-wsr-structure="...">，客户端再据此去取 Data:Structures/名字.json。
 *
 *   2. 直接写挂载 div（高级用法，站内仅 1 页）：
 *        <div class="web-structure-renderer" data-wsr-structure="PseudoBiosphere" ...>
 *
 * 因此提取口径 = 「模板调用」∪「data-wsr-structure 属性」。两条都按同一套规则清洗：
 *
 *   - 先去掉 HTML 注释与 <pre>/<nowiki>/<syntaxhighlight>/<code> 块 —— 这些是
 *     文档示例，不会被渲染成挂载点（站内 用户指导 的示例就在 <pre> 里）；
 *   - 参数值里若残留 {{{参数}}} / {{模板}} / [[链接]]，说明名字是算出来的，
 *     不做猜测：记入 placeholders，交给报告列为未解析；
 *   - 名字做 normalizeStructureBase（去 .json、去 Data:Structures/ 前缀），
 *     对齐 Data 页标题时再由 titleKey 把下划线视同空格。
 */

import { normalizeStructureBase } from './envelope.mjs'

const TEMPLATE_RE = /\{\{\s*(?:Template:|模板:)?渲染器(?=\s*(?:\||\}\}))/g
const DIV_ATTR_RE = /data-wsr-structure\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g

export function normalizeLineEndings(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n')
}

/** 去掉不会被渲染成挂载点的区域（注释与代码示例块）。 */
export function stripNonRendered(wikitext) {
  return normalizeLineEndings(wikitext)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, '')
    .replace(/<nowiki\b[^>]*>[\s\S]*?<\/nowiki>/gi, '')
    .replace(/<syntaxhighlight\b[^>]*>[\s\S]*?<\/syntaxhighlight>/gi, '')
    .replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, '')
}

/** 从 start（指向 "{{"）起找到配对的 "}}" 结束位置；找不到返回 -1。 */
export function findTemplateEnd(text, start) {
  let depth = 0
  for (let i = start; i < text.length - 1; i++) {
    if (text[i] === '{' && text[i + 1] === '{') {
      depth++
      i++
      continue
    }
    if (text[i] === '}' && text[i + 1] === '}') {
      depth--
      i++
      if (depth === 0) return i + 1
      continue
    }
  }
  return -1
}

/** 拆模板参数（只在顶层 | 上切，[[..]] 与 {{..}} 内部不切）。 */
export function parseTemplateParams(body) {
  const firstPipe = body.indexOf('|')
  const payload = firstPipe >= 0 ? body.slice(firstPipe + 1) : ''
  const parts = []
  let depth = 0
  let current = ''
  for (let i = 0; i < payload.length; i++) {
    const ch = payload[i]
    const next = payload[i + 1]
    if ((ch === '{' && next === '{') || (ch === '[' && next === '[')) {
      depth++
      current += ch + next
      i++
      continue
    }
    if ((ch === '}' && next === '}') || (ch === ']' && next === ']')) {
      depth--
      current += ch + next
      i++
      continue
    }
    if (ch === '|' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)

  const params = {}
  let positional = 1
  for (const part of parts) {
    const match = /^\s*([^=\n|]+?)\s*=([\s\S]*)$/.exec(part)
    if (match) params[match[1].trim()] = match[2].trim()
    else params[String(positional++)] = part.trim()
  }
  return params
}

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

function isDynamic(value) {
  return /\{\{|\}\}|\[\[|\]\]/.test(value)
}

/**
 * 提取页面上的挂载点。
 * @returns {{mounts:Array<{kind:string,name:string,rawName:string,dataTitle:string,line:number}>, placeholders:Array<{kind:string,raw:string,line:number}>}}
 */
export function extractMounts(wikitext) {
  const text = stripNonRendered(wikitext)
  const mounts = []
  const placeholders = []

  TEMPLATE_RE.lastIndex = 0
  let match
  while ((match = TEMPLATE_RE.exec(text))) {
    const start = match.index
    const end = findTemplateEnd(text, start)
    if (end < 0) continue
    const params = parseTemplateParams(text.slice(start + 2, end - 2))
    const raw = params['结构名称'] != null ? params['结构名称'] : params['1']
    TEMPLATE_RE.lastIndex = end
    if (raw == null || raw === '') continue
    if (isDynamic(raw)) {
      placeholders.push({ kind: 'template', raw, line: lineOf(text, start) })
      continue
    }
    const name = normalizeStructureBase(raw)
    if (!name) continue
    mounts.push({
      kind: 'template',
      name,
      rawName: raw,
      dataTitle: 'Data:Structures/' + name + '.json',
      line: lineOf(text, start),
    })
  }

  DIV_ATTR_RE.lastIndex = 0
  while ((match = DIV_ATTR_RE.exec(text))) {
    const raw = (match[1] != null ? match[1] : match[2] != null ? match[2] : match[3] || '').trim()
    if (!raw) continue
    if (isDynamic(raw)) {
      placeholders.push({ kind: 'div', raw, line: lineOf(text, match.index) })
      continue
    }
    const name = normalizeStructureBase(raw)
    if (!name) continue
    mounts.push({
      kind: 'div',
      name,
      rawName: raw,
      dataTitle: 'Data:Structures/' + name + '.json',
      line: lineOf(text, match.index),
    })
  }

  return { mounts, placeholders }
}

/** 页面里是否出现与渲染器相关的字样（用于全站扫描时的廉价预筛）。 */
export function mightMount(text) {
  return /渲染器|data-wsr-structure|web-structure-renderer/.test(text)
}
