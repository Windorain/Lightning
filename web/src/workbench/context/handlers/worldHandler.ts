import type { DocumentHandler } from '@/workbench/context/documentHandler'
import type { V2PlainSceneDocument } from '@/render/data/sceneDocumentV2'
import type { World } from '@/render/schema/types'

/** World (multi-frame) -> V2PlainSceneDocument */
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

    return {
      format_version: '2.0',
      ...world,
      meta: {
        name: world.label ?? world.id,
        author: world.author ?? '',
        created_at_ms: 0,
        description: world.description ?? '',
        tags: [],
        origin: { x: 0, y: 0, z: 0 },
      },
      annotations: [],
      labels: [],
    } as V2PlainSceneDocument
  },
}
