/**
 * T2.6 · 「帧为主」文档回归断言（计划 §5 Phase 3 / T3.4 复用）。
 *
 * 覆盖：帧播放与分层预览语义不变 ——
 *  - 帧切换由 **DOM 事件**驱动（滑杆 `change` / 键盘），且 `ctx.getFrameIndex()`
 *    随之变化（「doc 当前帧变化」）；
 *  - 播放按钮 → 索引随时间推进；暂停 → 索引停住；
 *  - 分层预览开关行为：`ALL`(-1) ↔ 单层 `Y = n`，且**几何真的变了**（像素签名判据）；
 *  - 帧 tab 与分层 tab 互不干扰：切 tab 不改动对方的当前值；
 *  - 单帧文档不出帧 tab（`hasWorldMultiFrame === false`）。
 *
 * 样例来源：由真实导出信封样例 `e2e/fixtures/structuredata-exported-envelope.json`
 * 在测试内存中派生 3 帧（仓库现有「帧为主」样例都是单帧，无法回归帧播放）。
 */

import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  DOCK,
  FRAME_COUNT,
  FRAME_EXPECTATIONS,
  FRAME_SLIDER,
  LAYER_SLIDER,
  PLAYBACK_BUTTON,
  VIEWPORT_CANVAS,
  assertScreenshotNotBlank,
  buildFrameDominantMultiframeDocument,
  captureEvidence,
  dockTab,
  elementBox,
  gotoWorkbench,
  injectSceneDocumentOk,
  readDocObservation,
  readDockStatus,
  readPixelSignature,
  readRenderedGrid,
  readViewportState,
  expectSignificantPixelChange,
  expectStablePixels,
  pressSliderKey,
  setSliderValue,
  waitForFrameIndex,
  waitForLayerY,
  waitForMeshIdle,
  waitForRenderedGrid,
  waitForViewportMounted,
} from './helpers/multiblock'

const SHOT_DIR = path.join(import.meta.dirname, 'screenshots', 'multiblock')
const FRAME_FIXTURE = path.join(import.meta.dirname, 'fixtures', 'structuredata-exported-envelope.json')

test.describe('T2.6 · 帧为主文档回归（帧播放 / 分层预览语义）', () => {
  test('多帧：DOM 驱动帧切换 / 播放推进 / 分层预览切换且几何真的变了', async ({ page }, testInfo) => {
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    const suffix = testInfo.project.name

    await gotoWorkbench(page)
    await injectSceneDocumentOk(page, buildFrameDominantMultiframeDocument(), 'multiframe-frame-dominant.json')
    await waitForViewportMounted(page)
    await waitForRenderedGrid(page)

    // ── 形态：帧为主（无通道声明），帧数是合成的 3 帧 ──
    const doc = await readDocObservation(page)
    expect(doc.isMultiblock, '帧为主文档不得被判为多方块').toBe(false)
    expect(doc.channelCount).toBe(0)
    expect(doc.runstateCount).toBe(0)
    expect(doc.variantCount).toBe(0)
    expect(doc.multiblockSceneCount, '帧为主文档没有多方块场景声明').toBe(0)
    expect(doc.frameCount).toBe(FRAME_COUNT)
    expect(
      doc.frameGrids.map((f) => [f.d, f.h, f.w, f.solidCells]),
      '每帧自带 grid（帧是唯一变体存储原语）',
    ).toEqual(FRAME_EXPECTATIONS.map((e) => [e.d, e.h, e.w, e.solidCells]))

    // ── 帧 0：渲染网格 = 帧 0 的 grid；dock 显示 帧 1/3；图层为 ALL ──
    const g0 = await readRenderedGrid(page)
    expect([g0.d, g0.h, g0.w, g0.solidCells]).toEqual([
      FRAME_EXPECTATIONS[0]!.d, FRAME_EXPECTATIONS[0]!.h, FRAME_EXPECTATIONS[0]!.w, FRAME_EXPECTATIONS[0]!.solidCells,
    ])
    expect(await readViewportState(page)).toMatchObject({ frameIndex: 0, layerWorldY: -1 })
    expect(await readDockStatus(page)).toContain(`帧 1/${FRAME_COUNT}`)
    expect(await readDockStatus(page)).toContain('层 ALL')

    // 帧 tab 默认激活（多帧），分层面板未挂载
    // 布局口径：tab 行必须可见；滑杆**可见性**只在桌面 project 断言（见下方开放项说明）
    await expect(dockTab(page, '帧控制')).toBeVisible()
    await expect(page.locator(FRAME_SLIDER)).toBeAttached()
    await expect(page.locator(LAYER_SLIDER)).toHaveCount(0)
    const frameSliderBox = await elementBox(page, FRAME_SLIDER)
    console.log(`[T2.6] 帧滑杆布局盒（${testInfo.project.name}）= ${JSON.stringify(frameSliderBox)}`)
    if (testInfo.project.name === 'desktop-chrome') {
      await expect(page.locator(FRAME_SLIDER)).toBeVisible()
    } else {
      // 窄视口（Pixel 5）下 Workbench 视口列约 250 CSS px，滑杆 flex 宽度被挤为 0
      // —— 属既有窄布局限制，不是 T2.6 引入；功能断言仍照跑（DOM 事件路径一致）。
      expect(frameSliderBox!.height, '滑杆仍应占据行高').toBeGreaterThan(0)
    }

    const viewport = page.locator(VIEWPORT_CANVAS)
    const cap0 = await captureEvidence(
      page, viewport, '帧 0 视口截图', path.join(SHOT_DIR, `frame0-${suffix}.png`),
    )
    console.log(`[T2.6] 帧 0 视口截图像素实测 ${JSON.stringify(cap0.stats)}`)

    // 判据噪声地板：同一状态重复截图必须几乎相同（否则「有差异」的门限不成立）
    const sig0b = await readPixelSignature(page, await viewport.screenshot())
    const noise = expectStablePixels(cap0.signature, sig0b, '重复截图')
    console.log(`[T2.6] 重复截图签名差（噪声地板）= ${JSON.stringify(noise)}`)

    // ── 帧切换（DOM 事件注入：range 的 input+change）──
    await setSliderValue(page, FRAME_SLIDER, 2)
    await waitForFrameIndex(page, 2)
    expect(await readDockStatus(page)).toContain(`帧 3/${FRAME_COUNT}`)
    expect((await readViewportState(page)).frameIndex).toBe(2)
    // 帧为主文档的「当前帧数据」在 doc 上逐帧完好
    const afterSwitch = await readDocObservation(page)
    expect(afterSwitch.frameGrids.map((f) => [f.d, f.h, f.w, f.solidCells])).toEqual(
      FRAME_EXPECTATIONS.map((e) => [e.d, e.h, e.w, e.solidCells]),
    )
    // 诊断（不作断言）：当前实现的渲染定义是否跟随帧索引
    const g2 = await readRenderedGrid(page)
    console.log(
      `[T2.6] 帧切换后渲染定义诊断：帧 2 期望 [${FRAME_EXPECTATIONS[2]!.d},${FRAME_EXPECTATIONS[2]!.h},${FRAME_EXPECTATIONS[2]!.w}]/` +
        `${FRAME_EXPECTATIONS[2]!.solidCells} 格，实得 [${g2.d},${g2.h},${g2.w}]/${g2.solidCells} 格` +
        `（既有实现：V2Plain 文档的帧切换不重建网格，见 drwMeshPipeline 的 isWorldDocument 门；本阶段不对此设断言）`,
    )

    // ── 帧切换（第二条独立事件通道：键盘）──
    await pressSliderKey(page, FRAME_SLIDER, 'Home')
    await waitForFrameIndex(page, 0)
    expect(await readDockStatus(page)).toContain(`帧 1/${FRAME_COUNT}`)

    // ── 播放 / 暂停 ──
    const playBtn = page.locator(PLAYBACK_BUTTON)
    await expect(playBtn).toBeVisible()
    await expect(playBtn).toHaveAttribute('aria-pressed', 'false')
    await playBtn.click()
    await expect(playBtn).toHaveAttribute('aria-pressed', 'true')
    await page.waitForFunction(
      () => (window as any).__vm__.getFrameIndex() !== 0,
      undefined,
      { timeout: 15_000 },
    )
    const advanced = (await readViewportState(page)).frameIndex
    console.log(`[T2.6] 播放推进到帧索引 ${advanced}`)
    await playBtn.click()
    await expect(playBtn).toHaveAttribute('aria-pressed', 'false')
    const paused = (await readViewportState(page)).frameIndex
    await page.waitForTimeout(500)
    expect((await readViewportState(page)).frameIndex, '暂停后帧索引必须停住').toBe(paused)

    // ── 分层预览：切换 tab，滑杆出现 ──
    expect((await readViewportState(page)).layerWorldY).toBe(-1)
    expect(await readDockStatus(page)).toContain('层 ALL')
    await dockTab(page, '分层预览').click()
    await expect(page.locator(LAYER_SLIDER)).toBeAttached()
    await expect(page.locator(FRAME_SLIDER)).toHaveCount(0)

    const capAll = await captureEvidence(page, viewport, '分层 ALL 视口截图', null)

    // 单层 Y = 0：图层状态变化 + dock 标签变化
    await setSliderValue(page, LAYER_SLIDER, 0)
    await waitForLayerY(page, 0)
    await waitForMeshIdle(page, LAYER_SLIDER)
    expect((await readViewportState(page)).layerWorldY).toBe(0)
    expect(await readDockStatus(page)).toContain('层 Y = 0')
    const capY0 = await captureEvidence(
      page, viewport, '单层 Y=0 视口截图', path.join(SHOT_DIR, `layer-y0-${suffix}.png`),
    )
    console.log(`[T2.6] 单层 Y=0 视口截图像素实测 ${JSON.stringify(capY0.stats)}`)

    // 「几何真的变了」的机器判据 —— 第二阶段「相邻取值截图必须有差异」直接用这条
    const layerDiff = expectSignificantPixelChange(capAll.signature, capY0.signature, 'ALL → 单层 Y=0')
    console.log(`[T2.6] ALL vs Y=0 签名差 = ${JSON.stringify(layerDiff)}`)

    // 恢复到 ALL
    await setSliderValue(page, LAYER_SLIDER, -1)
    await waitForLayerY(page, -1)
    expect(await readDockStatus(page)).toContain('层 ALL')

    // ── 互不干扰：切回帧 tab，帧索引仍为暂停时的值 ──
    await dockTab(page, '帧控制').click()
    await expect(page.locator(FRAME_SLIDER)).toBeAttached()
    expect((await readViewportState(page)).frameIndex, '切 tab 不得改动当前帧').toBe(paused)
    expect((await readViewportState(page)).layerWorldY, '切 tab 不得改动图层').toBe(-1)
  })

  test('单帧：不出帧 tab，分层预览仍可用', async ({ page }, testInfo) => {
    await gotoWorkbench(page)
    const single = JSON.parse(fs.readFileSync(FRAME_FIXTURE, 'utf8')) as Record<string, unknown>
    await injectSceneDocumentOk(page, single, 'structuredata-exported-envelope.json')
    await waitForViewportMounted(page)
    await waitForRenderedGrid(page)

    const doc = await readDocObservation(page)
    expect(doc.isMultiblock).toBe(false)
    expect(doc.frameCount).toBe(1)

    // `hasWorldMultiFrame === false` → 只有分层 tab，没有帧 tab、没有播放按钮
    expect(await page.locator(`${DOCK} .vp-dock__tab`).allInnerTexts()).toEqual(['分层预览'])
    expect(await page.locator(FRAME_SLIDER).count()).toBe(0)
    expect(await page.locator(PLAYBACK_BUTTON).count()).toBe(0)

    await expect(page.locator(LAYER_SLIDER)).toBeAttached()
    expect(await readDockStatus(page)).toContain('层 ALL')
    await setSliderValue(page, LAYER_SLIDER, 1)
    await waitForLayerY(page, 1)
    expect(await readDockStatus(page)).toContain('层 Y = 1')

    const stats = await assertScreenshotNotBlank(
      page,
      page.locator(VIEWPORT_CANVAS),
      '单帧 + 单层视口截图',
      path.join(SHOT_DIR, `single-frame-layer1-${testInfo.project.name}.png`),
    )
    console.log(`[T2.6] 单帧 + 单层视口截图像素实测 ${JSON.stringify(stats)}`)
  })
})
