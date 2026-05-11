/**
 * Envelope 元数据键：唯一真源在信封 `meta`；gzip payload 内不应再含这些顶层键（浅层约定，与 StructureData/World 根一致）。
 */

/** 打入 Envelope.meta、并从 payload 解压 JSON 根上剔除的键 */
export const ENVELOPE_META_KEYS = [
  'id',
  'label',
  'author',
  'gtnhVersion',
  'structureId',
  'schemaVersion',
  'documentFormat',
] as const

export type EnvelopeMetaKey = (typeof ENVELOPE_META_KEYS)[number]

/** 工作台元数据表单字段（`schemaVersion` / `documentFormat` 由导出管线维护） */
export const ROOT_META_FORM_KEYS = [
  'id',
  'label',
  'author',
  'gtnhVersion',
  'structureId',
] as const

export type RootMetaFormKey = (typeof ROOT_META_FORM_KEYS)[number]

export function omitEnvelopeMetaKeys(
  src: Record<string, unknown>,
  keys: readonly string[] = ENVELOPE_META_KEYS,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...src }
  for (const k of keys) {
    delete out[k]
  }
  return out
}

export function pickEnvelopeMeta(
  src: Record<string, unknown>,
  keys: readonly string[] = ENVELOPE_META_KEYS,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {}
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(src, k)) {
      meta[k] = src[k]
    }
  }
  return meta
}
