/**
 * ready 预算纯策略的单测（无 Playwright、无浏览器、无网络）。
 *
 * 判据分三层：
 *  1. **默认路径原判据不变**：90s/120s/180s/10s/0/null 这些既有语义逐项锁死；
 *  2. **晚调用边界**：剩余预算放不下"1s 等待 + 诊断预留"时，等待必须被压到 1s 以下
 *     （最多 250ms 有界即时宽限），页面侧采集预算也按真实剩余收紧（不再出现"等满 1s
 *     让 deadline 关页"，也不把健康晚调用误判红）；
 *  3. **不变量**：等待 + 页面采集 + 余量 ≤ 剩余；等待 ≤ 上限；等待 ≤ 剩余。
 */
import { describe, expect, it } from 'vitest'
import {
  BOOT_DIAG_MARGIN_MS,
  BOOT_DIAG_PAGE_BUDGET_MS,
  BOOT_DIAG_RESERVE_MS,
  BOOT_LATE_READY_GRACE_MS,
  BOOT_LATE_TIGHT_REMAINING_MS,
  BOOT_READY_CAP_MS,
  BOOT_READY_HEADROOM_MS,
  BOOT_READY_MIN_MS,
  decideReadyBudget,
  describeReadyBudget,
  explicitReadyBudget,
} from '../../e2e/helpers/multiblock/readyBudget'

const budget = (testTimeoutMs: number | null, elapsedMs: number | null, waitElapsedMs?: number | null) =>
  decideReadyBudget({ testTimeoutMs, elapsedMs, waitElapsedMs })

describe('ready 预算：默认路径原判据不变', () => {
  it('缺省 90s test timeout ⇒ 60s（上限内、为归因预留 30s）', () => {
    const b = budget(90_000, 0)
    expect(b.source).toBe('headroom')
    expect(b.waitMs).toBe(60_000)
    expect(b.remainingMs).toBe(90_000)
    expect(b.pageProbeMs).toBe(BOOT_DIAG_PAGE_BUDGET_MS)
  })

  it('120s / 180s / 420s ⇒ 仍被 90s 上限封顶', () => {
    for (const timeout of [120_000, 180_000, 420_000]) {
      expect(budget(timeout, 0).waitMs, `timeout=${timeout}`).toBe(BOOT_READY_CAP_MS)
    }
  })

  it('10s test timeout ⇒ 1s（最少 1s 下限保留）', () => {
    const b = budget(10_000, 0)
    expect(b.waitMs).toBe(BOOT_READY_MIN_MS)
    expect(b.floorBroken).toBe(false)
    expect(b.source).toBe('headroom')
  })

  it('test.setTimeout(0)（禁用超时）⇒ 上限 90s，不按 0ms 预算', () => {
    const b = budget(0, 0)
    expect(b.source).toBe('no-deadline')
    expect(b.waitMs).toBe(BOOT_READY_CAP_MS)
    expect(b.remainingMs).toBeNull()
  })

  it('非 test 上下文（timeout=null）⇒ 上限 90s', () => {
    const b = budget(null, null)
    expect(b.source).toBe('no-deadline')
    expect(b.waitMs).toBe(BOOT_READY_CAP_MS)
  })

  it('有 timeout 但拿不到锚点（elapsed=null）⇒ 退回旧公式', () => {
    expect(budget(90_000, null).waitMs).toBe(60_000)
    expect(budget(10_000, null).waitMs).toBe(BOOT_READY_MIN_MS)
  })

  it('显式覆盖不参与剩余政策（负对照语义不变）', () => {
    const b = explicitReadyBudget(2_000, 90_000, 88_000)
    expect(b.source).toBe('explicit')
    expect(b.waitMs).toBe(2_000)
    expect(b.pageProbeMs).toBe(BOOT_DIAG_PAGE_BUDGET_MS)
  })

  it('显式 0 / 负数原样保留（0=不设超时；负数=Playwright 立即超时），不当成预算耗尽', () => {
    for (const raw of [0, -1, -1_000]) {
      const b = explicitReadyBudget(raw)
      expect(b.source, `raw=${raw}`).toBe('explicit')
      expect(b.waitMs, `raw=${raw}`).toBe(raw)
      expect(b.exhausted, `raw=${raw}`).toBe(false)
      expect(b.floorBroken, `raw=${raw}`).toBe(false)
    }
    // 0 与负数在 Playwright 里语义不同：0 不设超时，负数立即超时（实测）。
    // 本模块只负责原样转发，不把它们归一成同一种"预算耗尽"。
  })
})

describe('ready 预算：晚调用边界（第二次 goto 的真实剩余）', () => {
  it('90s 在 30s 时第二次 goto ⇒ 等待 30s（剩余 60s − 30s headroom）', () => {
    const b = budget(90_000, 30_000)
    expect(b.entryRemainingMs).toBe(60_000)
    expect(b.remainingMs).toBe(60_000)
    expect(b.waitMs).toBe(30_000)
    expect(b.floorBroken).toBe(false)
  })

  it('90s 在 55s 时 ⇒ 只剩 5s 等待，不再拿 60s', () => {
    expect(budget(90_000, 55_000).waitMs).toBe(5_000)
  })

  it('90s 在 70s 时 ⇒ 1s 下限仍保留（剩余 20s 放得下 1s + 诊断预留）', () => {
    const b = budget(90_000, 70_000)
    expect(b.waitMs).toBe(BOOT_READY_MIN_MS)
    expect(b.floorBroken).toBe(false)
  })

  it('90s 在 87s 时 ⇒ 压破 1s 下限，但保留 250ms 有界 ready 宽限', () => {
    const b = budget(90_000, 87_000)
    expect(b.remainingMs).toBe(3_000)
    expect(b.floorBroken).toBe(true)
    expect(b.source).toBe('late')
    expect(b.waitMs).toBe(BOOT_LATE_READY_GRACE_MS)
    expect(b.exhausted).toBe(false)
    expect(b.pageProbeMs).toBe(2_000) // 3s − 250ms − 250ms 仍够采页面侧事实
  })

  it('90s 在 88.5s 时 ⇒ 仍有 250ms 宽限，页面侧采集压到剩余之内', () => {
    const b = budget(90_000, 88_500)
    expect(b.waitMs).toBe(BOOT_LATE_READY_GRACE_MS)
    expect(b.exhausted).toBe(false)
    expect(b.pageProbeMs).toBe(1_000) // 1.5s − 250ms − 250ms
  })

  it('90s 在 89.95s 时（剩余 50ms）⇒ wait=0，保留剩余给 close 事实', () => {
    const b = budget(90_000, 89_950)
    expect(b.remainingMs).toBe(50)
    expect(b.waitMs).toBe(0)
    expect(b.exhausted).toBe(false)
    expect(b.pageProbeMs).toBe(0)
  })

  it('剩余 < 500ms ⇒ wait = max(0, 剩余 − 250ms)，不因 page-probe=0 变成例外', () => {
    for (const remaining of [499, 400, 300, 250, 100, 1, 0]) {
      const b = budget(90_000, 90_000 - remaining)
      expect(b.waitMs, `remaining=${remaining}`).toBe(Math.max(0, remaining - BOOT_DIAG_MARGIN_MS))
      expect(b.waitMs, `remaining=${remaining}`).toBeLessThanOrEqual(remaining)
      expect(b.pageProbeMs, `remaining=${remaining}`).toBe(0)
    }
    expect(BOOT_LATE_TIGHT_REMAINING_MS).toBe(500)
    // 500ms 是边界：仍是 250ms 宽限。
    expect(budget(90_000, 89_500).waitMs).toBe(BOOT_LATE_READY_GRACE_MS)
  })

  it('10s 在 8.5s 时（短 timeout 的晚调用）⇒ 同样给 250ms 宽限', () => {
    const b = budget(10_000, 8_500)
    expect(b.remainingMs).toBe(1_500)
    expect(b.floorBroken).toBe(true)
    expect(b.waitMs).toBe(BOOT_LATE_READY_GRACE_MS)
    expect(b.pageProbeMs).toBe(1_000)
  })

  it('等待开始比调用时刻更晚（goto 自身耗时）⇒ 用更小的剩余算', () => {
    const b = budget(90_000, 80_000, 88_000)
    expect(b.entryRemainingMs).toBe(10_000)
    expect(b.remainingMs).toBe(2_000)
    expect(b.waitMs).toBe(BOOT_LATE_READY_GRACE_MS)
    expect(b.floorBroken).toBe(true)
  })

  it('时间回拨：waitElapsed 小于 elapsed 时以 elapsed 为准（剩余不得被放大）', () => {
    const b = budget(90_000, 80_000, 10_000)
    expect(b.waitElapsedMs).toBe(80_000)
    expect(b.remainingMs).toBe(10_000)
    expect(b.entryRemainingMs).toBe(10_000)
    // 未被回拨放大成 80s 剩余（那会给出 60s 等待）；10s 剩余仍走旧公式 1s。
    expect(b.source).toBe('headroom')
    expect(b.waitMs).toBe(BOOT_READY_MIN_MS)
  })

  it('已耗时超过 timeout ⇒ 剩余 0，预算 0，不产生负等待', () => {
    const b = budget(90_000, 120_000)
    expect(b.remainingMs).toBe(0)
    expect(b.waitMs).toBe(0)
    expect(b.exhausted).toBe(true)
    expect(b.pageProbeMs).toBe(0)
  })
})

describe('ready 预算：不变量', () => {
  it('等待 + 页面采集 + 余量 ≤ 剩余（0..120s 全扫）', () => {
    for (let timeout = 0; timeout <= 120_000; timeout += 500) {
      for (let elapsed = 0; elapsed <= timeout + 5_000; elapsed += 500) {
        const b = budget(timeout, elapsed)
        expect(b.waitMs, `timeout=${timeout} elapsed=${elapsed}`).toBeLessThanOrEqual(BOOT_READY_CAP_MS)
        if (b.remainingMs === null) continue
        expect(b.waitMs).toBeLessThanOrEqual(b.remainingMs)
        if (b.waitMs + b.pageProbeMs + BOOT_DIAG_MARGIN_MS > b.remainingMs) {
          // 唯一豁免：剩余小到连余量都不够（此时 pageProbe 必须是 0）。
          expect(b.pageProbeMs, `timeout=${timeout} elapsed=${elapsed}`).toBe(0)
        }
      }
    }
  })

  it('剩余不足 1s + 诊断预留 ⇒ 不守 1s，且宽限不超过 250ms', () => {
    for (let remaining = 0; remaining < BOOT_READY_MIN_MS + BOOT_DIAG_RESERVE_MS; remaining += 50) {
      const b = budget(90_000, 90_000 - remaining)
      expect(b.waitMs, `remaining=${remaining}`).toBeLessThanOrEqual(
        Math.min(BOOT_LATE_READY_GRACE_MS, remaining),
      )
      expect(b.waitMs, `remaining=${remaining}`).toBeLessThan(BOOT_READY_MIN_MS)
    }
  })

  it('健康晚调用的宽限 ≥ 250ms（剩余 2s 时）', () => {
    const b = budget(90_000, 88_000)
    expect(b.remainingMs).toBe(2_000)
    expect(b.waitMs).toBe(BOOT_LATE_READY_GRACE_MS)
  })

  it('HEADROOM / RESERVE 常量自洽', () => {
    expect(BOOT_READY_HEADROOM_MS).toBe(30_000)
    expect(BOOT_DIAG_RESERVE_MS).toBe(BOOT_DIAG_PAGE_BUDGET_MS + BOOT_DIAG_MARGIN_MS)
    expect(BOOT_DIAG_RESERVE_MS).toBe(2_250)
  })
})

describe('ready 预算：事实行', () => {
  it('如实报来源/剩余/等待/页面预算，不补默认值', () => {
    const line = describeReadyBudget(budget(90_000, 88_500))
    expect(line).toContain('[budget] ')
    expect(line).toContain('source=late')
    expect(line).toContain('basis=anchor-estimate')
    expect(line).toContain('test-timeout=90000ms')
    expect(line).toContain('elapsed=88500ms')
    expect(line).toContain('entry-remaining-estimate=1500ms')
    expect(line).toContain('remaining-estimate=1500ms')
    expect(line).toContain('actual-remaining=unknown')
    expect(line).toContain('wait=250ms')
    expect(line).toContain('page-probe=1000ms')
    expect(line).toContain('floor-broken=true')
    expect(line).toContain('exhausted=false')
  })

  it('预算耗尽（剩余 0）时才写 exhausted=true / wait=0ms', () => {
    const line = describeReadyBudget(budget(90_000, 90_000))
    expect(line).toContain('remaining-estimate=0ms')
    expect(line).toContain('actual-remaining=unknown')
    expect(line).toContain('wait=0ms')
    expect(line).toContain('exhausted=true')
  })

  it('无 deadline 时写 none，而不是编一个数', () => {
    const line = describeReadyBudget(budget(0, 0))
    expect(line).toContain('source=no-deadline')
    expect(line).toContain('test-timeout=none')
    expect(line).toContain('remaining-estimate=none')
    expect(line).toContain('wait=90000ms')
  })

  it('≤ 320 字符（能安全塞进一条诊断）', () => {
    expect(describeReadyBudget(budget(90_000, 88_500)).length).toBeLessThanOrEqual(320)
  })
})
