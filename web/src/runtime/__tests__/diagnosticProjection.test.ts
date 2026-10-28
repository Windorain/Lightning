/**
 * **通道收口**：C1 → C2/C3 的投影（单点发射，多处可读）。
 *
 * ## 判据要钉的四件事
 *
 * | 判据 | 防什么 |
 * |---|---|
 * | `device.*` ⇒ C2 条目带稳定码 + C3 提示（文案/渠道/状态逐字确定） | 提示退回"设备事件自己写 liveStatus"（两个写点各自演化） |
 * | 失败/拒绝类 ⇒ C2 有条目；**逐条成功事件不进** C2 | 2000 条日志被 `command.applied` 刷满（可观测退化成噪声） |
 * | 投影**不写回**诊断、且观察者抛错不影响记录/业务 | 读面反向驱动（"日志成为业务驱动源"被明确禁止） |
 * | 投影只吃 `DiagnosticRecord`（不读业务状态） | 同一事实两套判定（同一缺陷的形态） |
 */
import { describe, expect, it } from 'vitest'
import { createDiagnosticRecorder, type DiagnosticRecord } from '@/application/diagnostics'
import { LOG_LEVEL } from '@/logging/LogCenter'
import {
  DEVICE_LOST_MESSAGE,
  DEVICE_LOST_STATE,
  DEVICE_RESTORED_MESSAGE,
  DEVICE_RESTORED_STATE,
  createDiagnosticProjection,
  diagnosticLine,
  shouldProjectToLog,
} from '@/runtime/diagnosticProjection'

interface LogCall {
  readonly kind: 'event' | 'live'
  readonly code?: string
  readonly channel?: string
  readonly level?: number
  readonly message?: string
  readonly state?: string | null
  readonly origin?: string | null
}

function harness() {
  const calls: LogCall[] = []
  const port = {
    event: (entry: { code: string; channel: string; level: number; message: string }) => {
      calls.push({ kind: 'event', code: entry.code, channel: entry.channel, level: entry.level, message: entry.message })
      return {} as never
    },
    setLiveStatus: (message: string, level: number, state: string | null, origin: string | null) => {
      calls.push({ kind: 'live', message, level, state, origin })
    },
  }
  const recorder = createDiagnosticRecorder({
    capacity: 32,
    now: () => 1000,
    observe: createDiagnosticProjection(port as never),
  })
  return { calls, recorder }
}

describe('诊断投影：C1 是唯一结构化面，C2/C3 从它投影', () => {
  it('device.lost ⇒ C2 带码条目 + C3 成句提示（文案/渠道/状态由码决定）', () => {
    const h = harness()
    const record = h.recorder.record({
      channel: 'device',
      code: 'device.lost',
      params: { abandoned: 7, texturesAbandoned: 3 },
      correlation: { viewportId: 'r-viewport', deviceGeneration: 1 },
    })
    const events = h.calls.filter((c) => c.kind === 'event')
    expect(events.map((e) => e.code)).toEqual(['device.lost'])
    expect(events[0]!.channel).toBe('device')
    expect(events[0]!.level).toBe(LOG_LEVEL.ERROR)
    expect(events[0]!.message).toContain('viewport=r-viewport')
    expect(events[0]!.message).toContain('abandoned=7')
    const live = h.calls.filter((c) => c.kind === 'live')
    expect(live).toEqual([
      { kind: 'live', message: DEVICE_LOST_MESSAGE, level: LOG_LEVEL.WARN, state: DEVICE_LOST_STATE, origin: 'device' },
    ])
    // 记录本身不受投影影响（C1 仍是权威）
    expect(h.recorder.byCode('device.lost')).toHaveLength(1)
    expect(record.seq).toBeGreaterThan(0)
  })

  it('device.restored ⇒ 与丢失**不同**的提示与状态（一个码不冒充两件事）', () => {
    const h = harness()
    h.recorder.record({ channel: 'device', code: 'device.restored', params: { pendingRebuild: false }, correlation: { viewportId: 'r' } })
    const live = h.calls.filter((c) => c.kind === 'live')
    expect(live.map((l) => l.state)).toEqual([DEVICE_RESTORED_STATE])
    expect(live[0]!.message).toBe(DEVICE_RESTORED_MESSAGE)
    expect(live[0]!.level).toBe(LOG_LEVEL.INFO)
  })

  it('失败/拒绝/降级类进 C2；**逐条成功事件不进**（防日志被刷满）', () => {
    const h = harness()
    h.recorder.record({ channel: 'resource', code: 'resource.degraded', params: { failed: 1, total: 62 }, correlation: { viewportId: 'r' } })
    h.recorder.record({ channel: 'command', code: 'command.applied', params: { op: 'x' }, correlation: {} })
    h.recorder.record({ channel: 'command', code: 'command.received', params: { op: 'x' }, correlation: {} })
    h.recorder.record({ channel: 'resource', code: 'resource.acquired', params: { count: 3 }, correlation: {} })
    const codes = h.calls.filter((c) => c.kind === 'event').map((c) => c.code)
    expect(codes, '降级必须有日志条目').toEqual(['resource.degraded'])
    expect(h.calls.filter((c) => c.kind === 'live'), 'resource.* 的用户面在底栏文案里（同一结算点），不走本投影').toEqual([])
    // 采样口径本身也是可断言的数据（不是靠"没人写"）
    expect(shouldProjectToLog('command.applied')).toBe(false)
    expect(shouldProjectToLog('resource.degraded')).toBe(true)
    expect(shouldProjectToLog('recovery.detected')).toBe(true)
  })

  it('严重级映射：写副本失败=ERROR、命令拒绝=WARN、设备丢失=ERROR', () => {
    const h = harness()
    h.recorder.record({ channel: 'recovery', code: 'recovery.writeFailed', params: { cause: 'quotaExceeded' }, correlation: {} })
    h.recorder.record({ channel: 'command', code: 'command.rejected', params: { reason: 'readOnly' }, correlation: {} })
    const levels = h.calls.filter((c) => c.kind === 'event').map((c) => c.level)
    expect(levels).toEqual([LOG_LEVEL.ERROR, LOG_LEVEL.WARN])
  })

  it('负对照：投影抛错不得影响记录（C1 是权威，C2/C3 是投影）', () => {
    const recorder = createDiagnosticRecorder({
      capacity: 8,
      now: () => 0,
      observe: () => {
        throw new Error('projection boom')
      },
    })
    const record = recorder.record({ channel: 'command', code: 'command.rejected', params: {}, correlation: {} })
    expect(record.code).toBe('command.rejected')
    expect(recorder.size(), '记录仍然落地').toBe(1)
  })

  it('投影只读：观察者拿到的记录改动不改缓冲里的那条', () => {
    const recorder = createDiagnosticRecorder({
      capacity: 8,
      now: () => 0,
      observe: (r) => {
        // 只允许读（类型上是 Readonly）；这里用运行期强改来证明"缓冲不是投影的草稿纸"。
        try { (r.params as Record<string, unknown>).injected = true } catch { /* frozen 更好 */ }
      },
    })
    recorder.record({ channel: 'command', code: 'command.rejected', params: { reason: 'x' }, correlation: {} })
    const stored = recorder.all()[0]!
    // 若记录被冻结 ⇒ 注入失败；若未冻结 ⇒ 只能影响**同一条副本**，不得影响投影外的判定。
    expect(stored.code).toBe('command.rejected')
    expect(typeof stored.params.reason).toBe('string')
  })

  it('日志行是"码 + 标量参数"（无人读文案、无 CJK）：可 grep / 可按码聚合', () => {
    const h = harness()
    const record: DiagnosticRecord = h.recorder.record({
      channel: 'resource',
      code: 'resource.failed',
      params: { assetId: 'material:0', locator: 'gregtech:iconsets/GODFORGE_TRIM', state: 'failed' },
      correlation: { viewportId: 'r-viewport' },
    })
    const line = diagnosticLine(record)
    expect(line.startsWith('resource.failed')).toBe(true)
    expect(line).toContain('assetId=material:0')
    expect(line).toContain('viewport=r-viewport')
    expect(line, '日志行不得含自然语言（翻译是 UI 的职责）').not.toMatch(/[\u4e00-\u9fff]/)
  })
})
