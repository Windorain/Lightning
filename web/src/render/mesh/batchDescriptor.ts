/**
 * Simple 网格合并批次：一次算清描述符，材质库按同一键缓存，避免字符串解析往返。
 * - `useVertexColor !== true`：MC Tessellator 整型色映射到材质 `color`，同贴图不同 tint 分批次。
 * - `useVertexColor === true`：与 MC `GL_COLOR_ARRAY` 对齐，染色在 `geometry.attributes.color`（逐顶点插值），`tint` 固定白。
 */

import * as THREE from 'three'

import type { MaterialBlendMode } from '../schema/types'

const BATCH_SEP = '|' as const

export interface BatchDescriptor {
  materialId: string
  blend: MaterialBlendMode
  tint: THREE.Color
  /** 体素 BakedQuads：用顶点色乘贴图，`tint` 应为白 */
  useVertexColor?: boolean
}

/** 与 SimpleMaterialLibrary 中 materialByBatchKey 一致 */
export function batchMaterialCacheKey(d: BatchDescriptor): string {
  const vc = d.useVertexColor === true ? '1' : '0'
  return [d.materialId, d.blend, vc, d.tint.getHex()].join(BATCH_SEP)
}
