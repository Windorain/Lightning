/**
 * **内置动态贴图样例**（产品入口 → 播放 → GIF）。
 *
 * ## 为什么需要第二份样例
 *
 * M5 验收要手测「动态贴图在视口里播放」和「GIF 导出会动」。实测两份既有样例
 * （`builtin-multiblock-ebf.json` 与 `export.json`）的 `materialPalette[].animation` 命中 **0**
 * ⇒ 只有它们时，手测永远看不到动画。本 spec 打开 `builtin-animated-texture`（16×64 四色竖条，
 * 4 帧声明；由 `scripts/multiblock-fixtures/make-animated-sample.mjs` 从既有的
 * `texture-strip-animated.v2.json` 再生成、扩成 3 个世界帧），证明：
 *
 *  1. **视口播放时纹理样本真的换帧**（`presenterSurface.textureSamples()` 的 `frame` 变化，
 *     不是只改 UI 状态）；
 *  2. **GIF 导出的相邻帧像素不同**（WebCodecs 逐帧解码，测试侧独立于生产编码器）；
 *  3. 暂停后样本不漂（没有视口自己累加 tick）。
 *
 * ## 期望值从哪来
 *
 * 样例的动画声明 = `defaultFrametimeTicks: 2` + `frameSequence [{0},{1,3},{2,1},{3,2}]`
 * ⇒ 逐帧 2/3/1/2 tick = 100/150/50/100 ms ⇒ GIF 4 帧、delayCs `[10,15,5,10]`、总 400 ms。
 * 这些数字**硬编码**在这里（不读被测实现）。
 *
 * desktop-only：顶栏设置入口 / 导出卡固定在桌面工作台。
 */
import { expect, test } from '@playwright/test'
import {
  gotoWorkbench,
  PLAYBACK_BUTTON,
  VIEWPORT_REGION,
  VIEWPORT_CANVAS,
  waitForDocLoaded,
  waitForRenderedGrid,
  waitForViewportMounted,
} from './helpers/multiblock'
import { parseGif } from './helpers/export/gifBytes'

const SAMPLE_SCENE_ID = 'builtin-animated-texture'
const SAMPLE_DISPLAY_NAME = '示例·动态贴图'

/** 声明侧期望（不读被测实现）。 */
const EXPECTED = Object.freeze({ frameCount: 4, delayCs: [10, 15, 5, 10] as readonly number[], totalMs: 400 })

interface SampleReport {
  readonly assetId: string
  readonly seconds: number
  readonly frame: number
  readonly nextFrame: number
  readonly mix: number
  readonly stripFrameCount: number
  readonly offsetY: number
  readonly repeatY: number
}

async function readSamples(page: import('@playwright/test').Page): Promise<{ samples: SampleReport[]; playing: boolean; seconds: number }> {
  return (await page.evaluate((region: string) => {
    const ctx = (window as any).__vm__
    const surface = ctx?.viewports?.get(region)?.presenterSurface ?? null
    const playback = ctx.requireKernelSession().playback()
    return {
      samples: surface === null ? [] : JSON.parse(JSON.stringify(surface.textureSamples() ?? [])),
      playing: playback?.playing === true,
      seconds: typeof playback?.time?.frame === 'number' ? playback.time.frame : Number.NaN,
    }
  }, VIEWPORT_REGION)) as { samples: SampleReport[]; playing: boolean; seconds: number }
}

/** 打开内置动态样例（真实入口：设置 → 内置示例 → 加载）。 */
async function openAnimatedSample(page: import('@playwright/test').Page): Promise<void> {
  await gotoWorkbench(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const drawer = page.locator('.drawer-panel')
  await expect(drawer).toBeVisible()
  await drawer.getByRole('button', { name: '内置示例', exact: true }).click()
  const select = drawer.locator('select')
  await expect(select.locator(`option[value="${SAMPLE_SCENE_ID}"]`)).toHaveText(SAMPLE_DISPLAY_NAME)
  await select.selectOption(SAMPLE_SCENE_ID)
  await drawer.getByRole('button', { name: '加载到工作台' }).click()
  await waitForDocLoaded(page)
  await waitForViewportMounted(page)
  await waitForRenderedGrid(page)
  await drawer.getByRole('button', { name: '关闭' }).click()
  await expect(drawer).toBeHidden()
}

test.describe('内置动态贴图样例（播放 → 换帧 / GIF 相邻帧不同）', () => {
  test('真实入口加载 ⇒ 播放时 textureSamples 换帧、暂停不漂、GIF 相邻帧像素不同', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', '设置入口与导出卡固定在 desktop-chrome')
    test.setTimeout(240_000)
    await openAnimatedSample(page)

    // ── 1. 样本存在且从第 0 帧开始（4 格竖条） ─────────────────────────────
    await expect(page.locator(VIEWPORT_CANVAS)).toBeVisible()
    const initial = await readSamples(page)
    expect(initial.samples.length, '视口必须有纹理样本（没有样本 = 样例根本没接动画）').toBeGreaterThan(0)
    const s0 = initial.samples[0]!
    expect(s0.stripFrameCount, '竖条格数 = 16×64 / 16').toBe(EXPECTED.frameCount)
    expect(s0.repeatY, '竖条裁切必须生效（repeat.y = 1/N）').toBeCloseTo(1 / EXPECTED.frameCount, 5)
    expect(s0.frame, 't=0 ⇒ 第 0 帧').toBe(0)
    expect(s0.offsetY, '第 0 帧在顶点 ⇒ offset.y = 0').toBeCloseTo(0, 5)

    // ── 2. 播放：帧读数必须真的变（不是只改 UI） ────────────────────────────
    const playBtn = page.locator(PLAYBACK_BUTTON)
    await expect(playBtn, '多帧文档必须有播放按钮（单帧文档没有帧控制 tab）').toBeVisible()
    await playBtn.click()
    await expect(playBtn).toHaveAttribute('aria-pressed', 'true')

    const seen = new Set<number>()
    let advanced = initial.seconds
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && seen.size < 2) {
      const r = await readSamples(page)
      advanced = r.seconds
      for (const s of r.samples) if (s.assetId === s0.assetId) seen.add(s.frame)
      await page.waitForTimeout(80)
    }
    expect(seen.size, `播放期必须观察到多个纹理帧（实测 ${[...seen].join(',')}）`).toBeGreaterThan(1)
    expect(advanced, '场景时间必须真的推进').toBeGreaterThan(initial.seconds)

    // ── 3. 暂停：样本不漂（没有视口自持 tick） ─────────────────────────────
    await playBtn.click()
    await expect(playBtn).toHaveAttribute('aria-pressed', 'false')
    const paused = await readSamples(page)
    await page.waitForTimeout(500)
    const stillPaused = await readSamples(page)
    expect(stillPaused.samples, '暂停后纹理样本必须逐字段停住').toEqual(paused.samples)

    // ── 4. GIF：真实导出 + 测试侧逐帧解码 ──────────────────────────────────
    await page.click('.wt-tab:has-text("导出")')
    await page.waitForSelector('.ew-root', { timeout: 20_000 })
    await page.locator('[data-make-gif]').click()
    const planText = page.locator('[data-gif-plan]')
    await expect(planText, '生成成功后卡片必须给出帧数/总时长').toBeVisible({ timeout: 60_000 })
    const plan = (await planText.textContent()) ?? ''
    expect(plan, `UI 声明帧数必须是 ${EXPECTED.frameCount}`).toContain(`${EXPECTED.frameCount} 帧`)
    expect(plan, `UI 声明总时长必须是 ${(EXPECTED.totalMs / 1000).toFixed(3)} s`).toContain(
      `${(EXPECTED.totalMs / 1000).toFixed(3)} s`,
    )

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 90_000 }),
      page.locator('[data-download-gif]').click(),
    ])
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    const bytes = Buffer.concat(chunks)
    expect(bytes.length, 'GIF 必须是真实字节').toBeGreaterThan(50)

    const gif = parseGif(new Uint8Array(bytes))
    expect(gif.header).toBe('GIF89a')
    expect(gif.imageCount, '帧数必须 == 声明').toBe(EXPECTED.frameCount)
    expect(gif.delaysCs, '逐帧 delay 必须 == 声明（2/3/1/2 tick ⇒ [10,15,5,10]）').toEqual([...EXPECTED.delayCs])

    // 相邻帧像素必须不同（渲染一次复制 N 帧的实现会在这里判红）。
    const framesDiff = await page.evaluate(async (data: string) => {
      const bin = atob(data)
      const u8 = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
      const dec = new (window as any).ImageDecoder({ data: u8, type: 'image/gif' })
      await dec.tracks.ready
      const count = dec.tracks.selectedTrack?.frameCount ?? 0
      if (count < 2) return { count, differentPixels: -1, totalPixels: 0 }
      const grab = async (index: number): Promise<Uint8ClampedArray> => {
        const { image } = await dec.decode({ frameIndex: index })
        const canvas = document.createElement('canvas')
        canvas.width = image.displayWidth
        canvas.height = image.displayHeight
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(image, 0, 0)
        image.close()
        return ctx.getImageData(0, 0, canvas.width, canvas.height).data
      }
      const a = await grab(0)
      const b = await grab(1)
      let differentPixels = 0
      const totalPixels = a.length / 4
      for (let i = 0; i < totalPixels; i++) {
        const off = i * 4
        const d = Math.abs(a[off]! - b[off]!) + Math.abs(a[off + 1]! - b[off + 1]!) + Math.abs(a[off + 2]! - b[off + 2]!)
        if (d > 24) differentPixels += 1
      }
      dec.close()
      return { count, differentPixels, totalPixels }
    }, bytes.toString('base64'))
    expect(framesDiff.count, 'WebCodecs 必须解出全部帧').toBe(EXPECTED.frameCount)
    expect(framesDiff.differentPixels, 'GIF 相邻帧像素必须真的不同').toBeGreaterThan(0)

    console.log(
      `[内置动态贴图] 动态样例：竖条 ${s0.stripFrameCount} 帧 / 播放观察到帧 {${[...seen].join(',')}} / ` +
        `GIF ${gif.imageCount} 帧 delay ${JSON.stringify(gif.delaysCs)} / 相邻帧差异像素 ${framesDiff.differentPixels}`,
    )
  })
})
