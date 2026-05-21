/**
 * ParserRegistry — 文档反序列化分发中心。
 *
 * 所有格式统一转为 RuntimeDocument。
 * Parser 负责 detect + parse（含解压等预处理）。
 * 取代旧的 formatDispatcher + handler 系统。
 */
import type { RuntimeDocument } from '@/workbench/context/runtimeDocument'

export interface DocumentParser {
  formatName: string
  detect(raw: unknown): boolean
  /** 反序列化：任意源格式 → RuntimeDocument。返回 null 表示解析失败。 */
  parse(raw: unknown): RuntimeDocument | Promise<RuntimeDocument | null>
}

export interface ParseResult {
  document: RuntimeDocument | null
  parser: DocumentParser | null
  error?: string
}

class ParserRegistryImpl {
  private parsers: DocumentParser[] = []

  register(p: DocumentParser): void {
    // 按注册顺序优先匹配
    this.parsers.push(p)
  }

  async detectAndParse(raw: unknown): Promise<ParseResult> {
    for (const p of this.parsers) {
      if (p.detect(raw)) {
        try {
          const doc = await p.parse(raw)
          if (doc) {
            return { document: doc, parser: p }
          }
          return { document: null, parser: p, error: `无法将 ${p.formatName} 转为 RuntimeDocument` }
        } catch (e) {
          return { document: null, parser: p, error: `${p.formatName} 解析错误: ${e}` }
        }
      }
    }
    return { document: null, parser: null, error: '未知文档格式' }
  }
}

export const parserRegistry = new ParserRegistryImpl()
