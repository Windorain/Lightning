// web/src/render/data/versionMigration.ts

import type { V2PlainSceneDocument, V2BlockInstance, V2EntityInstance } from './sceneDocumentV2'

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
    meta: migrateMeta(v1.meta as Record<string, unknown> | undefined),
    frames: migrateFrames(v1.frames as Array<Record<string, unknown>> | undefined),
    block_palette: (v1.blockPalette ?? v1.block_palette ?? {}) as Record<string, any>,
    materials: (v1.materials ?? { entries: [] }) as any,
    annotations: [],
    labels: [],
    stats_template: { mode: 'auto' },
  }
}

function migrateMeta(raw: Record<string, unknown> | undefined): V2PlainSceneDocument['meta'] {
  return {
    name: (raw?.name as string) ?? '',
    author: (raw?.author as string) ?? '',
    created_at_ms: (raw?.createdAtMs ?? raw?.created_at_ms ?? 0) as number,
    description: (raw?.description as string) ?? '',
    tags: (raw?.tags as string[]) ?? [],
    origin: {
      x: (raw?.origin as any)?.x ?? 0,
      y: (raw?.origin as any)?.y ?? 0,
      z: (raw?.origin as any)?.z ?? 0,
    },
  }
}

function migrateFrames(raw: Array<Record<string, unknown>> | undefined): V2PlainSceneDocument['frames'] {
  if (!raw) return []
  return raw.map((f, i) => ({
    label: (f.label as string) ?? `Frame ${i}`,
    index: (f.index as number) ?? i,
    blocks: ((f.blocks as any[]) ?? []).map(migrateBlock),
    entities: ((f.entities as any[]) ?? []).map(migrateEntity),
  }))
}

function migrateBlock(b: Record<string, unknown>): V2BlockInstance {
  return {
    pos: {
      x: (b.pos as any)?.x ?? 0,
      y: (b.pos as any)?.y ?? 0,
      z: (b.pos as any)?.z ?? 0,
    },
    block_state_id: (b.blockStateId ?? b.block_state_id ?? '') as string,
    nbt: (b.nbt as Record<string, string>) ?? undefined,
    parts: undefined,
    gui_state: undefined,
  }
}

function migrateEntity(e: Record<string, unknown>): V2EntityInstance {
  return {
    pos: {
      x: (e.pos as any)?.x ?? 0,
      y: (e.pos as any)?.y ?? 0,
      z: (e.pos as any)?.z ?? 0,
    },
    entity_id: (e.entityId ?? e.entity_id ?? '') as string,
    nbt: (e.nbt as Record<string, string>) ?? undefined,
  }
}
