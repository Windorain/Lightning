/**
 * RuntimeDocument — 运行时场景文档。
 *
 * 独立于传输格式（V2Plain / StructureData / World），使用 Y-up 坐标系。
 * Pallete 已解析为 SlotBlock，不使用原始的 palette index。
 * 序列化/反序列化分别在 serializers / parsers 中实现。
 */
import { structureRowToWorldY } from '@/pure/vec'
import { blockKey } from '@/pure/string'
import { Grid, type GridPos, type SlotBlock, type PaletteEntryMeta } from './grid'

export { Grid, GridPos, SlotBlock, PaletteEntryMeta }

export const AIR_PALETTE_INDEX = 0

// ---------------------------------------------------------------------------
// RuntimeFrame
// ---------------------------------------------------------------------------

export class RuntimeFrame {
  readonly index: number
  readonly label: string | undefined
  readonly grid: Grid | null
  readonly durationMs: number | undefined

  constructor(index: number, label?: string, grid?: Grid | null, durationMs?: number) {
    this.index = index
    this.label = label
    this.grid = grid ?? null
    this.durationMs = durationMs
  }


}

// ---------------------------------------------------------------------------
// RuntimeDocument
// ---------------------------------------------------------------------------

export class RuntimeDocument {
  readonly formatVersion: string
  readonly id: string
  readonly frames: RuntimeFrame[]
  readonly meta: Record<string, unknown>
  readonly annotations: unknown[]
  readonly labels: unknown[]
  readonly textureBlobs: Record<string, unknown> | undefined
  readonly tooltipPalette: unknown[] | undefined
  readonly cellTooltipGrid: number[][][] | undefined
  readonly materialPalette: unknown[] | undefined
  readonly playback: Record<string, unknown> | undefined

  /** 不认识的顶层 key 兜底（round-trip 无损） */
  private _extra: Record<string, unknown>

  constructor(opts: {
    formatVersion?: string
    id?: string
    frames?: RuntimeFrame[]
    meta?: Record<string, unknown>
    annotations?: unknown[]
    labels?: unknown[]
    textureBlobs?: Record<string, unknown> | null
    tooltipPalette?: unknown[] | null
    cellTooltipGrid?: number[][][] | null
    materialPalette?: unknown[] | null
    playback?: Record<string, unknown> | null
    extra?: Record<string, unknown>
  }) {
    this.formatVersion = opts.formatVersion ?? '2.0'
    this.id = opts.id ?? ''
    this.frames = opts.frames ?? []
    this.meta = { ...(opts.meta ?? {}) }
    this.annotations = [...(opts.annotations ?? [])]
    this.labels = [...(opts.labels ?? [])]
    this.textureBlobs = opts.textureBlobs ?? undefined
    this.tooltipPalette = opts.tooltipPalette ?? undefined
    this.cellTooltipGrid = opts.cellTooltipGrid
      ? opts.cellTooltipGrid.map(s => s ? s.map(r => r ? [...r] : []) : [])
      : undefined
    this.materialPalette = opts.materialPalette ?? undefined
    this.playback = opts.playback ?? undefined
    this._extra = { ...(opts.extra ?? {}) }
  }

  get frameCount(): number {
    return this.frames.length
  }

  frame(i: number): RuntimeFrame | null {
    return this.frames[i] ?? null
  }

  forEachFrame(fn: (frame: RuntimeFrame) => void): void {
    for (const f of this.frames) fn(f)
  }

  forEachBlock(fn: (frameIndex: number, pos: GridPos, block: SlotBlock) => void): void {
    for (const f of this.frames) {
      if (f.grid) {
        f.grid.forEach((pos, block) => fn(f.index, pos, block))
      }
    }
  }

  /** 序列化为 V2Plain JSON（兼容 render pipeline：展开首帧 structure 字段到顶层） */
  serialize(): Record<string, unknown> {
    const rawFrames = this.frames.map(f => {
      const frame: Record<string, unknown> = {
        index: f.index,
        label: f.label,
        durationMs: f.durationMs,
      }
      if (f.grid) {
        const { cellGrid, blockPalette } = this._gridToV2(f.grid)
        frame.structure = {
          geometryPhase: 'baked' as const,
          cellGrid,
          blockPalette,
        }
      }
      return frame
    })

    const out: Record<string, unknown> = {
      ...this._extra,
      format_version: this.formatVersion,
      id: this.id,
      meta: { ...this.meta },
      frames: rawFrames,
      annotations: [...this.annotations],
      labels: [...this.labels],
    }
    // 展开首帧 structure 到顶层，兼容 render pipeline（loadStructureData 直接读顶层字段）
    if (rawFrames.length > 0) {
      const st = rawFrames[0]!.structure as Record<string, unknown> | undefined
      if (st) {
        for (const key of Object.keys(st)) {
          if (!(key in out)) {
            out[key] = st[key]
          }
        }
      }
    }
    if (this.textureBlobs) out.textureBlobs = this.textureBlobs
    if (this.tooltipPalette) out.tooltipPalette = [...this.tooltipPalette]
    if (this.cellTooltipGrid) out.cellTooltipGrid = this.cellTooltipGrid.map(s => s ? s.map(r => r ? [...r] : []) : [])
    if (this.materialPalette) out.materialPalette = [...this.materialPalette]
    if (this.playback) out.playback = { ...this.playback }
    return out
  }

  clone(): RuntimeDocument {
    return new RuntimeDocument({
      formatVersion: this.formatVersion,
      id: this.id,
      frames: this.frames.map(f => {
        if (!f.grid) return new RuntimeFrame(f.index, f.label, null, f.durationMs)
        // Deep clone grid
        const cells: (SlotBlock | null)[][][] = []
        for (let z = 0; z < f.grid.depth; z++) {
          const slice: (SlotBlock | null)[][] = []
          for (let y = 0; y < f.grid.height; y++) {
            const row: (SlotBlock | null)[] = []
            for (let x = 0; x < f.grid.width; x++) {
              const b = f.grid.at({ x, y, z })
              row.push(b ? { ...b } : null)
            }
            slice.push(row)
          }
          cells.push(slice)
        }
        const paletteCache = new Map(f.grid.getPaletteCache())
        return new RuntimeFrame(
          f.index,
          f.label,
          new Grid(f.grid.width, f.grid.height, f.grid.depth, cells, paletteCache),
          f.durationMs,
        )
      }),
      meta: { ...this.meta },
      annotations: [...this.annotations],
      labels: [...this.labels],
      textureBlobs: this.textureBlobs ? (Array.isArray(this.textureBlobs) ? [...this.textureBlobs] as unknown as Record<string, unknown> : { ...this.textureBlobs }) : undefined,
      tooltipPalette: this.tooltipPalette ? [...this.tooltipPalette] : undefined,
      cellTooltipGrid: this.cellTooltipGrid ? this.cellTooltipGrid.map(s => s ? s.map(r => r ? [...r] : []) : []) : undefined,
      materialPalette: this.materialPalette ? [...this.materialPalette] : undefined,
      playback: this.playback ? { ...this.playback } : undefined,
      extra: { ...this._extra },
    })
  }


  /** 从 V2Plain JSON 创建（反序列化入口） */
  static fromV2Plain(raw: Record<string, unknown>): RuntimeDocument | null {
    const framesRaw = raw.frames
    if (!Array.isArray(framesRaw)) return null

    const known = new Set([
      'format_version', 'id', 'frames', 'meta',
      'annotations', 'labels',
      'schemaVersion', 'label', 'gtnhVersion', 'author',
      'description', 'modSource', 'globalConfig',
      'cellTooltipGrid', 'tooltipPalette', 'materialPalette',
    ])
    const extra: Record<string, unknown> = {}
    for (const key of Object.keys(raw)) {
      if (!known.has(key)) extra[key] = (raw as Record<string, unknown>)[key]
    }

    const meta = raw.meta as Record<string, unknown> | undefined
    const annotations = (raw.annotations as unknown[]) ?? []
    const labels = (raw.labels as unknown[]) ?? []

    const frames: RuntimeFrame[] = []
    for (let i = 0; i < framesRaw.length; i++) {
      const f = framesRaw[i] as Record<string, unknown> | undefined
      if (!f || typeof f !== 'object') continue
      const index = (f.index as number) ?? i
      const label = f.label as string | undefined
      const durationMs = f.durationMs as number | undefined
      const st = f.structure as Record<string, unknown> | undefined
      let grid: Grid | null = null
      if (st?.cellGrid && Array.isArray(st.cellGrid) && st.blockPalette && Array.isArray(st.blockPalette)) {
        grid = RuntimeDocument._fromV2CellGrid(
          st.cellGrid as number[][][],
          st.blockPalette as Record<string, unknown>[],
        )
      }
      frames.push(new RuntimeFrame(index, label, grid, durationMs))
    }

    return new RuntimeDocument({
      formatVersion: (raw.format_version as string) ?? '2.0',
      id: (raw.id as string) ?? '',
      frames,
      meta: meta ? { ...meta } : { name: '', author: '', created_at_ms: Date.now(), description: '', tags: [], origin: { x: 0, y: 0, z: 0 } },
      annotations: [...annotations],
      labels: [...labels],
      textureBlobs: raw.textureBlobs as Record<string, unknown> | undefined,
      tooltipPalette: raw.tooltipPalette as unknown[] | undefined,
      cellTooltipGrid: raw.cellTooltipGrid as number[][][] | undefined,
      materialPalette: raw.materialPalette as unknown[] | undefined,
      playback: raw.playback as Record<string, unknown> | undefined,
      extra,
    })
  }

  /** 创建空文档 */
  static empty(): RuntimeDocument {
    return new RuntimeDocument({
      id: '',
      meta: {
        name: '未命名', author: '', created_at_ms: Date.now(),
        description: '', tags: [], origin: { x: 0, y: 0, z: 0 },
      },
    })
  }

  // ---- 内部序列化辅助 ----

  private _gridToV2(grid: Grid): { cellGrid: number[][][]; blockPalette: Record<string, unknown>[] } {
    const paletteCache = grid.getPaletteCache()
    // name:meta → palette index (AIR_PALETTE_INDEX = 0 = air)
    const indexMap = new Map<string, number>()
    // Index 0 is always reserved for air
    const blockPalette: Record<string, unknown>[] = [{ registryId: 'air', meta: AIR_PALETTE_INDEX }]
    const cellGrid: number[][][] = []

    for (let z = 0; z < grid.depth; z++) {
      const slice: number[][] = []
      for (let y = 0; y < grid.height; y++) {
        // cellGrid row = height - 1 - y (Y-up → cellGrid row, 0=top)
        const row: number[] = []
        for (let x = 0; x < grid.width; x++) {
          const block = grid.at({ x, y, z })
          if (block) {
            const key = blockKey(block)
            let idx = indexMap.get(key)
            if (idx === undefined) {
              idx = blockPalette.length // AIR_PALETTE_INDEX already occupies index 0
              indexMap.set(key, idx)
              const meta = paletteCache.get(key)
              blockPalette.push(meta
                ? { ...meta }
                : {
                    registryId: 'minecraft:' + block.name,
                    meta: block.meta,
                    renderMode: 'BlockModel',
                    parts: [],
                  })
            }
            row.push(idx)
          } else {
            row.push(AIR_PALETTE_INDEX)
          }
        }
        // cellGrid 的 row 顺序：row 0 = 顶部 = height-1-y
        slice.unshift(row)
      }
      cellGrid.push(slice)
    }

    return { cellGrid, blockPalette }
  }

  /** @internal */
  static _fromV2CellGrid(
    cellGrid: number[][][],
    rawPalette: Record<string, unknown>[],
  ): Grid {
    // 构建 palette cache（key = palette index，保留原始映射避免同名不同态被覆盖）
    const paletteCache = new Map<string, PaletteEntryMeta>()
    for (let i = 0; i < rawPalette.length; i++) {
      const entry = rawPalette[i]!
      const rid = entry.registryId as string
      const colon = rid.indexOf(':')
      const name = colon >= 0 ? rid.slice(colon + 1) : rid
      if (name !== 'air' && name !== 'Air') {
        paletteCache.set('#' + String(i), entry as unknown as PaletteEntryMeta)
      }
    }

    // 解析 air index (0)
    const depth = cellGrid.length
    const height = cellGrid[0]?.length ?? 0
    const width = cellGrid[0]?.[0]?.length ?? 0

    const cells: (SlotBlock | null)[][][] = []
    for (let z = 0; z < depth; z++) {
      const rawSlice = cellGrid[z]!
      const slice: (SlotBlock | null)[][] = []
      for (let row = 0; row < height; row++) {
        // Y-up: y = structureRowToWorldY(row, height) (cellGrid row 0 = 顶部)
        const y = structureRowToWorldY(row, height)
        const rawRow = rawSlice[row]!
        const outRow: (SlotBlock | null)[] = new Array(width).fill(null)
        for (let x = 0; x < width; x++) {
          const palIdx = rawRow[x]!
          if (palIdx > AIR_PALETTE_INDEX && palIdx < rawPalette.length) {
            const entry = rawPalette[palIdx]!
            const rid = entry.registryId as string
            const colon = rid.indexOf(':')
            const name = colon >= 0 ? rid.slice(colon + 1) : rid
            if (name !== 'air' && name !== 'Air') {
              outRow[x] = { name, meta: (entry.meta as number) ?? 0, paletteIndex: palIdx }
            }
          }
        }
        slice[y] = outRow
      }
      cells.push(slice)
    }

    return new Grid(width, height, depth, cells, paletteCache)
  }
}
