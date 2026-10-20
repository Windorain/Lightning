/**
 * **设备事件接线**（M8-3）：画布事件 → 会话/诊断/底栏，且监听**可注销**。
 *
 * ## 为什么需要这一层判据（S0-A D1/D2/D3/D11）
 *
 * 接线之前：`src/` 生产面 `handleContextLost` 零调用方（事件没人接收）、
 * 丢失路径诊断 0 条、`deviceState` 的相位机生产 0 实例、监听是匿名闭包无法注销。
 * 本文件钉的是**转译层**的三件事：
 *
 * | 判据 | 防什么 |
 * |---|---|
 * | 丢失 ⇒ `preventDefault` + 会话放弃 + `device.lost` + 可见提示 | 事件被丢弃（旧形态：只 preventDefault） |
 * | 恢复 ⇒ 会话推进代次 + `device.restored`（**不同码**） | 一个码冒充两件事，判不出恢复失败 |
 * | 注销 ⇒ 不再转译 | D11：监听不注销，拆解后仍改写已释放会话 |
 *
 * 关联字段（视口 id + 设备代次）也在判据里：多 Area 场景必须能定位是谁丢了设备。
 */
import { describe, expect, it } from 'vitest'
import { createDiagnosticRecorder } from '@/application/diagnostics'
import { attachViewportDeviceEvents, type ViewportDeviceSession } from '@/runtime/deviceEvents'
import { createDiagnosticProjection } from '@/runtime/diagnosticProjection'

class FakeCanvas {
  readonly listeners = new Map<string, Set<(ev: Event) => void>>()
  addEventListener(type: string, listener: (ev: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set<(ev: Event) => void>()
    set.add(listener)
    this.listeners.set(type, set)
  }
  removeEventListener(type: string, listener: (ev: Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }
  dispatch(type: string): Event {
    const ev = new Event(type, { cancelable: true })
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(ev)
    return ev
  }
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }
}

/** 记录调用序的最小会话替身（真实的会话行为由 presenterSession.test.ts 钉）。 */
function fakeSession(): ViewportDeviceSession & { calls: string[]; generation: number; phase: string; lost: number } {
  const s = {
    calls: [] as string[],
    generation: 1,
    phase: 'ready',
    lost: 0,
    handleContextLost(): number {
      s.calls.push('lost')
      s.phase = 'lost'
      s.lost = 7
      return 7
    },
    handleContextRestored(): void {
      s.calls.push('restored')
      s.phase = 'ready'
      s.generation += 1
    },
    get deviceGeneration(): number { return s.generation },
    get devicePhase(): string { return s.phase },
    get pendingRebuild(): boolean { return s.phase !== 'ready' },
  }
  return s as unknown as ViewportDeviceSession & { calls: string[]; generation: number; phase: string; lost: number }
}

/**
 * 底栏读面替身 + 日志读面替身（M8-6：C2/C3 由**诊断投影**产出，不再由 deviceEvents 直写）。
 *
 * 为什么替身放在这里而不是直接断言 `ctx.log`：本单测只驱动转译层，不建整个宿主。
 * 投影函数是**生产实现**（`createDiagnosticProjection`）—— 判据测的是"记录 → 投影"这条
 * 真链路，不是测试自己编的一句话。
 */
function projectionHarness() {
  const live: { message: string; state: string | null; origin: string | null }[] = []
  const events: { code: string; channel: string; level: number; message: string }[] = []
  const log = {
    event: (entry: { code: string; channel: string; level: number; message: string }) => {
      events.push({ code: entry.code, channel: entry.channel, level: entry.level, message: entry.message })
      return entry as never
    },
    setLiveStatus: (message: string, _level?: number, state?: string | null, origin?: string | null) => {
      live.push({ message, state: state ?? null, origin: origin ?? null })
    },
  }
  const recorder = createDiagnosticRecorder({
    capacity: 32,
    now: () => 0,
    observe: createDiagnosticProjection(log as never),
  })
  return { live, events, recorder }
}

function harness(): {
  canvas: FakeCanvas
  session: ReturnType<typeof fakeSession>
  recorder: ReturnType<typeof createDiagnosticRecorder>
  live: { message: string; state: string | null; origin: string | null }[]
  events: { code: string; channel: string; level: number; message: string }[]
  detach: () => void
} {
  const canvas = new FakeCanvas()
  const session = fakeSession()
  const { live, events, recorder } = projectionHarness()
  const detach = attachViewportDeviceEvents({
    canvas,
    viewportId: 'r-viewport',
    session,
    diagnostics: recorder,
    onLost: () => 3,
  })
  return { canvas, session, recorder, live, events, detach }
}

describe('M8-3 设备事件接线', () => {
  it('丢失 ⇒ preventDefault + 会话放弃 + device.lost（视口/代次可定位）+ 成句提示', () => {
    const h = harness()
    const ev = h.canvas.dispatch('webglcontextlost')
    expect(ev.defaultPrevented, '必须 preventDefault（否则浏览器永远不会派发 restored）').toBe(true)
    expect(h.session.calls).toEqual(['lost'])
    const lost = h.recorder.byChannel('device')
    expect(lost.map((r) => r.code)).toEqual(['device.lost'])
    expect(lost[0]!.correlation.viewportId, '必须能定位到视口（多 Area）').toBe('r-viewport')
    expect(lost[0]!.correlation.deviceGeneration, '必须带设备代次').toBe(1)
    expect(lost[0]!.params.abandoned, '放弃份额数必须进参数（旧读面只有一次性返回值）').toBe(7)
    expect(lost[0]!.params.texturesAbandoned, '附加处置（纹理）的放弃数也必须进参数').toBe(3)
    expect(h.live.map((l) => l.state)).toEqual(['device-lost'])
    // M8-6：提示由**投影**产出（C2/C3 同源），日志条目必须带稳定码。
    expect(h.events.map((e) => e.code), 'C2 条目必须由 device.* 记录投影而来（带稳定码）').toEqual(['device.lost'])
    expect(h.events[0]!.channel).toBe('device')
    expect(h.live[0]!.origin, '明确渠道：设备提示不得冒充纹理/拒绝').toBe('device')
    expect(h.live[0]!.message.length, '提示必须成句（不是空串/单个词）').toBeGreaterThan(8)
    h.detach()
  })

  it('恢复 ⇒ 会话推进代次 + device.restored（与丢失**不同码**）', () => {
    const h = harness()
    h.canvas.dispatch('webglcontextlost')
    h.canvas.dispatch('webglcontextrestored')
    expect(h.session.calls).toEqual(['lost', 'restored'])
    const codes = h.recorder.byChannel('device').map((r) => r.code)
    expect(codes).toEqual(['device.lost', 'device.restored'])
    expect(new Set(codes).size, '一个码不得同时表示两件事').toBe(2)
    const restored = h.recorder.byChannel('device')[1]!
    expect(restored.correlation.deviceGeneration, '恢复记录的代次必须是**推进后**的代次').toBe(2)
    expect(h.live.map((l) => l.state)).toEqual(['device-lost', 'device-restored'])
    h.detach()
  })

  it('**负对照**：没有丢失就收到 restored ⇒ 不产记录（不冒充一次恢复）', () => {
    const h = harness()
    h.canvas.dispatch('webglcontextrestored')
    expect(h.recorder.byChannel('device'), '无丢失时不得产生 device.* 记录').toHaveLength(0)
    expect(h.live, '无丢失时不得写用户可见提示').toHaveLength(0)
    h.detach()
  })

  it('D11：注销后画布不再有监听，事件不再到达会话/诊断', () => {
    const h = harness()
    expect(h.canvas.listenerCount('webglcontextlost')).toBe(1)
    h.detach()
    expect(h.canvas.listenerCount('webglcontextlost'), '注销必须真的摘除监听').toBe(0)
    expect(h.canvas.listenerCount('webglcontextrestored')).toBe(0)
    h.canvas.dispatch('webglcontextlost')
    expect(h.session.calls).toEqual([])
    expect(h.recorder.byChannel('device')).toHaveLength(0)
    // 幂等：重复注销不抛、不把监听装回去
    h.detach()
    expect(h.canvas.listenerCount('webglcontextlost')).toBe(0)
  })

  it('重复丢失事件 ⇒ 每次都有记录（不是每帧刷屏的采样，而是真实事件计数）', () => {
    const h = harness()
    h.canvas.dispatch('webglcontextlost')
    h.canvas.dispatch('webglcontextlost')
    const lost = h.recorder.byChannel('device')
    expect(lost).toHaveLength(2)
    expect(lost[1]!.params.lostEvents, '同一画布的丢失次数可读').toBe(2)
    h.detach()
  })
})