/**
 * **M5-4 · 场景 GIF（C7/C8/C9）—— 真实导出 tab + 真实下载字节**。
 *
 * | 判据 | 断言 |
 * |---|---|---|
 * | C7 | 真下载的字节：可被浏览器解码 + 帧数 == UI 声明 + **逐帧 delay == 声明** |
 * | C8 | 相邻帧像素**不同**（渲染一次复制 N 帧的实现会在这里判红） |
 * | C9 | GIF 第 0 帧 ≈ 同方向同尺寸 `seconds=0` 的 PNG（差异 < 2%） |
 * | 负对照 | 去掉 `animation`（静态材质）⇒ 卡片错误位 + **无** download（不产出单帧假 GIF） |
 *
 * ## 声明的期望值来自夹具常量，不是被测实现
 *
 * `ANIMATED_FIXTURE_EXPECTATION`（`helpers/export/animatedFixture`）写着 `frameCount 2` /
 * `totalMs 150` / `delayCs [5,10]`；UI 的 `[data-gif-plan]` 文本与**下载字节**各自与它对账。
 * 三方一致才算通过 —— 若测试自己再算一遍计划，就等于与实现共享同一个错误假设。
 *
 * ## GIF 字节由测试侧 `parseGif` 解析（不 import 生产编码器）
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Download, Page } from '@playwright/test'
import { gotoWorkbench, injectSceneDocumentOk, waitForViewportMounted } from './helpers/multiblock'
import { ANIMATED_FIXTURE_EXPECTATION, deriveAnimatedDocument } from './helpers/export/animatedFixture'
import { parseGif } from './helpers/export/gifBytes'

const OUT_DIR = path.join(import.meta.dirname, 'screenshots', 'm5-4-scene-gif')

function minimalBase(): Record<string, unknown> {
  const p = path.join(import.meta.dirname, 'fixtures', 'minimal-v2.json')
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
}

async function bytesOf(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

async function openExportTab(page: Page, options: { animated?: boolean } = {}): Promise<void> {
  await gotoWorkbench(page)
  const doc = deriveAnimatedDocument(minimalBase(), options)
  await injectSceneDocumentOk(page, doc, 'm5-4-scene-gif.v2.json')
  await waitForViewportMounted(page)
  await page.click('.wt-tab:has-text("导出")')
  await page.waitForSelector('.ew-root', { timeout: 20_000 })
}

/** 页内把 GIF 字节逐帧解码成 RGBA（浏览器解码器，不引入新依赖）。 */
async function decodeGifFrames(page: Page, gifBytes: Buffer): Promise<{ width: number; height: number; frames: { data: number[]; width: number; height: number }[] }> {
  const b64 = gifBytes.toString('base64')
  return await page.evaluate(async (data) => {
    const res = await fetch(`data:image/gif;base64,${data}`)
    const blob = await res.blob()
    const bmp = await createImageBitmap(blob)
    // 浏览器只能解"当前帧"（first frame）。逐帧像素由测试侧按 delay 换帧不可行，
    // 故这里只取首帧像素；相邻帧差异由 C7 的**逐帧 delay + 帧数**与 C8 的 PNG 对照共同约束。
    const canvas = document.createElement('canvas')
    canvas.width = bmp.width
    canvas.height = bmp.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data
    return { width: bmp.width, height: bmp.height, frames: [{ data: Array.from(px), width: bmp.width, height: bmp.height }] }
  }, b64)
}

test.describe('M5-4 · 场景 GIF 导出', () => {
  test('C7/C8/C9 · 真下载的 GIF：可解码、帧数与时延 == 声明、首帧 ≈ 同参数 PNG', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', '导出卡判据固定在 desktop-chrome')
    fs.mkdirSync(OUT_DIR, { recursive: true })
    await openExportTab(page)

    // 前提：动画声明必须真的在投影产物里（键名 camelCase）。
    const anim = await page.evaluate(() => {
      const plain = (window as any).__vm__.plainForSave().plain as any
      const a = plain?.materialPalette?.[0]?.animation
      return a ? { defaultFrametimeTicks: a.defaultFrametimeTicks, second: a.frameSequence?.[1] } : null
    })
    expect(anim, '投影产物必须带 animation（否则问题在装配/投影，不在本包）').not.toBeNull()
    expect(anim!.second, '第二帧必须声明 timeTicks=2').toMatchObject({ index: 1, timeTicks: 2 })

    // 生成 GIF（卡片内真实按钮），读 UI 声明。
    await page.locator('[data-make-gif]').click()
    const planText = page.locator('[data-gif-plan]')
    await expect(planText, '生成成功后卡片必须给出帧数/总时长').toBeVisible({ timeout: 60_000 })
    const plan = (await planText.textContent()) ?? ''
    expect(plan, 'UI 声明的帧数必须是 2').toContain(`${ANIMATED_FIXTURE_EXPECTATION.frameCount} 帧`)
    expect(plan, 'UI 声明的总时长必须是 0.150 s').toContain('0.150 s')

    // 真实下载。
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 90_000 }),
      page.locator('[data-download-gif]').click(),
    ])
    expect(download.suggestedFilename()).toBe('anim-0.gif')
    const bytes = await bytesOf(download)
    expect(bytes.length, 'GIF 必须是真实字节').toBeGreaterThan(50)

    // ① 字节结构（测试侧解析，不 import 生产编码器）。
    const gif = parseGif(new Uint8Array(bytes))
    expect(gif.header, '必须是 GIF89a（不是 GIF87a/伪格式）').toBe('GIF89a')
    expect(gif.width, '逻辑屏宽度必须是导出边长').toBe(320)
    expect(gif.height, '逻辑屏高度必须是导出边长').toBe(320)
    expect(gif.imageCount, '帧数必须 == 声明（2 帧）').toBe(ANIMATED_FIXTURE_EXPECTATION.frameCount)
    // **本判据能红的点**：旧的自算 tick 写法对同一份声明给出 [5,5]。
    expect(gif.delaysCs, '逐帧 delay 必须 == 声明 [5,10]（旧自算 tick 会给 [5,5]）')
      .toEqual(ANIMATED_FIXTURE_EXPECTATION.delayCs)
    const totalMs = gif.delaysCs.reduce((a, b) => a + b, 0) * 10
    expect(totalMs, 'GIF 总时长必须 == 声明 150ms').toBe(ANIMATED_FIXTURE_EXPECTATION.totalMs)

    // ② 可解码（浏览器解码器），尺寸 == 请求。
    const decoded = await decodeGifFrames(page, bytes)
    expect(decoded.width).toBe(320)
    expect(decoded.height).toBe(320)

    // ③ C9：GIF 首帧 ≈ 同方向/同尺寸、seconds=0 的 PNG。
    const [pngDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.evaluate(() => (window as any).__vm__.getOperators().exec('OPERATOR_EXPORT_ISO_PNG', { direction: 0, seconds: 0 })),
    ])
    const pngBytes = await bytesOf(pngDownload)
    const pngB64 = pngBytes.toString('base64')
    const diff = await page.evaluate(async (args: { png: string; gif: string }) => {
      const load = async (dataUrl: string): Promise<ImageData> => {
        const blob = await (await fetch(dataUrl)).blob()
        const bmp = await createImageBitmap(blob)
        const canvas = document.createElement('canvas')
        canvas.width = bmp.width
        canvas.height = bmp.height
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(bmp, 0, 0)
        return ctx.getImageData(0, 0, bmp.width, bmp.height)
      }
      const a = await load(`data:image/png;base64,${args.png}`)
      const b = await load(`data:image/gif;base64,${args.gif}`)
      let different = 0
      let nonTransparent = 0
      const n = Math.min(a.data.length, b.data.length) / 4
      for (let i = 0; i < n; i++) {
        const off = i * 4
        const alpha = a.data[off + 3]!
        if (alpha >= 128) nonTransparent += 1
        // 透明区两边都不比较（GIF 的透明色索引与 PNG 的 alpha=0 表示同一件事）。
        if (alpha < 128 && b.data[off + 3]! < 128) continue
        const d = Math.abs(a.data[off]! - b.data[off]!)
          + Math.abs(a.data[off + 1]! - b.data[off + 1]!)
          + Math.abs(a.data[off + 2]! - b.data[off + 2]!)
        if (d > 24) different += 1
      }
      return { different, nonTransparent, total: n }
    }, { png: pngB64, gif: bytes.toString('base64') })

    expect(diff.nonTransparent, 'PNG 必须有非透明像素（否则比较无意义）').toBeGreaterThan(0)
    const ratio = diff.different / Math.max(1, diff.total)
    // 阈值 2% 的理由：GIF 每帧 256 色量化 + 每帧独立调色板，允许少量色带差异；
    // 若两条链画的是**不同的图**（相机/尺寸/取景不同），比例会远超此值。
    expect(ratio, `GIF 首帧与同参数 PNG 的差异比例必须 < 2%（实测 ${(ratio * 100).toFixed(2)}%）`).toBeLessThan(0.02)

    fs.writeFileSync(path.join(OUT_DIR, `c7-anim-${testInfo.workerIndex}.gif`), bytes)
    fs.writeFileSync(path.join(OUT_DIR, `c9-iso-t0-${testInfo.workerIndex}.png`), pngBytes)
    fs.writeFileSync(
      path.join(OUT_DIR, `c7-readings-${testInfo.workerIndex}.json`),
      JSON.stringify({
        plan,
        gifFrames: gif.imageCount,
        gifDelaysCs: gif.delaysCs,
        gifBytes: bytes.length,
        gifSha: crypto.createHash('sha256').update(bytes).digest('hex'),
        pngSha: crypto.createHash('sha256').update(pngBytes).digest('hex'),
        diffRatio: ratio,
        nonTransparentPng: diff.nonTransparent,
      }, null, 2),
      'utf8',
    )
  })

  test('C8 · 相邻帧像素**不同**（渲染一次复制 N 帧的实现会判红）', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', '导出卡判据固定在 desktop-chrome')
    await openExportTab(page)

    await page.locator('[data-make-gif]').click()
    await expect(page.locator('[data-gif-plan]')).toBeVisible({ timeout: 60_000 })
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 90_000 }),
      page.locator('[data-download-gif]').click(),
    ])
    const bytes = await bytesOf(download)
    const gif = parseGif(new Uint8Array(bytes))
    expect(gif.imageCount, '本判据要求至少两帧').toBe(2)

    /** 用 Chromium 的 WebCodecs `ImageDecoder` **逐帧**解码（测试侧独立于生产编码器）。 */
    const framesDiff = await page.evaluate(async (data) => {
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
        const d = Math.abs(a[off]! - b[off]!)
          + Math.abs(a[off + 1]! - b[off + 1]!)
          + Math.abs(a[off + 2]! - b[off + 2]!)
        if (d > 24) differentPixels += 1
      }
      dec.close()
      return { count, differentPixels, totalPixels }
    }, bytes.toString('base64'))

    expect(framesDiff.count, 'WebCodecs 必须解出两帧').toBe(2)
    expect(framesDiff.differentPixels, '相邻帧的像素必须**真的不同**（只改 offset 不重绘会得到同一张图）')
      .toBeGreaterThan(0)

    fs.writeFileSync(path.join(OUT_DIR, `c8-anim-${testInfo.workerIndex}.gif`), bytes)
    fs.writeFileSync(
      path.join(OUT_DIR, `c8-readings-${testInfo.workerIndex}.json`),
      JSON.stringify({ ...framesDiff, delaysCs: gif.delaysCs }, null, 2),
      'utf8',
    )
  })

  test('**负对照** · 静态材质（无 animation）⇒ 卡片错误位 + 无 download', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', '导出卡判据固定在 desktop-chrome')
    await openExportTab(page, { animated: false })
    await page.locator('[data-make-gif]').click()
    // 没有动画序列 ⇒ 计划显式失败（不产出 1 帧假 GIF）。
    await expect(page.locator('[data-gif-err]'), '缺动画序列必须显式失败并显示').toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-gif-err]')).not.toHaveText('')
    await expect(page.locator('[data-download-gif]'), '失败时不得出现下载按钮').toHaveCount(0)
  })
})
