/**
 * Envelope 场景 JSON：`meta` 为唯一元数据真源；`payload` 解压后的 JSON 根不含与 `compactMetaKeys` 中一致的元数据键。
 */

import { omitEnvelopeMetaKeys } from '@/render/data/compactMetaKeys'
import type { EnvelopeDocument, DocumentFormat } from '@/render/schema/types'
import { COMPACT_PAYLOAD_ENCODING } from '@/render/schema/types'

/**
 * fixture 专用载荷编码：`base64(未压缩 JSON)`。
 *
 * 与生产形态 `gzip+base64` **共用同一读取路径**（多方块格式契约 §8.3）：
 * `payload` 解 base64 得字节 → 先当 UTF-8 JSON 文本解析 → 失败再 gunzip → 解析。
 * 该取值只影响人工阅读/diff 的便利性，不影响任何解析分支 —— 分派由「先 JSON 后 gunzip」完成。
 */
export const PLAIN_BASE64_PAYLOAD_ENCODING = 'base64(json)' as const

/** 已支持的载荷编码（契约 §8.3 的两个取值）。 */
export const SUPPORTED_PAYLOAD_ENCODINGS = [COMPACT_PAYLOAD_ENCODING, PLAIN_BASE64_PAYLOAD_ENCODING] as const

/** 只要带 payload/meta 的信封形对象即可读取（`EnvelopeDocument` 的 `payloadEncoding` 类型只认生产取值）。 */
export interface EnvelopePayloadDocument {
  payloadEncoding?: unknown
  payload: string
  meta: Record<string, unknown>
}

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
    (SUPPORTED_PAYLOAD_ENCODINGS as readonly unknown[]).includes(doc.payloadEncoding) &&
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
 * Envelope 载荷解码（契约 §8.3 的**同一把钥匙**）：base64 → 字节 → 先当 UTF-8 JSON 文本解析 → 失败再 gunzip。
 *
 * 生产形态 `base64(gzip(json))` 与 fixture 形态 `base64(json)` 都由此读取；
 * 未知 `payloadEncoding` 仍显式报错（既有行为不变）。
 */
export async function decodeEnvelopePayload(document: EnvelopePayloadDocument): Promise<Record<string, unknown>> {
  if (!(SUPPORTED_PAYLOAD_ENCODINGS as readonly unknown[]).includes(document.payloadEncoding)) {
    throw new Error(
      `不支持的 payloadEncoding：期望 "${COMPACT_PAYLOAD_ENCODING}" 或 "${PLAIN_BASE64_PAYLOAD_ENCODING}"，` +
        `实际为 ${String(document.payloadEncoding)}`,
    )
  }
  if (typeof document.payload !== 'string' || document.payload.length === 0) {
    throw new Error('Envelope 文档缺少非空 payload 字符串')
  }
  const bytes = base64ToUint8Array(document.payload)

  const direct = tryParseUtf8Json(bytes)
  const inner = direct ?? (await parseGunzippedPayload(bytes))
  if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) {
    throw new Error('Envelope payload 解压后须为 JSON 对象')
  }
  return inner as Record<string, unknown>
}

/**
 * Envelope → `{ inner, plain }`：
 *  - `inner`  = payload 解出的**内层 body**（多方块文档要把它原样交给装配器）；
 *  - `plain`  = `inner` 剔除信封元数据键后与 `meta` 合并（**meta 权威**）的 Plain 形态。
 *
 * 非 Envelope 输入抛错（调用方先用 `isEnvelopeDocument` 判别）。
 */
export async function readEnvelopeLayers(
  document: EnvelopePayloadDocument,
): Promise<{ inner: Record<string, unknown>; plain: Record<string, unknown> }> {
  const { meta } = document
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error('Envelope 文档缺少 meta 对象')
  }
  const inner = await decodeEnvelopePayload(document)
  const innerStripped = omitEnvelopeMetaKeys(inner)
  // 信封根上的 documentFormat: Envelope 会经 canonicalize 折入 meta；合并后须是 Plain 形，避免「下载 Plain」仍带 Envelope。
  const plain = { ...innerStripped, ...(meta as Record<string, unknown>), documentFormat: 'Plain' }
  return { inner, plain }
}

function tryParseUtf8Json(bytes: Uint8Array): unknown | null {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

async function parseGunzippedPayload(bytes: Uint8Array): Promise<unknown> {
  let decoded: Uint8Array
  try {
    decoded = await gunzip(bytes)
  } catch (e) {
    throw new Error(
      `Envelope payload 既不是 JSON 文本，也无法 gunzip 解压：${e instanceof Error ? e.message : String(e)}`,
    )
  }
  const text = new TextDecoder('utf-8').decode(decoded)
  try {
    return JSON.parse(text) as unknown
  } catch (e) {
    throw new Error(`Envelope payload 非合法 JSON：${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * Envelope：解压 payload，去掉 payload 根上的元数据键，再与 `meta` 合并（**meta 权威**）。
 * Plain：原样返回。
 */
export async function normalizeEnvelopeToPlain(document: unknown): Promise<unknown> {
  if (!isEnvelopeDocument(document)) {
    return document
  }
  const { plain } = await readEnvelopeLayers(document)
  return plain
}

// v2 version helpers
export { detectVersion, migrateV1ToV2 } from './versionMigration'
export type {
  V2PlainSceneDocument,
  V2AnnotationBox,
  V2Label,
  V2StatsTemplate,
} from './sceneDocumentV2'
