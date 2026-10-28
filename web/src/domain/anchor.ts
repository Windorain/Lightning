/**
 * `domain/anchor` —— **注解锚点：解析、未解析状态与重新解析**
 * （内核契约 §4.2 `StaleReference`）。
 *
 * ## 冻结语义
 *
 * 「注解可绑定**对象局部锚点**，或**显式场景坐标**；**几何元素锚点**携带元素身份与
 * 拓扑版本。目标删除后的默认行为是**保留注解并标为未解析**，呈现可使用**最后有效位置**
 * 但**明确其状态**；**不得偷偷绑定同名对象或相同坐标处的新对象**。恢复原身份后
 * 可以**重新解析**」。
 *
 * ## 本模块的三条设计决定
 *
 * ### 1. 锚点是**值**，目标身份与几何位置分开存
 *
 * 锚点存的是 `objectId` / `ElementRef`（身份），**不是**位置快照。
 * 位置是**求值结果**。这样"目标移动了，注解跟着走"是自然结果，而不是需要同步维护的
 * 第二份状态。相对地，`unresolved.lastValidWorld` 是**明确标注为历史**的缓存 ——
 * 它与"当前有效位置"在类型上是不同的字段，不可能被混用。
 *
 * ### 2. 未解析是**显式状态**，不是"位置为 null"
 *
 * 契约的同族要求（负对照）：「`null` 同时代表加载中/缺失/失败」必须判红。
 * 同理这里不用"位置是 `null`"兼表"目标被删"与"还没求值"：
 * {@link AnchorResolution} 是三态判别联合（`resolved` / `unresolved`），
 * 且 `unresolved` **必须**带结构化 `reason`。
 *
 * ### 3. 重新解析靠**身份**，不靠相似性
 *
 * {@link resolveAnchor} 只认身份相等：
 *  - 对象锚点：`scene.objects[objectId]` 存在即解析（哪怕它被移动了、改名了）；
 *  - 元素锚点：`dataId` 存在 **且** `topologyVersion` 相符 **且** 元素存在。
 *
 * "恢复原身份后可重新解析"因此是**免费**的：撤销让对象回来了，身份没变，
 * 下一次求值自然就解析上了 —— 不需要任何"记住它以前绑过谁"的注册表。
 * 而"删除后绑定同名对象"（负对照）在本实现里**不可能**发生：
 * 函数只按 `objectId` 索引，从不比较名字或坐标。
 */

import { err, invalidValue, missingTarget, ok, staleReference } from './errors'
import type { ElementRef } from './identity'
import { elementPosition, meshFromPayload, resolveElement, type GeometryElementKind } from './geometry'
import { transformPoint, worldMatrix, type Affine } from './spatial'
import { findObject, findObjectData, type Scene, type Vec3 } from './scene'

// ─────────────────────────────────────────────────────────────────────────────
// 锚点目标
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 锚点目标（**身份**，不是位置）。
 *
 * 三种形态：
 *  - `objectLocal`：对象局部锚点（随对象变换走）；
 *  - `scenePoint`：显式场景坐标（**不**随任何东西走 —— 它是绝对位置）；
 *  - `geometryElement`：几何元素锚点，携带元素身份与拓扑版本。
 */
export type AnchorTarget =
  | { readonly kind: 'objectLocal'; readonly objectId: string; readonly local: Vec3 }
  | { readonly kind: 'scenePoint'; readonly point: Vec3 }
  | {
      readonly kind: 'geometryElement'
      readonly objectId: string
      readonly dataId: string
      readonly elementKind: GeometryElementKind
      readonly element: ElementRef
    }

export function objectLocalAnchor(objectId: string, local: Vec3): AnchorTarget {
  return Object.freeze({ kind: 'objectLocal' as const, objectId, local: Object.freeze({ ...local }) })
}

export function scenePointAnchor(point: Vec3): AnchorTarget {
  return Object.freeze({ kind: 'scenePoint' as const, point: Object.freeze({ ...point }) })
}

export function geometryElementAnchor(
  objectId: string,
  dataId: string,
  elementKind: GeometryElementKind,
  element: ElementRef,
): AnchorTarget {
  return Object.freeze({ kind: 'geometryElement' as const, objectId, dataId, elementKind, element: Object.freeze({ ...element }) })
}

// ─────────────────────────────────────────────────────────────────────────────
// 解析结果（三态；**不用 null 兼表**）
// ─────────────────────────────────────────────────────────────────────────────

/** 未解析的结构化原因（**稳定码**，可供 UI 本地化与诊断关联）。 */
export type AnchorUnresolvedReason =
  | 'objectMissing'
  | 'dataMissing'
  | 'elementMissing'
  | 'topologyChanged'
  | 'notAMesh'

/**
 * 锚点解析结果。
 *
 * `unresolved` 携带 `lastValidWorld`（**最后有效位置**）：契约明确允许"呈现
 * 可使用最后有效位置"，但**必须**同时暴露状态。故它与 `resolved.world` 是不同分支的
 * 不同字段 —— 消费者想用旧位置就得先匹配 `status === 'unresolved'`，
 * 从而不可能"不知不觉地用着过期位置"。
 */
export type AnchorResolution =
  | { readonly status: 'resolved'; readonly world: Vec3; readonly from: AnchorTarget['kind'] }
  | {
      readonly status: 'unresolved'
      readonly reason: AnchorUnresolvedReason
      readonly detail: Readonly<Record<string, string | number>>
      /** 最后有效世界位置；`null` = **从未**解析成功（与"曾经解析、现在失效"不同）。 */
      readonly lastValidWorld: Vec3 | null
    }

/**
 * 解析一个锚点。
 *
 * `lastValidWorld` 由调用方（注解对象的持久字段）显式传入 —— 本函数是**纯**的，
 * 不持有"上一次求值"的隐式状态（「不依赖…可变单例」）。
 */
export function resolveAnchor(scene: Scene, anchor: AnchorTarget, lastValidWorld: Vec3 | null = null): AnchorResolution {
  if (anchor.kind === 'scenePoint') {
    // 显式场景坐标恒可解析：它不依赖任何目标
    return Object.freeze({ status: 'resolved' as const, world: anchor.point, from: 'scenePoint' as const })
  }

  const obj = findObject(scene, anchor.objectId)
  if (!obj) {
    return unresolved('objectMissing', { objectId: anchor.objectId }, lastValidWorld)
  }

  if (anchor.kind === 'objectLocal') {
    const w = worldMatrix(scene, anchor.objectId)
    if (!w.ok) {
      // 父链成环/奇异变换：**不**退回"用局部坐标当世界坐标"（那是静默失真）
      return unresolved('objectMissing', { objectId: anchor.objectId, cause: w.error.code }, lastValidWorld)
    }
    return Object.freeze({ status: 'resolved' as const, world: transformPoint(w.value, anchor.local), from: 'objectLocal' as const })
  }

  const data = findObjectData(scene, anchor.dataId)
  if (!data) return unresolved('dataMissing', { dataId: anchor.dataId, objectId: anchor.objectId }, lastValidWorld)
  const mesh = meshFromPayload(data.payload)
  if (!mesh) return unresolved('notAMesh', { dataId: anchor.dataId, objectId: anchor.objectId }, lastValidWorld)
  if (anchor.element.topologyVersion !== mesh.topology.version) {
    // 拓扑版本不符 ⇒ **显式失效**，且**不**猜配到"同名/同坐标"的元素
    return unresolved(
      'topologyChanged',
      { elementId: anchor.element.elementId, expected: anchor.element.topologyVersion, actual: mesh.topology.version },
      lastValidWorld,
    )
  }
  const el = resolveElement(mesh.topology, anchor.elementKind, anchor.element)
  if (!el.ok) return unresolved('elementMissing', { elementId: anchor.element.elementId, objectId: anchor.objectId }, lastValidWorld)

  const w = worldMatrix(scene, anchor.objectId)
  if (!w.ok) return unresolved('objectMissing', { objectId: anchor.objectId, cause: w.error.code }, lastValidWorld)
  // 元素局部位置取 `domain/geometry#elementPosition`（**单一实现点**）：
  // 顶点=自身、边=中点、面=质心。在本文件重写一份会让"锚点位置"与
  // "选择/呈现用的元素位置"在某些种类上悄悄分歧。
  const localPos = elementPosition(el.value)
  return Object.freeze({ status: 'resolved' as const, world: transformPoint(w.value, localPos), from: 'geometryElement' as const })
}

function unresolved(reason: AnchorUnresolvedReason, detail: Record<string, string | number>, lastValidWorld: Vec3 | null): AnchorResolution {
  return Object.freeze({
    status: 'unresolved' as const,
    reason,
    detail: Object.freeze({ ...detail }),
    lastValidWorld: lastValidWorld === null ? null : Object.freeze({ ...lastValidWorld }),
  })
}

/** 从解析出的元素取局部位置由 `domain/geometry#elementPosition` 提供（单一实现点）。 */

/**
 * 呈现用位置：解析成功用当前值；未解析**且**有历史值时用历史值。
 *
 * 第二个返回值显式告知"这个位置是不是历史的" —— 调用方无法在不知道状态的情况下
 * 拿到位置。这是「呈现可使用最后有效位置但**明确其状态**」的落点。
 */
export function displayPosition(res: AnchorResolution): { readonly world: Vec3 | null; readonly isStale: boolean; readonly reason: AnchorUnresolvedReason | null } {
  if (res.status === 'resolved') return { world: res.world, isStale: false, reason: null }
  return { world: res.lastValidWorld, isStale: true, reason: res.reason }
}

/**
 * 把"当前解析结果"折进下一次求值的 `lastValidWorld`。
 *
 * 纯函数：解析成功 ⇒ 记下新位置；未解析 ⇒ **保留**旧值（不因一次失败就丢掉
 * 最后有效位置 —— 那会让"删掉一个对象又撤销"期间的呈现跳回原点）。
 */
export function nextLastValidWorld(previous: Vec3 | null, res: AnchorResolution): Vec3 | null {
  return res.status === 'resolved' ? res.world : previous
}

/**
 * 锚点是否**指向**某个对象（供删除对象时收集受影响的注解）。
 *
 * 判据是身份相等 —— 于是"删了 A 之后 B 同名"不会被误认为锚点目标。
 */
export function anchorTargetsObject(anchor: AnchorTarget, objectId: string): boolean {
  if (anchor.kind === 'scenePoint') return false
  return anchor.objectId === objectId
}

/** 未使用占位：保持 `Affine` 类型可达（下游如需直接消费世界矩阵可复用）。 */
export type { Affine }
/** 未使用占位：`missingTarget`/`staleReference`/`invalidValue` 由调用方按语境复用。 */
void missingTarget
void staleReference
void invalidValue
void err
void ok
