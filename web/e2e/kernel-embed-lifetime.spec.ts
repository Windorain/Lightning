/**
 * M7-6 · **G7：嵌入实例的显式销毁**（S0-B D8 / 计划 §5 M7-6 退出判据）。
 *
 * ## 判据面（三面同时读，任何一面不动都判红）
 *
 * | 面 | 读法 | 为什么必须读它 |
 * |---|---|---|
 * | 画布 | `.vc-viewport canvas` 计数 | 组件树真的卸载了（不是 `v-show` 藏起来） |
 * | 本实例资源账 | `__lk_embed__.probes()[i].lifecycle()` | 视口槽位（camera+domElement）与**帧循环**都退出；只看画布会被"画布没了但 RAF 还在跑"假绿 |
 * | 观测面登记 | `__log__.instanceIds()` / `probes().length` | 实例的日志与装配探针登记随实例退出（否则读面指向已销毁的 ctx） |
 *
 * ## 为什么基线取"页面上已有两个在跑的实例"
 *
 * 只证明"挂两个 → 卸两个 → 回到 0"不够：**计数读面本身就是空的**时，
 * "回 0"与"从来没数过"同形。故本页的基线上已有 A/B 两个真实例（`boot()`），
 * 挂两个（⇒ 4 画布）再卸两个（⇒ 2 画布），并要求 A/B **仍活着** ——
 * 于是"销毁"与"把整页拆了"可区分。
 *
 * ## 失败面（调度裁决：warn + 占位诊断，不抛未捕获异常、不静默）
 *
 * 1. **缺挂载点**：`mount()` 返回 `failure.code === 'noMountPoint'` 且控制台有 warn；
 * 2. **装配/渲染期抛错**：容器内出现 `[data-lk-embed-error]` 占位（role=alert），
 *    页面**零未捕获异常**（`pageerror` 为空）——
 *    这正是"不静默"与"不把整页搞崩"的交点。
 */

import { expect, test, type Page } from '@playwright/test'
import { readEmbedInstanceLifecycles, type EmbedInstanceLifecycle } from './helpers/areaLifetime'

const PAGE = '/e2e/pages/embed-dual.html'

/**
 * 一个实例此刻的寿命读数：**三条读面合并**（全部来自产品）。
 *
 * - 视口槽位 + 帧循环：`helpers/areaLifetime#readEmbedInstanceLifecycles`
 *   （按实例登记的装配探针；判据与工作台的 `readRegionLifecycle` 同一条 `slotLive`）；
 * - 观测面登记：`__log__.instanceIds()` / `probes().length`；
 * - 画布：DOM 计数（"组件树真的卸载了"，不是 `v-show` 藏起来）。
 */
interface LifecycleReading {
  probeCount: number
  instances: EmbedInstanceLifecycle[]
  logInstanceIds: string[]
  canvases: number
}

async function readLifecycle(page: Page): Promise<LifecycleReading> {
  const instances = await readEmbedInstanceLifecycles(page)
  const rest = (await page.evaluate(() => {
    const log = (window as any).__log__
    return {
      probeCount: ((window as any).__lk_embed__?.probes?.() ?? []).length,
      logInstanceIds: (log?.instanceIds?.() ?? []) as string[],
      canvases: document.querySelectorAll('.vc-viewport canvas').length,
    }
  })) as { probeCount: number; logInstanceIds: string[]; canvases: number }
  return { ...rest, instances }
}

async function waitDualReady(page: Page): Promise<void> {
  await page.goto(PAGE)
  await page.waitForFunction(() => (window as any).__embedDual__?.ready === true, undefined, { timeout: 120_000 })
  await expect
    .poll(async () => (await readLifecycle(page)).canvases, { message: '基线的两个实例必须真的挂上画布', timeout: 120_000 })
    .toBe(2)
}

/** 等某个计数稳定到期望值（销毁是异步的：Vue 卸载 → 组件 onBeforeUnmount → 槽位归零）。 */
async function expectCanvases(page: Page, n: number): Promise<void> {
  await expect.poll(async () => (await readLifecycle(page)).canvases, { timeout: 30_000 }).toBe(n)
}

test.describe('M7-6 · G7 嵌入实例显式销毁 / 失败面', () => {
  test('G7 两次 mount + 两次 unmount 后画布/视口/帧循环/登记全部回基线', async ({ page }) => {
    test.setTimeout(300_000)
    await waitDualReady(page)

    const baseline = await readLifecycle(page)
    console.log('[G7] baseline=' + JSON.stringify(baseline))
    // 【前提】基线不是"空的"：两个实例都活着（否则"回基线"可能只是读面失效）
    expect(baseline.canvases, '基线必须有两个在用实例的画布').toBe(2)
    expect(baseline.probeCount, '基线必须有两个在册装配探针').toBe(2)
    expect(baseline.logInstanceIds.length, '基线必须有两个在册日志实例').toBe(2)
    for (const [i, l] of baseline.instances.entries()) {
      expect(l.slotLive, `基线实例 ${i} 的视口必须活着（前提）`).toBe(true)
      expect(l.frameClockRunning, `基线实例 ${i} 的帧循环必须在跑（前提）`).toBe(true)
    }

    // ── ① 再挂两个实例（新建容器 + 生产 mount()，拿到寿命句柄）──
    const mounted = await page.evaluate(async () => {
      const host = document.querySelector('#remount-slot') as HTMLElement
      const mk = (id: string): HTMLElement => {
        const el = document.createElement('div')
        el.id = id
        el.className = 'web-structure-renderer'
        Object.assign(el.style, { width: '400px', height: '300px', background: '#0f172a' })
        host.appendChild(el)
        return el
      }
      mk('embed-x')
      mk('embed-y')
      const x = await (window as any).__embedDual__.mountTracked({ selector: '#embed-x', theme: 'dark' })
      const y = await (window as any).__embedDual__.mountTracked({ selector: '#embed-y', theme: 'light' })
      return { x, y }
    })
    console.log('[G7] mounted=' + JSON.stringify(mounted))
    expect(mounted.x.mounted, '新实例 X 必须真的挂上（否则下面"卸载后回基线"没有量可回）').toBe(true)
    expect(mounted.y.mounted, '新实例 Y 必须真的挂上').toBe(true)
    expect(mounted.x.instanceId, 'mount() 必须返回**本实例**身份').not.toBe(mounted.y.instanceId)

    await expectCanvases(page, 4)
    const withFour = await readLifecycle(page)
    expect(withFour.probeCount, '四个实例 ⇒ 四条装配探针登记').toBe(4)
    expect(withFour.logInstanceIds.length, '四个实例 ⇒ 四条日志登记').toBe(4)
    // 【前提】两个新实例的帧循环真的在跑（"回基线"要求它们确实曾经在跑）
    expect(withFour.instances.slice(2).every((l) => l.frameClockRunning), '新实例的帧循环必须在跑（前提）').toBe(true)

    // ── ② 显式销毁一个（真实调用 mount() 返回的 unmount()）──
    const unmountedX = await page.evaluate(() => (window as any).__embedDual__.unmount('#embed-x'))
    expect(unmountedX, '宿主必须拿到了句柄（unmount 可用）').toBe(true)
    await expectCanvases(page, 3)

    const afterOne = await readLifecycle(page)
    console.log('[G7] after unmount X=' + JSON.stringify(afterOne))
    expect(afterOne.probeCount, '被销毁实例的装配探针必须注销').toBe(3)
    expect(afterOne.logInstanceIds, '被销毁实例的日志登记必须注销').not.toContain(mounted.x.instanceId)
    expect(afterOne.logInstanceIds, '未销毁实例的日志登记必须保留').toContain(mounted.y.instanceId)
    // 容器内不得留组件产出的 DOM（"看起来销毁了"与"真的销毁了"必须可区分）
    expect(
      await page.locator('#embed-x .wm-root').count(),
      '⚠️ 销毁后容器内不得残留实例根（残留即"没真销毁"）',
    ).toBe(0)
    expect(
      await page.evaluate(() => document.querySelector('#embed-x canvas') !== null),
      '⚠️ 销毁后容器内不得残留画布',
    ).toBe(false)

    // ── ③ 再销毁第二个 ⇒ 回到**基线**（画布/探针/日志登记三面同时回）──
    const unmountedY = await page.evaluate(() => (window as any).__embedDual__.unmount('#embed-y'))
    expect(unmountedY, '第二个句柄同样必须可销毁').toBe(true)
    await expectCanvases(page, 2)

    const restored = await readLifecycle(page)
    console.log('[G7] restored=' + JSON.stringify(restored))
    expect(restored.canvases, '⚠️ G7：销毁后画布计数必须回到基线').toBe(baseline.canvases)
    expect(restored.probeCount, '⚠️ G7：销毁后装配探针登记必须回到基线').toBe(baseline.probeCount)
    expect(restored.logInstanceIds.length, '⚠️ G7：销毁后日志登记必须回到基线').toBe(baseline.logInstanceIds.length)
    // 剩下两个实例**不受牵连**（销毁 A 不得把 B 的呈现/时钟一起弄停）
    for (const [i, l] of restored.instances.entries()) {
      expect(l.slotLive, `销毁别的实例不得影响实例 ${i} 的视口`).toBe(true)
      expect(l.frameClockRunning, `销毁别的实例不得停掉实例 ${i} 的帧循环`).toBe(true)
    }

    // ── ④ 幂等：重复 unmount 不改变任何计数 ──
    const again = await page.evaluate(() => (window as any).__embedDual__.unmount('#embed-x'))
    expect(again, '句柄已被移除 ⇒ 宿主侧再调用应报 false（不静默重放已销毁实例）').toBe(false)
    await page.waitForTimeout(300)
    expect((await readLifecycle(page)).canvases).toBe(baseline.canvases)
  })

  test('失败面：缺挂载点 = warn + 结构化 failure（不抛未捕获异常）', async ({ page }) => {
    test.setTimeout(120_000)
    const pageErrors: string[] = []
    const warnings: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'warning' || m.type() === 'error') warnings.push(m.text())
    })
    await waitDualReady(page)

    const result = await page.evaluate(() => {
      const m = (window as any).__embedDual__
      return m.mountTracked({ selector: '#no-such-container' })
    })
    console.log('[G7-fail] ' + JSON.stringify(result))

    expect(result.ok, '缺挂载点 ⇒ 没有实例可挂').toBe(false)
    expect(result.mounted).toBe(false)
    expect(
      (result.failure as any)?.code,
      '⚠️ 缺挂载点必须给**结构化**原因（S0-B D13：只 warn 然后 return = 宿主拿不到任何失败信号）',
    ).toBe('noMountPoint')
    // 不静默：控制台必须有可搜到的 warn（宿主排查的入口）。
    // 用 poll：Playwright 的 console 事件经 CDP 异步送达，evaluate 返回时它可能还没到。
    await expect
      .poll(
        () => warnings.some((w) => w.includes('StructureRenderer') && w.includes('未找到挂载节点')),
        {
          message: '缺挂载点必须留下可搜的 warn；实际 ' + JSON.stringify(warnings.slice(-5)),
          timeout: 10_000,
        },
      )
      .toBe(true)
    // 不把页面搞崩：零未捕获异常
    expect(pageErrors, '⚠️ 缺挂载点不得抛未捕获异常（Wiki 正文不该因一个嵌入整页报错）').toEqual([])
  })

  test('失败面：渲染期抛错 = 容器内占位诊断（不静默、不崩页）', async ({ page }) => {
    test.setTimeout(120_000)
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await waitDualReady(page)

    const reading = await page.evaluate(() => {
      const host = document.querySelector('#remount-slot') as HTMLElement
      const el = document.createElement('div')
      el.id = 'embed-boom'
      el.className = 'web-structure-renderer'
      Object.assign(el.style, { width: '400px', height: '300px', background: '#0f172a' })
      host.appendChild(el)
      // 注入一个**读取即抛**的文档：宿主把坏数据交给库的真实形态。
      const evil = new Proxy(
        { label: 'boom' },
        {
          get(_t, k: string | symbol) {
            if (k === 'label') return 'boom'
            throw new Error('boom-in-bootstrap')
          },
          ownKeys() { throw new Error('boom-in-bootstrap') },
          getOwnPropertyDescriptor() { throw new Error('boom-in-bootstrap') },
        },
      )
      const m = (window as any).__embedDual__
      const session = m.mountRaw(el, { data: { document: evil } })
      const box = el.querySelector('.embed-mount-error') as HTMLElement | null
      return {
        mounted: session.mounted,
        failure: session.failure,
        placeholderCount: el.querySelectorAll('.embed-mount-error').length,
        role: box?.getAttribute('role') ?? null,
        code: box?.getAttribute('data-lk-embed-error') ?? null,
        text: box?.textContent ?? null,
      }
    })
    console.log('[G7-fail-render] ' + JSON.stringify(reading))

    expect(reading.mounted, '渲染期抛错 ⇒ 本次挂载不得报成功').toBe(false)
    expect(reading.failure, '必须给出结构化失败原因').not.toBeNull()
    expect((reading.failure as any)?.code).toBe('mountThrew')
    expect(reading.placeholderCount, '⚠️ 容器内必须有占位诊断（不静默；且只一个，不叠画）').toBe(1)
    expect(reading.role, '占位必须是可被辅助技术读到的 alert').toBe('alert')
    expect(reading.text ?? '', '占位必须说清"挂载失败"与原因').toContain('结构渲染器挂载失败')
    expect(reading.text ?? '').toContain('boom-in-bootstrap')
    expect(pageErrors, '⚠️ 渲染期异常不得冒出页面（库入口必须收口）').toEqual([])
  })
})