/**
 * P2.5 · 断言有效性证伪（**防止部件断言包恒绿**）。
 *
 * 计划 P2.5 自检：「篡改 fixture 一个计数 → 必红」；任务口径：「篡改 fixture 一个
 * 计数 / 一个部件 displayName → 对应断言必红（spec 内以变形副本方式做，不改
 * fixture 原件）」。
 *
 * 三条纪律（与多方块轮证伪一致）：
 *  1. **仓库 fixture 原件一字不改**：篡改只发生在测试内存里的注入副本
 *     （`cloneFixture`），注入路径与原件完全相同（OPERATOR_OPEN_SCENE + File）。
 *  2. **红色必须来自断言，而不是解析失败**：每个用例先断言篡改副本仍正常加载
 *     （`injectSceneDocumentOk` 内部已断言 `docLoaded === true`），再用
 *     `captureAsyncFailure` 验证**断言确实抛出**。
 *  3. **证伪必须定向**：计数篡改只打红统计计数断言（宿主视图行集仍绿）；
 *     displayName 篡改只打红该部件的 tooltip/行名断言（同格另一部件仍绿）。
 */

import { expect, test } from '@playwright/test'
import {
  gotoWikiPreviewWithScene,
  probeHover,
  clearWikiHover,
  readStatsSidebarSettled,
  waitStatsSidebarReady,
  switchStatsView,
  readPartsFixture,
  readPartsObservation,
  cloneFixture,
  augmentFixtureGeometry,
  normalizeTextureBlobsForRender,
  quadCenter,
  type QuadCorners,
} from './helpers/parts'

/** 跑一个异步断言，返回捕获到的错误（未抛则返回 null）。 */
async function captureAsyncFailure(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
    return null
  } catch (e) {
    return e
  }
}

/** 与主断言包同源的 AE2 几何增强（悬停证伪用；部件数据保持被测原样）。 */
function augmentedAe2(fixture: Record<string, unknown>): {
  fixture: Record<string, unknown>
  quads: { cable: QuadCorners; toggle: QuadCorners; storage: QuadCorners }
} {
  const cable = [[0.375, 0.375, 0.375], [0.375, 0.375, 0.625], [0.375, 0.625, 0.625], [0.375, 0.625, 0.375]] as QuadCorners
  const toggle = [[0.375, 0.375, 0], [0.625, 0.375, 0], [0.625, 0.625, 0], [0.375, 0.625, 0]] as QuadCorners
  const storage = [[0.1875, 1, 0.1875], [0.8125, 1, 0.1875], [0.8125, 1, 0.8125], [0.1875, 1, 0.8125]] as QuadCorners
  const f = normalizeTextureBlobsForRender(augmentFixtureGeometry(fixture, 1, [cable, toggle, storage]))
  return { fixture: f, quads: { cable, toggle, storage } }
}

/**
 * 展开侧栏交互只在 desktop 跑（与主断言包同一跳过理由，见
 * `parts-hover-stats.spec.ts` 的 EXPANDED_SIDEBAR_DESKTOP_ONLY 登记）：
 * mobile 窄布局下自动折叠 watcher ~50ms 内把展开态折回（probe 实证），
 * 统计行/视图切换断言无法稳定进行。
 */
const EXPANDED_SIDEBAR_DESKTOP_ONLY =
  'mobile 窄布局自动折叠振荡（展开 ~50ms 内被 watcher 折回，probe 实证）；展开态统计交互仅 desktop 跑'

test.describe('P2.5 证伪 · 篡改计数 → 统计断言必红', () => {
  test('slab fixture：partLists[0] 物品 count 1→2 → 计数断言红、宿主视图断言仍绿', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', EXPANDED_SIDEBAR_DESKTOP_ONLY)
    test.setTimeout(240_000)

    // ── 基线：未篡改原件 → 全绿（同一页面先建立对照）──
    await gotoWikiPreviewWithScene(page, readPartsFixture('parts-singlebox-mix.v2.json'), 'parts-singlebox-mix.v2.json', { requireMesh: false })
    await waitStatsSidebarReady(page)
    const clean = await readStatsSidebarSettled(page)
    expect(clean.rows.map((r) => [r.name, r.qty]), '基线：Stone Slab×3 / Fence×1').toEqual([
      ['Stone Slab', '3'],
      ['Fence', '1'],
    ])

    // ── 篡改：两个下半 slab 共享 partLists[0]（契约 §2.1 去重），其物品 count 1→2
    //    ⇒ 期望 Stone Slab 计数 3 → 2+2+1 = 5。解析仍合法（数值字段，无 schema 破坏）。──
    const tampered = cloneFixture(readPartsFixture('parts-singlebox-mix.v2.json'))
    const partLists = (tampered.frames as any[])[0].structure.partLists as any[]
    const before = partLists[0][0].items[0].count
    partLists[0][0].items[0].count = before + 1
    expect(partLists[0][0].items[0].count, '篡改必须真的改动了计数').toBe(before + 1)

    await gotoWikiPreviewWithScene(page, tampered, 'parts-singlebox-mix.tampered-count.json', { requireMesh: false })
    await waitStatsSidebarReady(page)
    const dirty = await readStatsSidebarSettled(page)
    // 篡改确实沿公开观测透出：Stone Slab 计数 3 → 5
    const slabRow = dirty.rows.find((r) => r.key === 'minecraft:stone_slab:0')
    expect(slabRow?.qty, '篡改后 Stone Slab 计数应变为 5（两格共享 partLists[0]）').toBe('5')

    // ── 固化：主断言包的计数断言在篡改副本上必须抛出（管线变红）──
    const err = await captureAsyncFailure(async () => {
      expect(dirty.rows.map((r) => [r.name, r.qty]), '篡改后仍按原件期望比对').toEqual([
        ['Stone Slab', '3'],
        ['Fence', '1'],
      ])
    })
    expect(err, '计数篡改后统计断言必须抛出（必红）').not.toBeNull()
    console.log(`[P2.5] 证伪（计数 3→5）→ 断言红：${(err as Error).message.split('\n')[0]}`)

    // ── 定向性：宿主视图（旧口径，不经部件物品计数）仍必须全绿 ──
    const hosts = await switchStatsView(page, 'hosts')
    expect(hosts.rows.map((r) => [r.key, r.qty]), '物品计数篡改不影响宿主口径').toEqual([
      ['minecraft:fence', '1'],
      ['minecraft:stone', '1'],
      ['minecraft:stone_slab', '2'],
      ['minecraft:stone_slab@8', '1'],
    ])

    // 解析级对照：篡改后的部件数据沿 Grid API 透出（证明红来自数据而非管线崩坏）
    const cells = await readPartsObservation(page)
    const slabCell = cells.find((c) => c.pos.x === 0)!
    expect(slabCell.parts![0]!.itemCounts).toEqual([before + 1])
  })
})

test.describe('P2.5 证伪 · 篡改 displayName → 悬停/统计断言必红', () => {
  test('AE2 fixture：ME Toggle Bus 改名 → 该部件 tooltip/行名断言红，同格线缆断言仍绿', async ({ page }, testInfo) => {
    // 悬停部分在 mobile 可跑，但统计行名断言依赖展开态（同 EXPANDED_SIDEBAR_DESKTOP_ONLY）
    test.skip(testInfo.project.name !== 'desktop-chrome', EXPANDED_SIDEBAR_DESKTOP_ONLY)
    test.setTimeout(240_000)
    const TOGGLE_NAME = 'ME Toggle Bus'
    const TAMPERED_NAME = 'ME Toggle Bus TAMPERED'

    // ── 篡改：partLists[0] 第 2 个部件（ae2:NORTH）displayName ──
    const tampered = cloneFixture(readPartsFixture('parts-ae2-multibox.v2.json'))
    const parts = (tampered.frames as any[])[0].structure.partLists[0] as any[]
    expect(parts[1].localId, '篡改目标必须是 ae2:NORTH').toBe('ae2:NORTH')
    expect(parts[1].displayName, '篡改前必须是原名').toBe(TOGGLE_NAME)
    parts[1].displayName = TAMPERED_NAME

    const aug = augmentedAe2(tampered)
    await gotoWikiPreviewWithScene(page, aug.fixture, 'parts-ae2-multibox.tampered-name.json')

    // ── 篡改确实透出：悬停状态的部件显示名 = 被篡改名 ──
    const toggle = await probeHover(page, { col: 0, row: 0, z: 0, ...quadCenter(aug.quads.toggle) })
    expect(toggle.hover.part?.localId, '命中判定不受改名影响（盒未动）').toBe('ae2:NORTH')
    expect(toggle.hover.part?.displayName).toBe(TAMPERED_NAME)
    expect(toggle.tooltip).toContain(TAMPERED_NAME)

    // ── 固化一：主断言包的 tooltip 断言（期望原名）在篡改副本上必须抛出 ──
    const tipErr = await captureAsyncFailure(async () => {
      expect(toggle.tooltip, 'tooltip 应显示原 displayName').toContain(TOGGLE_NAME)
      expect(toggle.tooltip).not.toContain(TAMPERED_NAME)
    })
    expect(tipErr, 'displayName 篡改后 tooltip 断言必须抛出（必红）').not.toBeNull()
    console.log(`[P2.5] 证伪（displayName）→ 悬停断言红：${(tipErr as Error).message.split('\n')[0]}`)

    // ── 固化二：统计行名断言（期望原名）也必须抛出 ──
    await waitStatsSidebarReady(page)
    const s = await readStatsSidebarSettled(page)
    const toggleRow = s.rows.find((r) => r.key === 'appliedenergistics2:item.ItemMultiPart:80')
    expect(toggleRow?.name, '统计行名沿篡改透出').toBe(TAMPERED_NAME)
    const rowErr = await captureAsyncFailure(async () => {
      expect(s.rows.map((r) => r.name), '行名应含原 displayName').toContain(TOGGLE_NAME)
    })
    expect(rowErr, 'displayName 篡改后统计行名断言必须抛出（必红）').not.toBeNull()

    // ── 定向性：同格中心线缆（未篡改部件）悬停断言仍全绿 ──
    const cable = await probeHover(page, { col: 0, row: 0, z: 0, ...quadCenter(aug.quads.cable) })
    expect(cable.hover.part?.localId).toBe('ae2:UNKNOWN')
    expect(cable.tooltip).toContain('ME Glass Cable - Fluix')
    const cableRow = s.rows.find((r) => r.key === 'appliedenergistics2:item.ItemMultiPart:16')
    expect(cableRow?.name, '未篡改部件的行名不受影响').toBe('ME Glass Cable - Fluix')

    await clearWikiHover(page)
  })
})
