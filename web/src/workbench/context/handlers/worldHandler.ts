import type { DocumentHandler } from '@/workbench/context/documentHandler'
import type { V2PlainSceneDocument, V2WorldFrame, V2BlockInstance, V2MaterialEntry, V2BlockState } from '@/render/data/sceneDocumentV2'
import type { World, Frame, StructureDataBaked, BlockPaletteEntry } from '@/render/schema/types'

export const WorldHandler: DocumentHandler = {
  priority: 20,
  formatName: 'World',

  detect(doc: unknown): boolean {
    if (!doc || typeof doc !== 'object') return false
    const d = doc as Record<string, unknown>
    return Array.isArray(d.frames) && typeof d.id === 'string'
  },

  toEditable(doc: unknown): V2PlainSceneDocument | null {
    const world = doc as World
    if (!world.frames?.length) return null

    const blockPalette = world.blockPalette ?? []
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

    const frames: V2WorldFrame[] = []
    for (const frame of world.frames) {
      const v2Frame = convertFrame(frame, blockPalette, blockStateMap)
      if (v2Frame) frames.push(v2Frame)
    }

    const materials: V2MaterialEntry[] = (world.materialPalette ?? []).map((m, i) => ({
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
        name: world.label ?? world.id,
        author: world.author ?? '',
        created_at_ms: 0,
        description: world.description ?? '',
        tags: [],
        origin: { x: 0, y: 0, z: 0 },
      },
      frames,
      block_palette: blockStateMap,
      materials: { entries: materials },
      textureBlobs: world.textureBlobs ?? [],
    } as V2PlainSceneDocument & { textureBlobs: string[] }
  },
}

function convertFrame(
  frame: Frame,
  blockPalette: ReadonlyArray<BlockPaletteEntry>,
  blockStateMap: Record<string, V2BlockState>,
): V2WorldFrame | null {
  const structure = frame.structure as StructureDataBaked | undefined
  if (!structure?.cellGrid?.length) return null

  const grid = structure.cellGrid
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

  return {
    label: frame.label ?? '',
    index: frame.index ?? 0,
    blocks,
    entities: [],
  }
}
