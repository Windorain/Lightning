/**
 * `presentation/outlinePlan` —— **描边（选中高亮）→ 呈现图元**（#289 P10d）。
 *
 * ## 本模块补什么（P10c 实测缺口）
 *
 * P10c（#286）对 `presentation/` 的实测结论：
 *
 * > `presentation/` 也没有注解、**描边**、拾取渲染（`annotationMeshProvider`、
 * > **`SelectionOutlinePass`**、`scenePick` 均零引用）。
 *
 * 描边在旧链里是 `render/postprocessing/SelectionOutlinePass` +
 * `render/mesh/selectionHighlightProvider` + `render/mesh/maskGeometryBuild`
 * 三者的组合（后者把部件盒/整格盒转成掩码几何）。内核取得**稳定元素身份**
 * （`domain/geometry` 的 `ElementRef` + `topologyVersion`）之后，呈现层需要一条
 * 从"选中了什么"到"该描哪些几何"的**纯数据**通路。
 *
 * ## 核心判据：描边**必须**带求值版本
 *
 * #249 §7 / A12 的原文判据是「**不得新描边配旧几何**」。而"新旧"只能由
 * **求值键**回答 —— 故 {@link OutlineRequest} 携带 `keyAtPick`（拾取时的求值键），
 * 而 {@link planOutline} 在它和当前键不等时返回**显式失败**而不是画一条错位的边。
 *
 * 这与 `presentation/pickingIndex#evaluateStalePick` 同一条纪律
 * （那里对"过期拾取"返回 `suspend` 判别式）—— 本模块是它在**描边**上的对偶：
 * 拾取侧判"能不能操作"，描边侧判"能不能画"。
 *
 * ## 与 `pickingIndex` 的分工
 *
 * | 模块 | 输入 | 输出 |
 * |---|---|---|
 * | `pickingIndex` | 批次命中（GPU 侧） | 对象/元素身份 + 求值版本 |
 * | 本模块 | 对象/元素身份 + 求值版本 | 描边图元（世界空间盒/掩码） |
 *
 * 两者**不重叠**：拾取回答"点到了谁"，描边回答"怎么把它画出来"。
 *
 * ## 纯度
 *
 * 不 import three、不碰 DOM、不读时钟（`presentation-purity` 闸门覆盖本文件）。
 */

import type { EvaluationKey } from './evaluationKey'
import { structurallyEqual } from './evaluationKey'
import type { ElementRef } from '@/domain/identity'

/** 选中目标的种类（与 `domain/geometry#GeometryElementKind` 同集合 + `object` 整体）。 */
export type OutlineTargetKind = 'object' | 'vertex' | 'edge' | 'face' | 'part' | 'cell'

/**
 * 一个**选中目标**（拾取/选择的产物；全部是**稳定身份**，不含批次位置）。
 *
 * ## 为什么这里不允许出现批次索引
 *
 * #249 §11 明文：「批次索引仅在其 generation 内有效，拾取必须映射回对象/元素和求值版本。
 * 重新分组、压缩或移出批次不能更改对象 ID，选择和动画轨道**不得引用批次位置**。」
 * ⇒ 本类型里**没有** `batchIndex` 字段，于是"描边引用批次位置"在类型上不可表达。
 */
export interface OutlineTarget {
  readonly objectId: string
  readonly kind: OutlineTargetKind
  /** 元素身份（`kind` 为 `vertex`/`edge`/`face` 时必需；带 `topologyVersion`）。 */
  readonly element?: ElementRef
  /** 部件局部身份（`kind === 'part'` 时必需；与 `BlockRef.partLocalId` 同源）。 */
  readonly partLocalId?: string
  /** 格坐标（`kind === 'cell'`/`'part'` 时的宿主格；Y-up 世界坐标）。 */
  readonly cell?: readonly [number, number, number]
}

/**
 * 一次描边请求（**显式**携带拾取时的求值版本；A12 的实现前提）。
 */
export interface OutlineRequest {
  readonly target: OutlineTarget
  /** 拾取/选择发生时的求值键。 */
  readonly keyAtPick: EvaluationKey
  /** 该目标的**几何来源**（对象/元素 → 几何身份与版本）。 */
  readonly geometry: Readonly<{ id: string; version: string }>
}

/**
 * 描边图元（与后端无关的纯描述）。
 *
 * 用联合而不是一个宽结构：不同目标的掩码形状不同，而"一个 face 目标带着
 * `partBoxes`"是无意义组合。
 */
export type OutlinePrimitive =
  | {
      readonly kind: 'objectBounds'
      readonly objectId: string
      readonly min: readonly [number, number, number]
      readonly max: readonly [number, number, number]
    }
  | {
      readonly kind: 'element'
      readonly objectId: string
      /** 逐元素掩码（顶点/边/面各自的世界空间点集）。 */
      readonly elementId: string
      readonly topologyVersion: number
      readonly points: readonly (readonly [number, number, number])[]
    }
  | {
      readonly kind: 'partBoxes'
      readonly objectId: string
      readonly partLocalId: string
      readonly boxes: readonly { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] }[]
    }
  | {
      readonly kind: 'cellBox'
      readonly objectId: string
      readonly cell: readonly [number, number, number]
    }

/** 描边规划的结果。 */
export interface OutlinePlan {
  readonly primitives: readonly OutlinePrimitive[]
  /** 本条目标对应的**几何版本**（供呈现侧做几何缓存键）。 */
  readonly geometry: Readonly<{ id: string; version: string }>
}

/**
 * 描边规划的**显式失败**（判别式，不是 `null`）。
 *
 * ## 为什么不是 `null`
 *
 * `null` 无法回答"为什么没画"。而这里的三种原因**处置完全不同**：
 *  - `stale-evaluation` ⇒ 暂停该操作并等下一次求值（A12）；
 *  - `stale-topology` ⇒ 元素引用已失效，必须**丢弃并提示**（`StaleReference`）；
 *  - `missing-geometry` ⇒ 该目标的几何不在本次编译里（真实缺陷，要暴露）。
 *
 * 与 `pickingIndex#StalePickVerdict` 同一手法（判别式 + 可展示的原因）。
 */
export type OutlineSkip =
  | { readonly kind: 'stale-evaluation'; readonly detail: string }
  | { readonly kind: 'stale-topology'; readonly detail: string; readonly elementId: string; readonly expected: number; readonly actual: number }
  | { readonly kind: 'missing-geometry'; readonly detail: string }
  | { readonly kind: 'incomplete-target'; readonly detail: string }

export type OutlineOutcome =
  | { readonly ok: true; readonly plan: OutlinePlan }
  | { readonly ok: false; readonly skip: OutlineSkip }

/** 描边几何的来源端口（纯数据；由装配/求值侧提供）。 */
export interface OutlineGeometrySource {
  /**
   * 取某对象的**边界盒**（世界空间）。`undefined` = 该对象无可用几何
   * ——**不得**用零盒冒充（A36「未就绪不得假装完整」）。
   */
  boundsOf(objectId: string): Readonly<{ min: readonly [number, number, number]; max: readonly [number, number, number] }> | undefined
  /**
   * 取元素的**世界空间点集**。`undefined` = 该元素在**当前拓扑**里不存在。
   *
   * 端口**不知道**拓扑版本 —— 版本判定由 {@link planOutline} 做
   * （先比版本再取元素，与 `domain/geometry#resolveVertex` 的顺序判据一致：
   * "版本不符立刻拒绝"而不是"找不到再报错"）。
   */
  elementPointsOf(objectId: string, elementId: string): readonly (readonly [number, number, number])[] | undefined
  /** 当前拓扑版本（元素引用据此判过期）。 */
  topologyVersionOf(objectId: string): number | undefined
  /** 取部件的世界空间盒（`kind === 'part'`）。 */
  partBoxesOf(objectId: string, partLocalId: string): readonly { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] }[] | undefined
}

/**
 * 规划描边（**纯函数**）。
 *
 * ## 判据顺序（**顺序本身是契约的一部分**）
 *
 *  1. **求值版本**：`structurallyEqual(request.keyAtPick, currentKey)` 不成立 ⇒ 立刻 `stale-evaluation`。
 *     这一条**必须最先**：过期画面上的元素引用即使"看起来还在"，也不得据此画边（A12）。
 *  2. **拓扑版本**：元素引用的 `topologyVersion` 与当前不符 ⇒ `stale-topology`。
 *     与 `domain/geometry#resolveVertex` 逐字同序（先比版本、再找元素）。
 *  3. **几何可用性**：端口返回 `undefined` ⇒ `missing-geometry`（不静默不画）。
 *  4. **目标完整性**：`kind` 与必需字段不符 ⇒ `incomplete-target`。
 *
 * 这个顺序让"最容易静默出错的判据"排在前面：若把 3 放在 1 前面，一个过期引用
 * 只要碰巧还有几何就会通过 —— 而那正是「新描边配旧几何」。
 */
export function planOutline(
  request: OutlineRequest,
  currentKey: EvaluationKey,
  source: OutlineGeometrySource,
): OutlineOutcome {
  const target = request.target

  // ① 求值版本（A12）
  if (!structurallyEqual(request.keyAtPick, currentKey)) {
    return {
      ok: false,
      skip: Object.freeze({
        kind: 'stale-evaluation' as const,
        detail:
          `描边请求来自文档版本 ${request.keyAtPick.documentVersion}，当前为 ${currentKey.documentVersion}` +
          `（过期画面上的几何引用不得用于描边 —— A12「不得新描边配旧几何」）`,
      }),
    }
  }

  // ② 拓扑版本（元素引用）
  if (target.kind === 'vertex' || target.kind === 'edge' || target.kind === 'face') {
    if (target.element === undefined) {
      return { ok: false, skip: Object.freeze({ kind: 'incomplete-target' as const, detail: `${target.kind} 目标缺 element 引用` }) }
    }
    const actual = source.topologyVersionOf(target.objectId)
    if (actual === undefined) {
      return { ok: false, skip: Object.freeze({ kind: 'missing-geometry' as const, detail: `对象 ${target.objectId} 无当前拓扑版本` }) }
    }
    if (target.element.topologyVersion !== actual) {
      return {
        ok: false,
        skip: Object.freeze({
          kind: 'stale-topology' as const,
          detail: `元素 ${target.element.elementId} 的拓扑版本已失效`,
          elementId: target.element.elementId,
          expected: target.element.topologyVersion,
          actual,
        }),
      }
    }
    const points = source.elementPointsOf(target.objectId, target.element.elementId)
    if (points === undefined) {
      return {
        ok: false,
        skip: Object.freeze({ kind: 'missing-geometry' as const, detail: `拓扑里找不到元素 ${target.element.elementId}` }),
      }
    }
    return {
      ok: true,
      plan: Object.freeze({
        primitives: Object.freeze([
          Object.freeze({
            kind: 'element' as const,
            objectId: target.objectId,
            elementId: target.element.elementId,
            topologyVersion: actual,
            points: Object.freeze(points.map((p) => Object.freeze(p) as readonly [number, number, number])),
          }),
        ]),
        geometry: request.geometry,
      }),
    }
  }

  if (target.kind === 'part') {
    if (target.partLocalId === undefined) {
      return { ok: false, skip: Object.freeze({ kind: 'incomplete-target' as const, detail: 'part 目标缺 partLocalId' }) }
    }
    const boxes = source.partBoxesOf(target.objectId, target.partLocalId)
    if (boxes === undefined || boxes.length === 0) {
      return {
        ok: false,
        skip: Object.freeze({ kind: 'missing-geometry' as const, detail: `对象 ${target.objectId} 无部件 ${target.partLocalId} 的盒` }),
      }
    }
    return {
      ok: true,
      plan: Object.freeze({
        primitives: Object.freeze([
          Object.freeze({
            kind: 'partBoxes' as const,
            objectId: target.objectId,
            partLocalId: target.partLocalId,
            boxes: Object.freeze(boxes.map((b) => Object.freeze({ min: b.min, max: b.max }))),
          }),
        ]),
        geometry: request.geometry,
      }),
    }
  }

  if (target.kind === 'cell') {
    if (target.cell === undefined) {
      return { ok: false, skip: Object.freeze({ kind: 'incomplete-target' as const, detail: 'cell 目标缺 cell 坐标' }) }
    }
    return {
      ok: true,
      plan: Object.freeze({
        primitives: Object.freeze([
          Object.freeze({ kind: 'cellBox' as const, objectId: target.objectId, cell: Object.freeze(target.cell) }),
        ]),
        geometry: request.geometry,
      }),
    }
  }

  // object：整对象边界盒
  const bounds = source.boundsOf(target.objectId)
  if (bounds === undefined) {
    return { ok: false, skip: Object.freeze({ kind: 'missing-geometry' as const, detail: `对象 ${target.objectId} 无可用几何边界` }) }
  }
  return {
    ok: true,
    plan: Object.freeze({
      primitives: Object.freeze([
        Object.freeze({ kind: 'objectBounds' as const, objectId: target.objectId, min: bounds.min, max: bounds.max }),
      ]),
      geometry: request.geometry,
    }),
  }
}

/**
 * 一批目标的描边规划（**逐条独立**失败）。
 *
 * ## 为什么不是"一条失败就整批失败"
 *
 * 多选描边里，一个目标过期不该让其余选中目标消失（那会让用户看到"选择突然全没了"）。
 * ⇒ 每条独立出结果，失败项进 `skipped` 并**逐条**报原因 —— 调用方可以据此
 * 只暂停受影响的那条操作（#256 的"暂停该类操作并明确状态"）。
 */
export function planOutlines(
  requests: readonly OutlineRequest[],
  currentKey: EvaluationKey,
  source: OutlineGeometrySource,
): Readonly<{ plans: readonly OutlinePlan[]; skipped: readonly OutlineSkip[] }> {
  const plans: OutlinePlan[] = []
  const skipped: OutlineSkip[] = []
  for (const r of requests) {
    const out = planOutline(r, currentKey, source)
    if (out.ok) plans.push(out.plan)
    else skipped.push(out.skip)
  }
  return Object.freeze({ plans: Object.freeze(plans), skipped: Object.freeze(skipped) })
}
