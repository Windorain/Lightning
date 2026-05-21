/**
 * 嵌入端公开契约：宿主传入已打包 document（含 textureBlobs）。
 *
 * EmbedRoot → parserRegistry → RuntimeDocument → createEmbedContext → bctx。
 */
import type { View3DFeatures } from '@/preview/previewConfig'
import type { BlockIconCacheOptions } from '@/render/interaction/blockIconCache'

export type { View3DFeatures }

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
  features?: Partial<View3DFeatures>
  ui?: EmbedUiOptions
}
