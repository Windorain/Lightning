/**
 * 纹理图集布局与 UV 重映射（纯算术）。
 */

export interface AtlasPlacement {
  blobIndex: number
  x: number
  y: number
  width: number
  height: number
}

/** 与 {@link AtlasPlacement} 相同布局，但用任意 tileId（方块模式体素 atlas 等） */
export interface AtlasTilePlacement {
  tileId: number
  x: number
  y: number
  width: number
  height: number
}

/**
 * 与 {@link packTextureGrid} 相同算法，按 tileId 标识格子（可与 blob 索引无关）。
 */
export function packTextureGridByTileId(
  items: Array<{ tileId: number; width: number; height: number }>,
  padding: number,
  maxSide: number,
): { atlasWidth: number; atlasHeight: number; placements: AtlasTilePlacement[] } {
  if (items.length === 0) {
    return { atlasWidth: 0, atlasHeight: 0, placements: [] }
  }

  let x = padding
  let y = padding
  let rowH = 0
  let atlasW = padding * 2
  let atlasH = padding * 2

  const placements: AtlasTilePlacement[] = []

  for (const it of items) {
    const w = it.width + padding
    const h = it.height + padding
    if (x + w > maxSide && x > padding) {
      x = padding
      y += rowH
      rowH = 0
    }
    if (rowH < h) rowH = h

    placements.push({
      tileId: it.tileId,
      x,
      y,
      width: it.width,
      height: it.height,
    })
    x += w
    atlasW = Math.max(atlasW, x + padding)
    atlasH = Math.max(atlasH, y + rowH + padding)
  }

  return { atlasWidth: atlasW, atlasHeight: atlasH, placements }
}

export function buildTileIdToUvRect(
  placements: AtlasTilePlacement[],
  atlasWidth: number,
  atlasHeight: number,
): Map<number, { u0: number; v0: number; u1: number; v1: number }> {
  const m = new Map<number, { u0: number; v0: number; u1: number; v1: number }>()
  const aw = Math.max(1, atlasWidth)
  const ah = Math.max(1, atlasHeight)
  for (const p of placements) {
    const u0 = p.x / aw
    const v0 = p.y / ah
    const u1 = (p.x + p.width) / aw
    const v1 = (p.y + p.height) / ah
    m.set(p.tileId, { u0, v0, u1, v1 })
  }
  return m
}

/**
 * 将局部 UV (0..1) 映射到 atlas 子矩形。
 */
export function remapUvPair(
  u: number,
  v: number,
  rect: { u0: number; v0: number; u1: number; v1: number },
): { u: number; v: number } {
  return {
    u: rect.u0 + u * (rect.u1 - rect.u0),
    v: rect.v0 + v * (rect.v1 - rect.v0),
  }
}

