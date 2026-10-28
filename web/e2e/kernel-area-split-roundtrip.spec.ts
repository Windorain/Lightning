/**
 * **G2：多区分割往返后仍是两个区、两个机位各自不变**（真实菜单分割 + 真实工作区切换）。
 *
 * ## 判据要钉的语义（SPEC §7.3-a/b）
 *
 * 分割出的第二个 Area 是**另一个编辑器实例**（A05「保持独立观察视角」的前提）。
 * 工作区往返属呈现生命周期 ⇒ 回来后必须仍是两个区、分割方向/比例不变、
 * 两个区各自的机位**逐字段**不变，且两区机位**不串**（§10.5「一个生命周期变化
 * 不能无条件终止其他生命周期」）。
 *
 * ## 当前预期（§2.2 状态寿命表）
 *
 * 布局活在 `Context.areaSession`（`runtime/host/workbenchHost.ts:168-180`）⇒ 区数与分割
 * 应当保住；但两个机位在重挂时各自走一遍 `attachViewport` 的 INIT
 * （`runtime/attachViewport.ts:115-123`），而 `cameraInit.forget` 已在卸载时发生
 * （`runtime/viewportManager.ts:119-128`）⇒ **两个机位都会被重新框选**。预期先红。
 *
 * ## 防假绿
 *
 * 1. 两区机位先被设成**两个不同的**非默认姿态，并断言逻辑机位等于写入值、
 *    且两者互不相等 —— 否则"两区机位各自不变"会被"两区共用一个机位"蒙混过关；
 * 2. 分割走**真实菜单**（视图 → 水平分割区域），不是直接改布局值；
 * 3. 往返前先断言呈现真的被卸载（`leaveAndReturnWorkspace` 内轮询叶子/画布归零），
 *    同时断言 Area 会话仍在且**还是两个区**（逻辑布局不随组件存亡）。
 */

import { expect, test } from '@playwright/test'
import {
  clickMenuItem,
  expectEngineClose,
  leaveAndReturnWorkspace,
  MENU_MERGE,
  MENU_SPLIT_H,
  MENU_VIEW,
  openWorkbenchWithScene,
  POSE_A,
  POSE_B,
  readAreaState,
  readCamera,
  readLayoutSignature,
  setCamera,
} from './helpers/areaLifetime'

test.describe('多区分割 + 工作区往返（布局与两区机位各自存活）', () => {
  test('分割出第二区 → 两区各自挪机位 → 切走切回 ⇒ 仍是两区、两机位各自不变', async ({ page }) => {
    test.setTimeout(300_000)

    await openWorkbenchWithScene(page)
    const single = await readAreaState(page)
    expect(single.areaIds.length, '初始应恰好 1 个 Area').toBe(1)

    // ── ① 真实菜单分割（视图 → 水平分割区域）──
    await clickMenuItem(page, MENU_VIEW, MENU_SPLIT_H)
    await expect
      .poll(async () => {
        const s = await readAreaState(page)
        return s.leafCount + ':' + s.canvasCount
      }, { message: '分割后必须出现两个 Area 且各自挂上真实 canvas', timeout: 30_000 })
      .toBe('2:2')
    // 第二区的自动框选在 @ready 之后落地，等够再设机位
    await page.waitForTimeout(1500)

    const splitState = await readAreaState(page)
    expect(splitState.areaIds.length, '分割后应有 2 个 Area').toBe(2)
    const leafOf = (areaId: string): string => {
      const leaf = splitState.leaves.find((l) => l.areaId === areaId)
      expect(leaf, '每个 Area 必须能在 DOM 上解析出自己的 region（实测 ' + JSON.stringify(splitState.leaves) + '）').toBeTruthy()
      return leaf!.region
    }
    const regA = leafOf(splitState.areaIds[0]!)
    const regB = leafOf(splitState.areaIds[1]!)
    expect(regA, '两个 Area 的 region 必须不同（共用 region ⇒ 共用机位 ⇒ A05 判红形态）').not.toBe(regB)

    // ── ② 两区各自挪到**不同**的非默认机位 ──
    await setCamera(page, regA, POSE_A)
    await setCamera(page, regB, POSE_B)
    const camA1 = await readCamera(page, regA)
    const camB1 = await readCamera(page, regB)
    expect(camA1.logical, '【前提】A 区机位必须真的写进逻辑机位').toEqual(POSE_A)
    expect(camB1.logical, '【前提】B 区机位必须真的写进逻辑机位').toEqual(POSE_B)
    expect(camA1.logical, '【前提】两区机位必须不同（否则"各自不变"无从观测）').not.toEqual(camB1.logical)
    const layout1 = await readLayoutSignature(page)
    expect(layout1.areas.length, '布局签名应含 2 个叶子').toBe(2)
    expect(layout1.splits.length, '布局签名应含 1 个分割节点').toBe(1)

    // ── ③ 真实工作区往返 ──
    const { awayArea } = await leaveAndReturnWorkspace(page, undefined, undefined, { expectLeaves: 2 })
    expect(awayArea.areaIds.length, '离开工作区后 Area 会话必须仍是 2 个区（§7.3-a）').toBe(2)

    // ── ④ 判据：区数 / 分割结构 / region 归属 / 两区机位 ──
    const afterState = await readAreaState(page)
    const layout2 = await readLayoutSignature(page)
    const camA2 = await readCamera(page, regA)
    const camB2 = await readCamera(page, regB)
    console.log(
      '[G2] areas=' + JSON.stringify(splitState.areaIds) + '→' + JSON.stringify(afterState.areaIds) +
      '\n     layout=' + JSON.stringify(layout1) + '→' + JSON.stringify(layout2) +
      '\n     A=' + JSON.stringify(camA1.logical) + '→' + JSON.stringify(camA2.logical) +
      '\n     B=' + JSON.stringify(camB1.logical) + '→' + JSON.stringify(camB2.logical),
    )

    expect(afterState.areaIds, '切回后仍是同样两个 Area（不得回到单区）').toEqual(splitState.areaIds)
    expect(afterState.leaves, '切回后 areaId→region 归属必须不变').toEqual(splitState.leaves)
    expect(layout2, '⚠️ G2：切回后分割结构（区数/方向/比例/类型）必须逐字段不变').toEqual(layout1)
    expect(
      camA2.logical,
      '⚠️ G2/D1：切回后 A 区逻辑机位必须逐字段等于用户挪到的机位',
    ).toEqual(camA1.logical)
    expect(
      camB2.logical,
      '⚠️ G2/D1：切回后 B 区逻辑机位必须逐字段等于用户挪到的机位',
    ).toEqual(camB1.logical)
    expect(camA2.logical, '⚠️ 两区机位不得串位（A 读到的不能是 B 的姿态）').not.toEqual(camB2.logical)
    expectEngineClose(camA2.engine, camA1.engine, '⚠️ 切回后 A 区引擎取景')
    expectEngineClose(camB2.engine, camB1.engine, '⚠️ 切回后 B 区引擎取景')
    expect(camA2.engine.m, '切回后 A 区必须有真实引擎相机').not.toBeNull()
    expect(camB2.engine.m, '切回后 B 区必须有真实引擎相机').not.toBeNull()
  })

  test('负对照：布局签名读面必须能区分 1 区 / 2 区（否则主判据 toEqual 恒绿）', async ({ page }) => {
    test.setTimeout(240_000)
    await openWorkbenchWithScene(page)

    const one = await readLayoutSignature(page)
    expect(one.areas.length, '负对照：单区时签名应有 1 个叶子').toBe(1)
    expect(one.splits, '负对照：单区时不应有分割节点').toEqual([])

    await clickMenuItem(page, MENU_VIEW, MENU_SPLIT_H)
    await expect
      .poll(async () => (await readAreaState(page)).leafCount, { timeout: 30_000 })
      .toBe(2)
    const two = await readLayoutSignature(page)
    expect(
      two,
      '负对照：分割后签名必须与单区不同 —— 若读面恒返回同一值，主判据的 layout toEqual 就是空转',
    ).not.toEqual(one)
    expect(two.splits, '负对照：分割后应恰好 1 个分割节点').toHaveLength(1)

    await clickMenuItem(page, MENU_VIEW, MENU_MERGE)
    await expect
      .poll(async () => (await readAreaState(page)).leafCount, { timeout: 30_000 })
      .toBe(1)
    const backToOne = await readLayoutSignature(page)
    expect(backToOne.areas.length, '负对照：合并回单区后签名应回到 1 个叶子').toBe(1)
    expect(backToOne, '负对照：合并回单区后签名必须与最初单区签名一致（读面是纯读，不带副作用）').toEqual(one)
  })
});
