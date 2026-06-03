/**
 * Envelope 信封构建与元数据 patch（纯函数，不依赖浏览器 API）。
 *
 * 现在从 `@/pure/envelope` 再导出（向后兼容）。
 */

export {
  mergeRootStringFields,
  patchSceneMetadataRoot,
  buildEnvelopePackage,
  type BuildEnvelopeOptions,
} from '@/pure/envelope'
export type { RootMetaFormKey } from '@/render/data/compactMetaKeys'
