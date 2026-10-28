/**
 * `runtime/execution` —— **统一执行协议**：更新批次、状态持有、原子发布。
 *
 * ## 本模块替代的旧机制
 *
 * 旧机制（`Main`/万能 `Context` 裸字段及 Vue Ref 访问；多 RAF 分别推进业务、
 * Promise 回调写状态）的**替代实现**在这里：权威状态只存在于 `Editor` 内部，
 * 对外只有四个方法；所有权威变化都经同一条 `reduceCommand` 入口，
 * 且只在**批次**里发生与发布。
 *
 * ## 四条硬要求的落地
 *
 * ### 「所有权威变化只在更新阶段」
 * `Editor` **不**自己驱动任何循环：没有 `requestAnimationFrame`、没有 `setInterval`、
 * 没有微任务。批次由**宿主编排**显式调用 `runBatch()` 推进。
 * 这不是"少写了一个循环"，而是把"业务推进可枚举"变成结构事实 ——
 * 内核里不存在一个"到点自己跑"的东西，因此不存在"隐式的第二条业务推进路径"。
 *
 * ### 「发布版本内文档/选择/历史一致」
 * 状态是**不可变值**，发布 = 一次引用赋值（`this.state = next`）。
 * 「新文档、旧选择、半更新历史」需要一个中间态才能被观察到，而中间态不存在。
 *
 * ### 负对照「允许回调直接推进版本」⇒ 必须判红
 * 订阅回调执行期间 `publishing === true`：
 *  - `executeNow` 返回 `WouldBlock{reason:'reentrant'}`（执行协议明文）；
 *  - `submit` **被接纳但只入队**，进入**下一合法更新批次**（执行协议明文：
 *    「`observe` 的回调不能同栈重入写入；新命令进入下一合法更新批次」）。
 *
 * ### 「`executeNow` 不构成第二写通路」
 * `executeNow` 与批次**调用同一个** `reduceCommand`，并走同一个 `publish`。
 * 它唯一的额外职责是：在忙/重入/有排队命令时**拒绝**（`WouldBlock`），
 * 以及限制在 `ImmediateCommand`（无效果、可有界完成）范围内。
 */

import {
  reduceCommand,
  requiresQueue,
  ALL_CAPABILITIES,
  type Command,
  type ExecutionInputs,
  type ImmediateCommand,
  type Transition,
} from '@/application/commands'
import { captureReadView, type ReadView } from '@/application/queries'
import type { CommandOutcome } from '@/application/contracts'
import { emptyApplicationState, type ApplicationState } from '@/application/state'
import { canonicalize, type Version } from '@/domain/identity'
import { type DomainError, wouldBlock } from '@/domain/errors'
import {
  DEFAULT_BUDGET,
  digestStep,
  planBatch,
  type BatchBudget,
  type InputRecord,
  type InputSource,
  type ReplayLog,
  type StepDigest,
} from './scheduling'

// ─────────────────────────────────────────────────────────────────────────────
// 执行协议的对外类型
// ─────────────────────────────────────────────────────────────────────────────

export interface CommandTicket {
  readonly ticketId: string
  readonly commandId: string
}

/**
 * 内核契约 §4.1 —— `CommandOutcome` 的**唯一权威是 `application/contracts`**。
 *
 * 本文件曾本地定义一份（与 `contracts.ts` 的同名同义并存）。收敛后只再导出：
 * `CommandOutcome` 是命令结算的**契约类型**，它的分类（applied/unchanged/rejected）
 * 与构造子（`appliedOutcome`/`unchangedOutcome`/`rejectedOutcome`）必须与
 * RNA 侧（`property-commands.ts` 用的那套）**逐个字段相同** ——
 * 两处各定义一份，`toOutcome` 的映射就可能少一个字段而无人发现。
 */
export type { CommandOutcome }

/** 内核契约 §2.1 —— `ReadView` 在 `application/queries` 落地（此处只做类型出口）。 */
export type { ReadView }

/** `read` 的作用域。 */
export interface ReadScope {
  readonly documentId: string
  readonly contextId: string
}

/**
 * 查询规格（`observe(query, listener)`）。
 *
 * 这是**封闭枚举**：每个规格对应一个可枚举、可值比较的查询。
 * 它让"依赖自动维护"在早期就有真实含义（按值比较检测变化），
 * 而不需要预先造出完整依赖图。
 */
export type QuerySpec =
  | { readonly kind: 'version'; readonly documentId: string }
  | { readonly kind: 'document'; readonly documentId: string }
  | { readonly kind: 'objects'; readonly documentId: string }
  | { readonly kind: 'object'; readonly documentId: string; readonly objectId: string }
  | { readonly kind: 'selection'; readonly contextId: string }
  | { readonly kind: 'interaction'; readonly contextId: string }
  | { readonly kind: 'context'; readonly contextId: string }

export type QueryValue = unknown
export type Dispose = () => void

/**
 * `EditorClient` —— **唯一编辑入口**（统一执行协议）。
 *
 * `read` / `submit` / `executeNow` / `observe` 四个方法是必要且充分的最小面。
 * 类实例上**没有** `state` / `doc` / `structEpoch` 之类的公开字段 ——
 * 契约 §2.1「`read` 不导出内部 `ApplicationState`、Vue Ref、文档实例字段或渲染对象」
 * 在类型层面成立：那些东西没有公开通路。
 */
export interface EditorClient {
  read(scope: ReadScope): ReadView
  submit(command: Command, source?: InputSource): CommandTicket
  executeNow(command: ImmediateCommand): CommandOutcome
  observe(query: QuerySpec, listener: (value: QueryValue) => void): Dispose
}

// ─────────────────────────────────────────────────────────────────────────────
// 结算记录（"普通命令有一次结算"）
// ─────────────────────────────────────────────────────────────────────────────

interface Settlement {
  readonly ticketId: string
  readonly commandId: string
  readonly outcome: CommandOutcome | null
  readonly settledAtVersion: Version | null
}

interface Observer {
  readonly id: number
  readonly query: QuerySpec
  readonly listener: (value: QueryValue) => void
  /** 上次发布给该订阅者的值（规范化字符串；用于按值比较检测变化）。 */
  lastValue: string | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor
// ─────────────────────────────────────────────────────────────────────────────

export interface EditorOptions {
  /** 身份前缀（进 `IdState`，使重放可复现）。 */
  readonly prefix?: string
  readonly budget?: BatchBudget
  readonly initial?: ApplicationState
}

/**
 * 内核执行器。
 *
 * **不**实现 `EditorClient` 之外的能力；**不**启动任何循环。
 */
export class Editor implements EditorClient {
  private state: ApplicationState
  /** 待处理队列（当前批次的输入从这里切片）。 */
  private queue: readonly InputRecord[] = Object.freeze([])
  private cursor = 0
  /**
   * **输入流水（只增、永不回收）**。
   *
   * 与 `queue` 分开的理由：`queue` 表示"还没处理的输入"，排空后回收；
   * 而重放记录要的是"这一路**发生过**什么"。最初曾用
   * `queue.slice(0, cursor)` 当记录，结果 `drain()` 之后记录为空 ——
   * 重放"成功"但**什么都没比对**（一次典型假绿）。流水只增是重放可对账的结构前提。
   */
  private journal: readonly InputRecord[] = Object.freeze([])
  private nextSequence = 1
  private nextTicket = 1
  private publishing = false
  private readonly observers: Observer[] = []
  private readonly settlements = new Map<string, Settlement>()
  /** 每条已结算输入的摘要（重放记录与对账的唯一来源）。 */
  private readonly digests: StepDigest[] = []
  private readonly budget: BatchBudget

  constructor(opts: EditorOptions = {}) {
    this.state = opts.initial ?? emptyApplicationState(opts.prefix ?? 'wk')
    this.budget = opts.budget ?? DEFAULT_BUDGET
  }

  // ── read ────────────────────────────────────────────────────────

  /**
   * 捕获一个一致版本的只读视图。
   *
   * 失败（文档/上下文不存在）时抛 —— `ReadScope` 指向不存在的目标属**调用方缺陷**，
   * 不是业务拒绝；业务拒绝有 `Result`/`DomainError` 的表达方式。
   * `read` 签名返回 `ReadView`（非 `Result`），故这里保持该签名。
   */
  read(scope: ReadScope): ReadView {
    const r = captureReadView(this.state, scope.documentId, scope.contextId)
    if (!r.ok) {
      throw new Error(`Editor.read: ${r.error.code} ${JSON.stringify(r.error.params)}`)
    }
    return r.value
  }

  // ── submit ──────────────────────────────────────────────────────

  /**
   * 接收一条命令（**接收不等于已生效**）。
   *
   * 命令被追加到输入队列的**尾部**并返回票据；它在某个后续批次里结算且**只结算一次**。
   * 订阅回调里调用 `submit` 是合法的（新命令进入下一合法更新批次），
   * 因为这里**不会**立即推进状态。
   */
  submit(command: Command, source: InputSource = 'command'): CommandTicket {
    const sequence = this.nextSequence
    this.nextSequence += 1
    const record: InputRecord = Object.freeze({ sequence, order: 0, source, command, env: this.env() })
    this.queue = Object.freeze([...this.queue, record])
    this.journal = Object.freeze([...this.journal, record])
    const ticket: CommandTicket = Object.freeze({ ticketId: `t${sequence}`, commandId: `${command.kind}#${sequence}` })
    this.nextTicket += 1
    this.settlements.set(ticket.ticketId, Object.freeze({ ticketId: ticket.ticketId, commandId: ticket.commandId, outcome: null, settledAtVersion: null }))
    return ticket
  }

  /** 查询票据结算结果（`null` = 尚未结算）。 */
  settlement(ticket: CommandTicket): CommandOutcome | null {
    return this.settlements.get(ticket.ticketId)?.outcome ?? null
  }

  /** 是否还有未处理输入（宿主可据此决定是否继续驱动批次）。 */
  get pending(): number {
    return this.queue.length - this.cursor
  }

  // ── executeNow ──────────────────────────────────────────────────

  /**
   * 同步结算一条**无效果、可有界完成**的命令。
   *
   * 三种拒绝（「不越序、不阻塞等待」）：
   *  - 发布订阅中重入 ⇒ `WouldBlock{reason:'reentrant'}`（负对照的判定点）；
   *  - 存在前序排队命令 ⇒ `WouldBlock{reason:'incompatibleQueued'}`（不越序）；
   *  - 非 `ImmediateCommand`（涉及效果/生命周期）⇒ `UnsupportedOperation`。
   *
   * 它**进入与异步提交相同的逻辑更新入口**（同一个 `reduceCommand` + 同一个 `publish`），
   * 因此**不构成第二写通路**（执行协议明文）。它也**追加进流水**（同样是一次权威变化），
   * 故重放记录不会漏掉同步路径。
   */
  executeNow(command: ImmediateCommand): CommandOutcome {
    if (this.publishing) {
      return Object.freeze({ status: 'rejected', error: wouldBlock('reentrant', { command: command.kind }) })
    }
    if (this.pending > 0) {
      return Object.freeze({ status: 'rejected', error: wouldBlock('incompatibleQueued', { pending: this.pending, command: command.kind }) })
    }
    if (requiresQueue(command as Command)) {
      return Object.freeze({
        status: 'rejected',
        error: Object.freeze({ code: 'UnsupportedOperation', params: Object.freeze({ reason: 'notImmediate', command: command.kind }) }),
      })
    }
    const record: InputRecord = Object.freeze({
      sequence: this.nextSequence,
      order: 0,
      source: 'command',
      command: command as Command,
      env: this.env(),
    })
    this.nextSequence += 1
    this.journal = Object.freeze([...this.journal, record])
    const transition = reduceCommand(this.state, record.command, record.env)
    this.commit(transition)
    this.digests.push(digestStep(record, transition))
    return toOutcome(transition)
  }

  // ── observe ─────────────────────────────────────────────────────

  /**
   * 订阅一个查询。
   *
   * 回调**不能同栈重入写入**：publish 期间 `executeNow` 被判 `WouldBlock`（见上），
   * `submit` 只入队。这使"回调直接推进版本"在结构上不可能 —— 负对照注入
   * （在回调里 `executeNow` 一条写命令）必然拿到 `reentrant`。
   */
  observe(query: QuerySpec, listener: (value: QueryValue) => void): Dispose {
    const observer: Observer = { id: this.observers.length + 1, query, listener, lastValue: null }
    // 首次投递当前值（订阅者立即拿到一致版本，不必轮询）。
    // 投递走**同一条**投递路径（含异常隔离）—— 否则"订阅者一上来就抛"会
    // 从 `observe` 里漏出去，成为执行协议之外的一条未定义失败路径。
    const initial = this.evaluate(query)
    observer.lastValue = canonicalize(initial)
    this.observers.push(observer)
    this.deliver(observer, initial)
    return () => {
      const i = this.observers.indexOf(observer)
      if (i >= 0) this.observers.splice(i, 1)
    }
  }

  // ── 批次推进（宿主驱动；内核不自跑） ─────────────────────────────────────

  /**
   * 推进**一个**有界批次：接纳已排序输入 → 纯命令转移 → 原子提交 → 发布。
   *
   * 返回本批的转移（供宿主/测试对账）。预算耗尽只推迟下一批，
   * **不把半个原子命令对外发布**。
   */
  runBatch(budget: BatchBudget = this.budget): readonly Transition[] {
    const plan = planBatch(this.queue, this.cursor, budget)
    const transitions: Transition[] = []
    for (const input of plan.inputs) {
      const t = reduceCommand(this.state, input.command, input.env)
      this.commit(t)
      this.digests.push(digestStep(input, t))
      // 结算票据（每条命令**只**在首次出现时结算一次）
      const ticketId = `t${this.ticketIdOf(input.sequence)}`
      const s = this.settlements.get(ticketId)
      if (s && s.outcome === null) {
        this.settlements.set(ticketId, Object.freeze({ ...s, outcome: toOutcome(t), settledAtVersion: t.version }))
      }
      transitions.push(t)
    }
    this.cursor = plan.nextCursor
    if (this.cursor === this.queue.length && this.cursor > 0) {
      // 队列已排空：重置，避免数组无界增长（**流水**不受影响，见 `journal`）
      this.queue = Object.freeze([])
      this.cursor = 0
    }
    return Object.freeze(transitions)
  }

  /** 一次推进直到队列排空（**有界**：最多 `maxBatches` 批，防宿主写错成无界循环）。 */
  drain(maxBatches = 1024): readonly Transition[] {
    const out: Transition[] = []
    for (let i = 0; i < maxBatches && this.pending > 0; i++) {
      out.push(...this.runBatch())
    }
    return Object.freeze(out)
  }

  /**
   * 票据号 ↔ 提交序号。
   *
   * `submit` 与 `executeNow` 都在分配 `sequence` 的**同一步**分配票据号
   * （两者用同一个计数器），故此处恒等。把它抽成方法而不是内联字符串拼接，
   * 是为了让"票据与输入一一对应"这一事实只有一个落点。
   */
  private ticketIdOf(sequence: number): number {
    return sequence
  }

  // ── 重放记录 ─────────────────────────────────────────────────────────────

  /**
   * 导出重放记录。
   *
   * 记录只含**值**：初始状态的引用、输入**流水**、预算决策与逐条摘要。
   * 用 `journal`（只增）而**不是** `queue.slice(0, cursor)` —— 后者在 `drain()` 之后为空，
   * 会让重放"成功"但什么都没比对（首跑实测到的假绿）。
   * 重放不需要 DOM/GPU，因为内核本来就不依赖它们。
   */
  replayLog(initial: ApplicationState): ReplayLog {
    return Object.freeze({
      initial,
      inputs: Object.freeze([...this.journal]),
      budget: this.budget,
      digests: Object.freeze([...this.digests]),
      effects: this.state.effects,
    })
  }

  /**
   * 取当前状态的**只读快照**（供重放/诊断/测试对账）。
   *
   * 这是本类唯一的"状态出口"，且返回的是不可变值 —— 它**不**是四个方法之一，
   * 故仅以 `snapshot` 命名，不在 `EditorClient` 接口上；接线层不应把它当作读面
   * （读面是 `read()`）。它存在的原因是重放与一致性的测试需要一个可对账的初态与末态。
   */
  snapshot(): ApplicationState {
    return this.state
  }

  // ── 内部：原子提交与发布 ─────────────────────────────────────────────────

  private env(): ExecutionInputs {
    // 能力集合的权威来源：装配层。早期默认给全能力（可用的内核），
    // 但**拒绝路径已被测试覆盖**（`VIEWER_CAPABILITIES` 下内容编辑必须被判 UnsupportedOperation）。
    return this.executionInputs
  }

  private executionInputs: ExecutionInputs = Object.freeze({ capabilities: ALL_CAPABILITIES })

  /** 装配层注入执行输入（能力集合/profile 裁剪）。 */
  setExecutionInputs(env: ExecutionInputs): void {
    this.executionInputs = env
  }

  /**
   * 提交一次转移并**原子发布**。
   *
   * `rejected` 分支不改状态（转移里的 `state` 就是原引用）——
   * 这是"拒绝零残留"在发布路径上的落点：连"重新赋同一个值"都不做。
   */
  private commit(t: Transition): void {
    this.state = t.state
    this.publish()
  }

  /**
   * 发布：把变化投递给订阅者。
   *
   * `publishing` 标志是「所有权威变化只在更新阶段」的执行面 —— 它在回调栈上保持为 true，
   * 使回调内的 `executeNow` 拿到 `reentrant`、`submit` 只入队。
   * 单个订阅者抛错不影响其它订阅者，也**不**回滚状态
   * （状态已原子发布；异常属于订阅者自己的缺陷，不得污染内核，
   * 这与「UI 错误边界不得吞掉核心不变量失败」不冲突 ——
   * 这里吞掉的是**订阅者**的异常，核心不变量在 publish 之前已经成立）。
   */
  private publish(): void {
    if (this.observers.length === 0) return
    this.publishing = true
    try {
      for (const observer of this.observers.slice()) {
        const value = this.evaluate(observer.query)
        const encoded = canonicalize(value)
        if (encoded === observer.lastValue) continue
        observer.lastValue = encoded
        this.deliver(observer, value)
      }
    } finally {
      this.publishing = false
    }
  }

  /**
   * 投递一次给单个订阅者，**隔离其异常**。
   *
   * 为什么不重抛：状态已经原子发布，订阅者抛错不回滚任何东西；
   * 让异常穿透会打断对其余订阅者的投递，把"一个订阅者的缺陷"升级成
   * "其余订阅者收不到已发布的一致版本" —— 那才是对原子发布的破坏。
   * 这与「UI 错误边界不得吞掉**核心不变量**失败」不冲突：
   * 这里吞掉的是**订阅者回调**的异常，核心不变量在 publish 之前已经成立，
   * 且本方法不改变状态（错误没有掩盖任何业务失败 —— 业务失败走 `DomainError` 值）。
   */
  private deliver(observer: Observer, value: QueryValue): void {
    try {
      observer.listener(value)
    } catch {
      // 见上方注释：订阅者异常隔离。
    }
  }

  /** 求值一个查询规格（对**当前已发布状态**）。 */
  private evaluate(query: QuerySpec): QueryValue {
    switch (query.kind) {
      case 'version': {
        const doc = this.state.docs[query.documentId]
        return doc ? doc.version : null
      }
      case 'document': {
        const doc = this.state.docs[query.documentId]
        if (!doc) return null
        return {
          id: doc.id,
          version: doc.version,
          dirty: (doc.version.contentVersion ?? 0) !== (doc.saveBaseline.contentVersion ?? 0),
          canUndo: doc.history.past.length > 0,
          canRedo: doc.history.future.length > 0,
          objectCount: Object.keys(doc.scene.objects).length,
        }
      }
      case 'objects': {
        const doc = this.state.docs[query.documentId]
        if (!doc) return null
        return doc.scene.order.map((id) => {
          const o = doc.scene.objects[id]
          return { id: o.id, type: o.type, name: o.name, visible: o.visible, dataId: o.dataId }
        })
      }
      case 'object': {
        const doc = this.state.docs[query.documentId]
        const o = doc?.scene.objects[query.objectId]
        return o ? { id: o.id, name: o.name, visible: o.visible, transform: o.transform } : null
      }
      case 'selection': {
        const ctx = this.state.contexts[query.contextId]
        return ctx ? ctx.selection : null
      }
      case 'interaction': {
        const ctx = this.state.contexts[query.contextId]
        if (!ctx) return null
        return {
          active: ctx.interaction !== null,
          tool: ctx.interaction?.tool ?? null,
          targets: ctx.interaction?.targets ?? [],
          stagedCount: ctx.interaction ? Object.keys(ctx.interaction.overrides).length : 0,
        }
      }
      case 'context': {
        const ctx = this.state.contexts[query.contextId]
        return ctx ? { id: ctx.id, documentId: ctx.documentId, time: ctx.time, channelValues: ctx.channelValues, activeTool: ctx.activeTool, playing: ctx.playing, rate: ctx.playbackRate } : null
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 转移 → 契约结果
// ─────────────────────────────────────────────────────────────────────────────

function toOutcome(t: Transition): CommandOutcome {
  if (t.status === 'applied') return Object.freeze({ status: 'applied', version: t.version, changes: t.changes })
  if (t.status === 'unchanged') return Object.freeze({ status: 'unchanged', version: t.version })
  return Object.freeze({ status: 'rejected', error: t.error })
}

/** 未使用占位，保持契约类型的可达性（供下游 `import type`）。 */
export type { DomainError }
