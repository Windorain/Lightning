/**
 * **C6（M5-4）**：`domain/materials#planSequenceLoop` —— GIF 时间计划的纯层判据。
 *
 * 本文件只喂**声明**、只读**计划**，不碰 Vue/Three/DOM/IO。
 *
 * 每条"能红"的理由都写在用例旁：这几个数字正是"逐帧声明"与"旧的自算
 * `defaultFrametimeTicks * 5`"会分叉的地方。
 */
import { describe, expect, it } from 'vitest'
import {
  LOOP_LIMITS,
  delayCsOf,
  planSequenceLoop,
  type LoopStrip,
  type SequenceLoopPlan,
} from '@/domain/materials'

function okPlan(strips: readonly LoopStrip[], limits?: { readonly maxFrames: number; readonly maxTotalMs: number }): SequenceLoopPlan {
  const r = planSequenceLoop(strips, limits)
  if (!r.ok) throw new Error(`计划意外失败：${r.error.code} ${JSON.stringify(r.error.params)}`)
  return r.value
}

/** C6-6 的不变式：对**每一个**成功计划都必须成立。 */
function expectInvariants(plan: SequenceLoopPlan): void {
  expect(plan.atMs.length).toBe(plan.frameCount)
  expect(plan.delayCs.length).toBe(plan.frameCount)
  expect(plan.atMs[0]).toBe(0)
  expect(plan.atMs.every((t) => t >= 0 && t < plan.totalMs)).toBe(true)
  for (let i = 1; i < plan.atMs.length; i++) {
    expect(plan.atMs[i]!, `atMs 必须严格升序（下标 ${i}）`).toBeGreaterThan(plan.atMs[i - 1]!)
  }
  for (const d of plan.delayCs) {
    expect(Number.isInteger(d), `delayCs 必须是整数（实得 ${d}）`).toBe(true)
    expect(d, `delayCs 每项必须 >= 1（实得 ${d}）`).toBeGreaterThanOrEqual(1)
  }
  const sum = plan.delayCs.reduce((a, b) => a + b, 0)
  expect(sum, 'Σ delayCs 必须等于 round(totalMs/10)').toBe(Math.round(plan.totalMs / 10))
}

describe('planSequenceLoop · 单序列（一个循环 = 该序列自己的帧边界）', () => {
  it('均匀 4×50ms ⇒ 4 帧、atMs 均匀、delayCs 全 5、Σ=20', () => {
    const plan = okPlan([{ id: 'm0', frameCount: 4, durationsMs: [50, 50, 50, 50] }])
    expect(plan.frameCount).toBe(4)
    expect(plan.totalMs).toBe(200)
    expect(plan.atMs).toEqual([0, 50, 100, 150])
    expect(plan.delayCs).toEqual([5, 5, 5, 5])
    expectInvariants(plan)
  })

  it('**不等帧时长**（本包核心回归）：[50,100,50] ⇒ atMs [0,50,150]、delayCs [5,10,5]', () => {
    const plan = okPlan([{ id: 'm0', frameCount: 3, durationsMs: [50, 100, 50] }])
    expect(plan.atMs).toEqual([0, 50, 150])
    expect(plan.delayCs).toEqual([5, 10, 5])
    expectInvariants(plan)

    // **负对照**：旧算法（忽略 frameSequence[].timeTicks，只按 defaultFrametimeTicks 自算）
    // 对同一份声明给出 [5,5,5]。若实现退回旧算法，上面两条必红。
    const oldAlgorithm = [1, 1, 1].map((ticks) => ticks * 5)
    expect(oldAlgorithm).toEqual([5, 5, 5])
    expect(plan.delayCs).not.toEqual(oldAlgorithm)
  })
})

describe('planSequenceLoop · 多序列（LCM 共同循环）', () => {
  it('total 100 与 total 150 ⇒ L=300，边界包含两条序列的每次重启', () => {
    const plan = okPlan([
      { id: 'a', frameCount: 1, durationsMs: [100] },
      { id: 'b', frameCount: 1, durationsMs: [150] },
    ])
    expect(plan.totalMs).toBe(300)
    // A 在 0/100/200 重启，B 在 0/150 重启 ⇒ 并集 [0,100,150,200]。
    // 若只取"一个周期内的边界"（A=[0]、B=[0]），这里会退化成 [0]，GIF 只会有一帧。
    expect(plan.atMs).toEqual([0, 100, 150, 200])
    expect(plan.delayCs).toEqual([10, 5, 5, 10])
    expect(plan.delayCs.reduce((a, b) => a + b, 0)).toBe(30)
    expectInvariants(plan)
  })

  it('周期成倍数时并集不重复计数', () => {
    const plan = okPlan([
      { id: 'a', frameCount: 2, durationsMs: [50, 50] },
      { id: 'b', frameCount: 1, durationsMs: [100] },
    ])
    expect(plan.totalMs).toBe(100)
    expect(plan.atMs).toEqual([0, 50])
    expect(plan.delayCs).toEqual([5, 5])
    expectInvariants(plan)
  })
})


describe('delayCsOf · ms→厘秒的**唯一**换算点（M6-2 / D3）', () => {
  function okCs(holds: readonly number[]): readonly number[] {
    const r = delayCsOf(holds)
    if (!r.ok) throw new Error("delayCsOf 意外失败：" + r.error.code + " " + JSON.stringify(r.error.params))
    return r.value
  }

  it('与 planSequenceLoop 的 delayCs **逐项相等**（同一份声明只有一个时延）', () => {
    const plan = okPlan([{ id: 'm0', frameCount: 3, durationsMs: [50, 100, 50] }])
    expect(plan.atMs).toEqual([0, 50, 150])
    const holds = [50, 100, 50]
    expect([...okCs(holds)]).toEqual([...plan.delayCs])
    // 反空洞真：不是"恒等"（[5,10,5] 与旧自算 ticks*5 的 [5,5,5] 不同）
    expect([...okCs(holds)]).not.toEqual([5, 5, 5])
  })

  it('1 厘秒地板：5ms ⇒ 1cs（量化，不另立"四舍五入"）', () => {
    expect([...okCs([5])]).toEqual([1])
  })

  it('最大余数法：15ms + 15ms ⇒ Σ 恰为 round(30/10)=3 ⇒ [2,1]（余数相同按下标）', () => {
    const cs = okCs([15, 15])
    expect([...cs]).toEqual([2, 1])
    expect(cs.reduce((a, b) => a + b, 0)).toBe(Math.round(30 / 10))
  })

  it('不减到 0：总量偏大时只在 > 1 的项上回收（保住 1 厘秒地板）', () => {
    const cs = okCs([25, 5])
    expect(cs.every((c: number) => Number.isInteger(c) && c >= 1)).toBe(true)
    expect(cs.reduce((a, b) => a + b, 0)).toBe(Math.round(30 / 10))
  })

  it('总时长短于 1 厘秒地板 × 帧数 ⇒ textureLoopTooShort（不是"截断成合法"）', () => {
    const r = delayCsOf([1, 1, 1, 1])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('UnsupportedOperation')
    expect(r.error.params.reason).toBe('textureLoopTooShort')
    expect(r.error.params.frames).toBe(4)
    expect(r.error.params.totalMs).toBe(4)
  })

  it('非法驻留（0 / 负 / 小数 / 空表）⇒ InvalidValue（不夹取）', () => {
    for (const bad of [0, -5, 1.5]) {
      const r = delayCsOf([50, bad])
      expect(r.ok, '驻留 ' + bad + ' 必须被拒绝').toBe(false)
      if (!r.ok) expect(r.error.params.reason).toBe('nonPositiveDuration')
    }
    const empty = delayCsOf([])
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.error.params.reason).toBe('emptyHolds')
  })

  it('上限与 planSequenceLoop 同一张表（超限 ⇒ textureLoopTooLong）', () => {
    const r = delayCsOf([LOOP_LIMITS.maxTotalMs + 1])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('UnsupportedOperation')
      expect(r.error.params.reason).toBe('textureLoopTooLong')
      expect(r.error.params.maxTotalMs).toBe(LOOP_LIMITS.maxTotalMs)
    }
  })
})

describe('planSequenceLoop · 显式失败面', () => {
  it('空表 ⇒ noAnimatedSequences（不产出 1 帧假 GIF）', () => {
    const r = planSequenceLoop([])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('InvalidValue')
    expect(r.error.params.reason).toBe('noAnimatedSequences')
  })

  it('durationsMs 与 frameCount 不等长 ⇒ invalidValue', () => {
    const r = planSequenceLoop([{ id: 'm0', frameCount: 3, durationsMs: [50, 50] }])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('InvalidValue')
    expect(r.error.params.reason).toBe('invalidStripDurations')
  })

  it('非法时长（0 / 负 / 小数）⇒ invalidValue', () => {
    for (const bad of [0, -1, 1.5]) {
      const r = planSequenceLoop([{ id: 'm0', frameCount: 2, durationsMs: [50, bad] }])
      expect(r.ok, `时长 ${bad} 必须被拒绝`).toBe(false)
      if (r.ok) continue
      expect(r.error.code).toBe('InvalidValue')
      expect(r.error.params.reason).toBe('nonPositiveDuration')
    }
  })

  it('300 帧 ⇒ textureLoopTooLong；把上限调大后同一输入必须成功（负对照）', () => {
    const strip: LoopStrip = {
      id: 'm0',
      frameCount: 300,
      durationsMs: Array.from({ length: 300 }, () => 50),
    }
    const r = planSequenceLoop([strip])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('UnsupportedOperation')
      expect(r.error.params.reason).toBe('textureLoopTooLong')
      expect(r.error.params.frames).toBe(300)
    }
    const raised = okPlan([strip], { maxFrames: 400, maxTotalMs: 30_000 })
    expect(raised.frameCount).toBe(300)
    expectInvariants(raised)
  })

  it('总时长 > 30s ⇒ textureLoopTooLong；把上限调大后成功（负对照）', () => {
    const strip: LoopStrip = { id: 'm0', frameCount: 1, durationsMs: [31_000] }
    const r = planSequenceLoop([strip])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('UnsupportedOperation')
      expect(r.error.params.reason).toBe('textureLoopTooLong')
      expect(r.error.params.totalMs).toBe(31_000)
      expect(r.error.params.maxTotalMs).toBe(LOOP_LIMITS.maxTotalMs)
    }
    const raised = okPlan([strip], { maxFrames: 240, maxTotalMs: 60_000 })
    expect(raised.totalMs).toBe(31_000)
    expectInvariants(raised)
  })

  it('总时长短于 GIF 的 1 厘秒地板（4×1ms ⇒ target 0 < 4 帧）⇒ 显式失败', () => {
    const r = planSequenceLoop([
      { id: 'm0', frameCount: 4, durationsMs: [1, 1, 1, 1] },
    ])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('UnsupportedOperation')
    expect(r.error.params.reason).toBe('textureLoopTooShort')
  })
})
