/**
 * `runtime/evaluation` —— **依赖图实例、缓存与异步求值接线**（#249 §7 §9 §19.5）。
 *
 * ## 本模块与 `application/evaluation` 的分工（#249 §4 导入规则 2/3）
 *
 * | 层 | 职责 |
 * |---|---|
 * | `application/evaluation` | **纯**：图校验、环检测、节点身份、拉动求值、接纳判定（`admitNodeResult`） |
 * | `runtime/evaluation`（本模块） | **接线**：持有缓存、发起异步效果、把完成事件交给纯判定、回收过期资源 |
 *
 * 「合法性、碰撞、选择跟随、动画插值、事务冲突等政策必须在可独立测试的纯函数中；
 * 不能因"这里接线方便"迁入 Vue watch 或网络回调」（#249 §2.1）。
 * ⇒ 本模块**没有**任何一个"该不该失效/该不该接纳"的判断：它全部转调
 * `application/evaluation` 的纯函数。它只负责"记住"与"调用"。
 *
 * ## 为什么异步求值必须走本模块而不是在节点里 `await`
 *
 * `#249` §7：「昂贵节点可以发出**异步计算效果**，但接纳结果仍受**原求值键**约束。
 * 过期结果不得覆盖新结果，已获取资源必须回收。」
 *
 * 节点自身的 `compute` 是**同步纯函数**（否则它就无法被重放，A04）。
 * 昂贵节点因此这样表达：`compute` 立刻返回一个 `PendingRequest` 描述
 * （"我需要异步算这个，身份是 X"），接线层把它交给宿主执行；结果回来时经
 * `admitAsyncResult` 判定。判定不通过 ⇒ 结果丢弃**且**要求回收。
 *
 * ## 时钟与刷新：本模块不含任何循环
 *
 * 与 `runtime/execution` 同一条纪律：**没有** `requestAnimationFrame`、
 * `setInterval`、`setTimeout`、微任务自唤醒。推进由宿主显式调用
 * `evaluate(...)`；"什么时候再算一次"是宿主的决定，不是内核的隐式行为。
 * 这使 A11 负对照「无调用方手动 refresh」有一个可核对的正面事实：
 * 本模块**没有**任何"刷新"入口，只有"给我键、我算"。
 */

import {
  admitNodeResult,
  emptyEvaluationCache,
  evaluateScene,
  evaluationKeyId,
  nodeIdentity,
  requireEvaluationCapability,
  resourceVersionsChanged,
  versionSnapshot,
  memberSnapshot,
  type AdmitNodeDecision,
  type AsyncNodeRequest,
  type EvaluationCache,
  type EvaluationContext,
  type EvaluationGraphDeclaration,
  type EvaluatedScene,
  type EvaluationKey,
  type MemberSnapshot,
  type SceneReadView,
  type VersionSnapshot,
} from '@/application/evaluation'
import type { DomainError, Result } from '@/domain/errors'
import { ok, err, unsupportedOperation } from '@/domain/errors'

// ─────────────────────────────────────────────────────────────────────────────
// 异步求值请求（由节点的同步 compute 产出）
// ─────────────────────────────────────────────────────────────────────────────

/** 节点 compute 产出的"我需要异步算"描述。 */
export interface PendingEvaluationRequest {
  readonly kind: 'pendingEvaluation'
  readonly nodeId: string
  /** 该请求所依据的节点缓存身份（接纳判定用；过期即丢弃）。 */
  readonly identity: string
  readonly correlationId: string
}

/** 判断一个节点产物是否是异步请求（窄化用；不用 `instanceof` 以免跨 realm 失效）。 */
export function isPendingEvaluationRequest(v: unknown): v is PendingEvaluationRequest {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { kind?: unknown }).kind === 'pendingEvaluation' &&
    typeof (v as { nodeId?: unknown }).nodeId === 'string' &&
    typeof (v as { identity?: unknown }).identity === 'string'
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 图实例
// ─────────────────────────────────────────────────────────────────────────────

export interface EvaluationInstanceOptions {
  readonly graph: EvaluationGraphDeclaration
  readonly prefix?: string
  /** 宿主是否已安装异步求值能力（未安装 ⇒ 收到 pending 请求时显式拒绝）。 */
  readonly asyncEvaluation?: boolean
  readonly capabilities?: readonly string[]
}

/** 一次求值的结果 + 需要宿主执行的异步请求。 */
export interface EvaluationOutcome {
  readonly evaluated: EvaluatedScene
  /** 需要宿主执行的异步请求（可能为空）。 */
  readonly pending: readonly PendingEvaluationRequest[]
  /** 快捷键（诊断关联）。 */
  readonly keyId: string
  /** 本次求值是否"结构上什么都没变"（缓存全命中 ⇒ 呈现侧可跳过重传）。 */
  readonly noStructuralChange: boolean
}

/** 一次异步完成事件（宿主调用 `admitAsyncResult` 时给出）。 */
export interface AsyncEvaluationCompletion {
  readonly request: PendingEvaluationRequest
  readonly bindingGeneration: number
  readonly outcome:
    | { readonly kind: 'success'; readonly data: unknown }
    | { readonly kind: 'failure'; readonly error: DomainError }
}

/**
 * 依赖图实例。
 *
 * 它**只**持有三样东西：图声明、缓存、绑定代数。
 * 没有任何"脏标记集合""待刷新队列""版本补丁表"—— 那些正是 #249 §15 第 5 条
 * 要退役的形态（"非内容版本不得冒充内容变化"）。
 *
 * `inFlight` 记录在途异步请求，用于"过期不得覆盖 + 资源必须回收"的记账：
 * 每个进入 in-flight 的请求在结算时必须得到一个明确结局（接纳或回收）。
 */
export class EvaluationInstance {
  private cache: EvaluationCache = emptyEvaluationCache()
  private bindingGeneration = 0
  private readonly inFlight = new Map<string, AsyncNodeRequest>()

  constructor(private readonly options: EvaluationInstanceOptions) {}

  /** 当前图声明。 */
  get graph(): EvaluationGraphDeclaration {
    return this.options.graph
  }

  get cacheSize(): number {
    return Object.keys(this.cache.entries).length
  }

  get inFlightCount(): number {
    return this.inFlight.size
  }

  /**
   * 推进绑定代数（文档关闭 / 重新绑定源）。
   *
   * 契约 §6.1：「文档关闭也释放租约、取消归属作业。**资源加载回调不能重新激活已关闭的交互**」
   * ⇒ 推进代数使任何迟到回调都无法命中当前绑定（与 `runtime/execution` 的
   * `rebindSaveLedger` 同一机制、同一理由）。
   */
  rebind(): void {
    this.bindingGeneration += 1
    // 重绑即在途请求全部过期；它们的结果会被 `admitAsyncResult` 判为 staleBinding。
  }

  get binding(): number {
    return this.bindingGeneration
  }

  /**
   * 求值一次。
   *
   * 缓存**跨次复用**：`this.cache` 被逐次替换为新的不可变缓存值，
   * 于是"上一轮算了什么"是显式状态，可被测试逐步对账（A11 的"重建数为 0"断言）。
   */
  evaluate(source: SceneReadView): Result<EvaluationOutcome> {
    const capability = requireEvaluationCapability(this.options.capabilities ?? [], 'evaluation.read')
    if (!capability.ok) return capability

    const ctx: EvaluationContext = {
      bindingGeneration: this.bindingGeneration,
      cache: this.cache,
    }
    const r = evaluateScene(source, ctx)
    if (!r.ok) return r
    this.cache = r.value.cache

    // 收集本轮出现的异步请求（由节点 compute 产出），并登记为在途。
    // 只看**本轮真正重算过**的节点：命中缓存的节点不会再次产出同一请求
    // （否则每轮都会重复发起同一个昂贵计算）。
    const recomputed = new Set(r.value.stats.recomputedNodes)
    const pending: PendingEvaluationRequest[] = []
    for (const object of r.value.objects) {
      if (!recomputed.has(object.objectId)) continue
      if (!isPendingEvaluationRequest(object.payload)) continue
      const request: PendingEvaluationRequest = Object.freeze({
        kind: 'pendingEvaluation',
        nodeId: object.objectId,
        identity: object.payload.identity,
        correlationId: object.payload.correlationId,
      })
      pending.push(request)
      this.inFlight.set(request.correlationId, Object.freeze({
        nodeId: request.nodeId,
        identity: request.identity,
        bindingGeneration: this.bindingGeneration,
        correlationId: request.correlationId,
      }))
    }

    return ok(
      Object.freeze({
        evaluated: r.value,
        pending: Object.freeze(pending),
        keyId: evaluationKeyId(r.value.key),
        noStructuralChange: r.value.stats.recomputed === 0,
      }),
    )
  }

  /**
   * 接纳一次异步求值结果（**接线**：判定在纯函数里）。
   *
   * 返回 `{ admitted, release, reason }`：
   *  - `release: true` ⇒ 调用方**必须**回收结果携带的资源。
   *    这不是"建议"—— `#249` §7 明文「已获取资源必须回收」，把它做成返回值
   *    让"忘了 dispose"在类型上显形。
   *
   * 未被接纳时同时把它从在途表中移除（它有了结局），使 in-flight 计数可对账
   * （A19/A12 的"活跃计数回基线"依赖这类显式结算）。
   */
  admitAsyncResult(completion: AsyncEvaluationCompletion): AdmitDecisionWithRelease {
    const known = this.inFlight.get(completion.request.correlationId)
    if (!known) {
      // 未知请求：结果与资源都必须回收，且**不**改动任何状态。
      return Object.freeze({ admitted: false, release: true, reason: 'nodeUnknown', unknown: true })
    }

    // 该请求所依据的**当前**身份：重新计算（版本可能已经变了）。
    const currentIdentity = this.currentIdentityOf(completion.request.nodeId, completion.request.identity)
    const decision: AdmitNodeDecision = admitNodeResult(
      this.options.graph,
      known,
      {
        identity: currentIdentity,
        bindingGeneration: this.bindingGeneration,
      },
    )
    this.inFlight.delete(completion.request.correlationId)

    if (!decision.admitted) {
      return Object.freeze({ admitted: false, release: decision.release, reason: decision.reason, unknown: false })
    }
    // 接纳：把结果写入缓存（以**发起时**的身份为键）。
    // 走到这里 `currentIdentity === known.identity`（admitNodeResult 已判定），
    // 故写入不会覆盖更新的结果 —— 这正是"过期结果不得覆盖新结果"的落点。
    const entries: Record<string, { identity: string; value: unknown }> = { ...this.cache.entries }
    entries[completion.request.nodeId] = Object.freeze({ identity: known.identity, value: completion.outcome.kind === 'success' ? completion.outcome.data : null })
    this.cache = Object.freeze({ entries: Object.freeze(entries) })
    return Object.freeze({ admitted: true, release: false, reason: 'current', unknown: false })
  }

  /**
   * 当前身份。
   *
   * 接线层**无法**凭自己重算真实身份（它需要当前的版本/成员快照）。
   * 故这里采用"已知身份 + 未变"的保守语义：若调用方在 `evaluate` 之后又推进过
   * 版本快照，必须调用 `noteVersionAdvance()` 主动标记，使身份不再匹配。
   *
   * 为什么不做成"自动重算"：那需要接线层持有最新快照并在异步回调时重放求值，
   * 等于把"求值"藏进接纳路径 —— 政策就漏进接线了。显式标记让
   * "什么使结果过期"成为一个可枚举的事实。
   */
  private currentIdentityOf(nodeId: string, fallback: string): string {
    if (this.staleNodes.has(nodeId)) return `stale:${fallback}`
    return fallback
  }

  /** 已被新版本超越的节点（其异步结果必须被拒绝）。 */
  private readonly staleNodes = new Set<string>()

  /**
   * 标记"该节点所依据的输入已经前进"。
   *
   * 调用方（宿主）在版本/集合/时间变化后调用它 —— 通常紧接一次新的 `evaluate()`。
   * 这里**不**接收版本值：只需知道"变了"，具体身份由下一次 `evaluate` 重新计算。
   */
  noteVersionAdvance(nodeIds?: readonly string[]): void {
    if (nodeIds === undefined) {
      for (const n of this.options.graph.nodes) this.staleNodes.add(n.id)
      return
    }
    for (const id of nodeIds) this.staleNodes.add(id)
  }

  /** 清空缓存并复位过期标记（用于"资源清单整体换版"这类粗粒度场景，也供测试对账）。 */
  clearCache(): void {
    this.cache = emptyEvaluationCache()
    this.staleNodes.clear()
  }

  /**
   * 丢弃**所有**在途请求并要求回收（文档关闭 / 取消导出）。
   *
   * 返回被丢弃的请求数，供调用方核对"资源确实被回收"（A12「旧资源释放」）。
   */
  discardInFlight(): readonly AsyncNodeRequest[] {
    const dropped = [...this.inFlight.values()]
    this.inFlight.clear()
    this.bindingGeneration += 1
    return Object.freeze(dropped)
  }
}

export interface AdmitDecisionWithRelease {
  readonly admitted: boolean
  readonly release: boolean
  readonly reason: AdmitNodeDecision['reason']
  /** 请求未在案（重复完成 / 伪造完成）。 */
  readonly unknown: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// 便捷构造（供装配层与测试）
// ─────────────────────────────────────────────────────────────────────────────

export function createEvaluationInstance(options: EvaluationInstanceOptions): EvaluationInstance {
  return new EvaluationInstance(options)
}

/**
 * 由若干"版本事实"构造快照（供宿主接线；纯）。
 *
 * 「所有影响输出的时间来源与参数进入相应求值键，不能只缓存场景时间」（#249 §7）
 * ⇒ 资源版本、参数版本、暂存版本都必须显式传进来，**没有**"从环境猜"的默认值。
 */
export interface SceneFacts {
  readonly sceneId: string
  readonly documentVersion: number
  readonly time: SceneReadView['time']
  readonly parameterVersion: number
  readonly stagedTransactionVersion?: number
  readonly contentResourceVersions: Readonly<Record<string, string>>
  readonly versions?: Readonly<Record<string, number>>
  readonly members?: Readonly<Record<string, readonly string[]>>
  readonly viewProjection?: SceneReadView['viewProjection']
}

/** 由事实构造求值源（把"要传什么"收在一处，避免各处漏传一项而静默缓存）。 */
export function sceneReadView(graph: EvaluationGraphDeclaration, facts: SceneFacts): SceneReadView {
  const versions: VersionSnapshot = versionSnapshot(facts.versions ?? {})
  const members: MemberSnapshot = memberSnapshot(facts.members ?? {})
  return Object.freeze({
    sceneId: facts.sceneId,
    documentVersion: facts.documentVersion,
    time: facts.time,
    parameterVersion: facts.parameterVersion,
    ...(facts.stagedTransactionVersion === undefined ? {} : { stagedTransactionVersion: facts.stagedTransactionVersion }),
    contentResourceVersions: facts.contentResourceVersions,
    ...(facts.viewProjection === undefined ? {} : { viewProjection: facts.viewProjection }),
    graph,
    versions,
    members,
  })
}

/**
 * 计算某节点的身份（供宿主在发起异步请求时记录依据）。
 *
 * 这是"发起时记下依据"的唯一入口：宿主不应自己拼身份字符串。
 */
export function identityForNode(
  graph: EvaluationGraphDeclaration,
  nodeId: string,
  key: EvaluationKey,
  versions: VersionSnapshot,
  members: MemberSnapshot,
): Result<string> {
  const node = graph.nodes.find((n) => n.id === nodeId)
  if (!node) return err(unsupportedOperation({ reason: 'nodeNotDeclared', node: nodeId }))
  return ok(nodeIdentity(node, key, versions, members))
}

/** 资源清单变化 ⇒ 受影响节点（供宿主 `noteVersionAdvance` 精确调用，不做全量失效）。 */
export function nodesAffectedByResourceChange(
  graph: EvaluationGraphDeclaration,
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): readonly string[] {
  const changed = resourceVersionsChanged(before, after)
  if (changed.length === 0) return Object.freeze([])
  const out: string[] = []
  for (const n of graph.nodes) {
    if (n.domain === 'texture' || n.domain === 'channel') out.push(n.id)
  }
  return Object.freeze(out)
}
