/**
 * 断言有效性证伪（**防止部件断言包恒绿**）。
 *
 * 自检要求：「篡改 fixture 一个计数 → 必红」；口径：「篡改 fixture 一个
 * 计数 / 一个部件 displayName → 对应断言必红（spec 内以变形副本方式做，不改
 * fixture 原件）」。
 *
 * 三条纪律（与多方块轮证伪一致）：
 *  1. **仓库 fixture 原件一字不改**：篡改只发生在测试内存里的注入副本
 *     （`cloneFixture`），注入路径与原件完全相同（OPERATOR_OPEN_SCENE + File）。
 *  2. **红色必须来自断言，而不是解析失败**：每个用例先断言篡改副本仍正常加载
 *     （`injectSceneDocumentOk` 内部已断言 `docLoaded === true`），再用
 *     `captureAsyncFailure` 验证**断言确实抛出**。
 *  3. **证伪必须定向**：计数篡改只打红被篡改的物品行计数断言（行集/顺序与同视图内
 *     未篡改行仍绿 —— B-3 后宿主视图已不存在，定向性判据由"同页另一行不受影响"承担）；
 *     displayName 篡改只打红该部件的 tooltip/行名断言（同格另一部件仍绿）。
 */

import { expect, test } from '@playwright/test'
import {
  gotoWikiPreviewWithScene,
  probeHover,
  clearWikiHover,
  clickStatsRow,
  hoverStatsRow,
  leaveStatsRow,
  readOutlineMask,
  readStatsSidebarSettled,
  readTooltipText,
  waitStatsSidebarReady,
  readPartsFixture,
  readPartsObservation,
  cloneFixture,
  augmentFixtureGeometry,
  normalizeTextureBlobsForRender,
  quadCenter,
  type QuadCorners,
} from './helpers/parts'
import { pollUntil } from './helpers/multiblock'

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

test.describe('篡改计数 → 统计断言必红', () => {
  test('slab fixture：partLists[0] 物品 count 1→2 → 计数断言红，且篡改只打红被篡改的行', async ({ page }, testInfo) => {
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
    console.log(`[部件] 证伪（计数 3→5）→ 断言红：${(err as Error).message.split('\n')[0]}`)

    // ── 定向性：篡改只动 Stone Slab 的计数 —— 行集/顺序与同视图内未篡改行必须不随之变化 ──
    //    （B-3 决策 C 已整套移除「宿主视图」切换（`switchStatsView` 已删）⇒ 原「切宿主视图 ⇒
    //    旧口径行集不动」的定向性无法以原形态成立；改由同视图内定向性承担（语义等价且更贴近
    //    当前契约）：篡改的污染面只落在被篡改的物品行上，未篡改行逐项不变。）
    expect(
      dirty.rows.map((r) => r.key),
      '行集/顺序不因计数篡改而变化（slab 5 件仍居首）',
    ).toEqual(['minecraft:stone_slab:0', 'minecraft:fence:0'])
    expect(
      dirty.rows.filter((r) => r.key !== 'minecraft:stone_slab:0').map((r) => [r.name, r.qty]),
      '物品计数篡改不影响其它物品行（定向性）',
    ).toEqual([['Fence', '1']])

    // 解析级对照：篡改后的部件数据沿 Grid API 透出（证明红来自数据而非管线崩坏）
    const cells = await readPartsObservation(page)
    const slabCell = cells.find((c) => c.pos.x === 0)!
    expect(slabCell.parts![0]!.itemCounts).toEqual([before + 1])
  })
})

test.describe('篡改 displayName → 悬停/统计断言必红', () => {
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
    // 目标部件显式声明（旧口径"任何非空悬停"会把上一次的邻接部件当落定）
    const toggle = await probeHover(page, { col: 0, row: 0, z: 0, ...quadCenter(aug.quads.toggle) }, { localId: 'ae2:NORTH' })
    expect(toggle.hover.part?.localId, '命中判定不受改名影响（盒未动）').toBe('ae2:NORTH')
    expect(toggle.hover.part?.displayName).toBe(TAMPERED_NAME)
    expect(toggle.tooltip).toContain(TAMPERED_NAME)

    // ── 固化一：主断言包的 tooltip 断言（期望原名）在篡改副本上必须抛出 ──
    const tipErr = await captureAsyncFailure(async () => {
      expect(toggle.tooltip, 'tooltip 应显示原 displayName').toContain(TOGGLE_NAME)
      expect(toggle.tooltip).not.toContain(TAMPERED_NAME)
    })
    expect(tipErr, 'displayName 篡改后 tooltip 断言必须抛出（必红）').not.toBeNull()
    console.log(`[部件] 证伪（displayName）→ 悬停断言红：${(tipErr as Error).message.split('\n')[0]}`)

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
    // 本步是原先的间歇失败现场（上一次悬停停在同格切换总线 ae2:NORTH）；目标 = 线缆 ae2:UNKNOWN
    const cable = await probeHover(page, { col: 0, row: 0, z: 0, ...quadCenter(aug.quads.cable) }, { localId: 'ae2:UNKNOWN' })
    expect(cable.hover.part?.localId).toBe('ae2:UNKNOWN')
    expect(cable.tooltip).toContain('ME Glass Cable - Fluix')
    const cableRow = s.rows.find((r) => r.key === 'appliedenergistics2:item.ItemMultiPart:16')
    expect(cableRow?.name, '未篡改部件的行名不受影响').toBe('ME Glass Cable - Fluix')

    await clearWikiHover(page)
  })
})

// ---------------------------------------------------------------------------
// 首版 · 契约 §9 物品索引表的证伪（篡改归属 ⇒ 高亮必变；篡改说明 ⇒ Tooltip 必红）
// ---------------------------------------------------------------------------

/** B-2 物品索引表的内联构造（与 B-5 同款落盘形状；只作用于注入副本）。 */
const B4_ITEM_INDEX = {
  'appliedenergistics2:item.ItemMultiPart:80': {
    display: 'ME Toggle Bus',
    tooltip: ['ME Toggle Bus'],
    source: 'part',
    attribution: [{ source: 'part', frame: 0, grid: [0, 0, 0], localId: 'ae2:NORTH' }],
  },
  'appliedenergistics2:item.ItemMultiPart:220': {
    display: 'ME Storage Bus',
    tooltip: ['ME Storage Bus'],
    source: 'part',
    attribution: [{ source: 'part', frame: 0, grid: [0, 0, 0], localId: 'ae2:UP' }],
  },
  'appliedenergistics2:item.ItemMultiPart:16': {
    display: 'ME Glass Cable - Fluix',
    tooltip: ['ME Glass Cable - Fluix'],
    source: 'none',
    attribution: [],
  },
}

function ae2FixtureWithItemIndex(index: unknown): Record<string, unknown> {
  const f = augmentFixtureGeometry(readPartsFixture('parts-ae2-multibox.v2.json'), 1, [
    [[0.375, 0.375, 0.375], [0.375, 0.375, 0.625], [0.375, 0.625, 0.625], [0.375, 0.625, 0.375]] as QuadCorners,
    [[0.375, 0.375, 0], [0.625, 0.375, 0], [0.625, 0.625, 0], [0.375, 0.625, 0]] as QuadCorners,
    [[0.1875, 1, 0.1875], [0.8125, 1, 0.1875], [0.8125, 1, 0.8125], [0.1875, 1, 0.8125]] as QuadCorners,
  ])
  const normalized = normalizeTextureBlobsForRender(f)
  normalized.itemIndex = index
  return normalized
}

test.describe('证伪：篡改 itemIndex 归属 → 高亮集合必变', () => {
  test('把切换总线的归属 localId 换成存储总线 ⇒ mask 盒必随之改变（未篡改 = 自身盒）', async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop-chrome',
      '展开态侧栏交互在 mobile 窄布局自动折叠振荡；仅 desktop 跑',
    )
    test.setTimeout(300_000)
    const TOGGLE = 'appliedenergistics2:item.ItemMultiPart:80'

    // ── 基线：未篡改 ⇒ mask = 切换总线自身盒（z∈[0,0.3125]）──
    await gotoWikiPreviewWithScene(page, ae2FixtureWithItemIndex(B4_ITEM_INDEX), 'parts-ae2.b4-index-clean.json')
    await waitStatsSidebarReady(page)
    await clickStatsRow(page, TOGGLE)
    const cleanMask = await pollUntil(
      async () => {
        const m = await readOutlineMask(page)
        return m.meshCount === 1 ? m : null
      },
      '基线 mask = 1',
      30_000,
    )
    const cleanAabb = [cleanMask.min, cleanMask.max]
    const clean = await captureAsyncFailure(async () => {
      // 基线断言（= B-5 主断言口径）：切换总线盒
      expect(cleanMask.meshCount, '基线：1 块 mask').toBe(1)
    })
    expect(clean, '基线必须绿（否则下面的"必红"没有判定力）').toBeNull()

    // ── 篡改：归属 localId → 'ae2:UP'（存储总线）⇒ mask 盒必须变成存储总线的盒 ──
    const tamperedIndex = {
      ...B4_ITEM_INDEX,
      [TOGGLE]: {
        display: 'ME Toggle Bus',
        tooltip: ['ME Toggle Bus'],
        source: 'part',
        attribution: [{ source: 'part', frame: 0, grid: [0, 0, 0], localId: 'ae2:UP' }],
      },
    }
    await gotoWikiPreviewWithScene(page, ae2FixtureWithItemIndex(tamperedIndex), 'parts-ae2.b4-index-tampered-attr.json')
    await waitStatsSidebarReady(page)
    await clickStatsRow(page, TOGGLE)
    const dirtyMask = await pollUntil(
      async () => {
        const m = await readOutlineMask(page)
        return m.meshCount === 1 ? m : null
      },
      '篡改后 mask = 1',
      30_000,
    )
    const dirtyAabb = [dirtyMask.min, dirtyMask.max]

    // 高亮几何**确实变了**（归属数据是描边的唯一来源）
    expect(dirtyAabb, '篡改归属 ⇒ 高亮集合（mask 几何）必须变化').not.toEqual(cleanAabb)
    // 且**变红**：主断言口径（切换总线盒）在篡改副本上必须抛出
    const err = await captureAsyncFailure(async () => {
      expect(cleanMask.meshCount, '主断言：1 块 mask').toBe(1)
      expect(dirtyAabb, '主断言：mask = 切换总线自身盒').toEqual(cleanAabb)
    })
    expect(err, '篡改归属后高亮断言必须抛出（必红）').not.toBeNull()
    console.log(
      `[篡改归属] 证伪（篡改归属 localId）→ 断言红：clean=${JSON.stringify(cleanAabb)} / tampered=${JSON.stringify(dirtyAabb)}`,
    )
  })

  test('把某行的 attribution 清空 ⇒ 该行变"没有对应方块"、mask 归零（高亮集合必变）', async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop-chrome',
      '展开态侧栏交互在 mobile 窄布局自动折叠振荡；仅 desktop 跑',
    )
    test.setTimeout(300_000)
    const TOGGLE = 'appliedenergistics2:item.ItemMultiPart:80'
    const emptyIndex = {
      ...B4_ITEM_INDEX,
      [TOGGLE]: {
        display: 'ME Toggle Bus',
        tooltip: ['ME Toggle Bus'],
        source: 'none',
        attribution: [],
      },
    }
    await gotoWikiPreviewWithScene(page, ae2FixtureWithItemIndex(emptyIndex), 'parts-ae2.b4-index-empty-attr.json')
    await waitStatsSidebarReady(page)
    const s = await clickStatsRow(page, TOGGLE)
    const row = s.rows.find((r) => r.key === TOGGLE)!
    expect(row.unresolved, '归属清空 ⇒ 该行标"没有对应方块"').toBe(true)
    expect(s.notice, '提示语义含"没有对应方块"').toContain('没有对应方块')
    await pollUntil(
      async () => ((await readOutlineMask(page)).meshCount === 0 ? true : null),
      '归属清空 ⇒ mask 归零（不高亮）',
      30_000,
    )
    const err = await captureAsyncFailure(async () => {
      expect(row.unresolved, '主断言：有归属 ⇒ 不标无对应').toBe(false)
    })
    expect(err, '归属清空后"有对应"断言必须抛出（必红）').not.toBeNull()
    console.log(`[归属清空] 证伪（归属清空）→ 断言红：unresolved=${row.unresolved}；提示「${s.notice}」`)
  })
})

test.describe('证伪：篡改 itemIndex 说明行 → TooltipBox 文案断言必红', () => {
  test('改物品说明 ⇒ 行悬停文案随之改变，且主断言（期望原文）抛出；未篡改必绿', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', EXPANDED_SIDEBAR_DESKTOP_ONLY)
    test.setTimeout(300_000)
    const TOGGLE = 'appliedenergistics2:item.ItemMultiPart:80'
    const ORIGINAL = 'ME Toggle Bus'
    const TAMPERED = 'ME Toggle Bus TAMPERED'

    // ── 基线（未篡改 ⇒ 绿）──
    await gotoWikiPreviewWithScene(page, ae2FixtureWithItemIndex(B4_ITEM_INDEX), 'parts-ae2.b4-tip-clean.json', {
      requireMesh: false,
    })
    await waitStatsSidebarReady(page)
    await hoverStatsRow(page, TOGGLE)
    const cleanTip = await pollUntil(() => readTooltipText(page), '基线 TooltipBox', 15_000, 40)
    expect(cleanTip, '基线：文案 = itemIndex.tooltip（未篡改必绿）').toContain(ORIGINAL)
    expect(cleanTip, '基线：不得含篡改串').not.toContain(TAMPERED)
    await leaveStatsRow(page, TOGGLE)

    // ── 篡改说明行 ──
    const tamperedIndex = {
      ...B4_ITEM_INDEX,
      [TOGGLE]: {
        display: 'ME Toggle Bus',
        tooltip: [TAMPERED],
        source: 'part',
        attribution: [{ source: 'part', frame: 0, grid: [0, 0, 0], localId: 'ae2:NORTH' }],
      },
    }
    await gotoWikiPreviewWithScene(page, ae2FixtureWithItemIndex(tamperedIndex), 'parts-ae2.b4-tip-tampered.json', {
      requireMesh: false,
    })
    await waitStatsSidebarReady(page)
    await hoverStatsRow(page, TOGGLE)
    const dirtyTip = await pollUntil(() => readTooltipText(page), '篡改后 TooltipBox', 15_000, 40)
    expect(dirtyTip, '篡改沿公开观测透出（TooltipBox 显示篡改文案）').toContain(TAMPERED)

    // 主断言（期望原文）在篡改副本上必须抛出 ⇒ 判定式不是恒绿
    const err = await captureAsyncFailure(async () => {
      expect(dirtyTip, '主断言：文案 = itemIndex.tooltip 原文').toContain(ORIGINAL)
      expect(dirtyTip, '主断言：不得含篡改串').not.toContain(TAMPERED)
    })
    expect(err, '说明行篡改后 Tooltip 断言必须抛出（必红）').not.toBeNull()

    // 方向性：同页另一行（存储总线，未篡改）文案不受影响
    await leaveStatsRow(page, TOGGLE)
    await hoverStatsRow(page, 'appliedenergistics2:item.ItemMultiPart:220')
    const storageTip = await pollUntil(() => readTooltipText(page), '存储总线 TooltipBox', 15_000, 40)
    expect(storageTip, '未篡改行的文案不受影响（定向性）').toContain('ME Storage Bus')
    await leaveStatsRow(page, 'appliedenergistics2:item.ItemMultiPart:220')
    console.log(
      `[篡改说明] 证伪（篡改说明行）→ 断言红：clean=${JSON.stringify(cleanTip)} / tampered=${JSON.stringify(dirtyTip)}；同页未篡改行=${JSON.stringify(storageTip)}`,
    )
  })
})
