/**
 * **算子的可用性（availability）结算** —— 唯一实现。
 *
 * ## 它解决什么
 *
 * `OperatorType.poll` 一直有一条契约："返回 false 时操作符在 UI 中灰掉"
 * （`operators/operatorType` 的字段注释）。但 **UI 侧从未实现**这条契约：
 * `UIMenu.vue` 直接把菜单项渲染成可点按钮，点击一律 `invoke`。
 * 于是"保存到 Wiki"这类 `poll` 为 false 的项**可以点**，点了也没有任何可见反应
 * （`registry.invoke` 只写一条 `log.info`）—— 用户看到的是"点了没反应"，而不是
 * "为什么不可用、下一步做什么"（「不可编辑不能表现为静默成功」）。
 *
 * ## 为什么是一个共享函数，而不是各处各判一次
 *
 * 四条入口必须给**同一个答案**：
 *
 * | 入口 | 用途 |
 * |---|---|
 * | `OperatorRegistry#exec` | 执行前**最终防线**（脚本/快捷键/命令面） |
 * | `OperatorRegistry#invoke` | 交互前最终防线（菜单之外的入口：Ctrl+S、键位表…） |
 * | `UIMenu`（生产菜单渲染） | 灰显 + 原因（**呈现**，不是第二权威） |
 * | 判据（单测/e2e） | 读同一条结算，不另写判定 |
 *
 * 反过来说：**UI 的灰显不构成"不可用"的权威**。点击路径仍然在 registry 里重新结算
 * （`invoke` 的 gate 在每次调用时现算），所以"快照过期 ⇒ 可点"绝不会变成
 * "绕过了 gate"：那一次调用会以同样的原因被拒绝并出现在底栏。
 *
 * ## 能力的两个来源，一个结算点
 *
 * | 事实 | 来源 | 结论 |
 * |---|---|---|
 * | 装配是否具备能力 | `OperatorType.requires` + `ctx.hasCapability` | 缺 ⇒ `UnsupportedOperation:capability-unavailable`（既有拒绝链，不是新错误码） |
 * | 当前上下文是否适用 | `OperatorType.poll` | false ⇒ `UnsupportedOperation:<pollReason>`（**已有八码之一**，未新增错误码） |
 *
 * ## `pollReason`：为什么是"可选"的
 *
 * `poll` = false 的历史语义很宽：从"当前不适用/没什么可做"（撤销栈空、未选中目标）
 * 到"用户必须换个做法"（当前文档不是 Wiki 载入的）。前者不该弹拒绝（"撤销栈空"
 * 不是失败，见 `application` 的 `unchanged` 语义），后者必须说清下一步。
 *
 * ⇒ 由算子**自己声明**它属于哪一类：
 *
 * | 是否声明 `pollReason` | UI（菜单项） | `exec`/`invoke` |
 * |---|---|---|
 * | 声明了 | 灰显 + 该原因（句首含"不可用"） | 结构化拒绝 + 底栏成句原因（`refuseUnavailableOperator`） |
 * | 没声明（缺省） | 灰显 + **通用**原因（"当前上下文不满足该操作的前提"） | 与改动前逐字一致：只写 `log.info`，不弹拒绝 |
 *
 * 这一分叉是**按算子声明**的，而不是按入口声明的 —— 于是"同一个算子在菜单、Ctrl+S、
 * 脚本里得到同一句话"是结构性成立的（`pollReason` 只有一份）。 *
 * ## 错误码：不新增（八码冻结）
 *
 * poll 拒绝一律是 `UnsupportedOperation`（`params.reason` 承担精确性），且**构造子**放在
 * `capabilityRefusal`（那里已登记 `operators/ → domain/errors` 的旧→新边）。本文件只做
 * **判定**，不造第二份拒绝语义、不新增一条边界边。
 *
 * ## 求值时机（禁止渲染循环里反复求值）
 *
 * `poll` 可能有真实开销（例：Wiki 保存要经 `plainForSave()` 做差集比较）。
 * 本条不改变 poll 的调用者结构：`UIMenu` **只在"菜单打开 / items 变化"时**对每项求值
 * 一次并缓存（见 `UIMenu.vue` 的 `availability`）；渲染期只读缓存，不再求值。
 * 点击执行时由 registry 按当前事实**重新** poll（那是"最终防线"，不是第二份缓存）。
 */
import type { Context } from '@/runtime/context'
import type { OperatorType } from './operatorType'
import { rejectionReason } from '@/domain/rejectionText'
import { langOf } from '@/runtime/rejectionNotice'
import { capabilityUnavailableError, operatorUnavailableError } from './capabilityRefusal'

/**
 * **`poll` 拒绝的原因标识**（`DomainError.params.reason` 的取值）。
 *
 * ⚠️ 这些是**原因**（`reason`），不是错误码：错误码仍是 `domain/errors` 冻结的八项
 * （这里一律用 `UnsupportedOperation`）。加原因必须同时在
 * `domain/rejectionText` 的 `REASONS` 里给两种语言各写一条 —— 那条"逐条对照"
 * 判据（`rejectionText.test.ts`）会拦下漏写的条目。
 */
export const POLL_REASON = {
  /**
   * **通用原因**：算子没有声明 `pollReason`，或声明了却给不出更具体的原因。
   * 句子必须诚实地只说到这里（不编造"因为你没选中/没打开"之类的猜测）。
   */
  GENERIC: 'operator-unavailable',
  /** Wiki 保存：当前文档**不是**从 Wiki 载入的结构数据（下一步是"另存为 Wiki 结构"）。 */
  NOT_WIKI_DATA_DOCUMENT: 'not-wiki-data-document',
  /** Wiki 保存：文档是 Wiki 载入的，但**没有可审计的变更**（与保存基线一致）。 */
  NO_AUDITABLE_CHANGES: 'no-auditable-changes',
} as const

export type OperatorPollReason = (typeof POLL_REASON)[keyof typeof POLL_REASON]

/**
 * 拒绝值的类型：从**构造子**推导，不在这里 `import type { DomainError } from '@/domain/errors'`。
 *
 * 理由：那会在旧层（`operators/`）新增一条**指向内核**的导入边
 * （`tests/architecture/kernel-legacy-isolation.test.ts` 的旧→新依赖清单），而拒绝值的
 * 构造已经收在 `capabilityRefusal`（那里登记过该边）。本文件因此只依赖同层模块
 * + 文案层，边数不增。
 */
type RefusalError = ReturnType<typeof operatorUnavailableError>
/**
 * 结算所需的算子面（`OperatorType` 的结构子集）。
 *
 * 用窄类型而不是整个 `OperatorType`：调用方（菜单）从注册表取到的就是这条面，
 * 判据可以喂一个只声明 `poll`/`pollReason` 的算子来钉"通用原因"路径。
 */
export type OperatorAvailabilityInput = Pick<OperatorType, 'id' | 'label'> &
  Partial<Pick<OperatorType, 'requires' | 'poll' | 'pollReason'>>

/** 可用（没有能力缺口、`poll` 为真或未声明）。 */
export interface OperatorAvailable {
  readonly enabled: true
}

/**
 * 不可用。`source` 说明**是哪条事实**说不的（呈现与拒绝都读它）：
 *  - `capability`：装配事实（`requires` 缺一项）；
 *  - `poll-declared`：上下文事实 + 算子**声明了**可行动的原因 ⇒ 拒绝必须可见；
 *  - `poll-generic`：上下文事实 + 没声明原因 ⇒ UI 只给通用原因，exec/invoke 保持原样。
 */
export interface OperatorUnavailable {
  readonly enabled: false
  readonly source: 'capability' | 'poll-declared' | 'poll-generic' | 'poll-error'
  /** 缺的能力（仅 `source === 'capability'`）。 */
  readonly capability?: string
  /** 结构化拒绝值（八码之一；`params.reason` = 上面的原因标识）。 */
  readonly error: RefusalError
  /** **成句原因**（本实例语言；不含句首"X 被拒："）。菜单 title/aria 与底栏共用它。 */
  readonly reason: string
}

export type OperatorAvailability = OperatorAvailable | OperatorUnavailable

const AVAILABLE: OperatorAvailable = Object.freeze({ enabled: true })

/**
 * **结算本身抛错**时的不可用值（供 UI 做**逐项异常隔离**）。
 *
 * ## 为什么需要它（且为什么只在 UI 侧用）
 *
 * `poll`/`pollReason` 是算子自己的代码，可能抛（例：读一个尚未装配的读面）。`registry` 的
 * 两条入口**保持原语义**：异常照旧抛给调用方（那是执行路径的事实，吞掉会让"点了没反应"
 * 变成"点了报了个假原因"）。但**菜单**不一样：一个坏项把整份文件菜单打成空白/崩溃，会让
 * 用户连别的命令都点不到 —— 那是比缺陷本身更糟的后果。
 *
 * ⇒ UI 侧逐项 try/catch：抛错项 = 不可用 + **通用原因**（不编造），并另写一条 error 日志
 * （可诊断、可见）；其它项照常结算。
 *
 * 注意这里**不是**把异常翻译成业务原因：`reason` 用的就是通用条目（"当前上下文不满足该
 * 操作的前提"），错误码也仍是 `UnsupportedOperation` —— 不新增冻结错误码、不新增语义。
 */
export function operatorAvailabilityFailed(
  ctx: Context,
  op: OperatorAvailabilityInput,
): OperatorUnavailable {
  const error = operatorUnavailableError(op, POLL_REASON.GENERIC)
  return {
    enabled: false,
    source: 'poll-error',
    error,
    reason: rejectionReason(error, langOf(ctx)),
  }
}

/**
 * **唯一结算点**：能力 → `poll` → （仅当 false）`pollReason`。
 *
 * `pollReason` 是可选字段 —— 缺省时给 {@link POLL_REASON.GENERIC}，
 * 不做 `op.pollReason(ctx)` 的无保护调用（那会在未实现的算子上抛 `TypeError`）。
 *
 * `poll` 只在**这一处**对本函数调用者求值一次；`pollReason` **只**在 poll 为 false
 * 时求值（成功路径不付第二次开销）。
 */
export function operatorAvailability(
  ctx: Context,
  op: OperatorAvailabilityInput,
): OperatorAvailability {
  for (const capability of op.requires ?? []) {
    if (ctx.hasCapability(capability)) continue
    const error = capabilityUnavailableError(op, capability)
    return {
      enabled: false,
      source: 'capability',
      capability,
      error,
      reason: rejectionReason(error, langOf(ctx)),
    }
  }
  if (op.poll === undefined || op.poll(ctx)) return AVAILABLE
  const declared = op.pollReason === undefined ? undefined : op.pollReason(ctx)
  const error = operatorUnavailableError(op, declared ?? POLL_REASON.GENERIC)
  return {
    enabled: false,
    source: declared === undefined ? 'poll-generic' : 'poll-declared',
    error,
    reason: rejectionReason(error, langOf(ctx)),
  }
}

