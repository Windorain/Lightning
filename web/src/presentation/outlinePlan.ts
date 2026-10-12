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
      /**
       * 兜底盒的**世界空间角点**（#299 P10e）。
       *
       * 见 `planOutline` 的 cell 分支说明：由端口 `cellOriginOf` 给出，
       * 端口缺席时退回"格坐标即世界角"这一纯域约定。
       */
      readonly origin: readonly [number, number, number]
    }
  /**
   * **逐格四边形轮廓**（#299 P10e；legacy `BlockRef` 整格 quads 通道的等价物）。
   *
   * ## 为什么 `cellBox` 不够（这是 O1/O3 缺口原文）
   *
   * legacy 的整格高亮**不是**一个盒子 —— 它把该格的**烘焙四边形**（`BakedQuadsGeometry`
   * 的 quads，格内局部坐标 `0..16`）逐面构造成 mask 几何
   * （`render/mesh/selectionHighlightProvider` → `buildQuadsMaskMesh`）。
   * 于是"一个台阶方块"的高亮是台阶形状，"一根线缆"的高亮是线缆形状。
   *
   * 用 `cellBox`（1×1×1 盒）代替它会让**所有**高亮都变成一个立方体
   * —— 那是可感知的视觉回退，而不是实现细节。
   *
   * ## 为什么带 `quads` 而不是带 `assetId`
   *
   * 带 `assetId` 会要求呈现层自己按身份去查几何资产，于是"查不到时画什么"这个政策
   * 又被推给下游（每个消费者各答一次 ⇒ 必然漂移）。带**已经解析出来的四边形**使
   * "无几何"成为一个**上游**事实：端口返回 `undefined` ⇒ `missing-geometry`
   * （判别式，见 {@link OutlineSkip}），而是否画兜底盒是**一个**政策点。
   *
   * ## 坐标空间
   *
   * `quads[].vertices` 是**格内局部**坐标（与 `domain/blockGeometry#Quad` 同空间，
   * 即 legacy 的 `0..16` 单位），`origin` 是该格**世界空间**的角点
   * （`格中心 - 0.5`，与 legacy `selectionHighlightProvider.ts:61` 逐字同口径）。
   * 呈现层只需 `局部 + origin`，不需要知道网格尺寸 —— 于是这一形态对"格在世界哪里"
   * 完全解耦，与 legacy 的两段式（`buildQuadsMaskMesh(quads, corner)`）同形。
   */
  | {
      readonly kind: 'cellQuads'
      readonly objectId: string
      /** 该格的世界空间角点（`格中心 - 0.5`；legacy `corner` 同口径）。 */
      readonly origin: readonly [number, number, number]
      /** 该格的四边形（**格内局部坐标**；空数组 ⇒ 调用方不得产出本形态）。 */
      readonly quads: readonly OutlineQuad[]
    }

/**
 * 描边几何里的一份四边形（**格内局部坐标**）。
 *
 * 就地声明而**不** import `render/schema/types#BakedQuad`：`presentation/` 是新层，
 * `render/` 是它的**旧对应物**（`LAYER_DESTINATIONS.presentation.legacySources = ['render','shared']`）
 * —— 新层 import 旧层正是「新门面包旧核心」要禁的方向。
 * 形状与 `BakedQuad` 一致是**格式契约**（它是文件里真实存在的结构），不是依赖。
 */
export interface OutlineQuad {
  readonly materialIndex: number
  readonly vertices: readonly {
    readonly x: number
    readonly y: number
    readonly z: number
    readonly u: number
    readonly v: number
    readonly color?: number
  }[]
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
  /**
   * 取某格的**四边形轮廓**（`kind === 'cell'`；#299 P10e）。
   *
   * `undefined` = 该格无几何（**不是**空数组）：空数组表达的是"这一格确实没有面"
   * （在合法输入里不该出现 —— 有格的方块必然有面），而 `undefined` 表达"格表里
   * 查不到这一格 / 几何不可用"。两者对兜底政策的含义不同，见
   * {@link OutlinePolicy.cellWithoutQuads}。
   */
  cellQuadsOf?(objectId: string, cell: readonly [number, number, number]): readonly OutlineQuad[] | undefined
  /**
   * 取某格的**世界空间原点**（格角 = 该格世界中心 - 0.5；legacy 同口径）。
   *
   * `undefined` = 该格不在当前网格里 ⇒ `missing-geometry`（不静默不画）。
   * 独立于 {@link cellQuadsOf} 的理由：**原点与几何来自两个不同的面** ——
   * 原点由网格尺寸/格坐标算出（呈现侧），四边形由几何资产给出（内容侧）。
   * 合成一个方法会让"几何在但格不在"（网格换了）与"格在但几何没了"（资产丢了）
   * 不可区分，而前者该整批不画、后者该走兜底政策。
   */
  cellOriginOf?(objectId: string, cell: readonly [number, number, number]): readonly [number, number, number] | undefined
}

/**
 * **描边政策**（#299 P10e：两个待裁决项在这里成为**显式、唯一、可断言**的输入）。
 *
 * ## 为什么把待裁决项做成"政策参数"而不是就地选一个
 *
 * P10d 的 D3b 登记了两个待裁决项（O1/O3 的兜底盒政策、O2 的 A12 版本检查）。
 * 它们的共同点是：**两个分支都是可实现的**，选哪个是**视觉/行为政策**，须由 Lead 裁决
 * （#289 的裁决纪律：视觉/口径变更须独立裁决，不得由执行者顺手改）。
 *
 * ⇒ 执行者的正确动作是**让政策可表达**（两条分支都实现、都有判据、默认值 = **迁移前行为**），
 * 这样：
 *  - 裁决前：行为与迁移前**逐字节一致**（默认分支就是 legacy 行为，见各字段说明）；
 *  - 裁决后：改**一处**默认值即可切换，且切换不会漏掉任何消费者
 *    （不存在"有三个地方各判一次兜底盒"的形态）。
 *
 * 这两个字段是**仅有的**政策点。任何"顺手再放宽一点"的改动都应新增一个具名字段，
 * 而不是在 `planOutline` 里加分支 —— 政策点数量本身就是可审的。
 */
export interface OutlinePolicy {  /**
   * **待裁决项 ①**：整格目标**无四边形几何**时，画不画 1×1×1 兜底盒。
   *
   * | 取值 | 行为 | 来源 |
   * |---|---|---|
   * | `'fallback-box'`（**当前默认 = 迁移前行为**） | 产出 `cellBox`（1×1×1 盒） | legacy `selectionHighlightProvider.ts:53-57`/`:69-75` 两处兜底 |
   * | `'none'` | 产出 `missing-geometry` 判别式，不画 | 规划器原文（`outlinePlan.ts` 的"不用零盒冒充"，A36 纪律） |
   *
   * **分歧的实质**：legacy 把"这一格没几何"处理成"画个盒子意思一下"；
   * 规划器把它处理成"显式报缺"。前者用户在**无几何格**上仍看得到高亮
   * （例如几何缺失的方块），后者用户什么都看不到但有诊断。
   *
   * 默认取 legacy 的理由**不是**"legacy 对"，而是：本批的硬约束是**能力不回退**，
   * 而"高亮从有变没有"是可感知的回退。切换成 `'none'` 需要 Lead 明确裁决
   * （它会把"几何缺失"暴露成用户可见的"选中了但没高亮"）。
   */
  readonly cellWithoutQuads: 'fallback-box' | 'none'
  /**
   * **待裁决项 ②**：拾取键过期时画不画（O2，A12 求值版本检查）。
   *
   * | 取值 | 行为 | 来源 |
   * |---|---|---|
   * | `'suspend'`（**规划器现状**） | 第一步判 `stale-evaluation`，不画 | `outlinePlan.ts` 原文；A12「不得新描边配旧几何」 |
   * | `'draw'`（**legacy 现状**） | 不做版本检查，照画 | legacy `SelectionHighlightProvider` **无**版本比对 |
   *
   * **分歧的实质**：legacy **不做**版本检查 —— 这正是 A12 负对照要判红的形态
   * （过期画面上的几何引用被用于描边 ⇒ "新描边配旧几何"）。
   * 规划器更严，符合 A12 字面。
   *
   * 那"更严"为什么不直接算修正？因为它同时是**行为变更**：过期帧上，
   * legacy 画（可能错位的）边，规划器什么都不画。若过期窗口在正常操作里
   * 可达（例如拖动中每帧都在编译），"什么都不画"会表现为**高亮闪烁/短暂消失**。
   * ⇒ 需裁决的是"过期窗口的可达性与时长"，不是"哪个更符合 A12 字面"。
   *
   * 默认取 `'suspend'`（规划器现状）的理由：它是**已有的**新层行为，
   * 本批不引入新变更；且默认值一旦是 `'draw'`，"未经裁决就把 A12 判据关掉"
   * 会变成一个默认生效的事实。取现状使"裁决后才能放宽"成为结构性事实。
   */
  readonly stalePickAtOutline: 'suspend' | 'draw'
}

/**
 * 政策值的**具名别名**（供消费者在签名里引用而无需重复写联合）。
 *
 * 单独一个别名的理由：`planOutline`/`planOutlines` 的 `policy` 形参用它，
 * 于是"哪些调用点接受政策"可以靠 `grep EffectiveOutlinePolicy` 一次找全
 * —— 而写内联联合类型时，找全调用点需要读每一处签名。
 */
export type EffectiveOutlinePolicy = OutlinePolicy

/**
 * **当前基线政策** —— 两个字段各取"本批交付前的既成行为"，理由逐字段见
 * {@link OutlinePolicy} 的两条说明。
 *
 * ## 为什么不叫 "DEFAULT" 也不叫 "LEGACY"
 *
 * - 不叫 `LEGACY`：两个字段的基线**不在同一侧** —— `cellWithoutQuads` 取的是
 *   **legacy** 行为（`'fallback-box'`），`stalePickAtOutline` 取的是**新规划器**行为
 *   （`'suspend'`）。用 `LEGACY` 命名会让人以为整个对象都是 legacy 口径，
 *   从而在裁决第一个字段时**误改**第二个。
 * - 不叫 `DEFAULT`：`DEFAULT_*` 在本仓的既有用法是"性能/预算的合理缺省"
 *   （`DEFAULT_BATCH_BUDGET`）。这里不是"合理缺省"，而是"**未裁决前不许改变**"
 *   —— 名字必须让读者先想到"这是待裁决项的现状锚点"。
 *
 * 于是命名为 `BASELINE`：它是回归比对的**基准**，改动它等于改行为，
 * 必须由 Lead 裁决（见 #299 的两裁决项）。
 */
export const BASELINE_OUTLINE_POLICY: OutlinePolicy = Object.freeze({
  /** 基线 = legacy 的两处兜底盒（`selectionHighlightProvider.ts:53-57`/`:69-75`）。 */
  cellWithoutQuads: 'fallback-box',
  /** 基线 = 新规划器的第一步版本判定（`planOutline` 原文；A12 字面）。 */
  stalePickAtOutline: 'suspend',
})

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
  policy: OutlinePolicy = BASELINE_OUTLINE_POLICY,
): OutlineOutcome {
  const target = request.target

  // ① 求值版本（A12）—— 政策点 ②（O2）：'draw' 时**跳过**本判定（= legacy 行为）。
  if (policy.stalePickAtOutline === 'suspend' && !structurallyEqual(request.keyAtPick, currentKey)) {
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
    const cell = Object.freeze(target.cell)

    // 该格的世界空间原点（格角）。缺它 ⇒ 格不在当前网格里 —— 那是 missing-geometry，
    // 与"格在但几何没了"（下面那条）是两件不同的事（见 `cellOriginOf` 的说明）。
    const origin = source.cellOriginOf?.(target.objectId, cell)
    if (source.cellOriginOf !== undefined && origin === undefined) {
      return {
        ok: false,
        skip: Object.freeze({
          kind: 'missing-geometry' as const,
          detail: `对象 ${target.objectId} 的当前网格里没有格 (${cell.join(',')})`,
        }),
      }
    }

    const quads = source.cellQuadsOf?.(target.objectId, cell)

    // ── 政策点 ①（O1/O3 的兜底盒）──
    // `undefined` = 该格无几何；空数组 = "有几何记录但没有面"（合法输入下不该出现，
    // 但两者的处置在**下面**是同一条 —— 没有面就画不出轮廓，故都走政策）。
    // 分支只有这一个，所以"画不画兜底盒"在整个代码库里**只有一处**判定。
    if (quads === undefined || quads.length === 0) {
      if (policy.cellWithoutQuads === 'none') {
        return {
          ok: false,
          skip: Object.freeze({
            kind: 'missing-geometry' as const,
            detail: `对象 ${target.objectId} 的格 (${cell.join(',')}) 无四边形几何（政策 cellWithoutQuads='none'：不画兜底盒）`,
          }),
        }
      }
      // 基线（legacy 行为）：退化盒。原点可用时用**真实**格角，否则退回以格坐标为中心
      // —— 后者只在调用方没提供 `cellOriginOf` 时发生（如纯域测试），且与
      // legacy `gridCenterWorld` 的坐标空间一致（格中心 = 角 + 0.5）。
      const box = origin ?? [cell[0] - 0.5, cell[1] - 0.5, cell[2] - 0.5]
      return {
        ok: true,
        plan: Object.freeze({
          primitives: Object.freeze([
            Object.freeze({
              kind: 'cellBox' as const,
              objectId: target.objectId,
              cell,
              /**
               * 兜底盒的**角点**（世界空间）。
               *
               * 为什么显式写出来（而不是让呈现侧从 `cell` 自己算）：
               * `cell` 是**网格下标**（`row 0 = 顶部`），而盒在世界空间 —— 从下标到世界
               * 需要网格尺寸与翻转（`structureRowToWorldY`），那是适配层的知识。
               * 让呈现侧自己算会把"坐标翻转"复制到第二个地方（#249 §19.2/A26 禁的形态）。
               * 端口给了 `origin` 就用它；没给才退回"把格坐标当世界角"这一**纯域**约定。
               */
              origin: Object.freeze(box) as readonly [number, number, number],
            }),
          ]),
          geometry: request.geometry,
        }),
      }
    }

    // 有四边形 ⇒ 逐格轮廓（legacy 的整格 quads 通道）。
    // 无 origin 时退回零角（纯域调用方；呈现侧不得据此静默画错位置 —— 见上）。
    return {
      ok: true,
      plan: Object.freeze({
        primitives: Object.freeze([
          Object.freeze({
            kind: 'cellQuads' as const,
            objectId: target.objectId,
            origin: Object.freeze(origin ?? [0, 0, 0]) as readonly [number, number, number],
            quads: Object.freeze(quads.map((q) => Object.freeze({
              materialIndex: q.materialIndex,
              vertices: Object.freeze(q.vertices.map((v) => Object.freeze({ ...v }))),
            }))),
          }),
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
  policy: OutlinePolicy = BASELINE_OUTLINE_POLICY,
): Readonly<{ plans: readonly OutlinePlan[]; skipped: readonly OutlineSkip[] }> {
  const plans: OutlinePlan[] = []
  const skipped: OutlineSkip[] = []
  for (const r of requests) {
    const out = planOutline(r, currentKey, source, policy)
    if (out.ok) plans.push(out.plan)
    else skipped.push(out.skip)
  }
  return Object.freeze({ plans: Object.freeze(plans), skipped: Object.freeze(skipped) })
}
