/**
 * 纯函数：从**已归一化的 plain V2 文档**构建 SimpleMaterialLibrary。
 *
 * 不归一化、不校验 format，数据流单向。
 *
 * ⚠️ 入参今天有两个来源：旧格式 plain（暂存路径）与**内核材质面**
 * （`composition/kernelPresentationInputs#KernelRenderSourceFace.materialInput`）。
 * 后者的条目是**冻结**的 ⇒ 本函数**不得**改写入参（见下方 `hydrated` 的说明）。
 */
import * as THREE from 'three'
import {
  buildMaterialRegistryFromSceneDocument,
} from '@/render/data/bundleResolve'
import {
  hydrateMaterialBlendsInSceneDocument,
  listPaletteTextureDataUrls,
} from '@/render/data/sceneDocumentMaterialHydrate'
import { SimpleMaterialLibrary, type MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import { formatUnknownError } from '@/util/formatUnknownError'

function loadTextureDataUrl(loader: THREE.TextureLoader, dataUrl: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    loader.load(dataUrl, resolve, undefined, reject)
  })
}

export async function buildMaterialLibrary(plainDoc: unknown): Promise<MaterialLibraryApi> {
  const loader = new THREE.TextureLoader()
  const fetchList = listPaletteTextureDataUrls(plainDoc)
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
  // ⚠️ 必须用返回值：hydrate **不改写**输入（内核产物的材质条目是冻结的，
  // 原地写会抛 `Cannot add property blend, object is not extensible` —— P0 实测）。
  const hydrated = hydrateMaterialBlendsInSceneDocument(plainDoc, preloaded)
  const registry = buildMaterialRegistryFromSceneDocument(hydrated)
  return new SimpleMaterialLibrary(registry, preloaded)
}
