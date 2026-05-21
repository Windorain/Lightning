/**
 * 文档校验工具。
 */

import { isBakedStructureData, isWorldDocument } from '@/render/data/bundleResolve'
import { embeddedStructure } from '@/render/data/worldPlayback'
import type { StructureData } from '@/render/schema/types'

/**
 * 文档是否可能通过打包校验（用于 UI 提示，非严格等价于 validate）。
 */
export function documentLooksPreviewable(document: unknown): boolean {
  if (!document || typeof document !== 'object') return false

  const v2 = document as { format_version?: unknown; frames?: unknown; materials?: { entries?: Array<{ texture_png?: unknown }> } }
  if (v2.format_version === '2.0' && Array.isArray(v2.frames)) {
    return true
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
