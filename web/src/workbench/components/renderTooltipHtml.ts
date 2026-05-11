/**
 * Tooltip HTML 渲染：MC 颜色码(§x) → HTML span + snarkdown Markdown。
 */

import snarkdown from 'snarkdown'

/** MC 颜色码 → CSS color 映射 */
const MC_COLORS: Record<string, string> = {
  '0': '#000000', '1': '#0000AA', '2': '#00AA00', '3': '#00AAAA',
  '4': '#AA0000', '5': '#AA00AA', '6': '#FFAA00', '7': '#AAAAAA',
  '8': '#555555', '9': '#5555FF', 'a': '#55FF55', 'b': '#55FFFF',
  'c': '#FF5555', 'd': '#FF55FF', 'e': '#FFFF55', 'f': '#FFFFFF',
}

/** 格式码对应的 HTML 标签 */
const MC_FORMAT: Record<string, { open: string; close: string }> = {
  'l': { open: '<strong>', close: '</strong>' },
  'm': { open: '<del>', close: '</del>' },
  'n': { open: '<u>', close: '</u>' },
  'o': { open: '<em>', close: '</em>' },
}

interface StackEntry { close: string }

/**
 * 将 MC 格式码(§x)转为 HTML，再用 snarkdown 处理 Markdown。
 * 顺序：先处理 § 码 → HTML span，再 snarkdown（snarkdown 保留已有 HTML 标签）。
 */
export function renderTooltipHtml(text: string): string {
  if (!text) return ''
  // 不包含 § 码则直接用 snarkdown
  if (!text.includes('§')) {
    return snarkdown(text)
  }

  const stack: StackEntry[] = []
  let result = ''
  let i = 0

  while (i < text.length) {
    if (text[i] === '§' && i + 1 < text.length) {
      const code = text[i + 1]
      // 颜色码：MC 规则中颜色码会重置之前所有格式（粗/斜/删除/下划线）
      if (MC_COLORS[code]) {
        while (stack.length > 0) {
          result += stack.pop()!.close
        }
        result += `<span style="color:${MC_COLORS[code]}">`
        stack.push({ close: '</span>' })
        i += 2
        continue
      }
      // 格式码
      const fmt = MC_FORMAT[code]
      if (fmt) {
        result += fmt.open
        stack.push({ close: fmt.close })
        i += 2
        continue
      }
      // 重置码
      if (code === 'r') {
        while (stack.length > 0) {
          result += stack.pop()!.close
        }
        i += 2
        continue
      }
      // 未知码，原样保留
      result += text[i]
      i++
      continue
    }
    result += text[i]
    i++
  }

  // 关闭未闭合的标签
  while (stack.length > 0) {
    result += stack.pop()!.close
  }

  // snarkdown 处理剩余的 Markdown 语法，保留已生成的 HTML 标签
  return snarkdown(result)
}
