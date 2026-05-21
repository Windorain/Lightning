/**
 * 单一加载阶段：自内嵌 Base64 池解码 PNG，构造 SimpleMaterialLibrary（零 HTTP）。
 */

import { normalizeEnvelopeToPlain } from '@/render/data/compactSceneDocument'
import { validateRenderBundle } from '@/render/data/bundleResolve'
import { buildMaterialLibrary } from '@/render/data/buildMaterialLibrary'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import type { RenderBundle } from '@/render/schema/types'

/** 默认 dev 场景文件名（无 URL 参数时）：`data/scenes/<id>.json` */
export const DEFAULT_PREVIEW_SCENE_ID = 'export'

export interface PreviewSessionResult {
  renderBundle: RenderBundle
  materialLibrary: MaterialLibraryApi
}

/**
 * 由打包场景 document（StructureData | World）构建 **View3DConfig 核心载荷**：
 * `renderBundle`（`document` 为 normalize 后值）+ 预载 `materialLibrary`。
 */
export async function loadPreviewSessionFromDocument(document: unknown): Promise<PreviewSessionResult> {
  const normalized = await normalizeEnvelopeToPlain(document)
  const renderBundle: RenderBundle = { document: normalized }
  validateRenderBundle(renderBundle)
  const materialLibrary = await buildMaterialLibrary(normalized)
  return { renderBundle, materialLibrary }
}
