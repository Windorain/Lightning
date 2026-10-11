/**
 * #272 回归守卫：harness 注入的**导航竞态**。
 *
 * ## 为什么需要这个 spec（而不是只依赖线上偶发）
 *
 * #272 的原始现象是**间歇性**的：只在全量套件、负载较大时出现（已 4 次），
 * 单跑 `parts-hover-stats.spec.ts` 不复现，且每次都重试通过。
 * 一个只靠"等它偶发"的修复无法被验收 —— 无法区分"修好了"与"这轮没抽到"。
 *
 * 故本 spec 把**竞态本身**变成可确定触发的输入：在页面里安排一次真实导航
 * （`location.reload()` —— 即 dev server 侧 HMR `full-reload` 或
 * `vite:ws:disconnect` 时 Vite 客户端 `vite/dist/client/client.mjs` 所做的事），
 * 让它与注入/evaluate 的**执行窗口重叠**，然后断言 harness 仍然交付正确结果。
 *
 * ## 两条判据（分别覆盖修复的两半）
 *
 *  - **A（就绪门）**：注入窗口内发生导航 ⇒ 仍在**正确的新文档**上完成注入并断言
 *    `docLoaded`。证明"注入前等到 load + app 就绪"这一半有效。
 *  - **B（重试路径）**：把导航安排在 evaluate 执行**正中**（被求值函数 sleep 500ms，
 *    导航在 150ms 时发生）⇒ `evaluateNavigable` 必须接住
 *    `Execution context was destroyed` 并在新文档上重试成功。
 *    **A 单独存在时，重试路径从未被走到** —— 那样"重试能不能用"就没有证据，
 *    故 B 不是冗余：它专门压重试分支。
 *
 * ## 证伪记录（先证红）
 *
 * 未修复前（`page.evaluate` 直调），同一 A 场景实测稳定复现：
 * `page.evaluate: Execution context was destroyed, most likely because of a navigation.`
 * 修复后 A/B 均绿。见 #272 的 `*-repro-red.log`（红）与 `*-repro-green.log`（绿）。
 */
import { expect, test } from '@playwright/test'
import { evaluateNavigable, gotoWorkbench, injectSceneDocumentOk } from './helpers/multiblock/harness'
import { readPartsFixture } from './helpers/parts/fixtures'

test.describe('#272 · 注入导航竞态（导航落在注入/evaluate 窗口内）', () => {
  test('A：注入窗口内发生导航 ⇒ 就绪门把注入推迟到新文档稳定后，注入仍成功', async ({ page }) => {
    test.setTimeout(180_000)
    await gotoWorkbench(page)

    // 与注入重叠的一次真实导航（落在注入 evaluate 的执行窗口内）
    await page.evaluate(() => {
      setTimeout(() => location.reload(), 80)
    })

    const f = readPartsFixture('parts-singlebox-mix.v2.json')
    // 判据**不减弱**：仍断言 docLoaded 且 doc 非空（`injectSceneDocumentOk` 内）
    const r = await injectSceneDocumentOk(page, f, 'nav-race-a.json')
    expect(r.docLoaded).toBe(true)
  })

  test('B：导航落在 evaluate 正中 ⇒ 重试路径接住并恢复（A 覆盖不到这一半）', async ({ page }) => {
    test.setTimeout(180_000)
    await gotoWorkbench(page)

    // 150ms 后导航；被求值函数执行 500ms ⇒ 导航必然落在 evaluate 窗口正中，
    // 于是**必然**走到 `isNavigationDestroyedError` 的那条重试分支。
    await page.evaluate(() => {
      setTimeout(() => location.reload(), 150)
    })
    const value = await evaluateNavigable(
      page,
      async () => {
        await new Promise((res) => setTimeout(res, 500))
        return 'recovered'
      },
      null,
    )
    expect(value, '被导航打断的 evaluate 必须在新文档上重试成功').toBe('recovered')

    // 反空洞真：重试必须是**在新文档上、且 app 已重新就绪**之后完成的 ——
    // 否则"恢复"可能只是拿到了旧文档的结果（#272 的更隐蔽形态）。
    const ready = await page.evaluate(() => (window as any).__vm_ready__ === true)
    expect(ready, '重试后必须在新文档上重新等到 app 就绪').toBe(true)
  })

  test('**负对照**：非导航类错误**不得**被重试吞掉（重试不等于掩盖缺陷）', async ({ page }) => {
    test.setTimeout(180_000)
    await gotoWorkbench(page)

    // 应用内主动抛错 ⇒ 必须**原样上抛**，且**只尝试一次**（不得被当成竞态重试）。
    let calls = 0
    await expect(
      evaluateNavigable(
        page,
        () => {
          ;(window as any).__negctl_calls__ = ((window as any).__negctl_calls__ ?? 0) + 1
          throw new Error('负对照：应用层真实错误')
        },
        null,
      ),
    ).rejects.toThrow(/负对照：应用层真实错误/)

    calls = await page.evaluate(() => (window as any).__negctl_calls__ ?? 0)
    expect(calls, '非导航类错误必须立即上抛：只应执行一次').toBe(1)
  })
})
