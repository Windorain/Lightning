import { isMultipartIndex } from './detect'
import { normalizeBase, partTitle } from './titles'

export interface MultipartPartDoc {
  part: number
  payload?: string
}

export function mergeMultipartIndex(
  indexDoc: unknown,
  partDocs: MultipartPartDoc[],
): Record<string, unknown> {
  if (!isMultipartIndex(indexDoc)) {
    return indexDoc as Record<string, unknown>
  }
  const index = indexDoc as Record<string, unknown>
  const n = index.partCount as number
  const sorted = partDocs.slice().sort((a, b) => a.part - b.part)
  if (sorted.length !== n) {
    throw new Error(`分片数量不匹配：索引 ${n}，实际 ${sorted.length}`)
  }
  let payload = ''
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].part !== i + 1) {
      throw new Error(`缺少分片 part ${i + 1}`)
    }
    payload += sorted[i].payload ?? ''
  }
  return {
    documentFormat: 'Envelope',
    payloadEncoding: index.payloadEncoding ?? 'gzip+base64',
    meta: index.meta ?? {},
    payload,
  }
}

export function partTitlesFromIndex(indexDoc: unknown, base?: string): string[] | null {
  if (!isMultipartIndex(indexDoc)) return null
  const idx = indexDoc as Record<string, unknown>
  const b = normalizeBase(String(base ?? idx.base ?? ''))
  const out: string[] = []
  for (let i = 1; i <= (idx.partCount as number); i++) {
    out.push(partTitle(b, i))
  }
  return out
}
