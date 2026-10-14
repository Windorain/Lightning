/**
 * **R5-0 ② · 呈现链失败上报的"界"**（#391）。
 *
 * ## 这条判据防的是什么
 *
 * `emitPresenterFailure`（`useViewportRuntime`）的去重集合初版**无界**：只增不减、
 * 零容量上限、零判据可见。而它的动机恰恰是保护容量 512 的**有界**环形缓冲
 * ——观测设施自己成了泄漏源。触发条件不是理论：签名里带 `detail`，而 `detail`
 * 承载自由文本（异常 `message`、`out.compileError`），函数又在**帧循环**里被调用，
 * 于是"错误信息逐帧变化"就等于"集合逐帧增长"。
 *
 * 本文件把四件事变成机器可判的事实（每条都带负对照 / 反空洞真）：
 *
 *  1. **封顶**：逐帧变化的 `message`（一万条各不相同）⇒ 签名数 ≤ 256；
 *  2. **丢弃可见**：超限后上报里出现 `kind === 'dropped'`（不是静默丢弃）；
 *  3. **丢弃上报自己有界**：N 次丢弃的记录数是对数级（不是"把静默丢弃换成挤爆缓冲"）；
 *  4. **口径同源**：签名用的 `detail` 逐字节等于记录器 `sanitizeParams` 的产出
 *     ——否则去重判"不同"而读面看到"相同"，同一条事实在账上出现两次。
 *
 * ## 为什么可以纯函数驱动（不接生产视口）
 *
 * 被驱动的 `createPresenterFailureReporter` 是生产代码本身（`useViewportRuntime`
 * 就调它），只是把"写成诊断记录"这一动作换成回调 —— 上报设施与决策是解耦的。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PARAM_VALUE_MAX, sanitizeParams } from '@/application/diagnostics'
import {
  PRESENTER_FAILURE_DETAIL_MAX,
  PRESENTER_FAILURE_SIGNATURE_MAX,
  createPresenterFailureReporter,
  type PresenterFailureReport,
} from '@/shared/viewport/useViewportRuntime'

/** 收集上报（记录器的替身：只做"收到什么"的观测，不参与决策）。 */
function collector(): {
  readonly reports: PresenterFailureReport[]
  readonly reporter: ReturnType<typeof createPresenterFailureReporter>
} {
  const reports: PresenterFailureReport[] = []
  return { reports, reporter: createPresenterFailureReporter((r) => reports.push(r)) }
}

const failuresOf = (reports: readonly PresenterFailureReport[]): PresenterFailureReport[] =>
  reports.filter((r) => r.kind === 'failure')
const droppedOf = (reports: readonly PresenterFailureReport[]): PresenterFailureReport[] =>
  reports.filter((r) => r.kind === 'dropped')

/**
 * 读源码并**归一化行尾**（铁律 6：本仓 `core.autocrlf=true`，新鲜检出是 CRLF；
 * 同一份断言必须在两种口径下同结论）。本文件当下没有行尾敏感的断言，
 * 但"恰好安全"不是判据 —— 统一走本入口使"读到的文本恒为 LF"成为文件级前提。
 */
function readSource(absPath: string): string {
  return fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n')
}

describe('R5-0 ② · 去重签名数**封顶**（观测设施不得自己无界）', () => {
  it('负对照：逐帧变化的 message（一万条各不相同）⇒ 签名数封顶，而不是跟着帧数涨', () => {
    const { reports, reporter } = collector()
    for (let frame = 0; frame < 10_000; frame++) {
      reporter.emit('threw', `第 ${frame} 帧：呈现器抛错（这条 message 每帧都不同）`)
    }
    // 反空洞真：输入**确实**各不相同（否则"封顶"可能只是没造出不同签名）
    expect(new Set(failuresOf(reports).map((r) => r.detail)).size, '制造的 message 必须两两不同').toBe(
      PRESENTER_FAILURE_SIGNATURE_MAX,
    )
    expect(
      reporter.signatureCount(),
      `签名数必须封顶（初版实现这里等于 10000）：实测 ${reporter.signatureCount()}`,
    ).toBeLessThanOrEqual(PRESENTER_FAILURE_SIGNATURE_MAX)
    expect(reporter.dropCount(), '超出容量的那些必须被**计数**（丢弃可见的前提）').toBe(
      10_000 - PRESENTER_FAILURE_SIGNATURE_MAX,
    )
  })

  it('封顶前逐条上报、同签名静默（去重语义没有被容量口径改掉）', () => {
    const { reports, reporter } = collector()
    reporter.emit('compile', 'E_CAPACITY')
    reporter.emit('compile', 'E_CAPACITY')
    reporter.emit('kernel-skip', 'no-typed-geometry', 'obj-a')
    reporter.emit('kernel-skip', 'no-typed-geometry', 'obj-a')
    reporter.emit('kernel-skip', 'no-typed-geometry', 'obj-b')
    expect(failuresOf(reports)).toHaveLength(3)
    expect(reporter.dropCount(), '未超容量时不得有丢弃').toBe(0)
    expect(reporter.signatureCount()).toBe(3)
  })

  it('签名含 `objectId`：同 reason/detail 但对象不同 ⇒ 各记一次（不互相吞掉）', () => {
    const { reports, reporter } = collector()
    reporter.emit('annotation', 'no-geometry', 'obj-1')
    reporter.emit('annotation', 'no-geometry', 'obj-2')
    expect(failuresOf(reports).map((r) => r.objectId)).toEqual(['obj-1', 'obj-2'])
  })
})

describe('R5-0 ② · 丢弃**可见**且上报**自己有界**', () => {
  it('超限后出现 kind === "dropped"（不是静默丢弃），并带累计计数', () => {
    const { reports, reporter } = collector()
    for (let i = 0; i < PRESENTER_FAILURE_SIGNATURE_MAX + 3; i++) reporter.emit('threw', `e${i}`)
    const dropped = droppedOf(reports)
    expect(dropped.length, '丢弃必须被上报（否则只是把泄漏换成静默丢弃）').toBeGreaterThan(0)
    expect(dropped[0]!.reason, 'drop 记录必须带上是**哪个 reason** 在溢出').toBe('threw')
    expect(dropped.map((r) => r.detail), '前 8 次逐次精确').toEqual(['1', '2', '3'])
    expect(reporter.dropCount()).toBe(3)
  })

  it('丢弃上报**自己有界**：10 万次丢弃 ⇒ 记录数对数级（≤ 8 + log2(N/8)）', () => {
    const { reports, reporter } = collector()
    const n = 100_000
    for (let i = 0; i < PRESENTER_FAILURE_SIGNATURE_MAX; i++) reporter.emit('threw', `fill-${i}`)
    const beforeDrops = reports.length
    for (let i = 0; i < n; i++) reporter.emit('threw', `overflow-${i}`)

    expect(reporter.dropCount(), '每一次超限都必须被计数').toBe(n)
    const dropped = droppedOf(reports.slice(beforeDrops))
    expect(dropped.length, '必须真的发生了上报（否则上面的界是空转）').toBeGreaterThan(0)
    expect(
      dropped.length,
      `丢弃上报必须对数增长（逐次上报 = 把静默丢弃换成挤爆共享缓冲）：实测 ${dropped.length}`,
    ).toBeLessThanOrEqual(8 + Math.ceil(Math.log2(n / 8)))
    // 上报的计数单调、且最后一次 ≤ 真值（读数是对真值的下界）
    const counts = dropped.map((r) => Number(r.detail))
    expect(counts, '上报计数必须严格递增').toEqual([...counts].sort((a, b) => a - b))
    expect(Math.max(...counts)).toBeLessThanOrEqual(n)
  })
})

describe('R5-0 ② · 签名截断口径与记录器**同源**', () => {
  it('就地声明的常量必须等于记录器的 PARAM_VALUE_MAX（口径漂移即红）', () => {
    expect(
      PRESENTER_FAILURE_DETAIL_MAX,
      '本文件就地声明该常量是为避开旧层→新内核的导入；它必须与记录器逐字相同',
    ).toBe(PARAM_VALUE_MAX)
    expect(PRESENTER_FAILURE_SIGNATURE_MAX).toBe(256)
  })

  it('签名用的 detail 逐字节等于 sanitizeParams 的产出（长文本截断处）', () => {
    const long = `E_${'x'.repeat(PARAM_VALUE_MAX + 50)}`
    const { reports, reporter } = collector()
    reporter.emit('compile', long)
    const got = failuresOf(reports)[0]!
    expect(got.detail, '读面看到什么，去重就必须按什么去重').toBe(sanitizeParams({ detail: long }).detail)
    expect(got.detail.length).toBe(PARAM_VALUE_MAX + 1)
  })

  it('只在前 200 字符之后不同的两条 detail ⇒ 同一签名（读面本来也分不出）', () => {
    const { reports, reporter } = collector()
    const head = 'y'.repeat(PARAM_VALUE_MAX)
    reporter.emit('threw', `${head}-A`)
    reporter.emit('threw', `${head}-B`)
    expect(failuresOf(reports)).toHaveLength(1)
    expect(reporter.signatureCount()).toBe(1)
  })
})

describe('R5-0 ② · 接线判据：生产文件确实走这个有界上报器', () => {
  it('`useViewportRuntime.ts` 用 `createPresenterFailureReporter`，且旧的无界集合已消失', () => {
    const p = path.join(import.meta.dirname, '..', 'useViewportRuntime.ts')
    const src = readSource(p)
    expect(src.length, '反空洞真：读到的必须是非空源文件').toBeGreaterThan(1000)
    expect(src, '生产接线必须用有界上报器').toContain('createPresenterFailureReporter')
    expect(src, '旧的无界去重集合不得复活').not.toContain('reportedPresenterFailures')
    // 9 个发点仍然在（接线只是换了实现，不是删掉了上报）
    expect(src.match(/emitPresenterFailure\(/g)?.length ?? 0).toBeGreaterThanOrEqual(9)
  })
})
