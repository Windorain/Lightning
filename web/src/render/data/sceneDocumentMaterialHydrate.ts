/**
 * 场景 document（StructureData | World）的材质 hydrate：由内嵌 Base64 池加载纹理、补全 palette `blend`。
 * 与 {@link buildMaterialRegistryFromSceneDocument} 共用 materialId 规则。
 */

import * as THREE from 'three'

import { inferMaterialBlendModeFromTexture } from '../materials/inferMaterialBlendModeFromTexture'
import type { MaterialPaletteEntry, StructureData } from '../schema/types'
import { isBakedStructureData, isWorldDocument } from './bundleResolve'
import { hasTextureBlobAt, textureBlobPoolOf } from '@/domain/textureBlobPool'

export interface PaletteTextureDataUrlItem {
  materialId: string
  dataUrl: string
}

function base64PngToDataUrl(b64: string): string {
  const t = b64.trim()
  if (t.startsWith('data:')) return t
  return `data:image/png;base64,${t}`
}

/**
 * 枚举纹理为 data URL。优先从根级 `textureBlobs` 读取，其次从 V2 `materials.entries[].texture_png`。
 *
 * ## 两种形态都在这里处理
 *
 * 此前第一件事是 `if (!Array.isArray(blobs)) return []` —— 于是**帧为主**文档的投影产物
 * （`composition/kernelProjection.ts:1406-1408` 产**槽位键对象**）在这里被静默丢弃：
 * 一张都枚举不出来、调用方拿到空材质库、且**不报错**。当时的等轴 PNG 导出
 * （`ExportIsoPngOperator` → `workbench/exportIsometricImage.ts:103 buildMaterialLibrary(plain)`）
 * 实测走这条链 —— **该导出链已退役**，但本函数仍是**图标材质库**的槽位枚举入口
 * （`render/data/materialLibraryFromTextures`；它只做槽位枚举，**不看**字节内容 ——
 * 解码已归 `composition/kernelTextureResources` 的唯一链）。
 *
 * ⇒ 形态解析收敛到 `domain/textureBlobPool.ts#normalizeTextureBlobPool`
 * （同一语义不得有第二处实现），本函数只按下标取字节。
 */
export function listPaletteTextureDataUrls(document: unknown): PaletteTextureDataUrlItem[] {
  if (!document || typeof document !== 'object') return []

  // 根级纹理池：**两种契约形态**统一归一为"位置保持数组"（`blobs[i]` = 槽位 i 的字节）。
  const blobs = textureBlobPoolOf(document)

  if (isWorldDocument(document)) {
    const pal = document.materialPalette
    if (!pal?.length) return []
    const items: PaletteTextureDataUrlItem[] = []
    for (let i = 0; i < pal.length; i++) {
      const entry = pal[i]
      const idx = entry.textureBlobIndex
      if (typeof idx !== 'number' || !Number.isFinite(idx)) continue
      if (!hasTextureBlobAt(blobs, idx)) continue
      items.push({ materialId: String(i), dataUrl: base64PngToDataUrl(blobs[Math.floor(idx)]!) })
    }
    return items
  }
  const d = document as StructureData
  if (!isBakedStructureData(d) || !Array.isArray(d.materialPalette)) return []
  const pal = d.materialPalette
  const items: PaletteTextureDataUrlItem[] = []
  for (let i = 0; i < pal.length; i++) {
    const entry = pal[i]
    const idx = entry.textureBlobIndex
    if (typeof idx !== 'number' || !Number.isFinite(idx)) continue
    if (!hasTextureBlobAt(blobs, idx)) continue
    items.push({ materialId: String(i), dataUrl: base64PngToDataUrl(blobs[Math.floor(idx)]!) })
  }
  return items
}

/** 载荷里根级材质调色板的位置（World 与 baked StructureData **同一条**取法）。 */
function paletteOf(document: unknown): readonly MaterialPaletteEntry[] | null {
  if (!document || typeof document !== 'object') return null
  if (isWorldDocument(document)) return document.materialPalette ?? null
  const sd = document as StructureData
  if (!isBakedStructureData(sd) || !Array.isArray(sd.materialPalette)) return null
  return sd.materialPalette
}

/**
 * 补全缺 `blend` 的槽位：**返回新的调色板数组**（无需补全 ⇒ `null`，保持输入同一性）。
 *
 * ## 为什么不是"原地写"（实测的失效形态）
 *
 * 旧实现直接 `entry.blend = …`。而内核侧的材质调色板条目是**冻结**的
 * （`composition/kernelPresentationInputs.ts` 的 `materialPaletteOf`，刻意加的
 * 防线：内核产物不得被下游改写）⇒ 真入口上抛
 * `TypeError: Cannot add property blend, object is not extensible`，材质库建不起来、
 * 视口挂不出来（`e2e/picture-takeover.spec.ts` 实测：`buildMaterialLibrary failed`
 * → `loadStructureAndResources: failed to build textureCache` → 60s 挂载超时）。
 *
 * ⇒ 冻结**保留**（它是防下游改内核产物），改为由本函数**产出新条目**：
 * 显式 `blend` 的槽位复用原对象（零拷贝），缺的槽位新建 `{...entry, blend: 推断值}`。
 * 推断仍只有**一处**实现（`inferMaterialBlendModeFromTexture`），本函数是它唯一的补全调用点。
 */
function hydratePalette(
  document: unknown,
  preloaded: Map<string, THREE.Texture>,
): readonly MaterialPaletteEntry[] | null {
  const pal = paletteOf(document)
  if (pal === null || pal.length === 0) return null
  let changed = false
  const next = pal.map((entry, i) => {
    if (entry.blend !== undefined) return entry
    changed = true
    const tex = preloaded.get(String(i))
    return { ...entry, blend: tex ? inferMaterialBlendModeFromTexture(tex) : ('opaque' as const) }
  })
  return changed ? Object.freeze(next) : null
}

/**
 * 补全 `blend === undefined` 的槽位（已显式设置的不覆盖），**返回补全后的文档**。
 *
 * 须在纹理已装入 `preloaded` 之后、{@link buildMaterialRegistryFromSceneDocument} 之前调用一次；
 * **调用方必须使用返回值**（它可能就是输入本身 —— 无槽位需要补全时按原样返回，
 * 以免制造无意义的浅拷）。输入**永不被改写**（内核产物是冻结的，见 {@link hydratePalette}）。
 */
export function hydrateMaterialBlendsInSceneDocument(
  document: unknown,
  preloaded: Map<string, THREE.Texture>,
): unknown {
  const hydrated = hydratePalette(document, preloaded)
  if (hydrated === null) return document
  return { ...(document as Record<string, unknown>), materialPalette: hydrated }
}
