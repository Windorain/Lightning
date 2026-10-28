/**
 * **等轴 PNG 的显式时间与失败可见（C1/C2/C3/C5）**。
 *
 * 全程真实入口：导出 tab → 卡片上的"下载 PNG" → 浏览器真实 `download` 事件；
 * 字节经 `createReadStream` 累加（**不用** `saveAs`：blob URL 的 `saveAs` 会偶发 `canceled`，
 * 见 `e2e/export-asset-manifest.spec.ts` 的实测注释）。
 *
 * | 判据 | 断言 |
 * |---|---|---|
 * | C1 | 同 `seconds` 两次下载 sha 相同；`seconds=0.05` 的 sha 必不同（且颜色从红变蓝） |
 * | C2 | 卡片预览的 PNG 与下载得到的 PNG 逐字节相同（或差异 ≤ 噪声地板并记录） |
 * | C3 | **不传** `seconds` 的算子调用 == `t=0` 的产物（缺省即 0 的回归） |
 * | C5 | 坏纹理 ⇒ 卡片红色错误位出现 **且** 没有 download 事件 |
 *
 * ## 夹具（`deriveAnimatedDocument`）
 *
 * 由 `minimal-v2.json` 派生：两帧竖条（上红下蓝）+ `frameSequence:[{index:0},{index:1,timeTicks:2}]`
 * ⇒ 帧 0 停 50 ms、帧 1 停 100 ms。故 `t=0` 与 `t=0.05` 落在**不同帧**上，
 * "时间没进烘焙"这类实现会让两次产物完全相同（C1 因此能红）。
 *
 * ## 口径限制
 *
 * 像素/字节比较只在**同一 page、同一浏览器进程内**成立；跨机器/跨 GPU 的差异不在判据内。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Download, Page } from '@playwright/test'
import { gotoWorkbench, injectSceneDocumentOk, waitForViewportMounted } from './helpers/multiblock'
import { deriveAnimatedDocument } from './helpers/export/animatedFixture'

const OUT_DIR = path.join(import.meta.dirname, 'screenshots', 'export-iso-time')

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

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

async function openExportTab(page: Page): Promise<void> {
  await gotoWorkbench(page)
  const doc = deriveAnimatedDocument(minimalBase())
  await injectSceneDocumentOk(page, doc, 'm5-4-animated.v2.json')
  await waitForViewportMounted(page)
  // 真实 tab 切换（`.wt-tab` 与 `e2e/obj-export.spec.ts` 同法）
  await page.click('.wt-tab:has-text("导出")')
  await page.waitForSelector('.ew-root', { timeout: 20_000 })
  await expect(page.locator('[data-download-iso]')).toBeVisible({ timeout: 20_000 })
}

/** 设置时间输入（`v-model.lazy` ⇒ 失焦提交）并等一次重烘焙落定。 */
async function setIsoSeconds(page: Page, value: string): Promise<void> {
  const input = page.locator('[data-iso-seconds]')
  await input.fill(value)
  await input.press('Tab')
  // 重烘焙期间卡片显示"渲染中…"，等它消失（否则下一步可能点到 busy 态）。
  await expect(page.locator('.ew-card', { has: page.locator('[data-iso-seconds]') }).locator('.ew-fb', { hasText: '渲染中' }))
    .toHaveCount(0, { timeout: 30_000 })
}

async function downloadIsoPng(page: Page): Promise<Buffer> {
  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.locator('[data-download-iso]').click(),
    ])
    return bytesOf(download)
  } catch (e) {
    // 失败时把卡片里的错误位与页面 console 一并抛出来（否则只剩一句 "download 超时"，
    // 无法区分"画得太慢"与"算子抛错"）。
    const text = await page.locator('[data-iso-dl-err]').textContent().catch(() => null)
    const preview = await page.locator('.ew-card .ew-fb--err').first().textContent().catch(() => null)
    throw new Error(`等轴 PNG 下载未发生：卡片错误位=${JSON.stringify(text)} 预览错误位=${JSON.stringify(preview)} 原因=${String(e)}`)
  }
}

/**
 * 两张 PNG 的**逐像素差异比例**（用浏览器解码，避免在 Node 里自造 PNG 解码器）。
 *
 * 判据口径：透明区不参与（两边都 alpha < 128 的像素跳过），其余像素任一通道差 > 8
 * 记一个"不同"。阈值刻意小 —— 这里要证明的是"画面真的换了一帧"，不是颜色精确相等。
 */
async function pixelDiffRatio(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return await page.evaluate(async (args: { a: string; b: string }) => {
    const load = async (data: string): Promise<ImageData> => {
      const blob = await (await fetch(`data:image/png;base64,${data}`)).blob()
      const bmp = await createImageBitmap(blob)
      const canvas = document.createElement('canvas')
      canvas.width = bmp.width
      canvas.height = bmp.height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      return ctx.getImageData(0, 0, bmp.width, bmp.height)
    }
    const x = await load(args.a)
    const y = await load(args.b)
    let different = 0
    let compared = 0
    const n = Math.min(x.data.length, y.data.length) / 4
    for (let i = 0; i < n; i++) {
      const off = i * 4
      if (x.data[off + 3]! < 128 && y.data[off + 3]! < 128) continue
      compared += 1
      const d = Math.abs(x.data[off]! - y.data[off]!)
        + Math.abs(x.data[off + 1]! - y.data[off + 1]!)
        + Math.abs(x.data[off + 2]! - y.data[off + 2]!)
        + Math.abs(x.data[off + 3]! - y.data[off + 3]!)
      if (d > 8) different += 1
    }
    return compared === 0 ? 0 : different / compared
  }, { a: a.toString('base64'), b: b.toString('base64') })
}

test.describe('等轴 PNG 显式时间', () => {
  test('同秒同 sha、异秒必异；预览与下载同字节', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', '导出卡判据固定在 desktop-chrome（移动视口下卡片被折叠）')
    fs.mkdirSync(OUT_DIR, { recursive: true })
    await openExportTab(page)

    // 前提断言（防上游投影丢字段）：动画声明必须真的在**投影产物**里。
    const anim = await page.evaluate(() => {
      const plain = (window as any).__vm__.plainForSave().plain as any
      const a = plain?.materialPalette?.[0]?.animation
      return a ? { defaultFrametimeTicks: a.defaultFrametimeTicks, second: a.frameSequence?.[1] } : null
    })
    expect(anim, '投影产物必须带回 materialPalette[0].animation（否则问题在装配/投影，不在本包）').not.toBeNull()
    expect(anim!.defaultFrametimeTicks, '默认帧时长必须是 1 tick').toBe(1)
    expect(anim!.second, '第二帧必须声明 timeTicks=2（camelCase 键；写成 snake_case 会静默退化成 1 tick）')
      .toMatchObject({ index: 1, timeTicks: 2 })

    await setIsoSeconds(page, '0')
    const a = await downloadIsoPng(page)
    const a2 = await downloadIsoPng(page)
    expect(a.subarray(0, 8).toString('hex'), '产物必须是 PNG（魔数）').toBe('89504e470d0a1a0a')
    expect(sha256(a2), '同一 seconds 两次下载必须逐字节相同（时间→画面是纯映射）').toBe(sha256(a))

    await setIsoSeconds(page, '0.05')
    const c = await downloadIsoPng(page)
    // 能红：任何"时间没进烘焙"的实现都会让这次与 t=0 完全相同。
    expect(sha256(c), 'seconds=0.05 的产物必须与 seconds=0 不同（帧 1 从 50ms 开始）').not.toBe(sha256(a))

    // 像素级证据（不只是"字节不同"）：两帧的非透明区域必须有**成片**差异。
    const diffRatio = await pixelDiffRatio(page, a, c)
    expect(diffRatio, `t=0 与 t=0.05 的画面必须有成片差异（实测 ${(diffRatio * 100).toFixed(1)}%）`)
      .toBeGreaterThan(0.05)

    // 帧时长语义（比"字节不同"更硬）：声明是 50ms + 100ms ⇒
    //  · 0.05 与 0.10 落在**同一帧**（帧 1 的窗口是 [0.05, 0.15)）⇒ 同字节；
    //  · 0.15 回到循环起点 ⇒ 与 t=0 同字节。
    // 任何"时间没按声明时长采样"的实现都会在这两条上立刻露出来。
    await setIsoSeconds(page, '0.1')
    const d = await downloadIsoPng(page)
    expect(sha256(d), 't=0.10 必须在帧 1 的窗口内（与 t=0.05 同图）').toBe(sha256(c))
    await setIsoSeconds(page, '0.15')
    const e = await downloadIsoPng(page)
    expect(sha256(e), 't=0.15 是一个循环的末尾 ⇒ 回到帧 0（与 t=0 同图）').toBe(sha256(a))

    // C2：预览（组件内 bake）与下载（算子）必须同字节。
    const previewUrl = await page.locator('img.ew-iso').first().getAttribute('src')
    expect(previewUrl, '等轴卡片必须有预览图').not.toBeNull()
    const previewBytes = Buffer.from((previewUrl as string).split(',')[1] ?? '', 'base64')
    expect(previewBytes.length, '预览必须是真实 PNG 字节').toBeGreaterThan(100)
    // 此刻卡片的时间输入是 0.15，预览与上一次下载（`e`）是**同一配置** ⇒ 必须逐字节相同。
    expect(
      sha256(previewBytes),
      '预览 PNG 与同配置下载的 PNG 必须逐字节相同（卡片显示的图就是下载的图）',
    ).toBe(sha256(e))

    fs.writeFileSync(path.join(OUT_DIR, `c1-iso-t0-${testInfo.workerIndex}.png`), a)
    fs.writeFileSync(path.join(OUT_DIR, `c1-iso-t005-${testInfo.workerIndex}.png`), c)
    fs.writeFileSync(
      path.join(OUT_DIR, `c1-readings-${testInfo.workerIndex}.json`),
      JSON.stringify({
        sha_t0: sha256(a),
        sha_t0_again: sha256(a2),
        sha_t005: sha256(c),
        preview_sha: sha256(previewBytes),
        bytes_t0: a.length,
        bytes_t005: c.length,
        bytes_t010: d.length,
        bytes_t015: e.length,
        diffRatio_t0_t005: diffRatio,
      }, null, 2),
      'utf8',
    )
  })

  test('**不传** seconds 的算子调用 == t=0（缺省即 0 的回归）', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', '导出卡判据固定在 desktop-chrome')
    await openExportTab(page)

    await setIsoSeconds(page, '0')
    const explicitZero = await downloadIsoPng(page)

    // 仍走**生产算子 + 生产下载路径**，只是不带 `seconds` prop。
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.evaluate(() => (window as any).__vm__.getOperators().exec('OPERATOR_EXPORT_ISO_PNG', { direction: 0 })),
    ])
    const implicit = await bytesOf(download)
    expect(
      sha256(implicit),
      '缺省 seconds 必须等于 t=0（把缺省写成"当前时间"会在这里判红）',
    ).toBe(sha256(explicitZero))
  })

  test('坏纹理 ⇒ 卡片红色错误位 + **没有**下载（改造前只有日志）', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', '导出卡判据固定在 desktop-chrome')
    await gotoWorkbench(page)
    // 坏纹理：`textureBlobIndex` 指向不存在的槽 ⇒ `listPaletteTextureDataUrls` 跳过 ⇒
    // `buildBlockMesh` 抛"纹理未预取"（与 `isoExportTextureChain.test.ts` 记录同一形态）。
    const broken = deriveAnimatedDocument(minimalBase())
    ;(broken.materialPalette as Record<string, unknown>[])[0]!.textureBlobIndex = 5
    await injectSceneDocumentOk(page, broken, 'm5-4-broken-texture.v2.json')
    await waitForViewportMounted(page)
    await page.click('.wt-tab:has-text("导出")')
    await page.waitForSelector('.ew-root', { timeout: 20_000 })

    // 预览先失败（同一形态的旧错误位）—— 前提，不是判据。
    await expect(page.locator('.ew-card', { has: page.locator('[data-iso-seconds]') }).locator('.ew-fb--err').first())
      .toBeVisible({ timeout: 30_000 })

    // 点"下载 PNG"：必须出现**下载错误位**，且**没有** download 事件。
    const downloadPromise = page
      .waitForEvent('download', { timeout: 3_000 })
      .then(() => 'downloaded' as const)
      .catch(() => 'no-download' as const)
    await page.locator('[data-download-iso]').click()
    const outcome = await downloadPromise
    expect(outcome, '导出失败时**不得**产出下载（不得把失败当成功）').toBe('no-download')
    await expect(page.locator('[data-iso-dl-err]'), '失败必须在卡片里可见（红色错误位）')
      .toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-iso-dl-err]')).not.toHaveText('')
  })
  /**
   * **C6（手测实测）**：非法时间必须**真人在键盘上到得了**红字。
   *
   * ## 为什么这条要专门存在
   *
   * 输入框原是 `type="number"`：浏览器**吞掉**非法键盘输入（键入 `abc` 后 `value` 恒空），
   * 于是 `isoTimeInvalid` 红字在真人操作下几乎不可达（只有清空输入框才碰得到）——
   * 一条只有程序化可达的错误位等于没有。改为文本输入 + `@input` 即时校验后，本判据
   * 把"键入非法文本 ⇒ 红字出现"钉住（同时钉住"改回合法 ⇒ 红字消失"与"非法时不下载"）。
   */
  test('键入非法时间 ⇒ 红字可见；改回合法 ⇒ 红字消失；非法时点下载 ⇒ 可见错误且无下载', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', '导出卡判据固定在 desktop-chrome')
    await openExportTab(page)

    const input = page.locator('[data-iso-seconds]')
    const invalid = page.locator('[data-iso-time-invalid]')
    // 基线：合法值 ⇒ 无红字（否则下面的"出现"可能恒真）。
    await setIsoSeconds(page, '0.05')
    await expect(invalid, '合法时间不得显示红字').toHaveCount(0)

    // 键入非法文本（**不**失焦）：`@input` 即时校验就该出现红字。
    await input.fill('abc')
    await expect(invalid, '键入非法时间必须立刻出现红字（不必等失焦/提交）').toBeVisible({ timeout: 5_000 })
    await expect(invalid).not.toHaveText('')

    // 改回合法 ⇒ 红字消失（红字是"当前输入非法"，不是一次性横幅）。
    await input.fill('0.1')
    await expect(invalid, '改回合法值后红字必须消失').toHaveCount(0, { timeout: 5_000 })

    // 再键入非法值并提交（失焦）：红字仍在，且**点下载必须可见失败、不得产出下载**。
    await input.fill('abc')
    await expect(invalid).toBeVisible({ timeout: 5_000 })
    const downloadPromise = page
      .waitForEvent('download', { timeout: 3_000 })
      .then(() => 'downloaded' as const)
      .catch(() => 'no-download' as const)
    await page.locator('[data-download-iso]').click()
    expect(await downloadPromise, '非法时间不得产出下载（不得静默当 t=0）').toBe('no-download')
    await expect(page.locator('[data-iso-dl-err]'), '非法时间的下载失败必须可见').toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-iso-dl-err]')).not.toHaveText('')

    console.log('[等轴时间] 非法时间：键入即红字、改回即消失、点下载可见失败且无下载')
  })
});
