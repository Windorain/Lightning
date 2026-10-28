/**
 * `domain/errors` —— **冻结的八项错误分类**（内核契约 §4.2）。
 *
 * 契约原文：「用"至少包括"冻结了这八个。本契约**不增不减**」：
 *  - 不再增：新增错误码会让各实现各自发明"本地错误"再映射，破坏"错误码稳定"；
 *  - 不再减：每一个都对应一条已批准的验收负对照，删掉即失去该负对照的落点。
 *
 * ## 重入的归类
 *
 * 内核契约 §4.2 把 `ReentrantCall` 处理为 `WouldBlockError.params.reason = 'reentrant'`
 * 而非第九个顶层码，并**明确要求确认或改回第九码**。本实现**采纳该取舍**，
 * 理由与契约一致：重入与忙是**同一恢复策略**（下一批次重试），分成两个码会让调用方的
 * 重试分支重复；`reason` 保留精确断言能力（负对照需要区分"发布订阅中重入"）。
 *
 * ## 为什么错误是**值**而不是 `Error` 子类
 *
 * 内核契约 §4.2 的 `ErrorBase` 是 `{ code, params, commandId?, jobId?, objectId?, version? }`：
 * 结构化参数供 UI 本地化与诊断关联，**不是拼好的自然语言**（「错误用稳定错误码与
 * 参数表达…不会因语言改变而改变命令逻辑或测试断言」）。`Error` 子类的 `message` 恰恰是
 * 拼好的自然语言，且 `stack` 携带运行时句柄信息 —— 两者都会破坏"错误是值"。
 * 故本模块产出纯数据；需要 `Error` 形态时由**适配器**在边界包装（不在纯核心里做）。
 */

import type { Version } from './identity'

/** 内核契约 §4.2 —— 八个稳定错误码（**冻结**）。 */
export type DomainErrorCode =
  | 'InvalidValue'
  | 'ReadOnly'
  | 'MissingTarget'
  | 'StaleReference'
  | 'DocumentBusy'
  | 'VersionConflict'
  | 'UnsupportedOperation'
  | 'WouldBlock'

/** `WouldBlock` 的细分原因（`reentrant` 不另立第九码）。 */
export type WouldBlockReason = 'busy' | 'reentrant' | 'incompatibleQueued'

/** 内核契约 §4.2 `ErrorBase`。 */
export interface DomainError {
  readonly code: DomainErrorCode
  /** 结构化参数（供 UI 本地化与诊断关联），不是拼好的自然语言。 */
  readonly params: Readonly<Record<string, string | number>>
  readonly commandId?: string
  readonly jobId?: string
  readonly objectId?: string
  readonly version?: Version
}

function mk(
  code: DomainErrorCode,
  params: Record<string, string | number>,
  extra?: Omit<DomainError, 'code' | 'params'>,
): DomainError {
  const out: DomainError = { code, params: Object.freeze({ ...params }) }
  const merged = { ...out, ...(extra ?? {}) } as DomainError
  return Object.freeze(merged)
}

// ── 逐个构造子（内核契约 §4.2 表格的"触发条件"列即参数语义） ──────────────────────

/**
 * 值本身不合法。契约严禁的替代做法：悄悄夹取并宣称目标已实现。
 * `params` 建议带 `property`、`reason`；越界时带 `min`/`max`/`value`。
 */
export function invalidValue(params: Record<string, string | number>, extra?: Omit<DomainError, 'code' | 'params'>): DomainError {
  return mk('InvalidValue', params, extra)
}

/**
 * 目标存在但本上下文无写权。
 * 契约严禁：「用"静默忽略"当成功；或用文档级单一布尔代替按拥有者判定」。
 * ⇒ `params.owner` 必须写清是**哪个拥有者**拒绝，而不是"文档只读"。
 */
export function readOnly(params: Record<string, string | number>, extra?: Omit<DomainError, 'code' | 'params'>): DomainError {
  return mk('ReadOnly', params, extra)
}

/** 目标不存在。契约严禁：用默认值冒充成功。 */
export function missingTarget(params: Record<string, string | number>, extra?: Omit<DomainError, 'code' | 'params'>): DomainError {
  return mk('MissingTarget', params, extra)
}

/** 引用存在但版本已过期。契约严禁：静默猜配到"同名对象"或"相同坐标的新对象"。 */
export function staleReference(params: Record<string, string | number>, extra?: Omit<DomainError, 'code' | 'params'>): DomainError {
  return mk('StaleReference', params, extra)
}

/** 同文档已被另一上下文持有修改租约。契约严禁：静默排队等未来场景。 */
export function documentBusy(params: Record<string, string | number>, extra?: Omit<DomainError, 'code' | 'params'>): DomainError {
  return mk('DocumentBusy', params, extra)
}

/** 提交所依据的版本已不是当前版本。契约严禁：越序应用。 */
export function versionConflict(params: Record<string, string | number>, extra?: Omit<DomainError, 'code' | 'params'>): DomainError {
  return mk('VersionConflict', params, extra)
}

/**
 * 能力不存在于本 profile/构建。契约要求它必须可由**运行时**拒绝，不只靠 UI 隐藏按钮
 * （负对照「只隐藏按钮仍导入编辑模块」必须判红）。
 */
export function unsupportedOperation(params: Record<string, string | number>, extra?: Omit<DomainError, 'code' | 'params'>): DomainError {
  return mk('UnsupportedOperation', params, extra)
}

/**
 * 现在不能执行，但条件可能变化。`reason` 取值见 `WouldBlockReason`。
 * 契约严禁：阻塞等待；或越序执行。
 */
export function wouldBlock(
  reason: WouldBlockReason,
  params: Record<string, string | number> = {},
  extra?: Omit<DomainError, 'code' | 'params'>,
): DomainError {
  return mk('WouldBlock', { reason, ...params }, extra)
}

/** 发布订阅中重入（负对照「允许回调直接推进版本」必须判红）——`WouldBlock` 的一个原因。 */
export function reentrantCall(commandId?: string): DomainError {
  return wouldBlock('reentrant', {}, commandId === undefined ? undefined : { commandId })
}

/** 八码全集，供测试断言"不增不减"。 */
export const DOMAIN_ERROR_CODES: readonly DomainErrorCode[] = Object.freeze([
  'InvalidValue',
  'ReadOnly',
  'MissingTarget',
  'StaleReference',
  'DocumentBusy',
  'VersionConflict',
  'UnsupportedOperation',
  'WouldBlock',
])

/** 稳定错误码 → 判别（不依赖语言）。 */
export function isDomainError(v: unknown): v is DomainError {
  if (typeof v !== 'object' || v === null) return false
  const c = (v as { code?: unknown }).code
  return typeof c === 'string' && (DOMAIN_ERROR_CODES as readonly string[]).includes(c)
}

// ── Result（记号约定） ───────────────────────────────────────────────────

export type Result<T> = { ok: true; value: T } | { ok: false; error: DomainError }

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function err<T>(error: DomainError): Result<T> {
  return { ok: false, error }
}

/** 取出成功值，失败时抛 —— 仅供**已知会成功**的调用点（测试/内部断言），不用于业务分支。 */
export function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`unwrap on failure: ${r.error.code}`)
  return r.value
}
