/**
 * 单一加载阶段：自内嵌 Base64 池解码 PNG，构造 SimpleMaterialLibrary（零 HTTP）。
 */

import * as THREE from 'three'

import { normalizeEnvelopeToPlain } from '@/render/data/compactSceneDocument'
import {
  buildMaterialRegistryFromSceneDocument,
  validateRenderBundle,
} from '@/render/data/bundleResolve'
import {
  hydrateMaterialBlendsInSceneDocument,
  listPaletteTextureDataUrls,
} from '@/render/data/sceneDocumentMaterialHydrate'
import { SimpleMaterialLibrary, type MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import type { RenderBundle } from '@/render/schema/types'
import { formatUnknownError } from '@/util/formatUnknownError'

/** 默认 dev 场景文件名（无 URL 参数时）：`data/scenes/<id>.json` */
export const DEFAULT_PREVIEW_SCENE_ID = 'export'

export interface PreviewSessionResult {
  renderBundle: RenderBundle
  materialLibrary: MaterialLibraryApi
}

function loadTextureDataUrl(loader: THREE.TextureLoader, dataUrl: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    loader.load(dataUrl, resolve, undefined, reject)
  })
}

/**
 * 由打包场景 document（StructureData | World）构建 **View3DConfig 核心载荷**：
 * `renderBundle`（`document` 为 normalize 后值）+ 预载 `materialLibrary`。
 * `AppShell` / `createView3DStore` 只消费 `View3DConfig` 中这两部分 + UI 开关。
 */
export async function loadPreviewSessionFromDocument(document: unknown): Promise<PreviewSessionResult> {
  const normalized = await normalizeEnvelopeToPlain(document)
  const renderBundle: RenderBundle = { document: normalized }
  validateRenderBundle(renderBundle)

  const loader = new THREE.TextureLoader()
  const fetchList = listPaletteTextureDataUrls(normalized)
  const textures = await Promise.all(
    fetchList.map(async ({ materialId, dataUrl }) => {
      try {
        const tex = await loadTextureDataUrl(loader, dataUrl)
        return [materialId, tex] as const
      } catch (e) {
        throw new Error(
          `解码 textureBlobs 项失败（materialId=${materialId}）：${formatUnknownError(e)}`,
        )
      }
    }),
  )

  const preloaded = new Map<string, THREE.Texture>(textures)
  hydrateMaterialBlendsInSceneDocument(normalized, preloaded)
  const registry = buildMaterialRegistryFromSceneDocument(normalized)
  const materialLibrary = new SimpleMaterialLibrary(registry, preloaded)

  return { renderBundle, materialLibrary }
}
