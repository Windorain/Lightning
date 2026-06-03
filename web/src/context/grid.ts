/**
 * Grid — 3D 方块网格。
 *
 * Y-up 坐标系（y = 0 = 底部，height - 1 = 顶部）。
 * cells[z][y][x] = SlotBlock | null。
 *
 * 独立于传输格式（V2Plain / StructureData / World）。
 * Palette 已解析为 SlotBlock，不使用原始的 palette index。
 */
import { blockKey } from '@/pure/string'
import type { GridPos, SlotBlock, PaletteEntryMeta } from '@/pure/gridTypes'

// Re-export for backward compatibility
export type { GridPos, SlotBlock, PaletteEntryMeta }

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

  /** 将 GridPos (Y-up) 转换为世界空间体素中心坐标（网格居中于原点，方块中心偏移 +0.5） */
  centerWorld(pos: GridPos): { x: number; y: number; z: number } {
    return {
      x: pos.x - this._width / 2 + 0.5,
      y: pos.y - this._height / 2 + 0.5,
      z: pos.z - this._depth / 2 + 0.5,
    }
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
