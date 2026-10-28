/**
 * `presentation/pickResult` —— **拾取结果的形状契约**。
 *
 * ## 为什么形状要与旧实现「同形」
 *
 * 旧形状定义在 `render/interaction/scenePick.ts`（旧层的**实现文件**）里 ——
 * 于是「拾取是什么」与「怎么用 legacy `blockMesh` 的 `userData.triangleMap` 解格」
 * 被绑在同一处。画面与拾取一起切到内核链后，该文件的两条假设（`triangleMap`、
 * 世界坐标由 Raycaster 直接给出）**不再成立**，文件本身要被删除。
 *
 * 但**消费方**（hover / selection / tool）需要的是一个稳定的**结果形状**，
 * 与「谁算出的它」无关。故形状搬到这里成为独立契约：
 *
 * | 字段 | 来源（内核链） | 与 legacy 的关系 |
 * |---|---|---|
 * | `column`/`row`/`zSlice`/`quadIndex` | `PickResolution.cell` | 逐字同名（结构行号口径，`row` 0 = 顶层） |
 * | `blockId` | 内核网格读面 | 与 legacy `effectiveBlockId` 同语义 |
 * | `distance`/`point` | `PresenterHit`（同一次射线） | 同口径 |
 * | `annotationId`/`annotationType` | 内核注解对象身份 | `id` = **裸** legacy id（内核对象 id 的 `annotation:` 前缀在边界剥掉） |
 *
 * ## 纯性
 *
 * 本文件只有类型与一个纯几何函数（`rayIntersectsBox`），无 IO、无 DOM、无时钟。
 * 放在 `presentation/` 的理由：它是「呈现产物如何被指认」的契约，
 * 而不是某个具体实现（`composition/` 的装配、`context/` 的查询）的私有形状。
 */

import type { Vector3 } from 'three'
import type { AnnotationShape } from '@/presentation/annotationPlan'

/** 世界坐标三元组（本层不做单位换算，值即世界空间）。 */
export interface PickVec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** 命中一个**方格**（`kind: 'block'` 分支）。 */
export interface PickBlock {
  readonly kind: 'block'
  readonly distance: number
  /** 内核调色板键（`blockRegistryKeyForPalette` 口径；侧栏高亮/tooltip/导出按它对齐）。 */
  readonly blockId: string
  /** 格坐标（结构行号：`row` 0 = 顶层，消费方经 `structureRowToWorldY` 转世界 Y）。 */
  readonly column: number
  readonly row: number
  readonly zSlice: number
  /** 被击中的 quad 在该体素内的索引。 */
  readonly quadIndex?: number
  /** 命中面的世界空间法线（已归一化）。 */
  readonly normal?: PickVec3
  /** 命中点的世界空间坐标（不重射；与 `distance` 同一次射线）。 */
  readonly point?: PickVec3
}

/** 命中一个**注解**（盒拾取 / 注解网格拾取）。 */
export interface PickAnnotation {
  readonly kind: 'annotation'
  readonly distance: number
  /** **裸** legacy 注解 id（与面板选中集、`PropertyRef.owner.id` 同一命名空间）。 */
  readonly annotationId: string
  readonly point: PickVec3
}

export type PickResult = PickBlock | PickAnnotation | null

/** 轮换拾取（`pickAll`）的**去重后**候选（block / annotation 两分支共用形状）。 */
export interface PickEntity {
  readonly kind: 'block' | 'annotation'
  readonly distance: number
  // block 分支
  readonly blockId?: string
  readonly column?: number
  readonly row?: number
  readonly zSlice?: number
  readonly quadIndex?: number
  /** 命中面法线（block 分支）。 */
  readonly normal?: PickVec3
  /** 命中点世界坐标。 */
  readonly point?: PickVec3
  // annotation 分支
  readonly annotationId?: string
  readonly annotationType?: AnnotationShape
}

/**
 * 盒拾取所需的最小注解面（**结构子集**，不是通用注解类型）。
 *
 * 与旧 `scenePick#ScenePickableBoxAnnotation` 逐字段同形：`scenePick` 只读
 * `type`/`visible`/`min`/`max`/`id`，而内核注解读面（`KernelAnnotationView`）
 * 直接满足该子集 ⇒ 两侧都能传入。
 */
export interface PickableBoxAnnotation {
  readonly id: string
  readonly type: string
  readonly visible: boolean
  readonly min?: PickVec3
  readonly max?: PickVec3
}

/** 已证明 `min`/`max` 存在的盒注解（谓词窄化后的形态）。 */
export type BoundedBoxAnnotation = PickableBoxAnnotation & {
  readonly min: PickVec3
  readonly max: PickVec3
}

/**
 * 该注解是否可参与盒拾取（结构判据）。
 *
 * ⚠️ `min`/`max` 的存在性一并判：结构子集下它们可选，少判这一步会让
 * `rayIntersectsBox` 收到 `undefined` —— 那是**运行期**崩溃而不是编译期错误。
 */
export function isPickableBox(a: PickableBoxAnnotation): a is BoundedBoxAnnotation {
  return a.type === 'box' && a.visible !== false && a.min !== undefined && a.max !== undefined
}

/**
 * 射线–AABB 相交（slab 法；返回入射距离，未命中返回 `null`）。
 *
 * 从 `render/interaction/scenePick.ts` **原样搬入**（纯函数、无状态）：
 * 盒注解即使没有网格也要能拾取（`fillOpacity: 0` 时 overlay 不产填充面），
 * 故这条通道必须独立于"注解网格是否在场"。
 */
export function rayIntersectsBox(
  rayOrigin: Vector3,
  rayDirection: Vector3,
  boxMin: PickVec3,
  boxMax: PickVec3,
): number | null {
  let tmin = -Infinity
  let tmax = Infinity

  const origins = [rayOrigin.x, rayOrigin.y, rayOrigin.z]
  const dirs = [rayDirection.x, rayDirection.y, rayDirection.z]
  const mins = [boxMin.x, boxMin.y, boxMin.z]
  const maxs = [boxMax.x, boxMax.y, boxMax.z]

  for (let i = 0; i < 3; i++) {
    if (Math.abs(dirs[i]!) < 1e-10) {
      if (origins[i]! < mins[i]! || origins[i]! > maxs[i]!) return null
    } else {
      let t1 = (mins[i]! - origins[i]!) / dirs[i]!
      let t2 = (maxs[i]! - origins[i]!) / dirs[i]!
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp }
      tmin = Math.max(tmin, t1)
      tmax = Math.min(tmax, t2)
      if (tmin > tmax) return null
    }
  }

  return tmin >= 0 ? tmin : (tmax >= 0 ? 0 : null)
}

/**
 * 注解网格名 → 注解形状（`anno-<shape>-…` 口径，与 `presentation/overlayPresenter`
 * 的命名一致）。
 *
 * 为什么形状从**名字**解析而不是 `userData`：`overlayPresenter` 的 `userData`
 * 只承身份（`objectId`），形状编码在名字里（`anno-box-…`/`anno-point-…`/…）。
 * 返回 `null` = 该名字不是注解网格（例如批次网格），调用方跳过它。
 */
export function annotationShapeOfMeshName(name: string): AnnotationShape | null {
  if (!name.startsWith('anno-')) return null
  const rest = name.slice(5)
  const firstDash = rest.indexOf('-')
  if (firstDash <= 0) return null
  return asAnnotationShape(rest.slice(0, firstDash))
}

/**
 * 字符串 → 注解形状（**窄化检查**，不是类型断言）。
 *
 * 为什么需要它：内核注解读面把 `type` 收成 `string`（`runtime/annotationRead` 的
 * 明示口径 —— 它只做字段改名，不声称认识全部形状），而呈现侧的 `AnnotationShape`
 * 是**封闭联合**。两者之间的转换必须是一次**真实检查**（否则一个拼错的形状会
 * 被静默当成合法值一路传到 GPU 规划器）。
 */
export function asAnnotationShape(value: string): AnnotationShape | null {
  return value === 'box' || value === 'point' || value === 'line' || value === 'text' || value === 'face'
    ? value
    : null
}
