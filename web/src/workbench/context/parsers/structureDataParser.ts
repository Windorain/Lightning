/**
 * StructureDataParser — StructureDataBaked → RuntimeDocument
 *
 * 将单帧 baked 结构数据转为 RuntimeDocument。
 * 保留原始 palette 元数据用于 round-trip。
 */
import { RuntimeDocument } from '@/workbench/context/runtimeDocument'
import type { DocumentParser } from '@/workbench/context/parserRegistry'

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

    // Structure-level fields only (cellGrid/blockPalette inside frames[0].structure)
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

    // Document-level fields must be at V2 root so fromV2Plain captures them
    for (const key of ['materialPalette', 'textureBlobs', 'tooltipPalette', 'playback'] as const) {
      if (baked[key] !== undefined) v2[key] = baked[key]
    }

    return RuntimeDocument.fromV2Plain(v2)
  },
}
