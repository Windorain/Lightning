import { describe, expect, it } from 'vitest'
import { RuntimeDocument } from '@/context/runtimeDocument'
import {
  EMBED_INITIAL_VIEW_META_KEY,
  setDocumentEmbedInitialView,
} from '@/context/embedInitialView'
import {
  buildWikiEditSummaryDraft,
  hasWikiAuditableChanges,
} from '@/wiki/wikiEditSummary'

const MIN_V2 = {
  format_version: '2.0',
  id: 't',
  meta: { name: 't', author: '', created_at_ms: 0, description: '', tags: [], origin: { x: 0, y: 0, z: 0 } },
  frames: [{
    index: 0,
    structure: {
      geometryPhase: 'baked' as const,
      cellGrid: [[[0]]],
      blockPalette: [{
        registryId: 'minecraft:stone',
        meta: 0,
        renderMode: 'BakedQuads',
        geometry: { encoding: 'bakedQuadsJsonV1', quads: [] },
        occludesAdjacentFaces: true,
      }],
    },
  }],
  annotations: [],
  labels: [],
}

describe('wikiEditSummary', () => {
  it('detects embed_initial_view as auditable change', () => {
    const baseline = RuntimeDocument.fromV2Plain(MIN_V2 as Record<string, unknown>)!
    const current = baseline.clone()
    setDocumentEmbedInitialView(current, {
      target: { x: 0, y: 1, z: 0 },
      yawDeg: 45,
      elevationDeg: 35,
      distance: 10,
      zoom: 1,
    })

    const draft = buildWikiEditSummaryDraft(baseline, current)
    expect(hasWikiAuditableChanges(draft)).toBe(true)
    expect(draft?.lines.some((l) => l.key === 'embed_initial_view')).toBe(true)
  })

  it('ignores unchanged embed_initial_view', () => {
    const view = {
      target: { x: 0, y: 1, z: 0 },
      yawDeg: 45,
      elevationDeg: 35,
      distance: 10,
      zoom: 1,
    }
    const v2 = {
      ...MIN_V2,
      meta: { ...MIN_V2.meta, [EMBED_INITIAL_VIEW_META_KEY]: view },
    }
    const baseline = RuntimeDocument.fromV2Plain(v2 as Record<string, unknown>)!
    const current = baseline.clone()

    const draft = buildWikiEditSummaryDraft(baseline, current)
    expect(hasWikiAuditableChanges(draft)).toBe(false)
  })
})
