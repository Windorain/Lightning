/**
 * 文档校验工具。
 */

import { isBakedStructureData, isWorldDocument } from '@/render/data/bundleResolve'
import { embeddedStructure } from '@/render/data/worldPlayback'
import { normalizeTextureBlobPool } from '@/domain/textureBlobPool'
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

  // ── 纹理池必须按**两种契约形态**读（修复前只认数组）───────────────
  // `textureBlobs` 的形态由**生产者**决定：数组 = 内核材质面 / 多方块；槽位键对象
  // `{"0":"<b64>",…}` = 帧为主文档的 `plainForSave().plain`（`composition/kernelProjection.ts:1406-1408`）。
  // 原先的 `!Array.isArray(blobs) || blobs.length === 0` 把对象形态判成"不可渲染" ⇒
  // **有贴图的真产物在查看器里被判不可预览**（同一失明在 3 处相遇点各发生一次）。
  // 归一化是**位置保持**的（下标即槽位），且对非池值产出空表 ⇒ 空池 / 缺席 / 非法
  // 一律 false —— 与原先同口径，只多认了合法的对象形态。
  //
  // 退出条件：形态解析只在 `domain/textureBlobPool.ts` 一处（统一实现）⇒ 本判据随
  // 两形态分叉消失（生产者统一形态）而自然归零。owner：内核重建执行线。
  const blobs = (document as { textureBlobs?: unknown }).textureBlobs
  if (normalizeTextureBlobPool(blobs).length === 0) return false
  if (isWorldDocument(document)) {
    return document.frames.some((fr) => {
      const st = embeddedStructure(fr)
      return isBakedStructureData(st)
    })
  }
  return isBakedStructureData(document as StructureData)
}
