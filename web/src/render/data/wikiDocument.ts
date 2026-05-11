import type { World, BlockPaletteEntry, StructureData } from '@/render/schema/types'

function stripNbtFromPaletteEntry(entry: BlockPaletteEntry): BlockPaletteEntry {
  const { nbt, ...rest } = entry
  return rest as BlockPaletteEntry
}

/** Strip NBT and sdeCellNotes from WorldDocument to produce WikiDocument.
 *  Keeps thumbnailPNG — Wiki block stats sidebar needs it.
 *  Keeps tooltipPalette — Wiki tooltip display needs it.
 */
export function worldToWikiDocument(document: World): World {
  return {
    ...document,
    blockPalette: document.blockPalette?.map(stripNbtFromPaletteEntry),
    frames: document.frames.map(f => {
      if (!f.structure) return f
      const obj = f.structure as unknown as Record<string, unknown>
      const { sdeCellNotes, cellTooltipGrid, cellTypes, worldGrid, ...rest } = obj
      return { ...f, structure: rest as unknown as StructureData }
    }),
  }
}
