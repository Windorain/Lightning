/**
 * M2-4 · **呈现画面像素判据：纹理就绪前后必须真的不同，且就绪后不是白模**
 * （缺口 1；M1 复核 §3.2 #1）。
 *
 * ## 缺陷形态（M1 复核 §3.2 #1）
 *
 * 4 份 kernel spec 只截图、**零** sha/snapshot 断言（全仓 `createHash`/`toHaveScreenshot`
 * 零命中）⇒ 用户手测卡里"有真实几何、10–15 s 后有真实纹理、不是白模"这条核心观感
 * **没有任何自动判据**。
 *
 * ## 判据（B 级：真实入口 + 负对照，输入走生产装配）
 *
 * 1. 输入：`gotoWorkbench` → 生产 `OPERATOR_OPEN_SCENE` + `File`
 *    （`injectSceneDocumentOk`，夹具 `structuredata-exported-envelope.json` 原件）——
 *    不喂手工载荷。
 * 2. **就绪门是事实信号**：`data-texture-state`（M2-3 读面）。就绪前的采样只允许落在
 *    **非终态**（实测即 `loading`）上；就绪后的采样只允许落在 `ready` 上。
 *    **不用 `waitForTimeout` 当门**（#399 §7.4 末句）。
 * 3. **负对照（判据设计上体现）**：在 `loading` 期以 `'ready'` 门调 `sampleViewport`
 *    **必须被拒** —— 若哪天门失效，"把白模当就绪证据"的假绿会立刻被这条负对照抓住。
 * 4. 主断言 ①：两态像素分布**确实不同**（PNG 缓冲 sha256 + 16×16 灰度签名
 *    `pixelChangeViolations`），且两次采样的机位**逐字段相同**（差异不来自相机移动）。
 * 5. 主断言 ②：就绪后画面**非单一中性灰**（白模反义）：独特色数、彩色像素占比、
 *    最常见色占比三条互相独立的读数。
 * 6. 负对照场景：把第一项 `textureBlobs` 换成非法 base64（与
 *    `kernel-texture-progress.spec.ts` 共用同一份损坏构造）⇒ 终态可辨认
 *    （`missing`/`failed`），且**永远不会出现可采样的就绪画面** —— 与完好场景
 *    在"能不能拿到 ready 画面"这条事实上一刀两断。
 *
 * ## CRLF / 字节口径（铁律 6）
 *
 * 本文件的字节判据是**像素缓冲 sha256**（`locator.screenshot()` 返回的 PNG 字节），
 * 不是"读源码文件再正则/切片"，也**不落盘**任何快照 ⇒ 与 `core.autocrlf` 无关。
 * 断言消息里的状态时间线是 JSON（无换行敏感断言）。
 */
import { expect, test, type Page } from '@playwright/test'
import { gotoWorkbench, injectSceneDocumentOk } from './helpers/multiblock/harness'
import { blankViolations, pixelChangeViolations, signatureDiff } from './helpers/multiblock/pixels'
import { brokenFirstBlobEnvelope, fixturePath, readJson } from './helpers/saveReopen'
import {
  readLoadingSeen,
  readTextureState,
  sampleViewport,
  STATUS_BAR,
  TERMINAL_TEXTURE_STATES,
  textureStateTrace,
  traceTextureStates,
  waitTextureState,
  waitViewportLive,
  type ViewportSample,
} from './helpers/viewportPixels'

const FIXTURE = 'structuredata-exported-envelope.json'
const REGION = 'r-viewport'

interface Attempt {
  /** 采样成功时的读数。 */
  sample: ViewportSample | null
  /** 采样时刻读到的状态。 */
  state: string | null
  /** 被拒原因（门不满足 / 期间翻转 / canvas 未挂）。 */
  rejection: string | null
}

/**
 * 在**就绪之前**尽可能密集地采样（窗口实测只有约 0.9 s：t≈0.9 s loading → t≈1.8 s ready）。
 *
 * 为什么不是"等 loading 再截一张"：那要求窗口足够宽，而真实窗口是亚秒级；
 * 定长等待或单次尝试都会把判据变成"碰运气"。这里改成**事件驱动 + 全部尝试留痕**：
 * 每次尝试都记录状态与被拒原因，失败时打印完整尝试表（不假绿、也不黑箱）。
 */
async function collectPreReadySamples(
  page: Page,
  timeout = 120_000,
): Promise<{ attempts: Attempt[]; refusedReadyGate: string | null; sawLoading: boolean }> {
  const attempts: Attempt[] = []
  let refusedReadyGate: string | null = null
  let sawLoading = false
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const state = await readTextureState(page)
    if (state === 'ready') break
    if (state === 'loading' && refusedReadyGate === null) {
      // 负对照：门控采样在未就绪时必须在**截图之前**就拒绝（无副作用、开销可忽略）
      refusedReadyGate = await sampleViewport(page, REGION, ['ready'], '负对照：loading 期以 ready 门采样').then(
        () => null,
        (e: Error) => e.message,
      )
    }
    if (state === 'loading') sawLoading = true
    if (state === null) {
      attempts.push({ sample: null, state, rejection: '状态尚未写入（装载未开始）' })
      await page.waitForTimeout(20)
      continue
    }
    try {
      const sample = await sampleViewport(page, REGION, [state], `就绪前采样（${state}）`)
      attempts.push({ sample, state, rejection: null })
    } catch (e) {
      attempts.push({ sample: null, state, rejection: (e as Error).message.split('\n')[0]! })
    }
  }
  return { attempts, refusedReadyGate, sawLoading }
}

test.describe('M2-4 呈现画面：纹理就绪前后像素对照（真实入口）', () => {
  test('PX-1 白模窗口 → 就绪窗口：像素分布确实不同、就绪后非单一中性灰；未就绪不得采样当证据', async ({ page }) => {
    test.setTimeout(300_000)
    await gotoWorkbench(page)
    await expect(page.locator(STATUS_BAR), '前提：状态栏必须在页面上（data-texture-state 的宿主）').toBeVisible()
    // 装载**之前**开始记录状态变迁（失败时给出完整时间线，而不是只报超时）
    await traceTextureStates(page)

    // ── ① 生产入口：真实信封 ──
    // 采样与装载**并发**启动：白模窗口在装载返回时就可能只剩最后几十毫秒，
    // 顺序执行会让"就绪前"这一态纯靠运气（实测 retry 里就这样错过过一次）。
    const collecting = collectPreReadySamples(page)
    await injectSceneDocumentOk(page, readJson(fixturePath()), FIXTURE)

    // ── ② 就绪前的密集采样（门 = 当时的非终态，实测 loading）──
    const { attempts, refusedReadyGate, sawLoading } = await collecting
    const before = [...attempts].reverse().find((a) => a.sample !== null)?.sample ?? null
    const timeline = await textureStateTrace(page)
    expect(
      sawLoading,
      '前提：装载期必须出现 loading 态（否则"贴图前"这一态不存在，本判据无从成立）。状态时间线=' +
        JSON.stringify(timeline),
    ).toBe(true)
    expect(
      before,
      '前提：就绪前必须能采到至少一帧画面。尝试表=' +
        JSON.stringify(attempts.map((a) => ({ state: a.state, rejection: a.rejection }))),
    ).not.toBeNull()
    expect(before!.state, '前提：就绪前的采样必须落在 loading（终态之外的唯一事实态）').toBe('loading')

    // ── ③ 负对照：未就绪门未满足时**不得**采样当就绪证据 ──
    expect(refusedReadyGate, '负对照：loading 期以 ready 门采样必须被拒（否则白模会被当成就绪证据）').not.toBeNull()
    expect(refusedReadyGate!, '拒绝消息必须说清"未就绪"，便于定位').toContain('未就绪')
    expect(refusedReadyGate!, '拒绝消息必须点名实际状态 loading').toContain('loading')

    // ── ④ 等终态并核对就绪（事实信号，不猜时间）──
    const terminal = await waitTextureState(page, TERMINAL_TEXTURE_STATES, '纹理终态', 180_000)
    expect(terminal, '完好信封的终态必须是 ready（缺失/失败只应出现在负对照里）').toBe('ready')
    expect(await readLoadingSeen(page), '反假绿：必须粘性记录过 loading（真的经历了加载）').toBe('1')

    // ── ⑤ 就绪窗口采样（门 = ready）──
    const after = await sampleViewport(page, REGION, ['ready'], '就绪窗口')
    console.log(
      '[PX-1] pre samples=' + attempts.filter((a) => a.sample !== null).length +
        ' rejected=' + attempts.filter((a) => a.sample === null).length +
        ' timeline=' + JSON.stringify(timeline) +
        ' | before state=' + before!.state + ' sha=' + before!.sha256.slice(0, 12) +
        ' px=' + before!.pixels + ' uniqueColors=' + before!.stats.uniqueColors +
        ' chromatic=' + before!.chroma.chromaticRatio.toFixed(4) +
        ' dominant=' + before!.chroma.dominantColorShare.toFixed(3) +
        ' neutral=' + before!.chroma.neutralGrayRatio.toFixed(4) +
        ' | after state=' + after.state + ' sha=' + after.sha256.slice(0, 12) +
        ' px=' + after.pixels + ' uniqueColors=' + after.stats.uniqueColors +
        ' chromatic=' + after.chroma.chromaticRatio.toFixed(4) +
        ' dominant=' + after.chroma.dominantColorShare.toFixed(3) +
        ' neutral=' + after.chroma.neutralGrayRatio.toFixed(4) +
        ' stdDevLuma=' + after.stats.stdDevLuma.toFixed(2),
    )

    // ── ⑥ 差异不来自相机移动（否则"画面变了"证明不了贴图落地）──
    expect(before!.camera, '前提：就绪前的采样必须已有相机').not.toBeNull()
    expect(after.camera, '就绪窗口必须仍有相机').not.toBeNull()
    expect(after.camera, '两次采样的机位必须逐字段相同（画面差异不得来自相机移动）').toEqual(before!.camera)

    // ── ⑦ 主断言 ①：两态像素分布确实不同 ──
    expect(before!.pixels, '前提：就绪前那一帧必须有像素').toBeGreaterThan(0)
    expect(after.sha256, '① 纹理就绪前后的像素 sha256 必须不同（同一帧不可能既白模又有贴图）').not.toBe(
      before!.sha256,
    )
    const diff = signatureDiff(before!.signature, after.signature)
    console.log('[PX-1] signature diff=' + JSON.stringify(diff))
    expect(
      pixelChangeViolations(diff),
      '① 就绪前后必须是**显著**的像素变化（不是噪声级抖动）。实测 ' + JSON.stringify(diff),
    ).toEqual([])

    // ── ⑧ 主断言 ②：就绪后画面非单一中性灰（白模反义）──
    // 阈值按实测标定（两次独立运行读数见日志）：
    //   就绪前白模：uniqueColors≈78、chromatic≈0.007、neutral≈0.99
    //   就绪后贴图：uniqueColors≈399、chromatic≈0.039、neutral≈0.95
    // 取"绝对下限 + 相对跃升"两条互相独立的证人：
    //   · 绝对：白模是灰阶明暗，彩度高的像素几乎为零 ⇒ 就绪后必须 ≥0.02（实测 2 倍余量）；
    //     独特色数必须 ≥200（白模实测 78，纯灰度画面只有几十）；
    //   · 相对：就绪后的彩色比例必须 ≥ 白模的 2 倍，且中性灰占比必须**下降**
    //     （这两条把"贴图真的替换了灰模"与"画面整体变亮"区分开）。
    // 不用 dominantColorShare 当证人：视口背景占画面大多数（实测两态都≈0.80），
    // 它没有区分力（本文件如实登记，不拿一个恒定的数当证据）。
    expect(
      after.stats.uniqueColors,
      '② 就绪后画面必须有丰富的颜色（5bit 量化独特色数；白模/纯色画面只有几十）',
    ).toBeGreaterThanOrEqual(200)
    expect(
      after.stats.uniqueColors,
      '② 贴图落地必须真的增加颜色种类（就绪 > 白模 2 倍以上）',
    ).toBeGreaterThan(before!.stats.uniqueColors * 2)
    expect(
      after.chroma.chromaticRatio,
      '② 就绪后必须有可观比例的**彩色**像素（彩度>16 且亮度>20）；白模是灰阶明暗 ⇒ 该值≈0',
    ).toBeGreaterThanOrEqual(0.02)
    expect(
      after.chroma.chromaticRatio,
      '② 就绪后的彩色比例必须 ≥ 白模的 2 倍（否则"非白模"无从谈起）',
    ).toBeGreaterThanOrEqual(Math.max(before!.chroma.chromaticRatio * 2, 0.02))
    expect(
      after.chroma.neutralGrayRatio,
      '② 中性灰像素占比必须**下降**（贴图替换了灰模；仅整体提亮不会让它降）',
    ).toBeLessThan(before!.chroma.neutralGrayRatio)
  })

  test('PX-2 负对照：损坏一张贴图 ⇒ 终态可辨认，且永远不会出现可采样的就绪画面', async ({ page }) => {
    test.setTimeout(420_000)
    await gotoWorkbench(page)
    await expect(page.locator(STATUS_BAR)).toBeVisible()

    // ── 完好场景：终态 ready + 就绪采样（对照基准）──
    await injectSceneDocumentOk(page, readJson(fixturePath()), FIXTURE)
    expect(await waitTextureState(page, TERMINAL_TEXTURE_STATES, '完好场景终态', 180_000)).toBe('ready')
    await waitViewportLive(page, REGION)
    const intact = await sampleViewport(page, REGION, ['ready'], '完好场景（对照基准）')
    expect(blankViolations(intact.stats), '前提：完好场景必须真的画出画面').toEqual([])

    // ── 坏一张：同一入口、同一份损坏构造（与状态栏判据共用）──
    await gotoWorkbench(page)
    await injectSceneDocumentOk(page, brokenFirstBlobEnvelope(), FIXTURE)
    const brokenState = await waitTextureState(page, TERMINAL_TEXTURE_STATES, '损坏场景终态', 180_000)
    expect(brokenState, '负对照：坏一张的终态必须是 missing/failed（不得报成就绪）').toMatch(/^(missing|failed)$/)

    // ── 与完好场景可区分（事实级，不靠像素巧合）──
    expect(brokenState, '损坏场景的终态必须与完好场景不同').not.toBe(intact.state)
    expect(await readTextureState(page), '终态必须稳定（不是一闪而过的读数）').toBe(brokenState)

    // ── 损坏场景拿不到 ready 画面：ready 门永远不满足 ──
    const refused = await sampleViewport(page, REGION, ['ready'], '负对照：损坏场景以 ready 门采样').then(
      () => null,
      (e: Error) => e.message,
    )
    expect(refused, '负对照：损坏场景**不得**有任何可当作就绪画面证据的采样').not.toBeNull()
    expect(refused!, '拒绝消息必须点名未就绪与实际状态').toContain('未就绪')
    expect(refused!, '拒绝消息必须带上实际终态').toContain(brokenState)

    // ── 画面侧事实：损坏场景连视口都没有挂上（见本文件末的观测登记）──
    const mounted = await page.evaluate(() => document.querySelectorAll('.vc-viewport').length)
    console.log(
      '[PX-2] intact state=' + intact.state + ' sha=' + intact.sha256.slice(0, 12) +
        ' chromatic=' + intact.chroma.chromaticRatio.toFixed(4) +
        ' uniqueColors=' + intact.stats.uniqueColors +
        ' | broken state=' + brokenState + ' canvasCount=' + mounted,
    )
    expect(mounted, '观测登记：缺一张贴图时视口不挂载 ⇒ 损坏场景根本没有 canvas 可采样（见文件末说明）').toBe(0)
  })
})