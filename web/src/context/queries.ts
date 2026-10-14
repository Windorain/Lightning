/**
 * Scene queries — 对标 Blender 的 BKE_scene_* / ED_view3d_* 查询函数。
 *
 * 每个函数接收 ctx 作为第一参数，纯读取，不对 ctx 产生副作用。
 * 操作符直接 import { pickVoxel, ... } from '@/context/queries' 调用。
 */
import type { Context } from '@/runtime/context'
// NDC 换算需要真的构造 `Vector2`（见 `ndcOf`）⇒ 值导入。
import * as THREE from 'three'
import type { MaterialQueryItem, BlockTypeStat } from '@/runtime/types'
import type { BlockRef } from '@/context/selection'
// #301 P10f C′1（N4）：注解/材质的读面形状来自内核读面（不再依赖旧 Annotation 联合）。
import type { KernelAnnotationView } from '@/runtime/annotationRead'
import type { Frame } from '@/render/schema/types'
import {
  pickAllInViewport,
  pickInViewport,
  type ViewportPickInput,
} from '@/composition/viewportPick'
// R1-β① C8：返回/入参形状改吃**独立形状契约**（`presentation/pickResult`）。
// 旧定义寄居在 `render/interaction/scenePick.ts` 里，而该文件的
// `pickAtPointer`/`scenePickAllFromPointer` 在本批被删除 ⇒ 消费方不得再依赖它。
import type { PickBlock, PickEntity, PickResult } from '@/presentation/pickResult'
// #301 P10f D3：`decodeBakedGeometry` 与 `BakedQuadsGeometry` 的导入**随本文件最后两处
// legacy 读点一起退出** —— 解码与「两侧几何归一」已收进 `runtime/gridRead`（一处），
// 不再由消费点各自解码（那正是 15 处会漂移的适配）。`BakedQuad` 仍需要：
// 它是本查询的**返回类型**（消费点按它用）。
import type { BakedQuad } from '@/render/schema/types'
import { structureRowToWorldY } from '@/pure/vec'
import {
  blockLocalPointFromWorldPoint,
  pickPartAtLocalPoint,
  type BlockLocalPoint,
} from '@/pure/partHit'
import type { PartRecord } from '@/pure/partTypes'
import { resolvePartMaskGeometry, type PartMaskGeometry } from '@/pure/partMask'

/**
 * 当前注解集（盒拾取与注解命中身份的唯一读面）。
 *
 * #301 P10f C′1（N4 字段完备处）：改走**内核注解读面**。
 *
 * R1-β① C8：消费者从旧 `render/interaction/scenePick` 换成
 * `composition/viewportPick`（内核链）—— 注解命中的**身份映射**（内核对象 id
 * `annotation:<legacyId>` → 面板用的裸 id）在那边完成，本函数只负责"读到哪些注解"。
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

/**
 * **内核链拾取的入参**（R1-β① C8）。
 *
 * ## 与旧 `scenePickBase` 的差别（不是"换了几个字段"）
 *
 * | 旧 | 新 | 为什么 |
 * |---|---|---|
 * | `contentGroup`（legacy mesh 树） | `surface`（`PresenterSession`） | 画面生产者已切内核 ⇒ 只有内核批次上的命中能被解出格 |
 * | `def`（结构定义 → `buildVoxelVolume`） | `grid`（`ctx.kernelGrid`） | 逐格身份与 `blockId` 由内核网格读面给出（与 legacy 同语义，见 `kernelPickAdapter`） |
 * | `worldAnnotationGroup`/`overlayGroup`（各扫一次） | 注解子树（`PresenterSession` 内） | 注解的呈现已统一到呈现会话（`overlayPresenter` 的 depth/renderOrder 语义在那里） |
 *
 * ## 为什么缺任何一项就返回 `null`（而不是"尽力而为"）
 *
 * 拾取是**身份判定**：少了网格读面就无法把格映射成 `blockId`，少了呈现会话就没有
 * 可解算的批次。此处返回 `null` = "本次拾取没有结果"，而**不是**回落到旧链
 * （那会让"谁解出的这一格"重新出现两个答案，且回落会静默 —— 正是 #387 要消灭的形态）。
 */
function pickBase(ctx: Context, regionId?: string): (Omit<ViewportPickInput, 'ndc'> & { domElement: HTMLElement }) | null {
  const vp = viewportSlot(ctx, regionId)
  const camera = vp.camera.value
  const domElement = vp.domElement.value
  const surface = vp.presenterSurface
  const grid = ctx.kernelGrid(ctx.getFrameIndex())
  if (!camera || !domElement || surface === null || grid === null || grid === undefined) return null
  return {
    surface,
    camera,
    grid,
    domElement,
    layerPreview: vp.layerPreview.value ?? 'all',
    annotations: readAnnotations(ctx),
  }
}

/**
 * 客户端坐标 → NDC（**唯一**换算点）。
 *
 * 实现从旧 `scenePick.pickAtPointer` **逐字搬移**（`getBoundingClientRect` + Y 翻转）：
 * 换算口径改变会让所有拾取位置整体偏移，而那是"看不出错在哪"的一类回归。
 */
function ndcOf(domElement: HTMLElement, clientX: number, clientY: number): THREE.Vector2 {
  const rect = domElement.getBoundingClientRect()
  return new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  )
}

function gridHeight(ctx: Context): number {
  // #301 P10f D3（R5 网格读面）：`height` 是**声明尺寸**（见 `runtime/gridRead`
  // 的 `resolveGridSize`）—— 旧实现按包围盒推，尾层全空时会偏小 ⇒ 拾取 Y 偏移。
  return ctx.kernelGrid(ctx.getFrameIndex())?.height ?? 0
}

/** 统一视口拾取（方块 / 注解） */
export function pickEntity(ctx: Context, event: PointerEvent, regionId?: string): PickResult {
  return pickEntityAtClient(ctx, event.clientX, event.clientY, regionId)
}

export function pickEntityAtClient(
  ctx: Context,
  clientX: number,
  clientY: number,
  regionId?: string,
): PickResult {
  const base = pickBase(ctx, regionId)
  if (!base) return null
  const { domElement, ...rest } = base
  return pickInViewport({ ...rest, ndc: ndcOf(domElement, clientX, clientY) })
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
export function pickPartForScenePick(ctx: Context, picked: PickBlock): PartPick | null {
  if (!picked.point) return null
  // #301 P10f D3（R5）：网格读面（`partsAt` 走内核 `cellContent.parts`）。
  const grid = ctx.kernelGrid(ctx.getFrameIndex())
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
export function pickAll(ctx: Context, event: PointerEvent, regionId?: string): readonly PickEntity[] {
  const base = pickBase(ctx, regionId)
  if (!base) return []
  const { domElement, ...rest } = base
  const results = pickAllInViewport({ ...rest, ndc: ndcOf(domElement, event.clientX, event.clientY) })
  const h = gridHeight(ctx)
  // ⚠️ 形状契约的字段是**只读**的（`presentation/pickResult`）⇒ 结构行号 → 世界 Y
  // 的换算必须**造新对象**而不是原地改 `row`（旧写法 `r.row = …` 在只读对象上会抛
  // TypeError，而不是静默失效）。
  return results.map((r) =>
    r.kind === 'block' && r.row !== undefined
      ? { ...r, row: h > 0 ? structureRowToWorldY(r.row, h) : r.row }
      : r,
  )
}

/**
 * 当前帧的**声明**（`{index, label}`）。
 *
 * #301 P10f D3（**R4**）：改走 `ctx.frameDeclarations()` —— 帧声明的**唯一**读取面
 * （与状态栏、帧循环**同一个函数**，故三处读数不可能不一致）。
 *
 * ⚠️ `index` 的取值域：本读面给的是**轴上的位置序**（与 `count`/`durationsMs`/`labels`
 * 同一套下标）。旧实现读的是落盘在帧上的 `index` 字段 —— 两者在常规导出里相同
 *（装配按数组序填），要落盘字段的语义请用 {@link currentFrameKey}。
 */
export function getCurrentFrame(ctx: Context): Frame | null {
  const decl = ctx.frameDeclarations()
  const idx = ctx.getFrameIndex()
  if (idx < 0 || idx >= decl.count) return null
  return { index: idx, label: decl.labels[idx] ?? undefined }
}

/** 获取当前帧的 BlockRef 快照列表 */
export function getFrameBlocks(ctx: Context): BlockRef[] {
  const grid = ctx.kernelGrid(ctx.getFrameIndex())
  if (!grid) return []
  // `kernelGrid` 的 `name`/`meta` 与旧 `SlotBlock` **同源同形**
  //（`blockGrid.cells` 的值就是 GF-7 的 `minecraft:<name>:<meta>`）⇒ 构造式逐字不变。
  return grid.blocks().map((cell) => ({
    pos: { x: cell.pos.x, y: cell.pos.y, z: cell.pos.z },
    block_state_id: `minecraft:${cell.name}:${cell.meta}`,
  }))
}

/**
 * 获取完整的场景文档 plain（用于 annotations、labels 等顶层集合的访问）。
 *
 * #301 P10f D3（**R3**）：改吃 `ctx.plainForSave()` —— 保存/导出的**唯一**产物入口
 *（内核投影优先，未装配回落旧文档）。产物等价已由 D2 的
 * `composition/__tests__/p10fSaveProjection.test.ts`（52 tests）在四份真实夹具上把守。
 */
export function getDocument(ctx: Context): Record<string, unknown> | null {
  return ctx.plainForSave().plain as Record<string, unknown> | null
}

/** 将 Y-up GridPos 转换为世界空间体素中心坐标 */
export function gridCenterWorld(
  ctx: Context,
  pos: { x: number; y: number; z: number },
): { x: number; y: number; z: number } | null {
  const grid = ctx.kernelGrid(ctx.getFrameIndex())
  if (!grid) return null
  return grid.centerWorld(pos)
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
  // #301 P10f D3（R4）：帧声明的唯一读取面。⚠️ 落盘字段 `RuntimeFrame.index`
  // 与轴上下标在常规导出里相同（装配按数组序填），本读面用轴下标 —— 语义见文件头。
  const i = ctx.getFrameIndex()
  return i
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
  const grid = ctx.kernelGrid(ctx.getFrameIndex())
  if (!grid) return counts
  // `paletteIndex` 是**文件槽位**（`blockGrid.cellPaletteIndex` 承载，见 `runtime/gridRead`）
  // —— 本函数按它分组，故读面必须给出**同一个数**（R-WK-09 裁决 4：不改下游键口径）。
  grid.forEach((cell) => {
    if (cell.paletteIndex !== undefined) {
      const key = String(cell.paletteIndex)
      counts[key] = (counts[key] ?? 0) + 1
    }
  })
  return counts
}

/** 当前帧方块类型统计 (block_state_id → 计数) */
export function getBlockTypeStats(ctx: Context): Record<string, BlockTypeStat> {
  const stats: Record<string, BlockTypeStat> = {}
  const grid = ctx.kernelGrid(ctx.getFrameIndex())
  if (!grid) return stats
  grid.forEach((cell) => {
    const id = `minecraft:${cell.name}:${cell.meta}`
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
  const grid = ctx.kernelGrid(ctx.getFrameIndex())
  if (!grid) return null
  const cell = grid.at(pos)
  if (!cell || cell.paletteIndex === undefined) return null
  // 旧实现经 `PaletteCache.get('#' + paletteIndex)` 取条目；读面按**内容键精确命中**
  //（内核侧）/ `PaletteCache`（legacy 侧）给出**同一份条目** —— 差异只在承载方式。
  const entry = grid.paletteEntryOf(pos)
  return entry === null ? null : (entry.raw as Record<string, unknown>)
}

/** 获取方块位置的模型几何数据（解码后的 BakedQuad[]），用于精确轮廓描边 */
export function getBlockGeometry(
  ctx: Context,
  pos: { x: number; y: number; z: number },
) {
  const grid = ctx.kernelGrid(ctx.getFrameIndex())
  if (!grid) return null
  const cell = grid.at(pos)
  if (!cell || cell.paletteIndex === undefined) return null
  // 读面已经把两侧的几何**归一**为解码后的四边形（内核资产 `quads` / legacy 原文解码），
  // 且解码失败与旧实现同样给 `null`（不抛）—— 见 `runtime/gridRead#quadsOfLegacyGeometry`。
  return grid.geometryOf(pos) as BakedQuad[] | null
}

/** 获取方块位置的部件列表（契约 §3；无部件 ⇒ null，只读视图勿改） */
export function getPartsAt(
  ctx: Context,
  pos: { x: number; y: number; z: number },
): readonly PartRecord[] | null {
  return ctx.kernelGrid(ctx.getFrameIndex())?.partsAt(pos) ?? null
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
