/**
 * M7-6 · **同页第二个工作台：结构禁止 + 一句人话**（M7-0 Q3 裁决）。
 *
 * ## 裁决内容
 *
 * 「多工作台保持结构禁止、报错改人话」。两条都必须被钉住：
 *
 * | 要求 | 判据 |
 * |---|---|
 * | 结构禁止**不变** | 仍然只有一个 document keydown 持有者（`__p7_input__.keydownOwners()` 长度 1） |
 * | 报错改成**人话** | 第二个实例内出现 `[data-lk-workbench-conflict]`，文案是成句中文（逐字） |
 * | 原实例**不受影响** | 第一个实例仍能用键盘命令（Ctrl+Z 命中 `edit.undo` 路由）、无提示条 |
 * | 不把页面搞崩 | `pageerror` 为空（旧形态把异常抛在 `onMounted` 的异步回调里） |
 *
 * ## 为什么"文案逐字"
 *
 * M7-3 的 G5 已经立过同一条纪律（宽匹配会让文案漂移静默通过）。文案的单一真源是
 * `src/workbench/singleWorkbenchNotice#SINGLE_WORKBENCH_NOTICE`；本文件把它**读出来**
 * 断言页面上的文本，而不是复制一份字面量去比对（复制会比出两个真源）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const PAGE = '/e2e/pages/workbench-dual.html'

/** 文案的单一真源：从产品源码读出（不复制字面量）。 */
function noticeCopy(): string {
  const file = path.resolve(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
    '../src/workbench/singleWorkbenchNotice.ts',
  )
  const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const m = /export const SINGLE_WORKBENCH_NOTICE =\s*\n?\s*'([^']+)'/.exec(src)
  if (!m) throw new Error('未能从 singleWorkbenchNotice.ts 读出提示文案')
  return m[1]!
}

async function bothReady(page: Page): Promise<void> {
  await page.goto(PAGE)
  await page.waitForFunction(() => (window as any).__workbenchDual__?.ready === true, undefined, {
    timeout: 120_000,
  })
  // 两个实例都渲染出 shell 才算"装配真的跑过"（而不是还在启动）。
  await expect
    .poll(async () => await page.locator('.wb-shell').count(), { timeout: 120_000 })
    .toBeGreaterThanOrEqual(2)
}

test.describe('M7-6 · 多工作台：结构禁止不变、提示改人话', () => {
  test('第二个工作台给出一句人话；原实例的键盘与唯一持有者不受影响', async ({ page }) => {
    test.setTimeout(240_000)
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await bothReady(page)
    // 让第二个实例走完装配（它的失败发生在 mounted 之后的异步装配里）
    await page.waitForFunction(
      () => document.querySelectorAll('[data-lk-workbench-conflict]').length >= 1,
      undefined,
      { timeout: 60_000 },
    ).catch(() => { /* 交给下面的断言报出具体缺失 */ })

    const copy = noticeCopy()
    const reading = await page.evaluate(() => {
      const notices = [...document.querySelectorAll('[data-lk-workbench-conflict]')]
      const inB = document.querySelectorAll('#wb-b [data-lk-workbench-conflict]').length
      const inA = document.querySelectorAll('#wb-a [data-lk-workbench-conflict]').length
      const owners = (window as any).__p7_input__?.keydownOwners?.() ?? null
      const counters = (window as any).__p7_input__?.counters?.() ?? null
      return {
        total: notices.length,
        inA,
        inB,
        texts: notices.map((n) => (n.textContent ?? '').replace(/\r\n/g, '\n').trim()),
        owners,
        counters,
        vmPresent: typeof (window as any).__vm__ === 'object' && (window as any).__vm__ !== null,
      }
    })
    console.log('[Q3] ' + JSON.stringify(reading) + ' copy=' + JSON.stringify(copy))

    // ── ① 人话提示：只在**第二个**实例内出现，且逐字等于定稿文案 ──
    expect(reading.total, '⚠️ Q3：第二个工作台必须给出可见提示（旧形态是抛错后白屏）').toBe(1)
    expect(reading.inB, '提示必须落在**被拒的那个实例**内（用户能看出是哪一个）').toBe(1)
    expect(reading.inA, '⚠️ 第一个实例不得被标注为冲突').toBe(0)
    expect(reading.texts[0], '⚠️ 提示必须是定稿的那一句中文（逐字）').toBe(copy)

    // ── ② 结构禁止**不变**：document keydown 仍只有一个持有者 ──
    expect(reading.owners, '⚠️ A22 的结构防御不得因"改人话"而放松').toEqual(['workbench'])

    // ── ③ 原实例不受影响：键盘仍走同一条路由（一次按键仍只计一次 keydown）──
    const before = await page.evaluate(() => (window as any).__p7_input__?.counters?.()?.keyEvents ?? null)
    expect(before, '前提：第一个实例的输入面必须已装配（否则下面"没影响"是空转）').not.toBeNull()
    await page.locator('#wb-a .wb-shell').click({ position: { x: 30, y: 30 } })
    await page.keyboard.press('F5')
    const after = await page.evaluate(() => (window as any).__p7_input__?.counters?.()?.keyEvents ?? null)
    expect(after! - before!, '一次按键仍只被路由一次（两条 document keydown 会计两次）').toBe(1)

    // ── ④ 不把页面搞崩 ──
    expect(pageErrors, '⚠️ 第二个工作台不得把未捕获异常抛给页面').toEqual([])
  })
})
