/**
 * 由可编辑场景 document 构建 `PreviewConfig`（经 `loadPreviewSessionFromDocument` 生成
 * `renderBundle` 与 `materialLibrary`）。工作台/合入后刷新预览应调用本函数并传入**当前**内存快照。
 */

import type { PreviewConfig, PreviewFeatures } from '@/preview/previewConfig'
import { defaultEmbedUi } from '@/preview/previewConfig'
import { resolveBootstrapToPreviewConfig } from '@/embed/embedContract'
import { isBakedStructureData, isWorldDocument } from '@/render/data/bundleResolve'
import { embeddedStructure } from '@/render/data/worldPlayback'
import type { StructureData } from '@/render/schema/types'

/**
 * 文档是否可能通过打包校验（用于 UI 提示，非严格等价于 validate）。
 * Envelope 信封须先经 {@link normalizeEnvelopeToPlain} 再调用；工作台预览链已按此处理。
 */
export function documentLooksPreviewable(document: unknown): boolean {
  if (!document || typeof document !== 'object') return false

  const v2 = document as { format_version?: unknown; frames?: unknown; materials?: { entries?: Array<{ texture_png?: unknown }> } }
  if (v2.format_version === '2.0' && Array.isArray(v2.frames) && v2.materials?.entries) {
    return v2.materials.entries.some(e => typeof e.texture_png === 'string' && e.texture_png.length > 0)
  }

  const blobs = (document as { textureBlobs?: unknown }).textureBlobs
  if (!Array.isArray(blobs) || blobs.length === 0) return false
  if (isWorldDocument(document)) {
    return document.frames.some((fr) => {
      const st = embeddedStructure(fr)
      return isBakedStructureData(st)
    })
  }
  return isBakedStructureData(document as StructureData)
}

export interface PreviewFromDocumentOptions {
  /** 覆盖默认嵌入 UI（工作台 dev 面板等） */
  features?: Partial<PreviewFeatures>
  /** false 时隐藏底部调试状态栏 */
  debug?: boolean
}

export async function previewConfigFromDocument(
  document: unknown,
  options: PreviewFromDocumentOptions = {},
): Promise<PreviewConfig> {
  return await resolveBootstrapToPreviewConfig({
    data: { document },
    features: options.features,
    ui: {
      loadingMessage: defaultEmbedUi.loadingMessage,
      okMessage: defaultEmbedUi.okMessage,
      ...(options.debug !== undefined ? { debug: options.debug } : {}),
    },
  })
}
