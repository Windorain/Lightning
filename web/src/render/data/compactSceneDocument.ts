/**
 * Envelope 场景 JSON：`meta` 为唯一元数据真源；`payload` 解压后的 JSON 根不含与 `compactMetaKeys` 中一致的元数据键。
 */

import { omitEnvelopeMetaKeys } from '@/render/data/compactMetaKeys'
import type { EnvelopeDocument, DocumentFormat } from '@/render/schema/types'
import { COMPACT_PAYLOAD_ENCODING } from '@/render/schema/types'

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i)
  }
  return out
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前环境不支持 DecompressionStream（gzip），无法解压 Envelope 场景')
  }
  const ds = new DecompressionStream('gzip')
  const stream = new Blob([bytes]).stream().pipeThrough(ds)
  const buf = await new Response(stream).arrayBuffer()
  return new Uint8Array(buf)
}

/** `canonicalizeEnvelopeInPlace` 会把根上 `documentFormat` 折入 `meta`，此时仍须识别为 Envelope 信封。 */
function isEnvelopeStructural(doc: Record<string, unknown>): boolean {
  return (
    doc.payloadEncoding === COMPACT_PAYLOAD_ENCODING &&
    typeof doc.payload === 'string' &&
    doc.payload.length > 0 &&
    doc.meta !== null &&
    typeof doc.meta === 'object' &&
    !Array.isArray(doc.meta)
  )
}

export function isEnvelopeDocument(doc: unknown): doc is EnvelopeDocument {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return false
  const o = doc as Record<string, unknown>
  return o.documentFormat === 'Envelope' || isEnvelopeStructural(o)
}

/** 读取根级文档格式；缺省视为 Plain（兼容旧 JSON）。 */
export function readDocumentFormat(doc: unknown): DocumentFormat | undefined {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return undefined
  const o = doc as Record<string, unknown>
  const v = o.documentFormat
  if (v === 'Envelope' || v === 'Plain') return v
  if (isEnvelopeStructural(o)) return 'Envelope'
  return undefined
}

/**
 * 读取展示用元数据：Envelope 仅 `meta`；Plain 仅根对象。
 */
export function readSceneMetaField(document: unknown, key: string): string {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return ''
  if (isEnvelopeDocument(document)) {
    const meta = document.meta
    if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
      const m = meta as Record<string, unknown>
      if (Object.prototype.hasOwnProperty.call(m, key) && m[key] != null) {
        return String(m[key])
      }
    }
    return ''
  }
  const d = document as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(d, key) && d[key] != null) {
    return String(d[key])
  }
  return ''
}

/** 稳定场景 id；无则 `'scene'`。 */
export function sceneStableStringIdFromDocument(document: unknown): string {
  const id = readSceneMetaField(document, 'id')
  if (id.length > 0) return id
  return 'scene'
}

/**
 * Envelope：解压 payload，去掉 payload 根上的元数据键，再与 `meta` 合并（**meta 权威**）。
 * Plain：原样返回。
 */
export async function normalizeEnvelopeToPlain(document: unknown): Promise<unknown> {
  if (!isEnvelopeDocument(document)) {
    return document
  }
  if (document.payloadEncoding !== COMPACT_PAYLOAD_ENCODING) {
    throw new Error(
      `不支持的 payloadEncoding：期望 "${COMPACT_PAYLOAD_ENCODING}"，实际为 ${String(document.payloadEncoding)}`,
    )
  }
  if (typeof document.payload !== 'string' || document.payload.length === 0) {
    throw new Error('Envelope 文档缺少非空 payload 字符串')
  }
  const { meta } = document
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error('Envelope 文档缺少 meta 对象')
  }
  const bytes = base64ToUint8Array(document.payload)
  const decoded = await gunzip(bytes)
  const text = new TextDecoder('utf-8').decode(decoded)
  let inner: unknown
  try {
    inner = JSON.parse(text) as unknown
  } catch (e) {
    throw new Error(`Envelope payload 非合法 JSON：${e instanceof Error ? e.message : String(e)}`)
  }
  if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) {
    throw new Error('Envelope payload 解压后须为 JSON 对象')
  }
  const innerStripped = omitEnvelopeMetaKeys(inner as Record<string, unknown>)
  // 信封根上的 documentFormat: Envelope 会经 canonicalize 折入 meta；合并后须是 Plain 形，避免「下载 Plain」仍带 Envelope。
  return { ...innerStripped, ...(meta as Record<string, unknown>), documentFormat: 'Plain' }
}

// v2 version helpers
export { detectVersion, migrateV1ToV2 } from './versionMigration'
export type {
  V2PlainSceneDocument,
  V2BlockInstance,
  V2BlockPart,
  V2AnnotationBox,
  V2Label,
  V2GuiState,
  V2StatsTemplate,
} from './sceneDocumentV2'
