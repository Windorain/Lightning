/**
 * `runtime/effects` —— **效果的发起、完成、取消与过期结果处理**（效果与作业状态机）。
 *
 * ## 本模块解决的问题
 *
 * 把「Promise 回调写状态」列为要退役的机制。它的危险不在"用 Promise"，
 * 而在于**完成回调可以无条件写状态**。旧代码里典型形态是：
 *
 * ```ts
 * loadSomething().then((r) => { main.doc.value = r.doc })   // 迟到的结果覆盖了新状态
 * ```
 *
 * 无版本检查的接纳有两个后果（负对照「无版本检查接纳旧结果」）：
 *  1. 旧结果覆盖新结果；
 *  2. 已关闭/已重绑的文档被迟到回调"重新激活"（负对照）。
 *
 * ## 三条协议
 *
 * 1. **完成事件只携带数据、错误和关联身份**（明文）——
 *    本模块的 `EffectCompletion` 就是这么三项，没有"目标状态引用"这种逃生舱。
 *    接纳与否由**纯函数** `admitCompletion` 判定，回调里没有政策。
 * 2. **作业状态机**：`queued → running → (cancelRequested) → succeeded | failed | cancelled`。
 *    `cancelRequested` 是**独立相位**，不等于 `cancelled` ——
 *    「调用超时不冒充取消」（作业取消是协议，不把超时等同取消成功）。
 * 3. **过期结果不得覆盖新结果；已获取资源必须回收**。
 *    `admitCompletion` 对过期结果返回 `{ admitted: false, release: true }`，
 *    把"要回收"作为**返回值**而不是"记得在回调里 dispose"。
 */

import type { DomainError } from '@/domain/errors'
import type { IdState } from '@/domain/identity'
import { allocateId } from '@/domain/identity'

// ─────────────────────────────────────────────────────────────────────────────
// 作业状态机
// ─────────────────────────────────────────────────────────────────────────────

export type JobId = string

export type JobState =
  | { readonly phase: 'queued' }
  | { readonly phase: 'running'; readonly progress?: number }
  | { readonly phase: 'cancelRequested' }
  | { readonly phase: 'succeeded'; readonly result: unknown }
  | { readonly phase: 'failed'; readonly error: DomainError }
  | { readonly phase: 'cancelled' }

export interface Job {
  readonly id: JobId
  readonly kind: 'save' | 'load' | 'evaluate' | 'export'
  readonly state: JobState
  /** 发起时的关联身份（诊断关联）。 */
  readonly correlationId: string
  /** 接纳结果所要求的**绑定代数**；不符即过期。 */
  readonly bindingGeneration: number
  /** 结果所对应的目标版本（用于"旧结果不覆盖新结果"判定）。 */
  readonly targetVersion: number
}

export interface JobRegistry {
  readonly jobs: Readonly<Record<JobId, Job>>
  readonly ids: IdState
}

export function emptyJobRegistry(prefix: string): JobRegistry {
  return Object.freeze({ jobs: Object.freeze({}), ids: Object.freeze({ prefix, counter: 0 }) })
}

// ─────────────────────────────────────────────────────────────────────────────
// 转移（全部纯）
// ─────────────────────────────────────────────────────────────────────────────

/** 入队一个新作业。 */
export function enqueueJob(
  reg: JobRegistry,
  init: { kind: Job['kind']; correlationId: string; bindingGeneration: number; targetVersion: number },
): { readonly reg: JobRegistry; readonly job: Job } {
  const a = allocateId(reg.ids, 'job')
  const job: Job = Object.freeze({
    id: a.id,
    kind: init.kind,
    state: Object.freeze({ phase: 'queued' }),
    correlationId: init.correlationId,
    bindingGeneration: init.bindingGeneration,
    targetVersion: init.targetVersion,
  })
  return {
    reg: Object.freeze({ jobs: Object.freeze({ ...reg.jobs, [job.id]: job }), ids: a.next }),
    job,
  }
}

export type JobEvent =
  | { readonly kind: 'start' }
  | { readonly kind: 'progress'; readonly progress: number }
  | { readonly kind: 'requestCancel' }
  | { readonly kind: 'succeed'; readonly result: unknown }
  | { readonly kind: 'fail'; readonly error: DomainError }
  | { readonly kind: 'confirmCancel' }
  | { readonly kind: 'timeout' }

/**
 * 作业状态转移。
 *
 * 关键的**拒绝**（否则"不冒充取消"就形同虚设）：
 *  - `timeout` **不**产生 `cancelled` —— 它只把 `cancelRequested` 置位（"超时"是调用方的
 *    观察，不是作业的结局）。若作业从未运行，超时只是 no-op。
 *  - `succeed` / `fail` 在 `cancelRequested` 之后**不被接纳**（取消是协议，先到先得），
 *    但**返回 `false` 并保留相位**，让调用方知道"结果被丢弃、需要回收资源"。
 */
export function applyJobEvent(reg: JobRegistry, jobId: JobId, event: JobEvent): { readonly reg: JobRegistry; readonly accepted: boolean } {
  const job = Object.prototype.hasOwnProperty.call(reg.jobs, jobId) ? reg.jobs[jobId] : undefined
  if (!job) return { reg, accepted: false }
  const next = nextState(job.state, event)
  if (next === null) return { reg, accepted: false }
  return {
    reg: Object.freeze({ ...reg, jobs: Object.freeze({ ...reg.jobs, [jobId]: Object.freeze({ ...job, state: next }) }) }),
    accepted: true,
  }
}

function nextState(cur: JobState, event: JobEvent): JobState | null {
  switch (event.kind) {
    case 'start':
      return cur.phase === 'queued' ? Object.freeze({ phase: 'running' }) : null
    case 'progress':
      return cur.phase === 'running' ? Object.freeze({ phase: 'running', progress: event.progress }) : null
    case 'requestCancel':
      // 已终结的作业不能再被"请求取消"
      if (cur.phase === 'succeeded' || cur.phase === 'failed' || cur.phase === 'cancelled') return null
      return Object.freeze({ phase: 'cancelRequested' })
    case 'confirmCancel':
      // 只有"已请求取消"或"运行中"才能确认取消
      if (cur.phase === 'cancelRequested' || cur.phase === 'running' || cur.phase === 'queued') {
        return Object.freeze({ phase: 'cancelled' })
      }
      return null
    case 'succeed':
      // 取消请求之后到达的结果**不被接纳**（不冒充成功）
      if (cur.phase === 'cancelRequested' || cur.phase === 'cancelled') return null
      if (cur.phase === 'succeeded' || cur.phase === 'failed') return null
      return Object.freeze({ phase: 'succeeded', result: event.result })
    case 'fail':
      if (cur.phase === 'cancelRequested' || cur.phase === 'cancelled') return null
      if (cur.phase === 'succeeded' || cur.phase === 'failed') return null
      return Object.freeze({ phase: 'failed', error: event.error })
    case 'timeout':
      // **超时不冒充取消**：已有未终结的取消请求则保持之，否则只标记取消请求
      if (cur.phase === 'succeeded' || cur.phase === 'failed' || cur.phase === 'cancelled') return null
      return Object.freeze({ phase: 'cancelRequested' })
  }
}

/** 作业是否已终结（不再接受任何事件）。 */
export function isTerminal(state: JobState): boolean {
  return state.phase === 'succeeded' || state.phase === 'failed' || state.phase === 'cancelled'
}

/** 清理已终结作业（释放登记表；资源回收由 `admitCompletion` 的返回值驱动）。 */
export function reapTerminal(reg: JobRegistry): JobRegistry {
  const jobs: Record<JobId, Job> = {}
  for (const [id, job] of Object.entries(reg.jobs)) {
    if (!isTerminal(job.state)) jobs[id] = job
  }
  return Object.freeze({ ...reg, jobs: Object.freeze(jobs) })
}

// ─────────────────────────────────────────────────────────────────────────────
// 完成事件与接纳判定（负对照）
// ─────────────────────────────────────────────────────────────────────────────

/** 完成事件：**只**携带数据、错误和关联身份（明文）。 */
export interface EffectCompletion {
  readonly jobId: JobId
  readonly correlationId: string
  /** 完成时的绑定代数（发起时记录的那个）。 */
  readonly bindingGeneration: number
  /** 结果所对应的目标版本。 */
  readonly targetVersion: number
  readonly outcome: { readonly kind: 'success'; readonly data: unknown } | { readonly kind: 'failure'; readonly error: DomainError }
}

export interface AdmitDecision {
  /** 是否接纳该结果（应把它并入状态）。 */
  readonly admitted: boolean
  /** 是否必须回收该结果携带的资源（过期/已取消/已关闭 ⇒ 必须回收）。 */
  readonly release: boolean
  readonly reason: 'current' | 'staleVersion' | 'staleBinding' | 'jobUnknown' | 'jobCancelled'
}

/**
 * 接纳判定（**纯**）。
 *
 * 四条判据，缺一即负对照：
 *  1. 作业必须存在；
 *  2. 作业未被取消（取消是协议：已确认取消 ⇒ 结果丢弃 + 回收）；
 *  3. `bindingGeneration` 相符 —— 文档已关闭/重绑则结果过期（负对照）；
 *  4. `targetVersion` **不早于**当前版本 —— 旧结果不得覆盖新结果。
 *
 * 过期一律 `released: true`：「已获取资源必须回收」。
 * 把"要回收"做成返回值，是为了让"忘了 dispose"在类型上显形。
 */
export function admitCompletion(
  reg: JobRegistry,
  completion: EffectCompletion,
  current: { readonly bindingGeneration: number; readonly targetVersion: number },
): AdmitDecision {
  const job = Object.prototype.hasOwnProperty.call(reg.jobs, completion.jobId) ? reg.jobs[completion.jobId] : undefined
  if (!job) return Object.freeze({ admitted: false, release: true, reason: 'jobUnknown' })
  if (job.state.phase === 'cancelled' || job.state.phase === 'cancelRequested') {
    return Object.freeze({ admitted: false, release: true, reason: 'jobCancelled' })
  }
  if (completion.bindingGeneration !== current.bindingGeneration) {
    return Object.freeze({ admitted: false, release: true, reason: 'staleBinding' })
  }
  if (completion.targetVersion < current.targetVersion) {
    return Object.freeze({ admitted: false, release: true, reason: 'staleVersion' })
  }
  return Object.freeze({ admitted: true, release: false, reason: 'current' })
}

// ─────────────────────────────────────────────────────────────────────────────
// 保存完成 → 状态事件（接线）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把一次保存的接纳决定翻译成状态层要执行的动作。
 *
 * 注意本函数**不**直接改状态 —— 它只产出"该执行什么"的描述，
 * 由 `runtime/execution` 把它转成一条 `saveCompleted` 命令走**同一个** `reduceCommand`。
 * 这是"完成事件不是第二写通路"的落地方式。
 */
export interface SaveCompletionAction {
  readonly command: { readonly kind: 'saveCompleted'; readonly documentId: string; readonly sequence: number; readonly bindingGeneration: number; readonly outcome: { readonly kind: 'committed' } | { readonly kind: 'failed'; readonly code: string } | { readonly kind: 'superseded' } }
  readonly releaseResources: boolean
}

export function saveCompletionAction(
  documentId: string,
  sequence: number,
  completion: EffectCompletion,
  decision: AdmitDecision,
  targetBindingGeneration: number,
): SaveCompletionAction {
  if (!decision.admitted) {
    return Object.freeze({
      command: Object.freeze({
        kind: 'saveCompleted',
        documentId,
        sequence,
        bindingGeneration: completion.bindingGeneration,
        outcome: Object.freeze({ kind: 'superseded' }),
      }),
      releaseResources: decision.release,
    })
  }
  const outcome =
    completion.outcome.kind === 'success'
      ? Object.freeze({ kind: 'committed' as const })
      : Object.freeze({ kind: 'failed' as const, code: completion.outcome.error.code })
  return Object.freeze({
    command: Object.freeze({ kind: 'saveCompleted', documentId, sequence, bindingGeneration: targetBindingGeneration, outcome }),
    releaseResources: false,
  })
}
