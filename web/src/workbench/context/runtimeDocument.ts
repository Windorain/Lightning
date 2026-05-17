/**
 * RuntimeDocument — 运行时场景文档。
 *
 * 独立于传输格式（V2Plain / StructureData / World），使用 Y-up 坐标系。
 * Pallete 已解析为 SlotBlock，不使用原始的 palette index。
 * 序列化/反序列化分别在 serializers / parsers 中实现。
 */
export const AIR_PALETTE_INDEX = 0

// ---------------------------------------------------------------------------
// 值类型
// ---------------------------------------------------------------------------

/** 网格坐标（Y-up：y = 世界 Y，0 = 底部，height-1 = 顶部） */
export interface GridPos {
  x: number
  y: number
  z: number
}

/** 运行时方块描述（palette 已解析） */
export interface SlotBlock {
  name: string   // "stone"（已截去 "minecraft:" 前缀）
  meta: number
  /** 反序列化时保留的原始 palette index；编辑新增的 block 无此字段 */
  paletteIndex?: number
}

/** Palette 条目元数据（序列化 round-trip 用） */
export interface PaletteEntryMeta {
  registryId: string
  renderMode?: string
  parts?: unknown[]
  geometry?: unknown
  facing?: string
  nbt?: Record<string, unknown>
  occludesAdjacentFaces?: boolean
  thumbnailPNG?: string
  tooltip?: string[]
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

export class Grid {
  private _cells: (SlotBlock | null)[][][] // [z][y][x], null = air
  private _width: number
  private _height: number
  private _depth: number

  /** 反序列化 round-trip 用：name:meta → 完整 palette 元数据 */
  private _paletteCache: Map<string, PaletteEntryMeta>

  get width(): number { return this._width }
  get height(): number { return this._height }
  get depth(): number { return this._depth }

  /** 内部构造 —— cells 会被浅引用（调用方负责构建正确的结构） */
  constructor(
    width: number,
    height: number,
    depth: number,
    cells?: (SlotBlock | null)[][][],
    paletteCache?: Map<string, PaletteEntryMeta>,
  ) {
    this._width = width
    this._height = height
    this._depth = depth
    this._cells = cells ?? Grid._emptyCells(width, height, depth)
    this._paletteCache = paletteCache ?? new Map()
  }

  private static _emptyCells(w: number, h: number, d: number): (null)[][][] {
    const cells: (null)[][][] = []
    for (let z = 0; z < d; z++) {
      const slice: (null)[][] = []
      for (let y = 0; y < h; y++) {
        slice.push(new Array(w).fill(null))
      }
      cells.push(slice)
    }
    return cells
  }

  // ---- 读 ----

  at(pos: GridPos): SlotBlock | null {
    if (!this._inBounds(pos)) return null
    return this._cells[pos.z]![pos.y]![pos.x] ?? null
  }

  has(pos: GridPos): boolean {
    return this.at(pos) !== null
  }

  forEach(fn: (pos: GridPos, block: SlotBlock) => void): void {
    for (let z = 0; z < this._depth; z++) {
      const slice = this._cells[z]
      if (!slice) continue
      for (let y = 0; y < this._height; y++) {
        const row = slice[y]
        if (!row) continue
        for (let x = 0; x < this._width; x++) {
          const block = row[x]
          if (block) fn({ x, y, z }, block)
        }
      }
    }
  }

  blocks(): Array<{ pos: GridPos; block: SlotBlock }> {
    const result: Array<{ pos: GridPos; block: SlotBlock }> = []
    this.forEach((pos, block) => result.push({ pos, block }))
    return result
  }

  count(): number {
    let n = 0
    for (let z = 0; z < this._depth; z++) {
      const slice = this._cells[z]
      if (!slice) continue
      for (let y = 0; y < this._height; y++) {
        const row = slice[y]
        if (!row) continue
        for (let x = 0; x < this._width; x++) {
          if (row[x]) n++
        }
      }
    }
    return n
  }

  bounds(): { min: GridPos; max: GridPos } | null {
    if (this.count() === 0) return null
    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (let z = 0; z < this._depth; z++) {
      const slice = this._cells[z]
      if (!slice) continue
      for (let y = 0; y < this._height; y++) {
        const row = slice[y]
        if (!row) continue
        for (let x = 0; x < this._width; x++) {
          if (row[x]) {
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
            if (z < minZ) minZ = z
            if (z > maxZ) maxZ = z
          }
        }
      }
    }
    return {
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
    }
  }

  // ---- 写 ----

  setBlock(pos: GridPos, block: SlotBlock): boolean {
    if (pos.x < 0 || pos.y < 0 || pos.z < 0) return false
    this._expandToFit(pos)
    this._cells[pos.z]![pos.y]![pos.x] = { ...block }

    // 确保 palette cache 有此条目（序列化用）
    const key = blockKey(block)
    if (!this._paletteCache.has(key)) {
      this._paletteCache.set(key, {
        registryId: 'minecraft:' + block.name,
        renderMode: 'BlockModel',
        parts: [],
      })
    }
    return true
  }

  removeBlock(pos: GridPos): boolean {
    if (!this._inBounds(pos)) return false
    this._cells[pos.z]![pos.y]![pos.x] = null
    this._trimTrailingEmpty()
    return true
  }

  moveBlock(from: GridPos, to: GridPos): boolean {
    if (to.x < 0 || to.y < 0 || to.z < 0) return false

    const block = this.at(from)
    if (!block) return false

    // 检查目标是否被占用（超出边界视作空）
    if (this._inBounds(to) && this._cells[to.z]![to.y]![to.x] !== null) return false

    this._expandToFit(to)
    this._cells[to.z]![to.y]![to.x] = block
    this._cells[from.z]![from.y]![from.x] = null
    this._trimTrailingEmpty()
    return true
  }

  /** 序列化时获取 palette 元数据 map */
  getPaletteCache(): Map<string, PaletteEntryMeta> {
    return this._paletteCache
  }

  // ---- 内部 ----

  private _inBounds(pos: GridPos): boolean {
    return (
      pos.x >= 0 && pos.x < this._width &&
      pos.y >= 0 && pos.y < this._height &&
      pos.z >= 0 && pos.z < this._depth
    )
  }

  private _expandToFit(pos: GridPos): void {
    const newW = Math.max(this._width, pos.x + 1)
    const newH = Math.max(this._height, pos.y + 1)
    const newD = Math.max(this._depth, pos.z + 1)

    // 扩展 Z
    while (this._cells.length < newD) {
      this._cells.push(Grid._emptySlice(this._width, this._height))
    }
    if (newH > this._height) {
      for (let z = 0; z < this._cells.length; z++) {
        const slice = this._cells[z]!
        while (slice.length < newH) {
          slice.push(new Array(this._width).fill(null))
        }
      }
    }
    if (newW > this._width) {
      for (let z = 0; z < this._cells.length; z++) {
        const slice = this._cells[z]!
        for (let y = 0; y < slice.length; y++) {
          while ((slice[y]!.length) < newW) {
            slice[y]!.push(null)
          }
        }
      }
    }

    this._width = newW
    this._height = newH
    this._depth = newD
  }

  /** 裁掉尾部全空的 z-slice / y-row / x-column */
  private _trimTrailingEmpty(): void {
    // Trim empty z-slices from the end
    while (this._cells.length > 0) {
      const slice = this._cells[this._cells.length - 1]!
      if (slice.some(row => row.some(c => c !== null))) break
      this._cells.pop()
    }
    if (this._cells.length === 0) {
      this._width = 0; this._height = 0; this._depth = 0
      return
    }

    // Trim empty y-rows from the top (highest y = last in slice)
    const slices = this._cells
    let maxNonEmptyY = -1
    for (const slice of slices) {
      for (let y = slice.length - 1; y >= 0; y--) {
        if (slice[y]!.some(c => c !== null)) {
          if (y > maxNonEmptyY) maxNonEmptyY = y
          break
        }
      }
    }
    const newRowLen = maxNonEmptyY + 1
    if (newRowLen < slices[0]!.length) {
      for (const slice of slices) slice.length = newRowLen
    }

    // Trim empty x-columns from the end (highest x)
    let maxNonEmptyX = -1
    for (const slice of slices) {
      for (const row of slice) {
        for (let x = row.length - 1; x >= 0; x--) {
          if (row[x] !== null) {
            if (x > maxNonEmptyX) maxNonEmptyX = x
            break
          }
        }
      }
    }
    const newColLen = maxNonEmptyX + 1
    if (newColLen < slices[0]![0]!.length) {
      for (const slice of slices) {
        for (const row of slice) row.length = newColLen
      }
    }

    this._depth = slices.length
    this._height = slices[0]?.length ?? 0
    this._width = slices[0]?.[0]?.length ?? 0
  }

  private static _emptySlice(w: number, h: number): (null)[][] {
    return Array.from({ length: h }, () => new Array(w).fill(null))
  }
}

function blockKey(b: SlotBlock): string {
  if (b.paletteIndex !== undefined) return '#' + String(b.paletteIndex)
  return b.name + ':' + b.meta
}

// ---------------------------------------------------------------------------
// RuntimeFrame
// ---------------------------------------------------------------------------

export class RuntimeFrame {
  readonly index: number
  readonly label: string | undefined
  readonly grid: Grid | null

  constructor(index: number, label?: string, grid?: Grid | null) {
    this.index = index
    this.label = label
    this.grid = grid ?? null
  }

  /** @deprecated 直接访问 grid/fields */
  toRaw(): Record<string, unknown> {
    return {
      index: this.index,
      label: this.label,
      structure: this.grid
        ? { geometryPhase: 'baked' as const }
        : undefined,
    }
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

  /** @deprecated 改用 serialize() */
  toRaw(): Record<string, unknown> {
    return this.serialize()
  }

  /** 序列化为 V2Plain JSON（兼容 render pipeline：展开首帧 structure 字段到顶层） */
  serialize(): Record<string, unknown> {
    const rawFrames = this.frames.map(f => {
      const frame: Record<string, unknown> = {
        index: f.index,
        label: f.label,
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
    if (this.materialPalette) out.materialPalette = [...this.materialPalette]
    if (this.playback) out.playback = { ...this.playback }
    return out
  }

  clone(): RuntimeDocument {
    return new RuntimeDocument({
      formatVersion: this.formatVersion,
      id: this.id,
      frames: this.frames.map(f => {
        if (!f.grid) return new RuntimeFrame(f.index, f.label)
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
        )
      }),
      meta: { ...this.meta },
      annotations: [...this.annotations],
      labels: [...this.labels],
      textureBlobs: this.textureBlobs ? { ...this.textureBlobs } : undefined,
      tooltipPalette: this.tooltipPalette ? [...this.tooltipPalette] : undefined,
      materialPalette: this.materialPalette ? [...this.materialPalette] : undefined,
      playback: this.playback ? { ...this.playback } : undefined,
      extra: { ...this._extra },
    })
  }

  /** @deprecated 改用 fromV2Plain() */
  static fromRaw(raw: Record<string, unknown>): RuntimeDocument | null {
    return RuntimeDocument.fromV2Plain(raw)
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
      const st = f.structure as Record<string, unknown> | undefined
      let grid: Grid | null = null
      if (st?.cellGrid && Array.isArray(st.cellGrid) && st.blockPalette && Array.isArray(st.blockPalette)) {
        grid = RuntimeDocument._fromV2CellGrid(
          st.cellGrid as number[][][],
          st.blockPalette as Record<string, unknown>[],
        )
      }
      frames.push(new RuntimeFrame(index, label, grid))
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
        // Y-up: y = height - 1 - row (cellGrid row 0 = 顶部)
        const y = height - 1 - row
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
