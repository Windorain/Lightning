/**
 * ParserRegistry — 文档反序列化分发中心。
 *
 * 所有格式统一转为 RuntimeDocument。
 * Parser 负责 detect + parse（含解压等预处理）。
 * 取代旧的 formatDispatcher + handler 系统。
 */
import type { RuntimeDocument } from '@/context/runtimeDocument'
import { SHAPE_FIRST_PARSERS } from '@/context/parsers/builtinParsers'

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

export class ParserRegistryImpl {
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

/**
 * 创建默认注册表。
 *
 * **注册顺序即判别优先级**：`SHAPE_FIRST_PARSERS`（形态判别型，当前 = Multiblock）预置在表头，
 * 之后由 host 按历史顺序追加既有四类（V2Plain → Envelope → World → StructureData）。
 * 多方块为主的文档带 `format_version:"2.0" + frames`，若不抢先判别会被 V2Plain/World 抢走
 * （契约 §2）；既有四类 parser 的 detect 与注册顺序均未改动。
 */
export function createParserRegistry(): ParserRegistryImpl {
  const registry = new ParserRegistryImpl()
  for (const p of SHAPE_FIRST_PARSERS) {
    registry.register(p)
  }
  return registry
}
