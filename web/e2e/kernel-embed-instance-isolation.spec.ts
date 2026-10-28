/**
 * **G-embed：嵌入同页双实例 / 重挂载的实例隔离**（真实嵌入入口 `mount()`）。
 *
 * ## 语义依据
 *
 * 语言/主题/偏好按实例隔离。
 * 判据面（G8 行 + D6/D7/D9）：**同页两个嵌入实例，各自的状态栏 / 主题 /
 * 语言 / 偏好互不影响；重新挂载后读回自己的实例状态**（而不是别人的、也不是最后写者）。
 *
 * ## 测试基建（本包新增，测试专用，未动 `src/` 产品代码）
 *
 * - `e2e/pages/embed-dual.html` + `e2e/pages/embed-dual.ts`：一个**宿主页**，
 *   给两个挂载点并按宿主参数调用生产 `mount()`（`@/embed/mount` → `EmbedRoot` →
 *   `EmbedViewport`，与 Wiki 真实嵌入同一条路径）。它不 import 内部装配模块、不建替身宿主。
 *   之所以要新页：既有 `e2e-embed-mobile.html` 只挂一个实例，而同页双实例正是本判据的对象。
 * - 重挂载用宿主可用的最小手段：**新建容器再 `mount()` 一次**（生产 `mount()` 无返回值、
 *   无卸载句柄，见 D8/G7）。这正是 Wiki 模板重复嵌入的真实形态。
 *
 * ## 判据（三条用例）
 *
 * 1. **GE-1 呈现与失败隔离**：两实例按各自宿主参数呈现（A 有层栏与调试状态栏、B 没有）；
 *    第三个实例拿到**坏文档**时必须只影响自己（亮错误态），A/B 的画布与主题不受影响。
 * 2. **GE-2 主题隔离 + 重挂载读回**：A=dark / B=light ⇒ 各自实例根元素 `data-lk-theme`
 *    分别为 dark/light；`documentElement` 上**不得**出现旧的全局写点 `data-nei-theme`；
 *    重挂载的 B'（theme=light）读回 light，A 仍 dark。
 * 3. **GE-3 实例偏好隔离**：在 A 上**真实点击**设置面板改一项偏好；随后重挂载的 B'
 *    必须回到**默认值**（不得继承 A）。当前实现把偏好键固定成 `lightning.prefs.embed`
 *    （`runtime/screenRoot.ts:319`）⇒ 预期先红（D7）。
 *
 * 语言：嵌入**没有**宿主语言输入（`shellSettings` 的 `initialLang` 未被 `embedHost` 传入，
 * 第 5 条），故本文件对语言只能钉"两实例各自持本实例的 `data-lk-lang`"
 * （可区分性的真判据是存储键命名空间，见 GE-3 同族）。
 */

import { expect, test, type Page } from '@playwright/test'

const PAGE = '/e2e/pages/embed-dual.html'

/** 一个实例的可见状态（全部来自 DOM：实例根元素属性 + 宿主声明的呈现差异）。 */
interface InstanceView {
  theme: string | null
  lang: string | null
  title: string | null
  hasDock: boolean
  hasStatusBar: boolean
  canvasCount: number
}

async function readInstance(page: Page, selector: string): Promise<InstanceView> {
  return (await page.evaluate((sel) => {
    const root = document.querySelector(sel + ' .wm-root') as HTMLElement | null
    return {
      theme: root?.getAttribute('data-lk-theme') ?? null,
      lang: root?.getAttribute('data-lk-lang') ?? null,
      title: root?.querySelector('.wm-title-text')?.textContent?.replace(/\r\n/g, '\n').trim() ?? null,
      hasDock: (root?.querySelectorAll('.vp-dock').length ?? 0) > 0,
      hasStatusBar: (root?.querySelectorAll('.wm-status-bar').length ?? 0) > 0,
      canvasCount: root?.querySelectorAll('.vc-viewport canvas').length ?? 0,
    }
  }, selector)) as InstanceView
}

/** 等两个实例都真的挂上画布（`.wm-root` + canvas 是"实例活着"的可观测事实）。 */
async function waitEmbedDualReady(page: Page): Promise<void> {
  await page.goto(PAGE)
  await page.waitForFunction(() => (window as any).__embedDual__?.ready === true, undefined, { timeout: 120_000 })
  await expect
    .poll(async () => await page.locator('.wm-root .vc-viewport canvas').count(), {
      message: '两个嵌入实例都必须真的挂上 3D 画布',
      timeout: 120_000,
    })
    .toBeGreaterThanOrEqual(2)
}

/** 读设置面板第 1 个开关（"鼠标悬浮高亮方块"）的勾选状态。 */
async function readPrefsCheckbox(page: Page, instanceSelector: string): Promise<boolean | null> {
  return await page.evaluate((sel) => {
    const box = document.querySelector(sel + ' .wm-settings-panel input[type="checkbox"]') as HTMLInputElement | null
    return box ? box.checked : null
  }, instanceSelector)
}

/** 打开某实例的设置面板（真实点击标题栏"设置"按钮）。 */
async function openSettings(page: Page, instanceSelector: string): Promise<void> {
  await page.locator(instanceSelector + ' button[title="设置"]').click()
  await expect(page.locator(instanceSelector + ' .wm-settings-panel')).toBeVisible({ timeout: 10_000 })
}

/** 关闭某实例的设置面板（真实点击 ✕）。 */
async function closeSettings(page: Page, instanceSelector: string): Promise<void> {
  await page.locator(instanceSelector + ' .wm-settings-panel .wm-settings-close').click()
  await expect(page.locator(instanceSelector + ' .wm-settings-panel')).toHaveCount(0, { timeout: 10_000 })
}

test.describe('嵌入双实例 / 重挂载的实例隔离', () => {
  test('GE-1 同页双实例：呈现按实例参数生效，坏文档只影响自己', async ({ page }) => {
    test.setTimeout(240_000)
    await waitEmbedDualReady(page)

    const a = await readInstance(page, '#embed-a')
    const b = await readInstance(page, '#embed-b')
    console.log('[GE-1] A=' + JSON.stringify(a) + '\n       B=' + JSON.stringify(b))

    // ── 各自都是真实例 ──
    expect(a.canvasCount, 'A 实例必须有 1 个真实 3D 画布；实际 ' + a.canvasCount).toBe(1)
    expect(b.canvasCount, 'B 实例必须有 1 个真实 3D 画布；实际 ' + b.canvasCount).toBe(1)
    expect(a.title, 'A 必须有标题栏文本').toBeTruthy()
    expect(b.title, 'B 必须有标题栏文本').toBeTruthy()

    // ── 呈现裁剪按**实例**的宿主参数生效（不是全局一份）──
    expect(a.hasDock, 'A（宿主声明 layerBar=true）必须有下方 dock').toBe(true)
    expect(b.hasDock, 'B（宿主未声明 layerBar）不得有 dock —— 若出现即"宿主参数被全局化"').toBe(false)
    expect(a.hasStatusBar, 'A（debugStatusBar+debug）必须有调试状态栏').toBe(true)
    expect(b.hasStatusBar, 'B（未开调试状态栏）不得有状态栏 —— 同上').toBe(false)

    // ── 失败隔离：第三个实例拿坏文档 ──
    const mounted = await page.evaluate(async () => {
      const host = document.querySelector('#remount-slot') as HTMLElement
      const el = document.createElement('div')
      el.id = 'embed-broken'
      el.className = 'web-structure-renderer'
      Object.assign(el.style, { width: '400px', height: '300px' })
      host.appendChild(el)
      return await (window as any).__embedDual__.mountOne({ selector: '#embed-broken', data: 'broken', theme: 'dark' })
    })
    expect(mounted, '坏文档实例必须真的被挂载（否则"失败隔离"无从观测）').toBe(true)
    await expect(page.locator('#embed-broken .embed-boot--err')).toBeVisible({ timeout: 30_000 })

    const aAfter = await readInstance(page, '#embed-a')
    const bAfter = await readInstance(page, '#embed-b')
    expect(
      aAfter.canvasCount + bAfter.canvasCount,
      '⚠️ 一个实例装载失败不得影响其它实例的视口（§10.5 生命周期互不越界）',
    ).toBe(2)
    expect(aAfter.theme, '⚠️ 失败实例不得改掉 A 的主题').toBe(a.theme)
    expect(bAfter.theme, '⚠️ 失败实例不得改掉 B 的主题').toBe(b.theme)
    expect(
      await page.locator('#embed-a .wm-status-bar').count(),
      '⚠️ 失败实例的错误不得出现在 A 的状态栏位置',
    ).toBe(1)
  })

  test('GE-2 主题隔离 + 重挂载读回自己的主题（不得写全局）', async ({ page }) => {
    test.setTimeout(240_000)
    await waitEmbedDualReady(page)

    const a = await readInstance(page, '#embed-a')
    const b = await readInstance(page, '#embed-b')
    console.log('[GE-2] A.theme=' + a.theme + ' B.theme=' + b.theme)

    // ── 主题按实例解析（A=dark / B=light）──
    expect(a.theme, 'A（宿主 theme=dark）实例根元素必须解析出 dark').toBe('dark')
    expect(
      b.theme,
      '⚠️ B（宿主 theme=light）必须解析出 light —— 与 A 相同即"主题被全局化"（旧 F1 形态）；实际 ' + b.theme,
    ).toBe('light')

    // ── 旧全局写点不得回归 ──
    const docTheme = await page.evaluate(() => document.documentElement.getAttribute('data-nei-theme'))
    expect(
      docTheme,
      '⚠️ `mount()` 不得再写 `documentElement[data-nei-theme]`（同页两实例会互相覆盖）',
    ).toBeNull()

    // ── 语言：两实例各自持本实例的 `data-lk-lang`（嵌入无宿主语言输入，见文件头）──
    expect(a.lang, 'A 实例根元素必须带本实例的 data-lk-lang').toBeTruthy()
    expect(b.lang, 'B 实例根元素必须带本实例的 data-lk-lang').toBeTruthy()

    // ── 重挂载：新容器再 mount 一个 light 实例 ⇒ 读回自己的主题 ──
    const remounted = await page.evaluate(async () => {
      return await (window as any).__embedDual__.remountInNewSlot({ id: 'embed-b2', theme: 'light', features: { layerBar: false } })
    })
    expect(remounted, '重挂载必须真的成功（新容器 + 再次 mount）').toBe(true)
    await expect
      .poll(async () => (await readInstance(page, '#embed-b2')).canvasCount, { timeout: 90_000 })
      .toBe(1)

    const b2 = await readInstance(page, '#embed-b2')
    const aAfter = await readInstance(page, '#embed-a')
    console.log('[GE-2] remounted B2=' + JSON.stringify(b2) + ' A=' + JSON.stringify(aAfter))
    expect(
      b2.theme,
      '⚠️ 重挂载的实例必须读回**自己的**主题（light）；实际 ' + b2.theme,
    ).toBe('light')
    expect(aAfter.theme, '⚠️ 重挂载不得改掉已在场实例的主题（A 仍 dark）').toBe('dark')
    expect(
      await page.evaluate(() => document.documentElement.getAttribute('data-nei-theme')),
      '⚠️ 重挂载同样不得写文档根主题属性',
    ).toBeNull()
  })

  test('GE-3 实例偏好隔离：A 改设置 ⇒ 重挂载的 B′ 必须回到默认（先红）', async ({ page }) => {
    test.setTimeout(300_000)
    await waitEmbedDualReady(page)

    // ── ① A 上**真实点击**改一项偏好（"鼠标悬浮高亮方块" 默认 true → false）──
    await openSettings(page, '#embed-a')
    const defaultChecked = await readPrefsCheckbox(page, '#embed-a')
    expect(defaultChecked, '【前提】A 的设置面板必须能读到第 1 个开关（否则判据空转）').toBe(true)
    await page.locator('#embed-a .wm-settings-panel input[type="checkbox"]').first().uncheck()
    await page.waitForTimeout(300)
    await closeSettings(page, '#embed-a')

    // 负对照：A 自己重开必须读到改后的值（证明"改真的生效并持久化"）
    await openSettings(page, '#embed-a')
    const aAfterChange = await readPrefsCheckbox(page, '#embed-a')
    await closeSettings(page, '#embed-a')
    expect(
      aAfterChange,
      '【负对照】A 自己重开设置面板必须读到改后的值（false）—— 否则"B 读到默认"可能只是因为谁都没写',
    ).toBe(false)

    // ── ② 重挂载一个**新**实例 B′（不同容器、不同实例）──
    const remounted = await page.evaluate(async () => {
      return await (window as any).__embedDual__.remountInNewSlot({ id: 'embed-b3', theme: 'light' })
    })
    expect(remounted, '重挂载必须真的成功').toBe(true)
    await expect
      .poll(async () => (await readInstance(page, '#embed-b3')).canvasCount, { timeout: 90_000 })
      .toBe(1)

    await openSettings(page, '#embed-b3')
    const b3Checked = await readPrefsCheckbox(page, '#embed-b3')
    await closeSettings(page, '#embed-b3')

    console.log('[GE-3] A(default)=' + defaultChecked + ' A(after)=' + aAfterChange + ' B3=' + b3Checked)

    // ── ③ 判据：新实例必须读回**默认值**，不得继承 A ──
    expect(
      b3Checked,
      '⚠️ G-embed/G8：重挂载的实例必须读回**自己的**偏好（默认 true），不得继承 A 改成 false 的值 —— ' +
        '偏好键带实例段（lk-ui.v1.<instanceId>.viewer.r-embed）；实际 ' + b3Checked,
    ).toBe(true)
  })

  /**
   * GE-4（「LogCenter 实例化」判据）：**同页各实例的日志与实时状态互不影响**。
   *
   * ## 判据为什么必须用"两份内容不同的文档"
   *
   * `liveStatus` 的终态是 `纹理就绪 N/N`，N = 本实例文档的资源条数。
   * 两个实例装**同一份**文档时 N 相同 ⇒ "各读各的"与"共用一份"读数一样，
   * 判据恒绿（空洞真）。故第三个实例装 `minimal-v2.json`（1 条资源）：
   * A 的 N=62、C 的 N=1 ⇒ 读数可区分。
   *
   * ## 三面
   *
   * 1. **按实例登记**：`__log__.instanceIds()` 恰为挂载顺序的三个 id；
   * 2. **各读各的**：`forInstance(id).liveStatus()` 分别是 62/62 与 1/1（不相等）；
   * 3. **缺省读面不是"最后写者"**（D9 的原始形态）：`__log__.liveStatus()` 等于
   *    **第一个在册实例**的结论，而最后写的是 C（1/1）。共享单例时这里会是 1/1 ⇒ 判红。
   *
   * 另加两条护栏：`forInstance(未知 id)` 必须是 `null`（不静默回落到缺省 ——
   * 那会让"读错实例"与"实例已卸载"同形）；A 的可见状态栏仍是**自己那一条**。
   */
  test('GE-4 同页三实例：liveStatus 与日志登记按实例隔离（缺省读面不得是最后写者）', async ({ page }) => {
    test.setTimeout(300_000)
    await waitEmbedDualReady(page)

    // 第三个实例：**另一份内容**（1 条资源）⇒ 与 A/B 的 62 条可区分。
    const mounted = await page.evaluate(async () => {
      const host = document.querySelector('#remount-slot') as HTMLElement
      const el = document.createElement('div')
      el.id = 'embed-c'
      el.className = 'web-structure-renderer'
      Object.assign(el.style, { width: '400px', height: '300px', background: '#0f172a' })
      host.appendChild(el)
      return await (window as any).__embedDual__.mountTracked({ selector: '#embed-c', data: 'minimal', theme: 'dark' })
    })
    expect(mounted.mounted, '第三个实例必须真的挂上（否则"三份读数"少一份）').toBe(true)

    // 等 A 与 C 各自走到**纹理终态**（纹理同步是异步的：加载中 n/62 → 就绪 62/62）。
    //
    // 这一步本身不是判据，而是"读数必须在终态上比较"的前提：加载中的进度文本
    // 随帧推进（A=24/62、C=1/1），把它当结论会让断言依赖于采样时机。
    await expect
      .poll(
        async () =>
          await page.evaluate((cId: string) => {
            const log = (window as any).__log__
            const aState = log?.forInstance?.(log.instanceIds()[0])?.liveStatus?.()?.state ?? null
            const cState = log?.forInstance?.(cId)?.liveStatus?.()?.state ?? null
            return [aState, cState].join('|')
          }, mounted.instanceId),
        { message: 'A 与 C 都必须走到纹理终态（ready）', timeout: 180_000 },
      )
      .toBe('ready|ready')

    const reading = (await page.evaluate(() => {
      const log = (window as any).__log__
      const ids: string[] = log?.instanceIds?.() ?? []
      const per = ids.map((id: string) => {
        const api = log.forInstance(id)
        const live = api?.liveStatus?.() ?? null
        return { id, message: live?.message ?? null, state: live?.state ?? null, origin: live?.origin ?? null }
      })
      return {
        ids,
        per,
        defaultLive: log?.liveStatus?.() ?? null,
        // ⚠️ 不得用 `?? 'MISSING-API'`：`forInstance` 对未知 id 的正确返回**就是 null**，
        // 那会把判据要读的值替换成兜底串，从而把"正确"读成"API 不存在"。
        unknown: typeof log?.forInstance === 'function' ? log.forInstance('no-such-instance') : 'MISSING-API',
        instancesLen: (log?.instances?.() ?? []).length,
      }
    })) as {
      ids: string[]
      per: { id: string; message: string | null; state: string | null; origin: string | null }[]
      defaultLive: { message: string; state: string | null } | null
      unknown: unknown
      instancesLen: number
    }
    console.log('[GE-4] ids=' + JSON.stringify(reading.ids) + ' per=' + JSON.stringify(reading.per) +
      ' default=' + JSON.stringify(reading.defaultLive))

    // ── ① 按实例登记（顺序 = 挂载顺序，且互不相同）──
    expect(reading.ids.length, '三个实例 ⇒ 三条日志登记').toBe(3)
    expect(new Set(reading.ids).size, '实例 id 必须互不相同（同 id 会互相覆盖）').toBe(3)
    expect(reading.ids[2], '最后挂载的实例身份应等于 mount() 返回的那个').toBe(mounted.instanceId)
    expect(reading.instancesLen, 'instances() 必须与 instanceIds() 同长').toBe(3)

    // ── ② 各读各的：A 与 C 的纹理结论必须不同（内容不同 ⇒ N 不同）──
    const a = reading.per[0]!
    const c = reading.per[2]!
    expect(a.state, '前提：A 必须已到纹理终态').toBe('ready')
    expect(c.state, '前提：C 必须已到纹理终态').toBe('ready')
    expect(a.origin, 'A 的实时状态必须仍标明来源是纹理链').toBe('texture')
    expect(c.origin).toBe('texture')
    expect(
      a.message,
      '⚠️ D9：A 的实时状态必须读回**A 自己**的结论（62 条资源）',
    ).toBe('纹理就绪 62/62')
    expect(
      c.message,
      '⚠️ D9：C 的实时状态必须读回**C 自己**的结论（1 条资源）',
    ).toBe('纹理就绪 1/1')
    expect(a.message, '两实例内容不同 ⇒ 读数必须不同（相同即共用一份槽）').not.toBe(c.message)

    // ── ③ 缺省读面 = 第一个在册实例，**不是最后写者** ──
    expect(
      reading.defaultLive?.message,
      '⚠️ D9：缺省读面不得是"最后写者胜"（最后写的是 C=1/1；这里必须是 A=62/62）',
    ).toBe('纹理就绪 62/62')

    // ── ④ 未知实例不得静默回落到缺省 ──
    expect(reading.unknown, '⚠️ forInstance(未知 id) 必须是 null（回落会让"读错实例"与"已卸载"同形）').toBeNull()

    // ── ⑤ 可见状态栏仍按实例：A 有自己的一条、B 没有（未被别的实例"点亮"）──
    expect(await page.locator('#embed-a .wm-status-bar').count(), 'A 的状态栏必须还在').toBe(1)
    expect(await page.locator('#embed-b .wm-status-bar').count(), 'B 未开调试状态栏 ⇒ 仍不得出现').toBe(0)
    expect(
      (await page.locator('#embed-a .wm-status-text').textContent()) ?? '',
      'A 的状态栏必须仍显示自己那份文档的结论',
    ).toContain('场景已加载')
  })
})
