/**
 * Envelope 信封构建与元数据 patch（纯函数，不依赖浏览器 API）。
 */

import pako from 'pako'

import {
  ENVELOPE_META_KEYS,
  ROOT_META_FORM_KEYS,
  omitEnvelopeMetaKeys,
  pickEnvelopeMeta,
  type RootMetaFormKey,
} from '@/render/data/compactMetaKeys'
import { isEnvelopeDocument } from '@/render/data/compactSceneDocument'
import type { EnvelopeDocument } from '@/render/schema/types'
import { COMPACT_PAYLOAD_ENCODING } from '@/render/schema/types'

export type { RootMetaFormKey }

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

/** 合并表单字段到 Plain 文档根级。纯函数，不修改入参。 */
export function mergeRootStringFields(
  document: unknown,
  fields: Record<RootMetaFormKey, string>,
): Record<string, unknown> {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('document 须为非 null 对象')
  }
  const doc = { ...(document as Record<string, unknown>) }
  for (const k of ROOT_META_FORM_KEYS) {
    const v = fields[k]
    if (v === '') {
      delete doc[k]
    } else {
      doc[k] = v
    }
  }
  return doc
}

/** 元数据 patch：浅合并到 Plain 文档根级。纯函数，不修改入参。 */
export function patchSceneMetadataRoot(
  document: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('document 须为非 null 对象')
  }
  return { ...(document as Record<string, unknown>), ...patch }
}

export interface BuildEnvelopeOptions {
  metaKeys?: readonly string[]
}

/** 将 Plain 文档打包为 Envelope 信封。纯函数。 */
export function buildEnvelopePackage(
  document: unknown,
  options: BuildEnvelopeOptions = {},
): EnvelopeDocument {
  if (isEnvelopeDocument(document)) {
    throw new Error('buildEnvelopePackage 仅接受 Plain 形文档')
  }
  const keys = options.metaKeys ?? ENVELOPE_META_KEYS
  const src = document as Record<string, unknown>
  const meta = pickEnvelopeMeta(src, keys)
  const body = omitEnvelopeMetaKeys(src, keys)
  const gz = pako.gzip(JSON.stringify(body))
  const b64 = uint8ToBase64(gz)
  return {
    documentFormat: 'Envelope',
    payloadEncoding: COMPACT_PAYLOAD_ENCODING,
    meta,
    payload: b64,
  }
}
