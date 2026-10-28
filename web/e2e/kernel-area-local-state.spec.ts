/**
 * **G3：实例私有局部状态真写回/读回**（`localState` 接线判据；生产驱动）。
 *
 * ## 判据要钉的语义（SPEC §7.3-a/b）
 *
 * 「挂载、隐藏、调整布局和更换界面承载属于呈现生命周期，不自动结束逻辑编辑器实例」；
 * 「界面承载确需重新建立时，逻辑状态应在**首次呈现前**正确恢复」。
 *
 * 本仓的承载机制是 `Workspace.layout[areaId].localState[editorType]`
 * （`domain/workspace.ts:176-184`）：纯值、可序列化、随 Area 会话存活
 * （`Context.areaSession`）⇒ 组件卸载不会带走它。
 *
 * ## 为什么本判据此前必红（"判据自喂"缺口）
 *
 * `editors/useAreaHost.ts` 的 `captureLocalState`/`restoreLocalState` 当时**生产零调用**：
 * 老 `area-wiring.spec.ts` 用例先自己调 `host.captureLocalState(...)` 造输入，
 * 再断言切换后还在 —— 那只证明"纯转移不删键"（`domain/workspace.ts:465-476`），
 * 不证明"组件卸载前真的写进去了"。
 *
 * ⇒ 本判据的输入**只来自真实 UI**（点击视口下方栏 tab），观测只用生产读面
 * （`__areaHost__().restoreLocalState`、真实 DOM 选中态）。
 *
 * ## 被测的那一项状态（及为什么是它）
 *
 * `viewport3d` 的其它实例状态都已另有承载：机位在 `Main.cameras[region]`（跨组件存活，
 * G1/G2 钉住）、层高/帧/通道取值在内核（算子写文档呈现输入）、选择/历史在
 * `EditContext`/`Document`。**下方栏 tab（用户显式选择）没有其它承载**，
 * 换承载就会回到"文档形态默认"—— 本判据的观测点正是它。
 *
 * 判据强度：多方块文档（`multiblock-ebf-2ch.json`）的默认 tab 是「通道」
 * （`dockTabs#availableDockTabs` 的优先级），故"离开前选「分层预览」、回来后仍是
 * 「分层预览」"与默认值**可区分**；负对照用例把这条区分力钉死。
 */

import { expect, test, type Page } from '@playwright/test'
import {
  gotoWorkbench,
  injectSceneDocumentOk,
  readFixture,
  waitForViewportMounted,
} from './helpers/multiblock'
import { collectHint, leaveAndReturnWorkspace, readAreaState } from './helpers/areaLifetime'

/** 多方块夹具（默认 tab = 通道；与"分层预览"可区分）。 */
const FIXTURE = 'multiblock-ebf-2ch.json'

/** 打开工作台 + 注入多方块夹具 + 等真实 3D 视口挂载与 dock 就绪。 */
async function openMultiblock(page: Page): Promise<void> {
  await gotoWorkbench(page)
  const fx = readFixture(FIXTURE)
  await injectSceneDocumentOk(page, fx.envelope, FIXTURE)
  await waitForViewportMounted(page)
  // 下方栏的 tab 可用性随文档形态在装配后落地（`isMultiblock` 来自内核 body）
  await expect
    .poll(async () => page.locator('[data-dock-tab="channels"]').count(), {
      message: '多方块文档必须出现「通道」tab（否则本判据的默认值前提不成立）',
      timeout: 30_000,
    })
    .toBe(1)
}

/** 下方栏 tab 按钮（`ViewportFrameLayerDock.vue` 的 `data-dock-tab`）。 */
const tabButton = (tab: string): string => `[data-dock-tab="${tab}"]`

/** 生产读面：某 Area 某类型的局部状态（`useAreaHost#restoreLocalState` → 布局树）。 */
async function readLocalState(page: Page, areaId: string, editorType: string): Promise<Record<string, unknown> | null> {
  return (await page.evaluate(({ areaId, editorType }) => {
    const host = (window as any).__areaHost__?.() ?? null
    if (!host) return null
    const s = host.restoreLocalState(areaId, editorType) as Record<string, unknown> | undefined
    return s === undefined ? null : JSON.parse(JSON.stringify(s))
  }, { areaId, editorType })) as Record<string, unknown> | null
}

/** 当前**生效**的 dock tab（DOM 选中态；`null` = 下方栏未渲染）。 */
async function readActiveDockTab(page: Page): Promise<string | null> {
  return (await page.evaluate(() => {
    const el = document.querySelector('.vp-dock__tab--active')
    return el === null ? null : el.getAttribute('data-dock-tab')
  })) as string | null
}

test.describe('实例私有局部状态（localState）真写回/读回', () => {
  test('选「分层预览」→ 切走切回 ⇒ 下方栏选择逐字段恢复（并由生产写进布局树）', async ({ page }) => {
    test.setTimeout(240_000)
    await openMultiblock(page)

    const state0 = await readAreaState(page)
    expect(state0.areaIds.length, '前提：恰好 1 个 Area').toBe(1)
    const areaId = state0.areaIds[0]!

    // ── ① 前置：默认 tab 必须**不是**判据值（否则"恢复"与"回到默认"不可区分）──
    const before = await readActiveDockTab(page)
    expect(before, '前提：下方栏必须已渲染出 tab').not.toBeNull()
    expect(
      before,
      '前提：多方块文档的默认 tab 是「通道」；若默认恰好是「分层预览」，本判据无从区分"恢复"与"回到默认"',
    ).not.toBe('layer')

    // ── ② 真实点击「分层预览」（用户显式选择）──
    await page.locator(tabButton('layer')).click()
    await expect
      .poll(async () => readActiveDockTab(page), { message: '点击后「分层预览」必须生效', timeout: 15_000 })
      .toBe('layer')

    // ── ③ 真实工作区往返（helper 内含"呈现真的被卸载"的轮询断言）──
    await leaveAndReturnWorkspace(page)

    // ── ④ 判据：回来后仍是用户选的那个 tab；且布局树里逐字段就是它（生产写回）──
    const after = await readActiveDockTab(page)
    const savedAfter = await readLocalState(page, areaId, 'viewport3d')
    console.log('[G3] default=' + before + ' chosen=layer after=' + after + ' saved=' + JSON.stringify(savedAfter))

    expect(after, '⚠️ G3：切走再切回后，下方栏必须回到用户显式选择的「分层预览」（不是文档默认）').toBe('layer')
    expect(
      savedAfter,
      '⚠️ G3：局部状态必须真的写进 Workspace.layout.localState（生产写回，不是组件自持）',
    ).toEqual({ dockTab: 'layer' })
    await expect(page.locator('.vc-viewport canvas')).toHaveCount(1)
  })

  test('切编辑器类型再切回 ⇒ 局部状态逐字段恢复（§13「切回恢复局部状态」）', async ({ page }) => {
    test.setTimeout(240_000)
    await openMultiblock(page)
    const state0 = await readAreaState(page)
    const areaId = state0.areaIds[0]!

    await page.locator(tabButton('layer')).click()
    await expect.poll(async () => readActiveDockTab(page), { timeout: 15_000 }).toBe('layer')
    // 关实例之前，布局树里**还没有**这项状态（写回发生在关闭前 —— 这是设计的时序，
    // 也是本用例的负向前置：若哪天改成"每次变化都写"，这条会立刻红并提醒复核语义）
    expect(
      await readLocalState(page, areaId, 'viewport3d'),
      '前提：写回发生在关闭前（此处尚未关闭）',
    ).toBeNull()

    // 真实命令路径切类型（`OPERATOR_AREA_SET_EDITOR_TYPE`；菜单没有该入口）
    await page.evaluate(async (id) => {
      const ctx = (window as any).__vm__
      await ctx.getOperators().exec('OPERATOR_AREA_SET_EDITOR_TYPE', { areaId: id, editorType: 'timeline' })
    }, areaId)
    await expect
      .poll(async () => page.locator('.area-host[data-editor-type="timeline"]').count(), {
        message: '切类型后该 Area 必须真的换成 timeline 宿主', timeout: 20_000,
      })
      .toBe(1)

    // 关闭前已交回 ⇒ 旧类型的局部状态必须在布局树里（§13 负对照方向：不得丢）
    const whileAway = await readLocalState(page, areaId, 'viewport3d')
    expect(
      whileAway,
      '⚠️ G3：切类型关闭实例前必须把旧类型的局部状态写回（否则"切回恢复"无从谈起）',
    ).toEqual({ dockTab: 'layer' })

    // 切回
    await page.evaluate(async (id) => {
      const ctx = (window as any).__vm__
      await ctx.getOperators().exec('OPERATOR_AREA_SET_EDITOR_TYPE', { areaId: id, editorType: 'viewport3d' })
    }, areaId)
    await expect
      .poll(async () => page.locator('.area-host[data-editor-type="viewport3d"]').count(), { timeout: 20_000 })
      .toBe(1)
    await expect(page.locator('.vc-viewport canvas')).toHaveCount(1, { timeout: 60_000 })

    const restored = await readActiveDockTab(page)
    const hint = await collectHint(page)
    console.log('[G3/切类型] saved=' + JSON.stringify(whileAway) + ' restoredTab=' + restored
      + ' lifecycleErrors=' + JSON.stringify(hint.lifecycleErrors))
    expect(restored, '⚠️ 切回后必须恢复用户选择的下方栏 tab（首次呈现前恢复，不是先默认再改回）').toBe('layer')
    // 切类型关闭实例的两条纪律（D4）：
    //  ① 要么真关（旧账销掉、无 releaseFailed/closeFailed 噪音）；
    //  ② 要么报结构化原因 —— 不得留下"看起来 close 了但什么都没发生"的第三种形态。
    expect(
      hint.lifecycleErrors,
      '⚠️ 切类型关闭旧实例不得产生生命周期错误（releaseFailed/closeFailed 说明关错了 id）；实际 '
        + JSON.stringify(hint.lifecycleErrors),
    ).toEqual([])
  })

  test('负对照：默认 tab 与判据值必须可区分（否则"恢复"是空转）', async ({ page }) => {
    test.setTimeout(180_000)
    await openMultiblock(page)
    const def = await readActiveDockTab(page)
    expect(def, '负对照：默认 tab 必须有值').not.toBeNull()
    expect(def, '负对照：默认必须是「通道」（若默认就是「分层预览」，主判据的 toBe(layer) 恒真）').toBe('channels')

    // 显式选择后必须与默认不同（读面有区分力）
    await page.locator(tabButton('layer')).click()
    await expect.poll(async () => readActiveDockTab(page), { timeout: 15_000 }).toBe('layer')
  })
})