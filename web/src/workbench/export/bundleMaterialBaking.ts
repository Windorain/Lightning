/**
 * 材质烘焙模块：MTL 名称处理、材质混合模式、纹理 blob 提取与查询。
 *
 * 从 structureBundleExport.ts 拆分而来，见该文件 commit 历史。
 */

import type { BuildBlockMeshOptions } from '@/render/mesh/blockMesh'
import type { MaterialBlendMode, MaterialPaletteEntry, StructureDefinition } from '@/render/schema/types'
import { textureBlobPoolOf } from '@/render/data/textureBlobPool'

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
 * ## 数组分支**必须保持位置**（#387 同族批，本批修）
 *
 * 此前的数组分支写的是 `.filter((x) => typeof x === 'string')`。`filter` 是**压紧**语义：
 * 下标 0 若是空洞（内核材质面 `textureBlobsOfContent` 对无内嵌字节的条留 `undefined`
 * 空洞，`composition/kernelPresentationInputs.ts:397-404`），其后的 `blobs[1]`、`blobs[2]`
 * 会整体前移到 `[0]`、`[1]` ⇒ 调用方 `blobs[textureBlobIndex]` 取到**旁边槽位的字节**
 * （静默错图，不报错）。实测：`['a', null, 'c']` 的 `blobs[2]` 由 `'c'` 变成 `undefined`。
 *
 * ⇒ 两分支都按**下标 = 槽位**产出，空洞处写 `''` 占位（保持 `string[]` 而非
 * `(string|undefined)[]`：6 处调用方（`bundleMeshAssembly.ts:72/127/146-147/160/214/514`）
 * 的取法全部是 `blobs[i]` 或真值判定，`''` 与 `undefined` 在它们那里同判"无字节"，
 * 故零改动即语义一致；改类型会牵动该文件 6 处签名，收益为零）。
 *
 * **任何形态下 `blobs[i]` 都等于槽位 `i` 的字节或"该槽位无字节"的占位** —— 这是本函数
 * 对调用方的**唯一**契约。
 *
 * ## 形态解析已收敛到渲染侧（#387 同族批；本函数只剩"记账"）
 *
 * 本函数此前**自己**解析形态（数组分支 `.filter` + 对象分支按键落位）——
 * 那是同一语义的**第二处实现**（第一处在渲染侧：`render/data/sceneDocumentMaterialHydrate.ts`
 * 与 `render/data/bundleResolve.ts`）。现统一由 `render/data/textureBlobPool.ts#normalizeTextureBlobPool`
 * 提供，本函数保留名字与返回值形状（3 处调用点不变），只委托。
 */
export function extractTextureBlobs(normalizedDocument: unknown): string[] {
  return textureBlobPoolOf(normalizedDocument) as string[]
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
