import type { DocumentHandler } from '@/workbench/context/documentHandler'
import type { V2PlainSceneDocument } from '@/render/data/sceneDocumentV2'
import type { StructureDataBaked } from '@/render/schema/types'

/** StructureData (single-frame baked) -> V2PlainSceneDocument */
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

    return {
      format_version: '2.0',
      ...baked,
      meta: {
        name: baked.label ?? baked.id,
        author: baked.author ?? '',
        created_at_ms: 0,
        description: baked.description ?? '',
        tags: [],
        origin: { x: 0, y: 0, z: 0 },
      },
      frames: [{ index: 0, label: baked.label, structure: baked }],
      annotations: [],
      labels: [],
    } as V2PlainSceneDocument
  },
}
