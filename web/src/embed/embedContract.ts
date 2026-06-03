/**
 * 嵌入端公开契约：宿主传入已打包 document（含 textureBlobs）。
 *
 * EmbedRoot → createEmbedHost → OPERATOR_LOAD_EMBED_DOCUMENT → ctx。
 */
import type { View3DFeatures } from '@/viewer/viewerConfig'
import type { BlockIconCacheOptions } from '@/render/interaction/blockIconCache'

export type { View3DFeatures }

export interface EmbedData {
  /** SDE 打包后的 StructureData 或 World（根级含 `textureBlobs`） */
  document: unknown
}

/**
 * 挂载 div 可选属性（Gadget / 模板）：
 * - data-wsr-mobile-fit：默认开启外壳等比缩放；`0` 关闭
 * - data-wsr-mobile-profile：`auto` | `desktop` | `compact`
 */
export interface EmbedUiOptions {
  blockIconCacheOptions?: Partial<BlockIconCacheOptions>
  initialLayerWorldY?: number
  /** World 多帧时指定起始帧，缺省为文档默认帧 */
  initialWorldFrameIndex?: number
  initialCamera?: import('@/viewer/viewerConfig').InitialCamera
  sceneBackground?: number
  loadingMessage?: string
  okMessage?: (modelId: string) => string
  /** false 时不显示底部调试状态栏 */
  debug?: boolean
  /** UI 主题，默认 'dark' */
  theme?: 'light' | 'dark'
}

export interface EmbedBootstrapOptions {
  data: EmbedData
  /** 未指定字段使用 defaultEmbedUi（previewConfig） */
  features?: Partial<View3DFeatures>
  ui?: EmbedUiOptions
}
