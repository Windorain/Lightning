/**
 * pure/partHit.ts — 非满方块（部件）悬停命中判定的纯函数（P2.2）。
 *
 * 契约：`docs/contracts/format-parts-contract.md`
 *  - §6.1 盒坐标系 = 0–1 方块局部、Y-up，与烘焙四边形顶点同一空间
 *    （`render/mesh/structureGeometryUVs.ts`：世界坐标 = 顶点 + (col - w/2, worldY - h/2, z - d/2)）。
 *  - §6.3 盒允许越出 [0,1]³，命中判定不裁剪（如栅栏碰撞盒 maxY=1.5）。
 *  - §6.4 视觉/碰撞双盒：命中判定视觉盒优先、碰撞盒回退。
 *
 * No side effects: no Vue refs, no DOM, no I/O, no mutation of arguments.
 *
 * ── 命中规则（P2.2 拍板，留白 #7 实现细节记录）──────────────────────────
 * 1. 两趟扫描：第一趟只测各部件的 visual 盒（无 visual 盒的部件本趟跳过）；
 *    全部部件的视觉盒都无命中时，第二趟测所有部件的 collision 盒。
 *    即「视觉盒优先、碰撞盒回退」是格级整体语义，不是逐部件语义——
 *    碰撞盒通常大于视觉盒（EnderIO ×1.09、栅栏越界），若逐部件回退，
 *    大碰撞盒会遮挡邻近小部件的视觉命中。
 * 2. 多盒部件：任一同类盒命中即该部件命中（契约 §3 ③ 允许多子盒）。
 * 3. 重叠取舍：同一趟内多个部件命中（盒重叠）时，取「包含命中点的最小体积盒」
 *    所在部件（部件得分 = 其命中盒的最小体积）；体积并列时取部件列表序靠前者。
 *    规则确定性、与族无关；AE2 实测盒互不重叠，此规则是防御性兜底。
 * 4. 边界含端点，容差 PART_HIT_EPSILON（射线命中点落在盒面上的浮点抖动）。
 * ────────────────────────────────────────────────────────────────────
 */

import type { PartBox, PartBoxKind, PartRecord } from '@/pure/partTypes'
import { structureRowToWorldY } from '@/pure/vec'

/** 命中判定容差：盒边界含端点 + 浮点抖动容忍 */
export const PART_HIT_EPSILON = 1e-6

/** 格内局部坐标点（0–1 方块局部，可越界，与 PartBox 同空间） */
export interface BlockLocalPoint {
  x: number
  y: number
  z: number
}

/** 点是否在盒内（闭区间 + 容差；不裁剪越界盒，契约 §6.3） */
export function pointInPartBox(
  p: BlockLocalPoint,
  box: PartBox,
  eps: number = PART_HIT_EPSILON,
): boolean {
  return (
    p.x >= box.min[0] - eps && p.x <= box.max[0] + eps
    && p.y >= box.min[1] - eps && p.y <= box.max[1] + eps
    && p.z >= box.min[2] - eps && p.z <= box.max[2] + eps
  )
}

/** 盒体积（退化盒按 0 计，永不负数） */
export function partBoxVolume(box: PartBox): number {
  return (
    Math.max(0, box.max[0] - box.min[0])
    * Math.max(0, box.max[1] - box.min[1])
    * Math.max(0, box.max[2] - box.min[2])
  )
}

/** 单趟扫描：只测指定 kind 的盒；命中多部件时取最小命中盒体积者，并列取列表序前者。 */
function pickInPass(
  parts: readonly PartRecord[],
  local: BlockLocalPoint,
  kind: PartBoxKind,
): PartRecord | null {
  let best: PartRecord | null = null
  let bestVolume = Infinity
  for (const part of parts) {
    let partBestVolume = Infinity
    for (const box of part.boxes) {
      if (box.kind !== kind) continue
      if (!pointInPartBox(local, box)) continue
      const v = partBoxVolume(box)
      if (v < partBestVolume) partBestVolume = v
    }
    if (partBestVolume < bestVolume) {
      best = part
      bestVolume = partBestVolume
    }
  }
  return best
}

/**
 * 格内部件命中判定：输入格内局部命中点与该格 PartRecord[]，输出命中的部件。
 * 规则见文件头。无部件 / 无命中 ⇒ null（调用方回退宿主格行为）。
 */
export function pickPartAtLocalPoint(
  parts: readonly PartRecord[] | null | undefined,
  local: BlockLocalPoint,
): PartRecord | null {
  if (!parts || parts.length === 0) return null
  return pickInPass(parts, local, 'visual') ?? pickInPass(parts, local, 'collision')
}

/**
 * 世界空间命中点 → 格内局部坐标。
 * 与网格生成的世界偏移互逆（`structureGeometryUVs.ts` L31–34：
 * ox = col - sizeColumn/2, oy = worldY - sizeRow/2, oz = zSlice - sizeZSlice/2）。
 */
export function blockLocalPointFromWorldPoint(
  point: BlockLocalPoint,
  voxel: { column: number; row: number; zSlice: number },
  size: { sizeColumn: number; sizeRow: number; sizeZSlice: number },
): BlockLocalPoint {
  const worldY = structureRowToWorldY(voxel.row, size.sizeRow)
  return {
    x: point.x - (voxel.column - size.sizeColumn / 2),
    y: point.y - (worldY - size.sizeRow / 2),
    z: point.z - (voxel.zSlice - size.sizeZSlice / 2),
  }
}
