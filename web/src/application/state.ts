/**
 * `application/state` —— **应用状态**（`reduceCommand` 的输入）。
 *
 * ## 为什么需要它，以及它与 `Context`/`Main` 的区别
 *
 * 内核不允许把职责不明的 `Main`、万能 `Context` 作为新核心容器。
 * `ApplicationState` 与它们的关键差别不是"名字换了"，而是：
 *
 *  1. **它是值**：全部字段只读，变更返回新值。`Main` 是可变对象 + Vue Ref 容器。
 *  2. **它不含运行实例**：没有 Vue Ref、没有 Three 对象、没有 DOM 句柄、没有注册表实例。
 *     故 `read` 天然无法"导出内部 Vue Ref"（内核契约 §2.1 明文）。
 *  3. **它可序列化**：`reduceCommand` 的任何输入都能进记录并重放。
 *  4. **它是自足的纯领域状态**：`domain/document` 的文档 + 编辑上下文与租约都在里面。
 *
 * ## 多文档
 *
 * 应用可以打开多个文档。故文档按 ID 索引，`EditContext` 各自绑定一个。
 * 「不提供跨文档编辑事务」⇒ 一条命令只作用于**一个**文档。
 */

import type { Document, SaveLedger } from '@/domain/document'
import type { EditContext, DocumentLease } from '@/domain/editing'
import type { IdState } from '@/domain/identity'

/**
 * 应用状态。
 *
 * `docs` / `contexts` / `leases` 都用 `Readonly<Record<...>>` 而非 `Map`：
 * `Map` 是可变容器，把它放进"不可变状态"会让结构共享与内容身份比较出现漏洞
 * （同一个 Map 被两处持有 ⇒ "新容器"与"旧内容"混淆）。`Record` 强制每次变更造新对象。
 */
export interface ApplicationState {
  readonly docs: Readonly<Record<string, Document>>
  readonly contexts: Readonly<Record<string, EditContext>>
  /** 文档级修改租约，按文档 ID 索引。 */
  readonly leases: Readonly<Record<string, DocumentLease>>
  /** 每文档的保存写入台账（保存写入串行化与竞态判定的状态）。 */
  readonly saveLedgers: Readonly<Record<string, SaveLedger>>
  /** 身份分配状态（显式输入，见 `domain/identity`）。 */
  readonly ids: IdState
  /**
   * 已发出的效果描述序列。
   *
   * 为什么效果描述在状态里：重放要求「逐提交语义摘要与**效果序列**一致」。
   * 若效果只由执行器旁路收集，重放就无法给出同一序列。把它作为状态的**只增记录**，
   * 使"相同输入 ⇒ 相同效果描述序列"成为结构性质，而不是靠执行器自觉。
   */
  readonly effects: readonly EffectRequest[]
}

/**
 * 效果请求描述（`submit` 的"接收不等于已生效"）。
 *
 * 注意：这是**描述**，不是执行。发起、完成、过期由 `runtime/effects` 处理；
 * 纯转移只负责"描述应当发生什么"（「隐式发事件」被禁止，故描述是纯数据）。
 */
export interface EffectRequest {
  readonly kind: 'save' | 'load' | 'evaluate' | 'export'
  /** 关联身份（结构化诊断）。 */
  readonly correlationId: string
  readonly params: Readonly<Record<string, string | number>>
}

export function emptyApplicationState(prefix = 'wk'): ApplicationState {
  return Object.freeze({
    docs: Object.freeze({}),
    contexts: Object.freeze({}),
    leases: Object.freeze({}),
    saveLedgers: Object.freeze({}),
    ids: Object.freeze({ prefix, counter: 0 }),
    effects: Object.freeze([]),
  })
}

export function getDocument(state: ApplicationState, documentId: string): Document | undefined {
  return Object.prototype.hasOwnProperty.call(state.docs, documentId) ? state.docs[documentId] : undefined
}

export function getContext(state: ApplicationState, contextId: string): EditContext | undefined {
  return Object.prototype.hasOwnProperty.call(state.contexts, contextId) ? state.contexts[contextId] : undefined
}

export function getLease(state: ApplicationState, documentId: string): DocumentLease | undefined {
  return Object.prototype.hasOwnProperty.call(state.leases, documentId) ? state.leases[documentId] : undefined
}

export function getSaveLedger(state: ApplicationState, documentId: string): SaveLedger | undefined {
  return Object.prototype.hasOwnProperty.call(state.saveLedgers, documentId) ? state.saveLedgers[documentId] : undefined
}
