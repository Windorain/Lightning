/**
 * 回归守卫：harness 注入的**导航竞态**。
 *
 * ## 为什么需要这个 spec（而不是只依赖线上偶发）
 *
 * 原始现象是**间歇性**的：只在全量套件、负载较大时出现（已 4 次），
 * 单跑 `parts-hover-stats.spec.ts` 不复现，且每次都重试通过。
 * 一个只靠"等它偶发"的修复无法被验收 —— 无法区分"修好了"与"这轮没抽到"。
 *
 * 故本 spec 把**竞态本身**变成可确定触发的输入：在页面里安排一次真实导航
 * （`location.reload()` —— 即 dev server 侧 HMR `full-reload` 或
 * `vite:ws:disconnect` 时 Vite 客户端 `vite/dist/client/client.mjs` 所做的事），
 * 让它与注入/evaluate 的**执行窗口重叠**，然后断言 harness 仍然交付正确结果。
 *
 * ## 四条判据（分别覆盖修复的四半）
 *
 *  - **A（就绪门）**：注入窗口内发生导航 ⇒ 仍在**正确的新文档**上完成注入并断言
 *    `docLoaded`。证明"注入前等到 load + app 就绪"这一半有效。
 *  - **B（重试路径 + 原子快照）**：把导航安排在 evaluate 执行**正中**（被求值函数
 *    sleep 500ms，导航在 150ms 时发生）⇒ `evaluateNavigable` 必须接住
 *    `Execution context was destroyed` 并在新文档上重试成功。
 *    **A 单独存在时，重试路径从未被走到** —— 那样"重试能不能用"就没有证据，
 *    故 B 不是冗余：它专门压重试分支。
 *    结果是一个**同一快照** `{ value, ready, origin }`：`ready` 与 `origin` 不再靠
 *    事后另开裸探针读取（那既在保护圈外，也不判文档身份），而是与 `value` **同一次
 *    求值**返回；`origin=false`（旧文档标记不在场）证明快照来自新文档。
 *  - **C（start 已计数、commit 未发生 ⇒ 内层接受判据）**：确定性复现"只数 commit"
 *    的盲区 —— `page.route` 只扣住 reload 的**主文档**响应 1200ms（> evaluate 的
 *    500ms），reload 在求值正中发起。修复前该窗口内 start 已 +1、commit 仍为 0，
 *    旧实现会**采信旧文档的结果**（origin=true）；修复后要求 starts/commits 双不变
 *    **且**无在途导航，旧结果被拒绝，有界等待提交后在新文档重试
 *    （origin=false / ready=true）。`page.exposeFunction` 计数证明至少求值两次
 *    （旧文档一次 + 新文档一次），不是绕过导航。
 *  - **D（慢主文档 ⇒ 外层重做接线）**：同一份慢 reload 输入，但走**真实注入复合步骤**
 *    `injectSceneDocumentOk`（内层 evaluate 固定 `attempts: 1`）。注入结束后才发起
 *    reload，响应扣住 3000ms ⇒ 内层返回的旧文档结果被拒；外层重做前必须复用与
 *    `evaluateNavigable` **同一个**落定等待，等到 commit 后才在新文档完成注入。
 *    判据：注入成功、首条 `OPERATOR_OPEN_SCENE` 的 `commits=0`、末条 `commits>0`、
 *    外层落定等待的返回快照 `commits>0`（等待真的走完，不只是被调用）。
 *    （C 只压内层接受判据；D 不是同义重述，它专门压内外两层的**接线**。）
 *
 * ## 证伪记录（先证红）
 *
 * 未修复前（`page.evaluate` 直调），同一 A 场景实测稳定复现：
 * `page.evaluate: Execution context was destroyed, most likely because of a navigation.`
 * 修复后 A/B 均绿。
 *
 * C 的确定性红（只加 start 计数、未改接受判据时实测）：
 * `origin` 收到 **true**（旧文档被采信）、`evaluations=1`；
 * 修复后同输入绿：`origin=false`、`ready=true`、`evaluations=2`。
 *
 * D 的确定性红（外层重做未接落定等待时实测）：外层落定等待计数为 **0**，接线判据
 * 判红（不是注入失败 —— Chromium 会把 pending 下的新 evaluate 隐式串行到 commit）；
 * 接线后同输入绿：等待返回快照 `commits>0`、末条 `commits>0`、注入成功。
 */
import { expect, test, type Route } from '@playwright/test'
import {
  evaluateNavigable,
  gotoWorkbench,
  injectSceneDocumentOk,
  navEpochOf,
  navStartEpochOf,
} from './helpers/multiblock/harness'
import { readPartsFixture } from './helpers/parts/fixtures'

test.describe('注入导航竞态（导航落在注入/evaluate 窗口内）', () => {
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

    // reload **之前**写旧文档标记；新文档里不存在。
    // 这样 value / ready / origin 可以在同一次求值里自洽地判"结果出自哪份文档"。
    await page.evaluate(() => {
      ;(window as any).__nav_race_old_doc__ = 'old-doc'
    })
    // 150ms 后导航；被求值函数执行 500ms ⇒ 导航必然落在 evaluate 窗口正中，
    // 于是**必然**走到 `isNavigationDestroyedError` 的那条重试分支。
    await page.evaluate(() => {
      setTimeout(() => location.reload(), 150)
    })
    const snapshot = await evaluateNavigable(
      page,
      async () => {
        await new Promise((res) => setTimeout(res, 500))
        return {
          value: 'recovered',
          ready: (window as any).__vm_ready__ === true,
          origin: (window as any).__nav_race_old_doc__ === 'old-doc',
        }
      },
      null,
    )
    // 判据全部来自**同一快照**：不再事后另开裸探针（那既在保护圈外，也不判文档身份）。
    expect(snapshot.value, '被导航打断的 evaluate 必须在新文档上重试成功').toBe('recovered')
    expect(snapshot.ready, '重试后必须在新文档上重新等到 app 就绪').toBe(true)
    expect(snapshot.origin, '同一快照必须来自新文档：旧文档标记不得在场').toBe(false)
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

  test('C：start 已计数、commit 未发生 ⇒ 旧文档结果不得被采信（有界等待提交后在新文档重试）', async ({ page }) => {
    test.setTimeout(180_000)
    await gotoWorkbench(page)

    // ① Node 侧探针（记录每次求值**进入/返回**时刻的 start/commit）：
    //    · 至少两条进入记录 ⇒ 真的走了重试，而不是绕过导航；
    //    · 第一次返回时 start 已 +1、commit 仍为 0 ⇒ "start 未 commit"是**实测前提**，
    //      不是靠时长推断；第二次进入时 commit 已 +1 ⇒ 重试发生在新文档提交之后。
    const evalStarts: Array<{ starts: number; commits: number }> = []
    const evalEnds: Array<{ starts: number; commits: number }> = []
    let evaluations = 0
    await page.exposeFunction('__e2e_nav_eval_probe__', () => {
      evaluations += 1
      evalStarts.push({ starts: navStartEpochOf(page), commits: navEpochOf(page) })
    })
    await page.exposeFunction('__e2e_nav_eval_end_probe__', () => {
      evalEnds.push({ starts: navStartEpochOf(page), commits: navEpochOf(page) })
    })

    // ② 旧文档标记：reload 前写入；新文档里不存在。
    //    ⇒ 同一快照里的 origin 能回答"这次结果出自哪份文档"，且第二次求值不会
    //    再触发 reload（只有旧文档带这个标记）。
    await page.evaluate(() => {
      ;(window as any).__nav_race_old_doc__ = 'old-doc'
    })

    // ③ 计数器是惰性注册的：在**触发导航之前**先读一次，否则本次 reload 的
    //    request(start) 事件没有监听器可投递。
    navStartEpochOf(page)

    // ④ 只扣住 reload 的**主文档**响应：谓词只匹配当前文档 URL，
    //    其它资源请求根本不进这个 handler（不改变它们的时序）。
    const docUrl = new URL(page.url())
    const isDocumentUrl = (url: URL) => url.origin === docUrl.origin && url.pathname === docUrl.pathname
    let documentHeld = false
    const handler = async (route: Route) => {
      try {
        if (route.request().isNavigationRequest() && route.request().frame() === page.mainFrame()) {
          documentHeld = true
          // 扣住 1200ms > evaluate 的 500ms ⇒ 求值窗口内只有 start、没有 commit。
          await new Promise((res) => setTimeout(res, 1200))
        }
        await route.continue()
      } catch {
        // 判据失败后页面被测试收尾关闭时，路由已不可再处理；主判据不依赖这里，
        // 让它保持静默，避免用二次噪声掩盖真正的断言。
      }
    }
    await page.route(isDocumentUrl, handler)
    try {
      // ⑤ 真实 reload 在 evaluate 执行**正中**发起（100ms），响应被扣住 1200ms；
      //    evaluate 500ms 后仍返回旧文档的结果 —— 这正是旧实现会采信的形态。
      const snapshot = await evaluateNavigable(
        page,
        async () => {
          await (window as any).__e2e_nav_eval_probe__()
          if ((window as any).__nav_race_old_doc__ === 'old-doc') {
            setTimeout(() => location.reload(), 100)
          }
          await new Promise((res) => setTimeout(res, 500))
          ;(window as any).__e2e_nav_eval_end_probe__()
          return {
            value: 'recovered',
            ready: (window as any).__vm_ready__ === true,
            origin: (window as any).__nav_race_old_doc__ === 'old-doc',
          }
        },
        null,
      )

      // ⑥ 前提判据（不成立就必须判红，而不是退化成"没有竞态"的空转绿）：
      //    扣留真的生效、首次求值返回时 start 已计数且 commit 未发生。
      expect(documentHeld, '前提：reload 的主文档响应必须真的被扣住').toBe(true)
      expect(evalEnds.length, '前提：首次求值必须真的返回过').toBeGreaterThanOrEqual(1)
      expect(
        evalEnds[0]!.starts,
        '前提：求值窗口内必须已有 main-frame 导航 request（start 已计数）',
      ).toBeGreaterThan(evalEnds[0]!.commits)
      expect(evalEnds[0]!.commits, '前提：求值返回时 reload 尚未 commit').toBe(0)

      // ⑦ 判据：同一个快照同时回答 value / ready / origin，不允许事后另开裸探针。
      expect(snapshot.value, '被导航打断的 evaluate 必须在新文档上重试成功').toBe('recovered')
      expect(snapshot.ready, '重试后必须在新文档上重新等到 app 就绪').toBe(true)
      expect(snapshot.origin, '结果必须来自新文档：旧文档标记不得在场').toBe(false)

      // ⑧ 重试路径的证据：至少两次进入；第二次在 commit 之后、且最终 start=commit=1。
      expect(evaluations, '必须真的走了重试：求值至少两次（旧文档一次 + 新文档一次）').toBeGreaterThanOrEqual(2)
      expect(evalStarts[1]!.commits, '第二次求值必须在 reload 已提交之后开始').toBeGreaterThan(0)
      expect(navEpochOf(page), '本次只应发生一次导航提交').toBe(1)
      expect(navStartEpochOf(page), '本次只应发生一次导航发起').toBe(1)
    } finally {
      await page.unroute(isDocumentUrl, handler)
    }
  })

  test('D：慢 reload 主文档 + 真实注入复合步骤 ⇒ 外层重做必须等 commit 后再注入成功', async ({ page }) => {
    test.setTimeout(180_000)
    await gotoWorkbench(page)

    // ① 每次真正执行 OPERATOR_OPEN_SCENE 时记录 start/commit 快照（Node 侧）。
    //    首条应为 commit=0（旧文档），末条应为 commit>0（新文档提交后的重做）。
    //    不假设"第二条恰是第二轮"：仪表必须幂等，条目数可能 ≥2。
    const injectStarts: Array<{ starts: number; commits: number }> = []
    let reloadTriggered = false
    await page.exposeFunction('__e2e_nav_inject_probe__', (name: string) => {
      // 只统计真实注入算子；应用启动期其它 exec 不算。
      if (name !== 'OPERATOR_OPEN_SCENE') return false
      injectStarts.push({ starts: navStartEpochOf(page), commits: navEpochOf(page) })
      // 只让**第一次**注入触发 reload（新文档那次返回 false，不再导航）。
      if (reloadTriggered) return false
      reloadTriggered = true
      return true
    })

    // 在每次真实注入 exec **返回后**记录探针：注入本体先完成，再让 reload 与
    // **求值返回**重叠（请求 start、响应扣住）⇒ 内层返回的旧文档结果在 post-check 被拒，
    // 外层必须重做。OPERATOR_OPEN_SCENE 仍由真实实现执行，探针不改变注入路径。
    // 同一函数既装到当前文档，也通过 addInitScript 装到 reload 后的新文档（只记录、不再导航）。
    const installInjectProbe = () => {
      const w = window as any
      // 每个 document 一份：ops 对象用 WeakSet 去重，防止 getOperators() 每次调用
      // 都重新包 exec（否则仪表叠加，同一注入会被记录多次）。
      const wrappedOps = new WeakSet<object>()
      const wrap = (): boolean => {
        const ctx = w.__vm__
        if (!ctx || typeof ctx.getOperators !== 'function') return false
        if (ctx.getOperators.__e2eWrapped === true) return true
        const realGetOperators = ctx.getOperators.bind(ctx)
        const wrapper = () => {
          const ops = realGetOperators()
          if (wrappedOps.has(ops)) return ops
          wrappedOps.add(ops)
          const realExec = ops.exec.bind(ops)
          ops.exec = async (name: string, args: unknown) => {
            const result = await realExec(name, args)
            // 注入本体先完成，再让 reload 与 **求值返回** 重叠：请求已 start、
            // 响应被扣住 ⇒ 内层返回的旧文档结果会在 post-check 被拒，且此时尚未 commit。
            const trigger = await w.__e2e_nav_inject_probe__(name)
            if (trigger === true) {
              setTimeout(() => location.reload(), 0)
              await new Promise((res) => setTimeout(res, 0))
            }
            return result
          }
          return ops
        }
        ;(wrapper as any).__e2eWrapped = true
        ctx.getOperators = wrapper
        return true
      }
      if (!wrap()) {
        const id = setInterval(() => {
          if (wrap()) clearInterval(id)
        }, 0)
      }
    }
    await page.addInitScript(installInjectProbe)
    await page.evaluate(installInjectProbe)

    // ② 旧文档标记：reload 前写入；新文档里不存在。
    await page.evaluate(() => {
      ;(window as any).__nav_race_old_doc__ = 'old-doc'
    })
    // ③ 惰性注册：在触发导航前先读一次。
    navStartEpochOf(page)

    // ④ 只扣住 reload 的**主文档**响应 3000ms：注入复合步骤（数百 ms）必然先返回旧文档结果，
    //    而 commit 要等到扣留结束 —— 这正是外层重做必须等落定的场景。
    const docUrl = new URL(page.url())
    const isDocumentUrl = (url: URL) => url.origin === docUrl.origin && url.pathname === docUrl.pathname
    let documentHeld = false
    const handler = async (route: Route) => {
      try {
        if (route.request().isNavigationRequest() && route.request().frame() === page.mainFrame()) {
          documentHeld = true
          await new Promise((res) => setTimeout(res, 3000))
        }
        await route.continue()
      } catch {
        // 判据失败后测试收尾关闭页面时路由已不可处理；主判据不依赖这里。
      }
    }
    await page.route(isDocumentUrl, handler)
    try {
      const fixture = readPartsFixture('parts-singlebox-mix.v2.json')
      // 显式 attempts: 2：把外层重做预算收到最小，要求**一次有效重做**即成功。
      // 这里不靠"失败形态"判别 —— 实测 Chromium 会把 pending 导航下的新 evaluate
      // 隐式串行到 commit，缺等待时注入仍可能成功；判红靠下面的落定探针
      //（缺接线 ⇒ retrySettles.length=0），不是注入失败。
      const retrySettles: Array<{ starts: number; commits: number }> = []
      const result = await injectSceneDocumentOk(page, fixture, 'nav-race-d.json', {
        attempts: 2,
        onRetrySettle: (after) => {
          retrySettles.push({ starts: after.starts, commits: after.commits })
        },
      })

      // ⑥ 判据：注入仍成功，且重做发生在新文档提交之后（不是旧文档原地重试）。
      expect(documentHeld, '前提：reload 主文档响应必须真的被扣住').toBe(true)
      expect(result.docLoaded, '场景注入必须成功').toBe(true)
      expect(injectStarts.length, '必须真的重做整步注入（至少两次 OPERATOR_OPEN_SCENE）').toBeGreaterThanOrEqual(2)
      expect(injectStarts[0]!.commits, '首条注入必须在 reload 提交前（旧文档）').toBe(0)
      const lastInject = injectStarts[injectStarts.length - 1]!
      expect(lastInject.commits, '末条注入必须在 reload 已提交之后（新文档）').toBeGreaterThan(0)
      expect(
        retrySettles.length,
        '外层重做前必须执行与 evaluateNavigable 同一个落定等待（不得复制第二套/跳过）',
      ).toBeGreaterThanOrEqual(1)
      expect(retrySettles[0]!.commits, '外层落定等待返回时必须已经 commit').toBeGreaterThan(0)
      expect(navEpochOf(page), '本次只应发生一次导航提交').toBe(1)
      expect(navStartEpochOf(page), '本次只应发生一次导航发起').toBe(1)

      // ⑦ 原子快照复核：文档在场，且来自新文档（旧标记不在场）。
      const snap = await evaluateNavigable(
        page,
        () => ({
          docLoaded: (window as any).__vm__?.hasLoadedDocument() === true,
          origin: (window as any).__nav_race_old_doc__ === 'old-doc',
        }),
        null,
      )
      expect(snap.docLoaded).toBe(true)
      expect(snap.origin, '注入结果必须来自新文档').toBe(false)
    } finally {
      await page.unroute(isDocumentUrl, handler)
    }
  })
})
