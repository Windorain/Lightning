import type { V2PlainSceneDocument } from '@/render/data/sceneDocumentV2'

/** Build a stripped embed envelope — V1 data + meta only, no editing metadata */
export function buildEmbedEnvelope(doc: V2PlainSceneDocument): V2PlainSceneDocument {
  return {
    format_version: doc.format_version,
    id: doc.id,
    meta: {
      ...doc.meta,
      description: doc.meta.description.replace(/[#*`\[\]()]/g, ''),
    },
    frames: doc.frames,
    annotations: doc.annotations,
    labels: doc.labels,
  }
}

/** Full workbench envelope — all data preserved */
export function buildWorkbenchEnvelope(doc: V2PlainSceneDocument): V2PlainSceneDocument {
  return doc
}
