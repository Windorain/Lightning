/**
 * M4-3 R3 · 三分派判据。
 *
 * 这一组钉的是**分派规则本身**（五处生产调用点共用它）。若规则被改坏，
 * "内核拒绝被当成未装配"就会悄悄回来 —— 而那正是本包要消除的形态。
 */
import { describe, expect, it } from 'vitest'
import type { CommandOutcome, DomainError, Version } from '@/application/contracts'
import { kernelAccepted, settlementOf } from '../editSettlement'

const V: Version = { documentVersion: 1, contentVersion: 1 }
const ERR: DomainError = { code: 'InvalidValue', params: { reason: 'outsideDeclaredGrid', x: 1, y: 2, z: 3 } }

describe('M4-3 R3 · 编辑结算三分派', () => {
  it('applied ⇒ applied（内核已写并投影）', () => {
    const o: CommandOutcome = { status: 'applied', version: V, changes: { changedProperties: [], structurallyShared: true } as never }
    const s = settlementOf(o)
    expect(s.kind).toBe('applied')
    expect(kernelAccepted(s), 'applied 必须算"内核受理"（不得回落）').toBe(true)
  })

  it('unchanged ⇒ unchanged（不是失败，也不是未装配）', () => {
    const s = settlementOf({ status: 'unchanged', version: V })
    expect(s.kind).toBe('unchanged')
    expect(kernelAccepted(s), 'unchanged 同样不得回落 legacy（否则同一事实写两遍）').toBe(true)
  })

  it('rejected ⇒ rejected 且**原样**带出结构化原因（不压成布尔）', () => {
    const s = settlementOf({ status: 'rejected', error: ERR })
    expect(s.kind).toBe('rejected')
    expect(s.kind === 'rejected' ? s.error : null).toBe(ERR)
    expect(kernelAccepted(s), '被拒不是"内核受理"，但更不是"未装配"').toBe(false)
  })

  it('null ⇒ not-assembled（唯一允许回落 legacy 的分支）', () => {
    const s = settlementOf(null)
    expect(s.kind).toBe('not-assembled')
    expect(kernelAccepted(s)).toBe(false)
  })

  it('负对照：三分派互斥且穷尽（任意结算只落到一个分支）', () => {
    const all: (CommandOutcome | null)[] = [
      { status: 'applied', version: V, changes: {} as never },
      { status: 'unchanged', version: V },
      { status: 'rejected', error: ERR },
      null,
    ]
    const kinds = all.map((o) => settlementOf(o).kind)
    expect(kinds).toEqual(['applied', 'unchanged', 'rejected', 'not-assembled'])
    expect(new Set(kinds).size, '四个分支不得合并（合并即是本包要消除的形态）').toBe(4)
  })
})
