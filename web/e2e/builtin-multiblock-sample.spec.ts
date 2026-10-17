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
 * ## 两道判据：**语义层**（渲染定义逐格）+ **画面层**（像素）
 *
 * ⚠️ **M5 验收否决后的修订（2026-10-18）**：本 spec 起初只有渲染定义逐格判据，
 * 而定义面全绿的同时**产品画面是残的**（用户手测：只渲染出两个红色四边形；无头画布
 * 764736 像素里 764598 是纯背景灰）。原因不在定义面，而在**样例资产**：
 * 它沿用了 T0.5 夹具的占位资产（每方块 2 个整面、顶点在 MC 纹素空间 0..16、贴图是
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

/** 视口画面的像素统计（**画面层判据**的观测面）。 */
interface PictureStats {
  readonly width: number
  readonly height: number
  /** 中央取样面积（排除左侧工具栏 / 右下 HUD 等 DOM 覆盖物）。 */
  readonly sampled: number
  /** 与背景色差异 > 门限的像素数（= 机器占了多少画面）。 */
  readonly machinePixels: number
  readonly machineRatio: number
  /** 机器区域内 5bit/通道量化后的**独特色桶数**（两片纯色红面会极低）。 */
  readonly machineColors: number
  /**
   * **纹理细节像素**：机器区域内局部（3x3）亮度极差 > 12 的像素数。
   *
   * 这是"贴图真的贴上了"的判据：平坦纯色面只在棱边有对比，而 16x16 像素纹理
   * 在面内部就有大量高频细节（占位资产时代实测 ~0；真贴图实测占机器像素 20%~40%）。
   */
  readonly detailPixels: number
  readonly detailRatio: number
  /** 机器区域包围盒（画面坐标；变高的方向性证据）。 */
  readonly bbox: readonly [number, number, number, number]
  /** 背景色（取自右上角空白带的中位色）。 */
  readonly background: readonly [number, number, number]
  /** 逐像素 RGB（供前后对比）。 */
  readonly rgb: number[]
}

/**
 * 截图 → 画面统计。**全部在浏览器内解码**（仓库无 PNG 解码依赖，与 `pixels.ts` 同一手法）。
 *
 * 取样口径（防两类假读数）：
 *  - 中央区 x∈[22%,88%] × y∈[10%,90%]：排除左侧竖排工具栏与右下操作提示（DOM 覆盖物）；
 *  - 背景色取**右上角**空白带的中位色（相机取景把机器放在中央，右上恒为场景背景）；
 *  - 机器掩码 = 任一通道与背景差 > 14（场景背景是纯色 0x5a5a5a，无渐变）。
 */
async function readPictureStats(page: Page): Promise<PictureStats> {
  const png = await page.locator(VIEWPORT_CANVAS).first().screenshot()
  const b64 = png.toString("base64")
  return await page.evaluate(async (payload: string) => {
    const img = new Image()
    img.src = "data:image/png;base64," + payload
    await img.decode()
    const w = img.naturalWidth
    const h = img.naturalHeight
    const cv = document.createElement("canvas")
    cv.width = w
    cv.height = h
    const g = cv.getContext("2d", { willReadFrequently: true })!
    g.drawImage(img, 0, 0)
    const { data } = g.getImageData(0, 0, w, h)
    const rgb: number[] = new Array(w * h * 3)
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      rgb[j] = data[i]!
      rgb[j + 1] = data[i + 1]!
      rgb[j + 2] = data[i + 2]!
    }
    const at = (x: number, y: number): [number, number, number] => {
      const i = (y * w + x) * 3
      return [rgb[i]!, rgb[i + 1]!, rgb[i + 2]!]
    }
    const chans: number[][] = [[], [], []]
    for (let y = Math.floor(h * 0.04); y < Math.floor(h * 0.10); y += 2) {
      for (let x = Math.floor(w * 0.9); x < Math.floor(w * 0.96); x += 2) {
        const [r, gg, b] = at(x, y)
        chans[0]!.push(r)
        chans[1]!.push(gg)
        chans[2]!.push(b)
      }
    }
    const median = (xs: number[]): number => {
      const s = [...xs].sort((p2, q) => p2 - q)
      return s[Math.floor(s.length / 2)] ?? 0
    }
    const background: [number, number, number] = [median(chans[0]!), median(chans[1]!), median(chans[2]!)]

    const TOL = 14
    const x0 = Math.floor(w * 0.22)
    const x1 = Math.floor(w * 0.88)
    const y0 = Math.floor(h * 0.1)
    const y1 = Math.floor(h * 0.9)
    let sampled = 0
    let machinePixels = 0
    let minX = w
    let minY = h
    let maxX = -1
    let maxY = -1
    const seen = new Uint8Array(32 * 32 * 32)
    let machineColors = 0
    let detailPixels = 0
    const lumaOf = (x: number, y: number): number => {
      const [r, gg, b] = at(x, y)
      return 0.2126 * r + 0.7152 * gg + 0.0722 * b
    }
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        sampled++
        const [r, gg, b] = at(x, y)
        const diff = Math.max(Math.abs(r - background[0]), Math.abs(gg - background[1]), Math.abs(b - background[2]))
        if (diff <= TOL) continue
        machinePixels++
        // 局部对比（3x3 内 luma 极差）：纹理与棱边的证据。
        if (x > x0 && y > y0 && x + 1 < x1 && y + 1 < y1) {
          let minL = 255
          let maxL = 0
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const l = lumaOf(x + dx, y + dy)
              if (l < minL) minL = l
              if (l > maxL) maxL = l
            }
          }
          if (maxL - minL > 12) detailPixels++
        }
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
        const key = ((r >> 3) << 10) | ((gg >> 3) << 5) | (b >> 3)
        if (seen[key] === 0) {
          seen[key] = 1
          machineColors++
        }
      }
    }
    return {
      width: w,
      height: h,
      sampled,
      machinePixels,
      machineRatio: machinePixels / Math.max(1, sampled),
      machineColors,
      detailPixels,
      detailRatio: detailPixels / Math.max(1, machinePixels),
      bbox: [minX, minY, maxX, maxY] as [number, number, number, number],
      background,
      rgb,
    }
  }, b64)
}

/** 两张画面的逐像素差异比例（任一分量差 > 24 记一个变了的像素）。 */
async function changedPixelRatio(page: Page, a: PictureStats, b: PictureStats): Promise<number> {
  return await page.evaluate(
    ({ pa, pb }: { pa: number[]; pb: number[] }) => {
      const n = Math.min(pa.length, pb.length)
      let changed = 0
      for (let i = 0; i < n; i += 3) {
        const d =
          Math.abs(pa[i]! - pb[i]!) +
          Math.abs(pa[i + 1]! - pb[i + 1]!) +
          Math.abs(pa[i + 2]! - pb[i + 2]!)
        if (d > 24) changed++
      }
      return changed / Math.max(1, n / 3)
    },
    { pa: a.rgb, pb: b.rgb },
  )
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
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await gotoWorkbench(page)
    await openBuiltinSample(page)
    await openChannelTabReady(page)
    await waitForMeshIdle(page, channelSlider("height"))

    // 初始（height 0 ⇒ tt=2 ⇒ 3×2×3）
    const before = await readPictureStats(page)
    console.log("[M5-5·画面] height:0 ⇒ " + JSON.stringify({
      ratio: Number(before.machineRatio.toFixed(3)),
      colors: before.machineColors,
      detail: Number(before.detailRatio.toFixed(3)),
      bbox: before.bbox,
      bg: before.background,
    }))
    expect(before.machineRatio, "① 机器必须占画面（画面空 = 机器没画出来）").toBeGreaterThan(0.3)
    // ② 贴图/明暗真的在：局部高频细节占比（平坦纯色面只在棱边有对比）。
    //    占位资产时代实测 ~0；真贴图实测 0.3 上下（阈值取 0.15，留一半余量）。
    expect(before.detailRatio, "② 机器面必须有像素级纹理细节（贴图真的贴上了）").toBeGreaterThan(0.15)
    expect(before.machineColors, "② 明暗/材质至少有多个层次（纯色面只有 2~3 桶）").toBeGreaterThan(4)

    // 拖满 Height（3×2×3 → 3×5×3）
    await setChannelValue(page, "height", 5)
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.getAttribute("data-mb-dims") === "3×5×3",
      "[data-mb-panel=\"channels\"]",
      { timeout: 30_000 },
    )
    await waitForMeshIdle(page, channelSlider("height"))
    const after = await readPictureStats(page)
    const changed = await changedPixelRatio(page, before, after)
    console.log("[M5-5·画面] height:5 ⇒ " + JSON.stringify({
      ratio: Number(after.machineRatio.toFixed(3)),
      colors: after.machineColors,
      detail: Number(after.detailRatio.toFixed(3)),
      bbox: after.bbox,
      changed: Number(changed.toFixed(3)),
    }))

    expect(changed, "③ 拖 Height 必须在**像素面**可见变化（不只是定义面）").toBeGreaterThan(0.03)
    expect(
      after.machinePixels,
      "③ 变高 ⇒ 机器覆盖的像素必须增加（不是整体平移/重绘）",
    ).toBeGreaterThan(before.machinePixels)
    expect(after.machineRatio, "① 变高后机器仍在画面里").toBeGreaterThan(0.3)
    expect(after.detailRatio, "② 变高后仍有像素级纹理细节").toBeGreaterThan(0.15)
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
