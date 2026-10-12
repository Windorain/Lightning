/**
 * `application/recovery` —— **恢复副本的纯政策**（#249 §19.5；#260 A31 `recovery-storage`）。
 *
 * ## 本模块替代的旧机制（#249 §15 退役矩阵的"存储面"）
 *
 * | 旧机制 | 位置 | 旧行为的问题 | 本模块的替代 |
 * |---|---|---|---|
 * | 裸存储访问 + 无命名空间键 | `viewer/preferences.ts`（`'lightning.prefs'`）、`keymap/index.ts`（`'lightning-workbench-keymap'`）、`runtime/shellSettings.ts`（`'wsr-wb-lang'`/`'wb-theme'`） | 键无命名空间/版本/实例身份；多标签写**同一个**键 ⇒ 最后写者无提示覆盖 | {@link recoveryStoreKey}/{@link saveStoreKey}：前缀 + 种类 + schema 版本 + 应用范围 + 文档身份 +（恢复副本额外的）必要实例身份 |
 * | 存储写入的异常被**空 catch 吞掉** | `viewer/preferences.ts` | 配额不足与存储不可用被吞，上层无从区分"写成功"与"什么都没发生" | {@link StorageFailure} 判别式 + {@link RecoveryWriteOutcome}；写失败**不可能**被上层读成正式保存成功 |
 * | 无"恢复副本"概念（只有正式保存与运行期内存态） | —— | 刷新/崩溃即丢未保存修改，或反过来把恢复写当成已保存 | {@link RecoveryPayload} + {@link validateRecoveryCopy} + {@link decideRecoveryAdoption} + {@link adoptRecoveryCopy} |
 *
 * ## 三条**结构上不可表达**的事（A31 的判据落在类型上，不靠纪律）
 *
 * 1. **半次拖动不进恢复副本**：{@link RecoverySourceSnapshot} 只有
 *    `id`/`scene`/`animation`/`version` 四个字段 —— `EditContext.interaction`
 *    （暂存 `overrides`/`startTransforms`/`totalDisplacement`）在类型上**无处可放**；
 *    {@link RecoveryPayload} 同样没有 `interaction` 字段。
 * 2. **写恢复副本不表示正式保存成功**：{@link RecoveryWriteOutcome} 的每一个分支都带
 *    `artifact: 'recovery-copy'`，且**没有** `saved`/`baselineChanged`/`document` 字段；
 *    本模块既不 import 也不调用 `beginSave`/`completeSave`（正式保存结算的**唯一**入口，
 *    见 `domain/document`）⇒ "恢复写成功"无法被误报为"Wiki 上传成功"。
 * 3. **坏副本不能替换有效内容**：{@link RecoveryAdoption} 的 `reject` 分支**不携带任何内容**
 *    （没有 `payload`/`scene`/`animation`）—— 调用方连"误用坏副本"的原料都拿不到；
 *    `adoptRecoveryCopy` 在 reject 时返回**同一个** `Document` 对象（保留当前内容）。
 *
 * ## 基线不动（#249 §19.5「成功写恢复副本不改变文档保存基线」）
 *
 * 写入侧的函数只接受 {@link RecoverySourceSnapshot}（**看不见**
 * `saveBaseline`/`savedSequence`/`history`），且返回值里没有文档；
 * 采纳侧经 `withContent` 只替换 `scene`/`animation`，并把
 * `baselinePreserved` 按**实际比较**算出（不是硬写 `true`）。
 * {@link baselineFingerprint} 是给测试与诊断用的正断言钩子。
 *
 * ## 与适配器的分工（#249 §4 规则 4）
 *
 * 端口 {@link RecoveryStorePort} 的**定义**在本纯层（这样两侧无需互相 import），
 * **实现**在 `adapters/storageMemory.ts`（内存 + 可注入故障）与
 * `adapters/storageBrowser.ts`（宿主键值存储的包装，存储对象由注入传入）。
 * 本文件因此不 import 任何 DOM/IO/Vue/Three，也不读时钟 ——
 * 它连 `Storage` 这个**类型**都不提，只谈"键与值"。
 */

import { err, invalidValue, ok, type DomainError, type Result } from '@/domain/errors'
import { contentDigestOf, withContent, type Document } from '@/domain/document'
import { EMPTY_CONTENT, type DocumentContent } from '@/domain/content'
import { digestOf, sameVersion, type Version } from '@/domain/identity'
import { PREF_PREFIX, type PreferenceNamespace } from '@/domain/instanceSettings'
import type { AnimationState } from '@/domain/animation'
import type { ResourceRef } from '@/domain/materials'
import type { Scene } from '@/domain/scene'

// ─────────────────────────────────────────────────────────────────────────────
// 1. 存储键：正式保存键与恢复副本键的**分离**
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 恢复副本/正式保存的应用范围（#249 §19.5「副本与偏好按**应用/用户范围**…隔离」）。
 *
 * 与偏好键复用**同一个**联合类型（`domain/instanceSettings` 的 `PreferenceNamespace`）——
 * 键口径只有一处定义，"工作台/嵌入/共享"三域不会在两套命名里漂移。
 */
export type RecoveryScope = PreferenceNamespace

/** 前缀：与偏好键同一字面量（`domain/instanceSettings` 是它的唯一定义点）。 */
export const RECOVERY_PREFIX = PREF_PREFIX

/** 恢复副本 schema 版本（**独立于**正式保存版本与偏好版本）。 */
export const RECOVERY_SCHEMA_VERSION = 1

/** 正式保存键的 schema 版本（与恢复副本**独立**升版）。 */
export const SAVE_SCHEMA_VERSION = 1

/** 键里的"种类"段：恢复副本。 */
export const RECOVERY_KIND = 'recovery'

/** 键里的"种类"段：正式保存。 */
export const SAVE_KIND = 'save'

/**
 * 键里的"种类"段：**保真记录**（#301 P10f D1(b) 加入本族）。
 *
 * 见 {@link fidelityStoreKey} 的说明 —— 它此前是一个**游离**的键方案。
 */
export const FIDELITY_KIND = 'fidelity'

/** 保真记录键的 schema 版本（与恢复副本、正式保存**各自独立**升版）。 */
export const FIDELITY_SCHEMA_VERSION = 1

/** 载荷里的显式标记：保真记录（键与载荷共用同一取值，见 {@link ArtifactKind}）。 */
export const FIDELITY_ARTIFACT = 'fidelity-record' as const

/** 载荷里的显式标记："这是恢复副本，不是正式保存"。 */
export const RECOVERY_ARTIFACT = 'recovery-copy' as const

/** 制品种类判别式（键与载荷共用同一对取值）。 */
export type ArtifactKind = typeof RECOVERY_ARTIFACT | 'formal-save' | typeof FIDELITY_ARTIFACT

/**
 * 必要实例身份（#249 §19.5「多标签不最后写者无提示互相覆盖」）。
 *
 * ## 为什么恢复副本键必须带实例身份，而正式保存键**不带**
 *
 * 正式保存是**文档级**的事实（远端/Wiki 上"这份工程是什么"），跨标签共享同一份；
 * 恢复副本是**实例级**的兜底（"这个标签页崩溃前手里有什么"），若不带实例身份，
 * 两个标签页编辑同一文档时会互相覆盖 —— 而且**无提示**，因为覆盖发生在存储层，
 * 用户看不到任何 UI 事件。故实例身份是恢复副本键的必需成分。
 */
export interface InstanceIdentity {
  readonly scope: RecoveryScope
  /** 已规范化的实例身份（见 {@link instanceIdentity}）。 */
  readonly instanceId: string
}

/**
 * 规范化实例身份。
 *
 * 规则与 `domain/instanceSettings.preferenceKey` 同口径（空 ⇒ `'default'`），
 * 另把 `.`、`/`、`\`、空白替换成 `-`：这些字符会破坏键的**可解析性**
 * （`parseRecoveryStoreKey` 用 `[^.]+` 取实例段），一旦写进键就无法解析回去。
 */
export function instanceIdentity(scope: RecoveryScope, instanceId: string): InstanceIdentity {
  const cleaned = instanceId.trim().replace(/[.\\/\s]+/g, '-')
  return Object.freeze({ scope, instanceId: cleaned === '' ? 'default' : cleaned })
}

/** 文档身份必须非空 —— 空文档 ID 会让键退化成"整台机器一份副本"。 */
function requireDocumentId(documentId: string): DomainError | null {
  return documentId.trim() === ''
    ? invalidValue({ reason: 'emptyDocumentId', artifact: RECOVERY_ARTIFACT })
    : null
}

/**
 * **恢复副本**键：`lk.recovery.v<版本>.<范围>.<实例身份>.<文档 ID>`。
 *
 * 带命名空间（`lk`）+ 种类（`recovery`）+ schema 版本 + 应用范围 + **实例身份** + 文档 ID。
 */
export function recoveryStoreKey(identity: InstanceIdentity, documentId: string): Result<string> {
  const bad = requireDocumentId(documentId)
  if (bad) return err(bad)
  return ok(`${RECOVERY_PREFIX}.${RECOVERY_KIND}.v${RECOVERY_SCHEMA_VERSION}.${identity.scope}.${identity.instanceId}.${documentId}`)
}

/**
 * **正式保存**键：`lk.save.v<版本>.<范围>.<文档 ID>`。
 *
 * 刻意**不含**实例身份：正式保存是文档级事实，跨标签共享（否则"标签 A 保存过"
 * 在标签 B 看来仍是脏的，而远端其实已经有内容了）。与恢复副本键的差异是**结构性的**
 * （种类段不同 + 实例段的有无），不是"取个别的名字"。
 */
export function saveStoreKey(scope: RecoveryScope, documentId: string): Result<string> {
  const bad = requireDocumentId(documentId)
  if (bad) return err(bad)
  return ok(`${RECOVERY_PREFIX}.${SAVE_KIND}.v${SAVE_SCHEMA_VERSION}.${scope}.${documentId}`)
}

export interface ParsedRecoveryStoreKey {
  readonly artifact: typeof RECOVERY_ARTIFACT
  readonly schemaVersion: number
  readonly scope: RecoveryScope
  readonly instanceId: string
  readonly documentId: string
}

export interface ParsedSaveStoreKey {
  readonly artifact: 'formal-save'
  readonly schemaVersion: number
  readonly scope: RecoveryScope
  readonly documentId: string
}

export interface ParsedFidelityStoreKey {
  readonly artifact: typeof FIDELITY_ARTIFACT
  readonly schemaVersion: number
  readonly scope: RecoveryScope
  readonly instanceId: string
  readonly documentId: string
}

/**
 * **保真记录**键：`lk.fidelity.v<版本>.<范围>.<实例身份>.<文档 ID>`。
 *
 * ## 本函数替代的旧机制（#301 P10f D1(b)；GF-14 的键口径统一）
 *
 * 原先它是 `adapters/files/fidelityRecord.ts` 里一个**游离**的键方案：
 * `lk.fidelity.v1.<文档 ID>.record` —— 与恢复副本/正式保存家族
 * **八处**不兼容（逐条实测，不是"取个别的名字"）：
 *
 * | # | 分歧 | 旧形态 | 本函数 |
 * |---|---|---|---|
 * | 1 | 缺 `scope` 段 | 无 | 有（`identity.scope`） |
 * | 2 | 缺 `instanceId` 段 | 无 | 有（同恢复副本：多标签不得静默互覆） |
 * | 3 | 不被 `artifactKindOfKey` 识别 | 返回 `null` | 返回 `FIDELITY_ARTIFACT` |
 * | 4 | 与 `saveStoreKey` 位置长度撞车 | 都是 5 段、形状同，只靠字面量区分 | 6 段（与 `recoveryStoreKey` 同形） |
 * | 5 | 无解析器 / 不可逆 | 无 | `parseFidelityStoreKey` |
 * | 6 | 返回裸 `string` | 是 | `Result<string>` |
 * | 7 | 版本硬编码在模板串里 | `v1` 字面量 | 具名 `FIDELITY_SCHEMA_VERSION` |
 * | 8 | 空 id 静默降级为 `'unnamed'` | 是 | **显式拒绝**（同族口径）|
 *
 * ⇒ 四项"结构性"分歧（1/2/4/5）是**迁移负担为零**的前提下修的：
 * 旧键在 P9–P10 期间**零生产调用方**（实测：只有 `__tests__` 与 seam 散文提到它）
 * ⇒ 不存在"已写进用户 localStorage 的旧键"要兼容。
 *
 * ## ⚠️ 为什么带 `instanceId`（而不是像正式保存那样不带）
 *
 * 与恢复副本同理：保真记录是**这份产物在这一侧的伴生数据**，
 * 两个标签页处理**同一文档**时若共用一个键会**静默互相覆写**（存储层动作，无 UI 事件）。
 * 而正式保存键刻意不带实例身份（它是文档级事实，跨标签共享）—— 两者差异是**结构性**的。
 */
export function fidelityStoreKey(identity: InstanceIdentity, documentId: string): Result<string> {
  const bad = requireDocumentId(documentId)
  if (bad) return err(bad)
  return ok(
    `${RECOVERY_PREFIX}.${FIDELITY_KIND}.v${FIDELITY_SCHEMA_VERSION}.${identity.scope}.${identity.instanceId}.${documentId}`,
  )
}

/** 解析保真记录键（诊断/迁移/GC 用）；不匹配本方案 ⇒ `null`。 */
export function parseFidelityStoreKey(key: string): ParsedFidelityStoreKey | null {
  const m = new RegExp(
    `^${RECOVERY_PREFIX}\\.${FIDELITY_KIND}\\.v(\\d+)\\.([a-z]+)\\.([^.]+)\\.(.+)$`,
  ).exec(key)
  if (!m) return null
  return Object.freeze({
    artifact: FIDELITY_ARTIFACT,
    schemaVersion: Number(m[1]),
    scope: m[2] as RecoveryScope,
    instanceId: m[3]!,
    documentId: m[4]!,
  })
}

/** 解析恢复副本键（诊断/迁移/多标签对账用）；不匹配本方案 ⇒ `null`。 */
export function parseRecoveryStoreKey(key: string): ParsedRecoveryStoreKey | null {
  const m = new RegExp(`^${RECOVERY_PREFIX}\\.${RECOVERY_KIND}\\.v(\\d+)\\.([a-z]+)\\.([^.]+)\\.(.+)$`).exec(key)
  if (!m) return null
  return Object.freeze({
    artifact: RECOVERY_ARTIFACT,
    schemaVersion: Number(m[1]),
    scope: m[2] as RecoveryScope,
    instanceId: m[3]!,
    documentId: m[4]!,
  })
}

/** 解析正式保存键；不匹配本方案 ⇒ `null`（恢复副本键在这里**必须**是 `null`）。 */
export function parseSaveStoreKey(key: string): ParsedSaveStoreKey | null {
  const m = new RegExp(`^${RECOVERY_PREFIX}\\.${SAVE_KIND}\\.v(\\d+)\\.([a-z]+)\\.(.+)$`).exec(key)
  if (!m) return null
  return Object.freeze({
    artifact: 'formal-save',
    schemaVersion: Number(m[1]),
    scope: m[2] as RecoveryScope,
    documentId: m[3]!,
  })
}

/**
 * 键的制品种类（UI/诊断据此区分"这是恢复副本"与"这是正式保存"）。
 *
 * 两个键方案的分离由本函数**单一**判定：不存在第三条"看起来像两者之一"的路径。
 */
export function artifactKindOfKey(key: string): ArtifactKind | null {
  if (parseRecoveryStoreKey(key) !== null) return RECOVERY_ARTIFACT
  if (parseSaveStoreKey(key) !== null) return 'formal-save'
  // #301 P10f D1(b)：保真记录键加入本分类器（原先它对本函数**不可见** ⇒ 返回 null，
  // 于是"列/GC/迁移"结构上无法识别它）。
  if (parseFidelityStoreKey(key) !== null) return FIDELITY_ARTIFACT
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 存储端口与**可见失败**
// ─────────────────────────────────────────────────────────────────────────────

/** 存储不可用的原因（结构化，不是自然语言；#249 §19.7）。 */
export type StorageUnavailableReason =
  /** 宿主根本没有存储（SSR / 无 `Storage` 实现）。 */
  | 'noStorage'
  /** 宿主存在但拒绝访问（隐私模式、被策略禁用、跨源限制）。 */
  | 'blocked'
  /** 访问时抛出安全异常。 */
  | 'security'

/**
 * 存储失败（**三个**互不兼表的分支）。
 *
 * ## 为什么不是 `boolean` 也不是 `null`
 *
 * | 分支 | 正确反应 |
 * |---|---|
 * | `quotaExceeded` | 提示用户清理/降低保留数量；**可**重试（清理后）；不表示内容已保存 |
 * | `unavailable` | 提示本环境无法提供恢复副本；**不**重试（条件不会自行变化） |
 * | `failed` | 保留诊断码；按策略重试 |
 *
 * 三者合并成一个"失败"布尔，会让调用方要么对一个永久不可用的存储无限重试，
 * 要么把"配额不足可清理"当成"环境不支持"而放弃。
 */
export type StorageFailure =
  | { readonly status: 'quotaExceeded'; readonly detail: string }
  | { readonly status: 'unavailable'; readonly reason: StorageUnavailableReason }
  | { readonly status: 'failed'; readonly code: string; readonly detail: string }

/** 写/删的应答（无载荷）。 */
export type StorageAck = { readonly status: 'ok' } | StorageFailure

/**
 * 读的应答。
 *
 * `value === null` 有**唯一**含义：键不存在。失败走 `StorageFailure` 分支，
 * 故"读不到"与"读失败"从不在同一个值上兼表（同族原则见 #249 §19.3 与 A36 负对照）。
 */
export type StorageRead = { readonly status: 'ok'; readonly value: string | null } | StorageFailure

/** 键枚举的应答（键表恒为数组；"枚举不到任何键"是空数组，不是 `null`）。 */
export type StorageKeysRead = { readonly status: 'ok'; readonly value: readonly string[] } | StorageFailure

/**
 * 存储端口 —— 最小面（`get`/`set`/`remove`/`keys`）。
 *
 * ## 为什么端口定义在纯层而不是适配器层
 *
 * #249 §4 规则 4 是「adapters **实现**端口」。端口若定义在 `adapters/`，纯层要消费它
 * 就必须 import 适配器（把依赖方向倒过来）；定义在纯层后，两侧都只依赖契约：
 * `application/recovery` 不知道有几种存储，适配器不知道恢复政策。
 * 又因契约 §7.3 的公共出口深度为 2，端口必须与政策同处一个具名模块
 * （`application/recovery.ts`），不能塞进子目录当私有实现。
 *
 * 所有方法**必须**返回判别式；`catch` 之后返回"空/成功"是明令禁止的
 * （#249 §19.5「不能 catch 后宣称恢复可用」）。
 */
export interface RecoveryStorePort {
  /** 端口身份（诊断用；**不**参与键，故不是"存储位置"）。 */
  readonly id: string
  get(key: string): StorageRead
  set(key: string, value: string): StorageAck
  remove(key: string): StorageAck
  /** 枚举**全部**键（调用方自行按前缀过滤；枚举失败也必须是可见失败）。 */
  keys(): StorageKeysRead
}

/**
 * 写恢复副本的结局。
 *
 * **每一个**分支都带 `artifact: 'recovery-copy'`，且**没有任何**
 * `saved`/`baselineChanged`/`baseline`/`document`/`wiki`/`uploaded` 字段 ——
 * 于是"写恢复副本成功"在类型上**无法**被当成"正式保存成功"或"Wiki 上传成功"
 * （A31 负对照「将恢复写成功标记为已正式保存」的截断点）。
 */
export type RecoveryWriteOutcome =
  | {
      readonly status: 'ok'
      readonly artifact: typeof RECOVERY_ARTIFACT
      readonly key: string
      /** 存储表示的长度（字符数，非字节）。 */
      readonly serializedLength: number
    }
  | { readonly status: 'quotaExceeded'; readonly artifact: typeof RECOVERY_ARTIFACT; readonly key: string; readonly detail: string }
  | {
      readonly status: 'unavailable'
      readonly artifact: typeof RECOVERY_ARTIFACT
      readonly key: string
      readonly reason: StorageUnavailableReason
    }
  | {
      readonly status: 'failed'
      readonly artifact: typeof RECOVERY_ARTIFACT
      readonly key: string
      readonly code: string
      readonly detail: string
    }

/** 读恢复副本的结局。`missing`（本来就没有副本）与 `failed`（读坏了）**分开**。 */
export type RecoveryReadOutcome =
  | { readonly status: 'ok'; readonly artifact: typeof RECOVERY_ARTIFACT; readonly key: string; readonly raw: string }
  | { readonly status: 'missing'; readonly artifact: typeof RECOVERY_ARTIFACT; readonly key: string }
  | { readonly status: 'unavailable'; readonly artifact: typeof RECOVERY_ARTIFACT; readonly key: string; readonly reason: StorageUnavailableReason }
  | {
      readonly status: 'failed'
      readonly artifact: typeof RECOVERY_ARTIFACT
      readonly key: string
      readonly code: string
      readonly detail: string
    }

/** 列举本实例的恢复副本键的结局。 */
export type RecoveryListOutcome =
  | { readonly status: 'ok'; readonly artifact: typeof RECOVERY_ARTIFACT; readonly keys: readonly string[] }
  | { readonly status: 'quotaExceeded'; readonly artifact: typeof RECOVERY_ARTIFACT; readonly detail: string }
  | { readonly status: 'unavailable'; readonly artifact: typeof RECOVERY_ARTIFACT; readonly reason: StorageUnavailableReason }
  | { readonly status: 'failed'; readonly artifact: typeof RECOVERY_ARTIFACT; readonly code: string; readonly detail: string }

/** 把端口的失败分支原样带上 `key`（不吞、不降级为"空"）。 */
function writeFailureOf(key: string, failure: StorageFailure): RecoveryWriteOutcome {
  switch (failure.status) {
    case 'quotaExceeded':
      return Object.freeze({ status: 'quotaExceeded', artifact: RECOVERY_ARTIFACT, key, detail: failure.detail })
    case 'unavailable':
      return Object.freeze({ status: 'unavailable', artifact: RECOVERY_ARTIFACT, key, reason: failure.reason })
    case 'failed':
      return Object.freeze({ status: 'failed', artifact: RECOVERY_ARTIFACT, key, code: failure.code, detail: failure.detail })
  }
}

function readFailureOf(key: string, failure: StorageFailure): RecoveryReadOutcome {
  switch (failure.status) {
    case 'quotaExceeded':
      return Object.freeze({ status: 'failed', artifact: RECOVERY_ARTIFACT, key, code: 'quotaExceeded', detail: failure.detail })
    case 'unavailable':
      return Object.freeze({ status: 'unavailable', artifact: RECOVERY_ARTIFACT, key, reason: failure.reason })
    case 'failed':
      return Object.freeze({ status: 'failed', artifact: RECOVERY_ARTIFACT, key, code: failure.code, detail: failure.detail })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 最小恢复路径：只捕获**已提交内容**
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 恢复副本的**唯一**内容来源。
 *
 * ## 为什么是 `Pick` 而不是 `Document`
 *
 * 四个字段就是"已提交内容"的全部：文档身份、场景、动画、版本。
 * `Document` 的其余字段（`saveBaseline`、`savedSequence`、`history`、`types`）都不在此，
 * 于是写入路径**看不见**保存基线 —— "写恢复副本不改基线"不是靠自觉，是没有通路。
 *
 * `EditContext` 也不满足本类型（它没有 `scene`/`animation`/`version`）：
 * 想把 `interaction` 暂存塞进恢复副本，必须先**手工**把它并进 `scene` ——
 * 而那会改变内容摘要，被 {@link validateRecoveryCopy} 的摘要校验抓住（见 A31 负对照）。
 */
export interface RecoverySourceSnapshot {
  readonly id: string
  readonly scene: Scene
  readonly animation: AnimationState
  /**
   * 文档内容的其余三块（#282：元数据/帧时长轴/资源引用）。
   *
   * 为什么必须进恢复副本：恢复副本的语义是「已提交内容的副本」
   * （#249 §19.5）。若它只带 `scene`/`animation`，那么恢复回来的文档会
   * **丢掉元数据与资源引用** —— 而它们**进内容身份**（`contentDigestOf`），
   * 于是"采纳后内容回到已提交状态"不成立：摘要会与来源快照不同。
   *
   * 这与「半次拖动不恢复」是**同一条纪律的两个方向**：
   *  - 暂存（`interaction`）**不在**快照里 ⇒ 不恢复未提交的东西；
   *  - 内容三块**在**快照里 ⇒ 不丢失已提交的东西。
   */
  readonly content: DocumentContent
  readonly version: Version
}

/** 从文档投影出恢复副本的来源快照（**丢弃**基线/历史/类型表 —— 显式，不是顺手）。 */
export function recoverySourceSnapshot(doc: {
  readonly id: string
  readonly scene: Scene
  readonly animation: AnimationState
  readonly content?: DocumentContent
  readonly version: Version
}): RecoverySourceSnapshot {
  return Object.freeze({
    id: doc.id,
    scene: doc.scene,
    animation: doc.animation,
    content: doc.content ?? EMPTY_CONTENT,
    version: doc.version,
  })
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 恢复副本载荷。
 *
 * **没有** `interaction` 字段 —— 这就是"半次拖动不恢复"的类型落点
 * （A31 负对照「把暂存位移写进恢复副本」必须靠先破坏这一条才可能发生）。
 */
export interface RecoveryPayload {
  readonly artifact: typeof RECOVERY_ARTIFACT
  readonly schemaVersion: number
  readonly scope: RecoveryScope
  readonly instanceId: string
  readonly documentId: string
  /** 提交世代的单调计数（诊断/展示用；不比大小作判据）。 */
  readonly documentVersion: number
  /** 内容身份摘要（与 `Document.version.contentVersion` 同一算法）。 */
  readonly contentVersion: number
  readonly scene: Scene
  readonly animation: AnimationState
  /** 文档内容的其余三块（#282；与 `scene`/`animation` 一并构成"已提交内容"）。 */
  readonly content: DocumentContent
  /** 必要资源引用（#249 §19.5「已提交内容**及必要资源引用**」）。 */
  readonly assets: readonly ResourceRef[]
  /** 写入时刻 —— 由**注入时钟**在调用点给出，纯层不读墙钟。 */
  readonly writtenAt: number
}

export interface RecoveryCaptureInput {
  readonly snapshot: RecoverySourceSnapshot
  readonly identity: InstanceIdentity
  /** 注入时钟给出的写入时刻（毫秒）。非有限值即拒绝。 */
  readonly writtenAt: number
  /** 必要资源引用（缺省为空表，**不**用"没写就是没资源"掩盖）。 */
  readonly assets?: readonly ResourceRef[]
  readonly schemaVersion?: number
}

/**
 * 快照的**形状**校验（返回坏在哪；`null` = 形状正确）。
 *
 * 存在的理由是一条实测出来的崩法：把 `EditContext`（它**没有** `scene`/`animation`/`version`）
 * 当来源传进来时，直接读 `snapshot.version.contentVersion` 会抛 `TypeError` ——
 * 一个"浏览器运行时抛异常"的失败面。纯层不抛异常：形状不对就返回
 * `InvalidValue('invalidSnapshot')`，于是"半次拖动被误当来源"这类调用
 * 得到的是**结构化拒绝**，不是栈。
 */
function snapshotShapeProblem(snapshot: unknown): string | null {
  if (!isRecord(snapshot)) return '$'
  if (typeof snapshot.id !== 'string') return '$.id'
  if (!isRecord(snapshot.scene)) return '$.scene'
  if (!isRecord(snapshot.animation)) return '$.animation'
  if (!isRecord(snapshot.version)) return '$.version'
  if (typeof (snapshot.version as { documentVersion?: unknown }).documentVersion !== 'number') return '$.version.documentVersion'
  return null
}

/**
 * 捕获恢复副本载荷（**纯**）。
 *
 * 拒绝条件（全部显式，不用默认值掩盖）：
 *  - 来源形状不合法（例如误把 `EditContext` 当来源）；
 *  - 文档 ID 为空；
 *  - `writtenAt` 非有限值（说明调用方没有真的注入时钟，而是在猜）；
 *  - `contentVersion` 与 `digestOf({scene, animation})` 不一致 ——
 *    说明来源快照自相矛盾（例如有人手工把暂存位移并进了 `scene` 却没更新版本）。
 *    这条**先校验**让坏内容在写入侧就被挡住，而不是等读回时才发现。
 */
export function captureRecoveryCopy(input: RecoveryCaptureInput): Result<RecoveryPayload> {
  const shape = snapshotShapeProblem(input.snapshot)
  if (shape !== null) {
    return err(invalidValue({ reason: 'invalidSnapshot', path: shape, artifact: RECOVERY_ARTIFACT }))
  }
  const bad = requireDocumentId(input.snapshot.id)
  if (bad) return err(bad)
  if (!Number.isFinite(input.writtenAt)) {
    return err(invalidValue({ reason: 'writtenAtNotInjected', writtenAt: String(input.writtenAt) }))
  }
  const digest = contentDigestOf(input.snapshot.scene, input.snapshot.animation, input.snapshot.content)
  const declared = input.snapshot.version.contentVersion ?? digest
  if (declared !== digest) {
    return err(
      invalidValue({
        reason: 'snapshotDigestMismatch',
        declared,
        computed: digest,
        documentId: input.snapshot.id,
      }),
    )
  }
  const payload: RecoveryPayload = Object.freeze({
    artifact: RECOVERY_ARTIFACT,
    schemaVersion: input.schemaVersion ?? RECOVERY_SCHEMA_VERSION,
    scope: input.identity.scope,
    instanceId: input.identity.instanceId,
    documentId: input.snapshot.id,
    documentVersion: input.snapshot.version.documentVersion,
    contentVersion: digest,
    scene: input.snapshot.scene,
    animation: input.snapshot.animation,
    content: input.snapshot.content,
    assets: Object.freeze([...(input.assets ?? [])]),
    writtenAt: input.writtenAt,
  })
  return ok(payload)
}

/** 载荷 → 存储表示（JSON 文本）。 */
export function serializeRecoveryCopy(payload: RecoveryPayload): string {
  return JSON.stringify(payload)
}

/** 一次写入的完整计划（键 + 载荷 + 存储表示）。 */
export interface RecoveryWritePlan {
  readonly artifact: typeof RECOVERY_ARTIFACT
  readonly key: string
  readonly payload: RecoveryPayload
  readonly json: string
}

/** 组键 + 捕获 + 序列化（**纯**；不含任何 IO）。 */
export function planRecoveryWrite(input: RecoveryCaptureInput): Result<RecoveryWritePlan> {
  const key = recoveryStoreKey(input.identity, input.snapshot.id)
  if (!key.ok) return key
  const captured = captureRecoveryCopy(input)
  if (!captured.ok) return captured
  return ok(
    Object.freeze({
      artifact: RECOVERY_ARTIFACT,
      key: key.value,
      payload: captured.value,
      json: serializeRecoveryCopy(captured.value),
    }),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 写入 / 读取（经**注入**端口；失败一律可见）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 写恢复副本。
 *
 * 三件事，仅此三件：调端口的 `set`、把端口的判别式**原样**翻译成
 * {@link RecoveryWriteOutcome}、报告存储表示长度。
 *
 * - **不**调用 `beginSave`/`completeSave`（正式保存结算的唯一入口在 `domain/document`）；
 * - **不**返回 `Document`，**不**声明任何基线变化；
 * - 端口报配额/不可用时**原样**返回该判别式，绝不 catch 成 `ok`。
 */
export function writeRecoveryCopy(port: RecoveryStorePort, plan: RecoveryWritePlan): RecoveryWriteOutcome {
  const ack = port.set(plan.key, plan.json)
  if (ack.status !== 'ok') return writeFailureOf(plan.key, ack)
  return Object.freeze({
    status: 'ok',
    artifact: RECOVERY_ARTIFACT,
    key: plan.key,
    serializedLength: plan.json.length,
  })
}

/** 读恢复副本（`value === null` ⇒ `missing`，与 `failed` 分开）。 */
export function readRecoveryCopy(port: RecoveryStorePort, key: string): RecoveryReadOutcome {
  const got = port.get(key)
  if (got.status !== 'ok') return readFailureOf(key, got)
  if (got.value === null) return Object.freeze({ status: 'missing', artifact: RECOVERY_ARTIFACT, key })
  return Object.freeze({ status: 'ok', artifact: RECOVERY_ARTIFACT, key, raw: got.value })
}

/**
 * 列举**本实例**在同类范围下的恢复副本键（多标签对账/展示用）。
 *
 * 只保留 `parseRecoveryStoreKey` 能解析且 `scope`/`instanceId` 相符的键：
 * 别的实例（另一个标签页）的副本不进这个列表，于是"覆盖别的实例的副本"
 * 不会因为"批量清理"这类操作意外发生。
 */
export function listRecoveryKeys(port: RecoveryStorePort, identity: InstanceIdentity): RecoveryListOutcome {
  const all = port.keys()
  if (all.status === 'unavailable') {
    return Object.freeze({ status: 'unavailable', artifact: RECOVERY_ARTIFACT, reason: all.reason })
  }
  if (all.status === 'quotaExceeded') {
    return Object.freeze({ status: 'quotaExceeded', artifact: RECOVERY_ARTIFACT, detail: all.detail })
  }
  if (all.status === 'failed') {
    return Object.freeze({ status: 'failed', artifact: RECOVERY_ARTIFACT, code: all.code, detail: all.detail })
  }
  const keys = all.value.filter((k) => {
    const parsed = parseRecoveryStoreKey(k)
    return parsed !== null && parsed.scope === identity.scope && parsed.instanceId === identity.instanceId
  })
  return Object.freeze({ status: 'ok', artifact: RECOVERY_ARTIFACT, keys: Object.freeze(keys.slice().sort()) })
}

/** 删除一份恢复副本（用户显式"丢弃副本"）。 */
export function removeRecoveryCopy(port: RecoveryStorePort, key: string): StorageAck {
  return port.remove(key)
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. 校验 → 采纳（坏副本**先校验再采纳**）
// ─────────────────────────────────────────────────────────────────────────────

/** 拒绝采纳的**结构化**原因（稳定、可序列化、与语言无关）。 */
export type RecoveryRejectionReason =
  | { readonly kind: 'notJson'; readonly detail: string }
  | { readonly kind: 'schemaVersionMismatch'; readonly found: number; readonly expected: number }
  | { readonly kind: 'artifactMismatch'; readonly found: string }
  | { readonly kind: 'shapeInvalid'; readonly path: string; readonly detail: string }
  | { readonly kind: 'documentIdMismatch'; readonly found: string; readonly expected: string }
  | { readonly kind: 'instanceIdMismatch'; readonly found: string; readonly expected: string }
  | { readonly kind: 'digestMismatch'; readonly found: number; readonly expected: number }

export interface RecoveryValidationInput {
  /** 存储里的**原始**表示（不是已经 parse 过的对象 —— 判据要覆盖"根本不是 JSON"）。 */
  readonly raw: string
  /** 当前打开的文档身份；不符即拒绝（不得用别的文档的副本覆盖当前内容）。 */
  readonly expectedDocumentId: string
  /** 只接受本实例写的副本（多标签）；缺省则不限制（用户可在看到来源后显式选择别的实例的副本）。 */
  readonly expectedInstanceId?: string
  readonly expectedSchemaVersion?: number
}

export type RecoveryValidation =
  | { readonly ok: true; readonly payload: RecoveryPayload }
  | { readonly ok: false; readonly reasons: readonly RecoveryRejectionReason[] }

const SCOPES: readonly RecoveryScope[] = Object.freeze(['workbench', 'embed', 'shared'])

/** 形状校验：逐条列出坏在哪里（**不**只给一个"非法"）。 */
function validatePayloadShape(record: Record<string, unknown>): readonly RecoveryRejectionReason[] {
  const out: RecoveryRejectionReason[] = []
  const bad = (path: string, detail: string): void => {
    out.push(Object.freeze({ kind: 'shapeInvalid', path, detail }))
  }
  const scene = record.scene
  if (!isRecord(scene)) {
    bad('$.scene', '不是对象')
  } else {
    if (typeof scene.id !== 'string') bad('$.scene.id', '不是字符串')
    if (!isRecord(scene.objects)) bad('$.scene.objects', '不是以 ID 索引的对象表')
    if (!isRecord(scene.data)) bad('$.scene.data', '不是以 ID 索引的数据表')
    if (!isRecord(scene.collections)) bad('$.scene.collections', '不是以 ID 索引的集合表')
    if (!Array.isArray(scene.order)) bad('$.scene.order', '不是数组')
  }
  const animation = record.animation
  if (!isRecord(animation)) {
    bad('$.animation', '不是对象')
  } else {
    if (!Array.isArray(animation.tracks)) bad('$.animation.tracks', '不是数组')
    if (!isRecord(animation.publishedDefaults)) bad('$.animation.publishedDefaults', '不是键值表')
  }
  // 内容三块（#282）：形状必须可辨，否则摘要校验会对着一个"看起来空"的值算。
  // 缺省**允许**（旧副本没有该键 ⇒ 视为空内容），但给了就必须是合法形状 ——
  // 于是"旧副本读得回"与"坏副本挡得住"同时成立。
  const content = record.content
  if (content !== undefined) {
    if (!isRecord(content)) {
      bad('$.content', '不是对象')
    } else {
      if (!isRecord(content.metadata)) bad('$.content.metadata', '不是对象')
      if (!isRecord(content.frameAxis)) {
        bad('$.content.frameAxis', '不是对象')
      } else if (!Array.isArray(content.frameAxis.frames)) {
        bad('$.content.frameAxis.frames', '不是数组')
      }
      if (!Array.isArray(content.resources)) bad('$.content.resources', '不是数组')
    }
  }
  if (typeof record.documentVersion !== 'number' || !Number.isInteger(record.documentVersion) || record.documentVersion < 0) {
    bad('$.documentVersion', '不是非负整数')
  }
  if (typeof record.contentVersion !== 'number' || !Number.isFinite(record.contentVersion)) bad('$.contentVersion', '不是有限数')
  if (typeof record.writtenAt !== 'number' || !Number.isFinite(record.writtenAt)) bad('$.writtenAt', '不是有限数')
  if (typeof record.instanceId !== 'string' || record.instanceId === '') bad('$.instanceId', '不是非空字符串')
  if (typeof record.scope !== 'string' || !SCOPES.includes(record.scope as RecoveryScope)) bad('$.scope', '不是已知应用范围')
  if (!Array.isArray(record.assets)) bad('$.assets', '不是数组')
  return Object.freeze(out)
}

/**
 * **先校验再采纳**的唯一判据（A31「坏副本不替换有效内容」）。
 *
 * 四类校验一次给全（不短路，便于 UI 一次展示全部原因）：
 *  1. **版本**：`schemaVersion` 必须是本实现的版本；
 *  2. **形状**：载荷各字段的结构与类型（连"是不是 JSON""是不是对象"都算）；
 *  3. **文档 ID 匹配**：副本属于当前打开的文档；可选地还要求**实例匹配**；
 *  4. **内容摘要**：`contentVersion` 必须等于按载荷重算的摘要
 *     （形状不可用时跳过 —— 摘要算不出来，原因已经报了形状）。
 *
 * 任一条不过 ⇒ `ok: false` + 结构化原因，**且不返回任何内容**。
 */
export function validateRecoveryCopy(input: RecoveryValidationInput): RecoveryValidation {
  let parsed: unknown
  try {
    parsed = JSON.parse(input.raw)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    return Object.freeze({ ok: false, reasons: Object.freeze([Object.freeze({ kind: 'notJson', detail })]) })
  }
  if (!isRecord(parsed)) {
    return Object.freeze({
      ok: false,
      reasons: Object.freeze([Object.freeze({ kind: 'shapeInvalid', path: '$', detail: '载荷不是对象' })]),
    })
  }
  const reasons: RecoveryRejectionReason[] = []
  const expectedSchema = input.expectedSchemaVersion ?? RECOVERY_SCHEMA_VERSION
  const schema = parsed.schemaVersion
  if (typeof schema !== 'number' || schema !== expectedSchema) {
    reasons.push(Object.freeze({ kind: 'schemaVersionMismatch', found: typeof schema === 'number' ? schema : -1, expected: expectedSchema }))
  }
  if (parsed.artifact !== RECOVERY_ARTIFACT) {
    reasons.push(Object.freeze({ kind: 'artifactMismatch', found: typeof parsed.artifact === 'string' ? parsed.artifact : typeof parsed.artifact }))
  }
  const shape = validatePayloadShape(parsed)
  reasons.push(...shape)
  const documentId = parsed.documentId
  if (typeof documentId !== 'string' || documentId !== input.expectedDocumentId) {
    reasons.push(
      Object.freeze({
        kind: 'documentIdMismatch',
        found: typeof documentId === 'string' ? documentId : typeof documentId,
        expected: input.expectedDocumentId,
      }),
    )
  }
  if (input.expectedInstanceId !== undefined && parsed.instanceId !== input.expectedInstanceId) {
    reasons.push(
      Object.freeze({
        kind: 'instanceIdMismatch',
        found: typeof parsed.instanceId === 'string' ? parsed.instanceId : typeof parsed.instanceId,
        expected: input.expectedInstanceId,
      }),
    )
  }
  if (shape.length === 0) {
    // 摘要用**唯一权威** `contentDigestOf`（`domain/document`），不再本地拼一份
    // `digestOf({scene, animation})` —— 那正是「两套判据」的形态，而它在 #282
    // 引入内容三块后**必然**与文档侧漂移（旧副本会被误判为"摘要不符"）。
    // 缺 `content` 键的旧副本按空内容算：与 `RecoverySourceSnapshot.content` 的
    // 缺省同源，故"旧副本读得回"成立。
    const payloadContent = (isRecord(parsed.content) ? parsed.content : EMPTY_CONTENT) as unknown as DocumentContent
    const computed = contentDigestOf(parsed.scene as Scene, parsed.animation as AnimationState, payloadContent)
    if (computed !== parsed.contentVersion) {
      reasons.push(
        Object.freeze({
          kind: 'digestMismatch',
          found: typeof parsed.contentVersion === 'number' ? parsed.contentVersion : -1,
          expected: computed,
        }),
      )
    }
  }
  if (reasons.length > 0) return Object.freeze({ ok: false, reasons: Object.freeze(reasons) })
  return Object.freeze({ ok: true, payload: parsed as unknown as RecoveryPayload })
}

/** 恢复副本的**来源/版本**描述（供"恢复时展示来源/版本并由用户选择"）。 */
export interface RecoveryOrigin {
  readonly scope: RecoveryScope | null
  readonly instanceId: string | null
  readonly documentId: string | null
  readonly documentVersion: number | null
  readonly contentVersion: number | null
  /** 写入时刻（注入时钟给出）。 */
  readonly writtenAt: number | null
  readonly schemaVersion: number | null
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/** 从载荷取值（已校验通过时用；字段齐全）。 */
export function originOfPayload(payload: RecoveryPayload): RecoveryOrigin {
  return Object.freeze({
    scope: payload.scope,
    instanceId: payload.instanceId,
    documentId: payload.documentId,
    documentVersion: payload.documentVersion,
    contentVersion: payload.contentVersion,
    writtenAt: payload.writtenAt,
    schemaVersion: payload.schemaVersion,
  })
}

/**
 * **尽力**从原始表示里读出来源（即使副本是坏的也要能告诉用户"它来自哪"）。
 *
 * 与 {@link validateRecoveryCopy} 的分工：本函数**只**为展示服务，
 * 它的结果**绝不**参与"能不能采纳"的判定（`adoptable` 只由校验给出）。
 * 字段读不出时给 `null`（`null` 的唯一含义是"读不出"，不是"缺失即失败"）。
 */
export function readRecoveryOrigin(raw: string): RecoveryOrigin | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const scope = typeof parsed.scope === 'string' && SCOPES.includes(parsed.scope as RecoveryScope) ? (parsed.scope as RecoveryScope) : null
  return Object.freeze({
    scope,
    instanceId: stringOrNull(parsed.instanceId),
    documentId: stringOrNull(parsed.documentId),
    documentVersion: numberOrNull(parsed.documentVersion),
    contentVersion: numberOrNull(parsed.contentVersion),
    writtenAt: numberOrNull(parsed.writtenAt),
    schemaVersion: numberOrNull(parsed.schemaVersion),
  })
}

/** 给 UI/诊断用的候选描述：显式标记 + 是否可采纳 + 来源 + 拒绝原因。 */
export interface RecoveryCandidateDescription {
  /** 显式标记："这是恢复副本，不是正式保存"（#249 §19.5）。 */
  readonly artifact: typeof RECOVERY_ARTIFACT
  /** **唯一**由校验给出的可采纳性（不掺"看起来像"）。 */
  readonly adoptable: boolean
  readonly origin: RecoveryOrigin | null
  readonly reasons: readonly RecoveryRejectionReason[]
}

export function describeRecoveryCandidate(input: RecoveryValidationInput): RecoveryCandidateDescription {
  const validation = validateRecoveryCopy(input)
  if (validation.ok) {
    return Object.freeze({
      artifact: RECOVERY_ARTIFACT,
      adoptable: true,
      origin: originOfPayload(validation.payload),
      reasons: Object.freeze([]) as readonly RecoveryRejectionReason[],
    })
  }
  return Object.freeze({
    artifact: RECOVERY_ARTIFACT,
    adoptable: false,
    origin: readRecoveryOrigin(input.raw),
    reasons: validation.reasons,
  })
}

/**
 * 采纳决策（**纯**）。
 *
 * `reject` 分支**不携带内容** —— 这是"坏副本不替换有效内容"的类型落点：
 * 想在拒绝时替换内容，必须先**伪造**一个 `adopt`（那要绕过校验，见 A31 负对照）。
 * `keepCurrentContent: true` 是常量字面量类型，用于让调用方在类型上就知道
 * "拒绝 = 当前内容原样"。
 */
export type RecoveryAdoption =
  | { readonly decision: 'adopt'; readonly payload: RecoveryPayload; readonly origin: RecoveryOrigin }
  | { readonly decision: 'reject'; readonly reasons: readonly RecoveryRejectionReason[]; readonly keepCurrentContent: true }

export function decideRecoveryAdoption(input: RecoveryValidationInput): RecoveryAdoption {
  const validation = validateRecoveryCopy(input)
  if (!validation.ok) {
    return Object.freeze({ decision: 'reject', reasons: validation.reasons, keepCurrentContent: true })
  }
  return Object.freeze({ decision: 'adopt', payload: validation.payload, origin: originOfPayload(validation.payload) })
}

/** 采纳结果。 */
export type RecoveryApplication =
  | {
      readonly status: 'adopted'
      readonly doc: Document
      /** 采纳是否**真的**改了内容（内容身份相同 ⇒ `false`，不产生幽灵变化）。 */
      readonly changed: boolean
      readonly origin: RecoveryOrigin
      readonly restoredVersion: Version
      /** 按**实际比较**得出：保存基线与保存序号逐位未变。 */
      readonly baselinePreserved: boolean
    }
  | {
      readonly status: 'rejected'
      /** **同一个** `Document` 对象（引用相等）—— 当前内容原样保留。 */
      readonly doc: Document
      readonly reasons: readonly RecoveryRejectionReason[]
      readonly contentPreserved: true
    }

/**
 * 采纳一份恢复副本（**纯**）。
 *
 * - `reject` ⇒ 原样返回 `current`（引用相等，A31「不替换有效内容」的强断言）；
 * - `adopt` ⇒ 经 `withContent` 只替换 `scene`/`animation`：
 *   `saveBaseline`/`savedSequence` 由 `withContent` 原样带过，`baselinePreserved`
 *   按实际比较给出 —— 于是"恢复副本不改变正式保存基线"（#249 §19.5）
 *   既可断言又不可能被"顺手"破坏。
 *
 * 注意采纳**不**自动"变干净"：恢复回来的内容若本来就没保存过，`isDirty` 仍为真。
 */
export function adoptRecoveryCopy(current: Document, adoption: RecoveryAdoption): RecoveryApplication {
  if (adoption.decision === 'reject') {
    return Object.freeze({ status: 'rejected', doc: current, reasons: adoption.reasons, contentPreserved: true })
  }
  const applied = withContent(current, adoption.payload.scene, adoption.payload.animation, adoption.payload.content)
  const baselinePreserved = applied.doc.saveBaseline === current.saveBaseline && applied.doc.savedSequence === current.savedSequence
  return Object.freeze({
    status: 'adopted',
    doc: applied.doc,
    changed: applied.changed,
    origin: adoption.origin,
    restoredVersion: applied.version,
    baselinePreserved,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. 断言钩子（供 A31 测试与诊断做**正**断言，不靠"看起来对"）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 保存基线指纹：`(saveBaseline, savedSequence)` 的内容摘要。
 *
 * 写恢复副本前后取两次，**必须相等** —— 这把"不改基线"从叙述变成可执行判据。
 * 用摘要而不是逐字段比较，是为了让失败信息只有"变了"一种，避免测试变成字段清单维护。
 */
export function baselineFingerprint(doc: { readonly saveBaseline: Version; readonly savedSequence: number }): number {
  return digestOf({ saveBaseline: doc.saveBaseline, savedSequence: doc.savedSequence })
}

/**
 * 内容身份（与 `Document.version.contentVersion` **同一算法**；供"内容回到已提交状态"断言）。
 *
 * ## 为什么转发 `contentDigestOf` 而不是自己 `digestOf({scene, animation})`（#282 修正）
 *
 * 本函数原来本地拼 `digestOf({scene, animation})`，与 `domain/document#contentDigestOf`
 * 是**两份同义实现**。在 `Document` 只有这两块时它们恰好相等，于是缺陷不可见；
 * #282 把文档内容扩为「场景 + 动画 + 元数据/帧时长轴/资源引用」后，
 * 两份实现**必然**漂移 —— 而漂移的表现是"恢复副本的摘要校验把合法副本判成坏的"
 * （或反过来：把坏副本判成合法的，那更危险）。
 *
 * ⇒ 转发唯一权威。`content` 可选，缺省 = 空内容（与 `RecoverySourceSnapshot.content`
 * 的缺省同源）。
 */
export function contentFingerprint(scene: Scene, animation: AnimationState, content: DocumentContent = EMPTY_CONTENT): number {
  return contentDigestOf(scene, animation, content)
}

/** 版本是否与恢复副本记录的一致（含提交世代与内容身份）。 */
export function sameRestoredVersion(doc: { readonly version: Version }, payload: RecoveryPayload): boolean {
  return sameVersion(doc.version, { documentVersion: payload.documentVersion, contentVersion: payload.contentVersion })
}

/**
 * 暂存交互的字段名（`domain/editing` 的 `InteractionState` 成员）。
 *
 * 出现在**存储表示**里就意味着"半次拖动被写进了恢复副本"（A31 负对照）。
 * 纯类型排除是第一道防线（载荷里没有该字段），本常量供第二道防线使用：
 * 对**实际落盘的文本**做机械检查 —— 类型可以被 `as any` 绕过，落盘文本不会说谎。
 */
export const STAGED_CONTENT_FIELDS: readonly string[] = Object.freeze([
  'interaction',
  'overrides',
  'startTransforms',
  'totalDisplacement',
])

/**
 * 在存储表示里检出暂存内容（空数组 = 没有暂存内容）。
 *
 * 判定是**机械**的：`"<字段名>":` 出现在 JSON 文本里。它不试图理解语义
 * （那需要把载荷 parse 回领域对象，而坏副本恰恰可能 parse 不了）——
 * 它的职责是"证明这份文本里没有暂存的形状"。
 */
export function stagedContentMarkers(serialized: string): readonly string[] {
  const hits: string[] = []
  for (const field of STAGED_CONTENT_FIELDS) {
    if (serialized.includes(`"${field}":`)) hits.push(field)
  }
  return Object.freeze(hits)
}
