import type { DocumentHandler } from '@/workbench/context/documentHandler'
import type { V2PlainSceneDocument } from '@/render/data/sceneDocumentV2'

export const V2PlainHandler: DocumentHandler = {
  priority: 10,
  formatName: 'V2Plain',

  detect(doc: unknown): boolean {
    if (!doc || typeof doc !== 'object') return false
    const d = doc as Record<string, unknown>
    return d.format_version === '2.0' && Array.isArray(d.frames)
  },

  toEditable(doc: unknown): V2PlainSceneDocument | null {
    return doc as V2PlainSceneDocument
  },
}
