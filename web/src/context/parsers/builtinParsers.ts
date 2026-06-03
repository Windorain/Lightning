/**
 * builtinParsers — 内置文档格式解析器集。
 */

import { RuntimeDocument } from '@/context/runtimeDocument'
import { isEnvelopeDocument, normalizeEnvelopeToPlain } from '@/render/data/compactSceneDocument'
import type { DocumentParser, ParserRegistryImpl } from '@/context/parserRegistry'

export const V2PlainParser: DocumentParser = {
  formatName: 'V2Plain',
  detect(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') return false
    const d = raw as Record<string, unknown>
    return d.format_version === '2.0' && Array.isArray(d.frames)
  },
  async parse(raw: unknown) {
    return RuntimeDocument.fromV2Plain(raw as Record<string, unknown>)
  },
}

export function createEnvelopeParser(registry: ParserRegistryImpl): DocumentParser {
  return {
    formatName: 'Envelope',
    detect(raw: unknown): boolean {
      return isEnvelopeDocument(raw)
    },
    async parse(raw: unknown): Promise<RuntimeDocument | null> {
      const plain = await normalizeEnvelopeToPlain(raw)
      if (plain === raw) return null
      const result = await registry.detectAndParse(plain)
      return result.document
    },
  }
}

export const WorldParser: DocumentParser = {
  formatName: 'World',
  detect(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') return false
    const d = raw as Record<string, unknown>
    return Array.isArray(d.frames) && typeof d.id === 'string' && !d.format_version
  },
  async parse(raw: unknown) {
    const world = raw as Record<string, unknown>
    const frames = world.frames as unknown[] | undefined
    if (!frames?.length) return null

    const v2: Record<string, unknown> = {
      format_version: '2.0',
      id: (world.id as string) ?? '',
      meta: {
        name: (world.label as string) ?? (world.id as string) ?? '',
        author: (world.author as string) ?? '',
        created_at_ms: 0,
        description: (world.description as string) ?? '',
        tags: [],
        origin: { x: 0, y: 0, z: 0 },
      },
      frames: frames.map((f: unknown, i: number) => {
        const frame = f as Record<string, unknown>
        return {
          index: (frame.index as number) ?? i,
          label: frame.label as string | undefined,
          structure: frame.structure ?? undefined,
        }
      }),
      annotations: (world.annotations as unknown[]) ?? [],
      labels: (world.labels as unknown[]) ?? [],
      textureBlobs: world.textureBlobs,
      tooltipPalette: world.tooltipPalette,
      materialPalette: world.materialPalette,
      blockPalette: world.blockPalette,
      playback: world.playback,
    }

    return RuntimeDocument.fromV2Plain(v2)
  },
}

export const StructureDataParser: DocumentParser = {
  formatName: 'StructureData',
  detect(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') return false
    const d = raw as Record<string, unknown>
    return d.geometryPhase === 'baked' && Array.isArray(d.blockPalette) && Array.isArray(d.cellGrid)
  },
  async parse(raw: unknown) {
    const baked = raw as Record<string, unknown>
    const cellGrid = baked.cellGrid as number[][][] | undefined
    if (!cellGrid?.length) return null

    const structureFields: Record<string, unknown> = {
      geometryPhase: 'baked',
      cellGrid: baked.cellGrid,
      blockPalette: baked.blockPalette,
    }

    const v2: Record<string, unknown> = {
      format_version: '2.0',
      id: (baked.id as string) ?? '',
      meta: {
        name: (baked.label as string) ?? (baked.id as string) ?? '',
        author: (baked.author as string) ?? '',
        created_at_ms: 0,
        description: (baked.description as string) ?? '',
        tags: [],
        origin: { x: 0, y: 0, z: 0 },
      },
      frames: [{
        index: 0,
        label: baked.label,
        structure: structureFields,
      }],
      annotations: [],
      labels: [],
    }

    for (const key of ['materialPalette', 'textureBlobs', 'tooltipPalette', 'cellTooltipGrid', 'playback'] as const) {
      if (baked[key] !== undefined) v2[key] = baked[key]
    }

    return RuntimeDocument.fromV2Plain(v2)
  },
}
