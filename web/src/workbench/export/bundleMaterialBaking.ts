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

/**
 * 从**归一化 plain**（= `Context#plainForSave().plain`，导出算子的输入）取纹理字节表。
 *
 * ## 为什么必须同时吃两种形态（端到端实测抓出的缺陷，见 #387）
 *
 * `composition/kernelProjection.ts:1321-1330` 把 `textureBlobs` 的**两种形态**登记为**契约**形态：
 *
 * | 文档形态 | `textureBlobs` | 依据 |
 * |---|---|---|
 * | 帧为主（本函数此前的唯一分支） | 数组 `["<base64>", …]` | `serialize()` 既有形态 |
 * | 多方块 | 数组（`''` 占位） | `docs/contracts/format-multiblock-doc.md:108` |
 *
 * 但内核投影对**帧为主**文档产出的是**槽位键对象**（`{"0": "<base64>", …}`，键 =
 * `materialPalette` 下标 = `textureBlobIndex`）。此前只认数组 ⇒ 帧为主文档走生产导出
 * （`ExportObjOperator` → `buildStructureBundleZip`）时 `blobs = []` ⇒ 单件簇的 quad
 * **全部拿不到 blob tile**，真信封实测 **1234/1234 单件簇 quad 无贴图**（贴图只剩共面簇的
 * 合成 tile，`atlasCount` 45 / 173 个非空体素）——**静默失效**，既有判据一条都没覆盖。
 *
 * 对象形态按键（槽位）还原为**稀疏数组**，使 `blobs[textureBlobIndex]` 的取值口径与数组形态一致。
 */
export function extractTextureBlobs(normalizedDocument: unknown): string[] {
  if (normalizedDocument === null || typeof normalizedDocument !== 'object') return []
  const raw = (normalizedDocument as { textureBlobs?: unknown }).textureBlobs
  if (Array.isArray(raw)) {
    return (raw as unknown[]).filter((x) => typeof x === 'string') as string[]
  }
  if (raw !== null && typeof raw === 'object') {
    const out: string[] = []
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v !== 'string') continue
      const idx = Number(k)
      if (!Number.isInteger(idx) || idx < 0) continue
      out[idx] = v
    }
    return out
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
