/**
 * EnvelopeParser — Envelope 文档 → RuntimeDocument
 *
 * 解压 gzip+base64 payload 后委托 V2PlainParser / WorldParser。
 */
import { isEnvelopeDocument, normalizeEnvelopeToPlain } from '@/render/data/compactSceneDocument'
import { parserRegistry } from '@/workbench/context/parserRegistry'
import type { RuntimeDocument } from '@/workbench/context/runtimeDocument'
import type { DocumentParser } from '@/workbench/context/parserRegistry'

export const EnvelopeParser: DocumentParser = {
  formatName: 'Envelope',
  detect(raw: unknown): boolean {
    return isEnvelopeDocument(raw)
  },
  async parse(raw: unknown): Promise<RuntimeDocument | null> {
    const plain = await normalizeEnvelopeToPlain(raw)
    if (plain === raw) return null // 解压失败
    // 委托下游 parser 继续解析
    const result = await parserRegistry.detectAndParse(plain)
    return result.document
  },
}
