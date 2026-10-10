/**
 * `Result` / `DomainError` —— **契约兼容的最小实现**（呈现层内部用）。
 *
 * ## 为什么这里有一份自己的定义
 *
 * 冻结契约 `docs/contracts/web-kernel-contracts.md` §0 与 §3.2 定义了
 * `Result<T>` 与八项 `DomainError`，但文件头同时写明：
 *
 * > 辅助类型在本文件中省略，其完整定义由 P1/P2 在 `web/src/` 落地时补齐 ——
 * > **补齐时不得改变本文件已冻结的语义**。
 *
 * P1（#252）尚未开工（本树自 `2fd9e86` 开出，与基线一致），而 P5 的呈现编译必须能
 * 表达"目标缺失 / 引用过期 / 能力不支持"三类失败（A12/A19/A36 的判据面）。因此本层按
 * 契约**逐字**实现同一形状：八项错误码的码名、`ErrorBase` 的字段、`Result` 的两分支 ——
 * 语义一个字不改、也一个码不增。
 *
 * **合流时的收口项（非契约缺口）**：P1 落地 `application/` 的规范定义后，
 * 呈现层改为从该公共出口 import，本文件随之删除。这不属于 §8 的契约缺口
 * （未冻结任何新语义），属于 §7.3「只在本批有真实消费者时创建目录与文件」的必然过渡 ——
 * 故按批次收口而不是回 #250 裁决。
 */

/** 契约 §3.2 的八个错误码（**不增不减**；理由见契约 §3.2 选择理由）。 */
export type DomainErrorCode =
  | 'InvalidValue'
  | 'ReadOnly'
  | 'MissingTarget'
  | 'StaleReference'
  | 'DocumentBusy'
  | 'VersionConflict'
  | 'UnsupportedOperation'
  | 'WouldBlock'

/** 契约 §3.2 `ErrorBase`：结构化参数 + 诊断关联身份（#249 §19.9）。 */
export interface DomainError {
  code: DomainErrorCode
  /** 结构化参数（供 UI 本地化与诊断关联），**不是**拼好的自然语言。 */
  params: Readonly<Record<string, string | number>>
  commandId?: string
  jobId?: string
  objectId?: string
}

/** 契约 §0：`{ ok: true; value: T } | { ok: false; error: DomainError }`。 */
export type Result<T> = { ok: true; value: T } | { ok: false; error: DomainError }

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function err<T = never>(
  code: DomainErrorCode,
  params: Record<string, string | number> = {},
  extra: Omit<DomainError, 'code' | 'params'> = {},
): Result<T> {
  return { ok: false, error: { code, params, ...extra } }
}
