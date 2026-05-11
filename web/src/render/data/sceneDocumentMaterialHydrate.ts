/**
 * 场景 document（StructureData | World）的材质 hydrate：由内嵌 Base64 池加载纹理、补全 palette `blend`。
 * 与 {@link buildMaterialRegistryFromSceneDocument} 共用 materialId 规则。
 */

import * as THREE from 'three'

import { inferMaterialBlendModeFromTexture } from '../materials/inferMaterialBlendModeFromTexture'
import type { MaterialPaletteEntry, StructureData } from '../schema/types'
import { isBakedStructureData, isWorldDocument } from './bundleResolve'

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
 * 枚举 palette 纹理为 data URL（依赖根级 `textureBlobs` + 各槽 `textureBlobIndex`）。
 * 调用前应先 {@link validatePackedSceneDocument}。
 */
export function listPaletteTextureDataUrls(document: unknown): PaletteTextureDataUrlItem[] {
  if (!document || typeof document !== 'object') return []
  const root = document as { textureBlobs?: unknown }
  const blobs = root.textureBlobs
  if (!Array.isArray(blobs)) return []

  if (isWorldDocument(document)) {
    const pal = document.materialPalette
    if (!pal?.length) return []
    const items: PaletteTextureDataUrlItem[] = []
    for (let i = 0; i < pal.length; i++) {
      const entry = pal[i]
      const idx = entry.textureBlobIndex
      if (typeof idx !== 'number' || !Number.isFinite(idx)) continue
      const b = blobs[Math.floor(idx)]
      if (typeof b !== 'string') continue
      items.push({
        materialId: String(i),
        dataUrl: base64PngToDataUrl(b),
      })
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
    const b = blobs[Math.floor(idx)]
    if (typeof b !== 'string') continue
    items.push({
      materialId: String(i),
      dataUrl: base64PngToDataUrl(b),
    })
  }
  return items
}

function forEachPaletteSlot(
  document: unknown,
  fn: (entry: MaterialPaletteEntry, materialId: string) => void,
): void {
  if (!document || typeof document !== 'object') return
  if (isWorldDocument(document)) {
    const pal = document.materialPalette
    if (!pal?.length) return
    for (let i = 0; i < pal.length; i++) {
      fn(pal[i], String(i))
    }
    return
  }
  const d = document as StructureData
  if (!isBakedStructureData(d) || !Array.isArray(d.materialPalette)) return
  const pal = d.materialPalette
  for (let i = 0; i < pal.length; i++) {
    fn(pal[i], String(i))
  }
}

/**
 * 对 `blend === undefined` 的槽位写入推断值；已显式设置的 `blend` 不覆盖。
 * 须在纹理已装入 `preloaded` 之后、{@link buildMaterialRegistryFromSceneDocument} 之前调用一次。
 */
export function hydrateMaterialBlendsInSceneDocument(
  document: unknown,
  preloaded: Map<string, THREE.Texture>,
): void {
  forEachPaletteSlot(document, (entry, materialId) => {
    if (entry.blend !== undefined) return
    const tex = preloaded.get(materialId)
    if (!tex) {
      entry.blend = 'opaque'
      return
    }
    entry.blend = inferMaterialBlendModeFromTexture(tex)
  })
}
