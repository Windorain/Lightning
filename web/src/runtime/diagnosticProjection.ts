/**
 * `runtime/diagnosticProjection` —— **C1 → C2/C3 的唯一投影**（M8-6 通道收口）。
 *
 * ## 它替代什么（S0-B §4.1/§4.3）
 *
 * 收口之前，同一件事最多写三处、各写各的：
 *
 * | 通道 | 载体 | 收口前的问题 |
 * |---|---|---|
 * | C1 | `wm.diagnostics`（512 环形，稳定码） | **唯一结构化面**，但没有 UI 消费者 |
 * | C2 | `ctx.log`（2000 环形，人读） | `Report` **无 code** ⇒ 不可按码聚合；诊断类条目与普通日志混在一起 |
 * | C3 | `ctx.log.liveStatus`（单值） | 与 C1 同一事实各写一遍，字段不同构（无 code 级对应） |
 *
 * 现在的形状：**C1 是唯一结构化诊断面**，C2/C3 是它的**投影**——
 * 投影函数只吃 `DiagnosticRecord`（`code` + `params` + `correlation`），不读任何
 * 业务状态、不接受额外参数。于是"同一事实两条通道各自演化"在结构上不可能：
 * 想改底栏那句话，只能改本文件里那张表，改不动别的写点。
 *
 * ## 三条边界（都有单测钉）
 *
 * 1. **不改记录、不驱动业务**：投影只读记录；它抛错被记录器吞掉（见
 *    `createDiagnosticRecorder` 的 `observe` 说明），业务结果与诊断记录都不受影响；
 * 2. **有界**：进 C2 的只有"需要人看一眼"的码（失败/拒绝/降级/设备/恢复），
 *    成功类逐条事件（`command.applied` 这类）**不**刷进 2000 条日志里 ——
 *    否则一次拖拽就能把操作反馈挤出可读范围；
 * 3. **不抢显示位**：投影写 C2 用 `log.event()`（不更新 `lastDisplayable`），
 *    写 C3 只限 `device.*`（一句话事实；其余用户面在底栏诊断列表里读 C1）。
 *
 * ## C3 为什么只覆盖 `device.*`
 *
 * `device.lost`/`device.restored` 的用户可见文案是**常量**（与 `params` 无关），
 * 因此可以逐字从码投影。另外两条链的文案依赖记录之外的**状态**：
 *
 * - `recovery.*` 的"损坏的恢复副本 N 份"是**状态计数**（多条 `recovery.corrupt` 记录对应
 *   一句话），逐条投影会得到 N 句 "1 份"——比不投影更糟；它仍在**发记录的同一次结算**里
 *   写（`composition/recoverySession` 的 `host.live`，单一写点，与记录同一函数）；
 * - `resource.*` 的点名文案依赖**未就绪资源清单**（不是记录的 `params`），由
 *   `composition/resourceDiagnostics#reportOutcome` 与记录**同一次计算**产出，视口只负责落地。
 *
 * 这两条是"同一结算点发射多处可读"（任务允许的另一种收口形态），不是第二套判定。
 */
import type { DiagnosticChannel, DiagnosticReasonCode, DiagnosticRecord } from '@/application/diagnostics'
import { LOG_LEVEL, type LiveStatusOrigin, type LogLevelValue, type createLogCenter } from '@/logging/LogCenter'

/** 投影只需要的两个写方法（结构类型，便于单测用替身）。 */
export type DiagnosticProjectionPort = Pick<ReturnType<typeof createLogCenter>, 'event' | 'setLiveStatus'>

/**
 * 设备丢失/恢复的用户可见文案与机器可读状态（M8-3 引入，M8-6 移到投影表）。
 *
 * 文案是**常量**：`params` 里的放弃数/代次进日志（C2）与诊断列表，不进这句人话 ——
 * 那句人话要回答的是"我该不该担心"，细节在列表里点开就有。
 */
export const DEVICE_LOST_MESSAGE =
  '显示设备已丢失：画面已暂停，内容与编辑状态未受影响；设备恢复后会自动重建画面。'
export const DEVICE_RESTORED_MESSAGE =
  '显示设备已恢复：正在按当前内容重建画面，内容与编辑状态未受影响。'
export const DEVICE_LOST_STATE = 'device-lost'
export const DEVICE_RESTORED_STATE = 'device-restored'

/** 稳定码 → 严重级（决定日志级别与底栏最高级别读面；**不**决定是否记录）。 */
function levelOf(code: DiagnosticReasonCode): LogLevelValue {
  // 失败/损坏/丢失类：错误
  if (
    code === 'recovery.writeFailed' ||
    code === 'recovery.adoptFailed' ||
    code === 'recovery.corrupt' ||
    code === 'effect.failed' ||
    code === 'export.failed' ||
    code === 'export.encodingNotConfigured' ||
    code === 'export.emptyScene' ||
    code === 'resource.leaked' ||
    code === 'resource.failed' ||
    code === 'device.lost'
  ) {
    return LOG_LEVEL.ERROR
  }
  // 拒绝/阻塞/降级/不可表达：警告
  if (
    code === 'command.rejected' ||
    code === 'command.wouldBlock' ||
    code === 'command.unsupported' ||
    code === 'property.readOnly' ||
    code === 'content.rejected' ||
    code === 'resource.degraded' ||
    code === 'resource.retryRequested' ||
    code.startsWith('export.')
  ) {
    return LOG_LEVEL.WARN
  }
  return LOG_LEVEL.INFO
}

/**
 * 该码是否要进 C2（人读日志）。
 *
 * 规则（一句话）：**失败/拒绝/降级/设备生命周期**进日志；**逐条成功事件**不进。
 * 后者进日志会让 2000 条环形缓冲被 "command.applied" 这类高频条目挤满 ——
 * 那不是"可观测"，而是把日志变成噪声（同一理由见 `composition/resourceDiagnostics`
 * 的 8 条封顶）。
 */
/**
 * 码 → 严重级（**唯一**映射；日志级别与底栏诊断区共用它）。
 *
 * 为什么必须只有一个函数：底栏若自己写一套"哪些码算严重"，同一码就会在日志里是 WARN、
 * 在底栏是 info —— 那正是收口要消灭的"同一事实两套判定"。
 */
export function diagnosticSeverityOf(code: DiagnosticReasonCode): 'error' | 'warn' | 'info' {
  // `module.pruned` 是**装配事实**（缺可选能力 ⇒ 摘掉落点），不是缺陷：健康启动也可能有它，
  // 故它按 info 处理（底栏诊断区不常驻显示它；机读面照样可查）。
  if (code === 'module.pruned') return 'info'
  const level = levelOf(code)
  return level === LOG_LEVEL.ERROR ? 'error' : level === LOG_LEVEL.WARN ? 'warn' : 'info'
}

export function shouldProjectToLog(code: DiagnosticReasonCode): boolean {
  if (code === 'module.pruned') return true
  if (levelOf(code) >= LOG_LEVEL.WARN) return true
  return code.startsWith('device.') || code.startsWith('recovery.')
}

/** 一条记录 → C2 的一行人读文本（**不含自然语言**：码 + 标量参数，可 grep/可聚合）。 */
export function diagnosticLine(record: DiagnosticRecord): string {
  const parts: string[] = [record.code]
  const correlation = record.correlation
  const ids: string[] = []
  if (correlation.objectId !== undefined) ids.push(`object=${correlation.objectId}`)
  if (correlation.viewportId !== undefined) ids.push(`viewport=${correlation.viewportId}`)
  if (correlation.commandId !== undefined) ids.push(`command=${correlation.commandId}`)
  if (correlation.jobId !== undefined) ids.push(`job=${correlation.jobId}`)
  if (correlation.documentVersion !== undefined) ids.push(`docVersion=${correlation.documentVersion}`)
  if (correlation.deviceGeneration !== undefined) ids.push(`deviceGeneration=${correlation.deviceGeneration}`)
  if (ids.length > 0) parts.push(ids.join(' '))
  for (const [k, v] of Object.entries(record.params)) parts.push(`${k}=${String(v)}`)
  return parts.join(' · ')
}

/** C3 投影：只有"文案是码的常量函数"的记录才投影成实时状态。 */
export function liveStatusOf(record: DiagnosticRecord): {
  readonly message: string
  readonly level: LogLevelValue
  readonly state: string
  readonly origin: LiveStatusOrigin
} | null {
  if (record.code === 'device.lost') {
    return { message: DEVICE_LOST_MESSAGE, level: LOG_LEVEL.WARN, state: DEVICE_LOST_STATE, origin: 'device' }
  }
  if (record.code === 'device.restored') {
    return { message: DEVICE_RESTORED_MESSAGE, level: LOG_LEVEL.INFO, state: DEVICE_RESTORED_STATE, origin: 'device' }
  }
  return null
}

/** 通道名（日志的 `source` 用它，与 `byChannel` 同口径）。 */
export function channelOf(record: DiagnosticRecord): DiagnosticChannel {
  return record.channel
}

/**
 * 造一个投影观察者（交给 `createDiagnosticRecorder({ observe })`）。
 *
 * 生产接线点：`runtime/host/workbenchHost` / `runtime/host/embedHost` 在构造 `WM` 之后
 * **立刻**调用 `wm.observeDiagnostics(createDiagnosticProjection(log))` —— 早于第一份文档
 * 装载，因此装载期的诊断（资源/内容拒绝）也进得了 C2/C3。
 */
export function createDiagnosticProjection(port: DiagnosticProjectionPort) {
  return (record: Readonly<DiagnosticRecord>): void => {
    if (shouldProjectToLog(record.code)) {
      port.event({
        code: record.code,
        channel: channelOf(record),
        level: levelOf(record.code),
        message: diagnosticLine(record),
        detail: { params: record.params, correlation: record.correlation, seq: record.seq },
      })
    }
    const live = liveStatusOf(record)
    if (live !== null) {
      port.setLiveStatus(live.message, live.level, live.state, live.origin)
    }
  }
}
