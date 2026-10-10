/**
 * 冻结契约的**值类型**（`docs/contracts/web-kernel-contracts.md` §1 / §3）。
 *
 * ## 本文件的地位与边界
 *
 * 冻结契约是**文档**（P0/#251 B3），它明文写着「辅助类型在本文件中省略，其完整定义由
 * P1/P2 在 `web/src/` 落地时补齐 —— **补齐时不得改变本文件已冻结的语义**」。
 * 本文件是 P2（#253）需要的那一部分的落地：引用是**值**、错误分类**恰好八项**、
 * `Result` 判别式、`CommandOutcome` 三分支。
 *
 * ## 为什么单列一个模块（而不是塞进 properties.ts）
 *
 * `EntityRef` / `Version` / `DomainError` 是**跨批次**的：P1（#252）的
 * `ApplicationState`/`Transition`、P5 的求值键、P9 的保存基线都要用同一批定义。
 * 把它们藏在 `properties.ts` 里会诱使后续批次各写一份「本地版本」再互相映射 ——
 * 这正是契约 §3.2 选择理由点名的失败模式（「新增错误码会让 P1–P11 各自发明『本地错误』
 * 再映射，破坏『错误码稳定』」）。
 *
 * ## 与 P1 的重叠处理（**已登记的集成点，不是静默重复定义**）
 *
 * P1 与 P2 由 #250 判定为**可并行开发**（开发依赖同为 #251），两者都需要这批值类型。
 * 本文件是 P2 侧的落地；合流时以**一份**为准（Semantic 完全相同，属文本级冲突）。
 * P2 不擅自把 `ApplicationState`/`Transition`/`ExecutionInputs` 也定义掉 ——
 * 那三个是 P1 `domain/document`+`runtime/execution` 的职责面，本文件只定义
 * 「引用与结果」这类**无状态**的值。
 *
 * ## 纯度
 *
 * 无 Vue / Three / DOM / IO 依赖；全部为 `Readonly<{...}>` 值语义类型与纯函数
 * （#249 §2.1）。本文件不 import 本层之外的任何实现。
 */

// ─────────────────────────────────────────────────────────────────────────────
// §0 Result 判别式
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `Result<T>`（契约 §0 记号表）：成功带值、失败带**结构化** `DomainError`。
 *
 * 不用异常做领域失败：`Result` 是**值**，可以参与「多选一个失败即整体拒绝」的
 * 聚合（见 `property-commands.ts`），而异常会逼出 try/catch 控制流 ——
 * 那正是 #249 §6 要避免的「政策藏进调用方回调」。
 */
export type Result<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: DomainError }>

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function err<T>(error: DomainError): Result<T> {
  return { ok: false, error }
}

/** 成功则取 `value`，否则取 `fallback`（读面便利函数；不掩盖错误 —— 调用方拿不到 `Result` 时自行决定）。 */
export function valueOr<T>(r: Result<T>, fallback: T): T {
  return r.ok ? r.value : fallback
}

// ─────────────────────────────────────────────────────────────────────────────
// §1.1 引用是值
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 具名拥有者种类（契约 §1.1）。
 *
 * **显式而非 ID 前缀编码**：契约 §1.1 的选择理由写明「编码前缀会在新增实体种类时产生
 * 『谁认识这个前缀』的中心化分支」。故这里是可扩展的字符串集，
 * 新增种类**不改本文件**（`string & {}` 保留字面量提示又不封闭联合）。
 */
export type EntityOwnerKind =
  | 'document'
  | 'objectData'
  | 'object'
  | 'element'
  | 'editContext'
  | 'workspace'
  | 'asset'
  | 'shellSettings'
  | 'toolSettings'
  | (string & {})

/** 具名拥有者引用（契约 §1.1）。**不含**对象实例 / Vue ref / Three 对象 / DOM 节点。 */
export type EntityRef = Readonly<{
  kind: EntityOwnerKind
  /** 稳定 ID；保存并重开后同一实体得到同一 `id`（#249 §15 第 9 条要求）。 */
  id: string
  /** 内容版本；用于判定引用是否过期（见 `StaleReference`）。 */
  contentVersion?: number
}>

/** 稳定子元素身份（契约 §1.2）。**不得**使用 GPU 索引。 */
export type ElementRef = Readonly<{
  elementId: string
  /** 该数据当前拓扑版本；变化后旧引用必须返回 `StaleReference`，**不静默猜配**。 */
  topologyVersion: number
}>

/** 注册于 RNA 的稳定属性 ID（契约 §1.3）。 */
export type PropertyId = string

/**
 * 属性引用（契约 §1.3）—— RNA 的唯一寻址单位。
 *
 * **是值**：可比较、可序列化、**不含 setter 闭包**（#249 §6 明文）。
 * 多选场景下它表示**一个**目标；批量修改由命令承载（§3.3），
 * 不是让它变成数组 —— 数组化会让「一个目标不可改则整体拒绝」失去唯一落点。
 */
export type PropertyRef = Readonly<{
  owner: EntityRef
  property: PropertyId
  element?: ElementRef
  /** 向量/四元数的分量下标；与标量动画共用同一寻址（契约 §1.3 选择理由）。 */
  component?: number
}>

/** 内容版本（契约 §1.4）。`documentVersion` **只**因内容变化推进。 */
export type Version = Readonly<{
  documentVersion: number
  contentVersion?: number
}>

/** 变更摘要（契约 §1.4）：历史、脏标记与诊断的最小充分描述。 */
export type ChangeSummary = Readonly<{
  changedProperties: readonly PropertyRef[]
  createdEntities: readonly EntityRef[]
  removedEntities: readonly EntityRef[]
  structurallyShared: boolean
}>

/** 空变更摘要 —— 供 `unchanged` 与「新建容器 ≠ 内容变化」（A06 负对照）使用。 */
export const EMPTY_CHANGE_SUMMARY: ChangeSummary = {
  changedProperties: [],
  createdEntities: [],
  removedEntities: [],
  structurallyShared: true,
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.2 错误分类（八项，冻结）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 八个稳定错误码（契约 §3.2 表）。
 *
 * **不增不减**：不再增 —— 新增会让各批各自发明本地错误再映射；
 * 不再减 —— 每一项都对应一条已批准的验收负对照。
 *
 * `ReentrantCall` 不在本列（契约 §3.2 选择理由）：它是
 * `WouldBlockError.params.reason = 'reentrant'` 的一个取值（契约 §8 **GF-1**）。
 */
export const DOMAIN_ERROR_CODES = [
  'InvalidValue',
  'ReadOnly',
  'MissingTarget',
  'StaleReference',
  'DocumentBusy',
  'VersionConflict',
  'UnsupportedOperation',
  'WouldBlock',
] as const

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number]

/** `WouldBlockError.params.reason` 的取值域（含 GF-1 的 `reentrant`）。 */
export type WouldBlockReason = 'busy' | 'reentrant' | 'queued-incompatible'

/**
 * 结构化错误（契约 §3.2）。
 *
 * `params` 是**结构化参数**（供 UI 本地化与诊断关联），不是拼好的自然语言；
 * 错误码**稳定**，不因语言改变（#249 §19.7）。`code` 是唯一判据，
 * 消费方不得用 `message` 文本分支。
 */
export type DomainError = Readonly<{
  code: DomainErrorCode
  params: Readonly<Record<string, string | number>>
  /** 诊断关联身份（#249 §19.9）。 */
  commandId?: string
  jobId?: string
  objectId?: string
  version?: Version
}>

/** 构造 `DomainError`：省略空 `params` 的噪声，但**不掩盖**必须携带的字段。 */
export function domainError(
  code: DomainErrorCode,
  params: Readonly<Record<string, string | number>> = {},
  extra: Omit<DomainError, 'code' | 'params'> = {},
): DomainError {
  return { code, params, ...extra }
}

/** 判断两个错误是否为同一「类」（同码 + 同参数）—— 供多选聚合去重与测试断言。 */
export function sameDomainError(a: DomainError, b: DomainError): boolean {
  if (a.code !== b.code) return false
  const ka = Object.keys(a.params).sort()
  const kb = Object.keys(b.params).sort()
  if (ka.length !== kb.length) return false
  return ka.every((k, i) => k === kb[i] && a.params[k] === b.params[k])
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.1 CommandOutcome
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 命令结算结果（契约 §3.1）：三分支**互斥且穷尽**。
 *
 * 拒绝**不得**同时报告 `applied`（#249 §5 明文）；`unchanged` 必须保持未改分支身份，
 * 但「创建了新容器」**不**等于内容变化（A06 负对照）。
 */
export type CommandOutcome =
  | Readonly<{ status: 'applied'; version: Version; changes: ChangeSummary }>
  | Readonly<{ status: 'unchanged'; version: Version }>
  | Readonly<{ status: 'rejected'; error: DomainError }>

export const appliedOutcome = (version: Version, changes: ChangeSummary): CommandOutcome => ({
  status: 'applied',
  version,
  changes,
})

export const unchangedOutcome = (version: Version): CommandOutcome => ({ status: 'unchanged', version })

export const rejectedOutcome = (error: DomainError): CommandOutcome => ({ status: 'rejected', error })

// ─────────────────────────────────────────────────────────────────────────────
// 引用工具（纯）
// ─────────────────────────────────────────────────────────────────────────────

/** 实体引用相等：`kind` + `id` + 可选 `contentVersion`（值语义 ⇒ 可比较）。 */
export function sameEntityRef(a: EntityRef, b: EntityRef): boolean {
  return a.kind === b.kind && a.id === b.id && a.contentVersion === b.contentVersion
}

/** 属性引用相等：**逐字段**比较（含 `element` 与 `component`）。 */
export function samePropertyRef(a: PropertyRef, b: PropertyRef): boolean {
  if (!sameEntityRef(a.owner, b.owner)) return false
  if (a.property !== b.property) return false
  if (a.component !== b.component) return false
  const ea = a.element
  const eb = b.element
  if (ea === undefined || eb === undefined) return ea === eb
  return ea.elementId === eb.elementId && ea.topologyVersion === eb.topologyVersion
}

/** 稳定序列化（引用 → 字符串）：供去重、菜单/命令参数描述与诊断关联共用一份口径。 */
export function formatPropertyRef(ref: PropertyRef): string {
  const parts = [`${ref.owner.kind}:${ref.owner.id}`, ref.property]
  if (ref.element) parts.push(`@${ref.element.elementId}#${ref.element.topologyVersion}`)
  if (ref.component !== undefined) parts.push(`[${ref.component}]`)
  return parts.join('.')
}
