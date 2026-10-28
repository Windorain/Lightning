/**
 * 部件 E2E 断言包（fixture 驱动，接入既有多方块轮管线）。
 *
 * 契约：`docs/contracts/format-parts-contract.md`（过程性计划已删除）。
 * 零替身五原则与多方块轮完全一致（见 `helpers/multiblock/harness.ts` 与
 * `helpers/parts/hover.ts` 文件头）：完整 WorkbenchRoot 挂载 → IO 接管
 * （OPERATOR_OPEN_SCENE + File，同生产拖拽）→ Wiki 工作区（生产 EmbedPreview =
 * EmbedViewport，部件 tooltip/统计侧栏的生产宿主）→ DOM 事件注入 → 公开观测
 * （window.__vm__ / ctx.viewports / region hover / 生产 DOM）。
 *
 * ── 覆盖点（自检逐项）──
 *  1. 悬停断言：固定正交相机（视口 init 相机，等稳定后注入），AE2 fixture 同格
 *     三个部件（中心线缆 / NORTH 切换总线 / UP 存储总线）投影位置各注入 pointer
 *     事件 → 公开悬停状态的部件身份（localId）+ DOM tooltip 文本分别为各部件
 *     事物名；slab fixture 满方块石头格 tooltip = 宿主 NEI 名（回归）。
 *  2. 统计断言：slab fixture 默认视图（B-3 决策 C 后左栏**唯一**形态 = 物品清单）DOM 行 =
 *     Stone Slab×3 / Fence×1 精确比对（Stone 不出现）；图标键 = 物品身份键；
 *     无对应标记与选择提示的行为（B-5）。**移除锁**：视图切换工具条 / 视图按钮 /
 *     配置来源徽标 / provenance 面板 / 分组标题全部不存在（B-4 按 B-3 后的实际形态收口，
 *     见下方 describe —— 原「三视图切换 + provenance 徽标迁移」断言已删除，
 *     该 UI 随 B-3 整套移除，留着就是确定性坏断言）。
 *  3. 图标断言：物品行 `data-stats-icon-key` = 物品身份键（`registry:damage`），
 *     不是宿主方块键。
 *  4. 回归断言：minimal-v2（无部件）侧栏无部件模式 UI（无 `data-stats-row-key` /
 *     选中态数据位 / 未计入提示），行集 = 旧路径；无部件文档悬停 part = null、
 *     tooltip = 宿主名。
 *  5. **B-4 物品 TooltipBox**：左栏物品行悬停 → 生产 `tooltip-hover`
 *     （`source:'sidebar'`）→ `itemIndex.tooltip` → `.wm-tooltip-box`；空说明行 ⇒ 兜底
 *     display 一行；索引缺条目 ⇒ 回退行键本身（不产 `"0"` 片段）。证伪见
 *     `parts-falsification.spec.ts`（篡改 itemIndex.tooltip ⇒ 文案断言必红）。
 *  6. **性能登记**：600 格大网格 fixture 压到描边通道上限（599 命中）⇒
 *     mask 截断到 `OUTLINE_MASK_LIMIT=500` + 可辨认提示「仅高亮前 500 处」；
 *     帧时间以 40 帧 rAF 间隔采样**登记数字**（小命中 vs 大命中对照），不设脆阈值。
 *
 * ── 输入整备登记（本 spec 的两处输入整备）──
 *  【几何增强副本】悬停是真实 raycast（命中三角形 → 命中点 → 部件盒）。fixture
 *  几何经 c98351a 补全后仍有两处物理不可达（实测，详见
 *  `helpers/parts/fixtures.ts` 文件头）：① 全部 quad 单绕组、法线背向 init 相机
 *  （FrontSide 背面剔除 ⇒ 原件几何默认视角不可命中）；② AE2 切换总线的
 *  z=0.3125 面与线缆颈盒共边界，最小体积取舍会判给线缆。悬停用例因此注入
 *  **几何增强副本**（`augmentFixtureGeometry`：追加双绕组、目标部件独占边界的
 *  四边形，部件数据与原件逐字节一致；`normalizeTextureBlobsForRender`：对象数组
 *  → string[]，渲染管线既有口径见 multiblock README §7 开放项 4）。注入点 =
 *  追加面中心，命中点必落目标盒。统计/回归（侧栏）用例注入**原件**（侧栏不
 *  依赖网格构建）。
 *  【反同义反复】期望值（部件名/计数/行键/图标键/来源）全部硬编码于本文件，
 *  不是「再读一遍被测文件」；篡改 fixture 原件 → 断言必红（证伪见
 *  `parts-falsification.spec.ts`）。
 */

import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  gotoWikiPreviewWithScene,
  probeHover,
  clearWikiHover,
  clickStatsRow,
  compactTooltipText,
  hoverStatsRow,
  leaveStatsRow,
  readOutlineMask,
  readStatsSidebarSettled,
  readTooltipText,
  waitStatsSidebarReady,
  readLegacyStatsUiAbsent,
  readPartsFixture,
  readPartsObservation,
  augmentFixtureGeometry,
  normalizeTextureBlobsForRender,
  quadCenter,
  type QuadCorners,
  type StatsRowObservation,
} from './helpers/parts'
import { pollUntil } from './helpers/multiblock'

const SHOT_DIR = path.join(import.meta.dirname, 'screenshots', 'parts')

// ---------------------------------------------------------------------------
// 硬编码期望（反同义反复；与 fixture 内容一致但不从 fixture 读取）
// ---------------------------------------------------------------------------

const AE2_PARTS = {
  cable: { localId: 'ae2:UNKNOWN', name: 'ME Glass Cable - Fluix', typeKey: 'appliedenergistics2:item.ItemMultiPart:16' },
  toggle: { localId: 'ae2:NORTH', name: 'ME Toggle Bus', typeKey: 'appliedenergistics2:item.ItemMultiPart:80' },
  storage: { localId: 'ae2:UP', name: 'ME Storage Bus', typeKey: 'appliedenergistics2:item.ItemMultiPart:220' },
  hostName: 'ME Glass Cable - Fluix', // 宿主调色板 tooltip 首行（归属标注的宿主名）
  hostKey: 'appliedenergistics2:tile.BlockCableBus',
} as const

// ---------------------------------------------------------------------------
// 几何增强面（格内局部坐标；augmentFixtureGeometry 自动写双绕组）
// ---------------------------------------------------------------------------

/** AE2 线缆格（palette 1）：三部件事先画好的可命中面。 */
const AE2_AUGMENT_QUADS = {
  /** 中心线缆：-x 侧面（默认相机在 -x 象限，无遮挡） */
  cable: [[0.375, 0.375, 0.375], [0.375, 0.375, 0.625], [0.375, 0.625, 0.625], [0.375, 0.625, 0.375]] as QuadCorners,
  /** 切换总线：-z 正面（盒 z∈[0,0.3125] 的 min 面，相机 -z 方向首中） */
  toggle: [[0.375, 0.375, 0], [0.625, 0.375, 0], [0.625, 0.625, 0], [0.375, 0.625, 0]] as QuadCorners,
  /** 存储总线：+y 顶面（盒 y∈[0.9375,1.0] 的 max 面，全场景最高无遮挡） */
  storage: [[0.1875, 1, 0.1875], [0.8125, 1, 0.1875], [0.8125, 1, 0.8125], [0.1875, 1, 0.8125]] as QuadCorners,
} as const
/** AE2 石头格（palette 2）：+y 顶面（满方块对照）。 */
const AE2_STONE_QUAD = [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]] as QuadCorners

function augmentedAe2Fixture(): Record<string, unknown> {
  let f = readPartsFixture('parts-ae2-multibox.v2.json')
  f = augmentFixtureGeometry(f, 1, [AE2_AUGMENT_QUADS.cable, AE2_AUGMENT_QUADS.toggle, AE2_AUGMENT_QUADS.storage])
  f = augmentFixtureGeometry(f, 2, [AE2_STONE_QUAD])
  return normalizeTextureBlobsForRender(f)
}

/** slab fixture 增强：各 palette 一格一面（顶面），石头格同法。 */
function augmentedSingleboxFixture(): Record<string, unknown> {
  let f = readPartsFixture('parts-singlebox-mix.v2.json')
  const lowerSlabTop = [[0, 0.5, 0], [1, 0.5, 0], [1, 0.5, 1], [0, 0.5, 1]] as QuadCorners
  const fullTop = [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]] as QuadCorners
  const fenceTop = [[0.375, 1, 0.375], [0.625, 1, 0.375], [0.625, 1, 0.625], [0.375, 1, 0.625]] as QuadCorners
  f = augmentFixtureGeometry(f, 1, [lowerSlabTop]) // 下半 slab ×2 格
  f = augmentFixtureGeometry(f, 2, [fullTop]) // 上半 slab
  f = augmentFixtureGeometry(f, 3, [fullTop]) // 石头（满方块对照）
  f = augmentFixtureGeometry(f, 4, [fenceTop]) // 栅栏
  return normalizeTextureBlobsForRender(f)
}

/**
 * 行观测 → 紧凑可比对形状（断言失败时 diff 直接可读）。
 *
 * B-4 收口：B-3（决策 C）后左栏**只有物品行一种**，`data-stats-row-kind` 属性根本不再渲染
 * ⇒ 原先的 `kind` 字段读到的恒为 null，按它写的 `kind === 'part'/'host'` 断言永远不可能通过
 * （确定性坏断言，已随本单删除）。行种类判据 = **行上有无 `data-stats-row-key`**
 * （物品行有、旧文件退化路径行没有）—— `isItemRow` 即该判据。
 * （B-5 增补：`selected` / `unresolved` 两个数据位一并入紧凑形状。）
 */
function compactRows(rows: StatsRowObservation[]): Array<Record<string, string | boolean | null>> {
  return rows.map((r) => ({
    key: r.key, iconKey: r.iconKey, name: r.name, qty: r.qty,
    selected: r.selected, unresolved: r.unresolved,
  }))
}

/** 物品行判据 = 行带 `data-stats-row-key`（B-3 后无 `kind` 属性可用，见 `compactRows` 注释）。 */
function isItemRow(r: StatsRowObservation): boolean {
  return r.key !== null
}

/**
 * 展开侧栏交互（视图切换/徽标/展开态行文本）只在 desktop 跑的统一理由：
 * 窄布局（mobile-chrome）下生产自动折叠 watcher 与「展开改变根宽」形成
 * ~50ms 振荡（probe 实证：展开 → 根宽 361→445 → profile tiny→narrow →
 * watcher 立即再折叠），展开态无法保持。窄布局折叠本身是 embed-mobile.spec
 * 锁定的预期行为；该振荡（展开按钮在 361–445px 带宽下自失效）已作为
 * **实现发现**上报，不在本包修复。mobile 侧覆盖 = 解析级 + 悬停用例
 * （不依赖展开态）。
 */
const EXPANDED_SIDEBAR_DESKTOP_ONLY =
  'mobile 窄布局自动折叠振荡（展开 ~50ms 内被 watcher 折回，probe 实证）；展开态统计交互仅 desktop 跑'

test.describe('部件文档加载与解析级公开观测（不经渲染管线）', () => {
  test('AE2 fixture：同格三部件五要素与宿主格对照', async ({ page }) => {
    await gotoWikiPreviewWithScene(page, readPartsFixture('parts-ae2-multibox.v2.json'), 'parts-ae2-multibox.v2.json', { requireMesh: false })
    const cells = await readPartsObservation(page)
    expect(cells.length, 'AE2 fixture 只有线缆总线一格带部件（石头格无部件）').toBe(1)
    const cell = cells[0]!
    expect(cell.pos).toEqual({ x: 0, y: 0, z: 0 })
    expect(cell.parts!.map((p) => p.localId)).toEqual([AE2_PARTS.cable.localId, AE2_PARTS.toggle.localId, AE2_PARTS.storage.localId])
    expect(cell.parts!.map((p) => p.typeKey)).toEqual([AE2_PARTS.cable.typeKey, AE2_PARTS.toggle.typeKey, AE2_PARTS.storage.typeKey])
    expect(cell.parts!.map((p) => p.displayName)).toEqual([AE2_PARTS.cable.name, AE2_PARTS.toggle.name, AE2_PARTS.storage.name])
    // 来源四元组：族权威档 1、非兜底、视觉/碰撞双盒
    for (const p of cell.parts!) {
      expect(p.source).toEqual({ family: 'ae2', fallback: false, boxProvenance: 'both', tier: 1 })
      expect(p.boxCount, `${p.localId} 视觉/碰撞盒成对`).toBeGreaterThanOrEqual(2)
      expect(p.itemCounts).toEqual([1])
    }
  })

  test('slab fixture：单盒档三格 + 满方块石头格无部件', async ({ page }) => {
    await gotoWikiPreviewWithScene(page, readPartsFixture('parts-singlebox-mix.v2.json'), 'parts-singlebox-mix.v2.json', { requireMesh: false })
    const cells = await readPartsObservation(page)
    // 带部件格：col0/col1 下半 slab、col2 上半 slab、col4 栅栏（col3 石头无部件）
    expect(cells.map((c) => c.pos)).toEqual([
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
      { x: 4, y: 0, z: 0 },
    ])
    for (const c of cells) {
      expect(c.parts!.length, '单盒档一格一个部件').toBe(1)
      const p = c.parts![0]!
      expect(p.localId).toBe('generic:0')
      expect(p.source).toEqual({ family: 'generic', fallback: true, boxProvenance: 'both', tier: 2 })
    }
    // drop 身份计数键：上/下半 slab 同 typeKey
    expect(cells[0]!.parts![0]!.typeKey).toBe('minecraft:stone_slab:0')
    expect(cells[2]!.parts![0]!.typeKey).toBe('minecraft:stone_slab:0')
    expect(cells[3]!.parts![0]!.typeKey).toBe('minecraft:fence:0')
  })
})

test.describe('悬停断言（AE2 同格三部件 + 满方块回归）', () => {
  test('同格三部件投影位置各得各部件事物名；石头格 tooltip 与基线一致', async ({ page }) => {
    test.setTimeout(180_000)
    await gotoWikiPreviewWithScene(page, augmentedAe2Fixture(), 'parts-ae2-multibox.hover-augmented.json')

    // ── 中心线缆（ae2:UNKNOWN）：宿主名 == 部件名 ⇒ 无归属标注 ──
    const cable = await probeHover(page, { col: 0, row: 0, z: 0, ...quadCenter(AE2_AUGMENT_QUADS.cable) }, { localId: AE2_PARTS.cable.localId })
    expect(cable.hover.part?.localId, '中心线缆命中部件身份').toBe(AE2_PARTS.cable.localId)
    expect(cable.tooltip, '中心线缆 tooltip = 部件事物名').toContain(AE2_PARTS.cable.name)
    expect(cable.tooltip, '宿主名与部件名相同 ⇒ 不附归属标注').not.toContain('位于')

    // ── NORTH 切换总线（ae2:NORTH）：归属标注 = 宿主名 ──
    const toggle = await probeHover(page, { col: 0, row: 0, z: 0, ...quadCenter(AE2_AUGMENT_QUADS.toggle) }, { localId: AE2_PARTS.toggle.localId })
    expect(toggle.hover.part?.localId, '切换总线命中部件身份').toBe(AE2_PARTS.toggle.localId)
    expect(toggle.tooltip).toContain(AE2_PARTS.toggle.name)
    expect(toggle.tooltip, '部件说明附「位于 <宿主>」归属标注').toContain(`位于 ${AE2_PARTS.hostName}`)

    // ── UP 存储总线（ae2:UP）──
    const storage = await probeHover(page, { col: 0, row: 0, z: 0, ...quadCenter(AE2_AUGMENT_QUADS.storage) }, { localId: AE2_PARTS.storage.localId })
    expect(storage.hover.part?.localId, '存储总线命中部件身份').toBe(AE2_PARTS.storage.localId)
    expect(storage.tooltip).toContain(AE2_PARTS.storage.name)
    expect(storage.tooltip).toContain(`位于 ${AE2_PARTS.hostName}`)

    // ── 满方块石头格（无部件）：宿主 NEI 回退 = 既有基线行为 ──
    const stone = await probeHover(page, { col: 1, row: 0, z: 0, ...quadCenter(AE2_STONE_QUAD) }, { hostOnly: true, blockId: 'minecraft:stone' })
    expect(stone.hover.part, '满方块格不携带部件命中').toBeNull()
    expect(stone.hover.blockId).toBe('minecraft:stone')
    expect(stone.tooltip, '石头格 tooltip = 宿主 NEI 名（与无部件基线一致）').toContain('Stone')

    await clearWikiHover(page)
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    await page.screenshot({ path: path.join(SHOT_DIR, 'ae2-hover-probes.png') })
    console.log(
      `[部件] AE2 悬停：cable→${cable.hover.part?.localId} / toggle→${toggle.hover.part?.localId} ` +
        `/ storage→${storage.hover.part?.localId} / stone→host(${stone.hover.blockId})；` +
        `tooltip 四态 = ${JSON.stringify([cable.tooltip, toggle.tooltip, storage.tooltip, stone.tooltip])}`,
    )
  })

  test('slab fixture：单盒部件 tooltip = 部件名；石头格基线回归', async ({ page }) => {
    test.setTimeout(180_000)
    await gotoWikiPreviewWithScene(page, augmentedSingleboxFixture(), 'parts-singlebox-mix.hover-augmented.json')

    const lowerSlabTop = [[0, 0.5, 0], [1, 0.5, 0], [1, 0.5, 1], [0, 0.5, 1]] as QuadCorners
    const fullTop = [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]] as QuadCorners
    const fenceTop = [[0.375, 1, 0.375], [0.625, 1, 0.375], [0.625, 1, 0.625], [0.375, 1, 0.625]] as QuadCorners

    const slab = await probeHover(page, { col: 0, row: 0, z: 0, ...quadCenter(lowerSlabTop) }, { localId: 'generic:0' })
    expect(slab.hover.part?.localId).toBe('generic:0')
    expect(slab.hover.part?.displayName).toBe('Stone Slab')
    expect(slab.tooltip).toContain('Stone Slab')

    const stone = await probeHover(page, { col: 3, row: 0, z: 0, ...quadCenter(fullTop) }, { hostOnly: true })
    expect(stone.hover.part, '石头格无部件').toBeNull()
    expect(stone.tooltip, '石头格 tooltip 与基线一致').toContain('Stone')

    const fence = await probeHover(page, { col: 4, row: 0, z: 0, ...quadCenter(fenceTop) }, { localId: 'generic:0' })
    expect(fence.hover.part?.localId).toBe('generic:0')
    expect(fence.hover.part?.displayName).toBe('Fence')
    expect(fence.tooltip).toContain('Fence')

    await clearWikiHover(page)
    console.log(`[部件] slab 悬停：slab/stone/fence tooltip = ${JSON.stringify([slab.tooltip, stone.tooltip, fence.tooltip])}`)
  })
})

test.describe('统计断言（slab fixture 物品清单 + B-3 移除锁 + B-5 选择提示）', () => {
  // 本 describe 的用例都依赖「展开态保持」，跳过理由见 EXPANDED_SIDEBAR_DESKTOP_ONLY。

  test('默认视图 = 物品清单（Stone Slab×3 / Fence×1；石头不出现）；图标键 = 物品身份键', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', EXPANDED_SIDEBAR_DESKTOP_ONLY)
    test.setTimeout(180_000)
    await gotoWikiPreviewWithScene(page, readPartsFixture('parts-singlebox-mix.v2.json'), 'parts-singlebox-mix.v2.json', { requireMesh: false })
    await waitStatsSidebarReady(page)
    const s = await readStatsSidebarSettled(page)

    // 视图切换工具条 / 视图按钮 / 配置来源徽标已随 B-3（决策 C）整套移除 ⇒ 无对应断言
    //（移除锁由下方「B-3 移除锁」用例承担）。
    // 默认视图行集精确比对（count-desc：Stone Slab×3 在前；石头满方块不是物品，不出现）
    expect(compactRows(s.rows), '物品清单 = Stone Slab×3 / Fence×1（硬编码期望）').toEqual([
      { key: 'minecraft:stone_slab:0', iconKey: 'minecraft:stone_slab:0', name: 'Stone Slab', qty: '3', selected: false, unresolved: true },
      { key: 'minecraft:fence:0', iconKey: 'minecraft:fence:0', name: 'Fence', qty: '1', selected: false, unresolved: true },
    ])
    // 图标断言：物品行图标键 = 物品身份键（带 :damage 段），≠ 宿主方块键（registryId / registryId@meta）
    for (const r of s.rows) {
      expect(isItemRow(r), `行 ${r.name} 必须是物品行（行带 data-stats-row-key）`).toBe(true)
      expect(r.iconKey, `行 ${r.name} 的图标键必须是物品身份键`).toBe(r.key)
      expect(r.iconKey, '物品身份键带 :damage 段（宿主键没有）').toMatch(/:\d+$/)
    }
    expect(s.rows.map((r) => r.name)).not.toContain('Stone')
    // B-5：该 fixture 无 B-2 的 `itemIndex` ⇒ 每一行都标"没有对应方块"（不得让用户误判为渲染故障）
    expect(s.rows.every((r) => r.unresolved), '无 itemIndex ⇒ 全部行可辨认地标"没有对应方块"').toBe(true)
    expect(s.rows.some((r) => r.selected), '初始无选中态').toBe(false)
    expect(s.notice, '初始无选择 ⇒ 无会话提示').toBeNull()

    fs.mkdirSync(SHOT_DIR, { recursive: true })
    await page.locator('.wb-wiki-embed .nei-sidebar').screenshot({ path: path.join(SHOT_DIR, 'singlebox-stats-parts-view.png') })
    console.log(`[部件] slab 默认视图行 = ${JSON.stringify(compactRows(s.rows))}`)
  })

  test('AE2 fixture 默认视图：三物品行（计数键含 damage；图标键 = 物品键）', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', EXPANDED_SIDEBAR_DESKTOP_ONLY)
    test.setTimeout(180_000)
    await gotoWikiPreviewWithScene(page, readPartsFixture('parts-ae2-multibox.v2.json'), 'parts-ae2-multibox.v2.json', { requireMesh: false })
    await waitStatsSidebarReady(page)
    const s = await readStatsSidebarSettled(page)
    // 全 ×1 ⇒ count-desc 并列按 key 字典序：:16 < :220 < :80（逐字符比较）
    expect(compactRows(s.rows)).toEqual([
      { key: AE2_PARTS.cable.typeKey, iconKey: AE2_PARTS.cable.typeKey, name: AE2_PARTS.cable.name, qty: '1', selected: false, unresolved: true },
      { key: AE2_PARTS.storage.typeKey, iconKey: AE2_PARTS.storage.typeKey, name: AE2_PARTS.storage.name, qty: '1', selected: false, unresolved: true },
      { key: AE2_PARTS.toggle.typeKey, iconKey: AE2_PARTS.toggle.typeKey, name: AE2_PARTS.toggle.name, qty: '1', selected: false, unresolved: true },
    ])
    // 图标键 = 物品注册名（item.ItemMultiPart），与宿主方块键（tile.BlockCableBus）不同族
    for (const r of s.rows) {
      expect(isItemRow(r)).toBe(true)
      expect(r.iconKey).not.toBe(AE2_PARTS.hostKey)
    }
  })

  /**
   * B-4 收口（替代原「三视图切换 + provenance 迁移」用例）。
   *
   * 原用例驱动 B-3 已整套移除的 UI（视图按钮 / 来源徽标 / provenance 面板），
   * 其断言**永远不可能通过** —— 属确定性坏断言，已按 B-3 后的实际形态改写为
   * **移除锁 + 兼容兜底**（统计字段无格式语义：文档/本机残留配置 ⇒ 静默忽略）：含部件文档照样
   * 只出物品行，且这些入口一个都不渲染、`lightning:stats:v1:*` 残留键一字未动。
   */
  test('移除锁：视图切换/来源徽标/provenance 入口不存在；残留本机配置不被读写', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', EXPANDED_SIDEBAR_DESKTOP_ONLY)
    test.setTimeout(180_000)
    // 先埋一份 B-3 前的本机配置残留（旧实现的写入口径），生产代码必须完全无视它
    await page.addInitScript(() => {
      localStorage.setItem(
        'lightning:stats:v1:parts-singlebox-mix',
        JSON.stringify({ schema: 1, config: { view: 'hosts', rules: { showHostRows: true } } }),
      )
    })
    await gotoWikiPreviewWithScene(page, readPartsFixture('parts-singlebox-mix.v2.json'), 'parts-singlebox-mix.v2.json', { requireMesh: false })
    await waitStatsSidebarReady(page)
    const s = await readStatsSidebarSettled(page)

    // 行集不受残留配置影响：仍是物品清单
    expect(compactRows(s.rows)).toEqual([
      { key: 'minecraft:stone_slab:0', iconKey: 'minecraft:stone_slab:0', name: 'Stone Slab', qty: '3', selected: false, unresolved: true },
      { key: 'minecraft:fence:0', iconKey: 'minecraft:fence:0', name: 'Fence', qty: '1', selected: false, unresolved: true },
    ])

    const ui = await readLegacyStatsUiAbsent(page)
    expect(ui.present, '侧栏已挂载（缺此前提，下面的 0 计数不构成证据）').toBe(true)
    expect(ui.counts, 'B-3 已移除的 UI 入口一个都不渲染').toEqual({
      toolbar: 0, viewButtons: 0, pill: 0,
      provenancePanel: 0, provenanceFields: 0, resetLocal: 0, groupTitles: 0, rowKind: 0,
    })
    expect(ui.legacyLocalKeys, '残留本机配置键原样留存（不读不写不清除、无新增）').toEqual([
      'lightning:stats:v1:parts-singlebox-mix',
    ])
    expect(s.legacyToolbar, '旧读取字段同口径：工具条不存在').toBe(false)
    console.log('[部件] B-3 移除锁：视图切换/徽标/provenance 入口全部不存在；残留本机配置一字未动')
  })
})

test.describe('回归断言（无部件文档：DOM 零新增 + 行为基线）', () => {
  test('minimal-v2：侧栏无部件模式 UI（含 B-5 数据位），行集 = 旧路径（Gold Ore×8）', async ({ page }, testInfo) => {
    // 「无部件模式 UI」只有在展开态下才是有效断言（折叠态本来就不渲染）；
    // 展开态保持见统计 describe 的振荡登记 —— 本用例仅 desktop。
    test.skip(testInfo.project.name !== 'desktop-chrome', EXPANDED_SIDEBAR_DESKTOP_ONLY)
    test.setTimeout(180_000)
    await gotoWikiPreviewWithScene(page, readPartsFixture('minimal-v2.json'), 'minimal-v2.json', { requireMesh: false })
    await waitStatsSidebarReady(page)
    const s = await readStatsSidebarSettled(page)

    // 视图切换 UI / 来源徽标 / provenance 已随 B-3 决策 C 移除 ⇒ 不再断言其不存在；
    // 改为断言**当前**的部件模式数据位在旧路径上一个都不出现（DOM 零新增的直接证据）。
    const partsModeAttrs = await page.evaluate(() => {
      const el = document.querySelector('.wb-wiki-embed .nei-sidebar')
      if (!el) return null
      return {
        rowKey: el.querySelector('[data-stats-row-key]') !== null,
        selected: el.querySelector('[data-stats-selected]') !== null,
        unresolved: el.querySelector('[data-stats-unresolved]') !== null,
        anchor: el.querySelector('[data-stats-anchor]') !== null,
        notice: el.querySelector('[data-stats-selection-notice]') !== null,
      }
    })
    expect(partsModeAttrs, '旧路径行不得带任何部件模式数据位').toEqual({
      rowKey: false, selected: false, unresolved: false, anchor: false, notice: false,
    })
    expect(s.legacyToolbar, '无部件旧文件 ⇒ 视图切换工具条不渲染（DOM 零新增）').toBe(false)
    expect(s.rows.every((r) => !isItemRow(r)), '无部件 ⇒ 无物品行（行无 data-stats-row-key）').toBe(true)
    expect(s.itemless).toBeNull()
    expect(s.notice).toBeNull()
    // 旧路径行：无 data 属性（DOM 零新增的直接证据），行集 = 旧口径
    expect(compactRows(s.rows)).toEqual([
      { key: null, iconKey: null, name: 'Gold Ore', qty: '8', selected: false, unresolved: false },
    ])
  })

  test('minimal-v2：解析级观测无部件（Grid API）', async ({ page }) => {
    await gotoWikiPreviewWithScene(page, readPartsFixture('minimal-v2.json'), 'minimal-v2.json', { requireMesh: false })
    expect(await readPartsObservation(page), 'minimal-v2 不带任何格级部件').toEqual([])
  })

  test('minimal-v2：满方块 tooltip 与基线一致（宿主 NEI 名，part=null）', async ({ page }) => {
    test.setTimeout(180_000)
    // 几何增强副本（同 AE2/slab 机制：fixture 几何单绕组背向默认相机 + textureBlobs
    // 对象数组格式，见本文件头拍板登记）；gold ore 调色板补 +y 顶面。
    let f = readPartsFixture('minimal-v2.json')
    const top = [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]] as QuadCorners
    f = augmentFixtureGeometry(f, 1, [top])
    f = normalizeTextureBlobsForRender(f)
    await gotoWikiPreviewWithScene(page, f, 'minimal-v2.hover-augmented.json')

    // cellGrid 2×2×2 全 gold_ore；取顶面层格 (0, row0, 0)（h=2 ⇒ row0 = worldY1）
    const probe = await probeHover(page, { col: 0, row: 0, z: 0, ...quadCenter(top) }, { hostOnly: true, blockId: 'minecraft:gold_ore' })
    expect(probe.hover.part, '无部件文档悬停不携带部件信息').toBeNull()
    expect(probe.hover.blockId).toBe('minecraft:gold_ore')
    expect(probe.tooltip, '满方块 tooltip = 宿主 NEI 名（此前基线逐字节一致）').toContain('Gold Ore')
    await clearWikiHover(page)
  })
})

// ---------------------------------------------------------------------------
// B-4：左栏物品行悬停 → 物品 TooltipBox 文案 = itemIndex.tooltip
// ---------------------------------------------------------------------------

/**
 * B-4 覆盖点（原包只在 vitest 单测覆盖，本 spec 补**浏览器 + 生产侧栏悬停 → TooltipBox** 这一段）。
 *
 * 观测面：生产 DOM `pointerenter`/`pointermove`（`hoverStatsRow`）→ 生产 `tooltip-hover`
 * （`source:'sidebar'`，payload = 物品身份键）→ `useEmbedTooltip#resolveSidebarLines` →
 * `itemIndex.tooltip` → `.wm-tooltip-box`（`readTooltipText`）。
 *
 * 反同义反复：期望文案**硬编码**（不读 fixture 的 itemIndex）；篡改 fixture 的 itemIndex.tooltip
 * ⇒ 断言必红（证伪见 `parts-falsification.spec.ts`）。
 */
test.describe('物品行悬停 → 物品 TooltipBox（itemIndex 单一数据源）', () => {
  test('slab fixture：行悬停文案 = itemIndex.tooltip；无索引行回退行键（不产 "0"）', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', EXPANDED_SIDEBAR_DESKTOP_ONLY)
    test.setTimeout(180_000)
    // 注入副本：仓库 fixture 原件一字不改（B-2 的 itemIndex 由本 spec 内联构造）
    const f = readPartsFixture('parts-singlebox-mix.v2.json')
    ;(f as Record<string, unknown>).itemIndex = {
      'minecraft:stone_slab:0': {
        display: 'Stone Slab',
        tooltip: ['Stone Slab', '下半台阶（本体）'],
        source: 'part',
        attribution: [{ source: 'part', frame: 0, grid: [0, 0, 0], localId: 'generic:0' }],
      },
      'minecraft:fence:0': {
        display: 'Fence',
        tooltip: [], // 空 ⇒ 消费侧兜底至少 display 一行（契约 §9 空值语义）
        source: 'part',
        attribution: [{ source: 'part', frame: 0, grid: [4, 0, 0], localId: 'generic:0' }],
      },
    }
    await gotoWikiPreviewWithScene(page, f, 'parts-singlebox-mix.b4-item-tooltip.json', { requireMesh: false })
    await waitStatsSidebarReady(page)

    // ① 多行说明：TooltipBox 文案 = itemIndex.tooltip 全部行（不是宿主 NEI 名、不是行键）
    await hoverStatsRow(page, 'minecraft:stone_slab:0')
    const slabTip = await pollUntil(() => readTooltipText(page), 'slab 行 TooltipBox', 15_000, 40)
    expect(slabTip, 'B-4：物品行悬停弹出 TooltipBox').not.toBeNull()
    expect(slabTip!, 'B-4：文案含 itemIndex.tooltip 首行').toContain('Stone Slab')
    expect(slabTip!, 'B-4：文案含 itemIndex.tooltip 第二行（完整行集，不是只有首行）').toContain('下半台阶（本体）')
    expect(slabTip!, 'B-4：文案不得是行键本身').not.toBe('minecraft:stone_slab:0')
    expect(slabTip!, 'B-4：不得落到旧实现的 "取最后一个冒号之后" 片段').not.toBe('0')
    await leaveStatsRow(page, 'minecraft:stone_slab:0')

    // ② 空说明行 ⇒ 可读兜底（至少 display 一行）
    await hoverStatsRow(page, 'minecraft:fence:0')
    const fenceTip = await pollUntil(() => readTooltipText(page), 'fence 行 TooltipBox', 15_000, 40)
    expect(fenceTip, 'B-4：说明行为空时仍必须有可读兜底（至少 display 一行）').toContain('Fence')
    await leaveStatsRow(page, 'minecraft:fence:0')

    // ③ 无 itemIndex 的行（索引缺条目）⇒ 回退行键本身（旧行为，绝不产出片段）
    const noIndex = readPartsFixture('parts-singlebox-mix.v2.json')
    await gotoWikiPreviewWithScene(page, noIndex, 'parts-singlebox-mix.b4-no-item-index.json', { requireMesh: false })
    await waitStatsSidebarReady(page)
    await hoverStatsRow(page, 'minecraft:stone_slab:0')
    const rawTip = await pollUntil(() => readTooltipText(page), '无索引行 TooltipBox', 15_000, 40)
    expect(rawTip, 'B-4：索引缺条目 ⇒ 回退行键本身（不是空）').not.toBeNull()
    expect(
      compactTooltipText(rawTip!),
      'B-4：回退文案 = 行键本身（`_` 会被 TooltipBox 的行内强调渲染吃掉 ⇒ 用格式无关压缩比对）',
    ).toBe(compactTooltipText('minecraft:stone_slab:0'))
    expect(rawTip!, 'B-4：不得落到旧实现的 "取最后一个冒号之后" 片段').not.toBe('0')
    await leaveStatsRow(page, 'minecraft:stone_slab:0')
    console.log(`[B-4] 物品行 TooltipBox：slab=${JSON.stringify(slabTip)} / fence=${JSON.stringify(fenceTip)} / 无索引=${JSON.stringify(rawTip)}`)
  })
})

// ---------------------------------------------------------------------------
// 性能登记：大批量命中 / 多选 ⇒ 描边通道截断 + 可辨认提示（不得静默失效）
// ---------------------------------------------------------------------------

/**
 * 构造大网格 fixture（600 格 = 599 个共享同一物品键的格 + 1 个另一物品键的格）。
 *
 * 目的：把「大批量命中（如石头 ×N）」与「多选」两个场景压到 `OUTLINE_MASK_LIMIT = 500` 上限附近，
 * 断言**截断 + 提示**（B-5 硬约束）并把**帧时间**做成测量登记（数字进报告，不设脆阈值）。
 * 期望值全部硬编码（不读 fixture 反推）：599/1 命中、500 上限、提示文案。
 */
function bigHitFixture(): Record<string, unknown> {
  const f = readPartsFixture('parts-ae2-multibox.v2.json')
  const frame = (f.frames as any[])[0]
  const st = frame.structure
  const CABLE = 'appliedenergistics2:item.ItemMultiPart:16'
  const TOGGLE = 'appliedenergistics2:item.ItemMultiPart:80'
  const W = 25
  const H = 2
  const D = 12 // 600 格
  const cellGrid: number[][][] = []
  const cellPartsGrid: number[][][] = []
  const attributions: Array<{ source: string; frame: number; grid: number[]; localId: string }> = []
  let big = 0
  let small = 0
  for (let z = 0; z < D; z++) {
    const rowG: number[][] = []
    const rowP: number[][] = []
    for (let r = 0; r < H; r++) {
      const colG: number[] = []
      const colP: number[] = []
      for (let c = 0; c < W; c++) {
        const isSmall = z === 0 && r === 0 && c === 0
        colG.push(isSmall ? 2 : 1) // 调色板 1 = 线缆格；2 = 切换总线格（同一几何，仅部件池不同）
        colP.push(isSmall ? 1 : 0)
        if (isSmall) small++
        else {
          big++
          attributions.push({ source: 'part', frame: 0, grid: [z, r, c], localId: 'ae2:UNKNOWN' })
        }
      }
      rowG.push(colG)
      rowP.push(colP)
    }
    cellGrid.push(rowG)
    cellPartsGrid.push(rowP)
  }
  // 调色板 2 = 线缆格几何的副本（只换 registryId 以便与 1 区分追踪；不做 raycast 断言）
  const pal2 = JSON.parse(JSON.stringify(st.blockPalette[1]))
  st.blockPalette.push(pal2)
  st.cellGrid = cellGrid
  st.cellPartsGrid = cellPartsGrid
  st.partLists = [st.partLists[0], [st.partLists[0][1]]] // [cable 部件], [toggle 部件]
  ;(f as Record<string, unknown>).itemIndex = {
    [CABLE]: {
      display: 'ME Glass Cable - Fluix',
      tooltip: ['ME Glass Cable - Fluix'],
      source: 'part',
      attribution: attributions,
    },
    [TOGGLE]: {
      display: 'ME Toggle Bus',
      tooltip: ['ME Toggle Bus'],
      source: 'part',
      attribution: [{ source: 'part', frame: 0, grid: [0, 0, 0], localId: 'ae2:NORTH' }],
    },
  }
  ;(f as any).__bigSmall = { big, small }
  return normalizeTextureBlobsForRender(f)
}

/** 采样 40 帧的帧间隔（ms）—— 帧时间测量原语（测量登记，不是断言阈值）。 */
async function sampleFrameGaps(page: import('@playwright/test').Page): Promise<{ avg: number; max: number; n: number }> {
  return await page.evaluate(
    () =>
      new Promise<{ avg: number; max: number; n: number }>((resolve) => {
        const gaps: number[] = []
        let last = performance.now()
        let n = 0
        const tick = (t: number) => {
          gaps.push(t - last)
          last = t
          if (++n < 40) requestAnimationFrame(tick)
          else {
            const sum = gaps.reduce((a, b) => a + b, 0)
            resolve({ avg: sum / gaps.length, max: Math.max(...gaps), n: gaps.length })
          }
        }
        requestAnimationFrame(tick)
      }),
  )
}

test.describe('大批量命中/多选：描边通道截断 + 提示 + 帧时间登记', () => {
  test('600 格同键（599 命中）⇒ mask 截断到 500 + 提示「仅高亮前 500 处」；小命中不劣化', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', EXPANDED_SIDEBAR_DESKTOP_ONLY)
    test.setTimeout(300_000)
    const CABLE = 'appliedenergistics2:item.ItemMultiPart:16'
    const TOGGLE = 'appliedenergistics2:item.ItemMultiPart:80'
    const LIMIT = 500
    const BIG_HITS = 599

    await gotoWikiPreviewWithScene(page, bigHitFixture(), 'parts-bighit-600cells.json', { requireMesh: false })
    await waitStatsSidebarReady(page)

    // 基线：小命中（1 处）—— 先测帧时间与 mask 数（对照面）
    const s0 = await clickStatsRow(page, TOGGLE)
    expect(s0.notice, '小命中不截断 ⇒ 无提示').toBeNull()
    const smallMask = await pollUntil(
      async () => {
        const m = await readOutlineMask(page)
        return m.meshCount === 1 ? m : null
      },
      '小命中 mask = 1',
      30_000,
    )
    expect(smallMask.meshCount, '小命中：1 处 ⇒ 1 块 mask（通道未失效）').toBe(1)
    const smallFrames = await sampleFrameGaps(page)

    // 大批量命中：599 处 ⇒ 截断到上限 + 可辨认提示（不得静默失效）
    const t0 = Date.now()
    const s1 = await clickStatsRow(page, CABLE)
    const bigMask = await pollUntil(
      async () => {
        const m = await readOutlineMask(page)
        return m.meshCount === LIMIT ? m : null
      },
      `大命中 mask = ${LIMIT}（截断生效）`,
      120_000,
    )
    const settleMs = Date.now() - t0
    expect(bigMask.meshCount, `599 命中 ⇒ mask 截断到 ${LIMIT}（通道上限，不静默失效）`).toBe(LIMIT)
    expect(s1.notice, '截断必须给出可辨认提示（命中数 + 实际高亮数）').toContain('仅高亮前 500 处')
    expect(s1.notice, '提示必须报出命中总数').toContain(String(BIG_HITS))
    const bigFrames = await sampleFrameGaps(page)
    // 帧时间不劣化的**测量登记**（宽松上界只为捕捉"整帧卡死"级退化，数字进报告）
    expect(bigFrames.max, `大命中场景单帧间隔不得达到整秒级卡死（实测 ${bigFrames.max.toFixed(1)}ms）`).toBeLessThan(2000)

    console.log(
      `[性能测量] 600 格 fixture：小命中(1) 帧均 ${smallFrames.avg.toFixed(2)}ms/峰 ${smallFrames.max.toFixed(2)}ms；` +
        `大命中(${BIG_HITS}→mask ${LIMIT}) 帧均 ${bigFrames.avg.toFixed(2)}ms/峰 ${bigFrames.max.toFixed(2)}ms；` +
        `截断落定耗时 ${settleMs}ms；提示「${s1.notice}」`,
    )
  })
})
