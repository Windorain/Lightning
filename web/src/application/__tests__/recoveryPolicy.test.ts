/**
 * M8-4 · 恢复副本保留策略（Q2 暂定默认）的纯判据。
 *
 * 钉四件事：
 * 1. 上限是常量 RECOVERY_RETENTION_LIMIT（每文档最近 3 份）；
 * 2. 写入顺序是"最新在规范键、旧的在 ~r<n> 历史槽"；
 * 3. 内容未变 ⇒ 不重复写（避免每次编辑重写整份载荷）；
 * 4. 历史槽键可还原回文档身份的规范键（分类器/GC/放弃动作共用）。
 */
import { describe, expect, it } from 'vitest'

import {
  RECOVERY_RETENTION_LIMIT,
  planRecoveryRetention,
  recoveryBaseKeyOf,
  recoveryRankOf,
  recoveryRetainedKey,
  recoveryRetainedKeys,
} from '@/application/recoveryPolicy'

const BASE = 'lk.recovery.v1.workbench.workbench.doc-1'

describe('M8-4 恢复副本保留策略（Q2 暂定默认）', () => {
  it('上限是 3 份，且槽键按 rank 0..2 生成', () => {
    expect(RECOVERY_RETENTION_LIMIT).toBe(3)
    expect(recoveryRetainedKeys(BASE)).toEqual([BASE, BASE + '~r1', BASE + '~r2'])
    expect(recoveryRetainedKey(BASE, 0)).toBe(BASE)
    expect(recoveryRetainedKey(BASE, 2)).toBe(BASE + '~r2')
  })

  it('第一次写入只写规范键（没有历史可挪）', () => {
    const plan = planRecoveryRetention(BASE, [null, null, null], 'A')
    expect(plan.unchanged).toBe(false)
    expect(plan.writes).toEqual([{ key: BASE, raw: 'A' }])
  })

  it('第二次写入把旧规范键挪到 r1（最新仍在规范键）', () => {
    const plan = planRecoveryRetention(BASE, ['A', null, null], 'B')
    expect(plan.writes).toEqual([
      { key: BASE, raw: 'B' },
      { key: BASE + '~r1', raw: 'A' },
    ])
  })

  it('第三次写入形成 3 份；第四次写入丢弃最旧一份（仍是 3 份）', () => {
    const third = planRecoveryRetention(BASE, ['B', 'A', null], 'C')
    expect(third.writes).toEqual([
      { key: BASE, raw: 'C' },
      { key: BASE + '~r1', raw: 'B' },
      { key: BASE + '~r2', raw: 'A' },
    ])
    const fourth = planRecoveryRetention(BASE, ['C', 'B', 'A'], 'D')
    expect(fourth.writes).toEqual([
      { key: BASE, raw: 'D' },
      { key: BASE + '~r1', raw: 'C' },
      { key: BASE + '~r2', raw: 'B' },
    ])
    // 最旧的 A 被挤出（不在任何写入槽里）。
    expect(fourth.writes.some((w) => w.raw === 'A')).toBe(false)
  })

  it('内容与最新副本相同 ⇒ unchanged（不重复写）', () => {
    const plan = planRecoveryRetention(BASE, ['A', 'Z', null], 'A')
    expect(plan.unchanged).toBe(true)
    expect(plan.writes).toEqual([])
  })

  it('历史槽键可还原规范键与 rank（分类/放弃动作只认一个文档身份）', () => {
    expect(recoveryBaseKeyOf(BASE + '~r1')).toBe(BASE)
    expect(recoveryBaseKeyOf(BASE + '~r2')).toBe(BASE)
    expect(recoveryBaseKeyOf(BASE)).toBe(BASE)
    expect(recoveryRankOf(BASE)).toBe(0)
    expect(recoveryRankOf(BASE + '~r2')).toBe(2)
    // 非本族后缀不得被误剥（文档 id 里带 ~r 但不是数字时不剥）。
    expect(recoveryBaseKeyOf(BASE + '~readme')).toBe(BASE + '~readme')
  })
})
