/**
 * 测试场景数据工厂。
 *
 * 将 {x,y,z,id} 元组转换为生产格式的 cellGrid + blockPalette，
 * 构建符合 V2 格式的场景文档，通过 scene.loadFromData() 走生产加载路径。
 */

import type { BlockPaletteEntry } from '@/render/schema/types'

export interface BlockTuple { x: number; y: number; z: number; id: string }

/** 方块元组 → cellGrid + blockPalette */
export function blocksToCellGrid(blocks: BlockTuple[]): {
  cellGrid: number[][][]
  blockPalette: BlockPaletteEntry[]
} {
  if (blocks.length === 0) {
    return { cellGrid: [], blockPalette: [{ registryId: 'air', meta: 0 }] }
  }
  let maxX = 0, maxY = 0, maxZ = 0
  for (const b of blocks) {
    if (b.x >= maxX) maxX = b.x + 1
    if (b.y >= maxY) maxY = b.y + 1
    if (b.z >= maxZ) maxZ = b.z + 1
  }
  const ids = [...new Set(blocks.map(b => b.id))]
  const blockPalette: BlockPaletteEntry[] = [{ registryId: 'air', meta: 0 }]
  for (const id of ids) blockPalette.push({ registryId: id, meta: 0 })
  const idToIndex = new Map<string, number>()
  for (let i = 0; i < ids.length; i++) idToIndex.set(ids[i], i + 1)
  const cellGrid: number[][][] = []
  for (let z = 0; z < maxZ; z++) {
    const slice: number[][] = []
    for (let y = 0; y < maxY; y++) slice.push(new Array(maxX).fill(0))
    cellGrid.push(slice)
  }
  for (const b of blocks) {
    if (b.x < 0 || b.y < 0 || b.z < 0) continue
    const idx = idToIndex.get(b.id) ?? 0
    if (cellGrid[b.z]?.[b.y] !== undefined) cellGrid[b.z][b.y][b.x] = idx
  }
  return { cellGrid, blockPalette }
}

/** 构建符合生产格式的测试场景文档 */
export function buildTestSceneDocument(blocks: BlockTuple[]): Record<string, any> {
  const { cellGrid, blockPalette } = blocksToCellGrid(blocks)
  const palette: Record<string, { name: string }> = {}
  for (const b of blocks) { if (b.id && !palette[b.id]) palette[b.id] = { name: b.id } }
  return {
    format_version: '2.0',
    meta: { name: 'test', author: '', created_at_ms: 0, description: '', tags: [], origin: { x: 0, y: 0, z: 0 } },
    frames: [{
      index: 0, label: 'Frame 0',
      structure: {
        geometryPhase: 'baked' as const,
        id: 'test-structure',
        cellGrid,
        blockPalette,
        materialPalette: [],
      },
    }],
    block_palette: palette,
    materials: { entries: [] },
  }
}
