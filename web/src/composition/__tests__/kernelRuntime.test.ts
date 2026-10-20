/**
 * **帧时钟与内核会话接线的机器证据**（#261 / R-WK-03）。
 *
 * ## 判据的核心：把"每帧注入一次"变成可精确断言的事实
 *
 * 旧机制的时间推进藏在 `renderEngine` 的 RAF 里（`clock.getDelta()`），
 * 它**无法**被精确断言 —— 只能靠等待真实帧、再看一个近似值。
 * 本文件用注入的驱动源与注入的时钟把这件事变成确定性的：
 * 喂 N 次 tick ⇒ 恰好注入 N 次 delta，且每次的 delta 是**给定的**那个值。
 *
 * 因此"宿主按帧向内核注入时间输入"（R-WK-03 的原文要求）有一条
 * 可重跑的证据，而不是"看它好像在动"。
 */

import { describe, expect, it } from 'vitest'
import { createFrameClock, sceneSeconds, DEFAULT_MAX_DELTA_SECONDS } from '@/composition/kernelRuntime'
import { KernelSession } from '@/runtime/kernelSession'
import { ALL_CAPABILITIES } from '@/application/commands'
import { timeValue } from '@/domain/animation'

// ─────────────────────────────────────────────────────────────────────────────
// 确定性驱动源（不启动真 RAF）
// ─────────────────────────────────────────────────────────────────────────────

interface FakeRaf {
  request(cb: (t: number) => void): number
  cancel(handle: number): void
  /** 手动跑一帧。 */
  step(): void
  readonly pending: number
  readonly cancelled: readonly number[]
}

function fakeRaf(): FakeRaf {
  let next = 1
  const callbacks = new Map<number, (t: number) => void>()
  const cancelled: number[] = []
  return {
    request(cb) {
      const h = next++
      callbacks.set(h, cb)
      return h
    },
    cancel(h) {
      cancelled.push(h)
      callbacks.delete(h)
    },
    step() {
      const entries = [...callbacks.entries()]
      callbacks.clear()
      for (const [, cb] of entries) cb(0)
    },
    get pending() {
      return callbacks.size
    },
    get cancelled() {
      return Object.freeze([...cancelled])
    },
  }
}

function session(): KernelSession {
  const s = new KernelSession({
    documentId: 'doc-1',
    contextId: 'ctx-1',
    capabilities: ALL_CAPABILITIES,
    prefix: 'p10c',
  })
  s.bindFrameSource({ count: () => 3, durationsMs: () => [50, 50, 50] })
  return s
}

// ─────────────────────────────────────────────────────────────────────────────
// 一、每帧注入一次时间输入
// ─────────────────────────────────────────────────────────────────────────────

describe('帧时钟：每帧向内核注入一次时间输入（宿主驱动，内核不自跑）', () => {
  it('播放中：N 次 tick ⇒ 恰好 N 次推进，每次按**给定**的 delta', () => {
    const raf = fakeRaf()
    let clockMs = 0
    const s = session()
    s.setPlaying(true)
    const clock = createFrameClock({ session: s, raf, now: () => clockMs })
    clock.start()

    // 首帧：没有"上一次" ⇒ delta 0（不把构造至今的整段时间算进去）
    raf.step()
    expect(s.playback().time.frame, '首帧 delta 必须为 0').toBe(0)

    // 之后每帧 100ms ⇒ 0.1s ⇒ 20fps 下 2 帧
    for (let i = 0; i < 3; i++) {
      clockMs += 100
      raf.step()
    }
    expect(s.playback().time.frame, '3 × 0.1s @ 20fps = 6 帧').toBeCloseTo(6, 6)
    clock.stop()
  })

  it('**暂停时不推进**（且宿主不必自己判断 —— 命令判 unchanged）', () => {
    const raf = fakeRaf()
    let clockMs = 0
    const s = session()
    const clock = createFrameClock({ session: s, raf, now: () => clockMs })
    clock.start()
    for (let i = 0; i < 5; i++) {
      clockMs += 100
      raf.step()
    }
    expect(s.playback().time.frame).toBe(0)
    clock.stop()
  })

  it('`onFrame` 报出 `advanced`（供呈现判断要不要重绘）', () => {
    const raf = fakeRaf()
    let clockMs = 0
    const s = session()
    const seen: boolean[] = []
    const clock = createFrameClock({ session: s, raf, now: () => clockMs })
    clock.onFrame((info) => seen.push(info.advanced))
    clock.start()
    clockMs += 100
    raf.step()
    expect(seen, '暂停 ⇒ advanced 全 false').toEqual([false])
    s.setPlaying(true)
    clockMs += 100
    raf.step()
    expect(seen, '播放 ⇒ advanced true').toEqual([false, true])
    clock.stop()
  })

  it('`onFrame` 报出的 `frameIndex` 是**派生值**（随时间前进）', () => {
    const raf = fakeRaf()
    let clockMs = 0
    const s = session()
    s.setPlaying(true)
    const indices: number[] = []
    const clock = createFrameClock({ session: s, raf, now: () => clockMs })
    clock.onFrame((info) => indices.push(info.frameIndex))
    clock.start()
    raf.step()
    clockMs += 50 // 50ms ⇒ 第 1 帧
    raf.step()
    clockMs += 50 // 100ms ⇒ 第 2 帧
    raf.step()
    clockMs += 50 // 150ms ⇒ 回第 0 帧（循环）
    raf.step()
    expect(indices).toEqual([0, 1, 2, 0])
    clock.stop()
  })

  it('**单帧 delta 上限**：切标签页/休眠产生的巨大间隔被截断（不瞬移）', () => {
    const raf = fakeRaf()
    let clockMs = 0
    const s = session()
    s.setPlaying(true)
    const clock = createFrameClock({ session: s, raf, now: () => clockMs })
    clock.start()
    raf.step() // 首帧 0
    clockMs += 60_000 // 一分钟
    raf.step()
    // 上限 0.25s ⇒ 20fps 下至多 5 帧（不是 1200 帧）
    expect(s.playback().time.frame).toBeCloseTo(DEFAULT_MAX_DELTA_SECONDS * 20, 6)
    expect(s.playback().time.frame).toBeLessThan(10)
    clock.stop()
  })

  it('**stop 停掉 RAF**（不留幽灵推进：卸载后时间不得继续走）', () => {
    const raf = fakeRaf()
    let clockMs = 0
    const s = session()
    s.setPlaying(true)
    const clock = createFrameClock({ session: s, raf, now: () => clockMs })
    clock.start()
    raf.step()
    clockMs += 100
    raf.step()
    const beforeStop = s.playback().time.frame
    clock.stop()
    expect(clock.running).toBe(false)
    expect(raf.pending, 'stop 后不得还有挂起的帧回调').toBe(0)
    // 即使外部继续推时钟并手动 step（无挂起回调 ⇒ 什么都不会发生）
    clockMs += 1000
    raf.step()
    expect(s.playback().time.frame, 'stop 后时间不得再走').toBe(beforeStop)
  })

  it('`start` 幂等：重复调用不产生第二条帧链', () => {
    const raf = fakeRaf()
    let clockMs = 0
    const s = session()
    s.setPlaying(true)
    const clock = createFrameClock({ session: s, raf, now: () => clockMs })
    clock.start()
    clock.start()
    clock.start()
    expect(raf.pending, '只应有一条挂起的帧回调').toBe(1)
    clock.stop()
  })

  it('**负对照**：订阅者抛错不影响其它订阅者，也不回滚内核状态', () => {
    const raf = fakeRaf()
    let clockMs = 0
    const s = session()
    s.setPlaying(true)
    const clock = createFrameClock({ session: s, raf, now: () => clockMs })
    const good: number[] = []
    clock.onFrame(() => {
      throw new Error('订阅者缺陷')
    })
    clock.onFrame((info) => good.push(info.frameIndex))
    clock.start()
    raf.step() // 首帧 delta 0（建立"上一次"基准）
    clockMs += 50
    raf.step()
    expect(good.length, '抛错的订阅者不得打断其它订阅者').toBe(2)
    expect(s.playback().time.frame, '内核状态已发布，不因订阅者异常回滚').toBeCloseTo(1, 6)
    clock.stop()
  })

  it('取消订阅后不再收到通知', () => {
    const raf = fakeRaf()
    let clockMs = 0
    const s = session()
    const seen: number[] = []
    const clock = createFrameClock({ session: s, raf, now: () => clockMs })
    const off = clock.onFrame(() => seen.push(1))
    clock.start()
    raf.step()
    expect(seen.length).toBe(1)
    off()
    clockMs += 100
    raf.step()
    expect(seen.length, '取消后不得再收到').toBe(1)
    clock.stop()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 二、场景秒数：纹理/通道动画的统一时间输入
// ─────────────────────────────────────────────────────────────────────────────

describe('场景秒数：纹理动画的统一时间输入（唯一换算点）', () => {
  it('按有理帧率换算（20fps：frame=20 ⇒ 1s）', () => {
    expect(sceneSeconds(timeValue(20, 20))).toBe(1)
    expect(sceneSeconds(timeValue(10, 20))).toBe(0.5)
    expect(sceneSeconds(timeValue(0, 20))).toBe(0)
  })

  it('有理帧率（30000/1001）不退化：换算用精确帧率值', () => {
    const t = timeValue(30000, { num: 30000, den: 1001 })
    expect(sceneSeconds(t)).toBeCloseTo(1001, 6)
  })

  it('非法帧率 ⇒ 0（不产生 NaN 时间 —— NaN 会让之后每次采样都失败且无从诊断）', () => {
    expect(sceneSeconds(timeValue(10, 0))).toBe(0)
    expect(sceneSeconds(timeValue(10, -5))).toBe(0)
  })

  it('**同一时间 ⇒ 同一场景秒数**（A09/A27 的结构前提）', () => {
    const a = timeValue(37, 20)
    const b = timeValue(37, { num: 40, den: 2 }) // 同一帧率的等价写法
    expect(sceneSeconds(a)).toBe(sceneSeconds(b))
  })

  it('**倒退定位**给出更小的秒数（不是"只能向前"的累积量）', () => {
    expect(sceneSeconds(timeValue(40, 20))).toBe(2)
    expect(sceneSeconds(timeValue(20, 20)), '回到过去 ⇒ 秒数也回去').toBe(1)
  })
})
