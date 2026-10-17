/**
 * M5-5 · **内置多方块样例**（产品入口）端到端判据。
 *
 * ## 为什么要有这条 spec
 *
 * M5-S0-A 的 G8 是「通道预览的唯一入口没有产品样本」：`data/scenes/` 只有 `export.json`，
 * 用户要看通道面板必须自备外部文件。本批把 `builtin-multiblock-ebf.json` 放进
 * `web/data/scenes/`（由 `scripts/multiblock-fixtures/make-builtin-sample.mjs` 从
 * `multiblock-ebf-2ch` 夹具再生成），本条判据证明它**从真实入口一步可达**：
 *
 *   设置（顶栏）→ 内置示例 → 选中「示例·电力高炉（多方块）」→ 加载到工作台
 *
 * 然后复用 M5-2 的断言面（面板 `data-*` + 渲染定义逐格对比参考网格）证明：
 *  1. 通道 tab 出现、面板通道条数与声明一致（3 条：Height/Coil/Glass，范围 0..域上界）；
 *  2. 拖一条通道滑杆 ⇒ **面板 dims 与渲染定义同时变**，且逐格等于该组合的参考网格。
 *
 * ## 为什么用"渲染定义逐格"而不是截图像素
 *
 * 合成 fixture 的烘焙几何在参考视口下**不可见**（E2E README 明文："像素判据不适用于合成
 * fixture"）—— 截图差异对它是恒 0。M5-2 的断言面因此是**渲染定义**：面板与画面读同一次
 * 求值（`evaluateMultiblockPresentation` 记忆化），逐格等于参考 = "画面真的按取值再装配"。
 *
 * ## 期望值从哪来
 *
 * 样例是 `multiblock-ebf-2ch` 的产品化再包装（内层 body 逐字节不变，只重写信封 `meta`）
 * ⇒ 面板期望沿用 `panelContract.ts` 的同一张硬编码表；渲染参考来自
 * `snapshotOrFallbackReference`（缺失时就地按同一蓝本补生成，不静默跳过）。
 *
 * desktop-only：顶栏设置入口与抽屉是桌面工作台布局（窄视口下不在同一屏）。
 */

import { expect, test, type Page } from '@playwright/test'
import {
  CHANNEL_TAB,
  channelSlider,
  diffSignatureGrids,
  gotoWorkbench,
  openChannelTabReady,
  panelContractFor,
  pollUntil,
  readChannelPanel,
  readRenderedDefinition,
  setChannelValue,
  signatureGrid,
  snapshotOrFallbackReference,
  waitForDocLoaded,
  waitForMeshIdle,
  waitForRenderedGrid,
  waitForViewportMounted,
} from './helpers/multiblock'

/** 内置样例的场景 id（文件名去扩展名；与 `devScenes` 的 glob 同口径）。 */
const SAMPLE_SCENE_ID = 'builtin-multiblock-ebf'
/** 产品呈现名（`devScenes#SCENE_DISPLAY_NAMES`）。 */
const SAMPLE_DISPLAY_NAME = '示例·电力高炉（多方块）'
/** 样例的声明契约 = ebf-2ch 夹具那张硬编码表（内层 body 未改）。 */
const CONTRACT_FILE = 'multiblock-ebf-2ch.json'
/** 初始组合：tt=声明默认 2、通道全 Not set（面板/渲染的初始态）。 */
const INITIAL_KEY = 'height:0|coil:0|glass:0|tt:2|runstate:idle'

/**
 * 真实入口一步加载内置样例（顶栏设置 → 抽屉 → 内置示例 → 加载到工作台 → 关闭抽屉）。
 *
 * 两条判据共用：①功能面（滑杆改画面）；②手测面（1440×900 下全部通道可达）。
 * 抽出来是为了让"入口步骤"只有一处实现 —— 两条判据若各写一遍，入口一改就会漂移。
 */
async function openBuiltinSample(page: Page): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const drawer = page.locator('.drawer-panel')
  await expect(drawer, '设置抽屉必须能从顶栏打开（M5-5 恢复的入口）').toBeVisible()
  await drawer.getByRole('button', { name: '内置示例', exact: true }).click()

  const sceneSelect = drawer.locator('select')
  const sampleOption = sceneSelect.locator(`option[value="${SAMPLE_SCENE_ID}"]`)
  await expect(sampleOption, '内置示例列表必须包含多方块样例（按产品名呈现）').toHaveText(SAMPLE_DISPLAY_NAME)
  await sceneSelect.selectOption(SAMPLE_SCENE_ID)
  await drawer.getByRole('button', { name: '加载到工作台' }).click()

  await waitForDocLoaded(page)
  await waitForViewportMounted(page)
  await waitForRenderedGrid(page)
  // 抽屉是遮罩式：后续要在工作区里操作，先关掉。
  await drawer.getByRole('button', { name: '关闭' }).click()
  await expect(drawer).toBeHidden()
}

/** 面板几何观测（P4 手测阻断的判据面）：面板盒 + 每条滑杆的**屏幕盒**。 */
interface PanelSliderGeometry {
  readonly key: string
  readonly top: number
  readonly bottom: number
  readonly left: number
  readonly right: number
  readonly height: number
}

interface PanelGeometry {
  readonly innerWidth: number
  readonly innerHeight: number
  readonly panel: {
    readonly top: number
    readonly bottom: number
    readonly height: number
    readonly clientHeight: number
    readonly scrollHeight: number
  } | null
  readonly sliders: readonly PanelSliderGeometry[]
}

async function readPanelGeometry(page: Page): Promise<PanelGeometry> {
  return await page.evaluate(() => {
    const panel = document.querySelector('[data-dock-panel="channels"]') as HTMLElement | null
    const pr = panel?.getBoundingClientRect()
    const sliders = [...document.querySelectorAll('input[data-mb-channel]')].map((el) => {
      const r = (el as HTMLElement).getBoundingClientRect()
      return {
        key: el.getAttribute('data-mb-channel') ?? '',
        top: r.top, bottom: r.bottom, left: r.left, right: r.right,
        height: r.height,
      }
    })
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      panel:
        pr === undefined
          ? null
          : {
              top: pr.top, bottom: pr.bottom, height: pr.height,
              clientHeight: panel!.clientHeight, scrollHeight: panel!.scrollHeight,
            },
      sliders,
    }
  })
}

test.describe('M5-5 · 内置多方块样例（真实入口 → 通道面板 → 滑杆改画面）', () => {
  test('设置 → 内置示例 → 加载：通道 tab / 面板条数 / 滑杆改变渲染定义（逐格 = 参考）', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', '真实入口手测面固定在 desktop-chrome')
    test.setTimeout(180_000)
    const p = panelContractFor(CONTRACT_FILE)
    const ref = snapshotOrFallbackReference(CONTRACT_FILE)

    await gotoWorkbench(page)

    // ── 1. 真实入口：顶栏「设置」→ 抽屉 → 内置示例 ───────────────────────────
    await openBuiltinSample(page)

    // ── 2. 通道 tab + 面板条数 = 文件声明 ────────────────────────────────────
    await expect(page.locator(CHANNEL_TAB), '多方块文档必须出现「通道」tab').toBeVisible()
    await openChannelTabReady(page)
    const panel = await readChannelPanel(page)
    expect(panel.present).toBe(true)
    expect(panel.displayName, '面板显示名来自文件声明').toBe(p.displayName)
    expect(panel.channels.map((c) => c.key), '滑杆条数/顺序 = 声明通道').toEqual(p.channels.map((c) => c.key))
    expect(panel.channels.length, '样例声明的滑杆条数').toBe(p.sliderCount)
    expect(panel.channels.map((c) => c.name)).toEqual(p.channels.map((c) => c.name))
    expect(panel.channels.map((c) => c.sliderMax)).toEqual(p.channels.map((c) => c.sliderHi))
    expect(panel.tierMin).toBe(p.tierMin)
    expect(panel.tierMax).toBe(p.tierMax)
    expect(panel.tierSamples).toEqual(p.tierSamples)
    expect(panel.runstateOptions).toEqual(p.runstates)
    expect(panel.dims, '初始装配（tt=默认、通道 Not set）').toBe('3×2×3')

    // ── 3. 初始渲染定义 = 参考网格（逐格） ──────────────────────────────────
    const initialRef = ref.byVariant.get(INITIAL_KEY)
    expect(initialRef, `参考网格必须声明初始组合 ${INITIAL_KEY}`).toBeTruthy()
    const before = await pollUntil(
      async () => {
        const rendered = await readRenderedDefinition(page)
        const sig = signatureGrid(rendered.cellGrid, rendered.palette, 'idMeta')
        return diffSignatureGrids(sig, initialRef.signature).count === 0 ? rendered : null
      },
      '内置样例初始渲染收敛到参考网格',
      30_000,
    )
    expect(before.shape, '初始渲染定义形状 [d,h,w]').toEqual([initialRef.dims.d, initialRef.dims.h, initialRef.dims.w])

    // ── 4. 拖一根通道滑杆 ⇒ 面板与画面同一次装配 ─────────────────────────────
    await setChannelValue(page, 'height', 5)
    await waitForMeshIdle(page, channelSlider('height'))
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.getAttribute('data-mb-dims') === '3×5×3',
      '[data-mb-panel="channels"]',
      { timeout: 30_000 },
    )
    const afterPanel = await readChannelPanel(page)
    expect(afterPanel.channels.find((c) => c.key === 'height')!.value, '滑杆值真的落到面板状态').toBe(5)
    expect(afterPanel.variantKey, '变体键反映当前取值').toContain('height:5')

    const targetKey = 'height:5|coil:0|glass:0|tt:2|runstate:idle'
    const targetRef = ref.byVariant.get(targetKey)
    expect(targetRef, `参考网格必须声明目标组合 ${targetKey}`).toBeTruthy()
    const after = await pollUntil(
      async () => {
        const rendered = await readRenderedDefinition(page)
        const sig = signatureGrid(rendered.cellGrid, rendered.palette, 'idMeta')
        return diffSignatureGrids(sig, targetRef.signature).count === 0 ? rendered : null
      },
      'height=5 后渲染定义收敛到参考网格',
      30_000,
    )
    expect(after.shape, 'height=5 ⇒ 画面按当前取值再装配 [d,h,w]').toEqual([targetRef.dims.d, targetRef.dims.h, targetRef.dims.w])
    expect(after.shape[1], '高度确实变高').toBeGreaterThan(before.shape[1]!)
    expect(after.cellGrid, '渲染定义必须真的换了一份网格').not.toEqual(before.cellGrid)

    console.log(
      `[M5-5] 内置样例：面板 ${panel.channels.length} 条 / dims ${before.shape.join('×')} → ${after.shape.join('×')} / ` +
        `逐格 = 参考（初始 ${INITIAL_KEY}、目标 ${targetKey}）`,
    )
  })
  /**
   * **P4 手测阻断（M5-2 打回）**：1440×900 下通道面板被裁 —— 只露 Tier/Height，
   * Coil/Glass 落在面板外且页面底边也裁（实测：面板 computed height = 40px，
   * 命中主题规则 `.vp-dock--workbench .vp-dock__panel { height: 40px }`，
   * 而通道覆盖规则是单类选择器、压不过它；scrollHeight 90 > clientHeight 40）。
   *
   * 判据刻意**不**用 `scrollIntoViewIfNeeded`（那会把裁剪掩盖成"可达"）：
   *  1. 每条声明通道滑杆的**几何盒**完整落在面板盒与窗口内（不需要滚动）；
   *  2. 面板内容不依赖滚动（scrollHeight ≤ clientHeight）；
   *  3. 滑杆中点用**裸鼠标坐标**点击：命中测试必须是滑杆本身，且模型真的变。
   */
  test('1440×900 / 1600×1200：声明的全部通道滑杆在面板/视口内可达且可交互（手测阻断回归）', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', '手测面固定在 desktop-chrome（桌面窗口尺寸）')
    test.setTimeout(180_000)
    const p = panelContractFor(CONTRACT_FILE)

    // 先定视口再进页面：布局按首个手测窗口初始化。
    await page.setViewportSize({ width: 1440, height: 900 })
    await gotoWorkbench(page)
    await openBuiltinSample(page)
    await expect(page.locator(CHANNEL_TAB), '多方块文档必须出现「通道」tab').toBeVisible()
    await openChannelTabReady(page)

    // P4 手测的两个窗口都要成立（只验一个会让"换窗口又裁"漏网）。
    const sizes = [
      { width: 1440, height: 900 },
      { width: 1600, height: 1200 },
    ] as const
    const logs: string[] = []
    for (const size of sizes) {
      await page.setViewportSize(size)
      // 等一帧让布局落定（视口尺寸变化触发 reflow，不是异步数据）。
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())))
      const geom = await readPanelGeometry(page)
      const label = `${size.width}×${size.height}`

      // 反空洞真：面板与声明通道都在场（否则下面的"都在框内"是没扫到）。
      expect(geom.panel, `${label}：通道面板必须存在`).not.toBeNull()
      expect(geom.sliders.map((s) => s.key), `${label}：滑杆集合 = 声明通道`).toEqual(p.channels.map((c) => c.key))
      expect(geom.innerWidth, `${label}：窗口宽`).toBe(size.width)
      expect(geom.innerHeight, `${label}：窗口高`).toBe(size.height)

      // ① 面板不得被窗口底边裁（P4 症状之一：面板底部越过窗口底）。
      expect(geom.panel!.bottom, `${label}：面板底边必须在窗口内`).toBeLessThanOrEqual(geom.innerHeight + 0.5)
      expect(geom.panel!.top, `${label}：面板顶边必须在窗口内`).toBeGreaterThanOrEqual(0)

      // ② 每条通道滑杆完整落在面板盒与窗口内（Coil/Glass 不得落在面板外）。
      for (const s of geom.sliders) {
        expect(s.height, `${label} ${s.key}：滑杆必须有非零高度`).toBeGreaterThan(0)
        expect(s.top, `${label} ${s.key}：顶部必须在面板内`).toBeGreaterThanOrEqual(geom.panel!.top - 0.5)
        expect(s.bottom, `${label} ${s.key}：底部必须在面板内（不得被裁）`).toBeLessThanOrEqual(geom.panel!.bottom + 0.5)
        expect(s.bottom, `${label} ${s.key}：底部必须在窗口内`).toBeLessThanOrEqual(geom.innerHeight + 0.5)
      }

      // ③ 内容不依赖滚动（EBF 3 通道 + Tier 在两个手测窗口下都必须一屏可见）。
      expect(
        geom.panel!.scrollHeight,
        `${label}：面板内容高度不得超出可视高度（EBF 样例必须一屏可见，不靠滚动）`,
      ).toBeLessThanOrEqual(geom.panel!.clientHeight + 1)

      logs.push(
        `${label} panel=${Math.round(geom.panel!.height)}px client=${geom.panel!.clientHeight} scroll=${geom.panel!.scrollHeight} ` +
          `sliders=${geom.sliders.map((s) => `${s.key}@${Math.round(s.top)}-${Math.round(s.bottom)}`).join(',')}`,
      )

      // ④ 可交互（在首个手测窗口验一次就够：同一 DOM/事件链，尺寸不改变命中语义）。
      if (size.width !== 1440) continue
      const coil = geom.sliders.find((s) => s.key === 'coil')!
      const cx = (coil.left + coil.right) / 2
      const cy = (coil.top + coil.bottom) / 2
      const hit = await page.evaluate(
        ({ x, y }) => {
          const el = document.elementFromPoint(x, y) as HTMLElement | null
          return el?.getAttribute?.('data-mb-channel') ?? el?.tagName ?? null
        },
        { x: cx, y: cy },
      )
      expect(hit, `${label}：滑杆中点必须命中滑杆本身（不被裁/不被其它元素遮挡）`).toBe('coil')
      await page.mouse.click(cx, cy)
      await expect
        .poll(
          async () => {
            const panel = await readChannelPanel(page)
            return panel.channels.find((c) => c.key === 'coil')!.value
          },
          { timeout: 10_000 },
        )
        .toBeGreaterThan(0)
      logs.push(`click(coil)→${(await readChannelPanel(page)).channels.find((c) => c.key === 'coil')!.value}`)
    }

    console.log(`[M5-5] 通道可达（P4 手测窗口）：${logs.join(' | ')}`)
  })
});
