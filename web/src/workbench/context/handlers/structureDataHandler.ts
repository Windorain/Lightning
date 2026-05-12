import type { DocumentHandler } from '@/workbench/context/documentHandler'
import type { V2PlainSceneDocument, V2WorldFrame, V2BlockInstance, V2MaterialEntry, V2BlockState } from '@/render/data/sceneDocumentV2'
import type { StructureDataBaked, BlockPaletteEntry } from '@/render/schema/types'

export const StructureDataHandler: DocumentHandler = {
  priority: 30,
  formatName: 'StructureData',

  detect(doc: unknown): boolean {
    if (!doc || typeof doc !== 'object') return false
    const d = doc as Record<string, unknown>
    return d.geometryPhase === 'baked' && Array.isArray(d.blockPalette) && Array.isArray(d.cellGrid)
  },

  toEditable(doc: unknown): V2PlainSceneDocument | null {
    const baked = doc as StructureDataBaked
    if (!baked.cellGrid?.length) return null

    const blockPalette = baked.blockPalette ?? []
    const blockStateMap: Record<string, V2BlockState> = {}
    for (let i = 0; i < blockPalette.length; i++) {
      const e = blockPalette[i]
      const key = `${e.registryId}:${e.meta}`
      if (!blockStateMap[key]) {
        blockStateMap[key] = {
          name: e.registryId,
          properties: { meta: String(e.meta) },
        }
      }
    }

    const grid = baked.cellGrid
    const blocks: V2BlockInstance[] = []

    for (let z = 0; z < grid.length; z++) {
      const slice = grid[z]
      if (!slice) continue
      for (let row = 0; row < slice.length; row++) {
        const cols = slice[row]
        if (!cols) continue
        for (let col = 0; col < cols.length; col++) {
          const idx = cols[col]
          const entry = blockPalette[idx]
          if (!entry) continue
          if (entry.registryId === 'air' || entry.registryId === 'minecraft:air') continue

          const key = `${entry.registryId}:${entry.meta}`
          if (!blockStateMap[key]) {
            blockStateMap[key] = {
              name: entry.registryId,
              properties: { meta: String(entry.meta) },
            }
          }

          blocks.push({
            pos: { x: col, y: row, z: z },
            block_state_id: key,
            nbt: entry.nbt as Record<string, string> | undefined,
          })
        }
      }
    }

    const frame: V2WorldFrame = {
      label: baked.label ?? baked.id,
      index: 0,
      blocks,
      entities: [],
    }

    const materials: V2MaterialEntry[] = (baked.materialPalette ?? []).map((m, i) => ({
      key: String(i),
      texture_png: '',
      blend_mode: m.blend ?? 'opaque',
      is_animated: false,
      animation_ticks_per_frame: 1,
      animation_frame_count: 1,
    }))

    return {
      format_version: '2.0',
      meta: {
        name: baked.label ?? baked.id,
        author: baked.author ?? '',
        created_at_ms: 0,
        description: baked.description ?? '',
        tags: [],
        origin: { x: 0, y: 0, z: 0 },
      },
      frames: [frame],
      block_palette: blockStateMap,
      materials: { entries: materials },
      textureBlobs: baked.textureBlobs ?? [],
    } as V2PlainSceneDocument & { textureBlobs: string[] }
  },
}
