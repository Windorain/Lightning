/**
 * B-5（#38）— 描边 mask 通道的**预算结算**断言（`pure/outlineLimits.ts`）。
 *
 * 背景：#38「完成定义」要求「命中总数与既有 ≤500 口径对齐——超出截断 + 可辨认提示，
 * 不得静默失效」，并明确「现状 `extraMaskMeshes` 通道无上限的问题本任务一并收口」。
 * `drw.bindSelectionOutline` 的通道装配走本函数，故在此逐项钉死：
 *  - 总量 ≤ 上限；
 *  - 选择/悬停 mask 优先占预算，附加 mask 用余额、超出即截断；
 *  - 截断量可从 `dropped` 读出（上层的"可辨认提示"唯一依据）。
 */
import { describe, expect, it } from 'vitest'
import { OUTLINE_MASK_LIMIT, applyOutlineMaskBudget } from '@/pure/outlineLimits'

const range = (n: number, tag: string): string[] => Array.from({ length: n }, (_, i) => `${tag}${i}`)

describe('B-5 描边预算：≤500 口径与 extraMaskMeshes 收口', () => {
  it('口径常量 = 500（与 SelectionHighlightProvider 自保值同源）', () => {
    expect(OUTLINE_MASK_LIMIT).toBe(500)
  })

  it('选择/悬停 + 附加 都在额度内 ⇒ 全额通过，无截断', () => {
    const b = applyOutlineMaskBudget(range(3, 's'), range(4, 'x'))
    expect(b.all).toEqual([...range(3, 's'), ...range(4, 'x')])
    expect(b.total).toBe(7)
    expect(b.shown).toBe(7)
    expect(b.dropped).toBe(0)
  })

  it('附加通道超出上限 ⇒ 截断到上限，`dropped` 报出被丢弃的数量（不静默）', () => {
    const b = applyOutlineMaskBudget([], range(OUTLINE_MASK_LIMIT + 120, 'x'))
    expect(b.all).toHaveLength(OUTLINE_MASK_LIMIT)
    expect(b.total).toBe(OUTLINE_MASK_LIMIT + 120)
    expect(b.shown).toBe(OUTLINE_MASK_LIMIT)
    expect(b.dropped).toBe(120)
    // 前 N 条保留（顺序稳定 ⇒ 截断结果确定，不是"整体失效"）
    expect(b.all[0]).toBe('x0')
    expect(b.all.at(-1)).toBe(`x${OUTLINE_MASK_LIMIT - 1}`)
  })

  it('选择/悬停 mask 优先占预算：附加只能用余额', () => {
    const b = applyOutlineMaskBudget(range(OUTLINE_MASK_LIMIT - 2, 's'), range(10, 'x'))
    expect(b.shown).toBe(OUTLINE_MASK_LIMIT)
    expect(b.dropped).toBe(8)
    expect(b.all.slice(0, OUTLINE_MASK_LIMIT - 2)).toEqual(range(OUTLINE_MASK_LIMIT - 2, 's'))
    expect(b.all.slice(OUTLINE_MASK_LIMIT - 2)).toEqual(['x0', 'x1'])
  })

  it('选择/悬停 已占满 ⇒ 附加整条被截断（总量仍恰为上限，不越界）', () => {
    const b = applyOutlineMaskBudget(range(OUTLINE_MASK_LIMIT, 's'), range(5, 'x'))
    expect(b.shown).toBe(OUTLINE_MASK_LIMIT)
    expect(b.dropped).toBe(5)
  })

  it('空输入 ⇒ 空输出（既有"无选择不动通道"的行为不变）', () => {
    const b = applyOutlineMaskBudget([], [])
    expect(b.all).toEqual([])
    expect(b.total).toBe(0)
    expect(b.shown).toBe(0)
    expect(b.dropped).toBe(0)
  })
})
