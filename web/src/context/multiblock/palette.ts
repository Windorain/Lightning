/**
 * 调色板：并集（根级唯一一份）→ 装配下标 → SlotBlock（契约 §6）。
 *
 * 规则：`blockPalette[0]` 恒为 air（index 0 = 空）；`air` 之外按下标映射为 SlotBlock，
 * `registryId` 截去命名空间前缀（与既有 `RuntimeDocument._fromV2CellGrid` 同口径）。
 */
import type { PaletteEntryMeta, SlotBlock } from '@/pure/gridTypes'
import type { MultiblockInnerDocument, MultiblockPaletteEntry } from './types'

/** air 恒为下标 0（既有约定）。 */
export const AIR_PALETTE_INDEX = 0

export interface MultiblockPalette {
  /** 原始条目（下标即调色板下标） */
  entries: MultiblockPaletteEntry[]
  /** 下标 → SlotBlock（air = null） */
  slots: Array<SlotBlock | null>
  /** `#<下标>` → 完整条目元数据（非 air），供既有序列化 round-trip 复用 */
  cache: Map<string, PaletteEntryMeta>
}

/** 从内层 body 构建调色板映射。 */
export function buildPalette(doc: MultiblockInnerDocument): MultiblockPalette {
  const entries: MultiblockPaletteEntry[] = Array.isArray(doc.blockPalette) ? doc.blockPalette : []
  const slots: Array<SlotBlock | null> = new Array(entries.length).fill(null)
  const cache = new Map<string, PaletteEntryMeta>()
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    const rid = typeof entry.registryId === 'string' ? entry.registryId : ''
    const colon = rid.indexOf(':')
    const name = colon >= 0 ? rid.slice(colon + 1) : rid
    const meta = typeof entry.meta === 'number' ? entry.meta : 0
    if (i === AIR_PALETTE_INDEX || name === '' || name === 'air' || name === 'Air') continue
    slots[i] = { name, meta, paletteIndex: i }
    cache.set('#' + String(i), entry as unknown as PaletteEntryMeta)
  }
  return { entries, slots, cache }
}

/** 下标 → SlotBlock（越界或 air → null）。 */
export function slotAt(palette: MultiblockPalette, index: number): SlotBlock | null {
  if (!Number.isInteger(index) || index < 0 || index >= palette.slots.length) return null
  return palette.slots[index] ?? null
}
