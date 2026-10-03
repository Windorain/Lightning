/**
 * builtinParsers — 内置文档格式解析器集。
 */

import { RuntimeDocument } from '@/context/runtimeDocument'
import { isEnvelopeDocument, normalizeEnvelopeToPlain } from '@/render/data/compactSceneDocument'
import type { DocumentParser, ParserRegistryImpl } from '@/context/parserRegistry'
import { MultiblockParser } from '@/context/parsers/multiblockParser'

export { MultiblockParser }

/**
 * 「文档形态判别型」parser —— **必须先于**按 `format_version` / `frames` 泛匹配的 parser 判别。
 *
 * 契约 §2.2 的判别优先级：多方块为主的文档为了复用 `frames` 语义，天然带
 * `format_version:"2.0" + frames`（V2Plain 的判别条件）、且 `id` 来自信封 meta（World 的判别条件），
 * 因此必须先被多方块判别器接走。既有四类 parser 的 `detect` 一行未改；
 * 由 `createParserRegistry()` 预置在表头，host 仍按历史顺序追加既有四类（见 `parserRegistry.ts`）。
 */
export const SHAPE_FIRST_PARSERS: DocumentParser[] = [MultiblockParser]

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
    // 契约 §2：baked 结构自带的部件字段随 structure 透传（旧文件无此键 ⇒ 行为不变）
    for (const key of ['cellPartsGrid', 'partLists'] as const) {
      if (baked[key] !== undefined) structureFields[key] = baked[key]
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

    // 文档**根级**字段（与上面的 structure 级 cellPartsGrid/partLists 不同层级）：
    // `materialPalette/textureBlobs/...` 沿用既有透传；`statsTemplate`/`statsOverride`
    // （契约 §9 三级配置第 1/2 级）与 `partIconTextures`（契约 §2 部件物品图标纹理，P1.7 落盘）
    // 亦挂在真实导出文档根上，必须一并透传到 v2 根 —— 否则运行时定义根缺文档默认统计层
    // （徽标落"内建默认"）且部件行图标无嵌入纹理源。
    // 旧文件无这些键 ⇒ 循环体不执行，行为零差异（字节干净同 serialize()）。
    for (const key of [
      'materialPalette', 'textureBlobs', 'tooltipPalette', 'cellTooltipGrid', 'playback',
      'statsTemplate', 'statsOverride', 'partIconTextures',
    ] as const) {
      if (baked[key] !== undefined) v2[key] = baked[key]
    }

    return RuntimeDocument.fromV2Plain(v2)
  },
}
