/**
 * B-5 · 点选物品行 → 视口**部件级高亮** + 经典多选（issue #38 / #7 §4–§5）。
 *
 * 观测面（零替身）：完整 WorkbenchRoot → 注入 fixture + 内联 `itemIndex`
 * （生产 IO 路径；V2Plain 根字段经 `_extra` round-trip，见
 * `src/context/__tests__/itemIndexRootField.test.ts`）→ Wiki 工作区（生产
 * EmbedViewport）→ **生产侧栏 DOM click**（`clickStatsRow`）→ 读**真正喂给 Sobel 的
 * mask 几何**（`ctx.viewports.get('r-wiki-preview').outlinePass.maskScene`）。
 *
 * 断言口径（mask 世界顶点 AABB − 格世界角 = 格内局部 AABB，与 `PartRecord.boxes`
 * 同一空间，契约 §6.1）：
 *  - **部件级优先**：part 命中 ⇒ mask = 该部件的盒 union（不是整格）；
 *  - **并集**：多选 ⇒ mask 数 = 命中数（去重后），AABB = 各命中盒的并集；
 *  - **无对应不高亮**：`attribution: []` 的行可点选但 mask 为空，且提示含"没有对应方块"；
 *  - **经典多选**：单击 / Ctrl / Shift / Ctrl+Shift / Esc / 点空白 —— 断言写在
 *    **左栏可见顺序**上（`selectedRowKeys` 按渲染顺序给出）；
 *  - **证伪**：同一格把归属的 `localId` 换成同格另一部件 ⇒ mask 必须变化（定向对照页）。
 *
 * 单元层的同口径断言见 `src/runtime/__tests__/itemOutlineMasks.test.ts`（真 mask 几何）
 * 与 `src/pure/__tests__/itemOutlinePlan.test.ts`（计划/截断/证伪）。本文件补的是
 * **浏览器 + 生产侧栏点击 → 描边通道**这一段。
 */
import { expect, test } from '@playwright/test'
import {
  gotoWikiPreviewWithScene,
  clearWikiHover,
  readPartsFixture,
  augmentFixtureGeometry,
  normalizeTextureBlobsForRender,
  readStatsSidebar,
  readStatsSidebarSettled,
  waitStatsSidebarReady,
  clickStatsRow,
  pressStatsEscape,
  clickStatsBlank,
  selectedRowKeys,
  readOutlineMask,
  readGridSize,
  maskLocalAabb,
  type QuadCorners,
} from './helpers/parts'
import { pollUntil } from './helpers/multiblock'

const AE2_GRID = { w: 2, h: 1, d: 1 }
const CELL = { col: 0, row: 0, z: 0 }

/** AE2 物品身份键（= 左栏行键，硬编码；不从 fixture 反读）。 */
const CABLE = 'appliedenergistics2:item.ItemMultiPart:16'
const TOGGLE = 'appliedenergistics2:item.ItemMultiPart:80'
const STORAGE = 'appliedenergistics2:item.ItemMultiPart:220'

/** 与 B-1/P2.5 同一份几何增强副本（让视口照常建网格；部件数据与 mask 期望不受影响）。 */
const AE2_AUGMENT_QUADS = {
  cable: [[0.375, 0.375, 0.375], [0.375, 0.375, 0.625], [0.375, 0.625, 0.625], [0.375, 0.625, 0.375]] as QuadCorners,
  toggle: [[0.375, 0.375, 0], [0.625, 0.375, 0], [0.625, 0.625, 0], [0.375, 0.625, 0]] as QuadCorners,
  storage: [[0.1875, 1, 0.1875], [0.8125, 1, 0.1875], [0.8125, 1, 0.8125], [0.1875, 1, 0.8125]] as QuadCorners,
} as const

/**
 * 归属数据（契约 §2.2 落盘形状，硬编码）：
 *  - 切换总线 / 存储总线 → `part` 命中（各自 localId）；
 *  - 中心线缆 → 显式"没有对应方块"（键存在、`attribution: []`）——用它验证
 *    "可选中、不高亮 + 可辨认提示"。
 */
const ITEM_INDEX = {
  [TOGGLE]: {
    display: 'ME Toggle Bus', tooltip: ['ME Toggle Bus'], source: 'part',
    attribution: [{ source: 'part', frame: 0, grid: [0, 0, 0], localId: 'ae2:NORTH' }],
  },
  [STORAGE]: {
    display: 'ME Storage Bus', tooltip: ['ME Storage Bus'], source: 'part',
    attribution: [{ source: 'part', frame: 0, grid: [0, 0, 0], localId: 'ae2:UP' }],
  },
  [CABLE]: {
    display: 'ME Glass Cable - Fluix', tooltip: ['ME Glass Cable - Fluix'], source: 'none',
    attribution: [],
  },
} as const

/** fixture + 内联 `itemIndex`（注入副本；仓库 fixture 原件一字不改）。 */
function indexedAe2Fixture(index: unknown = ITEM_INDEX): Record<string, unknown> {
  const f = augmentFixtureGeometry(
    readPartsFixture('parts-ae2-multibox.v2.json'),
    1,
    [AE2_AUGMENT_QUADS.cable, AE2_AUGMENT_QUADS.toggle, AE2_AUGMENT_QUADS.storage],
  )
  const normalized = normalizeTextureBlobsForRender(f)
  normalized.itemIndex = index
  return normalized
}

/** 等 mask 达到期望的 mesh 数（mask 是 rAF/帧后写入的）。 */
async function waitMaskMeshes(page: import('@playwright/test').Page, count: number) {
  return await pollUntil(
    async () => {
      const m = await readOutlineMask(page)
      return m.meshCount === count ? m : null
    },
    `outline mask mesh 数 = ${count}`,
    20_000,
  )
}

test.describe('B-5 · 点选物品行 → 视口部件级高亮', () => {
  test('part 命中 ⇒ 该部件盒；Ctrl 多选 ⇒ 并集；无对应 ⇒ 不高亮但有提示；Esc/空白 ⇒ 清空', async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop-chrome',
      '展开态侧栏交互在 mobile 窄布局自动折叠振荡（P2.5 实证登记）；仅 desktop 跑',
    )
    test.setTimeout(300_000)
    await gotoWikiPreviewWithScene(page, indexedAe2Fixture(), 'parts-ae2-multibox.b5-item-index.json')
    await waitStatsSidebarReady(page)
    const size = await readGridSize(page)
    expect({ w: size.w, h: size.h, d: size.d }, 'fixture 网格尺寸').toEqual(AE2_GRID)

    // ── 初始：无选中、无 mask、无提示 ──
    const s0 = await readStatsSidebarSettled(page)
    expect(selectedRowKeys(s0), '初始无选中').toEqual([])
    expect(s0.notice, '初始无提示').toBeNull()
    expect((await readOutlineMask(page)).meshCount, '初始无 mask').toBe(0)

    // ── 单击 ME Toggle Bus ⇒ 单选 + 部件级 mask（盒 z∈[0,0.3125]，不是整格）──
    const s1 = await clickStatsRow(page, TOGGLE)
    expect(selectedRowKeys(s1), '单击 = 单选').toEqual([TOGGLE])
    expect(s1.rows.find((r) => r.key === TOGGLE)!.anchor, '该行成为锚点').toBe(true)
    const m1 = await waitMaskMeshes(page, 1)
    const local1 = maskLocalAabb(m1, CELL, size)!
    expect(m1.meshCount, '一条 part 命中 ⇒ 一块 mask').toBe(1)
    expect(local1.min, 'mask 下界 = 切换总线视觉盒下界').toEqual([0.375, 0.375, 0])
    expect(local1.max, 'mask 上界 = 切换总线视觉盒上界（不框整格）').toEqual([0.625, 0.625, 0.3125])

    // ── hover 只作临时叠加：不得清除/改变选择集 ──
    await clearWikiHover(page)
    const s2 = await readStatsSidebar(page)
    expect(selectedRowKeys(s2), 'hover 后选择集不变').toEqual([TOGGLE])

    // ── Ctrl + 单击 ME Storage Bus ⇒ 切换累加（锚点更新），mask = 两块（并集）──
    //    `selectedRowKeys` 按**左栏可见顺序**给出（数量升/降序 + 并列键字典序
    //    ⇒ :16 < :220 < :80），与点击先后无关。
    const s3 = await clickStatsRow(page, STORAGE, { ctrl: true })
    expect(selectedRowKeys(s3), 'Ctrl+单击 = 切换累加').toEqual([STORAGE, TOGGLE])
    expect(s3.rows.find((r) => r.key === STORAGE)!.anchor, '锚点更新为本次点击行').toBe(true)
    const m3 = await waitMaskMeshes(page, 2)
    const local3 = maskLocalAabb(m3, CELL, size)!
    // 并集 = 切换总线盒 ∪ 存储总线盒 union：[0.125,0.375,0]–[0.875,1,0.875]
    expect(local3.min, '并集 mask 下界').toEqual([0.125, 0.375, 0])
    expect(local3.max, '并集 mask 上界').toEqual([0.875, 1, 0.875])

    // ── 无对应（显式 none）：可选中、不高亮、提示含"没有对应方块" ──
    const s4 = await clickStatsRow(page, CABLE)
    expect(selectedRowKeys(s4), '无对应行仍是单选该行').toEqual([CABLE])
    expect(s4.rows.find((r) => r.key === CABLE)!.unresolved, '无对应行带行内标记').toBe(true)
    expect(s4.notice, '提示语义含"没有对应方块"').toContain('没有对应方块')
    await pollUntil(
      async () => ((await readOutlineMask(page)).meshCount === 0 ? true : null),
      '无对应 ⇒ mask 清空（不高亮）',
      20_000,
    )

    // ── Ctrl + 单击 有对应行 ⇒ 混选：只亮有对应项，且两项逐项可辨认 ──
    const s5 = await clickStatsRow(page, TOGGLE, { ctrl: true })
    expect(selectedRowKeys(s5), '混选（可见顺序）').toEqual([CABLE, TOGGLE])
    expect(s5.rows.find((r) => r.key === CABLE)!.unresolved, '混选中无对应项仍逐项可辨认').toBe(true)
    expect(s5.rows.find((r) => r.key === TOGGLE)!.unresolved).toBe(false)
    expect(s5.notice, '混选提示说明"1 项没有对应方块"').toContain('1 项没有对应方块')
    expect((await waitMaskMeshes(page, 1)).meshCount, '混选只亮有对应项').toBe(1)

    // ── Esc 清空 ⇒ mask 归零、提示消失 ──
    const s6 = await pressStatsEscape(page)
    expect(selectedRowKeys(s6), 'Esc 清空选择').toEqual([])
    expect(s6.notice, '无选择 ⇒ 无提示').toBeNull()
    await pollUntil(
      async () => ((await readOutlineMask(page)).meshCount === 0 ? true : null),
      'Esc 后 mask 清空',
      20_000,
    )

    // ── 点左栏空白同样清空（先重新选上）──
    await clickStatsRow(page, STORAGE)
    expect((await waitMaskMeshes(page, 1)).meshCount).toBe(1)
    const s7 = await clickStatsBlank(page)
    expect(selectedRowKeys(s7), '点左栏空白 = 清空').toEqual([])

    // ── Shift 区间：锚点（电缆，可见顺序首行）→ 存储 ⇒ 含两端两行 ──
    await clickStatsRow(page, CABLE)
    const s8 = await clickStatsRow(page, STORAGE, { shift: true })
    expect(selectedRowKeys(s8), 'Shift 区间 = 可见顺序 [电缆, 存储]（含两端）').toEqual([CABLE, STORAGE])
    expect((await waitMaskMeshes(page, 1)).meshCount, '混选（1 项无对应 + 1 项有对应）⇒ 1 块 mask').toBe(1)

    // ── Ctrl+Shift 区间并入：锚点仍为电缆 → 切换总线 ⇒ 三行全选 ──
    const s9 = await clickStatsRow(page, TOGGLE, { ctrl: true, shift: true })
    expect(selectedRowKeys(s9), 'Ctrl+Shift 区间并入既有选择').toEqual([CABLE, STORAGE, TOGGLE])
    expect(s9.rows.find((r) => r.key === CABLE)!.anchor, 'Ctrl+Shift 不改锚点').toBe(true)
    expect((await waitMaskMeshes(page, 2)).meshCount, '并入后两块 mask（两行有对应）').toBe(2)

    console.log(`[B-5] part mask 局部 AABB = ${JSON.stringify(local1)}；并集 = ${JSON.stringify(local3)}`)
  })

  test('证伪：同格把归属 localId 换成另一部件 ⇒ mask 必须变化（定向对照）', async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop-chrome',
      '展开态侧栏交互在 mobile 窄布局自动折叠振荡（P2.5 实证登记）；仅 desktop 跑',
    )
    test.setTimeout(300_000)
    const tampered = {
      ...ITEM_INDEX,
      [TOGGLE]: {
        display: 'ME Toggle Bus', tooltip: ['ME Toggle Bus'], source: 'part',
        attribution: [{ source: 'part', frame: 0, grid: [0, 0, 0], localId: 'ae2:UP' }],
      },
    }
    await gotoWikiPreviewWithScene(page, indexedAe2Fixture(tampered), 'parts-ae2-multibox.b5-tampered.json')
    await waitStatsSidebarReady(page)
    const size = await readGridSize(page)

    await clickStatsRow(page, TOGGLE)
    const m = await waitMaskMeshes(page, 1)
    const local = maskLocalAabb(m, CELL, size)!
    // 篡改后 mask 必须是**存储总线**的盒 union，而不是切换总线的盒
    expect(local.min, '篡改后 mask = 被指向部件的盒').toEqual([0.125, 0.75, 0.125])
    expect(local.max).toEqual([0.875, 1, 0.875])
    expect(local.min, '与未篡改时的切换总线盒不同（证伪成立）').not.toEqual([0.375, 0.375, 0])
    console.log(`[B-5] 证伪：localId 换成 ae2:UP ⇒ mask 局部 AABB = ${JSON.stringify(local)}`)
  })
})
