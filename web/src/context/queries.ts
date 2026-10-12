/**
 * Scene queries — 对标 Blender 的 BKE_scene_* / ED_view3d_* 查询函数。
 *
 * 每个函数接收 ctx 作为第一参数，纯读取，不对 ctx 产生副作用。
 * 操作符直接 import { pickVoxel, ... } from '@/context/queries' 调用。
 */
import type { Context } from '@/runtime/context'
import type { MaterialQueryItem, BlockTypeStat } from '@/runtime/types'
import type { BlockRef } from '@/context/selection'
// #301 P10f C′1（N4）：注解/材质的读面形状来自内核读面（不再依赖旧 Annotation 联合）。
import type { KernelAnnotationView } from '@/runtime/annotationRead'
import type { Frame } from '@/render/schema/types'
import {
  scenePickAllFromPointer,
  pickAtPointer,
  type ScenePickParams,
  type ScenePickResult,
  type ScenePickBlock,
} from '@/render/interaction/scenePick'
import { decodeBakedGeometry } from '@/render/mesh/bakedGeometryDecode'
import type { BakedQuadsGeometry } from '@/render/schema/types'
import { structureRowToWorldY } from '@/pure/vec'
import {
  blockLocalPointFromWorldPoint,
  pickPartAtLocalPoint,
  type BlockLocalPoint,
} from '@/pure/partHit'
import type { PartRecord } from '@/pure/partTypes'
import { resolvePartMaskGeometry, type PartMaskGeometry } from '@/pure/partMask'

/**
 * 当前注解集（供 `scenePick` 的盒拾取）。
 *
 * #301 P10f C′1（N4 字段完备处）：改走**内核注解读面**。
 *
 * ## 为什么这里可以同义替换（字段需求**实测**）
 *
 * 唯一消费者 `render/interaction/scenePick.ts` 只读
 * `id` / `type` / `visible` / `min` / `max`（`:194-197`、`:298-306`，其中
 * `isPickableBox` 已把该结构子集写成类型）—— 全部由内核承载
 * （字段表见 `runtime/annotationRead`）。
 *
 * ⚠️ 内核未装配（GF-16 = false）时读面返回**空表**：此时内核侧确实没有可读的注解，
 * 而"回落读 legacy"会让来源再次不可判（D8 同型）。调用方若要区分
 * "没有注解"与"内核没装"，问 `ctx.hasAdoptedContent()`。
 */
function readAnnotations(ctx: Context): KernelAnnotationView[] {
  return [...ctx.kernelAnnotations()]
}

function viewportSlot(ctx: Context, regionId?: string) {
  return regionId ? (ctx.viewports.get(regionId) ?? ctx.getViewport()) : ctx.getViewport()
}

function scenePickBase(ctx: Context, regionId?: string): Omit<ScenePickParams, 'clientX' | 'clientY'> | null {
  const vp = viewportSlot(ctx, regionId)
  const camera = vp.camera.value
  const contentGroup = vp.contentGroup.value
  const domElement = vp.domElement.value
  const definition = vp.definition.value
  if (!camera || !contentGroup || !domElement || !definition) return null
  return {
    domElement,
    camera,
    contentGroup,
    overlayGroup: vp.overlayGroup.value ?? undefined,
    worldAnnotationGroup: vp.worldAnnotationGroup.value ?? undefined,
    def: definition,
    layerPreview: vp.layerPreview.value ?? 'all',
    annotations: readAnnotations(ctx),
  }
}

function gridHeight(ctx: Context): number {
  const doc = ctx.getDoc().value
  const rf = doc?.frame(ctx.getFrameIndex())
  return rf?.grid?.height ?? 0
}

/** 统一视口拾取（方块 / 注解） */
export function pickEntity(ctx: Context, event: PointerEvent, regionId?: string): ScenePickResult {
  return pickEntityAtClient(ctx, event.clientX, event.clientY, regionId)
}

export function pickEntityAtClient(
  ctx: Context,
  clientX: number,
  clientY: number,
  regionId?: string,
): ScenePickResult {
  const base = scenePickBase(ctx, regionId)
  if (!base) return null
  return pickAtPointer({ ...base, clientX, clientY })
}

/** 屏幕坐标 → 方块引用 */
export function pickVoxel(ctx: Context, event: PointerEvent, regionId?: string): BlockRef | null {
  const result = pickEntity(ctx, event, regionId)
  if (!result || result.kind !== 'block') return null

  const h = gridHeight(ctx)
  const worldY = h > 0 ? structureRowToWorldY(result.row, h) : result.row

  return {
    pos: { x: result.column, y: worldY, z: result.zSlice },
    block_state_id: result.blockId,
    quadIndex: result.quadIndex,
    normal: result.normal,
    point: result.point,
  }
}

/** 部件级拾取结果（P2.2）：命中的部件 + 格内局部命中点 */
export interface PartPick {
  part: PartRecord
  localPoint: BlockLocalPoint
}

/**
 * pickVoxel 的部件级细化（P2.2，契约 §6/§8）：
 * 命中格有部件且世界命中点换算为格内局部坐标后落入某部件盒 ⇒ 返回该部件；
 * 否则返回 null（调用方保持宿主格既有行为，不劣化）。
 * 盒为导出时快照，可越出 [0,1]³（契约 §6.3）；命中规则见 pure/partHit.ts。
 */
export function pickPartForScenePick(ctx: Context, picked: ScenePickBlock): PartPick | null {
  if (!picked.point) return null
  const doc = ctx.getDoc().value
  const rf = doc?.frame(ctx.getFrameIndex())
  const grid = rf?.grid
  if (!grid || grid.height <= 0) return null
  const worldY = structureRowToWorldY(picked.row, grid.height)
  const parts = grid.partsAt({ x: picked.column, y: worldY, z: picked.zSlice })
  if (!parts || parts.length === 0) return null
  const localPoint = blockLocalPointFromWorldPoint(
    picked.point,
    { column: picked.column, row: picked.row, zSlice: picked.zSlice },
    { sizeColumn: grid.width, sizeRow: grid.height, sizeZSlice: grid.depth },
  )
  const part = pickPartAtLocalPoint(parts, localPoint)
  return part ? { part, localPoint } : null
}

/** 指针位置穿透的全部实体候选（去重、按深度排序），用于轮换拾取 */
export function pickAll(ctx: Context, event: PointerEvent, regionId?: string) {
  const base = scenePickBase(ctx, regionId)
  if (!base) return []
  const results = scenePickAllFromPointer({
    ...base,
    clientX: event.clientX,
    clientY: event.clientY,
  })
  const h = gridHeight(ctx)
  for (const r of results) {
    if (r.kind === 'block' && r.row !== undefined) {
      r.row = h > 0 ? structureRowToWorldY(r.row, h) : r.row
    }
  }
  return results
}

/** 获取当前帧的可变引用 */
export function getCurrentFrame(ctx: Context): Frame | null {
  const doc = ctx.getDoc().value
  if (!doc) return null
  const idx = ctx.getFrameIndex()
  const rf = doc.frame(idx)
  if (!rf) return null
  return { index: rf.index, label: rf.label }
}

/** 获取当前帧的 BlockRef 快照列表 */
export function getFrameBlocks(ctx: Context): BlockRef[] {
  const doc = ctx.getDoc().value
  if (!doc) return []
  const rf = doc.frame(ctx.getFrameIndex())
  if (!rf?.grid) return []
  return rf.grid.blocks().map(({ pos, block }) => ({
    pos: { x: pos.x, y: pos.y, z: pos.z },
    block_state_id: `minecraft:${block.name}:${block.meta}`,
  }))
}

/** 获取完整的场景文档（用于 annotations、labels 等顶层集合的访问） */
export function getDocument(ctx: Context): Record<string, unknown> | null {
  const doc = ctx.getDoc().value
  if (!doc) return null
  return doc.serialize() as Record<string, unknown>
}

/** 将 Y-up GridPos 转换为世界空间体素中心坐标 */
export function gridCenterWorld(
  ctx: Context,
  pos: { x: number; y: number; z: number },
): { x: number; y: number; z: number } | null {
  const doc = ctx.getDoc().value
  if (!doc) return null
  const rf = doc.frame(ctx.getFrameIndex())
  if (!rf?.grid) return null
  return rf.grid.centerWorld(pos)
}

/**
 * 当前帧的**帧键**（`RuntimeFrame.index`），即 `ItemAttributionHit.frame` 的取值域。
 *
 * 为什么要它而不是 `getCurrentFrameIndex()`：后者是**数组下标**，前者是落盘在帧上的
 * `index` 字段——`itemIndex` 的归属条目按后者记录（契约 §2.2）。两者在常规导出里相同，
 * 但以落盘字段为准才是"同一坐标系"。
 *
 * 消费方：B-5 的物品点选高亮（`pure/itemOutlinePlan.ts#planItemOutlineHits` 的帧过滤）。
 */
export function currentFrameKey(ctx: Context): number {
  const doc = ctx.getDoc().value
  const i = ctx.getFrameIndex()
  return doc?.frame(i)?.index ?? i
}

/**
 * 列出所有材质及其纹理 dataURL。
 *
 * #301 P10f C′1（N4 字段完备处）：改走**内核材质读面**（`ctx.kernelMaterials()`）。
 *
 * ## 两处字段适配的机械依据（不是"看着像"）
 *
 *  1. **`textureBlobIndex` → 内联 `payload`**：legacy 是"调色板条目里的下标 +
 *     `textureBlobs` 旁表"两级间接；内核把字节**内联在资源上**（`ContentResource.payload`）
 *     ⇒ 读面直接给出 data URL，本函数不再需要旁表与下标。
 *  2. **`locator` → `ref.url`**：语义同为"资源位置"（`ResourceRef` 明文说它
 *     "**仅**用于取回，不参与身份"）。
 *
 * data URL 的补前缀规则与 legacy **逐字相同**（已在读面内实现：
 * 已是 `data:` 的原样返回，否则补 `data:image/png;base64,`）——
 * 那条判断不能省，否则二次加前缀会产出坏 URL。
 */
export function listMaterials(ctx: Context): MaterialQueryItem[] {
  return ctx.kernelMaterials().map((m) => ({
    materialId: m.materialId,
    kind: (m.kind ?? 'static16') as MaterialQueryItem['kind'],
    blend: m.blend as MaterialQueryItem['blend'],
    locator: m.locator as MaterialQueryItem['locator'],
    emissive: m.emissive as MaterialQueryItem['emissive'],
    animation: m.animation as MaterialQueryItem['animation'],
    textureDataUrl: m.textureDataUrl,
    atlas: m.atlas as MaterialQueryItem['atlas'],
    linear: m.linear as MaterialQueryItem['linear'],
    useMipmaps: m.useMipmaps as MaterialQueryItem['useMipmaps'],
  }))
}

/** 当前帧按 materialId 统计方块数量 */
export function getMaterialUsageCounts(ctx: Context): Record<string, number> {
  const counts: Record<string, number> = {}
  const doc = ctx.getDoc().value
  if (!doc) return counts
  const rf = doc.frame(ctx.getFrameIndex())
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
export function getBlockTypeStats(ctx: Context): Record<string, BlockTypeStat> {
  const stats: Record<string, BlockTypeStat> = {}
  const doc = ctx.getDoc().value
  if (!doc) return stats
  const rf = doc.frame(ctx.getFrameIndex())
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
  ctx: Context,
  pos: { x: number; y: number; z: number },
) {
  const doc = ctx.getDoc().value
  if (!doc) return null
  const rf = doc.frame(ctx.getFrameIndex())
  if (!rf?.grid) return null
  const block = rf.grid.at(pos)
  if (!block || block.paletteIndex === undefined) return null
  const cache = rf.grid.getPaletteCache()
  return cache.get('#' + String(block.paletteIndex)) ?? null
}

/** 获取方块位置的模型几何数据（解码后的 BakedQuad[]），用于精确轮廓描边 */
export function getBlockGeometry(
  ctx: Context,
  pos: { x: number; y: number; z: number },
) {
  const doc = ctx.getDoc().value
  if (!doc) return null
  const rf = doc.frame(ctx.getFrameIndex())
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

/** 获取方块位置的部件列表（契约 §3；无部件 ⇒ null，只读视图勿改） */
export function getPartsAt(
  ctx: Context,
  pos: { x: number; y: number; z: number },
): readonly PartRecord[] | null {
  const doc = ctx.getDoc().value
  if (!doc) return null
  const rf = doc.frame(ctx.getFrameIndex())
  if (!rf?.grid) return null
  return rf.grid.partsAt(pos)
}

/**
 * 「格 + 部件定位 → 该部件 mask」通道（B-1）：hover 描边与（B-5 的）点选高亮**共用**此入口。
 *
 * - `ref.partLocalId === undefined` ⇒ 整格几何（既有行为：无部件格、框选/按类型选择等）；
 * - 给定 `partLocalId` 且该格有部件 ⇒ 该部件盒 union（贴面盒退化为其所辖 quads 的 AABB）；
 * - 无几何 ⇒ null（调用方退化为格中心 1×1×1 盒，与既有实现一致）。
 *
 * 判定规则与理由见 `pure/partMask.ts` 文件头（含「按部件盒 vs 按 quads 归属切分」对比结论）。
 */
export function getPartMaskGeometry(
  ctx: Context,
  ref: BlockRef,
): PartMaskGeometry | null {
  return resolvePartMaskGeometry(
    getPartsAt(ctx, ref.pos),
    getBlockGeometry(ctx, ref.pos),
    ref.partLocalId,
  )
}
