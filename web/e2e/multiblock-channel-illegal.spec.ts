/**
 * T2.6 第二阶段 · 交付 5 —— **非法组合行为**：域外取值被夹取、耦合违规被夹取、UI 提示如实呈现、
 * 装配不崩。
 *
 * 三类"非法"在本仓库的契约里语义**各不相同**，必须分开验（不能糊成一条"非法就拒绝"）：
 *
 *  ① **域外取值**（如 `coil=99`）：
 *     契约 §5.2 推论 3「只夹取/回落，不拒绝」。真实 UI 上有**两道闸**：
 *       - 浏览器 `<input type=range>` 原生把 `value` 夹到 `min..max`（滑杆根本到不了域外）；
 *       - `clampChannelValue()`（`multiblockChannelUi.ts`）再把任何输入夹到 `0..domain.hi`。
 *     本用例**两条都验**：直接给滑杆写 99 → 断言它被原生夹到 `hi`，且装配结果 = 该域内值的
 *     参考网格（即"夹取发生了，且装配没崩、没渲染错"）。
 *     同时验面板给出的**取值域契约**（`min`/`max`/`data-mb-channel-hi`）确实覆盖了所有合法值。
 *
 *  ② **Tier 未声明抽样**（如 EBF `tt=3`，`tierSample=[1,2,14]`）：
 *     Tier 滑杆**不吸附**（`data-mb-tier` 显示 3），装配器按 §5.2 回落到最近抽样（2）并落 warning；
 *     面板必须**如实呈现**该回落提示，且 `data-mb-variant` 反映的是**用户请求**的键。
 *
 *  ③ **耦合违规**（LSC `capacitor >= glass`，`couplingMode: "clamp"`）：
 *     违规组合被夹取（`glass` 降到 `capacitor`），面板必须如实呈现 `耦合夹取：…` 提示，
 *     且装配结果 = 夹取后组合的参考网格。
 *
 * 全部经 DOM 驱动（真实滑杆 / 下拉），并经公开观测点断言（面板 `data-*` + 渲染定义逐格 diff）。
 */

import { expect, test } from '@playwright/test'
import {
  captureEvidence,
  diffSignatureGrids,
  drivePanel,
  gotoWorkbench,
  injectSceneDocumentOk,
  openChannelTabReady,
  readChannelPanel,
  readFixture,
  readRenderedDefinition,
  signatureGrid,
  snapshotOrFallbackReference,
  waitForRenderMatch,
  VIEWPORT_CANVAS,
  type FixtureReference,
} from './helpers/multiblock'

/** 等渲染定义收敛到某参考变体（返回渲染观测）。 */
async function waitForReference(page: Parameters<typeof readRenderedDefinition>[0], ref: FixtureReference, key: string) {
  const reference = ref.byVariant.get(key)
  expect(reference, `参考清单必须含 ${key}`).toBeTruthy()
  const observed = await waitForRenderMatch(async () => {
    const rendered = await readRenderedDefinition(page)
    const sig = signatureGrid(rendered.cellGrid, rendered.palette, 'idMeta')
    return { rendered, sig, diffCount: diffSignatureGrids(sig, reference!.signature).count }
  }, 20_000)
  const diff = diffSignatureGrids(observed.sig, reference!.signature)
  const panel = await readChannelPanel(page)
  expect(
    observed.diffCount,
    `${key}：渲染必须收敛到参考网格。实测面板 variant=${panel.variantKey} dims=${panel.dims} ` +
      `渲染 [d,h,w]=${observed.rendered.shape.join('×')} 参考=${reference!.dims.d}×${reference!.dims.h}×${reference!.dims.w} ` +
      `差异=${diff.count}/${diff.cells} ${JSON.stringify(diff.details)}`,
  ).toBe(0)
  return observed
}

test.describe('T2.6 · 非法组合行为（夹取 / 回落 / 耦合 clamp；只提示不拒绝）', () => {
  test('域外取值：滑杆原生夹到域上界，装配结果 = 域内取值的参考网格（不崩、不拒绝）', async ({ page }) => {
    test.setTimeout(180_000)
    const file = 'multiblock-ebf-2ch.json'
    const ref = snapshotOrFallbackReference(file)
    await gotoWorkbench(page)
    await injectSceneDocumentOk(page, readFixture(file).envelope, file)
    await openChannelTabReady(page)

    // 基线：域内合法组合
    await drivePanel(page, { tier: 2, runstate: 'idle', values: { height: 5, coil: 3, glass: 2 } })
    await waitForReference(page, ref, 'height:5|coil:3|glass:2|tt:2|runstate:idle')

    for (const c of [
      // `over` = 写进滑杆的域外值；`hi` = 期望被原生夹到的值；`assembledKey` = 装配实际命中的参考变体
      // （`coil=-7` → 滑杆 0 = Not set → 装配期回落到总 Tier=2 再按域夹取 → 命中 `coil:2`）
      { key: 'coil', over: 99, hi: 3, assembledKey: 'height:5|coil:3|glass:2|tt:2|runstate:idle' },
      { key: 'glass', over: 99, hi: 2, assembledKey: 'height:5|coil:3|glass:2|tt:2|runstate:idle' },
      { key: 'height', over: 99, hi: 5, assembledKey: 'height:5|coil:3|glass:2|tt:2|runstate:idle' },
      { key: 'coil', over: -7, hi: 0, assembledKey: 'height:5|coil:2|glass:2|tt:2|runstate:idle' },
    ] as const) {
      // 直接给滑杆写域外值：浏览器原生把 value 夹到 min..max
      await drivePanel(page, { values: { [c.key]: c.over } })
      const panel = await readChannelPanel(page)
      const got = panel.channels.find((x) => x.key === c.key)!
      expect(got.value, `${c.key}：滑杆原生必须把域外值 ${c.over} 夹到 ${c.hi}`).toBe(c.hi)
      expect(got.valueText, `${c.key}：数值文本必须反映夹取后的值`).toBe(c.hi === 0 ? 'Not set' : String(c.hi))

      // 装配必须落在"夹取后取值"的参考网格上（不崩、不渲染错）
      await waitForReference(page, ref, c.assembledKey)
      console.log(
        `[T2.6] 非法组合·域外：${c.key}=${c.over} → 滑杆 ${got.value}（域 0..${c.hi}）、` +
          `装配 = 参考 ${c.assembledKey}；notice=${JSON.stringify(panel.notices)}`,
      )
    }

    // 面板给的取值域必须能表达全部合法值（0 = Not set 必在域内）
    const panel = await readChannelPanel(page)
    for (const c of panel.channels) {
      expect(c.sliderMin, `${c.key}：Not set（0）必须在取值域内`).toBe(0)
      expect(c.sliderMax, `${c.key}：域上界`).toBeGreaterThanOrEqual(c.effMax)
    }
  })

  test('Tier 滑杆吸附已声明抽样：永不落到未声明 Tier；所有可达 Tier 都命中已声明变体', async ({ page }) => {
    test.setTimeout(180_000)
    const file = 'multiblock-ebf-2ch.json'
    const ref = snapshotOrFallbackReference(file)
    await gotoWorkbench(page)
    await injectSceneDocumentOk(page, readFixture(file).envelope, file)
    await openChannelTabReady(page)

    await drivePanel(page, { values: { height: 0, coil: 0, glass: 0 } })

    // EBF tierSample=[1,2,14]：滑杆**吸附**到已声明抽样（`snapTierToSample`），
    // 因此"未落在 tierSample 的 Tier"在 UI 上**不可达** —— 这是比"回落"更强的保证。
    //
    // ⚠️ 口径坑（踩过）：每个请求必须在**驱动后立刻**验证收敛。把 6 次驱动跑完再逐条验证
    // 是错的 —— 那时页面停在最后一个取值上，前面 5 条必然"不收敛"（假红）。
    const log: string[] = []
    for (const [requested, expected] of [
      [3, 2],
      [7, 2],
      [13, 14],
      [1, 1],
      [2, 2],
      [14, 14],
      [3, 2],
    ] as const) {
      await drivePanel(page, { tier: requested, runstate: 'idle' })
      const panel = await readChannelPanel(page)
      expect(panel.tier, `Tier 请求 ${requested} 必须吸附到已声明抽样 ${expected}`).toBe(expected)
      expect(
        panel.notices.some((n) => n.includes('未在 tierSample 中声明')),
        `吸附后落在已声明抽样上，不得出现"未声明 → 回落"提示。实测 ${JSON.stringify(panel.notices)}`,
      ).toBe(false)
      const key = `height:0|coil:0|glass:0|tt:${expected}|runstate:idle`
      expect(panel.variantKey, `Tier=${expected} 的面板变体键`).toBe(key)
      expect(ref.byVariant.has(key), `Tier=${expected} 必须是已声明组合`).toBe(true)
      await waitForReference(page, ref, key)
      log.push(`${requested}→${expected}`)
    }
    console.log(`[T2.6] Tier 吸附（全部命中已声明组合）：` + log.join(' / '))
  })

  test('LSC 耦合违规（capacitor < glass）：被夹取 + 耦合夹取提示如实呈现 + 几何 = 夹取后组合', async ({ page }) => {
    test.setTimeout(180_000)
    const file = 'multiblock-lsc-overlap.json'
    const ref = snapshotOrFallbackReference(file)
    await gotoWorkbench(page)
    await injectSceneDocumentOk(page, readFixture(file).envelope, file)
    await openChannelTabReady(page)

    // couplings: capacitor >= glass（couplingMode: clamp）
    // 违规：capacitor=1、glass=2 → glass 必须被夹到 1
    await drivePanel(page, { tier: 14, runstate: 'idle', values: { height: 5, capacitor: 1, glass: 2 } })
    const panel = await readChannelPanel(page)
    expect(
      panel.notices.some((n) => n.includes('耦合夹取') && n.includes('capacitor') && n.includes('glass')),
      `必须如实呈现耦合夹取提示。实测 ${JSON.stringify(panel.notices)}`,
    ).toBe(true)
    await waitForReference(page, ref, 'height:5|capacitor:1|glass:1|tt:14|runstate:idle')

    // 不违规：capacitor=2、glass=1 → 无耦合夹取提示
    await drivePanel(page, { values: { capacitor: 2, glass: 1 } })
    const ok = await readChannelPanel(page)
    expect(
      ok.notices.some((n) => n.includes('耦合夹取')),
      `不违规组合不得出现耦合夹取提示。实测 ${JSON.stringify(ok.notices)}`,
    ).toBe(false)
    await waitForReference(page, ref, 'height:5|capacitor:2|glass:1|tt:14|runstate:idle')

    // 边界：capacitor=1、glass=1（相等，耦合是 ge 故合法）
    await drivePanel(page, { values: { capacitor: 1, glass: 1 } })
    const eq = await readChannelPanel(page)
    expect(eq.notices.some((n) => n.includes('耦合夹取')), '相等必须合法（ge 允许相等）').toBe(false)
    await waitForReference(page, ref, 'height:5|capacitor:1|glass:1|tt:14|runstate:idle')

    console.log(
      `[T2.6] 非法组合·耦合 clamp：capacitor=1,glass=2 → glass 夹到 1（几何 = 夹取后组合）；` +
        `不违规与相等两种情形均无耦合提示`,
    )
  })

  test('Not set（0）回落总 Tier：越出通道自身取值域时被夹取，提示如实呈现', async ({ page }) => {
    test.setTimeout(180_000)
    const file = 'multiblock-lsc-overlap.json'
    const ref = snapshotOrFallbackReference(file)
    await gotoWorkbench(page)
    await injectSceneDocumentOk(page, readFixture(file).envelope, file)
    await openChannelTabReady(page)

    // tt=14 > capacitor 域上界 2：capacitor=0（Not set）回落 14 → 夹到 2
    await drivePanel(page, { tier: 14, runstate: 'idle', values: { height: 5, capacitor: 0, glass: 0 } })
    const panel = await readChannelPanel(page)
    expect(
      panel.notices.some((n) => n.includes('取值夹取：capacitor')),
      `Not set 回落越出通道域必须如实提示。实测 ${JSON.stringify(panel.notices)}`,
    ).toBe(true)
    // 夹取后 capacitor=2、glass=0→回落 14→夹到 2 → 耦合 ge 合法
    await waitForReference(page, ref, 'height:5|capacitor:0|glass:0|tt:14|runstate:idle')

    // 截图证据（内容不作判据）
    await captureEvidence(page, page.locator(VIEWPORT_CANVAS), 'LSC Not set 回落夹取', null)
    console.log(`[T2.6] 非法组合·Not set 回落：tt=14 时 capacitor/glass 被夹到域上界；notice=${JSON.stringify(panel.notices)}`)
  })
})
