/**
 * 回归守卫：**gotoWorkbench 启动失败的可归因性**。
 *
 * ## 为什么需要这个 spec
 *
 * 现象不是"启动失败"本身，而是**失败不可归因**：full 套件里第二次
 * `gotoWorkbench` 后 `__vm_ready__` 等满 90s，首跑只留下一句
 * `Timeout 90000ms exceeded` —— 既没有页面侧事实，也无法回答"是模块没下来、
 * 文档被反复替换、启动抛错，还是渲染进程冻住了"。定向复跑又 8/8 健康
 * （ready 12–25ms、486 模块/启动、无 reload），于是这条失败**无法被追**。
 *
 * 本 spec 用**确定性负对照**把四类启动失败逐一压给真实 `gotoWorkbench`，
 * 断言"首次短超时就能在消息里区分类别"；用**正对照**钉住探针的健康路径代价为零；
 * 再用**默认路径对照**证明诊断真的进得了断言/报告（不靠"延长 test timeout"）。
 *
 * ## 预算政策：90s 上限 / 正常为归因预留 30s / **按真实剩余收紧**
 *
 * 缺省 test timeout 也是 90s；若 ready 等满 90s，test deadline 会先关页面，诊断进不了报告。
 * 正常路径仍用 `min(90s, max(1s, test timeout − 30s))`：缺省 90s ⇒ 60s；大 timeout ⇒ 仍 90s；
 * 小 test 预算 ⇒ 1s（`test.setTimeout(0)` 是禁用超时 ⇒ 上限 90s）。**test timeout 本身不改**；
 * 显式 `readyTimeoutMs` 仍优先。
 *
 * **剩余缺口**：旧政策只看 timeout、不看已经跑了多久，于是 90s 的用例在 30s 后做
 * 第二次 `gotoWorkbench` 仍拿 60s —— ready + 采诊断一起越过 test deadline，页面先关、
 * 诊断丢失。现在 harness 以"本测试首次进入 harness"为锚点（公开 `test.info()` 对象身份
 * 分组，**不注册 hook、不跨测试串号**）算已耗时；剩余放不下"1s 等待 + 3.25s 诊断预留"
 * 时，给 `min(250ms, 剩余)` 的**有界即时 ready 宽限**（从诊断预留里扣），既不让 deadline
 * 先关页，也不把健康晚调用误判红。
 *
 * **close 兜底与预算来源无关**：锚点晚（例如 7s 用例先睡 5s 才首次 goto）会让剩余被高估，
 * 首败可能是 Playwright 的 Test timeout，根本走不到 harness 的 catch。故页面 close 监听在
 * **goto 之前 armed、ready 成功 disarm**；pending 期间任何 close（deadline / 外部关页）
 * 都写一条 ≤1KB `[boot-probe:close]` **stderr** 事实（budget/nav/events/attribution），
 * 不 evaluate、与 source 无关。真实 deadline 的端到端证据在
 * `e2e/real-deadline.deadline.ts` + `scripts/run-real-deadline-evidence.mjs`
 * （预期由 deadline 打断；判据是脚本对运行输出的断言）。
 *
 * **锚点的限度（不声称消除未知 flaky）**：Playwright 1.60 的公开 `TestInfo` 没有
 * `startTime`；锚点是"首次进入 harness"，故已耗时是**下界**，首调之前跑掉的时间不计入。
 * ≤30s 的高估由 headroom 吸收；更极端的晚启动仍可能撞 deadline —— 由 close 兜底保证至少
 * 有分类与导航事实。**不声称"任意二次启动都必然可归因"**。
 *
 * 三条新对照的确定性来自**受控时钟**（把 `Date.now` 推进到"只剩 ~1–2s"）与**真实关页**，
 * 都不等真实 90s、不靠 retry；见 `晚调用棘轮` / `健康晚调用` / `关页兜底` 三节。
 *
 * ## 判据边界（只修可归因性）
 *
 *  - **不消除未知 flaky**，也不声称修好了 full 里的那次超时：探针只让下一次失败
 *    **有据可查**；
 *  - **不新增自动 retry**（本文件显式 `retries: 0`，失败必须在**首跑**判定）、
 *    **不改业务断言**、**不开全局 trace**、**不改产品**；
 *  - 短预算 `readyTimeoutMs` 只在本 spec 的负对照里出现：它收敛的是"多久知道失败"，
 *    不是"允许多失败一次"；**默认路径对照不传它**（走真实 headroom 政策）。
 *
 * ## 四类失败是怎么造的（都不碰产品代码）
 *
 * | 类别 | 注入方式 | 为什么这样造 |
 * |---|---|---|
 * | 模块请求失败 | `page.route` 中止 `/src/workbench/WorkbenchRoot.vue` | 真实网络层失败；浏览器侧记 `requestfailed`（script） |
 * | reload 循环 | 文档响应用"自刷新文档"替换 | 真实 app 页面无法在不削弱就绪语义的前提下稳定复现"永不就绪"；本控只压探针/诊断的**接线与分类**，不声称产品行为 |
 * | 启动抛错 | `page.route` 把 `WorkbenchRoot.vue` 换成一个 setup 抛错的组件 | 走**真实** Vue 错误边界（`DevApp#onErrorCaptured`）⇒ 真 `.wm-boot--err` |
 * | 采集失败 / 不返回 | 仪表替换 `page.evaluate` | 模拟"渲染进程冻结 / 导航销毁执行上下文"；判据是**诊断自身有界**且给出部分诊断 |
 */
import { expect, test, type Page, type Route } from '@playwright/test'
import { gotoWorkbench } from './helpers/multiblock/harness'

// 失败必须在**首跑**判定：不许靠 Playwright retry 把"第二次才明白"当通过。
test.describe.configure({ retries: 0 })

/**
 * 探针会（且只会）注册这 **9 类**监听，每页各一次。
 *
 * 前 4 类进事件缓冲（console / pageerror / requestfailed / response），后 5 类是
 * **独立启动状态**（framenavigated / request / requestfinished 构成"启动范围"的
 * start/commit/pending；dialog 是一次性 accept；**close** 只在启动 pending 期间写
 * Node 兜底，健康成功时 pending 已 disarm ⇒ 零输出）。requestfailed 只注册 **1** 次：
 * 事件缓冲与"在途导航落定"在**同一个 handler** 里完成。
 */
const PROBE_EVENTS = [
  'console',
  'pageerror',
  'requestfailed',
  'response',
  'framenavigated',
  'request',
  'requestfinished',
  'dialog',
  'close',
] as const

/** 把探针的失败日志（`console.error`）收进数组，用于断言"健康路径零输出"。 */
function captureProbeLogs(): { logs: string[]; restore: () => void } {
  const logs: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '))
  }
  return {
    logs,
    restore: () => {
      console.error = original
    },
  }
}

/** 统计 `page.on` 的注册次数（按事件名），用于断言"每页只注册一次、不随调用增长"。 */
function countListenerRegistrations(page: Page): {
  counts: Record<string, number>
  restore: () => void
} {
  const anyPage = page as any
  const counts: Record<string, number> = Object.fromEntries(PROBE_EVENTS.map((e) => [e, 0]))
  const realOn = anyPage.on.bind(page)
  const realOff = anyPage.off.bind(page)
  anyPage.on = (event: string, handler: unknown) => {
    if (event in counts) counts[event]! += 1
    return realOn(event, handler)
  }
  anyPage.off = (event: string, handler: unknown) => {
    if (event in counts) counts[event]! -= 1
    return realOff(event, handler)
  }
  return {
    counts,
    restore: () => {
      anyPage.on = realOn
      anyPage.off = realOff
    },
  }
}

/** 统计 `page.evaluate` 调用次数，用于断言"健康路径零额外 evaluate"。 */
function countEvaluates(page: Page): { count: () => number; restore: () => void } {
  const anyPage = page as any
  const realEvaluate = anyPage.evaluate.bind(page)
  let n = 0
  anyPage.evaluate = (...args: unknown[]) => {
    n += 1
    return realEvaluate(...args)
  }
  return {
    count: () => n,
    restore: () => {
      anyPage.evaluate = realEvaluate
    },
  }
}

/** 用 `page.route` 中止某个模块请求（`abort('failed')` ⇒ 浏览器侧 `net::ERR_FAILED`）。 */
async function abortModule(page: Page, pattern: string): Promise<void> {
  await page.route(pattern, (route: Route) => route.abort('failed'))
}

/** 捕获 `gotoWorkbench` 的失败，返回错误对象（成功则返回 `null` 并让调用方断言红）。 */
async function bootFailure(page: Page, readyTimeoutMs: number): Promise<Error | null> {
  return await gotoWorkbench(page, { readyTimeoutMs }).then(
    () => null,
    (e: unknown) => e as Error,
  )
}

/** 诊断块 = 消息里第一行之后的部分（第一行是"预算 + 原错误"）。 */
function diagnosticOf(message: string): string {
  const at = message.indexOf('\n')
  return at < 0 ? '' : message.slice(at + 1)
}

test.describe('gotoWorkbench 启动失败可归因性', () => {
  test('正对照：健康启动零额外 evaluate、零 [boot-probe] 日志、探针每页只注册一次', async ({ page }) => {
    test.setTimeout(180_000)
    const evals = countEvaluates(page)
    const listeners = countListenerRegistrations(page)
    const probeLogs = captureProbeLogs()
    let evaluateCount = -1
    let firstCounts: Record<string, number> = {}
    try {
      await gotoWorkbench(page)
      firstCounts = { ...listeners.counts }
      // 同一页再打开一次：既要仍然健康，也要证明探针**没有**再注册一遍监听。
      await gotoWorkbench(page)
      evaluateCount = evals.count()
      expect(listeners.counts, '探针监听每页只注册一次：第二次 gotoWorkbench 不得新增').toEqual(firstCounts)
      // 真实监听数：9 类各 1 次（requestfailed 只有 1 个 handler —— 事件缓冲与在途导航
      // 落定在同一回调里完成；探针不抢注导航纪元，那份计数是独立状态；
      // close 是为"启动 pending 期间关页"新增的一次性监听，不随 goto 次数增长）。
      expect(firstCounts, '探针每页注册 9 类监听，各一次').toEqual({
        console: 1,
        pageerror: 1,
        requestfailed: 1,
        response: 1,
        framenavigated: 1,
        request: 1,
        requestfinished: 1,
        dialog: 1,
        close: 1,
      })
      expect(probeLogs.logs, '健康路径不得有 [boot-probe] 日志').toEqual([])
    } finally {
      probeLogs.restore()
      evals.restore()
      listeners.restore()
    }
    // 计数快照在停机前取（读取上面的计数本身不得污染判据）
    expect(evaluateCount, '健康路径不得有任何额外 page.evaluate（诊断只在失败时采集）').toBe(0)
    // 健康判据未变（与改动前逐字相同：__vm_ready__ 且 .wb-shell 可见）
    expect(await page.evaluate(() => (window as any).__vm_ready__ === true)).toBe(true)
    await expect(page.locator('.wb-shell')).toBeVisible()
  })

  /**
   * 显式 `readyTimeoutMs: 0` 在 Playwright 里是"**不设超时**"，不是"预算耗尽 0"。
   * 健康页必须照常通过，且不得因此产生任何 `[boot-probe]` 输出。
   */
  test('显式 0ms 语义：Playwright 的"不设超时"，不得当成预算耗尽快速失败', async ({ page }) => {
    test.setTimeout(30_000)
    const logs = captureProbeLogs()
    try {
      await gotoWorkbench(page, { readyTimeoutMs: 0 })
      expect(await page.evaluate(() => (window as any).__vm_ready__ === true)).toBe(true)
      await expect(page.locator('.wb-shell')).toBeVisible()
      expect(logs.logs, '显式 0ms 健康路径不得有 [boot-probe] 输出').toEqual([])
    } finally {
      logs.restore()
    }
  })

  /**
   * 负数是"立即超时"（实测 `Timeout -1ms exceeded`），不是 0 的"不设超时"，
   * 也不是本政策算出的"预算耗尽 0"。显式值原样转发，错误仍按 ready 失败包装。
   */
  test('显式负数：Playwright 立即超时，不得伪装成预算耗尽 0ms', async ({ page }) => {
    test.setTimeout(30_000)
    // 负载下 Playwright 的调度/页面装配可能让 wall time 变长，但"负数=立即超时"
    // 的判据是错误文本（Timeout -1ms）与 Playwright 行为，不是墙钟性能。
    const error = await gotoWorkbench(page, { readyTimeoutMs: -1 }).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(error, '负数必须立即失败（否则 Playwright 语义变了）').not.toBeNull()
    const message = error!.message
    expect(message, '必须保留 Playwright 的负数超时原文').toContain('Timeout -1ms exceeded')
    expect(message, '不得被当成"预算耗尽 0ms"').not.toContain('ready 等待预算为 0ms')
  })

  test('默认路径对照：headroom 让诊断在 test deadline 前拿到（不传 readyTimeoutMs、不延长 test timeout）', async ({ page }) => {
    // test timeout 10s ⇒ 有效 ready 预算 = max(1s, 10s − 30s) = 1s。
    // 若诊断只能活到"test deadline 到点"之后，这里拿到的会是 Test timeout / page closed。
    test.setTimeout(10_000)
    await abortModule(page, '**/src/workbench/WorkbenchRoot.vue*')
    const startedAt = Date.now()
    const error = await gotoWorkbench(page).then(
      () => null,
      (e: unknown) => e as Error,
    )
    const elapsed = Date.now() - startedAt

    expect(error, '启动必须失败（否则对照无效）').not.toBeNull()
    const message = error!.message

    // ① 失败是**原始 waitForFunction 超时**被包装 —— 不是 test deadline、也不是页面已关闭
    expect(message, '必须是 ready 等待的原始失败原文').toMatch(
      /page\.waitForFunction: Timeout \d+ms exceeded/,
    )
    expect(message, '不得是 test deadline 冒充').not.toMatch(/Test timeout of \d+ms exceeded/)
    expect(message, '不得是页面已关闭').not.toMatch(/Target page, context or browser has been closed/)
    // ② 诊断真的在（说明它进得了断言/报告，而不是随页面一起消失）
    expect(message, '诊断必须随原失败一起进报告').toContain('[boot-probe]')
    expect(message, '归因必须随诊断一起进报告').toContain('[attribution]')
    expect(message, '1s 预算下页面仍是活的：页面侧事实必须在').toMatch(/\[page\] readyState=/)
    // ③ 政策可测：10s test timeout ⇒ 有效预算 1s（远小于 deadline，为归因留出余量）
    const budget = Number(/预算 (\d+)ms/.exec(message)?.[1] ?? '-1')
    expect(budget, '有效预算 = max(1s, test timeout − 30s)').toBe(1_000)
    expect(message, '默认路径的头行必须写明 headroom 政策来源').toContain('为归因预留 30000ms')
    expect(elapsed, '必须在 test deadline 之前就带着诊断失败').toBeLessThan(10_000)
    // ④ 原错误原样保留为 cause（只多包一层，不改原文）
    const cause = (error as Error & { cause?: unknown }).cause
    expect(cause, '原错误对象必须保留为 cause').toBeInstanceOf(Error)
    expect((cause as Error).name, 'cause 必须是 Playwright 的 TimeoutError').toBe('TimeoutError')
    // 证据：默认路径的实际 elapsed 与有效预算
    console.log(`[默认路径对照] elapsed=${elapsed}ms effectiveBudget=${budget}ms`)
  })

  test('负对照①：模块请求失败 ⇒ 首次短超时即点名失败的模块请求（含 URL 与网络原因）', async ({ page }) => {
    test.setTimeout(60_000)
    await abortModule(page, '**/src/workbench/WorkbenchRoot.vue*')
    const error = await bootFailure(page, 2_000)
    expect(error, '模块请求被中止后启动必须失败（否则负对照无效）').not.toBeNull()
    const message = error!.message

    // ① 类别可区分：点名"模块/入口请求失败"，并带上具体 URL 与网络层原因
    expect(message, '诊断必须点名模块/入口请求失败').toContain('模块/入口请求失败')
    expect(message, '诊断必须带上失败的模块 URL').toContain('/src/workbench/WorkbenchRoot.vue')
    expect(message, '诊断必须带上网络层原因').toMatch(/net::ERR_FAILED/)
    // ② 页面侧事实在场（这一类的页面是"文档已 load 但 app 没起来"）
    expect(message, '必须有页面侧事实').toMatch(/\[page\] readyState=/)
    expect(message, '必须点出 __vm__ 缺席').toMatch(/__vm__=undefined/)
    expect(message, '必须点出 .wm-boot--err 无文本（区别于启动抛错类）').toContain('.wm-boot--err=<无>')
    // ②′ 假归因守卫：`[vite] connecting/connected` 健康启动必现，
    // 必须照录在**事件摘要**里，却**不得**被归因当成 reload 线索。
    expect(message, '事件摘要必须照录常规 [vite] 连接行').toContain('[vite] connecting')
    expect(message, '常规 [vite] 连接行不得被当成 reload 线索').not.toContain('Vite reload/断线提示')
    // ③ 原错误保留为 cause，且原文仍在消息里
    const cause = (error as Error & { cause?: unknown }).cause
    expect(cause, '原错误对象必须保留为 cause（诊断不替代原超时）').toBeInstanceOf(Error)
    expect(String((cause as Error).message), 'cause 必须是 ready 等待的原始错误').toMatch(
      /waitForFunction|Timeout/,
    )
    expect(message, '原错误原文必须在消息里').toMatch(/page\.waitForFunction|Timeout/)
    // ③′ 预算来源必须如实：显式预算不得冒充 headroom 政策
    expect(message, '显式预算必须在头行写明来源').toContain('预算 2000ms（显式指定）')
    expect(message, '显式预算不得宣称"为归因预留 30s"').not.toContain('为归因预留')
    // ④ 诊断有界（≤2KB）
    expect(
      Buffer.byteLength(diagnosticOf(message), 'utf8'),
      '诊断块必须 ≤2KB',
    ).toBeLessThanOrEqual(2048)
  })

  test('负对照②：reload 循环 ⇒ 诊断点名文档被反复替换（导航销毁期也给出部分诊断）', async ({ page }) => {
    test.setTimeout(60_000)
    // 自刷新文档：40ms 后 reload，无限重复（= dev server/HMR 卡在 full-reload 的形态）。
    const loopHtml =
      '<!doctype html><html><head><meta charset="utf-8"><title>boot-probe reload loop</title></head>' +
      '<body><div id="boot-probe-loop"></div>' +
      '<script>setTimeout(function () { location.reload() }, 40)</script></body></html>'
    await page.route(
      (url) => url.pathname === '/',
      (route: Route) => route.fulfill({ status: 200, contentType: 'text/html', body: loopHtml }),
    )
    const error = await bootFailure(page, 1_500)
    expect(error, 'reload 循环下启动必须失败（否则负对照无效）').not.toBeNull()
    const message = error!.message

    // ① 类别可区分：主文档提交数 > 1 ⇒ 点名"文档被反复替换"
    const commits = Number(/commits=(\d+)/.exec(message)?.[1] ?? '-1')
    expect(commits, '诊断必须带 main-frame commit 计数').toBeGreaterThanOrEqual(2)
    expect(message, '诊断必须点名文档被反复替换').toContain('文档被反复替换')
    // ② 进程侧事实必在（页面侧采集可能被导航打断 —— 那也必须只是"部分降级"，不是空诊断）
    expect(message, '进程侧导航事实必须总在').toMatch(/\[nav\] starts=\d+ commits=\d+/)
    expect(message, '事件摘要必须总在').toMatch(/\[events\] kept=\d+\/100/)
    const pageLine = message
      .split('\n')
      .find((line) => line.startsWith('[page] '))
    expect(pageLine, '页面侧要么给事实、要么明确降级（部分诊断）').toBeDefined()
  })

  test('负对照③：启动抛错 ⇒ 诊断点名错误边界文本（.wm-boot--err）', async ({ page }) => {
    test.setTimeout(60_000)
    // 走**真实** Vue 错误边界：把一个 setup 抛错的组件换到 WorkbenchRoot 的位置。
    await page.route('**/src/workbench/WorkbenchRoot.vue*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body:
          'export default { name: "FaultyWorkbenchRoot", ' +
          'setup() { throw new Error("负对照③：WorkbenchRoot 启动抛错") } }',
      }),
    )
    const error = await bootFailure(page, 2_000)
    expect(error, '启动抛错后必须失败（否则负对照无效）').not.toBeNull()
    const message = error!.message

    // ① 类别可区分：错误边界文本被点名，且原文被带出
    expect(message, '诊断必须点名错误边界捕获').toContain('启动期异常被错误边界捕获')
    expect(message, '必须带出 .wm-boot--err 文本').toMatch(/\[boot-err\] \.wm-boot--err="/)
    expect(message, '必须带出具体异常文本').toContain('负对照③：WorkbenchRoot 启动抛错')
    // ② 与模块请求失败类可区分（这一类不是网络失败）
    expect(message, '启动抛错类不得被误报成模块请求失败').not.toContain('模块/入口请求失败')
    // ③ 假归因守卫：常规 [vite] 连接行不得制造 reload/断线假归因
    expect(message, '不得把 [vite] connecting/connected 当成 reload 线索').not.toContain('Vite reload/断线提示')
    expect(message, '不得虚构 reload 循环').not.toContain('文档被反复替换')
  })

  test('探针有界：事件环形缓冲不超过 100 条，溢出如实记账', async ({ page }) => {
    test.setTimeout(60_000)
    await abortModule(page, '**/src/workbench/WorkbenchRoot.vue*')
    // 在页面加载完成后灌 150 条 console.error（远超过环形上限）：
    // 探针只保留最后 100 条，并如实记账被挤掉的条数。
    await page.addInitScript(() => {
      window.addEventListener('load', () => {
        setTimeout(() => {
          for (let i = 0; i < 150; i++) console.error('[负对照 ring] event-' + i)
        }, 50)
      })
    })
    const error = await bootFailure(page, 4_000)
    expect(error, '启动必须失败（否则负对照无效）').not.toBeNull()
    const message = error!.message

    expect(message, '环形缓冲必须停在 100 条').toMatch(/\[events\] kept=100\/100/)
    const dropped = Number(/dropped=(\d+)/.exec(message)?.[1] ?? '-1')
    expect(dropped, '溢出必须如实记账（150 条灌入 ⇒ 至少挤掉 50 条）').toBeGreaterThanOrEqual(50)
    // 有界不等于丢证据：最后一条必须还在（tail 保留语义）
    expect(message, '缓冲必须保留最新事件').toContain('[负对照 ring] event-149')
    expect(
      Buffer.byteLength(diagnosticOf(message), 'utf8'),
      '诊断块必须 ≤2KB（即便事件很多）',
    ).toBeLessThanOrEqual(2048)
  })

  test('诊断不二次死等：页面侧采集不返回时按 2s 预算降级为部分诊断', async ({ page }) => {
    test.setTimeout(60_000)
    await abortModule(page, '**/src/workbench/WorkbenchRoot.vue*')
    // 仪表：把页面侧采集打成**永不返回**（= 渲染进程冻结时的形态）。
    const anyPage = page as any
    const realEvaluate = anyPage.evaluate.bind(page)
    anyPage.evaluate = () => new Promise(() => {})
    try {
      const startedAt = Date.now()
      const error = await bootFailure(page, 1_200)
      const elapsed = Date.now() - startedAt
      expect(error, '启动必须失败（否则负对照无效）').not.toBeNull()
      const message = error!.message

      expect(message, '页面侧采集失败必须明确降级').toContain('页面侧事实不可用')
      expect(message, '降级原因必须点明预算（不二次死等）').toContain('页面侧采集超过 2000ms 未返回')
      // 总耗时 = ready 预算(1.2s) + 采集预算(2s) + 余量：诊断不得把测试拖成"又等一轮 90s"
      expect(elapsed, '诊断必须有界，不得二次死等').toBeLessThan(15_000)
      // 部分诊断仍可用：进程侧事实 + 归因（不依赖页面侧采集）
      expect(message, '进程侧导航事实必须仍在').toMatch(/\[nav\] starts=\d+ commits=\d+/)
      expect(message, '事件摘要必须仍在').toMatch(/\[events\] kept=\d+\/100/)
      expect(message, '归因不得依赖页面侧采集').toContain('模块/入口请求失败')
    } finally {
      anyPage.evaluate = realEvaluate
    }
  })

  test('诊断降级②：页面侧采集抛"导航销毁"错误时仍返回部分诊断（保留原因）', async ({ page }) => {
    test.setTimeout(60_000)
    await abortModule(page, '**/src/workbench/WorkbenchRoot.vue*')
    // 仪表：复刻 Playwright 在导航销毁执行上下文时的**真实**错误文案。
    const anyPage = page as any
    const realEvaluate = anyPage.evaluate.bind(page)
    anyPage.evaluate = async () => {
      throw new Error(
        'page.evaluate: Execution context was destroyed, most likely because of a navigation',
      )
    }
    try {
      const error = await bootFailure(page, 1_200)
      expect(error, '启动必须失败（否则负对照无效）').not.toBeNull()
      const message = error!.message

      expect(message, '降级必须点名页面侧事实不可用').toContain('页面侧事实不可用')
      expect(message, '必须保留采集失败的具体原因').toContain('Execution context was destroyed')
      expect(message, '进程侧事实与事件摘要必须仍在').toMatch(/\[nav\] starts=\d+ commits=\d+/)
      expect(message, '归因仍必须可用').toContain('[attribution]')
    } finally {
      anyPage.evaluate = realEvaluate
    }
  })

  /**
   * 晚调用棘轮（判据 1/2）。
   *
   * ## 为什么用受控时钟
   *
   * 要复现的形态是"90s 的用例已经跑了 ~88s，再第二次 goto"。真烧 88s 会让用例自己
   * 贴着 deadline，判据就变成"是否恰好没被杀"而不是"预算算得对不对"；故把 `Date.now`
   * 推进 88s（受控时钟）——**同一段预算算术、同一条失败路径**，但 wall time 只有秒级。
   * test timeout 仍是 90s，**没有**为这条对照改生产/测试配置。
   *
   * ## 判据（首次失败报告，不靠 retry）
   *
   *  - 分类（模块请求失败）与晚调用预算事实（`source=late` / `floor-broken=true` /
   *    `remaining-estimate≈1–2s`）同在一份报告里；
   *  - `wait` 只断言**安全关系**：`wait <= min(250ms, remaining-estimate)`（`remaining<500ms`
   *    时是 `max(0, remaining−250)`），精确 cap 由 unit 负责 —— full 负载下不赌 250 这个常数；
   *  - `[budget]` 必须带 `basis=anchor-estimate` / `actual-remaining=unknown`（估算不冒充事实）；
   *  - close 前 Node 兜底先写 **stderr**（页面若立刻关，分类仍在），且**只写一次**；
   *  - 不是 test deadline 冒充、不是页面关闭冒充；wall time 远小于 60s/90s。
   */
  test('晚调用棘轮：第二次 goto 按真实剩余快速失败，首报含分类与剩余预算事实', async ({ page }) => {
    test.setTimeout(90_000)
    // 第一次健康 goto：本测试的时钟锚点在此刻（harness 记录的是**首次进入**的时间）。
    await gotoWorkbench(page)
    const realNow = Date.now
    const logs = captureProbeLogs()
    try {
      // 受控时钟：已耗时 ≈ 88s ⇒ test 剩余 ≈ 1~2s（真实 test timeout 仍是 90s）。
      Date.now = () => realNow() + 88_000
      await abortModule(page, '**/src/workbench/WorkbenchRoot.vue*')
      const startedAt = realNow()
      const error = await gotoWorkbench(page).then(
        () => null,
        (e: unknown) => e as Error,
      )
      const elapsed = realNow() - startedAt

      expect(error, '模块被中止后第二次启动必须失败（否则负对照无效）').not.toBeNull()
      const message = error!.message

      // ① 晚调用预算事实：来源 / 估算剩余 / 压破 1s 下限 / 安全关系
      expect(message, '诊断必须带预算事实行').toContain('[budget]')
      expect(message, '必须点名晚调用来源').toMatch(/\[budget\] source=late /)
      expect(message, '必须报出压破 1s 下限').toContain('floor-broken=true')
      expect(message, '预算必须标成锚点估算').toContain('basis=anchor-estimate')
      expect(message, '实际剩余必须写 unknown，不得冒充').toContain('actual-remaining=unknown')
      expect(message, '必须报出剩余估算').toMatch(/ remaining-estimate=\d{1,4}ms /)
      const remaining = Number(/ remaining-estimate=(\d+)ms /.exec(message)?.[1] ?? '-1')
      const wait = Number(/ wait=(\d+)ms /.exec(message)?.[1] ?? '-1')
      expect(remaining, '受控时钟下剩余估算必须落在 0..4000ms').toBeGreaterThanOrEqual(0)
      expect(remaining).toBeLessThan(4_000)
      // 安全关系（精确 cap 由 unit 负责）：剩余 >=500ms 时 wait=min(250,剩余)；
      // 剩余 <500ms 时 wait=max(0,剩余−250)。full 负载下不赌 250 这个常数。
      const expectedWait =
        remaining >= 500 ? Math.min(250, remaining) : Math.max(0, remaining - 250)
      expect(wait, `wait=${wait} 必须等于安全关系 ${expectedWait}（remaining=${remaining}）`).toBe(
        expectedWait,
      )
      expect(wait).toBeLessThanOrEqual(250)
      // 证据：把首次失败报告里的两行结论打进日志（不靠失败时的完整堆栈才能看到）
      console.log(`[晚调用棘轮] budget: ${/\[budget\][^\n]*/.exec(message)?.[0] ?? '<missing>'}`)
      console.log(
        `[晚调用棘轮] attribution: ${/\[attribution\][^\n]*/.exec(message)?.[0] ?? '<missing>'}`,
      )
      // ② 分类仍可判：事件环 + 进程侧导航事实
      expect(message, '必须点名模块/入口请求失败').toContain('模块/入口请求失败')
      expect(message, '必须带上失败模块 URL').toContain('/src/workbench/WorkbenchRoot.vue')
      expect(message, '导航摘要必须总在').toMatch(/\[nav\] starts=\d+ commits=\d+/)
      expect(message, '归因必须总在').toContain('[attribution]')
      // ③ close 前 Node 兜底必须先写 stderr（页面若马上关，分类仍在），且只写一次
      const fallbackLines = logs.logs.filter((line) => line.includes('close 前 Node 兜底'))
      expect(fallbackLines, '晚调用必须先写一次 close 前 Node 兜底').toHaveLength(1)
      expect(
        logs.logs.filter((line) => line.includes('[boot-probe:close]')),
        '页面未关闭时不得出现 close 兜底（去重边界）',
      ).toHaveLength(0)
      const fallback = fallbackLines[0]!
      expect(fallback, '兜底里必须有分类').toContain('[attribution]')
      expect(fallback, '兜底里必须有导航事实').toMatch(/\[nav\] starts=\d+ commits=\d+/)
      expect(fallback, '兜底里必须有预算事实').toContain('[budget]')
      expect(fallback, '兜底预算也必须标估算/unknown').toContain('basis=anchor-estimate')
      // 顺序：兜底先于首败 message 的 stderr 副本。
      const fallbackAt = logs.logs.indexOf(fallback)
      const wrappedAt = logs.logs.findIndex((line) => line.startsWith('gotoWorkbench：'))
      expect(wrappedAt, '首败 message 也应写一次 stderr').toBeGreaterThanOrEqual(0)
      expect(fallbackAt, 'Node 兜底必须早于首败 message').toBeLessThan(wrappedAt)
      // ④ 不是 deadline / 页面关闭冒充，也不靠等满真实预算
      expect(message, '不得是 test deadline 冒充').not.toMatch(/Test timeout of \d+ms exceeded/)
      expect(message, '不得是页面已关闭').not.toMatch(/Target page, context or browser has been closed/)
      expect(elapsed, '晚调用必须有界快速失败（不等 60s/90s）').toBeLessThan(10_000)
      const cause = (error as Error & { cause?: unknown }).cause
      expect(cause, '原错误必须保留为 cause').toBeInstanceOf(Error)
      console.log(`[晚调用棘轮] elapsed=${elapsed}ms remaining=${remaining}ms`)
    } finally {
      Date.now = realNow
      logs.restore()
    }
  })

  /**
   * 健康晚调用。
   *
   * ## 动态受控时钟（隔离真实页面加载耗时）
   *
   * 首次 goto 前取 `anchorAt`（harness 的锚点就在这次调用入口，误差为微秒级），
   * 实测 `firstGotoMs` 后算出"已耗时 87_000ms"对应的时钟值，并在第二次 goto
   * **及其 ready 等待期间冻结 Date.now** ⇒ entry remaining-estimate 稳定 ≈3000ms，
   * 不受第二次 goto 真实耗时影响。Playwright 自身的 monotonic timeout 不变；
   * 真实 deadline 由独立 deadline runner 覆盖（本测试只验证预算政策）。
   * finally 恢复 Date.now，避免串测试。
   *
   * ## 第二次导航的可控事实
   *
   * 旧版在 `/` 上延迟 4.2s。这段延迟发生在**新文档 commit 之前**：窗口里旧文档的
   * `__vm_ready__` 仍为 true。本用例不声称该形态复现了原 full 失败；只把可控事实限定为
   * “新文档 commit/load 完成后再进入 250ms 预算”。
   *
   * 现在不再延迟主文档：先让新文档正常 commit，再延迟真实入口模块 WorkbenchRoot.vue 1.2s。
   * 静态模块图在 load 前执行，`WorkbenchRoot` 的 setup 同步写 `__vm_ready__`；因此
   * `page.goto` 返回时新文档已 ready，250ms 只用于观测 late 预算。旧文档身份由下一条负对照
   * 单独守住（起点旧文档 ready + 新文档诊断事实）。
   *
   * ## 判据（不做墙钟性能断言）
   *
   *  - entry remaining-estimate 落在 (2000, 3200)ms（确实 late）；
   *  - `waitForFunction` 收到的 timeout `>0 且 <=250ms`（正常下限 1s ⇒ 证明确实走 late）；
   *  - ready 成功、零 `[boot-probe]` / console.error。
   */
  test('健康晚调用：冻结受控时钟稳定 ~3s 剩余，确实走 late 且通过', async ({ page }) => {
    test.setTimeout(90_000)
    const realNow = Date.now
    const anchorAt = realNow()
    await gotoWorkbench(page)
    const firstGotoMs = realNow() - anchorAt
    // 先让新文档正常 commit，再延迟真实入口模块：静态模块图在 load 前执行，
    // WorkbenchRoot setup 同步写 __vm_ready__，所以 page.goto 返回时新文档已 ready，
    // 250ms late 等待只观测预算，不承担启动耗时。
    const delayedModule = '/src/workbench/WorkbenchRoot.vue'
    let delayedModuleHits = 0
    await page.route(
      (url) => url.pathname === delayedModule && !url.searchParams.has('vue'),
      async (route) => {
        delayedModuleHits += 1
        await new Promise((resolve) => setTimeout(resolve, 1_200))
        await route.continue()
      },
    )
    const logs = captureProbeLogs()
    const anyPage = page as any
    const realWaitForFunction = anyPage.waitForFunction
    let observedTimeout = -1
    try {
      // 冻结在"已耗时 87s"的时刻：第二次 goto 真实再慢，剩余估算也不会被吃掉。
      const targetElapsedMs = 87_000
      const frozenNow = realNow() + (targetElapsedMs - firstGotoMs)
      Date.now = () => frozenNow
      const entryRemainingEstimate = 90_000 - (Date.now() - anchorAt)
      expect(entryRemainingEstimate, '动态剩余估算必须落在 late 区间（不得误入 headroom）').toBeGreaterThan(2_000)
      expect(entryRemainingEstimate).toBeLessThan(3_200)
      // 可观察预算：ready 等待传给 waitForFunction 的 timeout。
      anyPage.waitForFunction = (fn: unknown, arg: unknown, opts?: { timeout?: number }) => {
        if (typeof opts?.timeout === 'number') observedTimeout = opts.timeout
        return realWaitForFunction.call(page, fn, arg, opts)
      }
      const startedAt = realNow()
      await gotoWorkbench(page)
      const elapsed = realNow() - startedAt
      expect(
        delayedModuleHits,
        `必须真实命中并延迟入口模块 ${delayedModule}（否则本对照没有压到模块速度）`,
      ).toBeGreaterThanOrEqual(1)
      expect(observedTimeout, 'ready 等待必须实际用了 late 宽限').toBeGreaterThan(0)
      expect(observedTimeout, '晚调用 wait 不得超过 250ms').toBeLessThanOrEqual(250)
      expect(observedTimeout, '正常下限是 1000ms；<=250 证明走的是 late').toBeLessThan(1_000)
      expect(await page.evaluate(() => (window as any).__vm_ready__ === true)).toBe(true)
      await expect(page.locator('.wb-shell')).toBeVisible()
      expect(logs.logs, '健康晚调用不得有 [boot-probe] / console.error 输出').toEqual([])
      console.log(
        `[健康晚调用] firstGoto=${firstGotoMs}ms entryRemainingEstimate=${entryRemainingEstimate}ms ` +
          `waitBudget=${observedTimeout}ms delayedModuleHits=${delayedModuleHits} ` +
          `realSecondGoto=${elapsed}ms（仅记录，不作性能判据）`,
      )
    } finally {
      anyPage.waitForFunction = realWaitForFunction
      Date.now = realNow
      logs.restore()
    }
  })

  /**
   * 健康晚调用的**负对照**（新文档身份守卫）。
   *
   * 与上一条用**同一**受控晚时钟（已耗时 87s ⇒ 剩余 ≈3s、wait=250ms）和同一真实入口，
   * 只把 `WorkbenchRoot.vue` 的请求中止。起点显式断言旧文档 ready；中止后新文档不可能
   * ready。本用例不声称原 full 失败已复现：它要求失败必须发生，且诊断页面事实来自新文档
   * （`__vm_ready__=undefined` / `.wb-shell=absent`），从而排除“拿旧文档 ready 当新文档
   * 证据”的假绿。
   *
   * 判据：失败（非假绿）、wait=250ms、`source=late`、点名模块请求失败，
   * 且诊断页面事实来自新文档（`__vm_ready__=undefined` / `.wb-shell=absent`）。
   */
  test('健康晚调用负对照：旧文档 ready + 入口模块中止 ⇒ 250ms 必须失败而非假绿', async ({ page }) => {
    test.setTimeout(90_000)
    const realNow = Date.now
    const anchorAt = realNow()
    await gotoWorkbench(page)
    const firstGotoMs = realNow() - anchorAt
    // 先钉住"旧文档 ready"这个前提：没有它，本负对照抓不到"拿旧文档冒充"的假绿。
    expect(
      await page.evaluate(() => (window as any).__vm_ready__ === true),
      '负对照起点：调用前旧文档必须真实 ready',
    ).toBe(true)
    const logs = captureProbeLogs()
    const anyPage = page as any
    const realWaitForFunction = anyPage.waitForFunction
    let observedTimeout = -1
    try {
      const frozenNow = realNow() + (87_000 - firstGotoMs)
      Date.now = () => frozenNow
      await abortModule(page, '**/src/workbench/WorkbenchRoot.vue*')
      anyPage.waitForFunction = (fn: unknown, arg: unknown, opts?: { timeout?: number }) => {
        if (typeof opts?.timeout === 'number') observedTimeout = opts.timeout
        return realWaitForFunction.call(page, fn, arg, opts)
      }
      const startedAt = realNow()
      const error = await gotoWorkbench(page).then(
        () => null,
        (e: unknown) => e as Error,
      )
      const elapsed = realNow() - startedAt
      expect(error, '入口模块中止后晚调用必须失败（旧文档 ready 不得冒充新文档）').not.toBeNull()
      const message = error!.message
      expect(observedTimeout, '同一受控晚时钟下 wait 必须是 250ms').toBe(250)
      expect(message, '首败必须是 250ms 的晚调用等待').toContain('250ms 内 __vm_ready__ 未就绪')
      expect(message, '预算来源必须如实').toMatch(/\[budget\] source=late /)
      expect(message, '分类必须点名模块请求失败').toContain('模块/入口请求失败')
      expect(message, '分类必须带上失败模块 URL').toContain('/src/workbench/WorkbenchRoot.vue')
      // 页面事实必须来自**新文档**：旧文档 ready 时这两个值会分别是 true/present。
      expect(message, '诊断不得拿旧文档的 ready 冒充新文档').toContain('__vm_ready__=undefined')
      expect(message, '新文档的壳不得在场').toContain('.wb-shell=absent')
      expect(elapsed, '失败必须有界（不靠等满 90s）').toBeLessThan(10_000)
      console.log('[健康晚调用负对照] elapsed=' + elapsed + 'ms wait=' + observedTimeout + 'ms（旧文档 ready，新文档模块中止）')
    } finally {
      anyPage.waitForFunction = realWaitForFunction
      Date.now = realNow
      logs.restore()
    }
  })

  /**
   * late 预打印 + close 去重。
   *
   * 构造：受控时钟走 late → route 中止模块 → 失败前先写一条 `close 前 Node 兜底`；
   * 随后页面采集挂起，`page.evaluate` 被调用的瞬间安排 100ms 后关页 ⇒ close 事件一定
   * 落在"预打印之后、诊断采集期间"。判据：运行输出**恰好一条**预打印兜底，
   * **零条** `[boot-probe:close]`（close 监听必须被 fallbackEmitted 去重），首败 message
   * 仍是完整诊断。
   */
  test('去重：late 预打印后页面在诊断采集中关闭，只留一条 Node 兜底', async ({ page }) => {
    test.setTimeout(90_000)
    await gotoWorkbench(page)
    const realNow = Date.now
    const logs = captureProbeLogs()
    const anyPage = page as any
    const realEvaluate = anyPage.evaluate
    let closed = false
    let resolveCloser!: () => void
    const closer = new Promise<void>((resolve) => {
      resolveCloser = resolve
    })
    const closePage = (): void => {
      if (closed) return
      closed = true
      void page.close().then(
        () => resolveCloser(),
        () => resolveCloser(),
      )
    }
    const fallbackTimer = setTimeout(closePage, 4_000)
    try {
      Date.now = () => realNow() + 86_900
      await abortModule(page, '**/src/workbench/WorkbenchRoot.vue*')
      // 页面侧采集一被调用就安排关页 + 永不返回：close 必然在 late 预打印之后。
      anyPage.evaluate = () => {
        setTimeout(closePage, 100)
        return new Promise(() => {})
      }
      const error = await gotoWorkbench(page).then(
        () => null,
        (e: unknown) => e as Error,
      )
      await closer

      expect(error, '启动必须失败（否则对照无效）').not.toBeNull()
      const fallbackLines = logs.logs.filter((line) => line.includes('close 前 Node 兜底'))
      expect(fallbackLines, '晚调用预打印必须恰好一条').toHaveLength(1)
      expect(
        logs.logs.filter((line) => line.includes('[boot-probe:close]')),
        'close 监听不得在预打印后再写一条（去重失败）',
      ).toHaveLength(0)
      const message = error!.message
      expect(message, '首败 message 必须仍带完整诊断').toContain('[boot-probe]')
      expect(message, '页面侧采集被挂起 ⇒ 必须降级').toContain('页面侧事实不可用')
      const fallbackAt = logs.logs.indexOf(fallbackLines[0]!)
      const wrappedAt = logs.logs.findIndex((line) => line.startsWith('gotoWorkbench：'))
      expect(wrappedAt).toBeGreaterThanOrEqual(0)
      expect(fallbackAt).toBeLessThan(wrappedAt)
      console.log('[late+close 去重] fallback=1 close=0')
    } finally {
      clearTimeout(fallbackTimer)
      anyPage.evaluate = realEvaluate
      Date.now = realNow
      await closer.catch(() => undefined)
      logs.restore()
    }
  })

  /**
   * 关页兜底（headroom 源，与 late 无关）。
   *
   * 关页时点由 **ready 等待真正开始（page.waitForFunction 调用）+100ms** 决定：
   * 不依赖 load 事件、也不依赖固定 timer；模块被中止 ⇒ ready 永不成功，close 必在
   * pending 窗口内。默认 10s timeout ⇒ wait 1s、source=headroom ⇒ 证明 close 兜底与
   * 预算来源无关。
   */
  test('关页兜底：headroom 源启动 pending 期间真实关页仍写 Node 事实', async ({ page }) => {
    test.setTimeout(10_000)
    await abortModule(page, '**/src/workbench/WorkbenchRoot.vue*')
    const logs = captureProbeLogs()
    const anyPage = page as any
    const realWaitForFunction = anyPage.waitForFunction
    let closed = false
    let resolveCloser!: () => void
    const closer = new Promise<void>((resolve) => {
      resolveCloser = resolve
    })
    const closePage = (): void => {
      if (closed) return
      closed = true
      void page.close().then(
        () => resolveCloser(),
        () => resolveCloser(),
      )
    }
    const fallbackTimer = setTimeout(closePage, 3_000)
    anyPage.waitForFunction = (fn: unknown, arg: unknown, opts?: { timeout?: number }) => {
      anyPage.waitForFunction = realWaitForFunction
      setTimeout(closePage, 100)
      return realWaitForFunction.call(page, fn, arg, opts)
    }
    try {
      const startedAt = Date.now()
      const error = await gotoWorkbench(page).then(
        () => null,
        (e: unknown) => e as Error,
      )
      const elapsed = Date.now() - startedAt
      await closer

      expect(error, '页面被关闭后启动必须失败（否则负对照无效）').not.toBeNull()
      const message = error!.message

      // ① 默认路径来源必须是 headroom（不是 late）⇒ close 兜底与 source 无关
      expect(message, '默认路径来源必须是 headroom').toMatch(/\[budget\] source=headroom /)
      expect(message, '必须仍产出 boot-probe 诊断').toContain('[boot-probe]')
      expect(message, '页面侧采集失败必须明确降级').toContain('页面侧事实不可用')
      // ② Node 侧已有事实必须可输出
      expect(message, '导航摘要必须总在').toMatch(/\[nav\] starts=\d+ commits=\d+/)
      expect(message, '事件摘要必须总在').toMatch(/\[events\] kept=\d+\/100/)
      expect(message, '分类必须总在').toContain('[attribution]')
      expect(message, '预算事实必须总在').toContain('[budget]')
      // ③ close 监听先写一条 [boot-probe:close] stderr 事实（只一次、不 evaluate）
      const closeLines = logs.logs.filter((line) => line.includes('[boot-probe:close]'))
      expect(closeLines, 'close 兜底必须写一次（stderr）').toHaveLength(1)
      expect(closeLines[0], 'close 兜底必须是 close 语义（不是 goto 失败）').toContain(
        '页面在启动 pending 期间被关闭',
      )
      expect(closeLines[0], 'close 兜底必须有分类').toContain('[attribution]')
      expect(closeLines[0], 'close 兜底必须有导航事实').toMatch(/\[nav\] starts=\d+ commits=\d+/)
      expect(closeLines[0], 'close 兜底必须有预算事实').toContain('[budget]')
      expect(closeLines[0], 'close 兜底预算必须是估算').toContain('basis=anchor-estimate')
      expect(closeLines[0], 'close 兜底实际剩余必须 unknown').toContain('actual-remaining=unknown')
      expect(closeLines[0], 'close 兜底不得尝试页面采集').not.toContain('[page] readyState=')
      // ④ 页面被关必须立即结束期望（不等满预算）；原错误保留
      expect(elapsed, '页面关闭必须立即结束等待').toBeLessThan(5_000)
      const cause = (error as Error & { cause?: unknown }).cause
      expect(cause, '原错误必须保留为 cause').toBeInstanceOf(Error)
      expect(String((cause as Error).message), 'cause 必须是页面关闭原文').toMatch(
        /Target page, context or browser has been closed|Target closed/,
      )
      console.log(`[关页兜底] elapsed=${elapsed}ms source=headroom`)
    } finally {
      clearTimeout(fallbackTimer)
      anyPage.waitForFunction = realWaitForFunction
      await closer.catch(() => undefined)
      logs.restore()
    }
  })
})
