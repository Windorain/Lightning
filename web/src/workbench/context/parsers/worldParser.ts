/**
 * WorldParser — World 文档（多帧）→ RuntimeDocument
 *
 * 将多帧 World 结构转为 RuntimeDocument，每个 frame 包含独立 grid。
 */
import { RuntimeDocument } from '@/workbench/context/runtimeDocument'
import type { DocumentParser } from '@/workbench/context/parserRegistry'

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
