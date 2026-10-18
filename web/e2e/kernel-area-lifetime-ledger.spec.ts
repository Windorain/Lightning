/**
 * M7-1 · **G4：Area 资源账本回基线**（真实菜单分割/合并 + 真实工作区切换）。
 *
 * ## 判据要钉的语义（SPEC §7.3-c，`SPEC.md:248`）
 *
 * 「显式关闭区域应释放其拥有的资源；状态保留不得依赖废弃组件永远隐藏存活。」
 * 可测量的形式就是 `runtime/lifecycle` 的账本：**没有活跃 Area 呈现时
 * `totalActive === 0` 且 `leaks() === []`**；每个显式关闭的实例留下一笔
 * `releasedTotal`；且 `AreaHost` 不得报生命周期错误
 * （`releaseFailed`/`closeFailed`/`instanceAlreadyOpen`/`resourceLeakOnClose`）。
 *
 * ## 读面（本包前置核实，S0-B 提示"先核实该调试读面存在与用法"）
 *
 * `WorkbenchRoot.vue:162-166` 暴露 `window.__areaHost__()` → `AreaHostApi`
 * （`editors/useAreaHost.ts:84-108`）带 `ledger: Ref<LifecycleLedger>`。
 * `totalActive`/`leaks` 是 `runtime/lifecycle` 的**纯函数**且生产未挂到 window，
 * 故 `e2e/helpers/areaLifetime.ts#readLedger` 按它们的**定义**
 * （`lifecycle.ts:162-168` / `:197-203`）从账本值现算 —— 同一套判定语义，不是替身。
 * `AreaHost` 的生命周期错误经 `AreaLayoutHost` 落到 `ctx.log.warn('Area 生命周期', …)`
 * （`workbench/components/AreaLayoutHost.vue:176`），读面 `__log__.recent(WARN|ERROR)`。
 *
 * ## 结构（先采全量读数，再逐条断言）
 *
 * 先红证据要有**完整**读数，不能停在第一处失败。故本文件把
 * 「单区 → 分割 → 合并 → 离开 → 再切回」五个阶段的账本与生命周期错误**全部采集**
 * （`LedgerJourney`），一次性打印，然后按阶段断言；断言消息里带实际值。
 *
 * ## 三条断言 + 两个负对照（防假绿）
 *
 * 1. **读面有区分力**：单区装载后 `totalActive` 必须 **= 6**（`VIEWPORT3D_RESOURCES`
 *    六类，`editors/areaRegistry.ts`）。读面恒 0 时"回基线"是空转 ⇒ 本对照专治该假绿。
 * 2. **分割 ⇒ 12，合并 ⇒ 6**（不是 12）：合并必须真的关掉被合并区那一份账。
 * 3. **离开工作区（呈现全部卸载）⇒ `totalActive === 0`、`leaks() === []`**，
 *    且 `releasedTotal` 单调增加（真的走了 `closeInstance`，不是"账本没记账"）。
 */

import { expect, test } from '@playwright/test'
import {
  clickMenuItem,
  clickWorkspaceTab,
  collectHint,
  MENU_MERGE,
  MENU_SPLIT_H,
  MENU_VIEW,
  openWorkbenchWithScene,
  readAreaState,
  readLedger,
  TAB_EXPORT,
  TAB_PREVIEW,
  type HintReading,
  type LedgerReading,
} from './helpers/areaLifetime'

/** `VIEWPORT3D_RESOURCES` 的条数（每个 viewport3d 实例 acquire 六类资源）。 */
const RESOURCES_PER_VIEWPORT = 6

interface Stage { name: string; ledger: LedgerReading; leaves: number; hint: HintReading }
interface LedgerJourney { stages: Stage[] }

async function capture(page: import('@playwright/test').Page, name: string): Promise<Stage> {
  const ledger = await readLedger(page)
  const area = await readAreaState(page)
  const hint = await collectHint(page)
  return { name, ledger, leaves: area.leafCount, hint }
}

function fmt(stages: Stage[]): string {
  return stages
    .map((s) =>
      '  [' + s.name + '] leaves=' + s.leaves +
      ' totalActive=' + s.ledger.totalActive +
      ' active=' + JSON.stringify(s.ledger.activeInstanceIds) +
      ' releasedTotal=' + s.ledger.releasedTotal +
      ' leaks=' + JSON.stringify(s.ledger.leaks.map((l) => l.instanceId)) +
      ' lifecycleErrors=' + JSON.stringify(s.hint.lifecycleErrors),
    )
    .join('\n')
}

test.describe('M7-1 · G4 Area 资源账本回基线（§7.3-c 显式关闭释放资源）', () => {
  test('G4 分割 → 合并 → 离开工作区 ⇒ totalActive===0 且 leaks()===[]', async ({ page }) => {
    test.setTimeout(300_000)
    const stages: Stage[] = []

    await openWorkbenchWithScene(page)
    stages.push(await capture(page, '① 单区装载'))

    // 真实菜单分割（视图 → 水平分割区域）
    await clickMenuItem(page, MENU_VIEW, MENU_SPLIT_H)
    await expect
      .poll(async () => (await readAreaState(page)).leafCount, { timeout: 30_000 })
      .toBe(2)
    await page.waitForTimeout(1200)
    stages.push(await capture(page, '② 分割为两区'))

    // 真实菜单合并（活动区 = 刚分割出的新区）
    await clickMenuItem(page, MENU_VIEW, MENU_MERGE)
    await expect
      .poll(async () => (await readAreaState(page)).leafCount, { timeout: 30_000 })
      .toBe(1)
    await page.waitForTimeout(1200)
    stages.push(await capture(page, '③ 合并回单区'))

    // 离开工作区：呈现全部卸载
    await clickWorkspaceTab(page, TAB_EXPORT)
    await expect
      .poll(async () => await page.locator('.area-node--leaf').count(), {
        message: '离开工作区后 Area 呈现必须真的被卸载（否则"回基线"是空转）',
        timeout: 20_000,
      })
      .toBe(0)
    await page.waitForTimeout(800)
    stages.push(await capture(page, '④ 离开工作区（呈现全卸载）'))

    // 再切回：证明"回零"不是读面坏掉
    await clickWorkspaceTab(page, TAB_PREVIEW)
    await expect
      .poll(async () => (await readAreaState(page)).leafCount, { timeout: 60_000 })
      .toBe(1)
    await page.waitForTimeout(1500)
    stages.push(await capture(page, '⑤ 再次切回'))

    const journey: LedgerJourney = { stages }
    console.log('[G4] 账本全程读数：\n' + fmt(stages))

    const [single, split, merged, away, back] = stages as [Stage, Stage, Stage, Stage, Stage]

    // ── ① 负对照 1：读面必须能看见"在用"（= 6，不是 0）──
    expect(single.ledger.activeInstanceIds, '单区装载后账本必须有恰好 1 个活跃实例').toHaveLength(1)
    expect(
      single.ledger.totalActive,
      '【负对照】单区装载后 totalActive 必须 = 6（读面恒 0 时"回基线"是空转）；实际 ' + single.ledger.totalActive,
    ).toBe(RESOURCES_PER_VIEWPORT)
    expect(single.ledger.leaks, '单区在用时 leaks 应恰好是那 1 个实例').toHaveLength(1)

    // ── ② 分割：两个实例各持六类资源 ──
    expect(
      split.ledger.activeInstanceIds,
      '分割后应有 2 个活跃实例（每个 Area 一个）；实际 ' + JSON.stringify(split.ledger.activeInstanceIds),
    ).toHaveLength(2)
    expect(
      split.ledger.totalActive,
      '⚠️ 分割后 totalActive 必须 = 2×6；实际 ' + split.ledger.totalActive,
    ).toBe(2 * RESOURCES_PER_VIEWPORT)

    // ── ③ 合并：回落到 1 个实例 ──
    expect(
      merged.ledger.activeInstanceIds,
      '⚠️ G4/D4：合并后账本必须只剩 1 个活跃实例（被合并区那一份必须 closeInstance）；实际 ' +
        JSON.stringify(merged.ledger.activeInstanceIds),
    ).toHaveLength(1)
    expect(
      merged.ledger.totalActive,
      '⚠️ G4/D4：合并后 totalActive 必须回落到 6（残留 12 = 被合并 Area 的账没销）；实际 ' +
        merged.ledger.totalActive,
    ).toBe(RESOURCES_PER_VIEWPORT)
    expect(
      merged.hint.lifecycleErrors,
      '⚠️ 合并路径不得出现 Area 生命周期错误；实际 ' + JSON.stringify(merged.hint.lifecycleErrors),
    ).toEqual([])

    // ── ④ 离开：回零 ──
    expect(
      away.ledger.totalActive,
      '⚠️ G4/D4：没有活跃 Area 时 totalActive 必须为 0（非 0 = 资源没人还）；实际 ' +
        away.ledger.totalActive + '，活跃实例 ' + JSON.stringify(away.ledger.activeInstanceIds),
    ).toBe(0)
    expect(
      away.ledger.leaks,
      '⚠️ G4：leaks() 必须为空数组；实际 ' + JSON.stringify(away.ledger.leaks.map((l) => l.instanceId)),
    ).toEqual([])
    expect(
      away.ledger.activeInstanceIds,
      '⚠️ G4：离开后不得残留活跃实例登记；实际 ' + JSON.stringify(away.ledger.activeInstanceIds),
    ).toEqual([])
    expect(
      away.ledger.releasedTotal,
      '⚠️ 两次显式关闭（合并 1 次 + 卸载 1 次）必须留下 ≥2 笔 releasedTotal —— 否则是"账本没记账"而非"资源已还"；实际 ' +
        away.ledger.releasedTotal,
    ).toBeGreaterThanOrEqual(2)
    expect(
      away.hint.lifecycleErrors,
      '⚠️ G4/D4：整条路径不得出现 Area 生命周期错误；实际 ' + JSON.stringify(away.hint.lifecycleErrors),
    ).toEqual([])

    // ── ⑤ 再切回：资源重新 acquire（证明"回零"不是读面失效）──
    expect(
      back.ledger.totalActive,
      '切回工作区后必须重新 acquire 一份资源（= 6），否则"回零"可能是读面失效；实际 ' + back.ledger.totalActive,
    ).toBe(RESOURCES_PER_VIEWPORT)
  })

  test('G4 负对照：账本读数必须能区分"在用/关闭"（不是恒 0 也不是恒非 0）', async ({ page }) => {
    test.setTimeout(180_000)
    await openWorkbenchWithScene(page)

    const inUse = await readLedger(page)
    expect(inUse.totalActive, '负对照：在用态必须非 0；实际 ' + inUse.totalActive).toBeGreaterThan(0)

    await clickWorkspaceTab(page, TAB_EXPORT)
    await expect
      .poll(async () => await page.locator('.area-node--leaf').count(), { timeout: 20_000 })
      .toBe(0)
    await page.waitForTimeout(800)
    const closed = await readLedger(page)
    console.log('[G4 负对照] inUse=' + inUse.totalActive + ' closed=' + closed.totalActive)

    expect(
      closed.totalActive,
      '负对照：关闭态必须与在用态不同（否则本文件主判据的 =0 恒真）',
    ).not.toBe(inUse.totalActive)
    expect(closed.activeInstanceIds, '负对照：关闭态不得仍有活跃实例').toEqual([])
  })
})
