/**
 * `application/evaluation` —— **纯求值节点、显式依赖、失效与 `EvaluationKey`**
 * （#249 §7 §14 A11/A12；契约 §4 §5.3）。
 *
 * ## 本模块解决的问题（它替代的旧机制）
 *
 * #249 §15 第 5 条要退役的是「手推 `renderViewRevision`/`structEpoch`/`refresh` 链」。
 * 旧形态有两个可观测病灶：
 *  1. **没有依赖边**：改一个注解描述会让 `structEpoch += 1`，于是**整块几何重建**
 *     （含纹理重解码）。"只改注解却重建方块几何"正是 A11 要求必须为 0 的那个数。
 *  2. **没有缓存身份**：谁变了、该重算什么，靠调用方在每个改动点**记得**调用刷新。
 *
 * 本模块用两个机制消灭它们：
 *  - **节点粒度失效**：每个节点声明它消费的**版本化输入**（`versionInputs`）与
 *    **动态集合**（`collectionDeps`）。节点的缓存身份 = 它自己那几项版本 + 集合成员，
 *    **不是**全局 `documentVersion`。于是"改注解"只让注解节点失效。
 *  - **无刷新 API**：本模块**没有** `refresh()` / `invalidate()` / `markDirty()` 这类
 *    由调用方主动触发的入口。失效是"版本输入变了 ⇒ 缓存身份不匹配"的**计算结果**，
 *    不是一个需要被记得调用的动作。这使 A11 负对照「无调用方手动 refresh」
 *    在类型层面成立：找不到那个方法。
 *
 * ## 三条硬要求及其落点
 *
 * ### 1. 纯节点（#249 §7 明文）
 * `compute` 是纯函数：输入是 `(key, 上游结果, 版本快照)`，不看 Vue/Three/DOM/
 * 全局时钟/IO。本模块自身不 import 任何呈现或宿主设施。
 *
 * ### 2. 循环检测（#249 §7 明文「循环检测」）
 * `detectDependencyCycle` 在**声明期**判定（`validateGraph`）。
 * 除静态边之外，**动态集合依赖也参与**：集合成员可以引出新的节点消费关系，
 * 只检查静态边会让"集合成员引入环"漏网。
 *
 * ### 3. 过期结果不得覆盖新结果（#249 §7 + A12 负对照）
 * 异步结果经 `admitNodeResult` 接纳，判据是**该结果所依据的求值键**与当前键是否一致。
 * 不一致 ⇒ `admitted: false, release: true`（已获取资源必须回收）。
 *
 * ## 与契约 §4 `EvaluationKey` 的关系
 *
 * 契约 §4 冻结了键的**字段**（文档版本/场景/时间/参数版本/暂存事务版本/内容资源版本），
 * 并明确要求「摄像机/局部显示若不影响结构，只进入 `viewProjection`」。
 * 本模块把 `EvaluationKey` 分为两半（`structuralPart` / `viewProjection`）：
 * **节点缓存身份用结构半边**，视图半边只进呈现投影 —— 于是机位变化不可能让几何重算。
 * 这不是对契约的改动，而是把契约那句要求变成一条可执行的分区。
 */

import { invalidValue, unsupportedOperation, type DomainError, type Result, ok, err } from '@/domain/errors'
import { canonicalize, contentDigest } from '@/domain/identity'
import type { TimeValue } from '@/domain/animation'
import type { AssetId } from '@/domain/materials'

// ─────────────────────────────────────────────────────────────────────────────
// 契约 §4：EvaluationKey
// ─────────────────────────────────────────────────────────────────────────────

export type SceneId = string

/** 视图投影键（**只**影响机位/局部显示，不影响结构）。 */
export interface ViewProjection {
  readonly camera: string
  readonly localDisplay: string
}

/**
 * 求值缓存身份（契约 §4 逐字字段）。
 *
 * 「至少区分：文档版本、场景、时间、参数版本、暂存事务版本、内容资源版本」
 * —— 六项都在这里；`viewProjection` 是第七项，且**只在**视图半边参与。
 */
export interface EvaluationKey {
  readonly documentVersion: number
  readonly scene: SceneId
  readonly time: TimeValue
  /** 通道取值/动画参数版本。 */
  readonly parameterVersion: number
  /** 活动编辑事务的暂存版本（`EditContext.interaction` 的世代）。 */
  readonly stagedTransactionVersion?: number
  /** 内容资源版本/哈希（**按内容身份**，键是 assetId，值是版本）。 */
  readonly contentResourceVersions: Readonly<Record<AssetId, string>>
  /** 视图投影键：只影响机位/局部显示，不影响结构。 */
  readonly viewProjection?: ViewProjection
}

/** 结构半边：**不含** `viewProjection`。节点缓存身份用它。 */
export interface StructuralEvaluationKey {
  readonly documentVersion: number
  readonly scene: SceneId
  readonly time: TimeValue
  readonly parameterVersion: number
  readonly stagedTransactionVersion?: number
  readonly contentResourceVersions: Readonly<Record<AssetId, string>>
}

/**
 * 拆出结构半边。
 *
 * 这是 A11 的核心机制：`viewProjection` 被**排除**在结构身份之外，
 * 因此"只改机位 ⇒ 方块几何重建数 0"不是靠调用方自觉，而是因为机位
 * 根本没进几何节点的身份。
 */
export function structuralPart(key: EvaluationKey): StructuralEvaluationKey {
  const out: {
    documentVersion: number
    scene: SceneId
    time: TimeValue
    parameterVersion: number
    stagedTransactionVersion?: number
    contentResourceVersions: Readonly<Record<AssetId, string>>
  } = {
    documentVersion: key.documentVersion,
    scene: key.scene,
    time: key.time,
    parameterVersion: key.parameterVersion,
    contentResourceVersions: key.contentResourceVersions,
  }
  if (key.stagedTransactionVersion !== undefined) out.stagedTransactionVersion = key.stagedTransactionVersion
  return out
}

/** 两个求值键的**结构**身份是否相同（忽略机位）。 */
export function sameStructuralKey(a: EvaluationKey, b: EvaluationKey): boolean {
  return canonicalize(structuralPart(a)) === canonicalize(structuralPart(b))
}

/** 视图投影身份（呈现投影缓存用；**不**用于结构节点）。 */
export function sameViewProjection(a: EvaluationKey, b: EvaluationKey): boolean {
  return canonicalize(a.viewProjection ?? null) === canonicalize(b.viewProjection ?? null)
}

/** 键的稳定字符串（缓存与诊断的字典键）。 */
export function evaluationKeyId(key: EvaluationKey): string {
  return canonicalize(structuralPart(key))
}

/**
 * 键的**差异维度**。
 *
 * 契约 §4 的选择理由：「扁平且每项可序列化的键让"哪个维度变了"可以直接计算」。
 * 本函数就是那个"直接计算"—— 诊断（#249 §19.9「求值节点失效来源」）与
 * A11 的证据（"是版本变了还是时间变了"）都靠它。
 */
export function diffKeyDimensions(a: EvaluationKey, b: EvaluationKey): readonly string[] {
  const changed: string[] = []
  if (a.documentVersion !== b.documentVersion) changed.push('documentVersion')
  if (a.scene !== b.scene) changed.push('scene')
  if (canonicalize(a.time) !== canonicalize(b.time)) changed.push('time')
  if (a.parameterVersion !== b.parameterVersion) changed.push('parameterVersion')
  if (a.stagedTransactionVersion !== b.stagedTransactionVersion) changed.push('stagedTransactionVersion')
  if (canonicalize(a.contentResourceVersions) !== canonicalize(b.contentResourceVersions)) changed.push('contentResourceVersions')
  if (!sameViewProjection(a, b)) changed.push('viewProjection')
  return Object.freeze(changed)
}

// ─────────────────────────────────────────────────────────────────────────────
// 版本化输入（细粒度失效的来源）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 版本源标识。
 *
 * 约定（由生产者遵守，本模块不解析字符串）：
 *  - `data:<dataId>` —— 某个对象数据的**内容版本**；
 *  - `channel:<setId>/<key>` —— 某通道的参数版本；
 *  - `resources` —— 资源清单版本（整体）；
 *  - `scene` —— 场景结构版本（仅"对象增删"这类结构事实才该用它）。
 *
 * **为什么不用一个全局 `structEpoch`**：那正是旧机制的病灶 ——
 * 一个数代表"什么东西都可能变了"，于是最粗的消费者决定了重建粒度。
 */
export type VersionSourceId = string

/** 一次求值可用的版本快照（**显式输入**，不是从环境读的）。 */
export interface VersionSnapshot {
  readonly values: Readonly<Record<VersionSourceId, number>>
}

export function versionSnapshot(values: Readonly<Record<VersionSourceId, number>> = {}): VersionSnapshot {
  return Object.freeze({ values: Object.freeze({ ...values }) })
}

export function versionOf(snapshot: VersionSnapshot, id: VersionSourceId): number {
  return snapshot.values[id] ?? 0
}

// ─────────────────────────────────────────────────────────────────────────────
// 动态集合依赖
// ─────────────────────────────────────────────────────────────────────────────

export type CollectionSourceId = string

/** 集合成员快照（成员**变化**必须能被观察到，不只跟踪现存成员）。 */
export interface MemberSnapshot {
  readonly members: Readonly<Record<CollectionSourceId, readonly string[]>>
}

export function memberSnapshot(members: Readonly<Record<CollectionSourceId, readonly string[]>> = {}): MemberSnapshot {
  const out: Record<CollectionSourceId, readonly string[]> = {}
  for (const [k, v] of Object.entries(members)) out[k] = Object.freeze([...v])
  return Object.freeze({ members: Object.freeze(out) })
}

export function membersOf(snapshot: MemberSnapshot, id: CollectionSourceId): readonly string[] {
  return snapshot.members[id] ?? Object.freeze([] as string[])
}

// ─────────────────────────────────────────────────────────────────────────────
// 节点声明
// ─────────────────────────────────────────────────────────────────────────────

/** 节点所属领域（**证据分组**用：A11 要报"方块几何重建数"这个数）。 */
export type EvaluationDomain = 'geometry' | 'annotation' | 'camera' | 'channel' | 'texture' | 'picking' | 'other'

export interface EvaluationNodeDeclaration {
  readonly id: string
  readonly domain: EvaluationDomain
  /**
   * 静态依赖：上游节点 id。
   *
   * 「显式依赖声明」（#249 §7）—— 不靠"读了谁就自动记一笔"的隐式追踪，
   * 因为隐式追踪在动态分支下会漏记（`if (x) read(a) else read(b)` 只记到走的那支）。
   */
  readonly deps: readonly string[]
  /**
   * 消费的**版本化输入**。节点只在这些版本变化时失效。
   *
   * 这是"只改注解 ⇒ 方块几何重建数 0"唯一需要的机制：方块几何节点声明
   * `data:<blockDataId>`，注解节点的版本变化不在其中 ⇒ 不失效。
   */
  readonly versionInputs: readonly VersionSourceId[]
  /** 动态集合依赖（成员变化也构成失效）。 */
  readonly collectionDeps?: readonly CollectionSourceId[]
  /**
   * 依赖求值时间的节点。
   *
   * 只有真正吃时间的节点（轨道采样、纹理序列）才置 `true`。
   * 方块几何**不**置 —— 于是"播放动画"不会让几何重算（#249 §7
   * 「动画改变采样参数，不重建基础几何、不改文档版本」）。
   */
  readonly timeDependent?: boolean
  /** 纯计算。输入是不可变值；返回 `Result` 以便产出**可诊断**失败。 */
  readonly compute: (input: NodeComputeInput) => Result<unknown>
}

export interface NodeComputeInput {
  readonly nodeId: string
  readonly key: EvaluationKey
  /** 上游节点结果（按 `deps` 顺序的映射）。 */
  readonly upstream: Readonly<Record<string, unknown>>
  readonly versions: VersionSnapshot
  readonly members: MemberSnapshot
}

/** 一张求值图声明（**值**；可在装配层被反复引用）。 */
export interface EvaluationGraphDeclaration {
  readonly id: string
  readonly nodes: readonly EvaluationNodeDeclaration[]
  /** 输出节点（按消费者拉动求值的起点）。 */
  readonly outputs: readonly string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// 图校验：重复 ID、缺失依赖、循环检测
// ─────────────────────────────────────────────────────────────────────────────

export interface GraphValidation {
  readonly nodeIds: readonly string[]
  readonly order: readonly string[]
}

/**
 * 校验图声明。
 *
 * 三类拒绝（对齐 #249 §10「装配解析检测：重复 ID、循环依赖、缺失服务」在求值图上的形态）：
 *  1. **重复节点 id** ⇒ `InvalidValue`（不"后者胜出"，#249 §10「注册顺序不应产生隐藏覆盖结果」）；
 *  2. **依赖缺失** ⇒ `MissingTarget`（悬空边会让求值静默漏算）；
 *  3. **循环** ⇒ `InvalidValue`，`params.cycle` 给出环路径（可诊断）。
 */
export function validateGraph(decl: EvaluationGraphDeclaration): Result<GraphValidation> {
  const seen = new Set<string>()
  for (const n of decl.nodes) {
    if (seen.has(n.id)) return err(invalidValue({ reason: 'duplicateNodeId', node: n.id, graph: decl.id }))
    seen.add(n.id)
  }
  for (const n of decl.nodes) {
    for (const d of n.deps) {
      if (!seen.has(d)) return err({ code: 'MissingTarget', params: Object.freeze({ reason: 'dependencyMissing', node: n.id, dependency: d }) })
    }
  }
  for (const o of decl.outputs) {
    if (!seen.has(o)) return err({ code: 'MissingTarget', params: Object.freeze({ reason: 'outputMissing', output: o }) })
  }
  const cycle = detectDependencyCycle(decl)
  if (cycle !== null) {
    return err(invalidValue({ reason: 'dependencyCycle', graph: decl.id, cycle: cycle.join(' → ') }))
  }
  const order = topologicalOrder(decl)
  if (order === null) return err(invalidValue({ reason: 'dependencyCycle', graph: decl.id }))
  return ok(Object.freeze({ nodeIds: Object.freeze([...seen]), order }))
}

/**
 * 环检测（DFS 三色标记），返回首个环的路径或 `null`。
 *
 * 为什么环必须显式报错而不是"求值时栈溢出"：一个环意味着"这个值依赖它自己"，
 * 它是**声明错误**；让它表现为运行期栈溢出会把"图写错了"变成"崩了"，
 * 而 #249 §7 要求"循环检测"是设计的一部分，不是兜底。
 */
export function detectDependencyCycle(decl: EvaluationGraphDeclaration): readonly string[] | null {
  const byId = new Map(decl.nodes.map((n) => [n.id, n]))
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  for (const n of decl.nodes) color.set(n.id, WHITE)
  const stack: string[] = []

  const visit = (id: string): readonly string[] | null => {
    color.set(id, GRAY)
    stack.push(id)
    const node = byId.get(id)
    for (const d of node?.deps ?? []) {
      const c = color.get(d)
      if (c === GRAY) {
        const at = stack.indexOf(d)
        return Object.freeze([...stack.slice(at), d])
      }
      if (c === WHITE) {
        const found = visit(d)
        if (found !== null) return found
      }
    }
    stack.pop()
    color.set(id, BLACK)
    return null
  }

  for (const n of decl.nodes) {
    if (color.get(n.id) === WHITE) {
      const found = visit(n.id)
      if (found !== null) return found
    }
  }
  return null
}

/** 拓扑序（依赖在前）。有环返回 `null`。用于给出确定的求值顺序（可复现证据）。 */
export function topologicalOrder(decl: EvaluationGraphDeclaration): readonly string[] | null {
  const byId = new Map(decl.nodes.map((n) => [n.id, n]))
  const out: string[] = []
  const state = new Map<string, number>()
  const visit = (id: string): boolean => {
    const s = state.get(id) ?? 0
    if (s === 2) return true
    if (s === 1) return false // 环
    state.set(id, 1)
    for (const d of byId.get(id)?.deps ?? []) {
      if (!visit(d)) return false
    }
    state.set(id, 2)
    out.push(id)
    return true
  }
  // 按声明顺序遍历，使输出对输入顺序**稳定**（同一声明恒得同一序）。
  for (const n of decl.nodes) {
    if (!visit(n.id)) return null
  }
  return Object.freeze(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// 求值（按消费者拉动 + 缓存 + 失效传播）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 节点缓存条目。
 *
 * `identity` 是**该节点自己的**缓存身份（它消费的版本 + 集合成员 + 结构键的时间半边）。
 * 不是全局键 —— 这正是"节点粒度失效"。
 */
interface CacheEntry {
  readonly identity: string
  readonly value: unknown
}

export interface EvaluationCache {
  readonly entries: Readonly<Record<string, CacheEntry>>
}

export function emptyEvaluationCache(): EvaluationCache {
  return Object.freeze({ entries: Object.freeze({}) })
}

/**
 * 一个节点的缓存身份（可外部断言：解释"为什么这个节点重算了"）。
 *
 * ## 两条来自实测的设计决定（都由 A11 的用例抓出来，不是先验推理）
 *
 * ### 1. 身份 = **声明的东西**，不含全局粗粒度键
 *
 * 初版把 `EvaluationKey` 的粗粒度维度（`documentVersion` / `parameterVersion` /
 * `stagedTransactionVersion` / `contentResourceVersions`）折进**每个**节点的身份。
 * 那会让 A11 直接失败，而且是必然失败：
 *
 *  - 「只改注解描述」在真实文档里**会**推进 `documentVersion`（注解文本是内容）；
 *  - 于是每个节点（含方块几何）的身份都变 ⇒ 几何重算 ⇒ A11 要求为 0 的那个数 > 0。
 *
 * 更根本的问题：全局粗粒度键正是 **#249 §15 第 5 条要退役的形态**
 * （`structEpoch` / `renderViewRevision` 一类"一个数代表什么都可能变了"）。
 * 把它放进节点身份，等于让最粗的粒度决定所有节点的重建 —— 就是旧机制的复刻。
 *
 * ⇒ 节点身份只由**它自己声明**的东西构成：`versionInputs`（细粒度版本源）、
 * `collectionDeps`（集合成员）、上游身份、以及显式声明的 `timeDependent`。
 * 需要整份文档粒度的节点，可以显式声明 `scene`/`document` 这类版本源
 * （见 `sceneVersionSources`）—— 那是**显式选择粗粒度**，不是被强加。
 *
 * ### 2. 必须把**上游身份**折进来
 *
 * 初版不含上游身份。于是：`pick.index` 依赖 `geometry.block`，但它自己
 * `versionInputs: []` ⇒ 几何重算了、拾取的身份没变 ⇒ 拾取命中缓存、配旧几何。
 * 那正是 #249 §7 明文禁止的「新描边配旧几何」。
 *
 * 修法不是"让下游随便声明一个版本输入"（那要求维护一张与依赖边重复的表，
 * 漏一处就静默错），而是**让依赖边本身构成身份**：上游身份变 ⇒ 下游身份变。
 * 这让"显式依赖声明"（#249 §7）真正成为失效传播的唯一来源 ——
 * 删掉一条依赖边，那条传播就真的断了（A11 负对照「删除依赖边」判红的就是它）。
 *
 * `upstreamIdentities` 由 `pull()` 递归给出，故这里不重复遍历图。
 */
export function nodeIdentity(
  node: EvaluationNodeDeclaration,
  key: EvaluationKey,
  versions: VersionSnapshot,
  members: MemberSnapshot,
  upstreamIdentities: Readonly<Record<string, string>> = {},
): string {
  const versionValues: Record<string, number> = {}
  for (const v of [...node.versionInputs].sort()) versionValues[v] = versionOf(versions, v)
  const memberValues: Record<string, readonly string[]> = {}
  for (const c of [...(node.collectionDeps ?? [])].sort()) memberValues[c] = [...membersOf(members, c)].sort()
  // 上游身份按 `deps` 声明顺序取（声明顺序是图的一部分，不是偶然的遍历顺序）。
  const upstream: Record<string, string> = {}
  for (const d of node.deps) upstream[d] = upstreamIdentities[d] ?? ''
  // 时间**只在**声明 timeDependent 时进入身份 —— 否则播放动画会让几何节点失效
  // （#249 §7「动画改变采样参数，不重建基础几何」）。
  const timePart = node.timeDependent === true ? key.time : null
  return canonicalize({ versionValues, memberValues, upstream, time: timePart })
}

/**
 * 把 `EvaluationKey` 的粗粒度维度翻译成**可选**的版本源。
 *
 * 用途有两个：
 *  1. 让"需要整份文档粒度"的节点（例如文档级摘要、导出预检）能**显式**声明它；
 *  2. 让"用粗粒度冒充内容变化"成为一个**可构造**的形态 ——
 *     A11 的负对照正是拿它把方块几何节点喂成旧机制的样子（`scene`/`document`），
 *     从而证明"改注解 ⇒ 几何重建数 0"不是空转。
 *
 * 注意 `viewProjection` **不**在这里出现：机位不是版本源，节点无法声明依赖它，
 * 因此机位变化在类型层面就不能使任何结构节点失效（契约 §4 明文）。
 */
export function sceneVersionSources(key: EvaluationKey): Readonly<Record<VersionSourceId, number>> {
  const out: Record<VersionSourceId, number> = {
    document: key.documentVersion,
    scene: key.scene === '' ? 0 : 1,
    parameters: key.parameterVersion,
    staged: key.stagedTransactionVersion ?? 0,
  }
  // 资源清单：按内容版本摘要（同一批 assetId+版本 ⇒ 同一个数）。
  out.resources = contentDigest(canonicalize(key.contentResourceVersions))
  return Object.freeze(out)
}

export interface EvaluationStats {
  /** 求值过的节点数（无论是否命中缓存）。 */
  readonly visited: number
  /** 真正执行了 `compute` 的节点数。 */
  readonly recomputed: number
  /** 命中缓存的节点数。 */
  readonly cacheHits: number
  /**
   * 按领域分组的重算数 —— **A11 的证据面**。
   * 「只改注解描述、机位时方块几何重建数为 0」就是断言 `recomputedByDomain.geometry === 0`。
   */
  readonly recomputedByDomain: Readonly<Record<string, number>>
  /** 本次重算过的节点 id（可逐项对账）。 */
  readonly recomputedNodes: readonly string[]
}

export interface EvaluationResult {
  readonly key: EvaluationKey
  /** 输出节点的结果。 */
  readonly outputs: Readonly<Record<string, unknown>>
  /** 全部求值过的节点结果（供拾取/来源映射对应**同一次**求值，#249 §7）。 */
  readonly all: Readonly<Record<string, unknown>>
  /** 各节点本轮的身份（异步发起与接纳判据的唯一来源）。 */
  readonly identities: Readonly<Record<string, string>>
  readonly cache: EvaluationCache
  readonly stats: EvaluationStats
}

/**
 * 求值一张图（**纯**）。
 *
 * 「按消费者需要求值」（#249 §7）：只求 `outputs` 及其传递依赖，**不**全量跑一遍。
 * 这不是优化，而是语义要求的一部分 —— 全量求值会让"改注解也让几何节点参与求值"
 * 变得不可区分（除非再看缓存命中数，而那已经是第二个判据了）。
 *
 * 失败传播：任一节点返回 `Err` ⇒ 整个求值返回该错误（带 `node` 定位）。
 * **不**"跳过失败节点继续"：那会让消费者拿到部分结果却以为完整。
 */
export function evaluateGraph(
  decl: EvaluationGraphDeclaration,
  key: EvaluationKey,
  versions: VersionSnapshot,
  members: MemberSnapshot,
  cache: EvaluationCache = emptyEvaluationCache(),
): Result<EvaluationResult> {
  const byId = new Map(decl.nodes.map((n) => [n.id, n]))
  const nextEntries: Record<string, CacheEntry> = { ...cache.entries }
  const all: Record<string, unknown> = {}
  const outputs: Record<string, unknown> = {}
  const identities: Record<string, string> = {}
  const recomputedNodes: string[] = []
  const recomputedByDomain: Record<string, number> = {}
  let visited = 0
  let recomputed = 0
  let cacheHits = 0

  /** 拉动式求值：按需算上游。 */
  const pull = (id: string): Result<unknown> => {
    if (Object.prototype.hasOwnProperty.call(all, id)) return ok(all[id])
    const node = byId.get(id)
    if (!node) return err({ code: 'MissingTarget', params: Object.freeze({ reason: 'nodeMissing', node: id }) })
    visited += 1

    const upstream: Record<string, unknown> = {}
    const upstreamIdentities: Record<string, string> = {}
    for (const d of node.deps) {
      const r = pull(d)
      if (!r.ok) return r
      upstream[d] = r.value
      upstreamIdentities[d] = identities[d] ?? ''
    }

    const identity = nodeIdentity(node, key, versions, members, upstreamIdentities)
    identities[id] = identity
    const cached = nextEntries[id]
    if (cached !== undefined && cached.identity === identity) {
      cacheHits += 1
      all[id] = cached.value
      return ok(cached.value)
    }

    const computed = node.compute({ nodeId: id, key, upstream, versions, members })
    if (!computed.ok) {
      // 失败带上节点定位（#249 §19.9 结构化诊断），但**不改**原错误码。
      return err({ ...computed.error, params: Object.freeze({ ...computed.error.params, node: id }) })
    }
    recomputed += 1
    recomputedNodes.push(id)
    recomputedByDomain[node.domain] = (recomputedByDomain[node.domain] ?? 0) + 1
    const frozen = freezeDeep(computed.value)
    nextEntries[id] = Object.freeze({ identity, value: frozen })
    all[id] = frozen
    return ok(frozen)
  }

  for (const o of decl.outputs) {
    const r = pull(o)
    if (!r.ok) return err(r.error)
    outputs[o] = r.value
  }

  return ok(
    Object.freeze({
      key,
      outputs: Object.freeze(outputs),
      all: Object.freeze(all),
      // 各节点本轮的身份：接线层据此发起异步请求并判别过期（`admitNodeResult`）。
      // 放在产物里（而不是让接线层自己重算）是为了让"依据什么发起"与
      // "依据什么接纳"必然是**同一个**计算，不会两边漂移。
      identities: Object.freeze(identities),
      cache: Object.freeze({ entries: Object.freeze(nextEntries) }),
      stats: Object.freeze({
        visited,
        recomputed,
        cacheHits,
        recomputedByDomain: Object.freeze(recomputedByDomain),
        recomputedNodes: Object.freeze(recomputedNodes),
      }),
    }),
  )
}

/** 深度冻结（防止消费者就地改求值产物；产物是**值**）。 */
function freezeDeep<T>(v: T): T {
  if (v === null || typeof v !== 'object' || Object.isFrozen(v)) return v
  Object.freeze(v)
  for (const k of Object.keys(v as object)) freezeDeep((v as Record<string, unknown>)[k])
  return v
}

// ─────────────────────────────────────────────────────────────────────────────
// 异步节点结果接纳（A12 负对照「无版本检查接纳旧结果」）
// ─────────────────────────────────────────────────────────────────────────────

/** 一次异步求值的发起记录（携带**它依据的**求值键身份）。 */
export interface AsyncNodeRequest {
  readonly nodeId: string
  /** 发起时该节点的缓存身份（`nodeIdentity` 的结果）。 */
  readonly identity: string
  /** 发起时的绑定代数（用于文档关闭/重绑后识别过期）。 */
  readonly bindingGeneration: number
  readonly correlationId: string
}

export interface AdmitNodeDecision {
  readonly admitted: boolean
  /** 未接纳 ⇒ 其结果携带的资源必须回收（#249 §7「已获取资源必须回收」）。 */
  readonly release: boolean
  readonly reason: 'current' | 'staleIdentity' | 'staleBinding' | 'nodeUnknown' | 'cancelled'
}

/**
 * 接纳一个异步节点结果（**纯**）。
 *
 * 三条判据（缺一即 A12 负对照）：
 *  1. 节点仍在声明里（否则 `nodeUnknown`）；
 *  2. **身份相符** —— 结果依据的身份与当前身份一致。身份里含版本输入、集合成员
 *     与结构键，故"旧慢求值后于新求值返回"必然不匹配（#249 §7 明文）；
 *  3. **绑定代数相符** —— 文档已关闭/重绑则结果过期（契约 §6.1）。
 *
 * 过期一律 `release: true`：把"要回收"做成返回值，让"忘了 dispose"在类型上显形。
 * 与 `runtime/effects` 的 `admitCompletion` 是同一政策的求值面实现
 * （那边管作业，这边管求值节点）—— 两者判据同源，避免两套"过期"定义。
 */
export function admitNodeResult(
  decl: EvaluationGraphDeclaration,
  request: AsyncNodeRequest,
  current: {
    readonly identity: string
    readonly bindingGeneration: number
    readonly cancelled?: boolean
  },
): AdmitNodeDecision {
  if (!decl.nodes.some((n) => n.id === request.nodeId)) {
    return Object.freeze({ admitted: false, release: true, reason: 'nodeUnknown' })
  }
  if (current.cancelled === true) {
    return Object.freeze({ admitted: false, release: true, reason: 'cancelled' })
  }
  if (request.bindingGeneration !== current.bindingGeneration) {
    return Object.freeze({ admitted: false, release: true, reason: 'staleBinding' })
  }
  if (request.identity !== current.identity) {
    return Object.freeze({ admitted: false, release: true, reason: 'staleIdentity' })
  }
  return Object.freeze({ admitted: true, release: false, reason: 'current' })
}

// ─────────────────────────────────────────────────────────────────────────────
// 契约 §5.3：evaluateScene
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 求值源的只读视图。
 *
 * 契约 §5.3 的 `evaluateScene(source, context)` 需要"能看到什么"显式化。
 * 注意它**不是** `Document`：`#249` §15 第 2 条要退役的正是
 * 「`RuntimeDocument` 兼任文件、编辑、求值产物」。
 * ⇒ 本类型只含求值所需事实（场景、动画、通道、序列、资源版本），
 * **没有** raw JSON、没有 `serialize()`、没有文件格式字段。
 */
export interface SceneReadView {
  readonly sceneId: SceneId
  readonly documentVersion: number
  readonly time: TimeValue
  readonly parameterVersion: number
  readonly stagedTransactionVersion?: number
  readonly contentResourceVersions: Readonly<Record<AssetId, string>>
  readonly viewProjection?: ViewProjection
  /** 求值图（由装配层提供；本批由 `defaultSceneGraph` 给出）。 */
  readonly graph: EvaluationGraphDeclaration
  readonly versions: VersionSnapshot
  readonly members: MemberSnapshot
}

export interface EvaluationContext {
  readonly bindingGeneration: number
  /** 复用的缓存（跨次求值结构性复用）。 */
  readonly cache?: EvaluationCache
  /** 已取消的节点（取消是协议：其结果不接纳）。 */
  readonly cancelledNodes?: readonly string[]
}

/**
 * 求值产物（与 `Document` **分离**的求值场景）。
 *
 * `sources` 是**来源映射**（求值产物 → 文档对象 id），供拾取对应同一次求值
 * （#249 §7「几何、拾取和对象来源映射必须对应同次求值；不得新描边配旧几何」）。
 */
export interface EvaluatedScene {
  readonly sceneId: SceneId
  readonly key: EvaluationKey
  readonly objects: readonly EvaluatedObject[]
  readonly sources: Readonly<Record<string, string>>
  readonly stats: EvaluationStats
  /**
   * 各节点本轮的身份。
   *
   * 它是接线层发起异步请求的依据（`runtime/evaluation` 的 `PendingEvaluationRequest.identity`
   * 就是从这里取的），也是接纳判定的比对对象。放在产物里（而不是让接线层自己重算）
   * 使"依据什么发起"与"依据什么接纳"必然是**同一个**计算 —— 两边各算一次会漂移。
   */
  readonly identities: Readonly<Record<string, string>>
  /**
   * 本轮求值后的缓存。
   *
   * 它出现在求值产物里是**接线需要**，不是消费者契约：`evaluateScene` 是**纯**函数，
   * 它不能把缓存"存在某处"（那就是可变单例），只能**返回**它，由接线层
   * （`runtime/evaluation`）在下一轮原样传回 `context.cache`。
   * 消费者（呈现/拾取）不得依赖该字段 —— 它们要的是 `objects` / `sources`。
   */
  readonly cache: EvaluationCache
}

export interface EvaluatedObject {
  readonly objectId: string
  readonly domain: EvaluationDomain
  readonly payload: unknown
}

/**
 * 求值一个场景（契约 §5.3 的冻结签名落实）。
 *
 * 注意本函数**不**读 `Date.now()`、**不**看 DOM、**不**接收"上一帧过了多久"：
 * 时间是 `source.time`，版本是 `source.versions`，缓存是 `context.cache`。
 * 因此"同一输入 ⇒ 同一结果"（A09/A27「同时间同结果」）是结构性质。
 */
export function evaluateScene(source: SceneReadView, context: EvaluationContext): Result<EvaluatedScene> {
  const key: EvaluationKey = Object.freeze({
    documentVersion: source.documentVersion,
    scene: source.sceneId,
    time: source.time,
    parameterVersion: source.parameterVersion,
    ...(source.stagedTransactionVersion === undefined ? {} : { stagedTransactionVersion: source.stagedTransactionVersion }),
    contentResourceVersions: source.contentResourceVersions,
    ...(source.viewProjection === undefined ? {} : { viewProjection: source.viewProjection }),
  })

  const evaluated = evaluateGraph(source.graph, key, source.versions, source.members, context.cache ?? emptyEvaluationCache())
  if (!evaluated.ok) return evaluated

  // 取消的节点：其结果**不**进入产物（取消是协议，不是"算完丢掉"）。
  const cancelled = new Set(context.cancelledNodes ?? [])
  const objects: EvaluatedObject[] = []
  const sources: Record<string, string> = {}
  for (const node of source.graph.nodes) {
    if (cancelled.has(node.id)) continue
    if (!Object.prototype.hasOwnProperty.call(evaluated.value.all, node.id)) continue
    const value = evaluated.value.all[node.id]
    objects.push(Object.freeze({ objectId: node.id, domain: node.domain, payload: value }))
    // 来源映射：节点 id → 它声明的来源对象（若 compute 没给来源，则用节点 id）。
    sources[node.id] = sourceOf(value) ?? node.id
  }

  return ok(
    Object.freeze({
      sceneId: source.sceneId,
      key: evaluated.value.key,
      objects: Object.freeze(objects),
      sources: Object.freeze(sources),
      stats: evaluated.value.stats,
      identities: evaluated.value.identities,
      cache: evaluated.value.cache,
    }),
  )
}

/** 从求值产物里读来源对象 id（约定字段 `objectId`；没有则 `null`）。 */
function sourceOf(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null
  const v = (value as { objectId?: unknown }).objectId
  return typeof v === 'string' ? v : null
}

// ─────────────────────────────────────────────────────────────────────────────
// 资源缓存身份（A28 负对照「按 URL 而不按内容版本缓存」）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 资源缓存查询（**按内容身份**，不是 URL）。
 *
 * `#249` §19.3：「资源引用包含稳定资源 ID 和内容版本/哈希，**URL 仅为获取位置**」。
 * ⇒ 本函数只接受"内容身份"（`resourceCacheKey` 的产物），不接受 URL 字符串。
 * 一个想按 URL 缓存的实现**在签名上就写不出来** —— 这是 A28 负对照的静态落点。
 */
export function lookupResource<T>(
  cache: Readonly<Record<string, T>>,
  identity: string,
): T | undefined {
  return Object.prototype.hasOwnProperty.call(cache, identity) ? cache[identity] : undefined
}

/**
 * 资源版本清单是否变化（`contentResourceVersions` 的比对）。
 *
 * 单独成函数的原因：它必须**逐 assetId 比对内容版本**，而不是比"URL 集合"。
 * A28 的负对照「替换资源时旧请求晚到」在本函数上是"同一 assetId 的两个不同版本"，
 * 按 URL 比对会把它们看成同一个。
 */
export function resourceVersionsChanged(
  before: Readonly<Record<AssetId, string>>,
  after: Readonly<Record<AssetId, string>>,
): readonly AssetId[] {
  const changed: AssetId[] = []
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const k of [...keys].sort()) {
    if (before[k] !== after[k]) changed.push(k)
  }
  return Object.freeze(changed)
}

/**
 * 能力裁剪下的求值拒绝（A15 相关）。
 *
 * 求值本身通常不需要内容编辑能力；但**导出/呈现**可能需要"只读求值"之外的
 * 更窄能力。本函数让"未被装配的能力"在**运行时**被拒绝，而不是靠隐藏按钮。
 */
export function requireEvaluationCapability(
  capabilities: readonly string[],
  required: string,
): Result<null> {
  if (capabilities.includes(required)) return ok(null)
  return err(unsupportedOperation({ reason: 'evaluationCapabilityMissing', capability: required }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 默认场景求值图（呈现消费接口；呈现实现归 P5 #256）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 由文档状态构造默认场景求值图。
 *
 * ## 为什么这个函数必须存在（而不是"让 P5 自己写"）
 *
 * #255 的退出边界明文：「**呈现消费接口在本单定义**，呈现实现归 #256」。
 * 一个没有默认图的 `evaluateScene` 只是机制，消费者拿不到能用的产物 ——
 * 那正是 #249 §13 禁止的"空接口"。
 *
 * ## 图的形状由**所有权事实**决定，不是随手挑的
 *
 * | 节点域 | 消费的版本源 | 为什么 |
 * |---|---|---|
 * | `geometry`（每对象数据） | `data:<dataId>`（**细粒度**） | 只有该数据的内容版本变了才重建（A11 的核心） |
 * | `annotation`（每注解数据） | `data:<dataId>` | 注解描述变化**不得**重建方块几何 |
 * | `camera`（每相机数据） | `data:<dataId>` | 相机参数属文档；观察视角不在此（§3.1） |
 * | `channel`（每通道） | `param:<key>` + `timeDependent` | 通道吃参数版本与时间（#249 §7） |
 * | `texture`（每序列） | `res:<assetId>` | 资源按内容身份（§19.3 + A28） |
 * | `picking`（汇合） | 依赖上游（**不含** versionInputs） | 拾取必须对应同一次求值（§7「不得新描边配旧几何」） |
 *
 * **没有任何节点声明 `document`/`parameters` 这类粗粒度源** —— 那是旧
 * `structEpoch` 口径，会让"只改注解"重建方块几何（A11 负对照的形态）。
 *
 * ## 为什么 `picking` 用 `deps` 而不是自己声明版本源
 *
 * 见 `nodeIdentity` 的注释 2：依赖边本身构成身份。让拾取自己再列一遍版本源，
 * 等于维护一张与依赖边重复的表 —— 漏一处就静默配旧几何。
 */
export interface SceneGraphFacts {
  /** 每个对象的 `{ objectId, dataId, domain }`（域决定节点归组与失效面）。 */
  readonly objects: readonly {
    readonly objectId: string
    readonly dataId: string
    readonly domain: EvaluationDomain
    /** 该数据的来源内容版本（进 `data:<dataId>` 版本源）。 */
    readonly dataVersion: number
  }[]
  /** 通道：键 + 参数版本。 */
  readonly channels?: readonly { readonly key: string; readonly parameterVersion: number }[]
  /** 纹理序列：资源 id + 内容版本。 */
  readonly textures?: readonly { readonly assetId: string; readonly contentVersion: string }[]
  /** 每个对象的几何负载（由呈现消费者解释；本层只做"值"的传递）。 */
  readonly geometryOf?: (objectId: string) => unknown
  readonly annotationOf?: (objectId: string) => unknown
  readonly cameraOf?: (objectId: string) => unknown
}

export function defaultSceneGraph(facts: SceneGraphFacts): EvaluationGraphDeclaration {
  const nodes: EvaluationNodeDeclaration[] = []
  const outputs: string[] = []

  for (const o of facts.objects) {
    const nodeId = objectNodeId(o.domain, o.objectId)
    const loader =
      o.domain === 'annotation' ? facts.annotationOf : o.domain === 'camera' ? facts.cameraOf : facts.geometryOf
    nodes.push({
      id: nodeId,
      domain: o.domain,
      deps: [],
      // **细粒度**：只有该数据的内容版本变化才失效。
      versionInputs: [`data:${o.dataId}`],
      // 几何/注解/相机**不**吃时间：播放动画不得让它们重算（#249 §7）。
      timeDependent: false,
      compute: () => ok(Object.freeze({ objectId: o.objectId, payload: loader ? loader(o.objectId) : null })),
    })
    outputs.push(nodeId)
  }

  for (const ch of facts.channels ?? []) {
    nodes.push({
      id: `channel:${ch.key}`,
      domain: 'channel',
      deps: [],
      versionInputs: [`param:${ch.key}`],
      // 通道吃时间（#249 §7：通道动画的时间采样）。
      timeDependent: true,
      compute: (input) => ok(Object.freeze({ objectId: ch.key, parameterVersion: versionOf(input.versions, `param:${ch.key}`), time: input.key.time })),
    })
    outputs.push(`channel:${ch.key}`)
  }

  for (const t of facts.textures ?? []) {
    nodes.push({
      id: `texture:${t.assetId}`,
      domain: 'texture',
      deps: [],
      // 资源按**内容身份**（§19.3 + A28）；URL 不参与。
      versionInputs: [`res:${t.assetId}`],
      // 纹理序列吃时间（采样按时间）。
      timeDependent: true,
      compute: (input) => ok(Object.freeze({ objectId: t.assetId, contentVersion: t.contentVersion, time: input.key.time })),
    })
    outputs.push(`texture:${t.assetId}`)
  }

  // 拾取/来源映射节点：消费全部对象节点 ⇒ 自动随它们失效（对应同次求值）。
  const objectNodeIds = facts.objects.map((o) => objectNodeId(o.domain, o.objectId))
  nodes.push({
    id: 'picking:index',
    domain: 'picking',
    deps: objectNodeIds,
    versionInputs: [],
    timeDependent: false,
    compute: (input) =>
      ok(
        Object.freeze({
          objectId: 'picking:index',
          // 来源映射：节点 id → 文档对象 id（#249 §7「几何、拾取和对象来源映射必须对应同次求值」）
          sources: Object.freeze(
            Object.fromEntries(objectNodeIds.map((n) => [n, (input.upstream[n] as { objectId?: string } | undefined)?.objectId ?? n])),
          ),
        }),
      ),
  })
  outputs.push('picking:index')

  return Object.freeze({ id: 'scene-default', nodes: Object.freeze(nodes), outputs: Object.freeze(outputs) })
}

/** 对象节点 id（域 + 对象 id，稳定且可反查）。 */
export function objectNodeId(domain: EvaluationDomain, objectId: string): string {
  return `${domain}:${objectId}`
}

/**
 * 把 `SceneGraphFacts` 需要的版本源整理出来（供宿主接线；纯）。
 *
 * 与 `sceneVersionSources` 的关系：后者是**粗粒度**可选项（只有显式需要整份文档
 * 粒度的节点才该用），本函数产出的 `data:` / `param:` / `res:` 才是默认图的输入。
 */
export function graphVersionSnapshot(
  facts: SceneGraphFacts,
  extra: Readonly<Record<VersionSourceId, number>> = {},
): VersionSnapshot {
  const values: Record<VersionSourceId, number> = { ...extra }
  for (const o of facts.objects) values[`data:${o.dataId}`] = o.dataVersion
  for (const c of facts.channels ?? []) values[`param:${c.key}`] = c.parameterVersion
  for (const t of facts.textures ?? []) {
    // 内容版本（字符串）⇒ 一个稳定的数（内容身份摘要，非 URL）。
    values[`res:${t.assetId}`] = contentDigest(t.contentVersion)
  }
  return versionSnapshot(values)
}

/** 未使用占位：保持 `DomainError` 可达（下游 `import type`）。 */
export type { DomainError }
