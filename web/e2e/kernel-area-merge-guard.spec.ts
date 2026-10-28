/**
 * **G5：合并最后一个 Area 必须被拒绝，且工作台不得变空白**
 *（真实菜单「视图 → 合并区域」两连击）。
 *
 * ## 语义依据
 *
 * SPEC §7.3-c：「显式关闭区域应释放其拥有的资源」；
 * SPEC §10.5：五个生命周期互不越界。工作台没有"零个 Area"这个合法状态 ——
 * 一个 Area 都没有时用户既不能编辑也不能恢复（产品内唯一"重置布局"只做 `location.reload()`，
 * `operators/builtin/miscOperators.ts:325-340`）。口径：**拒绝合并 + 提示
 * 「至少保留一个区域」**（`workbench/ux/panels/menuBar.ts:102` 的菜单项保持可点，
 * 由命令层拒绝并给可见原因）。
 *
 * ## 先红读数（@812ed102）
 *
 * 当时 `mergeArea` 对根 Area 返回 `layout: null`（旧 `domain/workspace.ts:383-389`）
 * ⇒ `AreaLayoutHost` 的模板 `v-if="host.workspace.value.layout"` 不再渲染任何 Area
 * ⇒ **空白工作台**，底栏只报「合并区域 → FINISHED」，零提示，产品内无恢复入口。
 * 根 Area 的合并在域层被**拒绝**（`InvalidValue{reason:'lastArea'}`），
 * 由算子写成底栏成句原因；本文件的提示断言是**逐字**比对（见下）。
 *
 * ## 判据（三条，全部是用户可感知面）
 *
 * 1. **拒绝**：第二次合并后布局非空、仍是 1 个 Area、仍有 1 个真实 canvas；
 * 2. **不空白**：仍有一个**可编辑**视口 —— 叶子节点在、画布在、逻辑机位在，
 *    且真实点击画布后活动区仍是它（证明不是"看起来有个壳但已经不能操作"）；
 * 3. **有提示**：底栏实时状态槽出现**逐字**的「区域操作被拒：至少保留一个区域」，
 *    渠道为 `rejection`，且状态栏文本里用户真的读得到；合法合并不许出现这句。
 *
 * ⚠️ **提示文案是逐字判据**（收紧；旧的宽匹配已不存在）：
 * 文案定稿「至少保留一个区域」，成句形态由 `domain/rejectionText` 唯一决定
 * （`InvalidValue:lastArea` + 句首 `areaLayout` ⇒「区域操作被拒：至少保留一个区域」）。
 * 断言是三重的：**实时状态槽逐字相等** + **渠道是 `rejection`**（证明走的是
 * 拒绝可见机制，不是别的槽恰好有字）+ **底栏文本确含该句**（用户真的看得见）。
 *
 * ## 负对照（防"把合并判据写歪成一律拒绝"）
 *
 * 两区时**必须允许**合并（真实菜单两连击 ⇒ 回到 1 区）。若哪天实现为了过 G5
 * 把合并一律拒掉，这条立刻红。
 */

import { expect, test } from '@playwright/test'
import {
  clickMenuItem,
  collectHint,
  MENU_MERGE,
  MENU_SPLIT_H,
  MENU_VIEW,
  openWorkbenchWithScene,
  readAreaState,
  readCamera,
  ROOT_REGION,
} from './helpers/areaLifetime'

/**
 * **定稿文案**—— 逐字判据，不再是正则。
 *
 * 单一真源是 `src/domain/rejectionText.ts` 的两处：
 *  1. `InvalidValue:lastArea` 的 zh 文本 = 「至少保留一个区域」；
 *  2. 句首 `areaLayout` = 「区域操作」，成句模板 `<句首>被拒：<原因>`。
 * 合起来就是 `REJECT_SENTENCE`。**改产品文案必须同批改这里**（本文件只许收紧，
 * 不许回退成宽匹配 —— 旧的 `/至少|保留|不能|无法|不允许|拒绝/` 已删除）。
 */
const REJECT_COPY = '至少保留一个区域'
const REJECT_SENTENCE = '区域操作被拒：至少保留一个区域'

/** 读「用户可见的拒绝原因」（底栏文本 / 实时状态槽；CRLF 已归一化）。 */
async function readVisibleRejection(page: import('@playwright/test').Page): Promise<{
  statusBar: string
  liveStatus: { message: string; state: string; origin: string | null } | null
  lastDisplayable: string | null
  warnings: string[]
}> {
  const hint = await collectHint(page)
  return {
    statusBar: hint.statusBar,
    liveStatus: hint.liveStatus,
    lastDisplayable: hint.lastDisplayable,
    warnings: hint.warnings,
  }
}

test.describe('合并最后一个 Area（末区合并规则）', () => {
  test('单区再合并 ⇒ 被拒绝、仍有可编辑视口、有可见拒绝原因', async ({ page }) => {
    test.setTimeout(240_000)
    await openWorkbenchWithScene(page)

    const before = await readAreaState(page)
    expect(before.leafCount, '前提：初始应恰好 1 个 Area').toBe(1)
    const camBefore = await readCamera(page, ROOT_REGION)
    expect(camBefore.logical, '前提：初始必须有逻辑机位').not.toBeNull()

    // ── 真实菜单第二次合并（此时只剩一个 Area）──
    await clickMenuItem(page, MENU_VIEW, MENU_MERGE)
    await page.waitForTimeout(2000)

    const after = await readAreaState(page)
    const camAfter = await readCamera(page, ROOT_REGION)
    const rejection = await readVisibleRejection(page)
    console.log(
      '[G5] before=' + JSON.stringify({ areas: before.areaIds, leaves: before.leafCount, canvas: before.canvasCount }) +
      '\n     after=' + JSON.stringify({ areas: after.areaIds, leaves: after.leafCount, canvas: after.canvasCount, layout: after.hasLayout }) +
      '\n     statusBar=' + JSON.stringify(rejection.statusBar) +
      '\n     liveStatus=' + JSON.stringify(rejection.liveStatus) +
      '\n     lastDisplayable=' + JSON.stringify(rejection.lastDisplayable) +
      '\n     warnings=' + JSON.stringify(rejection.warnings.slice(-3)),
    )

    // ── ① 拒绝：布局不得被清空 ──
    expect(
      after.hasLayout,
      '⚠️ G5/D3：合并最后一个 Area 必须被拒绝 —— 布局树不得被置空（当前实现 mergeArea 对根返回 null）',
    ).toBe(true)
    expect(
      after.areaIds,
      '⚠️ G5/D3：合并被拒后必须仍是 1 个 Area；实际 ' + JSON.stringify(after.areaIds),
    ).toEqual(before.areaIds)
    expect(
      after.leafCount,
      '⚠️ G5/D3：合并被拒后必须仍渲染 1 个 Area 叶子；实际 ' + after.leafCount,
    ).toBe(1)
    expect(
      after.canvasCount,
      '⚠️ G5/D3：合并被拒后必须仍有 1 个真实 canvas；实际 ' + after.canvasCount,
    ).toBe(1)

    // ── ② 不空白：仍有一个**可编辑**视口 ──
    await expect(page.locator('.area-layout')).toBeVisible()
    await expect(page.locator('.vc-viewport canvas')).toHaveCount(1)
    expect(
      camAfter.logical,
      '⚠️ G5/D3：合并被拒后逻辑机位仍必须在（空白工作台会连带没有机位）',
    ).not.toBeNull()

    // 真实点击画布：仍在的视口必须是**可操作**的（活动区随指针）
    const box = await page.locator('.vc-viewport canvas').boundingBox()
    expect(box, '可编辑性前提：画布必须有可见尺寸').not.toBeNull()
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.waitForTimeout(500)
    const afterClick = await readAreaState(page)
    expect(
      afterClick.activeAreaId,
      '⚠️ G5/D3：真实点击视口后活动区必须仍是那个 Area（"看起来有壳但已不能操作"不算可用）',
    ).toBe(before.areaIds[0])

    // ── ③ 提示：**逐字**定稿文案（收紧；不再是宽匹配）──
    // ① 实时状态槽逐字相等（拒绝原因的单一真源）。
    expect(
      rejection.liveStatus === null ? null : rejection.liveStatus.message,
      '⚠️ G5/D3：底栏实时状态槽必须是逐字定稿的拒绝原因「' + REJECT_SENTENCE + '」。' +
        '实测=' + JSON.stringify(rejection.liveStatus) +
        ' 底栏=' + JSON.stringify(rejection.statusBar),
    ).toBe(REJECT_SENTENCE)
    // ② 渠道必须是 rejection（证明走的是拒绝可见机制，不是别的槽恰好有字）。
    expect(
      rejection.liveStatus!.origin,
      '⚠️ G5/D3：拒绝原因必须走既有拒绝通道（origin=rejection，`LogCenter.liveStatus`）；' +
        '实测=' + JSON.stringify(rejection.liveStatus),
    ).toBe('rejection')
    // ③ 用户真的看得见：状态栏（`.sb-root`）文本里必须出现定稿文案。
    expect(
      rejection.statusBar,
      '⚠️ G5/D3：状态栏必须显示「' + REJECT_COPY + '」（拒绝不能只写在诊断面）；' +
        '实测底栏=' + JSON.stringify(rejection.statusBar),
    ).toContain(REJECT_COPY)
  })

  test('负对照：两区时合并**必须允许**（不得为过判据把合并一律拒掉）', async ({ page }) => {
    test.setTimeout(240_000)
    await openWorkbenchWithScene(page)

    await clickMenuItem(page, MENU_VIEW, MENU_SPLIT_H)
    await expect
      .poll(async () => (await readAreaState(page)).leafCount, { timeout: 30_000 })
      .toBe(2)

    await clickMenuItem(page, MENU_VIEW, MENU_MERGE)
    await expect
      .poll(async () => (await readAreaState(page)).leafCount, {
        message: '负对照：两区时「合并区域」必须真的合并（回到 1 区）',
        timeout: 30_000,
      })
      .toBe(1)

    const after = await readAreaState(page)
    expect(after.areaIds, '负对照：合并后应剩 1 个 Area').toHaveLength(1)
    expect(after.hasLayout, '负对照：合并后布局必须非空').toBe(true)
    await expect(page.locator('.vc-viewport canvas')).toHaveCount(1)

    // 负对照第二面：合法合并不许刷「被拒」（否则成功被用户误读成拒绝，
    // 也会让上面那条逐字断言变成「只要点了合并就有」的恒真式）。
    const hint = await readVisibleRejection(page)
    console.log('[G5 负对照] liveStatus=' + JSON.stringify(hint.liveStatus) + ' statusBar=' + JSON.stringify(hint.statusBar))
    expect(
      hint.liveStatus === null ? null : hint.liveStatus.message,
      '负对照：两区合并是**合法**操作，不得写拒绝文案；实测=' + JSON.stringify(hint.liveStatus),
    ).not.toBe(REJECT_SENTENCE)
  })
})
