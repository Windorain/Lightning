/**
 * **回归判据：纹理异步期（白模期）的状态栏反馈**（真实入口）。
 *
 * ## 缺陷形态（缺陷 B）
 *
 * 资源五态早就算出来了（composition/kernelTextureResources），但**没有写点也没有读面**：
 * syncPresenterTextures 成功路径零输出、textureResourcesOf 没有进度回调，
 * 而状态栏只在 lastDisplayable === null 时才显示 statusMessage ——
 * 那一行一旦被任一非 DEBUG 日志写过就再没人清（LogCenter.clear() 全树零调用）。
 * ⇒ 实测：从载入到贴图落地（~7 s）状态栏恒为「初始化视口相机 → FINISHED」，
 *   用户看到的是「什么都没发生」。
 *
 * ## 判据要证明的事实（SPEC §7.4）
 *
 * 1. 载入期出现**加载中 + n/total** 事实（状态与范围可辨认）；
 * 2. 随后出现**终态**：就绪 n/n 或 缺失|失败 k；终态**不得**停在加载中；
 * 3. 反假绿：宿主元素暴露机器可读状态（data-texture-state），且「loading 曾被观察到」
 *    由**粘性** data-texture-loading-seen 记录 —— 否则终态一旦落地，判据无法区分
 *    「真的经历了加载」与「压根没写过加载态」（后者正是原缺陷）；
 * 4. 负对照：损坏一个 textureBlobs 项 ⇒ 出现「缺失/失败 1」，且仍在终态；
 * 5. 判据只看**实际请求/绑定事实**：不用 waitForTimeout、不用像素颜色占比
 *    （§7.4 末句明文禁止「靠固定延时、像素颜色猜测」）。
 *
 * ## 观测面
 *
 * - .sb-root（StatusBar.vue 根节点）的文本与 data-texture-* 属性；
 * - 装载前挂 MutationObserver 记录**每一次**状态栏变化（DOM 事实，不读产品内部状态）——
 *   这解决「终态落地太快、瞬时快照可能错过加载中」的判据脆弱性：
 *   要证的是「曾经出现」，瞬时采样不足以证它；
 * - performance.getEntriesByName('texture-sync:total' | 'texture-sync:decode')：
 *   白模期墙钟与其解码分段（步骤 6 的耗时登记，只登记不改行为）。
 */
import { expect, test, type Page } from '@playwright/test'
import { gotoWorkbench, injectSceneDocumentOk } from './helpers/multiblock/harness'
import { brokenFirstBlobEnvelope, firstMaterialLocator, fixturePath, readJson } from './helpers/saveReopen'

const FIXTURE = 'structuredata-exported-envelope.json'
/** 状态栏根节点（StatusBar.vue）。 */
const STATUS_BAR = '.sb-root'
/** 加载中：必须带 n/total（只报「加载中」不报数量 ⇒ 范围不可辨认）。 */
const LOADING = /纹理(加载中|载入中)\s*\d+\s*\/\s*\d+/
/** 终态：就绪 n/n 或 缺失/失败 k（k 是资源条数，分母同源）。 */
const TERMINAL = /纹理(就绪|可用)\s*\d+\s*\/\s*\d+|纹理(缺失|失败)\s*\d+/

/** CRLF/空白归一：文本判据不得依赖换行口径（铁律 6）。 */
function norm(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim()
}

interface StatusTick {
  /** performance.now()（页面时钟）。 */
  t: number
  /** data-texture-state（机器可读状态；未写时为 null）。 */
  state: string | null
  /** data-texture-loading-seen（粘性）。 */
  seen: string | null
  text: string
}

/** 在装载**之前**开始记录状态栏的每次变化。 */
async function traceStatusBar(page: Page): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (el === null) throw new Error('状态栏根节点不存在（' + sel + '）')
    const w = window as unknown as { __tex_trace__?: StatusTick[] }
    const out: StatusTick[] = []
    w.__tex_trace__ = out
    const snap = (): void => {
      out.push({
        t: Math.round(performance.now()),
        state: el.getAttribute('data-texture-state'),
        seen: el.getAttribute('data-texture-loading-seen'),
        text: el.textContent ?? '',
      })
    }
    snap()
    new MutationObserver(snap).observe(el, { attributes: true, subtree: true, childList: true, characterData: true })
  }, STATUS_BAR)
}

async function statusTrace(page: Page): Promise<StatusTick[]> {
  return (await page.evaluate(() => (window as unknown as { __tex_trace__?: StatusTick[] }).__tex_trace__ ?? [])) as StatusTick[]
}

/** 读某条 measure 的全部时长（ms）。 */
async function measureDurations(page: Page, name: string): Promise<number[]> {
  return (await page.evaluate(
    (n) => performance.getEntriesByName(n, 'measure').map((e) => Math.round(e.duration)),
    name,
  )) as number[]
}

/** 当前状态栏文本（归一）。 */
async function statusText(page: Page): Promise<string> {
  return norm(await page.locator(STATUS_BAR).innerText())
}

/** 当前 data-texture-state。 */
async function textureState(page: Page): Promise<string | null> {
  return await page.locator(STATUS_BAR).getAttribute('data-texture-state')
}

test.describe('纹理异步期状态栏反馈（真实入口）', () => {
  test('载入期出现「纹理加载中 n/总数」（带范围事实），随后终态；loading 有粘性记录', async ({ page }) => {
    test.setTimeout(240_000)
    await gotoWorkbench(page)
    await expect(page.locator(STATUS_BAR), '前提：状态栏必须在页面上').toBeVisible()
    await traceStatusBar(page)

    await injectSceneDocumentOk(page, readJson(fixturePath()), FIXTURE)

    // ① 加载中 n/total —— 从**已记录**的历史里取（瞬时快照可能错过这窗口，而「曾经出现」才是本判据）。
    await expect
      .poll(
        async () => {
          const tick = (await statusTrace(page)).find((x) => LOADING.test(norm(x.text)))
          return tick ? norm(tick.text) : ''
        },
        { timeout: 90_000, intervals: [50, 100, 150, 250], message: '载入期必须出现「纹理加载中 n/total」' },
      )
      .toMatch(LOADING)

    // ② 终态（同一次轮询换文案：就绪 n/n 或 缺失|失败 k）。
    await expect
      .poll(async () => await statusText(page), {
        timeout: 90_000,
        intervals: [100, 200, 400],
        message: '纹理落地后必须给出终态（就绪 / 缺失 / 失败）',
      })
      .toMatch(TERMINAL)

    const ticks = await statusTrace(page)
    const loadingTicks = ticks.filter((x) => LOADING.test(norm(x.text)))
    const terminalAt = ticks.findIndex((x) => TERMINAL.test(norm(x.text)))
    const firstLoadingAt = ticks.findIndex((x) => LOADING.test(norm(x.text)))
    expect(firstLoadingAt, '历史里必须有加载中那一帧').toBeGreaterThanOrEqual(0)
    expect(terminalAt, '终态必须出现在加载中**之后**（不得一上来就报就绪）').toBeGreaterThan(firstLoadingAt)

    // ③ 状态标签：加载中确实由 state='loading' 承载（不是文本撞出来的）
    expect(loadingTicks.some((x) => x.state === 'loading'), '加载中必须由显式状态标签承载').toBe(true)

    // ④ 反假绿：粘性读面。终态落地后仍能证明「经历过加载」。
    expect(await page.locator(STATUS_BAR).getAttribute('data-texture-loading-seen'), 'loading 必须粘性记录').toBe('1')

    // ⑤ 失败不得伪装成加载中（SPEC §7.4 末句）。
    const finalText = await statusText(page)
    expect(finalText, '终态不得停在加载中').not.toMatch(LOADING)
    expect(await textureState(page), '终态必须有机器可读状态').toMatch(/^(ready|missing|failed)$/)

    // ⑥ 耗时登记（步骤 6）：白模期墙钟及其解码分段。
    const total = await measureDurations(page, 'texture-sync:total')
    const decode = await measureDurations(page, 'texture-sync:decode')
    const last = (a: number[]): number | null => (a.length === 0 ? null : a[a.length - 1]!)
    console.log(
      '[纹理进度] 白模期墙钟 total=' + last(total) + 'ms decode=' + last(decode) + 'ms ' +
        'loadingTicks=' + loadingTicks.length + ' final=' + JSON.stringify(finalText),
    )
    expect(total.length, '必须留下 texture-sync:total 的耗时登记').toBeGreaterThan(0)
  })

  test('负对照：损坏一个 textureBlobs 项 ⇒ 出现「缺失/失败 1」，且终态不得停在加载中', async ({ page }) => {
    test.setTimeout(240_000)
    const broken = brokenFirstBlobEnvelope()
    await gotoWorkbench(page)
    await expect(page.locator(STATUS_BAR)).toBeVisible()
    await traceStatusBar(page)

    await injectSceneDocumentOk(page, broken, FIXTURE)

    // 终态必须报出「有 1 张坏」（缺失 = 必需贴图坏了；失败 = 非必需贴图坏了），而不是就绪。
    await expect
      .poll(async () => await statusText(page), {
        timeout: 90_000,
        intervals: [100, 200, 400],
        message: '负对照：坏一张必须可辨认（缺失/失败 1），不得报成就绪',
      })
      .toMatch(/纹理(缺失|失败)\s*1(?!\d)/)

    const finalText = await statusText(page)
    expect(finalText, '终态不得停在加载中').not.toMatch(LOADING)
    expect(await textureState(page), '负对照的状态标签').toMatch(/^(missing|failed)$/)
    expect(await page.locator(STATUS_BAR).getAttribute('data-texture-loading-seen')).toBe('1')
    // 「缺失范围必须可辨认」不止一个计数：坏掉那条的 locator 必须被点名。
    const brokenLocator = firstMaterialLocator()
    expect(norm(finalText), `终态必须点名缺失的那条资源（${brokenLocator}），而不只给一个数字`).toContain(
      brokenLocator.slice(0, 20),
    )
  })
})

/**
 * 损坏输入与像素判据共用同一份构造：`helpers/saveReopen#brokenFirstBlobEnvelope`
 * （已上移；本 spec 不再自带第二套实现）。
 */
