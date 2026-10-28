/**
 * **真实 test deadline** 的进程侧证据 spec（不在默认 e2e 套件里）。
 *
 * ## 为什么单列
 *
 * 这两条用例**必须被 test deadline 打断**：首败是 Playwright 的
 * `Test timeout of ...ms exceeded`，根本走不到 `gotoWorkbench` 的 catch。若把它们放进
 * 默认套件，就会以"预期外失败"污染绿灯；若用 `test.fail()`，Playwright 也不把
 * `timedOut` 当作 expected `failed`（实测：仍报 failed）。故：
 *
 *  - 文件名用 `*.deadline.ts`；主 `playwright.config.ts` **默认 testIgnore**；
 *  - 证据 runner 用 `REAL_DEADLINE_E2E=1` 打开主 config 的 `testMatch`，并**复用
 *    `test:e2e:tree` 包装**（同一 webServer + globalSetup + `__tree__` nonce/root
 *    身份门禁），不另起裸 Playwright 入口；
 *  - 每条用例在**第一行**向 stderr 写 `[deadline-case] caseN <title>`，runner
 *    据此逐 case 分块（禁止跨 block/全局匹配），并断言每块恰好一条
 *    `[boot-probe:close]` + 块内自己的 `[budget]`/`[nav]`/`[attribution]`。
 *
 * ## 覆盖什么
 *
 *  - 用例 1：10s deadline，**先睡 5s 再首次 goto**（锚点晚 ⇒ 剩余被高估；source 可能
 *    headroom 或 late）；主文档再延迟 2.5s、模块中止、页面采集挂起 ⇒ deadline 仍落在
 *    采集期间关页。首次 goto 仍有 5s 余量（慢加载下不至于在 goto 期间先撞 deadline）。
 *  - 用例 2：4s deadline，主文档响应被无限扣住（goto 一直 pending）⇒ deadline 落在
 *    **goto 期间**；close 兜底给出 nav/attribution，导航事实是"已发起、随后失败/未提交"
 *    （`starts=1 commits=0`，而不是 `pending=true`）。
 *
 * 判据是**运行输出**（process-side evidence），不是"错误 message 里有诊断"：
 * 首败 message 是 Test timeout，这一点不伪称。
 */
import { test } from '@playwright/test'
import { gotoWorkbench } from './helpers/multiblock/harness'

test.describe.configure({ retries: 0 })

test('deadline 在 ready/采集期间：close 兜底须给出分类与预算事实', async ({ page }) => {
  // 分块标记（stderr）：必须早于任何 await，deadline 打断前一定已写出。
  process.stderr.write(
    '[deadline-case] case1 deadline 在 ready/采集期间：close 兜底须给出分类与预算事实\n',
  )
  test.setTimeout(10_000)
  // 主文档延迟 2.5s：既保留 5s 的首次 goto 余量，又把"等待+采集"推到 10s deadline 之后。
  await page.route(
    (url) => url.pathname === '/',
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_500))
      await route.continue()
    },
  )
  await page.route('**/src/workbench/WorkbenchRoot.vue*', (route) => route.abort('failed'))
  // 页面侧采集永不返回：把"等待 + 采集"推到 deadline 之后（演练真实最坏形态）。
  const anyPage = page as any
  anyPage.evaluate = () => new Promise(() => {})
  // 先睡 5s：首次进入 harness 时已耗时 5s（锚点晚，剩余会被高估）。
  await page.waitForTimeout(5_000)
  // 期望：test deadline 在 10s 关闭页面；不再有 harness 的 catch。
  await gotoWorkbench(page)
})

test('deadline 落在 goto 期间：导航已发起未提交也须有 Node 事实', async ({ page }) => {
  process.stderr.write(
    '[deadline-case] case2 deadline 落在 goto 期间：导航已发起未提交也须有 Node 事实\n',
  )
  test.setTimeout(4_000)
  // 主文档响应永不放行（定时器 unref：close 后不拖住 worker），goto 全程 pending。
  await page.route(
    (url) => url.pathname === '/',
    async () => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 60_000)
        timer.unref?.()
      })
    },
  )
  // 立刻发起 goto：deadline（4s）必然落在导航 pending 窗口内。
  await gotoWorkbench(page)
})
