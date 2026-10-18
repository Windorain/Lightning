/**
 * M7-1 · **G1：工作区往返后机位逐字段不变**（真实工作台入口 + 真实工作区切换）。
 *
 * ## 判据要钉的语义（SPEC §7.3-a/b，`SPEC.md:244-246`）
 *
 * 「挂载、隐藏、调整布局和更换界面承载属于呈现生命周期，不自动结束逻辑编辑器实例」；
 * 「界面承载确需重新建立时，逻辑状态应在**首次呈现前**正确恢复」。⇒
 * 把机位按用户操作挪离默认值后，**切走再切回**必须逐字段回到用户那个机位。
 *
 * ## 当前预期（S0-B D1，机制链）
 *
 * `ViewportManager.unregister` → `cameraInit.forget`（`runtime/viewportManager.ts:119-128`）
 * ⇒ 重挂时 `claim(hasCameraState=true, last=null)` 仍返回 `true`
 * （`runtime/viewportCameraInit.ts:107-110`）⇒ `attachViewport` 执行
 * `OPERATOR_INIT_VIEWPORT_CAMERA`（`runtime/attachViewport.ts:115-123`）⇒ 无条件覆盖机位
 * （`runtime/viewportCameraApply.ts:34-79`）。**预期本用例先红**。
 *
 * ## 防假绿（三条，缺一条判据就可疑）
 *
 * 1. **前提**：机位必须先被挪到**显著非默认**位置，且在逻辑机位与引擎相机两侧都生效，
 *    并与自动框选机位不同 —— 否则"复位"无从观测（默认值恰好相同 ⇒ 恒绿）；
 * 2. **呈现真的重建了**：离开工作区时 `.area-node--leaf` 与 `.vc-viewport canvas` 必须
 *    归零（组件真卸载），而 `__areaHost__()` 的 Area 会话仍在（逻辑状态不随组件存亡）
 *    —— 否则"切回后状态还在"可能只是因为组件从来没被卸载过（`v-show` 旧形态）；
 * 3. **读面有区分力**：挪动后的逻辑机位必须逐字段等于写入值（读面不是 `null` 空转），
 *    且引擎取景矩阵非空。
 *
 * 入口与观测面：真实 `OPERATOR_OPEN_SCENE`（`File`，与拖放同路）装载游戏内导出信封；
 * 工作区切换 = 真实点击顶栏 `.wt-tab`；机位读 `__vm__.main.cameras['r-viewport']`
 * 与 `__vm__.viewports.get('r-viewport').camera.value`（生产读面）。
 */

import { expect, test } from '@playwright/test'
import {
  clickWorkspaceTab,
  expectEngineClose,
  leaveAndReturnWorkspace,
  openWorkbenchWithScene,
  POSE_A,
  readCamera,
  ROOT_REGION,
  setCamera,
  TAB_EXPORT,
  TAB_PREVIEW,
} from './helpers/areaLifetime'

test.describe('M7-1 · G1 工作区往返（机位属于编辑器实例）', () => {
  test('G1 装载 → 挪机位 → 切「导出」→ 切回「编辑」⇒ 机位逐字段不变', async ({ page }) => {
    test.setTimeout(240_000)

    await openWorkbenchWithScene(page)

    // ── ① 基线：自动框选机位 ──
    const fit = await readCamera(page, ROOT_REGION)
    expect(fit.logical, '装载后必须有自动框选机位（否则本用例无从谈"复位"）').not.toBeNull()

    // ── ② 前提：机位挪到显著非默认位置，并证明两侧都真的变了 ──
    await setCamera(page, ROOT_REGION, POSE_A)
    const moved = await readCamera(page, ROOT_REGION)
    expect(
      moved.logical,
      '【前提】挪机位必须真的写进权威逻辑机位（读面不得空转）',
    ).toEqual(POSE_A)
    expect(moved.logical, '【前提】挪动后的机位必须与自动框选机位不同').not.toEqual(fit.logical)
    expect(moved.engine, '【前提】挪机位必须在引擎相机上真的生效').not.toEqual(fit.engine)

    // ── ③ 真实工作区往返（离开态同时断言"呈现真的被拆掉"）──
    const { awayArea } = await leaveAndReturnWorkspace(page)
    expect(awayArea.areaIds.length, '离开工作区后 Area 会话（逻辑布局）必须仍在').toBe(1)
    expect(awayArea.hasLayout, '离开工作区不得销毁布局树（§7.3-a）').toBe(true)

    // ── ④ 判据：切回后机位逐字段不变 ──
    const after = await readCamera(page, ROOT_REGION)
    console.log(
      '[G1] fit=' + JSON.stringify(fit.logical) +
      '\n     moved=' + JSON.stringify(moved.logical) +
      '\n     after=' + JSON.stringify(after.logical) +
      '\n     away=' + JSON.stringify({ areaIds: awayArea.areaIds, leaves: awayArea.leafCount, canvas: awayArea.canvasCount }),
    )

    expect(
      after.logical,
      '⚠️ G1/D1：切走再切回后，逻辑机位必须**逐字段**等于用户挪到的那个机位（当前实现会重新自动框选）',
    ).toEqual(moved.logical)
    expect(
      after.logical,
      '⚠️ 切回后不得回到自动框选机位（那是 D1 的直接形态）',
    ).not.toEqual(fit.logical)
    expectEngineClose(after.engine, moved.engine, '⚠️ 切回后引擎相机取景')

    // ── ⑤ 终态复核：视口真的可用（不是"没机位所以相等"）──
    expect(after.engine.m, '切回后必须存在真实引擎相机').not.toBeNull()
    await expect(page.locator('.vc-viewport canvas')).toHaveCount(1)
  })

  test('G1 负对照：同一读面下"两个不同机位"必须可判红（读面有区分力）', async ({ page }) => {
    test.setTimeout(180_000)
    await openWorkbenchWithScene(page)

    await setCamera(page, ROOT_REGION, POSE_A)
    const a = await readCamera(page, ROOT_REGION)
    await setCamera(page, ROOT_REGION, { ...POSE_A, yawDeg: POSE_A.yawDeg + 40, distance: POSE_A.distance + 5 })
    const b = await readCamera(page, ROOT_REGION)

    // 若 ReadCamera 恒返回同一值（或恒 null），G1 的 toEqual 就永远绿 —— 本对照专治这种假绿。
    expect(a.logical, '负对照：读面必须给出机位').not.toBeNull()
    expect(b.logical, '负对照：读面必须给出机位').not.toBeNull()
    expect(a.logical, '负对照：两个不同机位必须可区分（否则 G1 恒绿）').not.toEqual(b.logical)
    expect(a.engine, '负对照：引擎取景必须可区分').not.toEqual(b.engine)
  })

  test('G1 前置：切到导出工作区确实卸载呈现（不是 v-show 保活）', async ({ page }) => {
    test.setTimeout(180_000)
    await openWorkbenchWithScene(page)
    await expect(page.locator('.area-node--leaf')).toHaveCount(1)
    await expect(page.locator('.vc-viewport canvas')).toHaveCount(1)

    await clickWorkspaceTab(page, TAB_EXPORT)
    await expect
      .poll(async () => await page.locator('.vc-viewport canvas').count(), { timeout: 20_000 })
      .toBe(0)
    await expect(page.locator('.area-node--leaf')).toHaveCount(0)

    await clickWorkspaceTab(page, TAB_PREVIEW)
    await expect(page.locator('.vc-viewport canvas')).toHaveCount(1, { timeout: 60_000 })
  })
})
