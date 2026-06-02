/**
 * iconCacheManager — BlockIconCache 生命周期管理。
 *
 * 抽取自 renderAssets.ts 中反复出现的 BlockIconCache 创建+revision key 拼接模式。
 * 供 loadStructureAndResources / setCurrentWorldFrame 共用。
 */
import { type ShallowRef } from 'vue'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import type { StructureDefinition } from '@/render/schema/types'
import {
  BlockIconCache,
  BLOCK_ICON_LAYOUT_REVISION,
  blockIconBakeLayoutKey,
} from '@/render/interaction/blockIconCache'
import {
  MC_ITEM_SLOT_BAKE_REVISION,
  summarizeBlocksForCache,
} from '@/render/interaction/blockSlotBaker'

export interface IconCacheManagerDeps {
  blockIconCache: ShallowRef<BlockIconCache | null>
  blockIconCacheOptions: { sizePx?: number; orthoHalf?: number }
}

export interface IconCacheManager {
  rebuild(lib: MaterialLibraryApi, definition: StructureDefinition): void
  dispose(): void
}

export function createIconCacheManager(deps: IconCacheManagerDeps): IconCacheManager {
  const { blockIconCache, blockIconCacheOptions } = deps

  function rebuild(lib: MaterialLibraryApi, definition: StructureDefinition): void {
    if (blockIconCache.value) blockIconCache.value.dispose()
    const iconCache = new BlockIconCache(lib, blockIconCacheOptions, definition)
    iconCache.setRevisionKey(
      `${definition.id}:${summarizeBlocksForCache(definition)}:${MC_ITEM_SLOT_BAKE_REVISION}:${BLOCK_ICON_LAYOUT_REVISION}:${blockIconBakeLayoutKey(blockIconCacheOptions)}`,
    )
    blockIconCache.value = iconCache
  }

  function dispose(): void {
    blockIconCache.value?.dispose()
    blockIconCache.value = null
  }

  return { rebuild, dispose }
}
