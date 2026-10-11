/**
 * **P10b（#282）· Area 产品接线的浏览器级验收**（真实 UI + 真实夹具 + 真实命令路径）。
 *
 * ## 本文件补什么（与单测的分工）
 *
 * `designUseCasesS16.test.ts` 在**纯域层**证明 `splitArea` 正确；
 * 但"工作台能真的分割出第二个 3D Area"是**产品级**事实 —— 它要求：
 *
 * ```
 * 真实菜单/命令 → 真实 Area 会话 → AreaLayoutHost 渲染 → 两个 WorkbenchViewport
 *   → 各自的 region（输入域/相机键/视口槽位）→ 各自的 WebGL 上下文
 * ```
 *
 * 零替身：全程真实组件实例，无 Mock/Stub，无测试专用 URL 参数。
 *
 * ## 判据（每条都读**真实 DOM 与真实内核**）
 *
 * 1. **可分割**：初始 1 个 `.vc-viewport` ⇒ 执行分割命令后 **2 个**；
 * 2. **两个都是真视口**：两个 `.vc-viewport` 都挂载了 canvas（不是空壳）；
 * 3. **机位独立**（A05 核心）：两个 Area 的相机键**不同**，且改一个不动另一个；
 * 4. **输入域独立**：两个 Area 的 `data-wm-region` 不同；
 * 5. **可合并**：合并后回到 1 个；
 * 6. **切类型保留局部状态**（§13/A13）：切走再切回，`localState` 逐字段相等。
 *
 * ## 负对照（证伪"判据恒真"）
 *
 * - 「两个视口共用机位」必须**可判红**：断言两个相机键不同 —— 若实现回退成
 *   共用 `'workbench'` 键，本断言立刻失败；
 * - 「合并后仍留 2 个」必须可判红：合并后 DOM 里必须只剩 1 个 `.vc-viewport`。
 */

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  gotoWorkbench,
  injectSceneDocumentOk,
  readFixture,
  waitForViewportMounted,
  VIEWPORT_CANVAS,
} from './helpers/multiblock'

const SHOT_DIR = path.join(import.meta.dirname, 'screenshots', 'p10b-area')

/** 经真实命令路径分割（`OPERATOR_AREA_SPLIT`），不是直接改状态。 */
async function splitArea(page: Page, direction: 'horizontal' | 'vertical'): Promise<void> {
  await page.evaluate(async (dir) => {
    const ctx = (window as any).__vm__
    await ctx.getOperators().exec('OPERATOR_AREA_SPLIT', { direction: dir })
  }, direction)
}

/** 读 Area 布局的**真实观测**（DOM + Area 会话，两者都对账）。 */
async function readAreaState(page: Page): Promise<{
  readonly domViewportCount: number
  readonly domRegions: readonly string[]
  readonly areaIds: readonly string[]
  readonly cameraKeys: readonly string[]
  readonly activeAreaId: string | null
}> {
  return await page.evaluate(() => {
    const ctx = (window as any).__vm__
    const host = (window as any).__areaHost__?.()
    // 只取**叶子单元格**：`.area-host` 自身也带 `data-area-id`（它是同一个 Area 的
    // 生命周期宿主），故裸 `[data-area-id]` 会把每个 Area 数两次（实测 2 Area → 4）。
    const cells = Array.from(document.querySelectorAll('.area-node--leaf[data-area-id]')) as HTMLElement[]
    const domRegions = cells.map((c) => c.dataset.wmRegion ?? '')
    return {
      domViewportCount: document.querySelectorAll('.vc-viewport').length,
      domRegions,
      areaIds: host ? [...host.areaIds.value] : [],
      // 相机键取自 `Main` 的**实际分配**（不是从布局推导）——这样"共用机位"
      // 这种回退会如实暴露（两个 Area 只会产出一个键）。
      cameraKeys: ctx.main.cameraKeys(),
      activeAreaId: host ? host.activeAreaId.value : null,
    }
  })
}

test.describe('P10b · Area 产品接线（真实双 3D Area）', () => {
  test('分割出第二个 3D 视口：两个真 canvas + 机位独立 + 输入域独立', async ({ page }, testInfo) => {
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    await gotoWorkbench(page)

    const fx = readFixture('multiblock-tier-only.json')
    await injectSceneDocumentOk(page, fx.envelope, 'multiblock-tier-only.json')
    await waitForViewportMounted(page)

    // ── ① 初始：恰好 1 个视口 ──
    const before = await readAreaState(page)
    expect(before.domViewportCount, '初始应恰好 1 个 3D 视口').toBe(1)
    expect(before.areaIds.length, '初始应恰好 1 个 Area').toBe(1)

    // ── ② 经**真实命令**分割 ──
    await splitArea(page, 'horizontal')
    await expect
      .poll(async () => (await readAreaState(page)).domViewportCount, {
        message: '分割后应出现第 2 个 3D 视口',
        timeout: 20_000,
      })
      .toBe(2)

    const after = await readAreaState(page)
    expect(after.areaIds.length, '分割后应有 2 个 Area').toBe(2)
    expect(after.domRegions.length, '两个 Area 都应标出 region').toBe(2)

    // ── ③ 输入域**独立**（否则输入会路由到同一个 Area）──
    const uniqueRegions = new Set(after.domRegions)
    expect(
      uniqueRegions.size,
      `两个 Area 的 region 必须不同（实测 ${JSON.stringify(after.domRegions)}）——` +
        '共用 region 会让两个视口共享输入域与机位',
    ).toBe(2)

    // ── ④ 两个都是**真**视口：各有 canvas（不是空壳）──
    const canvases = await page.locator(`${VIEWPORT_CANVAS} canvas`).count()
    expect(canvases, '两个视口都应有真实 canvas（WebGL 上下文各自创建）').toBeGreaterThanOrEqual(2)

    // ── ⑤ 机位**独立**（A05 核心判据）──
    // 相机键按 region 分配 ⇒ 两个 Area 各有一个键。
    // 负对照：若实现回退成共用 `'workbench'`，这里只会看到 1 个键 ⇒ 判红。
    const viewportCameraKeys = after.cameraKeys.filter((k) => k.startsWith('r-viewport'))
    expect(
      viewportCameraKeys.length,
      `两个 3D Area 必须各有自己的相机键（实测 ${JSON.stringify(after.cameraKeys)}）——` +
        '共用键就是 A05 判红的"机位不独立"形态',
    ).toBe(2)

    // ── ⑥ 改一个 Area 的机位，另一个**不动** ──
    const independent = await page.evaluate(() => {
      const ctx = (window as any).__vm__
      const host = (window as any).__areaHost__()
      const ids = [...host.areaIds.value] as string[]
      const keyA = ids[0]
      const keyB = ids[1]
      // 两个 region 名与布局 id 的对应（根 Area 用 r-viewport，其余带后缀）
      const regions = Array.from(document.querySelectorAll('.area-node--leaf[data-area-id]') as NodeListOf<HTMLElement>)
        .map((c) => ({ areaId: c.dataset.areaId ?? '', region: c.dataset.wmRegion ?? '' }))
      const regA = regions.find((r) => r.areaId === keyA)?.region ?? ''
      const regB = regions.find((r) => r.areaId === keyB)?.region ?? ''
      const camA = ctx.main.ensureCamera(regA)
      const camB = ctx.main.ensureCamera(regB)
      camA.value = { yawDeg: 11, elevationDeg: 22, distance: 33, zoom: 1, target: { x: 1, y: 2, z: 3 } }
      camB.value = { yawDeg: 99, elevationDeg: 88, distance: 77, zoom: 1, target: { x: 9, y: 8, z: 7 } }
      return {
        regA, regB,
        aAfter: camA.value?.yawDeg ?? null,
        bAfter: camB.value?.yawDeg ?? null,
      }
    })
    expect(independent.regA, '第一个 Area 的 region 应可解析').not.toBe('')
    expect(independent.regB, '第二个 Area 的 region 应可解析').not.toBe('')
    expect(
      independent.aAfter,
      '改第二个 Area 的机位**不得**影响第一个（A05「保持独立观察视角」）',
    ).toBe(11)
    expect(independent.bAfter, '第二个 Area 的机位应是刚设置的值').toBe(99)

    const shot = path.join(SHOT_DIR, `dual-area-${testInfo.project.name}.png`)
    await page.screenshot({ path: shot })
    console.log(
      `[P10b] 双 Area：regions=${JSON.stringify(after.domRegions)} ` +
        `cameraKeys=${JSON.stringify(viewportCameraKeys)} canvases=${canvases}`,
    )
  })

  test('**负对照**：合并后回到 1 个视口（证伪"分割只增不减"）', async ({ page }) => {
    await gotoWorkbench(page)
    const fx = readFixture('multiblock-tier-only.json')
    await injectSceneDocumentOk(page, fx.envelope, 'multiblock-tier-only.json')
    await waitForViewportMounted(page)

    await splitArea(page, 'vertical')
    await expect.poll(async () => (await readAreaState(page)).domViewportCount, { timeout: 20_000 }).toBe(2)

    // 合并**活动** Area（分割后活动区是新 Area）
    await page.evaluate(async () => {
      const ctx = (window as any).__vm__
      await ctx.getOperators().exec('OPERATOR_AREA_MERGE', {})
    })
    await expect
      .poll(async () => (await readAreaState(page)).domViewportCount, {
        message: '合并后必须回到 1 个视口（否则"合并"是空操作）',
        timeout: 20_000,
      })
      .toBe(1)

    const after = await readAreaState(page)
    expect(after.areaIds.length, '合并后应只剩 1 个 Area').toBe(1)
  })

  test('切类型保留局部状态：切走再切回逐字段相等（§13/A13）', async ({ page }) => {
    await gotoWorkbench(page)
    const fx = readFixture('multiblock-tier-only.json')
    await injectSceneDocumentOk(page, fx.envelope, 'multiblock-tier-only.json')
    await waitForViewportMounted(page)

    const result = await page.evaluate(async () => {
      const ctx = (window as any).__vm__
      const host = (window as any).__areaHost__()
      const areaId = host.areaIds.value[0] as string
      // 写入一份"该类型的局部状态"（模拟视口记下自己的观察视角）
      host.captureLocalState(areaId, 'viewport3d', { yawDeg: 45, elevationDeg: 30, distance: 20 })
      const saved = host.restoreLocalState(areaId, 'viewport3d')
      // 切到另一个类型
      await ctx.getOperators().exec('OPERATOR_AREA_SET_EDITOR_TYPE', { areaId, editorType: 'inspector' })
      const afterSwitch = host.restoreLocalState(areaId, 'viewport3d')
      // 切回来
      await ctx.getOperators().exec('OPERATOR_AREA_SET_EDITOR_TYPE', { areaId, editorType: 'viewport3d' })
      const afterSwitchBack = host.restoreLocalState(areaId, 'viewport3d')
      return { saved, afterSwitch, afterSwitchBack }
    })

    expect(result.saved, '写入后应能读回局部状态').toMatchObject({ yawDeg: 45, distance: 20 })
    expect(
      result.afterSwitch,
      '切走后**不得**删除旧类型的局部状态（删除就是 A13 负对照"丢掉编辑器状态"）',
    ).toMatchObject({ yawDeg: 45 })
    expect(
      result.afterSwitchBack,
      '切回后必须逐字段恢复（§13「切回恢复局部状态」）',
    ).toEqual(result.saved)
  })
})
