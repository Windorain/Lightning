/**
 * 呈现侧**失效面** —— 退役 #249 §15 第 5 条的执行面
 * （「手推 renderViewRevision/structEpoch/refresh 链 → **依赖图自动失效**」）。
 *
 * ## 被退役的机制，与它为什么必须整条删除
 *
 * 旧链路是：任何文档写入 ⇒ `Main.replaceDoc()` 自增 `structEpoch` ⇒ 每个 DRW 里
 * `watch(structEpochRef)` ⇒ `rebuildAll()`（清空全部 mesh 缓存 + **重新解码全部纹理** +
 * 重建资源 + 重建 mesh）。它有三个无法局部修复的缺陷：
 *
 * 1. **全量失效**：改一个注解文字与改一处几何走同一条路（G1 明确要求前者不重建方块几何）；
 * 2. **非内容版本冒充内容版本**：`structEpoch` 与内容无关地自增（`bumpEpoch()` 甚至在移动
 *    方块时被直接调用），于是机位/选择/布局变化也能触发全量重建（A11 要求机位变化
 *    方块几何重建数为 0）；
 * 3. **依赖靠调用方维护**：`annotationOperators` 必须显式传 `{ bumpStructEpoch: false }`
 *    才不至于触发全量重建 —— 这正是 §15 要删除的「调用方手动刷新、版本补丁」。
 *
 * ## 替代物：节点**自报读集**，失效由版本化输入计算
 *
 * 本模块是纯函数：输入「上一次键 + 本次键 + 上一轮摘要 + 节点声明」，输出「哪些节点必须
 * 重算、哪些可复用、哪些必须丢弃」。调用方不提供版本补丁，也没有"手动 refresh"这个 API。
 *
 * ## 为什么几何节点**不**声明 `documentVersion`
 *
 * 这是 G1 成立的关键，也是最容易做错的一处，故单独说明。
 *
 * 一个全局的"文档变了"计数**不足以**支撑局部失效 —— 注解文字改动也会推进
 * `documentVersion`，若几何节点把 `documentVersion` 列为输入，它就必然重算，
 * G1（"变一个注解文字不导致全部方块几何重建"）直接判红。
 *
 * 正确的依赖描述是节点**读什么就声明什么**：
 *
 * | 节点 | 真正读的东西 | 因此声明 |
 * |---|---|---|
 * | 几何 | 对象集合 + 每个对象的几何数据 | `collections`(成员) + `contentDigest`(读集内容) |
 * | 材质 | 内容资源版本 | `resources` |
 * | 注解 | 注解集合 + 注解内容 | `collections` + `contentDigest` |
 * | 视图投影 | 机位/局部显示 | `inputs: ['viewProjection']` |
 *
 * 于是"注解文字变了"只改注解节点的摘要 ⇒ 几何重算数 **0**；"几何数据变了"改几何节点的
 * 摘要 ⇒ 几何重算数 **1**。`documentVersion` 仍存在于 `EvaluationKey` 里（它是缓存身份的
 * 一部分，契约 §4 冻结），但**不作为任何呈现节点的失效输入** —— 这正是"非内容版本不得
 * 冒充内容变化"（#249 §15 第 5 条）在本层的字面落地。
 *
 * 诚实的边界：`contentDigest` 由调用方从其读集**机械计算**（`contentDigestOf()` 提供
 * 同族实现）。若调用方谎报摘要，失效就会漏 —— 因此该摘要的**来源**必须与被读数据同源，
 * 不能凭"我觉得没变"填写。这条约束由 `__tests__/assetState.test.ts` 的
 * "摘要必须由读集派生"用例钉住。
 */

import type { EvaluationKey } from './evaluationKey'
import { diffEvaluationKey, structuralKeyOf, viewProjectionKeyOf } from './evaluationKey'

/**
 * 失效粒度（**依赖图节点的种类**）。
 *
 * 与 #249 §11 的呈现数据结构一一对应：几何、材质、批次划分、注解、视图投影。
 * 刻意**没有**"整个场景"这一档 —— 全量失效正是被退役的机制。
 */
export type InvalidationTarget = 'geometry' | 'material' | 'batchPlan' | 'annotation' | 'viewProjection'

export const INVALIDATION_TARGETS: readonly InvalidationTarget[] = [
  'geometry',
  'material',
  'batchPlan',
  'annotation',
  'viewProjection',
]

/**
 * 动态集合依赖。
 *
 * `membersDigest` 是**成员身份集合**的摘要（不是成员内容摘要）：成员集合本身变化 ⇒
 * 摘要变化。这正是 #249 §7 明文要求的"包含集合成员变化" —— 只跟踪现存成员的实现会
 * 漏掉"新增对象"这类最常见的编辑。
 *
 * 成员**内容**变化由节点自己的 `contentDigest` 承担（两者是不同的事实，故分开）。
 */
export interface DynamicCollectionDependency {
  readonly collectionId: string
  readonly membersDigest: string
}

/**
 * 一条依赖声明（#249 §7「纯节点、显式依赖描述与版本输入」）。
 *
 * 三个通道各自对应一类"为什么该重算"：
 *  - `inputs`：求值键的维度（只列**真正读**的；列了不读的维度会产生假失效）；
 *  - `collections`：动态集合的**成员**；
 *  - `resources`：内容资源的**版本**；
 *  - `contentDigest`：节点读集**内容**的摘要（覆盖"成员没变但内容变了"）。
 */
export interface NodeDependency {
  readonly nodeId: string
  readonly target: InvalidationTarget
  readonly inputs: readonly (keyof EvaluationKey)[]
  readonly collections?: readonly DynamicCollectionDependency[]
  readonly resources?: readonly string[]
  /** 该节点读集**内容**的摘要（由 `contentDigestOf()` 从读集机械派生）。 */
  readonly contentDigest?: string
}

/** 上一轮的摘要（供下一轮比较）。 */
export interface PreviousDigests {
  /** `collectionId` → 成员身份集合摘要。 */
  readonly collections: Readonly<Record<string, string>>
  /** `nodeId` → 该节点读集内容摘要。 */
  readonly nodes: Readonly<Record<string, string>>
}

export const NO_DIGESTS: PreviousDigests = { collections: {}, nodes: {} }

/**
 * 内容摘要（FNV-1a 32bit over 稳定序列化）。
 *
 * 与 `compileScene.generationOf`、夹具哈希同族口径 —— 全仓只有一个哈希形状，证据之间可比。
 *
 * **顶层顺序无关**：入参是一个**读集**（集合），集合的枚举顺序不构成内容差异。因此本函数
 * 先按稳定序排列顶层元素；元组**内部**的顺序仍有意义（`['obj:1','geo:cube','v1']` 与
 * `['geo:cube','obj:1','v1']` 不同）。这条区分让"依赖图把同一读集按不同顺序枚举"不会
 * 产生假失效 —— 而假失效正是旧 `structEpoch` 链的病症。
 *
 * **必须**由节点读集派生（不能凭判断填写）：见文件头的诚实边界。
 */
export function contentDigestOf(values: readonly unknown[]): string {
  const sorted = values.map(stableStringify).sort()
  const s = sorted.join('\u0001')
  let hash = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `c:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/** 稳定序列化（对象键排序；**输入顺序不影响摘要**）。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value instanceof Float32Array || value instanceof Uint8Array) {
    return `bytes:${value.length}:${value[0] ?? 0}:${value[value.length - 1] ?? 0}`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

/** 计算成员身份集合的摘要（纯函数；**输入顺序不影响结果**）。 */
export function membersDigestOf(memberIds: readonly string[]): string {
  const sorted = [...memberIds].sort()
  let hash = 0x811c9dc5
  for (const id of sorted) {
    for (let i = 0; i < id.length; i++) {
      hash ^= id.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    hash ^= 0x2c // ','
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `m:${(hash >>> 0).toString(16).padStart(8, '0')}:${sorted.length}`
}

/** 单节点的失效原因（每一类对应一个可断言的事实）。 */
export type InvalidationReason =
  | 'no-input-changed'
  | 'input-changed'
  | 'collection-membership-changed'
  | 'content-changed'
  | 'resource-version-changed'

/** 单个节点的失效判定。 */
export type NodeVerdict =
  | { nodeId: string; target: InvalidationTarget; action: 'reuse'; reason: 'no-input-changed' }
  | {
      nodeId: string
      target: InvalidationTarget
      action: 'recompute'
      reason: Exclude<InvalidationReason, 'no-input-changed'>
      changedDimensions: readonly string[]
    }
  | { nodeId: string; target: InvalidationTarget; action: 'drop'; reason: 'scene-changed' }

/** 一次失效计算的完整结果（纯数据，可对账）。 */
export interface InvalidationPlan {
  readonly verdicts: readonly NodeVerdict[]
  /**
   * 按 target 聚合的重算计数 —— A11/G1 的**主读数**
   * （"方块几何重建数为 N"直接读 `recomputeCounts.geometry`）。
   */
  readonly recomputeCounts: Readonly<Record<InvalidationTarget, number>>
  /** 视图投影是否变化（**只**影响重投影；A11 要求它与几何重建无关）。 */
  readonly viewProjectionChanged: boolean
  /** 结构维度是否等价（等价 ⇒ 几何重建数必须为 0）。 */
  readonly structurallyEquivalent: boolean
  /** 本轮的摘要，供下一轮作为 `PreviousDigests` 传入。 */
  readonly digests: PreviousDigests
}

const ZERO_COUNTS: Readonly<Record<InvalidationTarget, number>> = {
  geometry: 0,
  material: 0,
  batchPlan: 0,
  annotation: 0,
  viewProjection: 0,
}

/**
 * 计算失效面。
 *
 * **不看时间、不看随机、不看全局**（#249 §2.1 纯性）：同一四元组必然得到同一计划。
 *
 * 判定顺序（每步都有明确理由）：
 *  1. `scene` 变化 ⇒ 整棵树 `drop`：节点身份的前提消失，不是"全量重建漏了口子"；
 *  2. `viewProjection` 节点**只**由投影键驱动（时间/文档变化都不影响它）；
 *  3. 其余节点按各自声明的 `inputs` / `collections` / `resources` / `contentDigest` 精确命中；
 *  4. 仅 `viewProjection` 变化 ⇒ **只有** `viewProjection` 重算，几何重建数为 0（A11）。
 */
export function computeInvalidation(
  prevKey: EvaluationKey,
  nextKey: EvaluationKey,
  nodes: readonly NodeDependency[],
  prev: PreviousDigests = NO_DIGESTS,
): InvalidationPlan {
  const changed = diffEvaluationKey(prevKey, nextKey)
  const sceneChanged = changed.includes('scene')
  const structuralEq = structuralKeyOf(prevKey) === structuralKeyOf(nextKey)
  const vpChanged = viewProjectionKeyOf(prevKey) !== viewProjectionKeyOf(nextKey)

  const verdicts: NodeVerdict[] = []
  const recomputeCounts: Record<InvalidationTarget, number> = { ...ZERO_COUNTS }

  for (const node of nodes) {
    if (sceneChanged) {
      verdicts.push({ nodeId: node.nodeId, target: node.target, action: 'drop', reason: 'scene-changed' })
      recomputeCounts[node.target] += 1
      continue
    }

    // 视图投影节点：只由投影键驱动。这是"机位变化不重建几何"的**实现落点**。
    if (node.target === 'viewProjection') {
      if (vpChanged) {
        verdicts.push({
          nodeId: node.nodeId,
          target: node.target,
          action: 'recompute',
          reason: 'input-changed',
          changedDimensions: ['viewProjection'],
        })
        recomputeCounts.viewProjection += 1
      } else {
        verdicts.push({ nodeId: node.nodeId, target: node.target, action: 'reuse', reason: 'no-input-changed' })
      }
      continue
    }

    const nodeChanged = changed.filter((d) => node.inputs.includes(d))

    // 动态集合**成员变化**（#249 §7 明文）
    const membershipChanged = (node.collections ?? []).some((c) => {
      const before = prev.collections[c.collectionId]
      return before !== undefined && before !== c.membersDigest
    })

    // 读集**内容**变化（成员没变但内容变了）
    const contentChanged =
      node.contentDigest !== undefined &&
      prev.nodes[node.nodeId] !== undefined &&
      prev.nodes[node.nodeId] !== node.contentDigest

    // 资源版本变化（**直接比较**，不先看全局维度 —— 否则"只改了一个资源的版本"这条
    // 最关键的 A11 场景会被全局判断吞掉）
    const resourceChanged = (node.resources ?? []).some(
      (id) => (prevKey.contentResourceVersions[id] ?? '') !== (nextKey.contentResourceVersions[id] ?? ''),
    )

    if (nodeChanged.length === 0 && !membershipChanged && !contentChanged && !resourceChanged) {
      verdicts.push({ nodeId: node.nodeId, target: node.target, action: 'reuse', reason: 'no-input-changed' })
      continue
    }

    const reason: Exclude<InvalidationReason, 'no-input-changed'> = resourceChanged
      ? 'resource-version-changed'
      : membershipChanged
        ? 'collection-membership-changed'
        : contentChanged
          ? 'content-changed'
          : 'input-changed'

    verdicts.push({
      nodeId: node.nodeId,
      target: node.target,
      action: 'recompute',
      reason,
      changedDimensions: nodeChanged.map(String),
    })
    recomputeCounts[node.target] += 1
  }

  return {
    verdicts,
    recomputeCounts,
    viewProjectionChanged: vpChanged,
    structurallyEquivalent: structuralEq,
    digests: digestsOf(nodes),
  }
}

/** 收集本轮摘要（供下一轮作为 `PreviousDigests` 传入）。 */
export function digestsOf(nodes: readonly NodeDependency[]): PreviousDigests {
  const collections: Record<string, string> = {}
  const nodeDigests: Record<string, string> = {}
  for (const node of nodes) {
    for (const c of node.collections ?? []) collections[c.collectionId] = c.membersDigest
    if (node.contentDigest !== undefined) nodeDigests[node.nodeId] = node.contentDigest
  }
  return { collections, nodes: nodeDigests }
}

/**
 * 呈现编译的**标准依赖集**（五个节点）。
 *
 * 这是"由依赖图自动失效"的声明面：每个节点自报读了什么。新增呈现节点时在这里补一条 ——
 * 不改任何调用方，也不需要"记得手动 refresh"。
 *
 * 注意 `geometry` / `batchPlan` 的 `inputs` **不含 `documentVersion`** —— 理由见文件头
 * 「为什么几何节点不声明 documentVersion」。
 */
export function defaultPresentationDependencies(options: {
  /** 方块几何节点读到的对象 ID 集合（用于动态集合依赖）。 */
  geometryObjectIds?: readonly string[]
  /** 几何节点读集**内容**的摘要（由几何数据机械派生）。 */
  geometryContentDigest?: string
  /** 注解节点读到的注解 ID 集合。 */
  annotationIds?: readonly string[]
  /** 注解节点读集内容的摘要（由注解数据机械派生）。 */
  annotationContentDigest?: string
  /** 材质节点读到的内容资源 ID。 */
  materialResourceIds?: readonly string[]
  /** 批次划分读集内容的摘要（由呈现参数机械派生）。 */
  batchContentDigest?: string
} = {}): readonly NodeDependency[] {
  const geoMembers = membersDigestOf(options.geometryObjectIds ?? [])
  const annoMembers = membersDigestOf(options.annotationIds ?? [])
  return [
    {
      nodeId: 'geometry/structure',
      target: 'geometry',
      // 几何只随**时间**（形变）/参数（通道装配）变化。刻意不含 documentVersion 与
      // viewProjection：前者会让注解编辑触发几何重建（G1 判红），后者会让机位变化
      // 触发几何重建（A11 判红）。
      inputs: ['time', 'parameterVersion', 'stagedTransactionVersion'],
      collections: [{ collectionId: 'structure.objects', membersDigest: geoMembers }],
      contentDigest: options.geometryContentDigest,
    },
    {
      nodeId: 'material/library',
      target: 'material',
      inputs: [],
      resources: options.materialResourceIds ?? [],
    },
    {
      nodeId: 'batch/plan',
      target: 'batchPlan',
      inputs: ['parameterVersion', 'stagedTransactionVersion'],
      collections: [{ collectionId: 'structure.objects', membersDigest: geoMembers }],
      contentDigest: options.batchContentDigest,
    },
    {
      nodeId: 'annotation/overlay',
      target: 'annotation',
      inputs: [],
      collections: [{ collectionId: 'document.annotations', membersDigest: annoMembers }],
      contentDigest: options.annotationContentDigest,
    },
    {
      nodeId: 'view/projection',
      target: 'viewProjection',
      inputs: ['viewProjection'],
    },
  ]
}

/** 从计划里取某 target 的重算数（A11/G1 断言糖）。 */
export function recomputeCount(plan: InvalidationPlan, target: InvalidationTarget): number {
  return plan.recomputeCounts[target]
}
