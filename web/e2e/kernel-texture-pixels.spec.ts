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
    // 阈值按**实测**标定（两个 project 各跑过，读数见日志与提交说明）：
    //   桌面：白模 uniqueColors=78 chromatic=0.0072 neutral=0.9924
    //         就绪 uniqueColors=402 chromatic=0.0385 neutral=0.9436
    //   窄视口：白模 uniqueColors=73 chromatic=0.0014 neutral=0.9985
    //           就绪 uniqueColors=285 chromatic=0.0064 neutral=0.9907
    // ⇒ **绝对**彩色占比不可跨视口（宽/窄白模 0.0072 vs 0.0014，窄视口就绪 0.0064
    //   低于桌面白模 0.0072），故只用它做**同视口内的相对**比较；
    //   绝对的"非单一中性灰"由**独特色数**承担（白模 73–78，就绪 285–402）。
    // 不用 dominantColorShare 当证人：视口背景占画面多数（两态都≈0.80/0.97），
    // 没有区分力（如实登记，不拿一个恒定的数当证据）。
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
      '② 就绪后必须**有**彩色像素（彩度>16 且亮度>20）；白模是灰阶明暗 ⇒ 该值≈0',
    ).toBeGreaterThanOrEqual(0.004)
    expect(
      after.chroma.chromaticRatio,
      '② 就绪后的彩色比例必须 ≥ 白模的 2 倍（否则"非白模"无从谈起）',
    ).toBeGreaterThanOrEqual(Math.max(before!.chroma.chromaticRatio * 2, 0.004))
    expect(
      after.chroma.neutralGrayRatio,
      '② 中性灰像素占比必须**下降**（贴图替换了灰模；仅整体提亮不会让它降）',
    ).toBeLessThan(before!.chroma.neutralGrayRatio)
  })

  test('PX-2 负对照：损坏一张贴图 ⇒ 终态可辨认、无就绪采样，且**视口仍挂载**（Q1：资源失败不夺视口）', async ({ page }) => {
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

    // ── 画面侧事实：视口**仍在**，但状态不是 ready（Q1；见下方断言与说明）──
    const mounted = await page.evaluate(() => document.querySelectorAll('.vc-viewport').length)
    console.log(
      '[PX-2] intact state=' + intact.state + ' sha=' + intact.sha256.slice(0, 12) +
        ' chromatic=' + intact.chroma.chromaticRatio.toFixed(4) +
        ' uniqueColors=' + intact.stats.uniqueColors +
        ' | broken state=' + brokenState + ' canvasCount=' + mounted,
    )
    /**
     * ## 画面形态（M8-5 / Q1 定稿：**资源失败不夺视口**）
     *
     * 旧形态（S0-B D2 实测）：缺一张贴图 ⇒ legacy 材质库整库 reject ⇒
     * `loadStatus='error'` ⇒ **视口不挂载**，本行当时断言 `mounted === 0`。
     * Q1 裁决后形态反过来了：受影响图元以占位呈现、其余照常显示。
     *
     * ⇒ 本行改写为**更强**的一组事实（而不是删掉）：视口必须挂载，且"有贴图的材质"
     * 与"被降级（无 map）的材质"同时存在 —— 后者证明占位真的发生了，
     * 而不是"把坏图当没发生"或"整幅变平"。
     *
     * 「永远不出现可当作就绪画面的采样」这一条**不变**（上面 ready 门的拒绝仍在）：
     * 视口在，但它的状态**不是 ready**。
     */
    const form = (await page.evaluate(() => {
      const vm = (window as any).__vm__
      const surface = vm?.viewports?.get?.('r-viewport')?.presenterSurface ?? null
      let mapped = 0
      let degraded = 0
      try {
        surface?.object3d?.traverse?.((o: any) => {
          if (o?.isMesh !== true && o?.isInstancedMesh !== true) return
          const m = Array.isArray(o.material) ? undefined : o.material
          if (m === undefined || m === null) return
          if (m.map === null || m.map === undefined) degraded += 1
          else mapped += 1
        })
      } catch {
        /* 读面失败按 0 计（会让判据红，不静默变绿） */
      }
      return { mounted: document.querySelectorAll('.vc-viewport').length, mapped, degraded }
    })) as { mounted: number; mapped: number; degraded: number }
    expect(mounted, '⚠️ Q1：缺一张贴图**不得**夺走视口（旧形态 mounted===0）').toBeGreaterThan(0)
    expect(form.degraded, '⚠️ Q1：占位必须可观测 —— 至少一个材质因缺图而没有 map').toBeGreaterThan(0)
    expect(form.mapped, '其余内容照常显示 —— 至少一个材质仍然带 map').toBeGreaterThan(0)
    console.log('[PX-2·form] mounted=' + form.mounted + ' mapped=' + form.mapped + ' degraded=' + form.degraded)
  })
})