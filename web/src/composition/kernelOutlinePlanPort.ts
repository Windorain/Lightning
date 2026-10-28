/**
 * `composition/kernelOutlinePlanPort` —— **描边规划的装配面**。
 *
 * ## 本模块补的缺口
 *
 * `presentation/outlinePlan` 的规划器（`planOutline` / `planOutlines`）与
 * `OutlineGeometrySource` 端口已经完备并有判据，但**零生产调用方**：
 * `planOutline` 只被自己的测试调用，`PresenterSession.applyOutline` 也只被测试与
 * 上下文恢复路径调用 ⇒ "描边用哪份几何"这一判定在生产上从未经过新规划器。
 *
 * 与之并存的是 `render/mesh/selectionHighlightProvider` 的 legacy 决策
 * （`getPartMaskGeometry` / 整格 quads / 1×1×1 兜底盒）—— 两套决策同时存在，
 * 而只有一套有生产入口。
 *
 * ⇒ 本模块是**那个缺失的生产实现**：把真实来源接成 `OutlineGeometrySource`，
 * 并把拾取引用编译成 `OutlineRequest`。
 *
 * ## 几何从哪来（**不新造数据**，逐口对真实来源）
 *
 * | 端口 | 来源 | 为什么是它 |
 * |---|---|---|
 * | `boundsOf` | `PresenterSession.inputsSnapshot()` 的 `EvaluatedPrimitive.bounds`（同 `objectId` 各材质组取并集） | 这是"本帧**真的编译出来**的图元"的边界，与画面对齐；另算一份就会漂移 |
 * | `topologyVersionOf` | 同一份图元的 `geometry.version` | 版本判据只能拿**同一份**几何身份 |
 * | `cellQuadsOf` | `kernelGridOf(doc, frame)` 的 `geometryOf(pos)` | 逐格几何的既有唯一读面（`context/queries#getBlockGeometry` 亦走它） |
 * | `cellOriginOf` | 同一读面的 `centerWorld(pos) - 0.5` | 与 legacy `gridCenterWorld` 的坐标空间一致（格角 = 格中心 − 0.5） |
 * | `partBoxesOf` | `pure/partMask#resolvePartMaskGeometry(partsAt, geometryOf, partLocalId)` 的 `boxes` | 部件盒归属规则**只有一处**定义；在此重算就是第二份会漂移的实现 |
 * | `elementPointsOf` | **不加**（生产没有元素引用数据） | 如实答 `undefined` ⇒ `missing-geometry`，不用假点集冒充 |
 *
 * ## 无细胞格的歧义（`partLocalId` 不足以定位到格）——**拒绝，不猜**
 *
 * `OutlineGeometrySource.partBoxesOf(objectId, partLocalId)` 的签名里**没有格**，
 * 而部件是**逐格**的（同一个 `localId` 的部件可以出现在多个格）。故本实现
 * 在网格里找该 `localId`：
 *  - **恰好一格**命中 ⇒ 返回该格的盒；
 *  - **0 格或多格** ⇒ `undefined`（歧义即拒绝）。
 *
 * 与 `runtime/gridRead#identityRefOf` 的"歧义即拒绝"同一纪律：取首条命中
 * 会让"同一个部件名在别的格也出现"变成一次**静默的错误描边位置**。
 * 单格夹具的三部件因此逐项可解析。
 *
 * ## 分层（**对旧层零值导入**）
 *
 * `composition/` 是装配根：它的"新 → 旧"**值**依赖就是"新内核为旧形状让路"的形态，
 * 是退役纪律明令要退的东西（"登记不是继续做大的许可"）。
 * ⇒ 本模块需要旧层读面时**不在 import 处取**，而是收**注入的结构化端口**：
 *
 * | 需要的能力 | 旧层实现 | 注入口 | 装配边（`runtime/host.ts`）提供 |
 * |---|---|---|---|
 * | 第 N 帧网格的**内核对象 id** | `runtime/gridRead#kernelGridObjectIdOf` | {@link KernelOutlinePlanPortDeps.gridObjectIdOf} | ✅ |
 * | 部件盒归属规则 | `pure/partMask#resolvePartMaskGeometry` | {@link KernelOutlinePlanPortDeps.resolvePartBoxes} | ✅ |
 *
 * 余下的 `runtime/gridRead` 引用只是**类型**（`KernelGridView` 的形状与它的
 * `ReturnType`），不进运行时依赖图。类型导入数在报告里与值导入**分开计**。
 */

import type { Context } from '@/runtime/context'
import type { KernelGridView, KernelGridPos } from '@/runtime/gridRead'
import type { EvaluationKey } from '@/presentation/evaluationKey'
import {
  planOutlines,
  BASELINE_OUTLINE_POLICY,
  type EffectiveOutlinePolicy,
  type OutlineGeometrySource,
  type OutlinePlan,
  type OutlinePrimitive,
  type OutlineQuad,
  type OutlineRequest,
  type OutlineSkip,
  type OutlineTarget,
} from '@/presentation/outlinePlan'

/** 一次拾取引用（**生产形状**：视口的 hover/选择都落在格 + 可选部件上）。 */
export interface OutlinePickRef {
  readonly pos: { readonly x: number; readonly y: number; readonly z: number }
  /** 部件定位（`BlockRef.partLocalId`）；缺省 = 整格目标。 */
  readonly partLocalId?: string
}

/** 一次规划的产物（**显式**报告被跳过的目标，不静默）。 */
export interface OutlinePlanOutcome {
  readonly plans: readonly OutlinePlan[]
  readonly skipped: readonly OutlineSkip[]
}

/** 描边规划端口（`runtime/drw` 消费它的**结构类型**，故那里不必 import 本模块）。 */
export interface OutlinePlanPort {
  planPicks(picks: readonly OutlinePickRef[]): OutlinePlanOutcome
}

export interface KernelOutlinePlanPortDeps {
  readonly ctx: Context
  /** 当前帧下标（与呈现/拾取同一个权威：`Context#getFrameIndex`）。 */
  readonly frameIndex: () => number
  /** 本帧**实际编译**的呈现输入（`PresenterSession#inputsSnapshot`）。 */
  readonly inputsOf: () => import('@/presentation/evaluationKey').PresentationInputs | null
  /** 当前求值键（`PresenterSession#activeKey`）。 */
  readonly currentKey: () => EvaluationKey | null
  /** 描边政策（缺省 = `BASELINE_OUTLINE_POLICY`，即不得变更的两政策点）。 */
  readonly policy?: EffectiveOutlinePolicy
  /**
   * 第 `frameIndex` 帧网格所属的**内核对象 id**（装配边注入；
   * 实现 = `runtime/gridRead#kernelGridObjectIdOf`）。
   *
   * 收**函数**而不是 import 那个函数：装配根不因"需要一个旧层读面"就长出
   * 一条新 → 旧的值边。
   */
  readonly gridObjectIdOf: (frameIndex: number) => string | null
  /**
   * 部件盒归属（装配边注入；实现 = `pure/partMask#resolvePartMaskGeometry` 的 `boxes` 面）。
   *
   * 规则**只有一处**定义（`pure/partMask`），本模块只消费它的结果：
   * `null` = 该格/该部件无盒（调用方如实转成 `missing-geometry`，不兜底）。
   */
  readonly resolvePartBoxes: (
    parts: ReturnType<KernelGridView['partsAt']>,
    wholeCell: ReturnType<KernelGridView['geometryOf']>,
    partLocalId: string,
  ) => readonly {
    readonly min: readonly [number, number, number]
    readonly max: readonly [number, number, number]
  }[] | null
}

/** 读面的世界空间格角（格中心 − 0.5；与 legacy `gridCenterWorld` 同空间）。 */
function cornerOf(grid: KernelGridView, pos: KernelGridPos): readonly [number, number, number] {
  const c = grid.centerWorld(pos)
  return [c.x - 0.5, c.y - 0.5, c.z - 0.5]
}

/** 格坐标（Y-up 世界坐标，与 `gridRead` 的键口径一致）。 */
function posOf(cell: readonly [number, number, number]): KernelGridPos {
  return { x: cell[0], y: cell[1], z: cell[2] }
}

/**
 * 生产 `OutlineGeometrySource`（见文件头的**逐口来源表**）。
 *
 * 端口每次调用都读**当前**帧与**当前**图元快照 —— 因为它服务的是一次拾取，
 * 而拾取与描边必须看到同一帧（不存在"缓存一份几何供后续帧用"的正解：
 * 那正是「新描边配旧几何」这条判据要判红的形态）。
 */
export function createKernelOutlineGeometrySource(deps: {
  readonly ctx: Context
  readonly frameIndex: () => number
  readonly inputsOf: KernelOutlinePlanPortDeps['inputsOf']
  readonly gridObjectIdOf: KernelOutlinePlanPortDeps['gridObjectIdOf']
  readonly resolvePartBoxes: KernelOutlinePlanPortDeps['resolvePartBoxes']
}): OutlineGeometrySource {
  const gridNow = (): KernelGridView | null => deps.ctx.kernelGrid(deps.frameIndex())

  /** 本帧图元（按对象 id 归组；同一 `objectId` 的多个材质组共享对象身份）。 */
  const primitivesOf = (objectId: string) => {
    const inputs = deps.inputsOf()
    if (inputs === null) return []
    return inputs.primitives.filter((p) => p.objectId === objectId)
  }

  /**
   * 在网格里找**唯一**含该 `partLocalId` 的格（见文件头的歧义处置）。
   *
   * 返回 `null` = 0 格或多格命中。
   */
  const uniqueCellOfPart = (grid: KernelGridView, partLocalId: string): KernelGridPos | null => {
    let hit: KernelGridPos | null = null
    for (const cell of grid.blocks()) {
      const parts = grid.partsAt(cell.pos)
      if (parts === null) continue
      if (!parts.some((p) => p.localId === partLocalId)) continue
      if (hit !== null) return null
      hit = cell.pos
    }
    return hit
  }

  return {
    boundsOf(objectId) {
      const prims = primitivesOf(objectId)
      if (prims.length === 0) return undefined
      const min: [number, number, number] = [Infinity, Infinity, Infinity]
      const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
      for (const p of prims) {
        for (let a = 0; a < 3; a++) {
          if (p.bounds.min[a]! < min[a]!) min[a] = p.bounds.min[a]!
          if (p.bounds.max[a]! > max[a]!) max[a] = p.bounds.max[a]!
        }
      }
      if (!Number.isFinite(min[0]) || !Number.isFinite(max[0])) return undefined
      return { min, max }
    },

    /**
     * 拓扑版本：**生产无数字版本** ⇒ 如实 `undefined`。
     *
     * `EvaluatedPrimitive.geometry.version` 是**字符串**内容身份
     * （`material:<下标>@<内容摘要>` 形态），而端口的 `topologyVersionOf`
     * 答的是 `OutlineTarget.element.topologyVersion` 的**数字**取值域。
     * 把字符串摘要哈希成一个数字会让"过了版本比对"变成一个**编造**的事实
     * —— 而哈希碰撞在这里的后果是"过期元素引用被当成当前引用"（负对照要判红的形态）。
     *
     * ⇒ 答 `undefined`（= `missing-geometry`）。这与 `elementPointsOf` 的
     * `undefined` 是**同一个缺口的两面**：生产没有元素引用的承载。
     */
    topologyVersionOf() {
      return undefined
    },

    /**
     * 元素点集：**生产无此承载** ⇒ 如实 `undefined`。
     *
     * 不做"从格几何里凑一个点集"的兜底：那会把"元素引用根本没有来源"
     * 伪装成"这个元素找不到"，而两者的处置不同（前者是缺承载，后者是过期引用）。
     */
    elementPointsOf() {
      return undefined
    },

    partBoxesOf(objectId, partLocalId) {
      const grid = gridNow()
      if (grid === null) return undefined
      const cell = uniqueCellOfPart(grid, partLocalId)
      if (cell === null) return undefined
      // 部件盒归属规则**只有一处**（`pure/partMask`，经装配边注入）：本处不改写它，
      // 只消费它的 boxes 面（`null`/空 ⇒ 如实 `missing-geometry`）。
      const boxes = deps.resolvePartBoxes(grid.partsAt(cell), grid.geometryOf(cell), partLocalId)
      if (boxes === null || boxes.length === 0) return undefined
      // `objectId` 只做身份断言：格所属的对象必须就是请求的对象（防跨对象串味）。
      const owner = deps.gridObjectIdOf(deps.frameIndex())
      if (owner !== null && owner !== objectId) return undefined
      // ⚠️ 端口契约是**世界空间**盒（`outlinePlan.ts#partBoxesOf` 的原文：
      // "取部件的**世界空间**盒"），而 `PartRecord.boxes` 是**格内局部**坐标
      // （0–1 方块局部，契约 §6.1）⇒ 必须加上该格的世界角。
      // 漏这一步的表现是"描边画在网格原点附近"而非所选格 —— 且 AABB 数值仍然
      // 自洽（e2e 的局部化断言会差一个格角），故它必须在此显式做、不留歧义。
      const corner = cornerOf(grid, cell)
      return boxes.map((b) => ({
        min: [b.min[0] + corner[0], b.min[1] + corner[1], b.min[2] + corner[2]] as const,
        max: [b.max[0] + corner[0], b.max[1] + corner[1], b.max[2] + corner[2]] as const,
      }))
    },

    cellQuadsOf(objectId, cell) {
      const grid = gridNow()
      if (grid === null) return undefined
      const owner = deps.gridObjectIdOf(deps.frameIndex())
      if (owner !== null && owner !== objectId) return undefined
      const pos = posOf(cell)
      // `at()` 为 null = 该格不在网格里 ⇒ `undefined`（**不是**空数组：
      // 空数组的含义是"有几何记录但没有面"，两者对兜底政策的含义不同）。
      if (grid.at(pos) === null) return undefined
      const quads = grid.geometryOf(pos)
      if (quads === null) return undefined
      return quads.map((q): OutlineQuad => ({
        materialIndex: q.materialIndex,
        vertices: q.vertices.map((v) => ({
          x: v.x,
          y: v.y,
          z: v.z,
          u: v.u,
          v: v.v,
          ...(v.color === undefined ? {} : { color: v.color }),
        })),
      }))
    },

    cellOriginOf(objectId, cell) {
      const grid = gridNow()
      if (grid === null) return undefined
      const owner = deps.gridObjectIdOf(deps.frameIndex())
      if (owner !== null && owner !== objectId) return undefined
      const pos = posOf(cell)
      if (grid.at(pos) === null) return undefined
      return cornerOf(grid, pos)
    },
  }
}

/**
 * 生产描边规划端口：`OutlinePickRef[]` → `planOutlines` 的产物。
 *
 * ## 目标编译（拾取引用 → `OutlineTarget`）
 *
 * | 拾取 | `kind` | 理由 |
 * |---|---|---|
 * | 有 `partLocalId` | `part` | B-1 的部件级描边（mask 收敛到部件盒） |
 * | 无 `partLocalId` | `cell` | 整格描边（legacy 的整格 quads / 兜底盒通道） |
 *
 * `objectId` 取**本帧网格所属的内核对象 id**（`kernelGridObjectIdOf`）——
 * 与 `cellQuadsOf`/`cellOriginOf` 的归属断言**同一个**来源，故不可能出现
 * "请求的对象 id 与端口断言的对象 id 不同 ⇒ 全部 missing-geometry"的静默空描边。
 *
 * ## `keyAtPick` 与 `currentKey` **是同一个值**（当前的诚实边界）
 *
 * 本端口服务的是**每帧**的 hover/选择描边（DRW 的 `update()` 内），
 * 而那一刻没有"更早的拾取键"可用 —— 拾取键由拾取链（`viewportPick`/`PickIndex`）
 * 携带，当前未把那条链的键接进来。故此处**如实**让两者相同：
 *  - 它使该判据在本路径上**恒不触发**（不是"关闭判据"，而是"没有比对的第二个值"）；
 *  - `policy.stalePickAtOutline` 因此保持基线语义不变，且**未**被放宽。
 *
 * ⇒ 这一条是**已知缺口**：把拾取键接进来（`keyAtPick ≠ currentKey`）归拾取链接线。
 * 这里不把它伪造成"已具备"。
 */
export function createKernelOutlinePlanPort(deps: KernelOutlinePlanPortDeps): OutlinePlanPort {
  const policy = deps.policy ?? BASELINE_OUTLINE_POLICY
  const source = createKernelOutlineGeometrySource({
    ctx: deps.ctx,
    frameIndex: deps.frameIndex,
    inputsOf: deps.inputsOf,
    gridObjectIdOf: deps.gridObjectIdOf,
    resolvePartBoxes: deps.resolvePartBoxes,
  })

  return {
    planPicks(picks) {
      const key = deps.currentKey()
      if (key === null) {
        // 尚未编译过任何内容 ⇒ 没有可用的求值键与图元表。
        // 如实报"无几何"（不猜、不画一条可能错位的边）。
        return {
          plans: [],
          skipped: picks.map((p) => ({
            kind: 'missing-geometry' as const,
            detail: `呈现会话尚未产出内容（无求值键）⇒ 无法为格 (${p.pos.x},${p.pos.y},${p.pos.z}) 规划描边`,
          })),
        }
      }
      const objectId = deps.gridObjectIdOf(deps.frameIndex())
      if (objectId === null) {
        return {
          plans: [],
          skipped: picks.map((p) => ({
            kind: 'missing-geometry' as const,
            detail: `当前帧没有 blockGrid 对象 ⇒ 无法为格 (${p.pos.x},${p.pos.y},${p.pos.z}) 规划描边`,
          })),
        }
      }
      const requests: OutlineRequest[] = picks.map((p) => {
        const target: OutlineTarget =
          p.partLocalId === undefined
            ? { objectId, kind: 'cell', cell: [p.pos.x, p.pos.y, p.pos.z] }
            : { objectId, kind: 'part', partLocalId: p.partLocalId }
        return {
          target,
          keyAtPick: key,
          geometry: { id: objectId, version: `frame:${deps.frameIndex()}` },
        }
      })
      const out = planOutlines(requests, key, source, policy)
      return { plans: out.plans, skipped: out.skipped }
    },
  }
}

/** 端口产物的 `primitives` 扁平化（多个计划 ⇒ 一份图元表；呈现侧只有一个描边组）。 */
export function primitivesOfPlans(plans: readonly OutlinePlan[]): readonly OutlinePrimitive[] {
  return plans.flatMap((p) => p.primitives)
}
