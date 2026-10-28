/**
 * 批次划分（**纯函数**；「呈现编译生成按材质/几何兼容性、空间范围、透明顺序与
 * 变形方式划分的绘制数据」）。
 *
 * ## 为什么批次身份与对象身份必须分离（身份分离的核心）
 *
 * 契约明文：「批次索引仅在其 generation 内有效，拾取必须映射回对象/元素和求值版本。
 * 重新分组、压缩或移出批次不能更改对象 ID，选择和动画轨道不得引用批次位置」。
 *
 * 本模块因此**只**产出"哪些**图元**落在哪个批次"这一层关系，并把每个批次的成员记录为
 * **图元身份的数组**（`members`，每个成员带自己的 `primitiveKey` 与所属 `objectId`）；
 * 批次自身的序号是编译产物的一部分，只对**这一次**编译有效。负对照「把 batch index
 * 当对象 ID」在实现上表现为：拾取拿到的是 `batchIndex` 而不是 `objectId` —— 见
 * `presentation/pickingIndex.ts`，它**只**接受携带 generation 的批次引用，并把结果解回
 * `objectId`。
 *
 * ## 兼容性键（为什么是这七项）
 *
 * | 维度 | 不合并的后果 |
 * |---|---|
 * | 材质身份+版本 | 换纹理后旧批次仍绑旧材质（内容身份与版本；「版本替换」） |
 * | 混合模式 | 不透明与半透明混在一批 ⇒ 深度写/排序错误（§11「透明顺序」） |
 * | 几何身份+版本 | 相同几何才能实例化；内容变了必须换（assetIdentity.ts） |
 * | 变形方式 | 独立形变必须走独立路径（§11 明文） |
 * | 顶点色路径 | 顶点色批次与整型 tint 批次的材质设置不同（既有 `batchDescriptor` 口径） |
 * | 透明顺序键 | 同材质不同透明顺序不得互覆 |
 * | 纹理**相位** | 相位不同的材质采样到不同帧 ⇒ 合进一批只能留一个相位，"另一相位的实例画成同一帧"（同族的静默错误） |
 *
 * ## 空间范围是**有界**的，不是无条件细分
 *
 * 契约明文：「合批目标是有界的绘制/更新成本，不是整场景无条件合并」。
 * 于是空间细分受 `maxBatches` 约束：同质夹具（10,000 个同几何/同材质对象）兼容性组只有
 * 1 个 ⇒ 1 个批次 ⇒ 远低于 ≤32 的结构性门槛。只有当兼容性组**多于**预算时才横向合并。
 */

import { texturePhaseKeyOf, type EvaluatedPrimitive, type GeometryId, type MaterialDescriptor } from './evaluationKey'

/**
 * **图元身份** —— 批次成员的**单位**（「对象身份与 GPU 批次身份分离」）。
 *
 * ## 为什么批次成员的单位不是 `objectId`
 *
 * 一个内核对象在呈现侧可以展开成**多个图元**：同一座 `blockGrid` 结构的四边形按
 * `materialIndex` 分组后，每一组是一份**独立**的几何 + 材质（`render/mesh/blockMesh.ts:87`
 * 的 `materialId: String(w.materialIndex)` 就是 legacy 的同一分组）。它们**共享**同一个
 * 内核对象身份（"这一座结构"），却必须是**不同的**批次成员。
 *
 * 以 `objectId` 作成员键会让第二个图元覆盖第一个的槽位 —— 表现是 `provenance` 把两组
 * 记进同一批次而 `payloads` 是两个批次 ⇒ **拾取解不出**，且材质只剩一份（贴图整链失效）。
 *
 * ## 为什么是**派生**键而不是新增必填字段
 *
 * 它是图元**内容**的函数（对象 × 元素 × 材质 × 几何），不引入新的生产者义务，也不给旧形状
 * 留后门。派生规则只有本函数一处 —— 两处各写一遍必然漂移，而漂移的表现是"槽位对不上"，静默。
 */
export type PrimitiveKey = string

/** 图元的稳定内容键（**唯一一处**派生规则）。 */
export function primitiveKeyOf(p: EvaluatedPrimitive): PrimitiveKey {
  return [
    p.objectId,
    p.elementId ?? '-',
    `${p.material.id}@${p.material.version}`,
    // 相位进成员键：同一对象的两组图元若相位不同，成员键必须不同，否则成员表/拾取槽位对不上。
    `ph:${texturePhaseKeyOf(p.material.texturePhase)}`,
    // 不透明度进成员键：占位组与真几何组可以共享材质 id（同一张图标贴图），
    // 只有"是否降不透明"不同 ⇒ 不进键就会被判成同一图元。
    `o:${opacityKeyOf(p.material.opacity)}`,
    `${p.geometry.id}@${p.geometry.version}`,
  ].join('\u0000')
}

/** 批次成员：一个**图元**（对象身份 + 该对象内部的材质/元素分组）。 */
export interface BatchMember {
  readonly primitiveKey: PrimitiveKey
  /** 该图元所属的**对象**身份（拾取解出的就是它；跨重新分批稳定）。 */
  readonly objectId: string
}

/** 一个绘制批次（纯数据；不含 three 类型）。 */
export interface BatchPlan {
  /** 兼容性键（人类可读，用于诊断"为什么这两个对象没合批"）。 */
  readonly compatibilityKey: string
  readonly material: MaterialDescriptor
  readonly geometry: Readonly<{ id: GeometryId; version: string }>
  readonly deform: 'shared' | 'independent'
  /** 透明顺序分组键（`null` = 不透明组）。 */
  readonly transparency: number | null
  /**
   * 该批次的**图元**成员 —— **顺序稳定**（按 `primitiveKey` 升序 ⇒ 编译可复现）。
   *
   * 同一 `objectId` 可以出现多次：一个内核对象的多个材质图元各自是一个成员
   * （这正是"对象身份与批次身份分离"）。
   */
  readonly members: readonly BatchMember[]
  /**
   * 是否需要 GPU 实例化路径：
   *  - `true`：同几何 + 同变形方式 + 成员数 > 1 + **同质** ⇒ 可用 `InstancedMesh`/`BatchedMesh`；
   *  - `false`：独立形变、单成员或合并批次 ⇒ 走普通 `Mesh` 路径。
   */
  readonly instanceable: boolean
  /** 世界包围盒（空间范围；供裁剪与拾取初筛）。 */
  readonly bounds: Readonly<{ min: readonly [number, number, number]; max: readonly [number, number, number] }>
  /**
   * 成员是否**同质**（单一材质/几何）。合并批次为 `false` ⇒ 呈现层必须回退到逐成员
   * 材质/几何，不得用代表值糊过去（用代表值会把 A 对象的纹理画到 B 对象上 —— 静默错误
   * 比崩溃更糟）。
   */
  readonly homogeneous: boolean
}

/** 编译预算（**显式输入**，不读全局配置）。 */
export interface BatchBudget {
  /**
   * 绘制批次数的上界（结构性门槛 = 32）。
   *
   * 语义是**硬上界**：超出时按空间合并，而不是放任增长。它是"结构性门槛证据"的输入，
   * 不是性能承诺（性能门槛另立标定）。
   */
  readonly maxBatches: number
  /**
   * 每个兼容性组内允许的空间子分片数（默认 1 = 不细分）。
   *
   * 为什么默认不细分：细分会增加绘制数，而拾取身份已由"批次成员表"保证，不依赖空间分片。
   * 需要局部更新（单例更新）时，分片能让"只动一个实例"变成"只改一个批次的一个实例槽"，
   * 但这不是正确性前提。
   */
  readonly spatialSlices?: number
}

/** 结构性门槛：均质夹具下主色彩 pass 绘制数上限。 */
export const A18_DRAW_CALL_BUDGET = 32

export const DEFAULT_BATCH_BUDGET: BatchBudget = { maxBatches: A18_DRAW_CALL_BUDGET, spatialSlices: 1 }

/**
 * 兼容性键（稳定序列化；用于分组与诊断）。
 *
 * `tint` **必须**在键里（顶点色路径下它对结果无影响，故按 `-` 归一）。理由：本仓体素路径
 * 走顶点色（`tint` 恒白），但同 `materialId` 在非顶点色路径下按整型 tint 分批次
 * （既有 `batchMaterialCacheKey` 口径）。若 tint 不进键，两个不同 tint 的对象会被判为
 * **同质**、落进一个批次，而批次只声明**一个**材质 —— 结果是 B 对象被画成 A 的颜色。
 * 这类"静默错误比崩溃更糟"的场景由 `__tests__/batchPlan.test.ts` 的负对照钉住。
 */
/** 不透明度的键片段：缺席与 1 都表示"常规不透明"，故归一到同一个值。 */
function opacityKeyOf(opacity: number | undefined): string {
  return opacity === undefined || opacity >= 1 ? '-' : String(opacity)
}

export function compatibilityKeyOf(p: EvaluatedPrimitive): string {
  return [
    `m:${p.material.id}@${p.material.version}`,
    `b:${p.material.blend}`,
    `g:${p.geometry.id}@${p.geometry.version}`,
    `d:${p.deform}`,
    `v:${p.material.useVertexColor ? '1' : '0'}`,
    `t:${p.material.useVertexColor ? '-' : p.material.tint}`,
    `x:${p.transparency === null ? '-' : p.transparency}`,
      // 相位进兼容性键：`-` = 无相位动画，`0/1` = 显式第 0 相位 ⇒ 两者**不合批**。
    `ph:${texturePhaseKeyOf(p.material.texturePhase)}`,
    // 不透明度进兼容性键：同 id/同相位但"一个是占位幽灵、一个是真几何"不得合批
    // （合批只带一个材质 ⇒ 要么整批变幽灵，要么占位被画实）。
    `o:${opacityKeyOf(p.material.opacity)}`,
  ].join('|')
}

/**
 * 划分批次。
 *
 * **确定性**（可复现证据的前提）：输出批次按其兼容性键排序，成员按 `primitiveKey` 排序。
 * 同一输入两次调用得到**逐字节相同**的计划 —— 这是"身份稳定"与证据可对账的
 * 基础（「运行后提供期望/实际、源码 SHA、夹具哈希」）。
 */
export function planBatches(
  primitives: readonly EvaluatedPrimitive[],
  budget: BatchBudget = DEFAULT_BATCH_BUDGET,
): readonly BatchPlan[] {
  const maxBatches = Math.max(1, Math.floor(budget.maxBatches))
  const slices = Math.max(1, Math.floor(budget.spatialSlices ?? 1))

  // ── 1. 兼容性分组 ──
  const groups = new Map<string, EvaluatedPrimitive[]>()
  for (const p of primitives) {
    const key = compatibilityKeyOf(p)
    const g = groups.get(key)
    if (g === undefined) groups.set(key, [p])
    else g.push(p)
  }

  const sortedKeys = [...groups.keys()].sort()
  const out: BatchPlan[] = []

  for (const key of sortedKeys) {
    const members = groups.get(key)!
    const first = members[0]!
    // 成员序按**图元**键（不是 objectId）：同一对象的多个图元必须各有稳定槽位。
    members.sort((a, b) => primitiveKeyOf(a).localeCompare(primitiveKeyOf(b)))

    const instanceable = first.deform === 'shared' && members.length > 1

    // ── 2. 空间分片（受剩余预算约束）──
    const remainingBudget = Math.max(1, maxBatches - out.length)
    const allowedSlices = Math.max(1, Math.min(slices, remainingBudget))
    const parts = splitSpatially(members, allowedSlices)

    for (const part of parts) {
      out.push({
        compatibilityKey: key,
        material: first.material,
        geometry: first.geometry,
        deform: first.deform,
        transparency: first.transparency,
        members: part.map((p) => ({ primitiveKey: primitiveKeyOf(p), objectId: p.objectId })),
        instanceable,
        bounds: unionBounds(part),
        homogeneous: true,
      })
    }
  }

  // ── 3. 上界强制：仍超预算则合并相邻同变形方式的批次 ──
  return enforceBatchBudget(out, maxBatches)
}

/**
 * 合并策略：把**最靠后**的两个同 `deform` 批次并成一个。
 *
 * 为什么合并而不是截断：截断会丢绘制内容（静默丢对象 = 假绿）；合并只牺牲批次的同质性，
 * 渲染结果不变（每成员仍带自己的材质/几何引用 —— 见 `presentation/three` 对非同质成员的
 * 回退路径）。
 */
function enforceBatchBudget(plans: readonly BatchPlan[], maxBatches: number): readonly BatchPlan[] {
  if (plans.length <= maxBatches) return plans
  const merged = [...plans]
  let guard = merged.length * 4 + 16
  while (merged.length > maxBatches && guard-- > 0) {
    let i = merged.length - 1
    let j = i - 1
    while (j >= 0 && merged[j]!.deform !== merged[i]!.deform) j -= 1
    if (j < 0) break
    const a = merged[j]!
    const b = merged[i]!
    const combined: BatchPlan = {
      compatibilityKey: `${a.compatibilityKey}+${b.compatibilityKey}`,
      material: a.material,
      geometry: a.geometry,
      deform: a.deform,
      transparency: a.transparency,
      members: [...a.members, ...b.members].sort((x, y) =>
        x.primitiveKey.localeCompare(y.primitiveKey),
      ),
      instanceable: false,
      bounds: unionBoundsOfBounds(a.bounds, b.bounds),
      homogeneous: false,
    }
    merged.splice(i, 1)
    merged.splice(j, 1, combined)
  }
  return merged
}

/** 空间分片：按**最长轴**等分（稳定、可复现）。`slices === 1` ⇒ 原样返回。 */
function splitSpatially(
  members: readonly EvaluatedPrimitive[],
  slices: number,
): readonly (readonly EvaluatedPrimitive[])[] {
  if (slices <= 1 || members.length <= 1) return [members]
  const b = unionBounds(members)
  const extents: [number, number, number] = [
    b.max[0] - b.min[0],
    b.max[1] - b.min[1],
    b.max[2] - b.min[2],
  ]
  let axis = 0
  if (extents[1] > extents[axis]!) axis = 1
  if (extents[2] > extents[axis]!) axis = 2

  const lo = b.min[axis]!
  const span = Math.max(extents[axis]!, Number.EPSILON)
  const buckets: EvaluatedPrimitive[][] = Array.from({ length: slices }, () => [])
  for (const p of members) {
    const c = (p.bounds.min[axis]! + p.bounds.max[axis]!) / 2
    const t = Math.min(slices - 1, Math.max(0, Math.floor(((c - lo) / span) * slices)))
    buckets[t]!.push(p)
  }
  const nonEmpty = buckets.filter((x) => x.length > 0)
  return nonEmpty.length > 0 ? nonEmpty : [members]
}

function unionBounds(members: readonly EvaluatedPrimitive[]): BatchPlan['bounds'] {
  if (members.length === 0) return { min: [0, 0, 0], max: [0, 0, 0] }
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const p of members) {
    for (let i = 0; i < 3; i++) {
      if (p.bounds.min[i]! < min[i]!) min[i] = p.bounds.min[i]!
      if (p.bounds.max[i]! > max[i]!) max[i] = p.bounds.max[i]!
    }
  }
  return { min, max }
}

function unionBoundsOfBounds(a: BatchPlan['bounds'], b: BatchPlan['bounds']): BatchPlan['bounds'] {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  }
}
