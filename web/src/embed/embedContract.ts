/**
 * 嵌入端公开契约：宿主传入已打包 document（含 textureBlobs），无 HTTP 加载阶段。
 */

import type { PreviewConfig, PreviewFeatures } from '@/preview/previewConfig'
import { defaultEmbedUi } from '@/preview/previewConfig'
import { loadPreviewSessionFromDocument } from '@/preview/previewSession'
import { sceneStableStringIdFromDocument } from '@/render/data/compactSceneDocument'
import type { BlockIconCacheOptions } from '@/render/interaction/blockIconCache'

export type { PreviewFeatures }

export interface EmbedData {
  /** SDE 打包后的 StructureData 或 World（根级含 `textureBlobs`） */
  document: unknown
}

export interface EmbedUiOptions {
  blockIconCacheOptions?: Partial<BlockIconCacheOptions>
  initialLayerWorldY?: number
  /** World 多帧时指定起始帧，缺省为文档默认帧 */
  initialWorldFrameIndex?: number
  initialCamera?: import('@/preview/previewConfig').InitialCamera
  sceneBackground?: number
  loadingMessage?: string
  okMessage?: (modelId: string) => string
  /** false 时不显示底部调试状态栏 */
  debug?: boolean
}

export interface EmbedBootstrapOptions {
  data: EmbedData
  /** 未指定字段使用 defaultEmbedUi（previewConfig） */
  features?: Partial<PreviewFeatures>
  ui?: EmbedUiOptions
}

export async function resolveBootstrapToPreviewConfig(
  options: EmbedBootstrapOptions,
): Promise<PreviewConfig> {
  const ui = options.ui ?? {}

  const { document } = options.data
  const { renderBundle, materialLibrary } = await loadPreviewSessionFromDocument(document)
  const features: PreviewFeatures = {
    ...defaultEmbedUi.features,
    ...options.features,
  }
  const sceneId = sceneStableStringIdFromDocument(renderBundle.document)

  const out: PreviewConfig = {
    sceneId,
    renderBundle,
    materialLibrary,
    features,
    blockIconCacheOptions: {
      ...defaultEmbedUi.blockIconCacheOptions,
      ...ui.blockIconCacheOptions,
    },
    initialLayerWorldY: ui.initialLayerWorldY ?? defaultEmbedUi.initialLayerWorldY,
    initialWorldFrameIndex: ui.initialWorldFrameIndex,
    initialCamera: ui.initialCamera,
    sceneBackground: ui.sceneBackground ?? defaultEmbedUi.sceneBackground,
    loadingMessage: ui.loadingMessage ?? defaultEmbedUi.loadingMessage,
    okMessage: ui.okMessage ?? defaultEmbedUi.okMessage,
    debug: ui.debug ?? defaultEmbedUi.debug,
  }
  return out
}
