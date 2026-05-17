/**
 * 库入口（IIFE）：mount、类型与数据校验 API。
 *
 * - `EmbedViewer`：Vue 组件，必需 `props.config: View3DConfig`（与 `resolveBootstrapToView3DConfig` 结果一致）；内部自建 `provide(View3DContextKey)`，无需外层注入。
 * - 无整页 Vue 树时一般用 `mount()`；已有 Vue 应用可 `createApp` / `<EmbedViewer :config="cfg" />`。
 * 不包含 SDE Workbench 整站（WorkbenchRoot 等）；后者见 main-workbench.ts 与 vite.workbench.config.ts，产物为 dist-workbench/（含 bundled/ 下的打包分块，勿与库 dist/ 或场景导出混淆）。
 * 灰机/wiki 嵌入只需 npm run build:lib，勿部署 dist-workbench。
 */

import '@/styles/nei-tokens.css'

/** 推荐挂载点 class；无参 `mount()` 仍会回退兼容 `#web-structure-renderer` */
export const MOUNT_SELECTOR = '.web-structure-renderer'

export { mount } from './embed/mount'
export { default as EmbedViewer } from './embed/EmbedViewer.vue'
export type { EmbedBootstrapOptions, EmbedData, EmbedUiOptions, View3DFeatures } from './embed/embedContract'
export type { View3DConfig } from './preview/previewConfig'

export { loadPreviewSessionFromDocument } from './preview/previewSession'
export {
  normalizeEnvelopeToPlain,
  readDocumentFormat,
  isEnvelopeDocument,
  readSceneMetaField,
  sceneStableStringIdFromDocument,
} from './render/data/compactSceneDocument'
export { ENVELOPE_META_KEYS, ROOT_META_FORM_KEYS } from './render/data/compactMetaKeys'
export type { EnvelopeMetaKey, RootMetaFormKey } from './render/data/compactMetaKeys'
export type { EnvelopeDocument, DocumentFormat } from './render/schema/types'
export { COMPACT_PAYLOAD_ENCODING } from './render/schema/types'

export {
  buildMaterialRegistryFromSceneDocument,
  resolveRenderBundle,
  validatePackedSceneDocument,
  validateRenderBundle,
  type RenderBundle,
  type RenderBundleResolveResult,
} from './render/data/bundleResolve'

export {
  patchSceneMetadataRoot,
  buildEnvelopePackage,
  type BuildEnvelopeOptions,
} from './render/data/sceneExport'
export { downloadJson, copyTextToClipboard } from './util/browser'
export { view3DConfigFromDocument, documentLooksPreviewable } from './preview/previewFromDocument'
export type { View3DConfigFromDocumentOptions } from './preview/previewFromDocument'
