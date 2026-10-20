/**
 * `render/data/materialLibraryFromTextures` —— **已解码纹理 → 图标材质库**（M8-5）。
 *
 * ## 本模块替代的旧机制（#171 退役纪律：同批删除，不留旁路）
 *
 * | 旧机制 | 位置 | 为什么必须退 |
 * |---|---|---|
 * | `buildMaterialLibrary(plainDoc)` 用 `THREE.TextureLoader` **自己解码**全部纹理（`Promise.all` + 逐项 `throw`） | `render/data/buildMaterialLibrary.ts`（**已删除**） | ①它是**第二条解码链**：同一份字节被 `composition/kernelTextureResources`（五态链）与它各解一次；②它的失败模式是**整库 reject** ⇒ 一张坏图让图标库整个建不起来（S0-B D2 的装载面形态） |
 *
 * 新形态：**解码只有一处**（`composition/kernelTextureResources#textureResourcesOf` +
 * `adapters/textureDecode`），本模块只做"已解码像素 → `SimpleMaterialLibrary`"的装配。
 * 于是：
 *
 *  - **不碰字节、不碰 DOM/IO**：入参是像素，函数是纯装配（`textureFor` 由调用方给）；
 *  - **坏一张只坏一张**：缺失的材质槽不进 `preloaded` ⇒ 只有**那个材质**的批次
 *    在烘焙时落 `error`（图标占位），其余图标照常 —— 不再有"整库 reject"；
 *  - **不再有第二份"哪些材质有贴图"的判定**：槽位枚举复用
 *    `sceneDocumentMaterialHydrate#listPaletteTextureDataUrls`（与旧链同一枚举），
 *    纹理本体由调用方按材质 id 提供。
 *
 * ## 为什么仍保留 `listPaletteTextureDataUrls`（而不是按资源表下标现推）
 *
 * 枚举回答的是"**这份文档声明了哪些材质槽带内嵌字节**"（含 `textureBlobIndex`
 * 的跳跃/稀疏情形），那是文档事实；而"这张纹理解出来没有"是资源事实。
 * 两者混为一谈会让"槽位存在但解码失败"与"槽位不存在"不可区分 —— 而这两种情形
 * 的用户后果不同（前者可在重试后恢复，后者根本不该有图）。
 */

import * as THREE from 'three'
import { buildMaterialRegistryFromSceneDocument } from '@/render/data/bundleResolve'
import {
  hydrateMaterialBlendsInSceneDocument,
  listPaletteTextureDataUrls,
} from '@/render/data/sceneDocumentMaterialHydrate'
import { SimpleMaterialLibrary, type MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import type { TextureAlphaClass } from '@/domain/textureAlphaClass'

/**
 * 材质 id → 已解码纹理（`null` = 该槽**当前**没有可用像素：未就绪/失败/未请求）。
 *
 * ⚠️ 实现**不得**在这里解码（那正是被退役的第二条解码链）。它只允许做一次查表。
 */
export type MaterialTextureResolver = (materialId: string) => THREE.Texture | null

/**
 * 材质 id → 贴图 **alpha 类别**（`undefined` = 未知：该槽没有可分类的像素）。
 *
 * 与 {@link MaterialTextureResolver} 同样**只允许查表** —— 分类是解码处的产出
 * （`domain/textureAlphaClass#textureAlphaClassOf` 在 `composition/kernelTextureResources`
 * 里被调用一次），本层不得再看像素。
 */
export type MaterialAlphaClassResolver = (materialId: string) => TextureAlphaClass | undefined

/**
 * 由**已解码**的调色板纹理装配材质库。
 *
 * @param plainDoc 材质输入（内核渲染源面的 `materialInput`，或旧格式 plain；
 *   两者都只需 `materialPalette` + `textureBlobs` 两处，见 `listPaletteTextureDataUrls`）
 * @param textureFor 按材质 id 取**已解码**纹理（缺失 ⇒ `null`，**不**抛错）
 * @param alphaClassFor 按材质 id 取**贴图 alpha 类别**（缺席 = 未知 ⇒ 维持修复前状态）。
 *   **只做一次查表**：类别的生产点在解码处（`composition/kernelTextureResources#decodeOne`
 *   的 `textureAlphaClassOf`），本模块不得重新扫像素（那会是第二份分类实现）。
 *
 * @returns 材质库。**不会**因为某一张纹理缺失而失败 —— 缺失只让该材质拿不到 `map`。
 */
export function buildMaterialLibraryFromTextures(
  plainDoc: unknown,
  textureFor: MaterialTextureResolver,
  alphaClassFor?: MaterialAlphaClassResolver,
): MaterialLibraryApi {
  const preloaded = new Map<string, THREE.Texture>()
  const alphaClasses = new Map<string, TextureAlphaClass>()
  for (const { materialId } of listPaletteTextureDataUrls(plainDoc)) {
    const texture = textureFor(materialId)
    // 缺失 = 该槽这次没有像素。**不**造占位纹理：占位由呈现侧（无 map 的中性色）
    // 表达，材质库这里伪造一张会让"缺了"与"有图"不可区分（SPEC §7.4:254）。
    if (texture === null) continue
    preloaded.set(materialId, texture)
    // 类别**只在有纹理的槽上**记录：没有像素就没有类别（缺席就是缺席）。
    const alphaClass = alphaClassFor?.(materialId)
    if (alphaClass !== undefined) alphaClasses.set(materialId, alphaClass)
  }
  // ⚠️ 必须用返回值：hydrate **不改写**输入（内核产物的材质条目是冻结的，
  // 原地写会抛 `Cannot add property blend, object is not extensible` —— P0 实测）。
  // 缺像素的槽由 hydrate 按"无纹理"退回 `opaque`（与旧链同一推断函数，一处实现）。
  const hydrated = hydrateMaterialBlendsInSceneDocument(plainDoc, preloaded)
  const registry = buildMaterialRegistryFromSceneDocument(hydrated)
  return new SimpleMaterialLibrary(registry, preloaded, alphaClasses)
}
