/**
 * 预览加载 helpers。
 *
 * `loadPreviewSessionFromDocument` 保留用于外部 SDK 向后兼容；
 * 解压 + 校验通过，材质库由 renderAssets 内部按需构建。
 */
import { normalizeEnvelopeToPlain } from '@/render/data/compactSceneDocument'
import { validatePackedSceneDocument } from '@/render/data/bundleResolve'
import type { RenderBundle } from '@/render/schema/types'

/** 默认 dev 场景文件名（无 URL 参数时）：`data/scenes/<id>.json` */
export const DEFAULT_PREVIEW_SCENE_ID = 'export'

export interface PreviewSessionResult {
  renderBundle: RenderBundle
}

/**
 * 由打包场景 document 构建 RenderBundle（normalize + validate）。
 * 材质库不在此时构建——由 renderAssets 内部按需调用 buildMaterialLibrary。
 */
export async function loadPreviewSessionFromDocument(document: unknown): Promise<PreviewSessionResult> {
  const normalized = await normalizeEnvelopeToPlain(document)
  validatePackedSceneDocument(normalized)
  const renderBundle: RenderBundle = { document: normalized }
  return { renderBundle }
}
