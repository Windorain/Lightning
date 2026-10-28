import { MAX_PART_COUNT, MULTIPART, PAGE_LIMIT_BYTES, PART } from './constants'
import { isEnvelopeDoc, isMultipartIndex } from './detect'
import { jsonPageBytes } from './encoding'
import { indexTitle, normalizeBase, partTitle } from './titles'

export interface UploadPage {
  title: string
  text: string
}

export interface UploadPlan {
  mode: 'single' | 'multipart'
  base: string
  pages: UploadPage[]
  partCount: number
}

function buildPartDoc(base: string, partIndex: number, partCount: number, payloadSlice: string) {
  return {
    documentFormat: PART,
    part: partIndex,
    partCount,
    base: normalizeBase(base),
    payload: payloadSlice,
  }
}

function maxPayloadSliceLength(base: string, partIndex: number, partCount: number): number {
  let lo = 0
  let hi = partCount > 0 ? 1 : 0
  let payload = 'A'
  while (jsonPageBytes(buildPartDoc(base, partIndex, partCount, payload)) <= PAGE_LIMIT_BYTES) {
    hi *= 2
    payload += payload
  }
  lo = Math.floor(hi / 2)
  hi = hi - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const slice = 'A'.repeat(mid)
    if (jsonPageBytes(buildPartDoc(base, partIndex, partCount, slice)) <= PAGE_LIMIT_BYTES) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  return lo
}

function splitPayload(base: string, payload: string): Record<string, unknown>[] {
  const chunks: string[] = []
  let offset = 0
  let estimatedParts = Math.max(1, Math.ceil(payload.length / 500_000))
  while (offset < payload.length) {
    let maxLen = maxPayloadSliceLength(base, chunks.length + 1, estimatedParts)
    if (maxLen < 1) {
      throw new Error('单分片仍超过 Wiki 页面大小上限，无法上传')
    }
    let take = Math.min(maxLen, payload.length - offset)
    let slice = payload.slice(offset, offset + take)
    while (
      take > 0 &&
      jsonPageBytes(buildPartDoc(base, chunks.length + 1, estimatedParts, slice)) > PAGE_LIMIT_BYTES
    ) {
      take -= 4
      slice = payload.slice(offset, offset + take)
    }
    if (take <= 0) throw new Error('无法切分 payload')
    chunks.push(slice)
    offset += take
  }
  const n = chunks.length
  return chunks.map((c, i) => buildPartDoc(base, i + 1, n, c))
}

function buildMultipartPlan(base: string, envelope: Record<string, unknown>): UploadPlan {
  const b = normalizeBase(base)
  const parts = splitPayload(b, String(envelope.payload ?? ''))
  const index = {
    documentFormat: MULTIPART,
    partCount: parts.length,
    payloadEncoding: envelope.payloadEncoding ?? 'gzip+base64',
    meta: envelope.meta ?? {},
    base: b,
  }
  const pages: UploadPage[] = [{ title: indexTitle(b), text: JSON.stringify(index) }]
  for (let i = 0; i < parts.length; i++) {
    pages.push({ title: partTitle(b, i + 1), text: JSON.stringify(parts[i]) })
  }
  return { mode: 'multipart', base: b, pages, partCount: parts.length }
}

function buildSinglePlan(base: string, doc: unknown): UploadPlan {
  const b = normalizeBase(base)
  return {
    mode: 'single',
    base: b,
    pages: [{ title: indexTitle(b), text: JSON.stringify(doc) }],
    partCount: 0,
  }
}

function assertPartCountWithinLimit(partCount: number): void {
  if (partCount > MAX_PART_COUNT) {
    throw new Error(
      `结构数据过大：最多分成 ${MAX_PART_COUNT} 个分片页。请缩小游戏内选区，或用工作台重新导出 Envelope 后再试。`,
    )
  }
}

export function planUpload(base: string, doc: unknown): UploadPlan {
  const b = normalizeBase(base)
  if (!b) {
    throw new Error('请填写结构名称（英文/数字，对应 Data:Structures/名称.json）')
  }
  if (!doc || typeof doc !== 'object') {
    throw new Error('不是有效的 JSON 对象')
  }
  if (isMultipartIndex(doc)) {
    throw new Error('请勿上传分片索引页；请上传完整导出的 JSON 文件')
  }
  if (isEnvelopeDoc(doc)) {
    const env = doc as Record<string, unknown>
    if (jsonPageBytes(doc) <= PAGE_LIMIT_BYTES) {
      return buildSinglePlan(b, doc)
    }
    const plan = buildMultipartPlan(b, env)
    assertPartCountWithinLimit(plan.partCount)
    return plan
  }
  if (jsonPageBytes(doc) <= PAGE_LIMIT_BYTES) {
    return buildSinglePlan(b, doc)
  }
  throw new Error(
    'Plain JSON 超过 Wiki 单页上限。请用游戏/工作台导出 Envelope（gzip+base64）后再上传。',
  )
}

export function cleanupTitlesForOverwrite(
  existingIndexDoc: unknown | null,
  newPlan: UploadPlan,
  knownOldPartCount = 0,
): string[] {
  const deleteTitles: string[] = []
  const b = newPlan.base
  let oldCount = 0
  if (existingIndexDoc && isMultipartIndex(existingIndexDoc)) {
    oldCount = (existingIndexDoc as Record<string, unknown>).partCount as number
  } else if (knownOldPartCount > 0) {
    oldCount = knownOldPartCount
  }
  if (newPlan.mode === 'single') {
    for (let i = 1; i <= oldCount; i++) deleteTitles.push(partTitle(b, i))
    return deleteTitles
  }
  for (let i = newPlan.partCount + 1; i <= oldCount; i++) {
    deleteTitles.push(partTitle(b, i))
  }
  return deleteTitles
}

export function probeLegacyPartTitles(base: string, maxProbe = 32): string[] {
  const out: string[] = []
  for (let i = 1; i <= maxProbe; i++) out.push(partTitle(base, i))
  return out
}
