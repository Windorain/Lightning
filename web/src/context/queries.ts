/**
 * Scene queries — 对标 Blender 的 BKE_scene_* / ED_view3d_* 查询函数。
 *
 * 每个函数接收 bctx 作为第一参数，纯读取，不对 bctx 产生副作用。
 * 操作符直接 import { pickVoxel, ... } from '@/context/queries' 调用。
 */
import type { BContext, MaterialQueryItem, BlockTypeStat } from '@/context/bContext'
import type { BlockRef } from '@/context/selection'
import type { Frame } from '@/render/schema/types'
import { scenePickAllFromPointer, scenePickFromPointer } from '@/render/interaction/scenePick'
import { decodeBakedGeometry } from '@/render/mesh/bakedGeometryDecode'
import type { BakedQuadsGeometry } from '@/render/schema/types'
import { structureRowToWorldY } from '@/pure/vec'

/** 屏幕坐标 → 方块引用 */
export function pickVoxel(bctx: BContext, event: PointerEvent): BlockRef | null {
  const vp = bctx.viewport
  const camera = vp.camera.value
  const contentGroup = vp.contentGroup.value
  const domElement = vp.domElement.value
  const definition = vp.definition.value
  if (!camera || !contentGroup || !domElement || !definition) return null
  const result = scenePickFromPointer({
    clientX: event.clientX,
    clientY: event.clientY,
    domElement,
    camera,
    contentGroup,
    overlayGroup: vp.overlayGroup.value ?? undefined,
    def: definition,
    layerPreview: vp.layerPreview.value ?? 'all',
  })
  if (!result || result.kind !== 'block') return null

  const doc = bctx.doc.value
  const rf = doc?.frame(bctx.currentWorldFrameIndex.value ?? 0)
  const h = rf?.grid?.height ?? 0
  const worldY = h > 0 ? structureRowToWorldY(result.row, h) : result.row

  return {
    pos: { x: result.column, y: worldY, z: result.zSlice },
    block_state_id: result.blockId,
    quadIndex: result.quadIndex,
    normal: result.normal,
    point: result.point,
  }
}

/** 指针位置穿透的全部实体候选（去重、按深度排序），用于轮换拾取 */
export function pickAll(bctx: BContext, event: PointerEvent) {
  const vp = bctx.viewport
  const camera = vp.camera.value
  const contentGroup = vp.contentGroup.value
  const domElement = vp.domElement.value
  const definition = vp.definition.value
  if (!camera || !contentGroup || !domElement || !definition) return []
  const results = scenePickAllFromPointer({
    clientX: event.clientX,
    clientY: event.clientY,
    domElement,
    camera,
    contentGroup,
    overlayGroup: vp.overlayGroup.value ?? undefined,
    def: definition,
    layerPreview: vp.layerPreview.value ?? 'all',
  })
  const doc = bctx.doc.value
  const rf = doc?.frame(bctx.currentWorldFrameIndex.value ?? 0)
  const h = rf?.grid?.height ?? 0
  for (const r of results) {
    if (r.kind === 'block' && r.row !== undefined) {
      r.row = h > 0 ? structureRowToWorldY(r.row, h) : r.row
    }
  }
  return results
}

/** 获取当前帧的可变引用 */
export function getCurrentFrame(bctx: BContext): Frame | null {
  const doc = bctx.doc.value
  if (!doc) return null
  const idx = bctx.currentWorldFrameIndex.value ?? 0
  const rf = doc.frame(idx)
  if (!rf) return null
  return { index: rf.index, label: rf.label }
}

/** 获取当前帧的 BlockRef 快照列表 */
export function getFrameBlocks(bctx: BContext): BlockRef[] {
  const doc = bctx.doc.value
  if (!doc) return []
  const rf = doc.frame(bctx.currentWorldFrameIndex.value ?? 0)
  if (!rf?.grid) return []
  return rf.grid.blocks().map(({ pos, block }) => ({
    pos: { x: pos.x, y: pos.y, z: pos.z },
    block_state_id: `minecraft:${block.name}:${block.meta}`,
  }))
}

/** 获取完整的场景文档（用于 annotations、labels 等顶层集合的访问） */
export function getDocument(bctx: BContext): Record<string, unknown> | null {
  const doc = bctx.doc.value
  if (!doc) return null
  return doc.serialize() as Record<string, unknown>
}

/** 将 Y-up GridPos 转换为世界空间体素中心坐标 */
export function gridCenterWorld(
  bctx: BContext,
  pos: { x: number; y: number; z: number },
): { x: number; y: number; z: number } | null {
  const doc = bctx.doc.value
  if (!doc) return null
  const rf = doc.frame(bctx.currentWorldFrameIndex.value ?? 0)
  if (!rf?.grid) return null
  return rf.grid.centerWorld(pos)
}

/** 列出所有材质及其纹理 dataURL */
export function listMaterials(bctx: BContext): MaterialQueryItem[] {
  const doc = bctx.doc.value
  if (!doc) return []
  const palette = doc.materialPalette as any[] | undefined
  if (!palette?.length) return []
  const blobs = doc.textureBlobs as Record<string, unknown> | undefined

  function getBlob(index: number): string | null {
    if (!blobs) return null
    const key = String(index)
    const b = blobs[key]
    if (typeof b !== 'string') return null
    const t = b.trim()
    if (t.startsWith('data:')) return t
    return `data:image/png;base64,${t}`
  }

  return palette.map((entry: any, i: number) => {
    const idx = entry.textureBlobIndex
    const dataUrl = (typeof idx === 'number' && Number.isFinite(idx))
      ? getBlob(Math.floor(idx))
      : null
    return {
      materialId: String(i),
      kind: entry.kind ?? 'static16',
      blend: entry.blend,
      locator: entry.locator,
      emissive: entry.emissive,
      animation: entry.animation,
      textureDataUrl: dataUrl,
      atlas: entry.atlas,
      linear: entry.linear,
      useMipmaps: entry.useMipmaps,
    }
  })
}

/** 当前帧按 materialId 统计方块数量 */
export function getMaterialUsageCounts(bctx: BContext): Record<string, number> {
  const counts: Record<string, number> = {}
  const doc = bctx.doc.value
  if (!doc) return counts
  const rf = doc.frame(bctx.currentWorldFrameIndex.value ?? 0)
  if (!rf?.grid) return counts
  rf.grid.forEach((_pos, block) => {
    if (block.paletteIndex !== undefined) {
      const key = String(block.paletteIndex)
      counts[key] = (counts[key] ?? 0) + 1
    }
  })
  return counts
}

/** 当前帧方块类型统计 (block_state_id → 计数) */
export function getBlockTypeStats(bctx: BContext): Record<string, BlockTypeStat> {
  const stats: Record<string, BlockTypeStat> = {}
  const doc = bctx.doc.value
  if (!doc) return stats
  const rf = doc.frame(bctx.currentWorldFrameIndex.value ?? 0)
  if (!rf?.grid) return stats
  rf.grid.forEach((_pos, block) => {
    const id = `minecraft:${block.name}:${block.meta}`
    const entry = stats[id]
    if (entry) {
      entry.count += 1
    } else {
      stats[id] = { count: 1 }
    }
  })
  return stats
}

/** 获取方块位置的调色板元数据 */
export function getBlockPaletteEntry(
  bctx: BContext,
  pos: { x: number; y: number; z: number },
) {
  const doc = bctx.doc.value
  if (!doc) return null
  const rf = doc.frame(bctx.currentWorldFrameIndex.value ?? 0)
  if (!rf?.grid) return null
  const block = rf.grid.at(pos)
  if (!block || block.paletteIndex === undefined) return null
  const cache = rf.grid.getPaletteCache()
  return cache.get('#' + String(block.paletteIndex)) ?? null
}

/** 获取方块位置的模型几何数据（解码后的 BakedQuad[]），用于精确轮廓描边 */
export function getBlockGeometry(
  bctx: BContext,
  pos: { x: number; y: number; z: number },
) {
  const doc = bctx.doc.value
  if (!doc) return null
  const rf = doc.frame(bctx.currentWorldFrameIndex.value ?? 0)
  if (!rf?.grid) return null
  const block = rf.grid.at(pos)
  if (!block || block.paletteIndex === undefined) return null
  const cache = rf.grid.getPaletteCache()
  const meta = cache.get('#' + String(block.paletteIndex))
  if (!meta?.geometry) return null
  try {
    return decodeBakedGeometry(meta.geometry as BakedQuadsGeometry)
  } catch {
    return null
  }
}
