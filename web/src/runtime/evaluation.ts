/**
 * `runtime/evaluation` —— **依赖图实例、缓存与异步求值接线**。
 *
 * ## 本模块与 `application/evaluation` 的分工
 *
 * | 层 | 职责 |
 * |---|---|
 * | `application/evaluation` | **纯**：图校验、环检测、节点身份、拉动求值、接纳判定（`admitNodeResult`） |
 * | `runtime/evaluation`（本模块） | **接线**：持有缓存、发起异步效果、把完成事件交给纯判定、回收过期资源 |
 *
 * 「合法性、碰撞、选择跟随、动画插值、事务冲突等政策必须在可独立测试的纯函数中；
 * 不能因"这里接线方便"迁入 Vue watch 或网络回调」。
 * ⇒ 本模块**没有**任何一个"该不该失效/该不该接纳"的判断：它全部转调
 * `application/evaluation` 的纯函数。它只负责"记住"与"调用"。
 *
 * ## 为什么异步求值必须走本模块而不是在节点里 `await`
 *
 * 求值规则：「昂贵节点可以发出**异步计算效果**，但接纳结果仍受**原求值键**约束。
 * 过期结果不得覆盖新结果，已获取资源必须回收。」
 *
 * 节点自身的 `compute` 是**同步纯函数**（否则它就无法被重放）。
 * 昂贵节点因此这样表达：`compute` 立刻返回一个 `PendingRequest` 描述
 * （"我需要异步算这个，身份是 X"），接线层把它交给宿主执行；结果回来时经
 * `admitAsyncResult` 判定。判定不通过 ⇒ 结果丢弃**且**要求回收。
 *
 * ## 时钟与刷新：本模块不含任何循环
 *
 * 与 `runtime/execution` 同一条纪律：**没有** `requestAnimationFrame`、
 * `setInterval`、`setTimeout`、微任务自唤醒。推进由宿主显式调用
 * `evaluate(...)`；"什么时候再算一次"是宿主的决定，不是内核的隐式行为。
 * 这使「无调用方手动 refresh」有一个可核对的正面事实：
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
 * 它**只**持有四样东西：图声明、缓存、逐节点身份、绑定代数与在途请求。
 * 没有"脏标记集合""待刷新队列""版本补丁表"—— 那些正是被退役的
 * 形态（"非内容版本不得冒充内容变化"）。
 *
 * `inFlight` 记录在途异步请求，用于"过期不得覆盖 + 资源必须回收"的记账：
 * 每个进入 in-flight 的请求在结算时必须得到一个明确结局（接纳或回收）。
 */
interface CacheEntry {
  readonly identity: string
  readonly value: unknown
}

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
   * 「文档关闭也释放租约、取消归属作业。**资源加载回调不能重新激活已关闭的交互**」
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
   * 于是"上一轮算了什么"是显式状态，可被测试逐步对账（"重建数为 0"的断言）。
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
    // 记下本轮逐节点身份：异步请求的发起与接纳都以它为依据。
    this.latestIdentities = r.value.identities

    // 收集本轮出现的异步请求（由节点 compute 产出），并登记为在途。
    //
    // 只看**本轮真正重算过**的节点：命中缓存的节点不会再次产出同一请求
    // （否则每轮都会重复发起同一个昂贵计算）。身份取自产物里的 `identities`
    // ——它是 `nodeIdentity` 的**同一次**计算，接线层不自己重算（两边重算会漂移）。
    const recomputed = new Set(r.value.stats.recomputedNodes)
    const pending: PendingEvaluationRequest[] = []
    for (const object of r.value.objects) {
      if (!recomputed.has(object.objectId)) continue
      if (!isPendingEvaluationRequest(object.payload)) continue
      const request: PendingEvaluationRequest = Object.freeze({
        kind: 'pendingEvaluation',
        nodeId: object.objectId,
        identity: r.value.identities[object.objectId] ?? object.payload.identity,
        correlationId: object.payload.correlationId,
      })
      pending.push(request)
      // **不覆盖**已在案的同一 `correlationId`。
      //
      // 为什么：若后来的求值用同一个 correlationId 覆盖了在途记录，那么**较早那次**
      // 请求的迟到结果就会拿"新的身份"去比对，从而被判为 `current` 并被接纳 ——
      // 旧结果覆盖新结果，正是明文禁止的形态。
      // 保留先到的那条记录，使旧请求的迟到结果必然被判 `staleIdentity`。
      // （正常情况下 correlationId 由发起方保证唯一；这条是纵深防御。）
      if (!this.inFlight.has(request.correlationId)) {
        this.inFlight.set(request.correlationId, Object.freeze({
          nodeId: request.nodeId,
          identity: request.identity,
          bindingGeneration: this.bindingGeneration,
          correlationId: request.correlationId,
        }))
      }
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
   *    这不是"建议"—— 「已获取资源必须回收」，把它做成返回值
   *    让"忘了 dispose"在类型上显形。
   *
   * 判据用**最近一次求值产出的身份**（`latestIdentities`）与发起时的身份比对：
   * 若这期间发生过使该节点失效的求值，身份必然不同 ⇒ `staleIdentity`。
   * 这就是"过期结果不得覆盖新结果"（负对照「无版本检查接纳旧结果」）的落地方式 ——
   * 判据是**版本化事实**，不是时间戳或"谁后到谁赢"。
   *
   * 未被接纳时同样把它从在途表移除（它有了结局），使 in-flight 计数可对账
   * （"活跃计数回基线"依赖这类显式结算）。
   */
  admitAsyncResult(completion: AsyncEvaluationCompletion): AdmitDecisionWithRelease {
    const known = this.inFlight.get(completion.request.correlationId)
    if (!known) {
      // 未知请求：结果与资源都必须回收，且**不**改动任何状态。
      return Object.freeze({ admitted: false, release: true, reason: 'nodeUnknown', unknown: true })
    }

    // 该节点**当前**的身份：由最近一次求值给出。若期间没有重算过该节点，
    // 说明它的输入没变，身份自然相符（不是"没检查"）。
    const currentIdentity = this.latestIdentities[completion.request.nodeId] ?? known.identity
    const decision: AdmitNodeDecision = admitNodeResult(this.options.graph, known, {
      identity: currentIdentity,
      bindingGeneration: this.bindingGeneration,
      cancelled: this.cancelledNodes.has(completion.request.correlationId),
    })
    this.inFlight.delete(completion.request.correlationId)
    this.cancelledNodes.delete(completion.request.correlationId)

    if (!decision.admitted) {
      return Object.freeze({ admitted: false, release: decision.release, reason: decision.reason, unknown: false })
    }
    // 接纳：把结果写入缓存（以**发起时**的身份为键）。
    // 走到这里 `currentIdentity === known.identity`（`admitNodeResult` 已判定），
    // 故写入不会覆盖更新的结果。
    const entries: Record<string, CacheEntry> = { ...this.cache.entries }
    entries[completion.request.nodeId] = Object.freeze({
      identity: known.identity,
      value: completion.outcome.kind === 'success' ? completion.outcome.data : null,
    })
    this.cache = Object.freeze({ entries: Object.freeze(entries) })
    return Object.freeze({ admitted: true, release: false, reason: 'current', unknown: false })
  }

  /** 最近一次求值产出的逐节点身份（过期判定的依据）。 */
  private latestIdentities: Readonly<Record<string, string>> = Object.freeze({})

  /**
   * 显式取消一个在途请求（取消是**协议**，不等于"等它返回后丢掉"）。
   *
   * 与 `runtime/effects` 的 Job 状态机同一政策：`cancelRequested` 是独立相位。
   * 在求值面上，取消表现为"该请求的结果回来后必被拒且要求回收"。
   */
  cancelAsync(correlationId: string): boolean {
    if (!this.inFlight.has(correlationId)) return false
    this.cancelledNodes.add(correlationId)
    return true
  }

  /** 已显式取消的在途请求。 */
  private readonly cancelledNodes = new Set<string>()

  /**
   * 清空缓存（**不是**"刷新"）。
   *
   * 注意命名：它不叫 `refresh`/`invalidate`，因为它不是"让某个东西重新算"的业务动作 ——
   * 它是"丢弃可丢弃的派生缓存"（所有权表：求值缓存"可丢弃、不保存为权威"）。
   * 丢弃之后**下一次求值**照常按版本输入判定要重算什么；本方法不指定任何节点。
   */
  clearCache(): void {
    this.cache = emptyEvaluationCache()
    this.latestIdentities = Object.freeze({})
  }

  /**
   * 丢弃**所有**在途请求并要求回收（文档关闭 / 取消导出）。
   *
   * 返回被丢弃的请求，供调用方核对"资源确实被回收"（「旧资源释放」）。
   * 推进绑定代数使任何**未在案**的迟到回调也无法命中当前绑定。
   */
  discardInFlight(): readonly AsyncNodeRequest[] {
    const dropped = [...this.inFlight.values()]
    this.inFlight.clear()
    this.cancelledNodes.clear()
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
 * 「所有影响输出的时间来源与参数进入相应求值键，不能只缓存场景时间」
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
 * 计算某节点的身份（供宿主在**图外**发起异步请求时记录依据）。
 *
 * `upstreamIdentities` 必须由调用方给出：`nodeIdentity` 把上游身份折进身份
 * （否则下游节点会拿旧上游结果，见该函数注释）。宿主若在**求值之后**单独发起请求，
 * 应从 `EvaluationOutcome.evaluated.identities` 原样取用，而不是自己重算 ——
 * 两边各算一次会漂移。
 */
export function identityForNode(
  graph: EvaluationGraphDeclaration,
  nodeId: string,
  key: EvaluationKey,
  versions: VersionSnapshot,
  members: MemberSnapshot,
  upstreamIdentities: Readonly<Record<string, string>> = {},
): Result<string> {
  const node = graph.nodes.find((n) => n.id === nodeId)
  if (!node) return err(unsupportedOperation({ reason: 'nodeNotDeclared', node: nodeId }))
  return ok(nodeIdentity(node, key, versions, members, upstreamIdentities))
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
