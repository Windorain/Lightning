/**
 * blockPalette.geometry.encoding → 规范化四边形列表（保持顺序）。
 */

import type { BakedGeometryEncoding, BakedQuad, BakedQuadsGeometry } from '../schema/types'

export function decodeBakedGeometry(geometry: BakedQuadsGeometry): BakedQuad[] {
  const enc = geometry.encoding
  if (enc === 'bakedQuadsJsonV1') {
    return geometry.quads ?? []
  }
  if (enc === 'packedQuadsV1') {
    throw new Error('packedQuadsV1 尚未实现解码')
  }
  throw new Error(`未知 geometry.encoding: ${String(enc)}`)
}

export function isSupportedEncoding(enc: BakedGeometryEncoding): boolean {
  return enc === 'bakedQuadsJsonV1'
}
