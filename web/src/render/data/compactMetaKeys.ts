/**
 * Envelope 元数据键：唯一真源在信封 `meta`；gzip payload 内不应再含这些顶层键（浅层约定，与 StructureData/World 根一致）。
 *
 * 现在从 `@/pure/envelopeMetaKeys` 再导出（向后兼容）。
 */

export {
  ENVELOPE_META_KEYS,
  ROOT_META_FORM_KEYS,
  omitEnvelopeMetaKeys,
  pickEnvelopeMeta,
  type EnvelopeMetaKey,
  type RootMetaFormKey,
} from '@/pure/envelopeMetaKeys'
