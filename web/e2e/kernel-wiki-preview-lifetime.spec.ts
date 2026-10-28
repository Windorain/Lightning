/**
 * **D6：离开 Wiki 工作区后 `r-wiki-preview` 的视口槽位必须释放**。
 *
 * ## 缺陷（D6）
 *
 * 旧 `EmbedViewport` 的 `onBeforeUnmount` 只做 detach / 注销 region / `drw.dispose()`，
 * **不调 `viewports.unregister`** —— 而 `attachViewport` 的 unbind 明确不归零槽位
 * （`runtime/attachViewport.ts:157-162`，"重挂前的 detach 也会走这里"）。
 * 于是切回"编辑"工作区后，`ctx.viewports.get('r-wiki-preview')` 仍返回
 * `camera`/`domElement` 非空的槽位（读到的是已 dispose 的句柄）—— `isSlotLive` 为 true。
 *
 * ## 判据
 *
 * 三面读数（复用 `readRegionLifecycle`，纯读面）：
 *  - 进 Wiki 工作区并装载：`slotPresent=true`、`slotLive=true`（前提：真的挂上了）；
 *  - 切回编辑工作区：`slotPresent=false`、`slotLive=false`（**槽位轴归零**）；
 *  - 屏幕树节点 / WM 输入域是**装配期静态声明**（`createWorkbenchScreenRoot` 的
 *    `popupRegions`），故它们**保持存在**——本判据不要求它们消失（那是 `AreaLayoutHost`
 *    的 region 台账轴，已覆盖），并在断言里显式钉住"不因槽位释放而被误删"。
 *
 * ## 负对照
 *
 * 撤掉 `EditorViewportHost#onBeforeUnmount` 里的 `ctx.viewports.unregister(region)`
 * 一行 ⇒ 第 2 步读数回到 `slotPresent=true / slotLive=true` ⇒ 本用例判红。
 */

import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import {
  FIXTURE,
  TAB_PREVIEW,
  openWorkbenchWithScene,
  readRegionLifecycle,
} from './helpers/areaLifetime'
import { WIKI_REGION, WIKI_TAB_TEXT, waitWikiViewportReady } from './helpers/parts/hover'
import { fixturePath } from './helpers/saveReopen'

test.describe('Wiki 预览槽位释放（双宿主同一卸载路径）', () => {
  test('离开 Wiki 工作区后 r-wiki-preview 的视口槽位必须归零', async ({ page }) => {
    test.setTimeout(300_000)

    // ── ① 生产入口 + 注入夹具 + 真实切到 Wiki 工作区 ──
    await openWorkbenchWithScene(page)
    await page.locator('.wt-tab', { hasText: WIKI_TAB_TEXT }).click()
    await waitWikiViewportReady(page, 90_000)

    const inside = await readRegionLifecycle(page, [WIKI_REGION])
    console.log('[D6 inside] ' + JSON.stringify(inside.byRegion[WIKI_REGION]))
    expect(
      inside.byRegion[WIKI_REGION].slotPresent,
      '前提：Wiki 工作区里预览视口必须真的登记了槽位（否则下面的归零是空转）',
    ).toBe(true)
    expect(inside.byRegion[WIKI_REGION].slotLive, '前提：槽位必须活着（camera + dom 非空）').toBe(true)

    // ── ② 切回"编辑"（真实点击工作区标签）──
    await page.locator('.wt-tab', { hasText: TAB_PREVIEW }).click()
    await page.waitForFunction(
      () => document.querySelectorAll('.wm-root').length === 0,
      undefined,
      { timeout: 60_000 },
    )
    await page.waitForTimeout(600)

    const after = await readRegionLifecycle(page, [WIKI_REGION])
    console.log('[D6 after] ' + JSON.stringify(after.byRegion[WIKI_REGION]))
    expect(
      after.byRegion[WIKI_REGION].slotLive,
      '⚠️ D6：离开 Wiki 后 r-wiki-preview 不得再报"槽位活着"（读到的是已 dispose 的句柄）',
    ).toBe(false)
    expect(after.byRegion[WIKI_REGION].slotPresent, '⚠️ D6：槽位必须被移除（不是留着空壳）').toBe(false)

    // ── ③ 装配期静态声明的 region 不得因槽位释放被误删 ──
    expect(
      after.byRegion[WIKI_REGION].node,
      'r-wiki-preview 的 region 节点是装配期静态声明（popupRegions），不属于槽位轴',
    ).toBe(true)
    expect(
      after.areas.some((a) => a.regions.includes(WIKI_REGION)) || after.inputIds.includes(WIKI_REGION),
      'WM 输入域/屏幕树里的静态 region 声明同样保留（否则是误删装配声明）',
    ).toBe(true)

    // ── ④ 工作台自己的视口不受影响（同一卸载路径不得牵连在职槽位）──
    const root = await readRegionLifecycle(page, ['r-viewport'])
    expect(root.byRegion['r-viewport'].slotLive, '切回编辑后工作台视口必须仍活着').toBe(true)

    // ── ⑤ 释放不得毒化 region：再切回 Wiki，预览必须重新挂上且槽位再次活着 ──
    await page.locator('.wt-tab', { hasText: WIKI_TAB_TEXT }).click()
    await waitWikiViewportReady(page, 90_000)
    const again = await readRegionLifecycle(page, [WIKI_REGION])
    console.log('[D6 reenter] ' + JSON.stringify(again.byRegion[WIKI_REGION]))
    expect(
      again.byRegion[WIKI_REGION].slotLive,
      '释放必须是可重入的：再进 Wiki 工作区时预览视口必须重新挂上（不是"关掉就坏"）',
    ).toBe(true)

    // 夹具文件存在性（防"因为夹具缺失而走了空路径"）：与读取同一条仓外解析路径
    expect(fs.existsSync(fixturePath())).toBe(true)
  })
})
