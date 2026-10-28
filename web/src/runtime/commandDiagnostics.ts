/**
 * `runtime/commandDiagnostics` —— 命令/属性写/装配/呈现版本的**生产发射点**。
 *
 * ## 它补的是哪一类空洞（18 码清单里的无生产者项）
 *
 * 码表统一了，但 `command.*` 六码里只有 `command.unsupported` 有生产者，
 * `property.readOnly`、`module.*`、`presentation.version` 则**只有类型** ——
 * 于是「为什么这条命令被拒/为什么这个属性只读/这次装配裁掉了什么」在诊断面上不可查。
 * 本模块把这三族接到**它们本来就存在的结算点**上：
 *
 * | 事实 | 结算点（唯一） | 码 |
 * |---|---|---|
 * | 命令被接收 / 执行完 | `operators/operatorRegistry#exec` | `command.received` / `command.applied` |
 * | 属性写结算（写成功但值没变） | `editors/workbench-rna#settleFieldWrite` | `command.unchanged` |
 * | 属性写被拒 | 同上（`DomainError.code` 分派） | `command.rejected` / `command.wouldBlock` / `property.readOnly` |
 * | 装配结果 | 宿主构造（`wm` 建好之后） | `module.assembled` / `module.pruned` |
 * | 呈现落地 | 视口 `applyPresenterSurface`（一次求值落地） | `presentation.version` |
 * | 纹理句柄账 | 视口纹理同步结算（`texturePort.sync` 的返回值） | `resource.acquired` / `resource.released` / `resource.leaked` |
 *
 * ## 为什么放在 `runtime/`
 *
 * 它只做"事实 → 稳定码"的搬运（有界记录要求 runtime 关联身份并发），
 * 判定仍在各自的权威处（注册表结算、属性写的 `editStateOf`、装配解析、呈现会话）。
 * 本模块**不**决定任何业务结果，也不读业务状态：入参全是调用方已经算出的结算事实。
 */
import type { DiagnosticRecorder } from '@/application/diagnostics'

/**
 * 领域错误的**结构子集**（不 import `domain/errors`）。
 *
 * 为什么用结构类型而不是 import：本文件在 `runtime/`（旧层），而
 * `kernel-legacy-isolation` 要求旧层 → 内核（`domain/`）的每条边都进
 * `APPROVED_LEGACY_TO_KERNEL_EDGES` 并写清退出条件。而这里需要的只有两个字段
 * （`code` 与标量 `params`）—— 为两个字段登记一条反向依赖边，是把架构清单
 * 变成噪声，而不是保护边界。结构类型同样保证"传错东西编译不过"。
 */
interface DomainErrorLike {
  readonly code: string
  readonly params: Readonly<Record<string, string | number>>
}

/** 装配结果的**结构子集**（同理：不 import `composition/resolver` 的类型）。 */
interface AssemblyLike {
  readonly profileId: string
  readonly modules: readonly unknown[]
  readonly capabilities: readonly string[]
  readonly pruned: readonly { readonly moduleId: string; readonly reason: string; readonly capability: string }[]
  readonly prunedLandings: readonly unknown[]
}

/** 记录器的最小面（`Pick` 便于单测传替身）。 */
export type DiagnosticSink = Pick<DiagnosticRecorder, 'record'>

// ── 命令接收/结算 ────────────────────────────────────────────────────────────

/** 算子执行开始（`OPERATOR_*` 的 `exec` 入口，唯一写点）。 */
export function reportCommandReceived(sink: DiagnosticSink, operatorId: string): void {
  sink.record({
    channel: 'command',
    code: 'command.received',
    params: { operator: operatorId },
    correlation: {},
  })
}

/** 算子执行完成（`FINISHED`；失败由 `command.rejected` 走拒绝结算）。 */
export function reportCommandApplied(sink: DiagnosticSink, operatorId: string): void {
  sink.record({
    channel: 'command',
    code: 'command.applied',
    params: { operator: operatorId, result: 'FINISHED' },
    correlation: {},
  })
}

/** 该错误码是不是"现在不行、条件可能变化"（内核契约 §4.2 的两类）。 */
function isWouldBlockLike(error: DomainErrorLike): boolean {
  return error.code === 'WouldBlock' || error.code === 'DocumentBusy'
}

/**
 * 属性写结算 → 诊断（**唯一分派点**）。
 *
 * 分派口径（不猜文本、不按 message 匹配）：
 *
 * | `CommandOutcome` | 码 | params |
 * |---|---|---|
 * | `unchanged` | `command.unchanged` | `properties`（属性 id 列表，截断 3 条） |
 * | `rejected` + `ReadOnly` | `property.readOnly` | `property` / `reason` |
 * | `rejected` + `WouldBlock`/`DocumentBusy` | `command.wouldBlock` | `reason`（= 领域码）/ `property` |
 * | `rejected` + 其它 | `command.rejected` | `code`（领域码）/ `property` |
 * | `applied` | **不记** | 逐条成功事件不进诊断（避免每格编辑一条记录挤掉别的通道） |
 */
export function reportPropertyWriteSettlement(
  sink: DiagnosticSink,
  outcome:
    | { readonly status: 'applied' }
    | { readonly status: 'unchanged' }
    | { readonly status: 'rejected'; readonly error: DomainErrorLike },
  propertyIds: readonly string[],
): void {
  if (outcome.status === 'applied') return
  const properties = propertyIds.slice(0, 3).join(',')
  if (outcome.status === 'unchanged') {
    sink.record({
      channel: 'command',
      code: 'command.unchanged',
      params: { properties, count: propertyIds.length },
      correlation: {},
    })
    return
  }
  const error = outcome.error
  if (error.code === 'ReadOnly') {
    const reason = typeof error.params.reason === 'string' ? error.params.reason : 'read-only'
    sink.record({
      channel: 'property',
      code: 'property.readOnly',
      params: { property: properties, reason, count: propertyIds.length },
      correlation: {},
    })
    return
  }
  if (isWouldBlockLike(error)) {
    sink.record({
      channel: 'command',
      code: 'command.wouldBlock',
      params: { reason: error.code, property: properties },
      correlation: {},
    })
    return
  }
  sink.record({
    channel: 'command',
    code: 'command.rejected',
    params: { code: error.code, property: properties },
    correlation: {},
  })
}

// ── 装配 ────────────────────────────────────────────────────────────────────

/**
 * 装配结果 → 两条诊断（每次装配**一次**，不是每帧）。
 *
 * `module.assembled` 带保留数与能力数；`module.pruned` **逐条**记裁剪原因（`prunedLandings`
 * 已按落点粒度给出"哪个落点缺哪个能力"）—— "裁剪"是用户在界面里能感知的（少了一个菜单项/
 * 编辑器类型），因此它必须是可查询事实，而不是只写在装配对象里。
 */
export function reportModuleAssembly(sink: DiagnosticSink, assembly: AssemblyLike): void {
  sink.record({
    channel: 'module',
    code: 'module.assembled',
    params: {
      profile: assembly.profileId,
      modules: assembly.modules.length,
      capabilities: assembly.capabilities.length,
      pruned: assembly.pruned.length,
      prunedLandings: assembly.prunedLandings.length,
    },
    correlation: {},
  })
  for (const p of assembly.pruned) {
    sink.record({
      channel: 'module',
      code: 'module.pruned',
      params: { module: p.moduleId, reason: p.reason, capability: p.capability, optional: true },
      correlation: {},
    })
  }
}

// ── 呈现版本 ────────────────────────────────────────────────────────────────

/**
 * 一次呈现落地 → `presentation.version`（实际/目标呈现版本）。
 *
 * 只在**新的求值真的落地**时调用（`applyIfChanged` 返回 `applied === true`，
 * 或本次编译有错误/跳过项）—— 去重命中时它每帧都会返回 `applied:false`，
 * 在那里发记录会把 512 条缓冲变成帧心跳。
 */
export function reportPresentationVersion(
  sink: DiagnosticSink,
  facts: {
    readonly applied: boolean
    readonly targetDocumentVersion: number
    readonly actualDocumentVersion: number
    readonly batches: number
    readonly compileError?: string
    readonly skipped?: number
  },
): void {
  sink.record({
    channel: 'presentation',
    code: 'presentation.version',
    params: {
      applied: facts.applied,
      batches: facts.batches,
      ...(facts.compileError === undefined ? {} : { compileError: facts.compileError }),
      ...(facts.skipped === undefined ? {} : { skipped: facts.skipped }),
    },
    correlation: {
      actualPresentationVersion: facts.actualDocumentVersion,
      targetPresentationVersion: facts.targetDocumentVersion,
    },
  })
}

// ── 纹理句柄账（资源拥有者与引用数）────────────────────────────

/**
 * 一次纹理同步的**句柄账**（acquire/release）+ 卸载时的泄漏登记。
 *
 * 为什么在同步结算处而不是逐张纹理：`texturePort.sync` 已经聚合成
 * `{ uploaded, released, ready }`（一次同步最多一次结算），逐张记会写爆 512 条缓冲，
 * 而"这一轮拿了多少、放了多少、现在活多少"正是资源对账要读的三个数。
 */
export function reportResourceLedger(
  sink: DiagnosticSink,
  facts: {
    readonly viewportId: string
    readonly uploaded: number
    readonly released: number
    readonly ready: number
    readonly attempt: number
  },
): void {
  if (facts.uploaded > 0) {
    sink.record({
      channel: 'resource',
      code: 'resource.acquired',
      params: { count: facts.uploaded, ready: facts.ready, owner: 'viewport-texture', attempt: facts.attempt },
      correlation: { viewportId: facts.viewportId },
    })
  }
  if (facts.released > 0) {
    sink.record({
      channel: 'resource',
      code: 'resource.released',
      params: { count: facts.released, ready: facts.ready, owner: 'viewport-texture' },
      correlation: { viewportId: facts.viewportId },
    })
  }
}

/**
 * 视口销毁时仍有存活纹理句柄 ⇒ `resource.leaked`（不得泄漏 GPU 份额）。
 *
 * 调用点在"释放之后"：`texturePort.dispose()` 之后 `size` 若仍 > 0，说明有句柄没被回收。
 * 这是**实现缺陷**信号（正常路径恒为 0），故它是 ERROR 级并进用户可见日志。
 */
export function reportResourceLeaked(
  sink: DiagnosticSink,
  facts: { readonly viewportId: string; readonly live: number },
): void {
  if (facts.live <= 0) return
  sink.record({
    channel: 'resource',
    code: 'resource.leaked',
    params: { live: facts.live, owner: 'viewport-texture' },
    correlation: { viewportId: facts.viewportId },
  })
}