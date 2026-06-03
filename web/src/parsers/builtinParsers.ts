/**
 * builtinParsers — 内置文档格式解析器集。
 *
 * 将所有内置 DocumentParser 汇集一处，
 * EmbedRoot.vue / WorkbenchRoot.vue 只需单个 import。
 */

import { RuntimeDocument } from '@/context/runtimeDocument'
import { isEnvelopeDocument, normalizeEnvelopeToPlain } from '@/render/data/compactSceneDocument'
import { parserRegistry } from '@/context/parserRegistry'
import type { DocumentParser, ParserRegistryImpl } from '@/context/parserRegistry'

// ==================== V2PlainParser ====================

/**
 * V2PlainParser — V2PlainSceneDocument → RuntimeDocument
 *
 * 由于 RuntimeDocument 本身已经持有 fromV2Plain 工厂方法，
 * 此 parser 只是 detect + 委托。
 */
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

// ==================== EnvelopeParser ====================

/**
 * EnvelopeParser — Envelope 文档 → RuntimeDocument
 *
 * 解压 gzip+base64 payload 后委托 V2PlainParser / WorldParser。
 */
export const EnvelopeParser: DocumentParser = {
  formatName: 'Envelope',
  detect(raw: unknown): boolean {
    return isEnvelopeDocument(raw)
  },
  async parse(raw: unknown): Promise<RuntimeDocument | null> {
    const plain = await normalizeEnvelopeToPlain(raw)
    if (plain === raw) return null // 解压失败
    // 委托下游 parser 继续解析
    const result = await parserRegistry.detectAndParse(plain)
    return result.document
  },
}

/**
 * createEnvelopeParser — 创建绑定到指定 registry 的 EnvelopeParser。
 *
 * 与 EnvelopeParser 的区别在于它捕获传入的 registry 实例，
 * 解压后委托给该 registry 而非全局 singleton。
 * 供 shell 使用 createParserRegistry() 创建本地 registry 时使用。
 */
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

// ==================== WorldParser ====================

/**
 * WorldParser — World 文档（多帧）→ RuntimeDocument
 *
 * 将多帧 World 结构转为 RuntimeDocument，每个 frame 包含独立 grid。
 */
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

    // 构造 V2Plain 兼容格式，委托 fromV2Plain
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

// ==================== StructureDataParser ====================

/**
 * StructureDataParser — StructureDataBaked → RuntimeDocument
 *
 * 将单帧 baked 结构数据转为 RuntimeDocument。
 * 保留原始 palette 元数据用于 round-trip。
 */
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
    for (const key of ['materialPalette', 'textureBlobs', 'tooltipPalette', 'cellTooltipGrid', 'playback'] as const) {
      if (baked[key] !== undefined) v2[key] = baked[key]
    }

    return RuntimeDocument.fromV2Plain(v2)
  },
}
