/**
 * materialPalette（数组槽位）→ MaterialRegistryData（materialId 字符串 → MaterialEntry）。
 * 单结构：materialId 为 "0".."n-1"；World 多帧由 scene 层使用 "帧:槽" 键。
 */

import type { MaterialEntry, MaterialPaletteEntry, MaterialRegistryData } from '../schema/types'

/** 单格 palette 条目映射为材质注册表中的逻辑条目（无下标） */
export function registryEntryFromPaletteSlot(e: MaterialPaletteEntry): MaterialEntry {
  return {
    locator: e.locator ?? 'minecraft:missingno',
    kind: e.kind,
    blend: e.blend,
    emissive: e.emissive,
    animation: e.animation,
  }
}

/** 单结构 materialPalette 数组 → 以槽下标为键的 registry */
export function indexedRegistryFromMaterialPalette(palette: MaterialPaletteEntry[]): MaterialRegistryData {
  const materials: Record<string, MaterialEntry> = {}
  for (let i = 0; i < palette.length; i++) {
    materials[String(i)] = registryEntryFromPaletteSlot(palette[i])
  }
  return { materials }
}
