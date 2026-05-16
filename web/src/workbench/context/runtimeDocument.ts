/**
 * RuntimeDocument — 运行时场景文档。
 *
 * 封装 V2PlainSceneDocument，提供类型安全的 Frame/Grid 访问。
 * 所有编辑通过此 API 完成，导出/预览通过 toRaw() 获取原始格式。
 */
import type { Frame, StructureDataBaked, BlockPaletteEntry } from '@/render/schema/types'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
export const AIR_PALETTE_INDEX = 0

// ---------------------------------------------------------------------------
// 值类型
// ---------------------------------------------------------------------------

/** 网格坐标（cellGrid 下标） */
export interface GridPos {
  col: number
  row: number
  z: number
}

/** 运行时方块描述（palette 已解析） */
export interface SlotBlock {
  name: string   // "stone"（已截去 "minecraft:" 前缀）
  meta: number
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

export class Grid {
  readonly width: number
  readonly height: number
  readonly depth: number

  private readonly _cellGrid: number[][][]
  private readonly _palette: BlockPaletteEntry[]
  private readonly _nameCache: Map<number, string | null>

  constructor(cellGrid: number[][][], palette: BlockPaletteEntry[]) {
    this._cellGrid = cellGrid
    this._palette = palette
    this._nameCache = new Map()
    this.depth = cellGrid.length
    this.height = cellGrid[0]?.length ?? 0
    this.width = cellGrid[0]?.[0]?.length ?? 0
  }

  // ---- 映射 ----

  private _resolveName(index: number): string | null {
    const cached = this._nameCache.get(index)
    if (cached !== undefined) return cached
    const entry = this._palette[index]
    let name: string | null = null
    if (entry) {
      const colon = entry.registryId.indexOf(':')
      name = colon >= 0 ? entry.registryId.slice(colon + 1) : entry.registryId
      if (name === 'air' || name === 'Air') name = null
    }
    this._nameCache.set(index, name)
    return name
  }

  private _resolveBlock(index: number): SlotBlock | null {
    const name = this._resolveName(index)
    if (!name) return null
    return { name, meta: this._palette[index]!.meta }
  }

  // ---- 读 ----

  at(pos: GridPos): SlotBlock | null {
    const row = this._rowAt(pos)
    if (!row) return null
    return this._resolveBlock(row[pos.col])
  }

  has(pos: GridPos): boolean {
    return this.at(pos) !== null
  }

  forEach(fn: (pos: GridPos, block: SlotBlock) => void): void {
    for (let z = 0; z < this.depth; z++) {
      const slice = this._cellGrid[z]
      if (!slice) continue
      for (let rowIdx = 0; rowIdx < slice.length; rowIdx++) {
        const r = slice[rowIdx]
        if (!r) continue
        for (let col = 0; col < r.length; col++) {
          const block = this._resolveBlock(r[col])
          if (block) fn({ col, row: rowIdx, z }, block)
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
    for (let z = 0; z < this.depth; z++) {
      const slice = this._cellGrid[z]
      if (!slice) continue
      for (let r = 0; r < slice.length; r++) {
        const row = slice[r]
        if (!row) continue
        for (let col = 0; col < row.length; col++) {
          if (row[col] !== AIR_PALETTE_INDEX) n++
        }
      }
    }
    return n
  }

  bounds(): { min: GridPos; max: GridPos } | null {
    if (this.count() === 0) return null
    let minCol = Infinity, minRow = Infinity, minZ = Infinity
    let maxCol = -Infinity, maxRow = -Infinity, maxZ = -Infinity
    for (let z = 0; z < this.depth; z++) {
      const slice = this._cellGrid[z]
      if (!slice) continue
      for (let r = 0; r < slice.length; r++) {
        const row = slice[r]
        if (!row) continue
        for (let col = 0; col < row.length; col++) {
          if (row[col] !== AIR_PALETTE_INDEX) {
            if (col < minCol) minCol = col
            if (col > maxCol) maxCol = col
            if (r < minRow) minRow = r
            if (r > maxRow) maxRow = r
            if (z < minZ) minZ = z
            if (z > maxZ) maxZ = z
          }
        }
      }
    }
    return {
      min: { col: minCol, row: minRow, z: minZ },
      max: { col: maxCol, row: maxRow, z: maxZ },
    }
  }

  // ---- 写 ----

  setBlock(pos: GridPos, block: SlotBlock): boolean {
    const row = this._rowAt(pos)
    if (!row) return false

    let index = this._findPaletteIndex(block.name, block.meta)
    if (index < 0) {
      index = this._palette.length
      this._palette.push({
        registryId: 'minecraft:' + block.name,
        meta: block.meta,
        renderMode: 'BlockModel',
        parts: [],
      })
      this._nameCache.set(index, block.name)
    }
    row[pos.col] = index
    return true
  }

  removeBlock(pos: GridPos): boolean {
    const row = this._rowAt(pos)
    if (!row) return false
    row[pos.col] = AIR_PALETTE_INDEX
    return true
  }

  moveBlock(from: GridPos, to: GridPos): boolean {
    // Fix 1: reject negative target coordinates (would crash _expandToFit)
    if (to.col < 0 || to.row < 0 || to.z < 0) return false

    const fromRow = this._rowAt(from)
    if (!fromRow) return false
    if (fromRow[from.col] === AIR_PALETTE_INDEX) return false

    // Fix 2: check target occupancy BEFORE _expandToFit to avoid grid inflation
    // on failed moves. Out-of-bounds targets are implicitly air.
    if (to.z < this._cellGrid.length &&
        to.row < this._cellGrid[to.z].length &&
        to.col < this._cellGrid[to.z][to.row].length) {
      if (this._cellGrid[to.z][to.row][to.col] !== AIR_PALETTE_INDEX) return false
    }

    this._expandToFit(to)

    const toSlice = this._cellGrid[to.z]
    const toRow = toSlice![to.row]
    toRow[to.col] = fromRow[from.col]
    fromRow[from.col] = AIR_PALETTE_INDEX
    return true
  }

  /** Bounds-checked row access. Returns null if pos is out of range. */
  private _rowAt(pos: GridPos): number[] | null {
    if (pos.z < 0 || pos.z >= this.depth) return null
    const slice = this._cellGrid[pos.z]
    if (!slice || pos.row < 0 || pos.row >= slice.length) return null
    const row = slice[pos.row]
    if (!row || pos.col < 0 || pos.col >= row.length) return null
    return row
  }

  private _expandToFit(pos: GridPos): void {
    const curZ = this._cellGrid.length
    const curY = this._cellGrid[0]?.length ?? 0
    const curX = this._cellGrid[0]?.[0]?.length ?? 0
    const newZ = Math.max(curZ, pos.z + 1)
    const newY = Math.max(curY, pos.row + 1)
    const newX = Math.max(curX, pos.col + 1)

    if (newZ > curZ) {
      const empty = Array.from({ length: newY }, () => new Array(newX).fill(0))
      while (this._cellGrid.length < newZ) {
        this._cellGrid.push(empty.map(r => [...r]))
      }
    }
    if (newY > curY) {
      for (const slice of this._cellGrid) {
        while (slice.length < newY) slice.push(new Array(newX).fill(0))
      }
    }
    if (newX > curX) {
      for (const slice of this._cellGrid) {
        for (const row of slice) {
          while (row.length < newX) row.push(0)
        }
      }
    }
  }

  private _findPaletteIndex(name: string, meta: number): number {
    const rid = 'minecraft:' + name
    for (let i = 0; i < this._palette.length; i++) {
      const e = this._palette[i]
      if (e && e.registryId === rid && e.meta === meta) return i
    }
    return -1
  }

  // ---- 导出 ----

  toRaw(): { cellGrid: number[][][]; blockPalette: BlockPaletteEntry[] } {
    return { cellGrid: this._cellGrid, blockPalette: this._palette }
  }
}

// ---------------------------------------------------------------------------
// RuntimeFrame
// ---------------------------------------------------------------------------

export class RuntimeFrame {
  readonly index: number
  readonly label: string | undefined
  readonly grid: Grid | null

  constructor(index: number, frame: Frame) {
    this.index = index
    this.label = frame.label
    const st = frame.structure as StructureDataBaked | undefined
    if (st?.cellGrid?.length && st.blockPalette?.length) {
      this.grid = new Grid(st.cellGrid, st.blockPalette)
    } else {
      this.grid = null
    }
  }

  toRaw(): Frame {
    return {
      index: this.index,
      label: this.label,
      structure: this.grid
        ? { ...this.grid.toRaw(), geometryPhase: 'baked' } as StructureDataBaked
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

  private _raw: Record<string, unknown>

  constructor(raw: Record<string, unknown>) {
    this._raw = raw
    this.formatVersion = (raw.format_version as string) ?? '2.0'
    this.id = (raw.id as string) ?? ''
    this.meta = (raw.meta as Record<string, unknown>) ?? {}
    this.annotations = (raw.annotations as unknown[]) ?? []
    this.labels = (raw.labels as unknown[]) ?? []

    const rawFrames = (raw.frames as Frame[]) ?? []
    this.frames = rawFrames.map((f, i) => new RuntimeFrame(i, f))
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

  /** 导出为 V2Plain 格式（预览/存储共用） */
  toRaw(): Record<string, unknown> {
    this._raw.frames = this.frames.map(f => f.toRaw())
    return this._raw
  }

  /** 深拷贝（undo snapshot 用） */
  clone(): RuntimeDocument {
    return new RuntimeDocument(JSON.parse(JSON.stringify(this.toRaw())))
  }

  /** 从 V2Plain 原始文档创建 */
  static fromRaw(raw: Record<string, unknown>): RuntimeDocument {
    return new RuntimeDocument(raw)
  }

  /** 创建空文档 */
  static empty(): RuntimeDocument {
    return new RuntimeDocument({
      format_version: '2.0',
      id: '',
      frames: [],
      meta: { name: '未命名', author: '', created_at_ms: Date.now(), description: '', tags: [], origin: { x: 0, y: 0, z: 0 } },
      annotations: [],
      labels: [],
    })
  }
}
