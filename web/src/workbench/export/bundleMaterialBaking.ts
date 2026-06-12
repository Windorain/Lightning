/**
 * 材质烘焙模块：MTL 名称处理、材质混合模式、纹理 blob 提取与查询。
 *
 * 从 structureBundleExport.ts 拆分而来，见该文件 commit 历史。
 */

import type { BuildBlockMeshOptions } from '@/render/mesh/blockMesh'
import type { MaterialBlendMode, MaterialPaletteEntry, StructureDefinition } from '@/render/schema/types'

export const OBJ_NAME = 'structure.obj'
export const MTL_NAME = 'structure.mtl'

export const DEFAULT_ATLAS_MAX_SIDE = 4096

export type StructureBundleExportMode = 'block' | 'connected' | 'layered'

export interface StructureBundleExportOptions extends BuildBlockMeshOptions {
  /** World 文档时覆盖默认帧 */
  worldFrameIndex?: number
  /** `block`：每体素单 mesh + 单 atlas；`connected`：每连通域单 mesh + 单 atlas（先 component 邻面剔除再叠化打包）；`layered`：全结构一份 mesh，不叠化，按 quadOrder 输出多层透明 PNG */
  mode?: StructureBundleExportMode
  /** 纹理图集最大边长（像素）；`block` 与 `connected` 共用 */
  atlasMaxSide?: number
}

export function sanitizeNewmtlName(id: string): string {
  return `m_${id.replace(/[^a-zA-Z0-9]+/g, '_')}`
}

export function mtlDissolveAndIllum(blend: MaterialBlendMode | undefined): { d: number; illum: number } {
  if (blend === 'translucent') return { d: 0.92, illum: 4 }
  return { d: 1, illum: 1 }
}

export function extractTextureBlobs(normalizedDocument: unknown): string[] {
  if (
    normalizedDocument !== null &&
    typeof normalizedDocument === 'object' &&
    Array.isArray((normalizedDocument as { textureBlobs?: unknown }).textureBlobs)
  ) {
    return ((normalizedDocument as { textureBlobs: unknown[] }).textureBlobs as unknown[]).filter(
      (x) => typeof x === 'string',
    ) as string[]
  }
  return []
}

export function representativePaletteEntryForBlob(
  def: StructureDefinition,
  sortedMatIdx: number[],
  blobIndex: number,
): MaterialPaletteEntry | undefined {
  let fallback: MaterialPaletteEntry | undefined
  for (const mi of sortedMatIdx) {
    const e = def.materialPalette[mi]
    if (!e || typeof e.textureBlobIndex !== 'number' || Math.floor(e.textureBlobIndex) !== blobIndex)
      continue
    if (e.kind === 'animated') return e
    fallback = e
  }
  return fallback
}
