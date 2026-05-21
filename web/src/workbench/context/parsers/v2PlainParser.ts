/**
 * V2PlainParser — V2PlainSceneDocument → RuntimeDocument
 *
 * 由于 RuntimeDocument 本身已经持有 fromV2Plain 工厂方法，
 * 此 parser 只是 detect + 委托。
 */
import { RuntimeDocument } from '@/workbench/context/runtimeDocument'
import type { DocumentParser } from '@/workbench/context/parserRegistry'

export const V2PlainParser: DocumentParser = {
  formatName: 'V2Plain',
  detect(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') return false
    const d = raw as Record<string, unknown>
    return d.format_version === '2.0' && Array.isArray(d.frames)
  },
  async parse(raw: unknown) {
    return RuntimeDocument.fromV2Plain(raw as Record<string, unknown>)
  },
}
