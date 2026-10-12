/**
 * `adapters/files/fidelityRecord` —— **旧格式未知字段的适配器保真记录**
 * （#249 §12 第 3 段、§15 第 2 条；#260 A20「静默丢未知语义」负对照）。
 *
 * ## 本模块替代的旧机制
 *
 * 旧 `RuntimeDocument` 把**未知顶层字段收进 `_extra` 字段袋**，并在 `serialize()` 时
 * 原样吐回（`context/runtimeDocument.ts:114-115,335-348` 收集、`:237` 写回、
 * `:317` clone）。它解决了"不丢字段"，代价是三件结构性问题：
 *
 * | 问题 | 后果 |
 * |---|---|
 * | 未知字段进**核心**文档 | 核心模型出现无界字段袋，`#249` §15 第 2 条明令「核心无 raw JSON/格式字段袋」 |
 * | 记录里**没有来源格式/版本** | 字段是"哪个格式、哪个版本"的语义在重写后就丢了；下游无从判断还能不能解释它 |
 * | 编辑后**无有效性判断** | 字段无条件随文档往返，即使它描述的索引空间已被编辑改掉（变成静默错误数据） |
 *
 * 本模块按 `#249` §12 的原文重建这三件事：
 *
 * > 「未知字段若必须往返保留，放在带**源格式/源版本**的适配器**保真记录**中；
 * > 编辑发生后对其**有效性作明确判断**。不能将原始 JSON 重新塞进核心 `_extra`，
 * > 也不能静默丢失无法解释的语义。」
 *
 * 于是：
 *
 * 1. **记录是适配器的值**（{@link FidelityRecord}），不是文档的一部分 —— 存不进核心，
 *    因为有类型保证：`Document` 里没有能放下它的字段（`domain/document.ts:122-125`）。
 * 2. 记录**自带** `sourceFormat` / `sourceVersion`。
 * 3. 编辑之后必须调 {@link judgeFidelityAfterEdit} 得到一个**显式裁定**
 *    （{@link FidelityVerdict}）—— 没有"默认仍然有效"这条路。
 *
 * ## 为什么裁定要有三种，而不是布尔
 *
 * 布尔（`valid: boolean`）会把两件恢复策略完全不同的事压成一个 `false`：
 *  - **字段被编辑删掉了** ⇒ 再写回等于**复活已删除的内容**（必须丢弃）；
 *  - **字段赖以定位的索引空间变了**（例如帧序/格坐标被改过）⇒ 字段内容还在，
 *    但它解释的对象可能已经移动（**无法自动判定**，必须请调用方重新解释或显式降级）。
 *
 * 两者对调用方的动作不同，故 {@link FidelityVerdict} 分开表达，且 `stale` 分支
 * 强制携带 `reason` —— 于是"我判了但它过期了"不能只写一个 `false` 了事。
 *
 * ## 纯度
 *
 * 无 IO、无 DOM、无时钟；`fields` 逐层冻结。并不 import 任何旧层
 * （`adapters` 的层内导入不受公共出口深度约束，跨层只吃 `domain/` 的公共出口）。
 */

import { invalidValue, type DomainError, type Result, ok, err } from '@/domain/errors'
import { digestOf } from '@/domain/identity'
// #301 P10f D1(b)：键口径的唯一权威（与 recovery/save 同族）。
import { fidelityStoreKey, instanceIdentity } from '@/application/recovery'

/**
 * 核心文档里**禁止**出现的字段袋键名。
 *
 * 这既是一条命名约定，也是可执行判据的锚点：{@link hasCoreExtraBag} 与测试都引用它，
 * 而不是各写一遍字面量（写第二遍就会漂移）。
 */
export const CORE_EXTRA_BAG_KEY = '_extra'

/**
 * 保真记录（#249 §12：**带源格式/源版本**）。
 *
 * `fields` 只含**无法被本适配器解释**的顶层字段 —— 能解释的字段（`frames` /
 * `cellGrid` / `materialPalette` …）不进这里，它们有类型化模型。
 * 这个边界很重要：把能解释的字段也塞进来，会让"哪些字段真的没人懂"永远查不出来。
 */
export interface FidelityRecord {
  /** 源格式标识（`'Plain'` / `'Envelope'` / `'StructureData'` / `'World'` / `'V2Plain'`…）。 */
  readonly sourceFormat: string
  /**
   * 源版本。
   *
   * 用**文件自己声明的**版本串（`format_version` / `schemaVersion` / `payloadEncoding`），
   * 不用"我们解析器内部的版本号" —— 后者无法回答"这份字段来自哪个年代的文件"。
   */
  readonly sourceVersion: string
  /** 未知顶层字段（键序保留；值原样持有，不做深拷贝改造）。 */
  readonly fields: Readonly<Record<string, unknown>>
}

export interface CaptureFidelityInput {
  readonly sourceFormat: string
  readonly sourceVersion: string
  /** 原始解析结果（对象）。 */
  readonly raw: unknown
  /** 本适配器**能解释**的顶层键（其余进记录）。 */
  readonly knownKeys: readonly string[]
}

/**
 * 采集保真记录。
 *
 * 三条纪律：
 *  1. `_extra` **不**被当作未知字段收集 —— 它是旧机制的名字，收进来等于把旧
 *     `_extra` 换个地方复活（且会产生 `_extra._extra` 这种不可解释的嵌套）；
 *  2. `knownKeys` 之外**一律**进记录（宁可多留，不可静默丢）；
 *  3. 空记录也返回（`fields: {}`），由调用方决定要不要存 —— 不返回 `null`
 *     让"没有未知字段"与"采集失败"长得不一样。
 */
export function captureFidelity(input: CaptureFidelityInput): Result<FidelityRecord> {
  const raw = input.raw
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return err(invalidValue({ reason: 'fidelitySourceNotObject', sourceFormat: input.sourceFormat }))
  }
  const known = new Set(input.knownKeys)
  const src = raw as Record<string, unknown>
  const fields: Record<string, unknown> = {}
  for (const key of Object.keys(src)) {
    if (key === CORE_EXTRA_BAG_KEY) continue
    if (known.has(key)) continue
    fields[key] = src[key]
  }
  return ok(Object.freeze({ sourceFormat: input.sourceFormat, sourceVersion: input.sourceVersion, fields: Object.freeze(fields) }))
}

/** 记录里的字段名（稳定排序 —— 供证据输出与对账，顺序不依赖采集顺序）。 */
export function fidelityFieldNames(record: FidelityRecord): readonly string[] {
  return Object.freeze(Object.keys(record.fields).sort())
}

/**
 * 记录是否**有内容**可保。
 *
 * 与"记录存在"分开：一个空记录放在产物旁边只会让人以为"这里有些要保的东西"。
 */
export function hasFidelityFields(record: FidelityRecord): boolean {
  return Object.keys(record.fields).length > 0
}

/** 记录的稳定摘要（键序无关；供"两次读取得到同一份字段集"的对账）。 */
export function fidelityDigest(record: FidelityRecord): number {
  return digestOf({ sourceFormat: record.sourceFormat, sourceVersion: record.sourceVersion, fields: record.fields })
}

// ─────────────────────────────────────────────────────────────────────────────
// 编辑后的有效性判断（#249 §12：「编辑发生后对其有效性作明确判断」）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 编辑事实。
 *
 * **全部由调用方显式给出** —— 本模块**不**去比较前后两份文档来猜"什么变了"。
 * 理由：#249 §2.1 要求纯函数显式输入；而且"猜"会造出第二套"什么算结构变化"的判据，
 * 与 `domain/document.withContent` 的内容身份判据漂移。
 */
export interface FidelityEdit {
  /** 编辑中被**移除**的顶层键（例如删掉了 `captureWorld`）。 */
  readonly removedRootKeys: readonly string[]
  /**
   * 编辑中被改动的、**会移动索引空间**的顶层键
   * （`frames` / `cellGrid` / `cellPartsGrid` / `partLists` / `blockPalette` …）。
   *
   * 为什么单列这一类而不是"所有被改的键"：未知字段最常见的作用是**通过下标引用
   * 别的结构**（说明格、部件、调色板槽位）。索引空间一动，记录里的下标就可能指向
   * 别的东西 —— 这是唯一需要"请人重新解释"的情形；纯粹的元数据改动（`author`）
   * 不影响它。
   */
  readonly indexSpaceKeys: readonly string[]
}

/** 显式裁定（三态；见文件头「为什么裁定要有三种」）。 */
export type FidelityVerdict =
  | { readonly status: 'valid' }
  | {
      readonly status: 'stale'
      readonly reason: 'indexSpaceMoved'
      /** 被改动的索引空间键（诊断用）。 */
      readonly keys: readonly string[]
      /** 记录里**可能**因此失效的字段名（保守：全部字段都可能引用索引）。 */
      readonly atRiskFields: readonly string[]
    }
  | {
      readonly status: 'dropped'
      readonly reason: 'fieldRemovedByEdit'
      /** 被编辑移除、因而**不得**再写回的字段名。 */
      readonly removedFields: readonly string[]
    }

/**
 * 编辑后裁定保真记录是否仍可写回。
 *
 * 顺序**是判据的一部分**：先看"字段是不是已经被删掉了"（确定性丢弃），
 * 再看"索引空间是不是动过"（不确定性，需重新解释）。反过来会让一个已被删除的
 * 字段先被报成 `stale`，于是调用方去"重新解释"一个已经不存在的字段。
 */
export function judgeFidelityAfterEdit(record: FidelityRecord, edit: FidelityEdit): FidelityVerdict {
  const removed = new Set(edit.removedRootKeys)
  const removedFields = Object.keys(record.fields)
    .filter((k) => removed.has(k))
    .sort()
  if (removedFields.length > 0) {
    return Object.freeze({
      status: 'dropped' as const,
      reason: 'fieldRemovedByEdit' as const,
      removedFields: Object.freeze(removedFields),
    })
  }
  if (edit.indexSpaceKeys.length > 0) {
    return Object.freeze({
      status: 'stale' as const,
      reason: 'indexSpaceMoved' as const,
      keys: Object.freeze([...edit.indexSpaceKeys]),
      // 保守方向：**全部**字段都列进来。未知字段的语义没人懂，声称"这个字段不受影响"
      // 就是一次无人能证伪的猜测 —— 而那正是"静默保留错误数据"的入口。
      atRiskFields: Object.freeze(fidelityFieldNames(record)),
    })
  }
  return Object.freeze({ status: 'valid' as const })
}

/**
 * 把裁定翻译成结构化错误（供必须中止的路径使用）。
 *
 * `dropped` 是**确定性**结论 ⇒ `InvalidValue`（调用方拿着它去裁剪字段）；
 * `stale` 是**能力不足**结论（"现在判不了"）⇒ `UnsupportedOperation`
 * （契约 §3.2：能力不存在于本 profile/构建，且**严禁用近似顶替**）。
 */
export function fidelityVerdictError(verdict: FidelityVerdict, sourceFormat: string): DomainError | null {
  if (verdict.status === 'valid') return null
  if (verdict.status === 'dropped') {
    return invalidValue({
      reason: 'fidelityFieldRemovedByEdit',
      sourceFormat,
      fields: verdict.removedFields.join(','),
    })
  }
  return {
    code: 'UnsupportedOperation',
    params: Object.freeze({
      reason: 'fidelityIndexSpaceMoved',
      sourceFormat,
      keys: verdict.keys.join(','),
      atRiskFields: verdict.atRiskFields.length,
    }),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 「不塞核心 `_extra`」的可执行面
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 文档里是否出现核心字段袋 `_extra`。
 *
 * 为什么这是一个**独立导出**而不是顺手内联：`#249` §15 第 2 条的删除验收是
 * 「核心无 raw JSON/格式字段袋」，而"没有字段袋"如果只写在注释里就无法被检查。
 * 本函数是那条验收的唯一判定点（核心侧与被测文档侧引用同一实现）。
 */
export function hasCoreExtraBag(doc: unknown): boolean {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return false
  return Object.prototype.hasOwnProperty.call(doc as Record<string, unknown>, CORE_EXTRA_BAG_KEY)
}

/**
 * 保真记录的存储键（**旁置**，不写进文档）。
 *
 * ## 为什么是旁置键而不是文档内的字段
 *
 * `#249` §12 只说"放在带源格式/源版本的适配器保真记录中"，没说放进产物。
 * 而放进产物有两条硬冲突：
 *  - **Plain 逐字节**（B-1）要求命令通道产物字节不变 —— 往里加一个键就直接违反；
 *  - 未知字段写进文档根，等于把它们重新变成**文档的一部分**，即 `_extra` 的同构复活
 *    （§15 第 2 条要退役的正是"核心含格式字段袋"）。
 *
 * ## ⚠️ #301 P10f D1(b)：本函数**已不再是键的权威**（它现在只是转发）
 *
 * 原先它自己拼 `lk.fidelity.v1.<文档ID>.record` —— 一个与恢复副本/正式保存家族
 * **八处不兼容**的游离方案（缺 scope/instance 段、无解析器、裸 `string`、
 * 版本硬编码、空 id 静默降级为 `'unnamed'`、且不被 `artifactKindOfKey` 识别）。
 *
 * 现在键口径的**唯一权威**是 `application/recovery.ts` 的 {@link fidelityStoreKey}
 * （与 `recoveryStoreKey`/`saveStoreKey` 同族、同构造与解析纪律）。
 * 本函数保留**只为测试**：P9–P10 期间它零生产调用方，故改口径**无迁移负担**。
 *
 * ⚠️ **签名刻意不变**（仍收裸 `documentId` 并返回 `string`）：改了会动到既有测试的
 * 形状，而本批已判定"保留一个测试用的旧形状转发"比"改签名带来的判据扰动"更划算。
 * **新代码一律用 `fidelityStoreKey(identity, documentId)`**（它返回 `Result`、
 * 带 scope/instance 段、可解析）。本函数的存在**不**构成第二套键口径 ——
 * 它没有自己的拼接逻辑，只是把参数补成 `default` 域再转发。
 */
export function fidelityStorageKey(documentId: string): string {
  // 空 id：同族权威口径是**显式拒绝**（`Result` 的 `err`），而本转发函数的签名
  // 不允许返回 `Result` ⇒ 按旧的可观测行为落到 `'unnamed'`（**不产生空段**）。
  // ⚠️ 归一化**只做这一次**，然后**单次**调权威构造器 —— 不存在第二套拼接。
  const id = documentId.trim() === '' ? 'unnamed' : documentId
  const key = fidelityStoreKey(instanceIdentity('workbench', 'default'), id)
  // `id` 已保证非空 ⇒ 权威构造器不可能失败。若真失败，说明它的口径变了
  // （本转发的前提被破坏）—— 那是**实现缺陷**，用显式串暴露而不是静默造键。
  return key.ok ? key.value : 'lk.fidelity.invalid'
}

/** 记录 → 可持久化 JSON（纯；键序稳定，供存储适配器直接写）。 */
export function serializeFidelity(record: FidelityRecord): string {
  return JSON.stringify({
    sourceFormat: record.sourceFormat,
    sourceVersion: record.sourceVersion,
    fields: record.fields,
  })
}

/** 持久化 JSON → 记录。形状不合 ⇒ `InvalidValue`（不用默认值冒充成功，契约 §3.1）。 */
export function parseFidelity(text: string): Result<FidelityRecord> {
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch {
    return err(invalidValue({ reason: 'fidelityNotJson' }))
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return err(invalidValue({ reason: 'fidelityNotObject' }))
  }
  const o = raw as Record<string, unknown>
  if (typeof o.sourceFormat !== 'string' || typeof o.sourceVersion !== 'string') {
    return err(invalidValue({ reason: 'fidelityMissingSourceIdentity' }))
  }
  if (o.fields === null || typeof o.fields !== 'object' || Array.isArray(o.fields)) {
    return err(invalidValue({ reason: 'fidelityFieldsNotObject' }))
  }
  const fields = { ...(o.fields as Record<string, unknown>) }
  // 读到旧的 `_extra` 形态时**显式拒绝**而不是顺手接受：接受它等于让旧机制
  // 通过存储层悄悄回来（它已经不在文档里，但会重新成为"必须保真的字段袋"）。
  if (Object.prototype.hasOwnProperty.call(fields, CORE_EXTRA_BAG_KEY)) {
    return err(invalidValue({ reason: 'fidelityRecordContainsExtraBag', key: CORE_EXTRA_BAG_KEY }))
  }
  return ok(Object.freeze({ sourceFormat: o.sourceFormat, sourceVersion: o.sourceVersion, fields: Object.freeze(fields) }))
}
