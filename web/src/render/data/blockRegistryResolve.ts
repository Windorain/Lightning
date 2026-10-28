/**
 * 旧层出口：palette / block_registry 键（`meta === 0` ⇒ 裸 `registryId`，否则 `registryId@meta`）。
 *
 * 实现已迁到 `presentation/blockRegistryKey`（新层公共出口，**深度 2**）——
 * 旧层这里**委托**，不保留第二份实现。为什么必须迁：装配根
 * `composition/kernelPickAdapter` 原来 import 本文件（深度 3）触发
 * `gate/no-private-cross-layer`（公共出口最大深度 2）。
 */

import type { BlockPaletteEntry, StructureDefinition } from '../schema/types'
import { blockRegistryKey } from '@/presentation/blockRegistryKey'

export { blockRegistryKey as blockRegistryKeyForPalette }

export function findBlockPaletteEntryByBlockId(
  def: StructureDefinition,
  blockId: string,
): BlockPaletteEntry | undefined {
  for (const e of def.blockPalette) {
    if (blockRegistryKey(e.registryId, e.meta) === blockId) return e
    if (e.registryId === blockId) return e
  }
  return undefined
}
