/**
 * ready 等待预算的**纯策略**（零依赖，可单测）。
 *
 * ## 为什么把预算单独拿出来
 *
 * 旧实现把政策写在 `gotoWorkbench` 里，只读公开的 `TestInfo.timeout`：
 *
 * ```text
 * 有效预算 = min(90s, max(1s, test timeout − 30s))
 * ```
 *
 * 它**不看已经跑了多久**。于是一条 90s 的用例在 30s 时做第二次 `gotoWorkbench`，
 * 仍会拿 60s 等 ready：ready 用掉 60s 后 test deadline 到点、页面先被关，诊断
 * 还没采就随页面消失（此前遗留的剩余项）。
 *
 * 本模块把"给多少等待、给多少诊断"变成**可逐项对账的纯函数**：
 * 输入是 test timeout 与两个已耗时（调用时刻 / 等待真正开始时刻），输出是
 * 等待预算与页面侧诊断预算。`harness.ts` 只负责取时钟与执行，不再在这一层
 * 写第二套算术。
 *
 * **口径**：这里的"剩余"全部是 **`basis=anchor-estimate`**（从"本测试首次进入
 * harness"的锚点推算），不是 Node 侧可测的实际剩余；诊断行固定写
 * `remaining-estimate=` 与 `actual-remaining=unknown`，绝不把估算冒充事实。
 *
 * ## 政策（默认路径）
 *
 * | 剩余 test 预算 | 等待预算 | 页面侧诊断预算 |
 * |---|---|---|
 * | 无 deadline（`timeout <= 0` 或非 test 上下文） | 上限 90s | 2s |
 * | 剩余 ≥ 1s + 诊断预留（3.25s） | `min(90s, max(1s, 剩余 − 30s))`（**旧语义不变**） | `min(2s, 剩余 − 等待 − 250ms)` |
 * | 剩余 < 1s + 诊断预留（晚调用） | `min(250ms, 剩余)`；**剩余 < 500ms 时** `max(0, 剩余 − 250ms)` | 同上（不足则为 0） |
 *
 * ### 为什么晚调用还要给 250ms
 *
 * 健康启动的 ready 通常只要 12–25ms。若"剩余不足 3.25s"就把等待直接压成 0，
 * 一次**健康**的晚调用会被判红（green→red）—— 那等于用预算政策制造假失败。
 * 故晚调用保留 `BOOT_LATE_READY_GRACE_MS` 的即时候选窗口：它**从诊断预留里扣**
 * （页面侧采集预算的公式同时减去它），不额外占用 test deadline，也不延长 timeout。
 * 坏页面在宽限后照常失败并带诊断；健康页面在 12–25ms 内通过。
 *
 * **1s 下限只在"还剩得下 1s 等待 + 诊断预留"时保留**；晚到调用不死守 1s，
 * 而是 250ms 有界快探 + 有界诊断。剩余 < 500ms 时进一步把等待压到
 * `max(0, 剩余 − 250ms)`：**无论如何给诊断/关页事件留 250ms**，不因为
 * `page-probe=0` 就把等待吃掉。**test timeout 本身不改，也不延长。**
 *
 * ### 时间回拨
 *
 * 两次读数若因受控时钟/系统时间回拨出现 `waitElapsed < elapsed`，以较大者为准
 * （`waitElapsed >= elapsed`）。否则"等待开始"会看起来比"调用时刻"更早，
 * 剩余被凭空放大 —— 预算只允许因真实流逝变小，不允许变大。
 *
 * ## 显式预算（**不参与**本政策）
 *
 * `gotoWorkbench(page, { readyTimeoutMs })` 是负对照用的显式覆盖：它原样交给
 * Playwright（与改动前一致）。Playwright 的事实是：**`0` = 不设超时；负数 = 立即超时**
 * （实测 `timeout=-1` 在 6ms 内以 `Timeout -1ms exceeded` 失败）。故既不能把
 * `0` 当成"预算耗尽 0"，也不能宣称负数无限；本模块只**原样保留**调用方给的值。
 * 见 {@link explicitReadyBudget}。
 */

/** ready 等待的**上限**（ms）。默认路径下任何公式都不得超过它。 */
export const BOOT_READY_CAP_MS = 90_000

/** 正常情况下为"采诊断 + 写进报告"预留的时间（ms）。 */
export const BOOT_READY_HEADROOM_MS = 30_000

/**
 * 正常路径的等待**下限**（ms）：小 test 预算下不能退化成"立即超时"。
 *
 * 注意：它不是无条件的。剩余预算已放不下"1s 等待 + 诊断预留"时，走
 * {@link BOOT_LATE_READY_GRACE_MS} 的晚调用分支。
 */
export const BOOT_READY_MIN_MS = 1_000

/**
 * 晚调用的**即时 ready 宽限**（ms）：健康启动 ready 12–25ms，给一个远小于 1s
 * 但有界的候选窗口，避免把健康的晚调用误判红；它从诊断预留里扣。
 */
export const BOOT_LATE_READY_GRACE_MS = 250

/**
 * 剩余低于此值（ms）时，等待进一步压到 `max(0, 剩余 − 250ms)`：
 * 给诊断格式化 / close 事件留出 250ms，不因为页面采集预算为 0 就把它吃掉。
 */
export const BOOT_LATE_TIGHT_REMAINING_MS = 500

/** 页面侧事实采集的独立预算（ms）；与 `harness.ts` 的 `withDeadline` 共用。 */
export const BOOT_DIAG_PAGE_BUDGET_MS = 2_000

/** 诊断预留的额外余量（ms）：格式化、抛出与测试进程记账。 */
export const BOOT_DIAG_MARGIN_MS = 250

/** 为诊断至少保留的时间（ms）= 页面侧预算 + 余量。 */
export const BOOT_DIAG_RESERVE_MS = BOOT_DIAG_PAGE_BUDGET_MS + BOOT_DIAG_MARGIN_MS

/** 预算来源（诊断头行如实标注，不把一种来源写成另一种）。 */
export type ReadyBudgetSource = 'no-deadline' | 'explicit' | 'headroom' | 'late'

export interface ReadyBudgetInputs {
  /** ready 上限（缺省 {@link BOOT_READY_CAP_MS}）。 */
  readonly capMs?: number
  /** 当前 test 的 timeout（ms）；`null` = 非 test 上下文；`<= 0` = 禁用超时。 */
  readonly testTimeoutMs: number | null
  /** 调用时刻（goto 入口）距本测试锚点的已耗时（ms）；`null` = 无锚点。 */
  readonly elapsedMs: number | null
  /** 等待真正开始（goto 返回后）的已耗时（ms）；缺省 = `elapsedMs`。 */
  readonly waitElapsedMs?: number | null
}

export interface ReadyBudget {
  readonly source: ReadyBudgetSource
  /** 实际交给 `waitForFunction` 的等待预算（ms）。默认路径 `0` = 不等待，立即带诊断失败。 */
  readonly waitMs: number
  /** 失败时页面侧事实采集的预算（ms）。`0` = 不尝试页面采集（只发 Node 侧事实）。 */
  readonly pageProbeMs: number
  readonly testTimeoutMs: number | null
  /** 调用时刻的已耗时（ms）。 */
  readonly elapsedMs: number | null
  /** 等待开始时刻的已耗时（ms）；保证 `>= elapsedMs`（时间回拨时取较大者）。 */
  readonly waitElapsedMs: number | null
  /** 调用时刻的剩余 test 预算（ms）。 */
  readonly entryRemainingMs: number | null
  /** 等待开始时刻的剩余 test 预算（ms）。 */
  readonly remainingMs: number | null
  readonly headroomMs: number
  /** 是否走了晚调用分支（1s 下限被压破；等待可能是 0 或 250ms 宽限）。 */
  readonly floorBroken: boolean
  /** 剩余是否已到 0（默认路径下等待预算必为 0；显式覆盖不使用此字段）。 */
  readonly exhausted: boolean
}

/**
 * 由 test timeout 与两个已耗时算出等待/诊断预算（纯函数）。
 *
 * `elapsedMs === null` 但 timeout 已知时退回**旧公式**（`min(cap, max(1s, timeout − 30s))`），
 * 等价于改动前的行为；这条分支只会在"拿不到锚点"时出现，正常 test 里不会。
 */
export function decideReadyBudget(inputs: ReadyBudgetInputs): ReadyBudget {
  const capMs = Math.max(0, Math.trunc(inputs.capMs ?? BOOT_READY_CAP_MS))
  const testTimeoutMs = inputs.testTimeoutMs
  const elapsedMs = inputs.elapsedMs === null ? null : Math.max(0, Math.trunc(inputs.elapsedMs))
  const waitElapsedInput = inputs.waitElapsedMs
  const waitElapsedRaw =
    waitElapsedInput === undefined || waitElapsedInput === null
      ? elapsedMs
      : Math.max(0, Math.trunc(waitElapsedInput))
  // 时间回拨：等待开始不得早于调用时刻（否则剩余被凭空放大）。
  const waitElapsedMs =
    elapsedMs === null || waitElapsedRaw === null ? waitElapsedRaw : Math.max(elapsedMs, waitElapsedRaw)

  // 无 deadline：只受上限约束（test.setTimeout(0) 是禁用超时，不是 0ms 预算）。
  if (testTimeoutMs === null || testTimeoutMs <= 0) {
    return {
      source: 'no-deadline',
      waitMs: capMs,
      pageProbeMs: BOOT_DIAG_PAGE_BUDGET_MS,
      testTimeoutMs,
      elapsedMs,
      waitElapsedMs,
      entryRemainingMs: null,
      remainingMs: null,
      headroomMs: BOOT_READY_HEADROOM_MS,
      floorBroken: false,
      exhausted: false,
    }
  }

  // 有 deadline 但没有锚点：无从计算"已耗时"，退回旧公式（改动前语义）。
  if (elapsedMs === null || waitElapsedMs === null) {
    const waitMs = Math.min(capMs, Math.max(BOOT_READY_MIN_MS, testTimeoutMs - BOOT_READY_HEADROOM_MS))
    return {
      source: 'headroom',
      waitMs,
      pageProbeMs: Math.min(BOOT_DIAG_PAGE_BUDGET_MS, capMs),
      testTimeoutMs,
      elapsedMs,
      waitElapsedMs,
      entryRemainingMs: null,
      remainingMs: null,
      headroomMs: BOOT_READY_HEADROOM_MS,
      floorBroken: false,
      exhausted: false,
    }
  }

  const entryRemainingMs = Math.max(0, testTimeoutMs - elapsedMs)
  const remainingMs = Math.max(0, testTimeoutMs - waitElapsedMs)
  // 旧公式：90s 是上限，为归因预留 30s，最少 1s。
  const headroomWaitMs = Math.min(
    capMs,
    Math.max(BOOT_READY_MIN_MS, remainingMs - BOOT_READY_HEADROOM_MS),
  )
  // 晚调用：不再死守 1s；只给有界即时 ready 宽限（从诊断预留里扣）。
  const late = remainingMs < BOOT_READY_MIN_MS + BOOT_DIAG_RESERVE_MS
  let waitMs = late ? Math.min(BOOT_LATE_READY_GRACE_MS, remainingMs) : headroomWaitMs
  // 剩余 < 500ms：即使 page-probe 会变成 0，也保留 250ms 给诊断/close 事实。
  if (late && remainingMs < BOOT_LATE_TIGHT_REMAINING_MS) {
    waitMs = Math.max(0, remainingMs - BOOT_DIAG_MARGIN_MS)
  }
  const floorBroken = late
  const exhausted = remainingMs <= 0
  // 页面侧采集预算 = 剩余 − 已承诺的等待 − 余量；不足则为 0（只发 Node 侧事实）。
  const pageProbeMs = Math.min(
    BOOT_DIAG_PAGE_BUDGET_MS,
    Math.max(0, remainingMs - waitMs - BOOT_DIAG_MARGIN_MS),
  )
  return {
    source: late ? 'late' : 'headroom',
    waitMs,
    pageProbeMs,
    testTimeoutMs,
    elapsedMs,
    waitElapsedMs,
    entryRemainingMs,
    remainingMs,
    headroomMs: BOOT_READY_HEADROOM_MS,
    floorBroken,
    exhausted,
  }
}

/**
 * 显式 `readyTimeoutMs` 覆盖：**不参与**剩余预算政策（负对照用它把失败收敛到秒级）。
 *
 * 原样保留调用方的值：`0` = Playwright 的"不设超时"，**负数 = 立即超时**（Playwright
 * 事实，不是无限）；**不**把默认路径的"预算耗尽 0"语义套上来。仍把 timeout/elapsed
 * 记进事实行，便于对账。
 */
export function explicitReadyBudget(
  waitMs: number,
  testTimeoutMs: number | null = null,
  elapsedMs: number | null = null,
): ReadyBudget {
  const raw = Number.isFinite(waitMs) ? Math.trunc(waitMs) : 0
  return {
    source: 'explicit',
    waitMs: raw,
    pageProbeMs: BOOT_DIAG_PAGE_BUDGET_MS,
    testTimeoutMs,
    elapsedMs,
    waitElapsedMs: elapsedMs,
    entryRemainingMs: null,
    remainingMs: null,
    headroomMs: BOOT_READY_HEADROOM_MS,
    // 显式 0（不设超时）/负数（立即超时）都不是"预算耗尽"，控制流不得据此快速失败。
    floorBroken: false,
    exhausted: false,
  }
}

/**
 * 单行事实（进诊断的 `[budget]` 行；≤ 320 字符）。
 *
 * 只报**已经发生**的数：没有锚点就写 `elapsed=none`，没有 deadline 就写
 * `test-timeout=none`，绝不补一个看起来合理的默认值。剩余一律标成
 * `basis=anchor-estimate` + `remaining-estimate`；`actual-remaining=unknown`
 * （close 兜底执行时实际剩余已不可从 Node 侧测量，不能用估算值冒充事实）。
 */
export function describeReadyBudget(budget: ReadyBudget): string {
  const ms = (v: number | null): string => (v === null ? 'none' : `${v}ms`)
  // `test.setTimeout(0)` 是**禁用**超时（没有 deadline），不是 0ms deadline。
  const deadline = (v: number | null): string => (v === null || v <= 0 ? 'none' : `${v}ms`)
  const parts = [
    `source=${budget.source}`,
    'anchor=first-goto',
    // 预算是"锚点估算"，不是实际剩余；实际剩余在 deadline 关页时无法从 Node 侧读到。
    'basis=anchor-estimate',
    `test-timeout=${deadline(budget.testTimeoutMs)}`,
    `elapsed=${ms(budget.elapsedMs)}`,
    `wait-elapsed=${ms(budget.waitElapsedMs)}`,
    `entry-remaining-estimate=${ms(budget.entryRemainingMs)}`,
    `remaining-estimate=${ms(budget.remainingMs)}`,
    'actual-remaining=unknown',
    `wait=${budget.waitMs}ms`,
    `page-probe=${budget.pageProbeMs}ms`,
    `headroom=${budget.headroomMs}ms`,
    `floor-broken=${budget.floorBroken}`,
    `exhausted=${budget.exhausted}`,
  ]
  return `[budget] ${parts.join(' ')}`.slice(0, 320)
}
