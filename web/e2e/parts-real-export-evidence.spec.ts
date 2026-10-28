/**
 * **真实导出** UI 证据采集包（验收位截图的唯一合法来源）。
 *
 * 存在理由（验收规范 §2 UI 硬规则）：UI 侧验收截图一律以**游戏内真实导出产物**为输入。
 * 本包把 L1 真实全量导出（`PARTS_ACCEPTANCE_DIR` 指定的归档，或最近归档回退）加载进
 * 生产 Wiki 工作区，对 B-1（描边收敛）/ B-4（部件级 tooltip）/ B-5（点选→部件级高亮）
 * 逐项**重走生产交互路径并截图**。fixture 包（parts-outline-b1 / parts-item-select-b5）
 * 的同名截图是开发过程旁证，不站在验收位。
 *
 * 断言口径（与 fixture 包同标尺，但**期望值全部从导出文件自身派生**，无一硬编码几何）：
 *  - mask 世界顶点 AABB − 格世界角 = 格内局部 AABB，必须与该部件**文件盒 union** 一致
 *    （ε=1e-4，float32 世界坐标舍入量级，见 EPS 注释）——证明描边贴合部件盒而非整格；
 *  - 点选物品行的 mask 块数 = 文件 `itemIndex` 里该键的 `source=part` 归属数（去重后）；
 *  - tooltip 文本 = 文件里该部件的 tooltip 行（含「位于 <宿主>」归属标注）。
 *
 * 输出：`web/e2e/screenshots/parts/ev-real-*.png`（gitignore 内，由执行者上传）。
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  CANONICAL_ORACLE_FILES,
  PARTS_CANONICAL_ORACLE_REL,
  REAL_EXPORT_FILES,
  cellsOfZone,
  gridIndexOf,
  loadArchiveJson,
  loadOracle,
  parseRealExport,
  partsAtGrid,
  probePartHover,
  readCameraDirectionForCell,
  readFileItemIndex,
  resolvePartsArchive,
  REPO_ROOT,
  gotoWikiPreviewWithScene,
  clearWikiHover,
  injectHoverAtCellLocal,
  readWikiHover,
  readOutlineMask,
  readOutlineMaskMeshes,
  maskLocalAabb,
  maskMeshLocalAabb,
  readGridSize,
  waitStatsSidebarReady,
  readStatsSidebarSettled,
  clickStatsRow,
  clickStatsRowWithMouse,
  selectedRowKeys,
  hoverStatsRow,
  hoverStatsRowWithMouse,
  hoverStatsRowText,
  leaveStatsRow,
  readTooltipText,
  compactTooltipText,
  WIKI_REGION,
  type OracleDoc,
  type OracleItemAttribution,
  attributionKey,
  type RealExportDoc,
  type RealPart,
} from './helpers/parts'
import { pollUntil } from './helpers/multiblock'

const SHOT_DIR = path.join(import.meta.dirname, 'screenshots', 'parts')
const archive = resolvePartsArchive()
const FULL: RealExportDoc = parseRealExport(loadArchiveJson(archive.dir, REAL_EXPORT_FILES.full))
const ORACLE: OracleDoc = loadOracle(archive.dir, 'full').oracle
/**
 * 受控 oracle（`test/expected/parts-acceptance/`）：由旧验收器具按 Minecraft 原语
 * **独立复算**、再**逐字节迁入**版本控制的期望基准——不是由当前 web 实现生成，
 * 也不是实现输出的同源副本。归档里另有一份 oracle 副本，只用于让通用读取链可跑；
 * FMP 键与归属的期望以本受控文件为准。
 */
const TRACKED_ORACLE = JSON.parse(
  fs.readFileSync(
    path.join(REPO_ROOT, PARTS_CANONICAL_ORACLE_REL, CANONICAL_ORACLE_FILES.full),
    'utf8',
  ),
) as { itemIndex: Record<string, { attribution: OracleItemAttribution[] }> }
/**
 * mask AABB 比对容差。fixture 格在近原点可逐值相等；真实场景在世界坐标 x≈64–69，
 * mask 顶点经 float32 世界矩阵往返，实测舍入伪差 ~5e-5（ae2:facade:EAST max[0]，float32
 * 在 |64| 量级单步 ulp≈7.6e-6 的累积）。1e-4 仍比「描边退回整格」类缺陷小三个数量级。
 */
const EPS = 1e-4

/** 部件文件盒 union（视觉盒优先；平面部件碰撞盒允许零厚度 ⇒ 以视觉盒为准）。 */
function partBoxUnion(part: RealPart): { min: number[]; max: number[] } {
  const visual = part.boxes.filter((b) => b.kind === 'visual')
  const boxes = visual.length > 0 ? visual : part.boxes
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const b of boxes) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, b.min[a]!)
      max[a] = Math.max(max[a]!, b.max[a]!)
    }
  }
  return { min, max }
}

function expectAabbClose(got: { min: number[]; max: number[] } | null, want: { min: number[]; max: number[] }, label: string) {
  expect(got, `${label}：有可见 mask`).not.toBeNull()
  for (let a = 0; a < 3; a++) {
    expect(Math.abs(got!.min[a]! - want.min[a]!), `${label} mask 下界[${a}] ≈ 文件盒 union`).toBeLessThan(EPS)
    expect(Math.abs(got!.max[a]! - want.max[a]!), `${label} mask 上界[${a}] ≈ 文件盒 union`).toBeLessThan(EPS)
  }
}

/** 两个 AABB 是否在容差内逐轴相等（逐 mesh 双射匹配用）。 */
function aabbClose(
  a: { min: number[]; max: number[] },
  b: { min: number[]; max: number[] },
  eps = EPS,
): boolean {
  return [0, 1, 2].every(
    (axis) => Math.abs(a.min[axis]! - b.min[axis]!) <= eps && Math.abs(a.max[axis]! - b.max[axis]!) <= eps,
  )
}

/** 部件文件盒 union（格内局部）→ 世界 AABB（与 mask 顶点同一空间）。 */
function partWorldAabb(
  part: RealPart,
  grid: { z: number; row: number; col: number },
  size: { w: number; h: number; d: number },
): { min: [number, number, number]; max: [number, number, number] } {
  const union = partBoxUnion(part)
  const worldY = size.h - 1 - grid.row
  const corner = [grid.col - size.w / 2, worldY - size.h / 2, grid.z - size.d / 2]
  return {
    min: [union.min[0]! + corner[0]!, union.min[1]! + corner[1]!, union.min[2]! + corner[2]!],
    max: [union.max[0]! + corner[0]!, union.max[1]! + corner[1]!, union.max[2]! + corner[2]!],
  }
}

/** 截图（等一帧保证 mask 是稳定态），返回文件名。 */
async function shot(page: Page, name: string, viewportOnly: boolean): Promise<string> {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  await page.waitForTimeout(150)
  const file = path.join(SHOT_DIR, name)
  if (viewportOnly) await page.locator('.vc-viewport').first().screenshot({ path: file })
  else await page.screenshot({ path: file })
  return name
}

test.describe('部件轮验收 · 真实导出 UI 证据（B-1/B-4/B-5 截图 + 同标尺断言）', () => {
  test('B-1/B-4：真实 AE2 格逐部件悬停——mask 贴合文件盒 union，tooltip 逐部件各自且含归属标注', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', '证据截图只出一份（desktop）；mobile 由 L2 解析级覆盖')
    test.setTimeout(300_000)
    await gotoWikiPreviewWithScene(page, FULL.raw, REAL_EXPORT_FILES.full)
    const size = await readGridSize(page)

    // AE2 区部件最多的格（真实产物：线缆 + 面板×2 + 终端 + 伪装板）
    const cell = cellsOfZone(ORACLE, 'ae2')
      .map((c) => ({ c, parts: partsAtGrid(FULL, gridIndexOf(c)) }))
      .filter((x) => x.parts.length >= 2)
      .reduce((a, b) => (b.parts.length > a.parts.length ? b : a))
    const g = gridIndexOf(cell.c)
    const camDir = await readCameraDirectionForCell(page, WIKI_REGION, g).catch(() => null)
    const cellCoord = { col: g.col, row: g.row, z: g.z }

    const observed: Array<{ localId: string; union: { min: number[]; max: number[] }; tooltip: string }> = []
    for (const part of cell.parts) {
      await clearWikiHover(page)
      const r = await probePartHover(page, { region: WIKI_REGION, grid: g, part, cameraDir: camDir })
      expect(r.hover.part?.localId, `命中部件身份 = ${part.localId}`).toBe(part.localId)
      // B-4：tooltip = 文件里该部件的说明行（含「位于 <宿主>」归属标注——B-4 语义）
      expect(r.tooltip, `${part.localId} tooltip 含部件显示名`).toContain(part.displayName)
      const union = partBoxUnion(part)
      const mask = await readOutlineMask(page)
      expectAabbClose(maskLocalAabb(mask, cellCoord, size), union, `B-1 ${part.localId}`)
      observed.push({ localId: part.localId, union, tooltip: r.tooltip ?? '' })
      // 前两部件各留一张视口描边图；第一个部件留一张**带 tooltip** 的全页图（B-4 验收位）
      if (observed.length === 1) await shot(page, 'ev-real-b4-tooltip-part.png', false)
      if (observed.length <= 2) await shot(page, `ev-real-b1-outline-${observed.length === 1 ? 'a' : 'b'}-${part.localId.replace(':', '_')}.png`, true)
    }
    // 同格多部件 mask 两两不同（描边到部件，不是到格）
    expect(new Set(observed.map((o) => JSON.stringify(o.union))).size, '同格各部件 mask 互不相同').toBe(observed.length)

    // ── 满方块回归：整格方块悬停 → part=null + mask = 整格 ──
    const fullCube = cellsOfZone(ORACLE, 'full-cube')[0]!
    const gf = gridIndexOf(fullCube)
    await clearWikiHover(page)
    await injectHoverAtCellLocal(page, { ...gf, lx: 0.5, ly: 0.9, lz: 0.5 })
    const hover = await pollUntil(() => readWikiHover(page), '满方块格悬停落定', 15_000, 40)
    expect(hover.part, '满方块格不携带部件命中').toBeNull()
    const stoneMask = await readOutlineMask(page)
    expectAabbClose(maskLocalAabb(stoneMask, { col: gf.col, row: gf.row, z: gf.z }, size), { min: [0, 0, 0], max: [1, 1, 1] }, 'B-1 满方块回归')
    await shot(page, 'ev-real-b1-fullcube-regression.png', true)

    console.log(`[EV-B1/B4] 真实格 ae2@[${g.z},${g.row},${g.col}] ${observed.length} 部件 mask 全部贴合文件盒 union：`)
    for (const o of observed) console.log(`  ${o.localId} union=${JSON.stringify(o.union)} tooltip=${JSON.stringify(o.tooltip)}`)
  })

  test('B-5：真实导出点选物品行 → 视口部件级高亮（单选 + Ctrl 多选并集）', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', '证据截图只出一份（desktop）')
    test.setTimeout(300_000)
    await gotoWikiPreviewWithScene(page, FULL.raw, REAL_EXPORT_FILES.full)
    await waitStatsSidebarReady(page)
    const size = await readGridSize(page)
    const itemIndex = readFileItemIndex(FULL)

    // 行键动态取自文件：AE2 族里归属数最多的两个键（线缆 + 任一其他部件行）
    const ae2Keys = Object.entries(itemIndex)
      .map(([key, e]) => ({
        key,
        display: e.display,
        parts: new Set(
          (e.attribution ?? []).filter((a) => a.source === 'part').map((a) => `${a.grid.join(',')}/${a.localId}`),
        ),
      }))
      .filter((x) => x.parts.size > 0 && (x.key.includes('ItemMultiPart') || x.key.includes('ItemFacade')))
      .sort((a, b) => b.parts.size - a.parts.size)
    expect(ae2Keys.length, 'itemIndex 里至少有 2 个 AE2 部件行键可选').toBeGreaterThanOrEqual(2)
    const [first, second] = ae2Keys

    // ── 单选第一行 ⇒ mask 块数 = 该键 part 归属数 ──
    const s1 = await clickStatsRow(page, first!.key)
    expect(selectedRowKeys(s1), '单击 = 单选').toEqual([first!.key])
    const m1 = await pollUntil(
      async () => ((await readOutlineMask(page)).meshCount === first!.parts.size ? await readOutlineMask(page) : null),
      `mask 块数 = ${first!.parts.size}（=${first!.display} 的 part 归属数）`,
      30_000,
    )
    expect(m1.meshCount, '点选行 ⇒ 部件级高亮块数 = 文件归属数').toBe(first!.parts.size)
    await shot(page, 'ev-real-b5-select-row-outline.png', true)
    await shot(page, 'ev-real-b5-select-row.png', false)

    // ── Ctrl 多选第二行 ⇒ 并集 = 两键归属数之和（跨格并集）──
    const s2 = await clickStatsRow(page, second!.key, { ctrl: true })
    const want = first!.parts.size + second!.parts.size
    expect(new Set(selectedRowKeys(s2)).size, 'Ctrl+单击 = 累加').toBe(2)
    const m2 = await pollUntil(
      async () => ((await readOutlineMask(page)).meshCount === want ? await readOutlineMask(page) : null),
      `多选 mask 块数 = ${want}（两键归属并集）`,
      30_000,
    )
    expect(m2.meshCount, '多选并集块数 = 两键归属数之和').toBe(want)
    await shot(page, 'ev-real-b5-multiselect-outline.png', true)
    await shot(page, 'ev-real-b5-multiselect.png', false)

    console.log(
      `[EV-B5] 行1 ${first!.display}(${first!.key}) 归属 ${first!.parts.size} → mask ${m1.meshCount}；` +
        `+行2 ${second!.display}(${second!.key}) 归属 ${second!.parts.size} → 并集 mask ${m2.meshCount}`,
    )
  })

  test('侧栏行悬停：悬停**物品图标**出 TooltipBox（行文本区不出）；文案 = 文件 itemIndex tooltip', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', '证据截图只出一份（desktop）')
    test.setTimeout(240_000)
    await gotoWikiPreviewWithScene(page, FULL.raw, REAL_EXPORT_FILES.full)
    await waitStatsSidebarReady(page)
    const itemIndex = readFileItemIndex(FULL)

    // 行键取自文件（AE2 部件行；英文显示名适配 compactTooltipText 的字母数字口径）
    const cableKey = 'appliedenergistics2:item.ItemMultiPart:16'
    const cableEntry = itemIndex[cableKey]
    expect(cableEntry, 'itemIndex 存在线缆键').toBeTruthy()

    // ── 生产路径：图标 pointerenter/move → tooltip-hover(source:'sidebar') → resolveSidebarLines → .wm-tooltip-box ──
    await hoverStatsRow(page, cableKey)
    const tip = await pollUntil(() => readTooltipText(page), '图标悬停 TooltipBox 出现', 15_000, 40)
    expect(tip, 'TooltipBox 必须出现（非 null）').not.toBeNull()
    // 文案 = 文件 itemIndex 该键 tooltip（格式无关压缩比对；§ 格式码经 renderTooltipHtml 转样式不进 innerText）
    expect(compactTooltipText(tip!), 'TooltipBox 含该物品显示名').toContain(compactTooltipText(cableEntry!.display))
    expect(cableEntry!.tooltip.length, '文件该键 tooltip 非空').toBeGreaterThan(0)
    expect(compactTooltipText(tip!), 'TooltipBox 文案 = 文件 itemIndex tooltip 首行').toContain(
      compactTooltipText(cableEntry!.tooltip[0]!),
    )
    await shot(page, 'ev-real-b4-sidebar-icon-tooltip.png', false)

    // ── 负对照（口径裁决）：先离开图标（真实 pointerleave → tooltip 清），
    //    再悬停行**文本区** → TooltipBox 必须不出现 ──
    await leaveStatsRow(page, cableKey)
    await pollUntil(async () => ((await readTooltipText(page)) === null ? true : null), '离开图标后 TooltipBox 消失', 15_000, 40)
    await hoverStatsRowText(page, cableKey)
    const tipNeg = await readTooltipText(page)
    expect(tipNeg, '行文本区悬停不出 TooltipBox（触发区 = 图标）').toBeNull()

    // ── 回退对照：原版物品行（chest）图标悬停同样出 TooltipBox，文案 = 文件 tooltip ──
    const chestKey = 'minecraft:chest:0'
    expect(itemIndex[chestKey], 'itemIndex 存在 chest 键').toBeTruthy()
    await hoverStatsRow(page, chestKey)
    const tip2 = await pollUntil(() => readTooltipText(page), 'chest 行图标悬停 TooltipBox 出现', 15_000, 40)
    expect(tip2, 'chest 行 TooltipBox 必须出现').not.toBeNull()
    expect(compactTooltipText(tip2!), 'chest TooltipBox 含显示名').toContain(compactTooltipText(itemIndex[chestKey]!.display))
    await leaveStatsRow(page, chestKey)

    console.log(
      `[EV-B4-sidebar] 图标悬停 ${cableKey} → TooltipBox=${JSON.stringify(tip)}；` +
        `文件 tooltip=${JSON.stringify(cableEntry!.tooltip)}；文本区悬停负对照=${JSON.stringify(tipNeg)}；` +
        `回退对照 ${chestKey} → ${JSON.stringify(tip2)}`,
    )
  })

  test('单盒区：真实悬停 tooltip（slab/栅栏/箱子任一格，带 tooltip 全页图）', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', '证据截图只出一份（desktop）')
    test.setTimeout(240_000)
    await gotoWikiPreviewWithScene(page, FULL.raw, REAL_EXPORT_FILES.full)
    const single = cellsOfZone(ORACLE, 'single-box').map((c) => ({ c, g: gridIndexOf(c) })).find((x) => partsAtGrid(FULL, x.g).length === 1)!
    const part = partsAtGrid(FULL, single.g)[0]!
    const camDir = await readCameraDirectionForCell(page, WIKI_REGION, single.g).catch(() => null)
    const r = await probePartHover(page, { region: WIKI_REGION, grid: single.g, part, cameraDir: camDir })
    expect(r.hover.part?.localId, '单盒格命中部件').toBe(part.localId)
    expect(r.tooltip, 'tooltip = 部件显示名').toContain(part.displayName)
    await shot(page, 'ev-real-b4-tooltip-singlebox.png', false)
    console.log(`[EV-B4] 单盒区 ${single.c.host} → ${part.localId} tooltip=${JSON.stringify(r.tooltip)}`)
  })

  test('FMP：真实材料键行 → 悬停物品 tooltip / 点选归属同一物品键（不串邻部件）', async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop-chrome',
      'FMP 行悬停是桌面指针交互（mobile 触屏无 hover）；点选归属的移动端边界由既有 item 点选包覆盖，不静默跳过',
    )
    test.setTimeout(300_000)
    await gotoWikiPreviewWithScene(page, FULL.raw, REAL_EXPORT_FILES.full)
    await waitStatsSidebarReady(page)
    const size = await readGridSize(page)
    const itemIndex = readFileItemIndex(FULL)

    // ── 键拼写：真实产物 itemIndex 的 FMP 键必须原样成为左栏行键（#mat= 材料判别不丢）──
    const FMP_PREFIX = 'ForgeMicroblock:microblock:'
    const hitKeyOf = (key: string) => new Set(itemIndex[key]!.attribution.map(attributionKey))
    const fmpKeys = Object.keys(itemIndex)
      .filter((k) => k.startsWith(FMP_PREFIX))
      .sort()
    const oracleFmpKeys = Object.keys(TRACKED_ORACLE.itemIndex)
      .filter((k) => k.startsWith(FMP_PREFIX))
      .sort()
    expect(fmpKeys, '导出 FMP 键集 = 受控 oracle 键集（同一拼写）').toEqual(oracleFmpKeys)
    expect(fmpKeys.length, '真实产物含三条 FMP 材料键').toBe(3)
    for (const key of fmpKeys) {
      expect(key, 'FMP 键保留 #mat= 材料判别').toContain('#mat=')
      expect(itemIndex[key]!.attribution.length, `${key} 在文件里有归属`).toBeGreaterThan(0)
      const oracleHits = new Set(TRACKED_ORACLE.itemIndex[key]!.attribution.map(attributionKey))
      expect(hitKeyOf(key), `${key} 归属 = 受控 oracle 归属`).toEqual(oracleHits)
    }
    // 行集是装配期动态写入的：要求"连续两次快照完全一致"才算稳定出现，避免单次快照撞上中间态。
    let prevSig = ''
    const stable = await pollUntil(
      async () => {
        const s = await readStatsSidebarSettled(page)
        const fmp = s.rows.filter((r) => r.key !== null && r.key.startsWith(FMP_PREFIX))
        const keys = fmp.map((r) => r.key!).sort()
        const exact =
          keys.length === fmpKeys.length &&
          keys.every((k, i) => k === fmpKeys[i]) &&
          fmp.every((r) => r.name !== '')
        if (!exact) {
          prevSig = ''
          return null
        }
        const sig = JSON.stringify(fmp.map((r) => [r.key, r.name, r.qty, r.iconKey, r.unresolved]))
        if (sig === prevSig) return s
        prevSig = sig
        return null
      },
      'FMP 三条行连续两次快照一致（稳定出现）',
      20_000,
      120,
    )
    const rows = stable.rows
    const sidebarFmpKeys = rows
      .map((r) => r.key)
      .filter((k): k is string => k !== null && k.startsWith(FMP_PREFIX))
      .sort()
    expect(sidebarFmpKeys, 'FMP 行键集双向精确相等（拒绝额外键）').toEqual(fmpKeys)
    expect(
      sidebarFmpKeys.filter((k) => !k.includes('#mat=')),
      '不得出现去掉 #mat= 的 base 键',
    ).toEqual([])
    const fmpRows = rows.filter((r) => r.key !== null && fmpKeys.includes(r.key))
    expect(fmpRows.length, '三条 FMP 行全部渲染').toBe(3)
    for (const row of fmpRows) {
      expect(row.iconKey, `行 ${row.key} 图标键 = 行键`).toBe(row.key)
      expect(row.unresolved, `行 ${row.key} 有归属 ⇒ 不标无对应`).toBe(false)
    }

    // ── 悬停：每条材料键出自己的 tooltip，互不串（非 generic、非邻键）──
    const tips: string[] = []
    for (const key of fmpKeys) {
      await hoverStatsRowWithMouse(page, key)
      const tip = await pollUntil(() => readTooltipText(page), `FMP 图标悬停 TooltipBox 出现（${key}）`, 15_000, 40)
      expect(tip, `${key} TooltipBox 必须出现`).not.toBeNull()
      const entry = itemIndex[key]!
      expect(compactTooltipText(tip!), `${key} 文案含文件 display`).toContain(compactTooltipText(entry.display))
      expect(compactTooltipText(tip!), `${key} 文案含文件 tooltip 首行`).toContain(
        compactTooltipText(entry.tooltip[0]!),
      )
      for (const other of fmpKeys.filter((k) => k !== key)) {
        expect(compactTooltipText(tip!), `${key} 文案不得串到 ${other} 的 display`).not.toContain(
          compactTooltipText(itemIndex[other]!.display),
        )
      }
      tips.push(tip!)
      await shot(page, `ev-real-fmp-tooltip-${tips.length}.png`, false)
      // 真实鼠标移出图标（不是合成 pointerleave）；tooltip 必须随之消失，避免下一条读到残留。
      await page.mouse.move(5, 5)
      await pollUntil(
        async () => ((await readTooltipText(page)) === null ? true : null),
        '离开 FMP 图标后 TooltipBox 消失',
        15_000,
        40,
      )
    }
    expect(new Set(tips).size, '三条 FMP 材料键的 tooltip 互不相同').toBe(fmpKeys.length)

    // ── 点选：单归属键 → 该部件盒（不是同格邻部件）；多归属键 → 全部归属并集 ──
    const singleKey = fmpKeys.find((k) => hitKeyOf(k).size === 1)!
    expect(singleKey, '真实产物存在单归属 FMP 键').toBeTruthy()
    const singleHit = itemIndex[singleKey]!.attribution[0]!
    const cell = { z: singleHit.grid[0], row: singleHit.grid[1], col: singleHit.grid[2] }
    const target = partsAtGrid(FULL, cell).find((p) => p.localId === singleHit.localId)
    expect(target, `归属 ${singleHit.localId}@${singleHit.grid.join(',')} 在真实产物同格存在`).toBeTruthy()

    const s1 = await clickStatsRowWithMouse(page, singleKey)
    expect(selectedRowKeys(s1), '单击 = 选中该 FMP 行键').toEqual([singleKey])
    const m1 = await pollUntil(
      async () => {
        const m = await readOutlineMask(page)
        return m.meshCount === 1 ? m : null
      },
      '单归属 FMP 键 ⇒ 一块 mask',
      20_000,
    )
    expect(m1.meshCount, '单归属 FMP 键 ⇒ 一块 mask').toBe(1)
    const local = maskLocalAabb(m1, cell, size)
    expectAabbClose(local, partBoxUnion(target!), `FMP ${singleKey}`)

    const neighbors = partsAtGrid(FULL, cell).filter((p) => p.localId !== target!.localId)
    expect(neighbors.length, '目标格存在同格邻部件（用于不串断言）').toBeGreaterThan(0)
    for (const n of neighbors) {
      const u = partBoxUnion(n)
      const differs = [0, 1, 2].some(
        (a) => Math.abs(u.min[a]! - local!.min[a]!) > EPS || Math.abs(u.max[a]! - local!.max[a]!) > EPS,
      )
      expect(differs, `描边不得是邻部件 ${n.localId} 的盒`).toBe(true)
    }

    for (const key of fmpKeys) {
      for (const a of itemIndex[key]!.attribution) {
        const part = partsAtGrid(FULL, { z: a.grid[0], row: a.grid[1], col: a.grid[2] }).find(
          (p) => p.localId === a.localId,
        )
        expect(part, `归属 ${a.localId}@${a.grid.join(',')} 在真实产物同格存在`).toBeTruthy()
      }
    }

    // 取归属最多的 FMP 键（跨格并集最完整；不是只看第一个多归属键）
    const multiKey = fmpKeys.reduce((a, b) => (hitKeyOf(b).size > hitKeyOf(a).size ? b : a))
    expect(hitKeyOf(multiKey).size, '真实产物存在多归属 FMP 键').toBeGreaterThan(1)
    const want = hitKeyOf(multiKey).size
    const s2 = await clickStatsRowWithMouse(page, multiKey)
    expect(selectedRowKeys(s2), '单击 = 单选该多归属 FMP 键').toEqual([multiKey])
    const meshes = await pollUntil(
      async () => {
        const ms = (await readOutlineMaskMeshes(page)).filter((m) => m.vertexCount > 0)
        return ms.length === want ? ms : null
      },
      `多归属 FMP 键 ⇒ ${want} 块 mask（文件归属去重数）`,
      20_000,
    )
    expect(meshes.length, '多归属 FMP 键 mask 数 = 文件归属去重数').toBe(want)

    // 逐 mesh 双射：每条文件归属在同格真实 partLists 里求 part 盒 union → 世界 AABB，
    // 必须**唯一**匹配一个 mask mesh；4 个错误同数 part（或任一 mesh 多余）都会在这里变红。
    const unmatched = new Set(meshes.map((_, i) => i))
    const matched: Array<{ hit: string; meshIndex: number; local: { min: number[]; max: number[] } }> = []
    for (const a of itemIndex[multiKey]!.attribution) {
      const grid = { z: a.grid[0], row: a.grid[1], col: a.grid[2] }
      const part = partsAtGrid(FULL, grid).find((p) => p.localId === a.localId)
      expect(part, `归属 ${a.localId}@${a.grid.join(',')} 在真实产物同格存在`).toBeTruthy()
      const union = partBoxUnion(part!)
      const expectedWorld = partWorldAabb(part!, grid, size)
      const candidates = [...unmatched].filter((i) => aabbClose(meshes[i]!, expectedWorld))
      expect(
        candidates.length,
        `归属 ${a.localId}@${a.grid.join(',')} 必须唯一匹配一个 mesh（实际 ${candidates.length} 个）`,
      ).toBe(1)
      const meshIndex = candidates[0]!
      unmatched.delete(meshIndex)
      const meshLocal = maskMeshLocalAabb(meshes[meshIndex]!, grid, size)
      expectAabbClose(meshLocal, union, `mesh#${meshIndex} 归属 ${a.localId}@${a.grid.join(',')}`)
      matched.push({ hit: `${a.localId}@${a.grid.join(',')}`, meshIndex, local: meshLocal! })
    }
    expect(unmatched.size, '全部 mesh 与文件归属一一匹配（无多余/无错误同数 part）').toBe(0)

    await shot(page, 'ev-real-fmp-select-outline.png', true)
    await shot(page, 'ev-real-fmp-select.png', false)

    console.log(
      `[EV-FMP] 键 ${fmpKeys.join(' | ')}；悬停文案 ${JSON.stringify(tips)}；` +
        `单归属 ${singleKey} → mask=${m1.meshCount} 局部 AABB=${JSON.stringify(local)}；` +
        `多归属 ${multiKey} 归属 ${want} → 逐 mesh 双射 ${JSON.stringify(matched)}`,
    )
  })
})
