/**
 * M7-1 · **G5：合并最后一个 Area 必须被拒绝，且工作台不得变空白**
 *（真实菜单「视图 → 合并区域」两连击）。
 *
 * ## 语义依据
 *
 * SPEC §7.3-c（`SPEC.md:248`）：「显式关闭区域应释放其拥有的资源」；
 * §10.5（`SPEC.md:307`）：五个生命周期互不越界。工作台没有"零个 Area"这个合法状态 ——
 * 一个 Area 都没有时用户既不能编辑也不能恢复（产品内唯一"重置布局"只做 `location.reload()`，
 * `operators/builtin/miscOperators.ts:325-340`）。M7-0 Q4 裁决：**拒绝合并 + 提示
 * 「至少保留一个区域」**（`workbench/ux/panels/menuBar.ts:102` 的菜单项保持可点，
 * 由命令层拒绝并给可见原因）。
 *
 * ## 当前预期（S0-B D3，先红）
 *
 * `mergeArea` 对根 Area 返回 `layout: null`（`domain/workspace.ts:383-389`）
 * ⇒ `AreaLayoutHost` 的模板 `v-if="host.workspace.value.layout"`（`AreaLayoutHost.vue:201`）
 * 不再渲染任何 Area ⇒ **空白工作台**，且产品内无恢复入口（只能整页刷新）。
 *
 * ## 判据（三条，全部是用户可感知面）
 *
 * 1. **拒绝**：第二次合并后布局非空、仍是 1 个 Area、仍有 1 个真实 canvas；
 * 2. **不空白**：仍有一个**可编辑**视口 —— 叶子节点在、画布在、逻辑机位在，
 *    且真实点击画布后活动区仍是它（证明不是"看起来有个壳但已经不能操作"）；
 * 3. **有提示**：任一用户可见面（底栏文本 / 实时状态槽 / 最近 WARN 日志）出现
 *    「至少保留一个区域」或等价的拒绝语。
 *
 * ⚠️ **提示文案的宽松匹配**（本包刻意如此）：具体字样由 M7-3 实现定稿，
 * 本文件先钉"必须有可见拒绝原因"这一**行为**，用
 * `/至少|保留|不能|无法|不允许|拒绝/` 宽匹配 + 注释说明；
 * M7-3 落地后应把这里收紧成固定文案（见 `REJECT_HINT_PATTERN` 的注释）。
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
 * 拒绝提示的**宽匹配**（M7-3 定稿文案前的最小行为判据）。
 *
 * M7-3 实现「拒绝 + 提示『至少保留一个区域』」后，应把本正则收紧为
 * `/至少保留一个区域/`，并把本条断言消息改成逐字比对。
 */
const REJECT_HINT_PATTERN = /至少|保留|不能|无法|不允许|拒绝/

/** 读"用户可见的拒绝原因"：底栏文本 / 实时状态槽 / 最近 WARN 日志（CRLF 已归一化）。 */
async function readVisibleRejection(page: import('@playwright/test').Page): Promise<{
  statusBar: string
  liveStatus: string | null
  warnings: string[]
  matched: string[]
}> {
  const hint = await collectHint(page)
  const surfaces = [
    hint.statusBar,
    hint.liveStatus ? hint.liveStatus.message : '',
    hint.lastDisplayable ?? '',
    ...hint.warnings,
    ...hint.lifecycleErrors,
  ]
  return {
    statusBar: hint.statusBar,
    liveStatus: hint.liveStatus ? hint.liveStatus.message : null,
    warnings: hint.warnings,
    matched: surfaces.filter((s) => s.length > 0 && REJECT_HINT_PATTERN.test(s)),
  }
}

test.describe('M7-1 · G5 合并最后一个 Area（§7.3-c + M7-0 Q4 裁决）', () => {
  test('G5 单区再合并 ⇒ 被拒绝、仍有可编辑视口、有可见拒绝原因', async ({ page }) => {
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
      '\n     matchedHints=' + JSON.stringify(rejection.matched.slice(0, 3)),
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

    // ── ③ 提示：必须有可见拒绝原因（文案宽松匹配，见 REJECT_HINT_PATTERN）──
    expect(
      rejection.matched.length,
      '⚠️ G5/D3：合并被拒必须给出**用户可见**的原因（M7-0 Q4：提示「至少保留一个区域」）。' +
        '实测底栏=' + JSON.stringify(rejection.statusBar) +
        ' liveStatus=' + JSON.stringify(rejection.liveStatus) +
        ' 最近告警=' + JSON.stringify(rejection.warnings.slice(-3)),
    ).toBeGreaterThan(0)
  })

  test('G5 负对照：两区时合并**必须允许**（不得为过判据把合并一律拒掉）', async ({ page }) => {
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
  })
})
