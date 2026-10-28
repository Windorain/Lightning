/**
 * pure/gridTypes.ts — Pure value types for the grid system.
 * No side effects: no Vue refs, no DOM, no I/O.
 */
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
