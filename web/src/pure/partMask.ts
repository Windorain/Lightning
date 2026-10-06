/**
 * pure/partMask.ts — 部件级描边 mask 的**纯几何决策**（B-1）。
 *
 * 输入：命中的格（`ScenePickBlock` 的格坐标 + 命中点已换算为格内局部坐标）、
 *       该格 `PartRecord[]`、以及该格 palette 的整体 baked quads（既有 `getBlockGeometry` 输出）。
 * 输出：喂给 `SelectionOutlinePass` 的 mask 几何决策（quads 或盒），或 null（无格几何）。
 *
 * 契约：`docs/contracts/format-parts-contract.md` §3（PartRecord.boxes）/ §6（盒坐标系 =
 * 0–1 方块局部、Y-up、允许越出 [0,1]³、视觉盒与碰撞盒成对）。
 *
 * ── 通道语义（B-1 拍板，决策留痕见 issue #34 评论）──────────────────────
 * `partLocalId === undefined` ⇒ **整格通道**：几何 = 该格 palette 全部 baked quads，
 * 与 B-1 之前逐字节一致（无部件文档、点选/框选/按类型选择的既有行为不变）。
 *
 * `partLocalId` 已给出 ⇒ **部件通道**，按以下顺序收敛：
 *  1. 该格无部件数据 / 找不到该 localId / 该部件无盒 ⇒ 回退整格通道（不劣化，不空描边）；
 *  2. 由 `boxGeometry(part)` 生成 AABB 盒 union（视觉盒优先，视觉盒全缺时用碰撞盒）——
 *     盒是导出时快照，是本渲染管线里唯一的「部件空间范围」权威；
 *  3. 盒退化（贴面/贴边，如单面部件盒）取该盒所辖 quads 的 AABB，保证 mask 可见像素
 *     与既有四边面几何一致；该盒无 quads 时退回退化盒本身。
 *
 * 为什么是盒而不是「按 quads 归属切分」（两路对比结论）：
 *  - `PartRecord.boxes` 已落盘（本体权威、零新增数据依赖），quad 归属数据本轮 B-2 才落盘，
 *    按 quads 切分只能靠启发式，会把相邻部件的贴合面切错（实证：AE2 fixture 的 +y 线缆面
 *    同时落在线缆副盒与存储总线盒内）；
 *  - `SelectionOutlinePass` 只呈现 mask 的**屏幕空间轮廓**（mask 为无光照白模 + Sobel），
 *    真正决定描边的是「mask 的投影轮廓」。盒与「落于盒内的 quads」在同一正交视角下
 *    投影轮廓一致，因此盒在视觉上等价而判定确定、与部件一一对应；
 *  - quad 归属仍是本模块的一等入口（{@link resolvePartMaskGeometry} 内 `quads` 分支 +
 *    {@link boxSourceForQuads}）：B-2 落盘 quad→部件 归属后，只需把归属表接到此处即可
 *    换成「真轮廓」，通道与调用方零改动。
 *
 * No side effects: no Vue refs, no DOM, no I/O, no mutation of arguments.
 */

import type { BakedQuad } from '@/render/schema/types'
import type { PartBox, PartRecord } from '@/pure/partTypes'
import { PART_HIT_EPSILON, partBoxVolume } from '@/pure/partHit'

export type { BakedQuad }

/** 格内局部坐标点（0–1 方块局部，可越界；与 PartBox 同空间） */
export interface MaskLocalPoint {
  x: number
  y: number
  z: number
}

/** mask 几何决策：`quads` 与 `boxes` 恰有一个非空（boxes 优先） */
export interface PartMaskGeometry {
  /** 整格/退化盒通道：直接喂这些四边面 */
  quads?: readonly BakedQuad[]
  /** 部件通道：喂这些盒的并集 */
  boxes?: readonly PartBox[]
}

/**
 * 「格 + 部件定位」→ mask 几何决策。
 *
 * @param parts      该格部件列表（`Grid.partsAt`；null/[] = 无部件）
 * @param wholeCell  该格整体 palette 几何（`getBlockGeometry`；null = 无几何）
 * @param partLocalId 目标部件 localId；undefined = 整格通道（点选/框选等既有调用方）
 */
export function resolvePartMaskGeometry(
  parts: readonly PartRecord[] | null | undefined,
  wholeCell: readonly BakedQuad[] | null | undefined,
  partLocalId?: string,
): PartMaskGeometry | null {
  const quads = wholeCell ?? []
  if (quads.length === 0) return null

  if (partLocalId === undefined) return { quads }

  const part = parts?.find(p => p.localId === partLocalId)
  if (!part) return { quads }

  const boxes = boxUnionForPart(part)
  if (boxes.length === 0) return { quads }

  // 退化盒（贴面/贴边）：盒本身投影为一条线 ⇒ 取该盒所辖 quads 的 AABB，
  // 与既有「按该部件四边面」的可见像素一致；无 quads 时保留退化盒（仍是该部件的位置）。
  const out: PartBox[] = []
  for (const box of boxes) {
    if (!isDegenerateBox(box)) {
      out.push(box)
      continue
    }
    const aabb = aabbOfQuadsWithinBox(quads, box)
    out.push(aabb ?? box)
  }
  return { boxes: out }
}

/**
 * 部件的 mask 盒 union：视觉盒优先；视觉盒全缺时用碰撞盒（与 `pure/partHit.ts` 的
 * 「视觉盒优先、碰撞盒回退」总语义一致）。盒序保持 PartRecord.boxes 原序（确定性）。
 */
export function boxUnionForPart(part: PartRecord): PartBox[] {
  const visual = part.boxes.filter(b => b.kind === 'visual')
  const chosen = visual.length > 0 ? visual : part.boxes.filter(b => b.kind === 'collision')
  return chosen.map(b => ({ min: [...b.min] as [number, number, number], max: [...b.max] as [number, number, number], kind: b.kind }))
}

/** 退化盒：任一轴无厚度（贴面/贴边盒，如单面部件的 [0.375,1,0.375]-[0.625,1,0.625]） */
export function isDegenerateBox(box: PartBox, eps: number = 1e-4): boolean {
  return (
    box.max[0] - box.min[0] <= eps
    || box.max[1] - box.min[1] <= eps
    || box.max[2] - box.min[2] <= eps
  )
}

/**
 * 指定盒所辖四边面的 AABB（含端点容差；无命中 ⇒ null）。
 * 「所辖」= 该四边面**全部顶点**落于盒内——严格归属，避免把跨越盒面的邻接面拉进来。
 */
export function aabbOfQuadsWithinBox(
  quads: readonly BakedQuad[],
  box: PartBox,
  eps: number = PART_HIT_EPSILON,
): PartBox | null {
  let minX = Infinity; let minY = Infinity; let minZ = Infinity
  let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity
  let any = false
  for (const q of quads) {
    if (!quadWithinBox(q, box, eps)) continue
    any = true
    for (const v of q.vertices) {
      if (v.x < minX) minX = v.x
      if (v.y < minY) minY = v.y
      if (v.z < minZ) minZ = v.z
      if (v.x > maxX) maxX = v.x
      if (v.y > maxY) maxY = v.y
      if (v.z > maxZ) maxZ = v.z
    }
  }
  if (!any) return null
  // 注意（#39 阶段二登记）：本行是**包络构造**（几何输入 = 上面的文件 baked quads），
  // 不是契约 §6/§12 禁止的"重算导出语义盒" —— 不读世界、不调游戏取盒 API、不参与命中/统计。
  // `scripts/parts-acceptance/check-static.mjs` 的"web 端不构造部件盒"规则用标记
  // `PartBoxMaskEnvelope` 对本行**具名豁免**（`BOX_RULE_EXEMPTIONS`），且该豁免带
  // "标记消失即判红"守卫；挪动/改写本行须同步核对那条登记。
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], kind: 'visual' } // PartBoxMaskEnvelope
}

/** 四边面是否整体落于盒内（含端点容差） */
export function quadWithinBox(quad: BakedQuad, box: PartBox, eps: number = PART_HIT_EPSILON): boolean {
  for (const v of quad.vertices) {
    if (
      v.x < box.min[0] - eps || v.x > box.max[0] + eps
      || v.y < box.min[1] - eps || v.y > box.max[1] + eps
      || v.z < box.min[2] - eps || v.z > box.max[2] + eps
    ) return false
  }
  return true
}

/**
 * 全部盒的体心（局部坐标）——诊断/断言用：同格不同部件的体心必须不同。
 * 无盒 ⇒ null。
 */
export function boxUnionCentroid(boxes: readonly PartBox[]): MaskLocalPoint | null {
  if (boxes.length === 0) return null
  let vx = 0; let vy = 0; let vz = 0; let w = 0
  for (const b of boxes) {
    const vol = Math.max(partBoxVolume(b), 1e-9)
    vx += ((b.min[0] + b.max[0]) / 2) * vol
    vy += ((b.min[1] + b.max[1]) / 2) * vol
    vz += ((b.min[2] + b.max[2]) / 2) * vol
    w += vol
  }
  return { x: vx / w, y: vy / w, z: vz / w }
}
