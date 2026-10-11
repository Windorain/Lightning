/**
 * 冻结契约的**值类型出口**（`docs/contracts/web-kernel-contracts.md` §1 / §3）。
 *
 * ## 本文件的地位（#250 GF-5 收敛后的形态）
 *
 * 冻结契约是**文档**（P0/#251 B3），它明文写着「辅助类型在本文件中省略，其完整定义由
 * P1/P2 在 `web/src/` 落地时补齐 —— **补齐时不得改变本文件已冻结的语义**」。
 *
 * 本文件曾是 P2 侧的**第二份**契约定义（`EntityRef`/`Version`/`DomainError`/`Result`… 各一份），
 * 与 P1 的 `domain/identity` + `domain/errors` **同名同义并存**。那是转录期的集成点，
 * 但按 #171 退役纪律，长期并存即使测试全绿也不算完成 —— #250 裁决本批收敛为
 * **再导出**：
 *
 *  - 引用与版本（`EntityRef`/`ElementRef`/`PropertyId`/`PropertyRef`/`Version`/`ChangeSummary`）
 *    的唯一权威是 **`domain/identity`**；
 *  - 错误与结果（`DomainErrorCode`/`WouldBlockReason`/`DomainError`/`Result`/`ok`/`err`）
 *    的唯一权威是 **`domain/errors`**；
 *  - 命令结算（`CommandOutcome` 及其构造子）与几个**无家可归**的纯引用工具
 *    （`formatPropertyRef`/`localPropertyOf`/`sameEntityRef`/`valueOr`/`domainError`/`sameDomainError`）
 *    在本文件**唯一**定义 —— 它们不属 `domain/identity`（不是身份）也不属 `domain/errors`（不是错误）。
 *
 * 于是「全树只有一份 `EntityRef`/`Version`/`Result`/`DomainError`」成为**机械可测**的事实，
 * 而不是约定：本文件不再有 `export type X = {…}` / `export interface X {…}` 形式的契约定义。
 *
 * ## 为什么保留这个模块而不是删掉它
 *
 * `application/**` 与 `editors/**` 有 8 个模块从 `@/application/contracts` 取契约类型。
 * 保留一个**纯出口**让「契约面」有稳定入口（消费方不必知道某个类型住在
 * `domain/identity` 还是别处），同时不给任何类型第二次生命的可能 ——
 * 再导出的类型无法在此处被"顺手改掉"。
 *
 * ## 纯度
 *
 * 无 Vue / Three / DOM / IO 依赖（#249 §2.1）。除再导出外只含**纯函数**，
 * 且只 import `domain` 层的类型与纯工具（层深 2，符合公共出口约束）。
 */

import {
  samePropertyRef,
  type ChangeSummary,
  type ElementRef,
  type EntityOwnerKind,
  type EntityRef,
  type PropertyId,
  type PropertyRef,
  type Version,
} from '@/domain/identity'
import {
  err,
  ok,
  type DomainError,
  type DomainErrorCode,
  type Result,
  type WouldBlockReason,
} from '@/domain/errors'

// ─────────────────────────────────────────────────────────────────────────────
// §1 引用与版本 —— 唯一权威：`domain/identity`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 引用、元素身份、属性 ID、属性引用、版本、变更摘要。
 *
 * **不得**在此处重新定义它们：`domain/identity` 是唯一权威，
 * 重复定义会让「引用是值」变成「引用是两套不兼容的值」——
 * 这正是 #250 GF-5 的核心验收项（全树单一来源）。
 */
export type { ChangeSummary, ElementRef, EntityOwnerKind, EntityRef, PropertyId, PropertyRef, Version }

// ─────────────────────────────────────────────────────────────────────────────
// §3.2 错误分类 —— 唯一权威：`domain/errors`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 八个稳定错误码、`WouldBlock` 原因域、结构化错误与 `Result` 判别式。
 *
 * `Result` **不用异常**做领域失败：它是**值**，可以参与「多选一个失败即整体拒绝」的
 * 聚合（见 `property-commands.ts`），而异常会逼出 try/catch 控制流 ——
 * 那正是 #249 §6 要避免的「政策藏进调用方回调」。
 */
export type { DomainError, DomainErrorCode, Result, WouldBlockReason }
export { err, ok }

// ─────────────────────────────────────────────────────────────────────────────
// §3.1 CommandOutcome —— 本文件唯一
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 命令结算结果（契约 §3.1）：三分支**互斥且穷尽**。
 *
 * 拒绝**不得**同时报告 `applied`（#249 §5 明文）；`unchanged` 必须保持未改分支身份，
 * 但「创建了新容器」**不等于**内容变化（A06 负对照）。
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
// 引用工具（纯）—— 本文件唯一
// ─────────────────────────────────────────────────────────────────────────────

/** 成功则取 `value`，否则取 `fallback`（读面便利函数；不掩盖错误 —— 调用方拿不到 `Result` 时自行决定）。 */
export function valueOr<T>(r: Result<T>, fallback: T): T {
  return r.ok ? r.value : fallback
}

/**
 * 构造 `DomainError`：省略空 `params` 的噪声，但**不掩盖**必须携带的字段。
 *
 * 与 `domain/errors` 的逐码构造子（`invalidValue`/`readOnly`/…）并存是刻意的：
 * 前者是「按码分类」的书写方式（调用方知道是哪一类失败），
 * 本函数是「码本身是变量」的场合（如把既有失败的码复用到聚合结果上）。
 */
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

/** 实体引用相等：`kind` + `id` + 可选 `contentVersion`（值语义 ⇒ 可比较）。 */
export function sameEntityRef(a: EntityRef, b: EntityRef): boolean {
  return a.kind === b.kind && a.id === b.id && a.contentVersion === b.contentVersion
}

/**
 * 属性引用相等 —— 委托 `domain/identity` 的唯一实现。
 *
 * 两处各写一份相等判定必然漂移，而漂移会让「无业务变化返回 unchanged」
 * 在两条路径上给出不同答案（A08-7 的直接失败模式）。
 */
export { samePropertyRef }

/**
 * 稳定序列化（引用 → 字符串）：供去重、菜单/命令参数描述与诊断关联共用一份口径。
 *
 * 属性 ID 形如 `<objectTypeId>.<localId>`，而 **`objectTypeId` 自身含点**
 * （`lightning.block`、`lightning.annotation.text`）。因此本函数只做**拼接**，
 * 绝不对 `property` 做「按点切分」—— 切分需要知道 `objectTypeId`，
 * 那是注册表的事实，不是字符串的形状（见 `localPropertyOf` 的同类陷阱）。
 */
export function formatPropertyRef(ref: PropertyRef): string {
  let s = `${ref.owner.kind}:${ref.owner.id}.${ref.property}`
  if (ref.element) s += `@${ref.element.elementId}#${ref.element.topologyVersion}`
  if (ref.component !== undefined) s += `[${ref.component}]`
  return s
}

/**
 * 属性 ID → 对象类型内的**局部** ID。
 *
 * ## 为什么必须传 `objectTypeId`（这里踩过一次真坑）
 *
 * 属性 ID 是 `<objectTypeId>.<localId>`，而对象类型 ID **自带点**
 * （`lightning.block`、`lightning.annotation.text`）。于是
 * 「取第一个点之后的部分」会把 `lightning.block.pos` 解成 **`block.pos`**（错），
 * 正确结果是 `pos`。这个错误不会抛异常 —— 它让每个属性读面都变成 `MissingTarget`，
 * 进而让「无业务变化」被误判为「有变化」（A08-7 的失败即由此而来）。
 *
 * 故本函数**优先**用 `objectTypeId` 做前缀剥离（唯一权威做法）；
 * 只在调用方拿不到 `objectTypeId` 时退回「最后一个点」，并假设 `localId` 不含点
 * （本批全部声明满足此假设）。
 */
export function localPropertyOf(propertyId: string, objectTypeId?: string): string {
  if (objectTypeId !== undefined && objectTypeId !== '' && propertyId.startsWith(`${objectTypeId}.`)) {
    return propertyId.slice(objectTypeId.length + 1)
  }
  const dot = propertyId.lastIndexOf('.')
  return dot === -1 ? propertyId : propertyId.slice(dot + 1)
}
