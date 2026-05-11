import type { V2PlainSceneDocument } from '@/render/data/sceneDocumentV2'

/** Build a stripped embed envelope — frames + palette + materials only, no editing metadata */
export function buildEmbedEnvelope(doc: V2PlainSceneDocument): V2PlainSceneDocument {
  return {
    format_version: doc.format_version,
    meta: {
      ...doc.meta,
      description: doc.meta.description.replace(/[#*`\[\]()]/g, ''),
    },
    frames: doc.frames.map(f => ({
      ...f,
      blocks: f.blocks.map(b => ({
        pos: b.pos,
        block_state_id: b.block_state_id,
        nbt: b.nbt,
      })),
      entities: f.entities,
    })),
    block_palette: doc.block_palette,
    materials: doc.materials,
    // Omit: annotations, labels, stats_template, parts, gui_state
  }
}

/** Full workbench envelope — all v2 data preserved */
export function buildWorkbenchEnvelope(doc: V2PlainSceneDocument): V2PlainSceneDocument {
  return doc
}
