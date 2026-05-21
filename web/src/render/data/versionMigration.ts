// web/src/render/data/versionMigration.ts

import type { V2PlainSceneDocument } from './sceneDocumentV2'

/** Detect whether a raw JSON doc is v1 or v2 */
export function detectVersion(doc: Record<string, unknown>): '1' | '2' {
  const v = doc.format_version as string | undefined
  if (v && v.startsWith('2.')) return '2'
  return '1'
}

/** Up-migrate v1 document to v2 internal model */
export function migrateV1ToV2(v1: Record<string, unknown>): V2PlainSceneDocument {
  return {
    format_version: '2.0',
    ...v1,
    meta: {
      name: (v1.label ?? v1.id ?? '') as string,
      author: (v1.author ?? '') as string,
      created_at_ms: 0,
      description: (v1.description ?? '') as string,
      tags: [],
      origin: { x: 0, y: 0, z: 0 },
    },
    annotations: (v1.annotations as V2PlainSceneDocument['annotations']) ?? [],
    labels: (v1.labels as V2PlainSceneDocument['labels']) ?? [],
  } as unknown as V2PlainSceneDocument
}
