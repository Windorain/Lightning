/**
 * envelope.mjs —— 导出件（Envelope）解码与分片拼装
 * ============================================================================
 *
 * 实测格式（2026-10 对 gtnh.huijiwiki.com 的 Data:Structures/*.json 全量取样，71 页）：
 *
 *   Envelope（单页）：
 *     { documentFormat: "Envelope", payloadEncoding: "gzip+base64", meta: {...},
 *       payload: "<gzip 的 base64>" }
 *     payload 解压后是 Plain 文档：
 *       { textureBlobs: [base64 PNG], materialPalette: [{locator, kind, textureBlobIndex, ...}],
 *         blockPalette: [{registryId, geometry:{quads:[{materialIndex,...}]}}],
 *         cellGrid, frames?: [{index, structure:{cellGrid, blockPalette}}] }
 *     注意：有 frames 的导出件，几何在 frames[].structure 里，而 textureBlobs /
 *     materialPalette 仍在**根**上（帧间共用）。别只看其中一层。
 *
 *   Envelope/multipart（分页索引）：
 *     { documentFormat: "Envelope/multipart", partCount: N, base: "名字", payloadEncoding, meta }
 *     分片页： { documentFormat: "Envelope/part", part: 1..N, partCount, base, payload }
 *     把 payload 按 part 顺序拼起来，再按索引页的 payloadEncoding 解压。
 *
 *   已知偏差（本工具如实报告，不做静默兼容）：站内 PseudoBiosphere 的分片页标题是
 *   "PseudoBiosphere 01.json"（空格），而客户端 StructureRenderEntry.js 拼的是
 *   "PseudoBiosphere_01.json"（下划线与 pad2）。也就是说页面嵌入的这个结构在浏览器里
 *   根本加载不到分片。本工具两种命名都试（为了把内容审出来），但会把「客户端命名
 *   对不上」作为缺口写进报告。
 */

import { gunzipSync } from 'node:zlib'

export class EnvelopeError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'EnvelopeError'
    this.code = code || 'ENVELOPE'
  }
}

export function parseJsonDocument(text) {
  if (typeof text !== 'string') throw new EnvelopeError('页面内容不是字符串', 'NOT-TEXT')
  const body = text.replace(/^\uFEFF/, '').trim()
  if (!body) throw new EnvelopeError('页面内容为空', 'EMPTY')
  try {
    return JSON.parse(body)
  } catch (error) {
    throw new EnvelopeError('不是合法 JSON：' + error.message, 'BAD-JSON')
  }
}

export function isMultipartIndex(value) {
  return !!(value && value.documentFormat === 'Envelope/multipart' && value.partCount > 0)
}

export function isMultipartPart(value) {
  return !!(value && value.documentFormat === 'Envelope/part' && Number.isInteger(value.part))
}

/**
 * 解一个单页 Envelope，返回 Plain 文档对象。
 * @param {object} envelope
 * @returns {{documentFormat:string, payloadEncoding:string, meta:object, doc:object}}
 */
export function decodeEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') throw new EnvelopeError('Envelope 不是对象', 'NOT-OBJECT')
  if (isMultipartIndex(envelope)) throw new EnvelopeError('这是分片索引页，需要先拼装分片', 'MULTIPART-INDEX')
  if (envelope.documentFormat !== 'Envelope') {
    throw new EnvelopeError('未知 documentFormat：' + String(envelope.documentFormat), 'FORMAT')
  }
  const encoding = envelope.payloadEncoding || 'gzip+base64'
  if (encoding !== 'gzip+base64') throw new EnvelopeError('不支持的 payloadEncoding：' + encoding, 'ENCODING')
  return {
    documentFormat: envelope.documentFormat,
    payloadEncoding: encoding,
    meta: envelope.meta || {},
    doc: decodePayload(envelope.payload, envelope.meta),
  }
}

function decodePayload(payload, meta) {
  if (typeof payload !== 'string' || !payload) throw new EnvelopeError('payload 缺失', 'NO-PAYLOAD')
  let inflated
  try {
    inflated = gunzipSync(Buffer.from(payload, 'base64'))
  } catch (error) {
    throw new EnvelopeError('payload 解压失败：' + error.message, 'GUNZIP')
  }
  try {
    return JSON.parse(inflated.toString('utf8'))
  } catch (error) {
    throw new EnvelopeError('payload 不是合法 JSON：' + error.message, 'PAYLOAD-JSON')
  }
}

export function normalizeStructureBase(raw) {
  let value = String(raw == null ? '' : raw).trim()
  if (!value) return ''
  value = value.replace(/\.json$/i, '')
  value = value.replace(/^Data:Structures\//i, '')
  value = value.replace(/^Data:/i, '')
  const slash = value.lastIndexOf('/')
  if (slash >= 0) value = value.slice(slash + 1)
  return value.trim()
}

export function structureDataTitle(base) {
  const normalized = normalizeStructureBase(base)
  return normalized ? 'Data:Structures/' + normalized + '.json' : ''
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

/**
 * 分片页标题候选。按客户端约定先给 base_NN，再给站内实际出现的 base NN。
 * @returns {string[]}
 */
export function multipartPartTitleCandidates(indexDoc, fallbackBase, partIndex) {
  const base = normalizeStructureBase(indexDoc && indexDoc.base ? indexDoc.base : fallbackBase)
  if (!base) return []
  return [
    'Data:Structures/' + base + '_' + pad2(partIndex) + '.json',
    'Data:Structures/' + base + ' ' + pad2(partIndex) + '.json',
  ]
}

/**
 * 把分片文档按 part 顺序拼装成一个可供 decodeEnvelope 使用的等价 Envelope。
 * @param {object} indexDoc
 * @param {object[]} partDocs
 */
export function mergeMultipart(indexDoc, partDocs) {
  if (!isMultipartIndex(indexDoc)) throw new EnvelopeError('不是分片索引页', 'NOT-INDEX')
  const expected = indexDoc.partCount
  if (!Array.isArray(partDocs) || partDocs.length !== expected) {
    throw new EnvelopeError('分片数量不匹配：期望 ' + expected + '，实得 ' + (partDocs ? partDocs.length : 0), 'PART-COUNT')
  }
  const sorted = partDocs.slice().sort((a, b) => a.part - b.part)
  for (let i = 0; i < sorted.length; i++) {
    if (!isMultipartPart(sorted[i])) throw new EnvelopeError('第 ' + (i + 1) + ' 个分片格式不对', 'PART-FORMAT')
    if (sorted[i].part !== i + 1) throw new EnvelopeError('缺少分片 part ' + (i + 1), 'PART-MISSING')
  }
  return {
    documentFormat: 'Envelope',
    payloadEncoding: indexDoc.payloadEncoding || 'gzip+base64',
    meta: indexDoc.meta || {},
    payload: sorted.map((part) => part.payload || '').join(''),
  }
}

/** 页面标题归一化：用于把模板里的名字对齐到 Data 页标题（下划线视同空格）。 */
export function titleKey(title) {
  return String(title || '')
    .replace(/^Data:/i, '')
    .replace(/\.json$/i, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
