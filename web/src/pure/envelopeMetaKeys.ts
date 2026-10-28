/**
 * Envelope 元数据键：纯类型 + 纯函数。
 * 无 Three.js / Vue / DOM 依赖。
 */

/** 打入 Envelope.meta、并从 payload 解压 JSON 根上剔除的键 */
export const ENVELOPE_META_KEYS = [
  'id',
  'label',
  'author',
  // 两条版本事实是一对：gtnhVersion 是整合包版本（dreamcraft），gtVersion 是 GregTech 版本。
  // 两者都必须是 meta 键，否则重新打包时 GT 版本会被搬进 payload 根（同一份文件两种位置）。
  'gtnhVersion',
  'gtVersion',
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
