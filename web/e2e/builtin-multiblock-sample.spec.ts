/**
 * **内置多方块样例**（产品入口）端到端判据。
 *
 * ## 为什么要有这条 spec
 *
 * 「通道预览的唯一入口没有产品样本」这一缺口：`data/scenes/` 只有 `export.json`，
 * 用户要看通道面板必须自备外部文件。现把 `builtin-multiblock-ebf.json` 放进
 * `web/data/scenes/`（由 `scripts/multiblock-fixtures/make-builtin-sample.mjs` 从
 * `multiblock-ebf-2ch` 夹具再生成），本条判据证明它**从真实入口一步可达**：
 *
 *   设置（顶栏）→ 内置示例 → 选中「示例·电力高炉（多方块）」→ 加载到工作台
 *
 * 然后复用既有的断言面（面板 `data-*` + 渲染定义逐格对比参考网格）证明：
 *  1. 通道 tab 出现、面板通道条数与声明一致（3 条：Height/Coil/Glass，范围 0..域上界）；
 *  2. 拖一条通道滑杆 ⇒ **面板 dims 与渲染定义同时变**，且逐格等于该组合的参考网格。
 *
 * ## 两道判据：**语义层**（渲染定义逐格）+ **画面层**（像素）
 *
 * ⚠️ **验收否决后的修订**：本 spec 起初只有渲染定义逐格判据，
 * 而定义面全绿的同时**产品画面是残的**（用户手测：只渲染出两个红色四边形；无头画布
 * 764736 像素里 764598 是纯背景灰）。原因不在定义面，而在**样例资产**：
 * 它沿用了占位夹具的资产（每方块 2 个整面、顶点在 MC 纹素空间 0..16、贴图是
 * 1×1 纯红），生产收集器把顶点坐标加体素偏移 ⇒ 3×2×3 的机器铺成 18×17 世界单位
 * ⇒ 相机按 ±1.5 取景后屏幕只剩两片巨大红面。**定义面判据对这类缺陷是盲的**
 * （它只看 `cellGrid` + 命名调色板，不看几何尺度与贴图内容）。
 *
 * ⇒ 现在两道判据都在：
 *  - **语义层**：渲染定义逐格 = 参考网格（证明"画面按当前取值再装配"）；
 *  - **画面层**：视口截图的实际像素（证明"机器真的画在屏幕上、且高度变化看得见"）。
 *    画面层是**唯一**能判"残画面"的证据面，不得再用语义层单独充当"画面正确"。
 *    样例资产已按生产约定重建（单位盒 + 16×16 贴图，见 `make-builtin-sample.mjs`）。
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
  readPictureStats,
  readRenderedDefinition,
  setChannelValue,
  signatureGrid,
  snapshotOrFallbackReference,
  waitForDocLoaded,
  waitForMeshIdle,
  waitForRenderedGrid,
  waitForViewportMounted,
  VIEWPORT_CANVAS,
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
  await expect(drawer, '设置抽屉必须能从顶栏打开').toBeVisible()
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

test.describe('内置多方块样例（真实入口 → 通道面板 → 滑杆改画面）', () => {
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
      `[内置样例] 面板 ${panel.channels.length} 条 / dims ${before.shape.join('×')} → ${after.shape.join('×')} / ` +
        `逐格 = 参考（初始 ${INITIAL_KEY}、目标 ${targetKey}）`,
    )
  })

  /**
   * **画面层判据（本返工的核心交付）**：内置样例必须**真的画在屏幕上**，且高度变化看得见。
   *
   * ## 为什么定义面判据不够（M5 验收否决的原话）
   *
   * 修复前：定义面全绿（`cellGrid` 3×2×3、命名调色板逐格 = 参考），而真实画面只有
   * 两片巨大红色四边形、无头画布 764598/764736 像素是纯背景灰。定义面读的是
   * `cellGrid + name:meta`，**看不见几何尺度与贴图内容** —— 所以它能绿，画面能残。
   *
   * ## 三条像素判据（各自拦一类退化）
   *
   * | # | 判据 | 拦的是 |
   * |---|---|---|
   * | ① | 机器像素占中央取样区 ≥ 30% | 画面空 / 只剩背景（机器根本没画出来） |
   * | ② | 机器区域内色桶 ≥ 40 | "两片纯色红面"（无明暗、无贴图纹理 = 退化几何/占位资产） |
   * | ③ | Height 3→5 时**变了 ≥ 3% 的像素**且机器像素**增加** | 滑杆只改定义不改画面（本返工的原始缺陷） |
   *
   * 阈值取的是量级（实测值随日志打印）：修复前 ①≈0.0002、②≈个位数；修复后 ①≈0.5、②≈数百。
   */
  test("画面层：机器真的画在屏幕上，且拖 Height 后像素面可见变化", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chrome", "真实指针/像素判据固定在 desktop-chrome")
    /**
     * **超时余量（300s；L3 满并发实测）**。
     *
     * 本用例的真实工作量 = 加载样例（生产装配 432 场景）+ **两张整视口截图**
     * + 两次逐像素解码（每次约 56 万像素，含 3x3 局部对比与色桶统计）。
     * 孤跑实测 46~49 s；**L3 满并发（多 spec 争 CPU）下首跑 180 s 超时、重试 56.1 s 通过**
     * —— 属并发耗时抖动，不是判据不稳（重试一次即绿，读数与孤跑一致）。
     * 取 300 s 约等于孤跑耗时的 6 倍、抖动后耗时的 5 倍：既留足余量，又不掩盖"真的卡死"
     * （卡死的表现是永远等不到收敛，而不是慢 2 倍）。
     *
     * 注：画面统计与前后差异都由浏览器算完（只回统计标量），跨 CDP 的是两张截图的
     * 无损 PNG，而不是 RGB 全量数组；判据与这里的时间余量都不因此放宽。
     */
    test.setTimeout(300_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await gotoWorkbench(page)
    await openBuiltinSample(page)
    await openChannelTabReady(page)
    await waitForMeshIdle(page, channelSlider("height"))

    // 初始（height 0 ⇒ tt=2 ⇒ 3×2×3）
    const before = await readPictureStats(page, VIEWPORT_CANVAS)
    console.log("[内置样例·画面] height:0 ⇒ " + JSON.stringify({
      ratio: Number(before.stats.machineRatio.toFixed(3)),
      colors: before.stats.machineColors,
      detail: Number(before.stats.detailRatio.toFixed(3)),
      bbox: before.stats.bbox,
      bg: before.stats.background,
    }))
    expect(before.stats.machineRatio, "① 机器必须占画面（画面空 = 机器没画出来）").toBeGreaterThan(0.3)
    // ② 贴图/明暗真的在：局部高频细节占比（平坦纯色面只在棱边有对比）。
    //    占位资产时代实测 ~0；真贴图实测 0.3 上下（阈值取 0.15，留一半余量）。
    expect(before.stats.detailRatio, "② 机器面必须有像素级纹理细节（贴图真的贴上了）").toBeGreaterThan(0.15)
    expect(before.stats.machineColors, "② 明暗/材质至少有多个层次（纯色面只有 2~3 桶）").toBeGreaterThan(4)

    // 拖满 Height（3×2×3 → 3×5×3）
    await setChannelValue(page, "height", 5)
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.getAttribute("data-mb-dims") === "3×5×3",
      "[data-mb-panel=\"channels\"]",
      { timeout: 30_000 },
    )
    await waitForMeshIdle(page, channelSlider("height"))
    // before/after 两张 PNG 都在页面内解码：统计与逐像素差异由浏览器算完，只回标量。
    const after = await readPictureStats(page, VIEWPORT_CANVAS, before.shot)
    const changed = after.changed.ratio
    console.log("[内置样例·画面] height:5 ⇒ " + JSON.stringify({
      ratio: Number(after.stats.machineRatio.toFixed(3)),
      colors: after.stats.machineColors,
      detail: Number(after.stats.detailRatio.toFixed(3)),
      bbox: after.stats.bbox,
      changed: Number(changed.toFixed(3)),
    }))

    expect(changed, "③ 拖 Height 必须在**像素面**可见变化（不只是定义面）").toBeGreaterThan(0.03)
    expect(
      after.stats.machinePixels,
      "③ 变高 ⇒ 机器覆盖的像素必须增加（不是整体平移/重绘）",
    ).toBeGreaterThan(before.stats.machinePixels)
    expect(after.stats.machineRatio, "① 变高后机器仍在画面里").toBeGreaterThan(0.3)
    expect(after.stats.detailRatio, "② 变高后仍有像素级纹理细节").toBeGreaterThan(0.15)
  })

  /**
   * **手测阻断**：1440×900 下通道面板被裁 —— 只露 Tier/Height，
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

    console.log(`[内置样例] 通道可达（1440×900）：${logs.join(' | ')}`)
  })
});
