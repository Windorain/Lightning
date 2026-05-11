/**
 * 侧栏 / 拾取等使用的 palette 键：`meta === 0` 用 `registryId`，否则 `registryId@meta`。
 */

import type { BlockPaletteEntry, StructureDefinition } from '../schema/types'

/**
 * Palette 体素在合并后 `blocks` 表中的键：`meta === 0` 用 `registryId`，否则 `registryId@meta`。
 */
export function blockRegistryKeyForPalette(registryId: string, meta: number): string {
  return meta === 0 ? registryId : `${registryId}@${meta}`
}

export function findBlockPaletteEntryByBlockId(
  def: StructureDefinition,
  blockId: string,
): BlockPaletteEntry | undefined {
  for (const e of def.blockPalette) {
    if (blockRegistryKeyForPalette(e.registryId, e.meta) === blockId) return e
    if (e.registryId === blockId) return e
  }
  return undefined
}
