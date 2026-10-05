/**
 * P3.1 · L2 真实导出渲染断言包（**真实产物**驱动；P2.5 fixture 包的产物级复跑）。
 *
 * 计划依据：`docs/plan/non-full-cube-parts-plan.md` §5 P3.1；契约：`docs/contracts/format-parts-contract.md`
 * （§2 文件表达 / §3 五要素+来源四元组 / §6 盒坐标系 / §9 统计默认值 / §11 oracle 格式）。
 *
 * 输入 = P1.8 建造→导出产物（`scripts/parts-acceptance/.out/<label>/`，由
 * `PARTS_ACCEPTANCE_DIR` 指定或以最近归档回退）+ canonical oracle
 * （`scripts/parts-acceptance/oracle/`，ground truth）。**产物缺失 = 显式失败**（不静默跳过）。
 *
 * ── 与 P2.5 fixture 包的差别（本包的存在理由）──
 *  P2.5 用**手工 fixture**（几何从简 + 几何增强内存副本）证明"实现能工作"；
 *  本包对**真实导出文件**（36 格意图 / 26 个 partLists 池，L1 已逐格核对通过的
 *  真实几何与真实坐标系 15×2×13）重跑同一批断言。
 *
 * ── 覆盖点（计划 P3.1 逐项）──
 *  1. **含部件文档真实加载渲染**：mesh 真的建起来（三角形数 > 0）、无 `DataCloneError`
 *     级回归（console error 通道断言；P2.5 擒获过的深响应式 `structuredClone` 阻断即此类）。
 *  2. **解析级逐格与 oracle 一致**：格映射通道 = oracle `grid:[zi,ri,ci]`（契约 §11），
 *     逐格断言 localId 序列 / typeKey / 档位 / 来源四元组（族由 localId 前缀按契约 §4 派生）
 *     + 盒静态合理性（min<max、非退化、允许越界——契约 §6.3）。
 *  3. **单盒区格（slab/栅栏/箱子）悬停到部件**：真实 raycast 命中 → 部件身份 + tooltip = 部件名。
 *  4. **AE2 区同格多部件不同 tooltip**：同格多个部件各得各的说明（命中判定到部件，不是到格）。
 *  5. **满方块格回归**：整格方块悬停不携带部件（`part === null`）、tooltip = 宿主回退（基线一致）。
 *  6. **统计默认视图行与 oracle `expectedCounts` 精确比对**（21 条 / 61 件；总数硬编码做反同义反复）。
 *  7. **来源徽标呈现** + 部件行图标键 = 物品身份键（不是宿主方块键）。
 *     P3.1 首轮擒获的 F1（StructureData 解析链丢文档根级 statsTemplate）与
 *     F2（partIconTextures 无消费接线）**已修复**，本节 C2 由"偏差锁"翻转为**正向锁**
 *     （徽标 = 文档默认 + 有纹理来源的部件行图标槽必须出 canvas）。
 *  8. **退化导出（degraded_all）**：全格落档 3 `family=inferred`、逐格与退化 oracle 哨兵语义一致；
 *     统计行有 inferred 族部件行，且 `countsScope=untransformed-cells-only` 子集精确
 *     （torch 12 件——退化档唯一"未变换格"）。
 *
 * ── 拍板登记（本包口径，均已上报调度者）──
 *  【探针点派生而非硬编码】真实产物坐标/几何与 fixture 不同，悬停是**真实 raycast**
 *  （射线命中宿主格几何 → 命中点换算格内坐标 → 部件盒判定）。探针点 = 从**导出文件自己的
 *  部件盒**派生的候选序列（盒面中心 → 面中心内缩 → 盒内 3×3×3 采样），按"面向相机"排序后
 *  逐个注入，命中目标部件即止（`helpers/parts/realExport.ts#probeCandidatesForPart`）。
 *  这是**输入整备**（让射线能到达目标盒），不是替身：命中判定、tooltip、统计全部走生产路径。
 *  【期望值来源】部件身份/数量/档位来自 oracle（mod 侧建造意图 + L1 逐格核对）；
 *  tooltip/名称来自真实导出文件自身的部件数据；两者不互相替代（二者一致性由 L1 独立断言）。
 *  **不硬编码** 36 格全部断言（否则等于把断言写死在某一轮产物上）；反同义反复由
 *  `EXPECTED_COUNTS_ENTRIES`/`EXPECTED_COUNTS_TOTAL`（21/61 硬编码）与
 *  "同格两部件必须得到两个不同 tooltip"两条交叉自检承担。
 */

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  CANONICAL_ORACLE_FILES,
  REAL_EXPORT_FILES,
  cellsOfZone,
  gridIndexOf,
  loadArchiveJson,
  loadOracle,
  gridApiPosOf,
  parseRealExport,
  partsAtGrid,
  probeAnyOfParts,
  probePartHover,
  readCameraDirectionForCell,
  readDefinitionRootFields,
  readPartsObservation,
  resolvePartsArchive,
  type GridIndex,
  type OracleCell,
  type OracleDoc,
  type RealExportDoc,
  type RealPart,
} from './helpers/parts'
import {
  WIKI_REGION,
  clearWikiHover,
  gotoWikiPreviewWithScene,
  injectHoverAtCellLocal,
  readProvenance,
  readStatsSidebarSettled,
  readTooltipText,
  readWikiHover,
  waitStatsRowIcons,
  waitStatsSidebarReady,
  type StatsRowObservation,
} from './helpers/parts'
import { pollUntil, readContentMesh } from './helpers/multiblock'

const SHOT_DIR = path.join(import.meta.dirname, 'screenshots', 'parts')

// ---------------------------------------------------------------------------
// 产物与 oracle（模块级读入一次；缺失即抛错 = 显式失败）
// ---------------------------------------------------------------------------

const archive = resolvePartsArchive()
const FULL: RealExportDoc = parseRealExport(loadArchiveJson(archive.dir, REAL_EXPORT_FILES.full))
const DEGRADED_ALL: RealExportDoc = parseRealExport(
  loadArchiveJson(archive.dir, REAL_EXPORT_FILES.degradedAll),
)
const ORACLE_FULL: OracleDoc = loadOracle(archive.dir, 'full').oracle
const ORACLE_DEGRADED_ALL: OracleDoc = loadOracle(archive.dir, 'degradedAll').oracle

// ---------------------------------------------------------------------------
// 反同义反复锚点（硬编码；不是"再读一遍被测文件"）
// ---------------------------------------------------------------------------

/** oracle `expectedCounts` 条目数（P1.8 release 归档实测）。 */
const EXPECTED_COUNTS_ENTRIES = 21
/** oracle `expectedCounts` 总件数（同上）。 */
const EXPECTED_COUNTS_TOTAL = 61
/** 退化档 `countsScope=untransformed-cells-only` 的唯一在册行（火把；P1.8 实测）。 */
const DEGRADED_SCOPE_TORCH = { typeKey: 'minecraft:torch:0', count: 12 }

/**
 * 契约 §4：localId 前缀 → 族（用于把 oracle 的 localId 映射回来源族）。
 *
 * P3.1 实测（已上报）：实现里 family 字符串与 localId 前缀**恒等**
 * （`generic/inferred/ae2/eio/fmp`），而契约 §3 示例把 EnderIO 族写作 `enderio`
 * —— 实际落盘是 `eio`（L1 README 的开关族名亦为 eio）。本函数按**实现口径**取前缀，
 * 并借"前缀 = family"这条恒等式把 oracle 的身份与产物的来源标记互证（比另写映射表更硬）。
 */
function familyOfLocalId(localId: string): string {
  const prefix = localId.split(':')[0] ?? '?'
  if (!['ae2', 'eio', 'fmp', 'generic', 'inferred'].includes(prefix)) return '?'
  return prefix
}

/** oracle 格（有部件者）→ 该格的部件期望。 */
function cellsWithParts(oracle: OracleDoc): OracleCell[] {
  return oracle.cells.filter((c) => (c.parts ?? []).length > 0)
}

/** 紧凑行形状（断言失败时 diff 可读）。 */
function compactRows(rows: StatsRowObservation[]): Array<{ key: string | null; kind: string | null; qty: string }> {
  return rows.map((r) => ({ key: r.key, kind: r.kind, qty: r.qty }))
}

/** 部件类型键 → 该键在文件里出现过的全部显示名（应唯一）。 */
function displayNamesByTypeKey(doc: RealExportDoc): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const list of doc.partLists ?? []) {
    for (const p of list) {
      const set = out.get(p.typeKey) ?? new Set<string>()
      set.add(p.displayName)
      out.set(p.typeKey, set)
    }
  }
  return out
}

/** 在页面里挂 console 错误收集（`DataCloneError` 级回归的观测通道）。 */
function collectConsoleErrors(page: Page): string[] {
  const errs: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errs.push(msg.text())
  })
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`))
  return errs
}

/** 该格的相机方向（供候选点排序）；失败返回 null（按默认顺序试）。 */
async function cameraDirFor(page: Page, grid: GridIndex): Promise<[number, number, number] | null> {
  try {
    return await readCameraDirectionForCell(page, WIKI_REGION, grid)
  } catch {
    return null
  }
}

// ===========================================================================
// A. 加载与解析级（两个 project 都跑）
// ===========================================================================

test.describe('P3.1 · 真实全量导出：加载渲染 + 解析级逐格与 oracle 一致', () => {
  test('全量导出：mesh 渲染、无 DataCloneError 级回归、36 格意图逐格一致', async ({ page }) => {
    test.setTimeout(240_000)
    const errs = collectConsoleErrors(page)
    await gotoWikiPreviewWithScene(page, FULL.raw, REAL_EXPORT_FILES.full)

    // ── 1. 真实加载渲染（mesh 真的建起来）──
    const mesh = await readContentMesh(page, WIKI_REGION)
    expect(mesh.present, '真实导出渲染出内容 mesh 组').toBe(true)
    expect(mesh.meshes, 'mesh 数 > 0').toBeGreaterThan(0)
    expect(mesh.triangles, '三角形数 > 0（几何真的进了管线）').toBeGreaterThan(0)
    // DataCloneError 级回归（P2.5 擒获过的深响应式 structuredClone 阻断）：
    // 只对"克隆/结构化"类错误判红——真实导出含 materialPalette 纹理槽等既有告警噪声不在此列。
    const fatal = errs.filter((e) => /DataCloneError|structuredClone|Maximum call stack/i.test(e))
    expect(fatal, `console 出现克隆级致命错误：\n${fatal.join('\n')}`).toEqual([])

    // ── 2. 解析级逐格与 oracle 一致（格映射通道 = oracle grid）──
    const cells = await readPartsObservation(page)
    const expectedCells = cellsWithParts(ORACLE_FULL)
    expect(cells.length, `带部件格数 = oracle 带部件格数（${expectedCells.length}）`).toBe(expectedCells.length)

    const observedByPos = new Map(cells.map((c) => [`${c.pos.x},${c.pos.y},${c.pos.z}`, c]))
    const details: string[] = []
    /** 某轴零厚度的盒（平面类部件的如实快照；测量观察，不判违例 —— 见下方注释）。 */
    const degenerateBoxes: string[] = []
    for (const oc of expectedCells) {
      const g = gridIndexOf(oc)
      // 格映射自检：oracle pos ↔ grid 下标 ↔ 导出文件下标（契约 §11 通道，独立于提供者实现）
      const [ox, oy, oz] = ORACLE_FULL.gridIndex.origin
      const [gw, gh] = ORACLE_FULL.gridIndex.size
      expect(
        [ox + g.col, oy + (gh - 1 - g.row), oz + g.z],
        `oracle 格映射自检（pos ↔ grid）: ${oc.zone} ${oc.pos}`,
      ).toEqual(oc.pos)
      // 导出文件里该下标确有部件池（且与 oracle 的部件数一致）
      const fileParts = partsAtGrid(FULL, g)
      const pagePos = gridApiPosOf(oc, ORACLE_FULL.gridIndex.size)
      const key = `${pagePos.x},${pagePos.y},${pagePos.z}`
      const observed = observedByPos.get(key)
      expect(observed, `导出文件解析出格 ${key}（zone=${oc.zone}）`).toBeTruthy()
      expect(
        fileParts.length,
        `导出文件 cellPartsGrid[${g.z}][${g.row}][${g.col}] 部件数 = oracle（zone=${oc.zone}）`,
      ).toBe(oc.parts.length)

      // 契约 §11 未规定格内部件顺序 ⇒ 按 localId 集合比对（顺序无关；身份/键/档位逐条精确）
      const gotIds = observed!.parts!.map((p) => p.localId).sort()
      const wantIds = oc.parts.map((p) => p.localId).sort()
      expect(gotIds, `zone=${oc.zone} pos=${key} 部件 localId 集合`).toEqual(wantIds)
      const gotById = new Map(observed!.parts!.map((p) => [p.localId, p]))
      const fileById = new Map(fileParts.map((p) => [p.localId, p]))

      for (const want of oc.parts) {
        const got = gotById.get(want.localId)!
        const filePart = fileById.get(want.localId)!
        expect(filePart, `导出文件里存在部件 ${want.localId}`).toBeTruthy()
        // ① localId（契约 §4 命名空间）已在集合断言中逐条核对
        // ② typeKey（计数/合并键，契约 §5）
        expect(got.typeKey, `${want.localId} typeKey`).toBe(want.typeKey)
        // ③ 物品件数（契约 §5 "一格多物算 N 件"）
        expect(got.itemCounts.reduce((a, b) => a + b, 0), `${want.localId} 物品件数`).toBe(want.itemCount)
        // ④ 来源四元组：族由 localId 前缀派生（契约 §4）——与 oracle 档位/来源互证
        expect(got.source.tier, `${want.localId} 档位`).toBe(want.boxTier)
        expect(got.source.family, `${want.localId} 族（localId 前缀派生）`).toBe(familyOfLocalId(want.localId))
        expect(got.source.fallback, `${want.localId} fallback（档 1 ≠ 兜底）`).toBe(want.boxTier !== 1)
        if (want.boxProvenance !== '*') {
          expect(got.source.boxProvenance, `${want.localId} 视觉/碰撞来源`).toBe(want.boxProvenance)
        }
        if (want.boxCount >= 0) {
          expect(got.boxCount, `${want.localId} 盒数`).toBe(want.boxCount)
        }
        // ⑤ 盒静态合理性（契约 §6.3：允许越界，但不允许反向盒；平面类部件盒允许某轴零厚度
        //    —— P3.1 实测：AE2 破坏面板（:300）碰撞盒 [0.0625,0.0625,0.9375]→[0.9375,0.9375,0.9375]
        //    在 y/z 两轴零厚度，是 AE2 平面语义的**如实快照**（视觉盒有 0.0625 厚度），
        //    已作为测量观察登记上报，不按契约违例处理）
        for (const b of got.boxes) {
          for (let a = 0; a < 3; a++) {
            expect(b.min[a]!, `${want.localId} 盒 min[${a}] ≤ max[${a}]`).toBeLessThanOrEqual(b.max[a]!)
            expect(Math.abs(b.min[a]!), `${want.localId} 盒坐标量级合理（未越界过远）`).toBeLessThanOrEqual(2)
            expect(Math.abs(b.max[a]!), `${want.localId} 盒坐标量级合理（未越界过远）`).toBeLessThanOrEqual(2)
          }
          const extents = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]]
          expect(Math.max(...extents), `${want.localId} 盒不得全轴退化（至少一轴有正厚度）`).toBeGreaterThan(0)
          if (extents.filter((e) => e === 0).length > 0) {
            degenerateBoxes.push(
              `${want.localId}/${b.kind} min=${JSON.stringify(b.min)} max=${JSON.stringify(b.max)}`,
            )
          }
        }
        expect(filePart!.tooltip.length, `${want.localId} 说明行非空（优先级链任何情况有话说）`).toBeGreaterThan(0)
        expect(filePart!.displayName.length, `${want.localId} 显示名非空`).toBeGreaterThan(0)
        void details
      }
    }
    console.log(
      `[P3.1-L2] 归档 ${archive.dir}（来源 ${archive.source}）：带部件格 ${cells.length} / 部件 ${
        expectedCells.reduce((n, c) => n + c.parts.length, 0)
      } 个逐格与 oracle 一致；mesh triangles=${mesh.triangles}；零厚度盒（平面语义）${
        [...new Set(degenerateBoxes)].length
      } 个：${[...new Set(degenerateBoxes)].join(', ')}`,
    )
  })

  test('全量导出：满方块格必须无部件、非满格必须有部件（快速否定路径的产物级证据）', async ({ page }) => {
    // 纯文件级判据（不需要页面）——但保留在同一 describe 以便报告里与加载用例同行。
    test.setTimeout(60_000)
    let fullCubeCells = 0
    let nonFullCells = 0
    for (const oc of ORACLE_FULL.cells) {
      const g = gridIndexOf(oc)
      const idx = FULL.cellPartsGrid?.[g.z]?.[g.row]?.[g.col]
      expect(idx, `cellPartsGrid 下标存在（zone=${oc.zone}）`).not.toBeUndefined()
      if (oc.expectFullCube) {
        fullCubeCells++
        expect(idx, `满方块格（${oc.host}）必须为 PARTS_GRID_NONE(-1)`).toBe(-1)
        expect(oc.parts.length, `满方块格 oracle 期望无部件`).toBe(0)
      } else {
        nonFullCells++
        expect(idx, `非满格（${oc.host}）必须挂部件池`).toBeGreaterThanOrEqual(0)
        expect(oc.parts.length, `非满格 oracle 期望 ≥1 部件`).toBeGreaterThan(0)
      }
    }
    expect(fullCubeCells, 'oracle 里满方块格数 > 0（快速否定路径被行使）').toBeGreaterThan(0)
    expect(nonFullCells, 'oracle 里非满格数 > 0').toBeGreaterThan(0)
    console.log(`[P3.1-L2] 快速否定路径：满方块格 ${fullCubeCells} 个全 -1；非满格 ${nonFullCells} 个全挂部件池`)
  })
})

// ===========================================================================
// B. 悬停（真实 raycast → 部件身份 + tooltip）
// ===========================================================================

test.describe('P3.1 · 真实导出悬停：单盒区 / AE2 同格多部件 / 满方块回归', () => {
  test('单盒区（slab / 栅栏 / 箱子）悬停命中部件，tooltip = 部件说明', async ({ page }) => {
    test.setTimeout(240_000)
    await gotoWikiPreviewWithScene(page, FULL.raw, REAL_EXPORT_FILES.full)

    // 单盒区三格：下半 slab / 栅栏 / 箱子（host 从 oracle 取；部件身份 = generic:0）
    const singles = cellsOfZone(ORACLE_FULL, 'single-box').filter((c) => c.parts.length === 1)
    const picks: Array<{ label: string; hostPrefix: string; cell: OracleCell }> = []
    for (const [label, prefix] of [
      ['slab', 'minecraft:stone_slab'],
      ['fence', 'minecraft:fence'],
      ['chest', 'minecraft:chest'],
    ] as const) {
      const c = singles.find((x) => x.host.startsWith(prefix))
      expect(c, `oracle 单盒区存在 ${label} 格`).toBeTruthy()
      picks.push({ label, hostPrefix: prefix, cell: c! })
    }

    const log: string[] = []
    for (const p of picks) {
      const g = gridIndexOf(p.cell)
      const parts = partsAtGrid(FULL, g)
      expect(parts.length, `${p.label} 格部件数`).toBe(1)
      const camDir = await cameraDirFor(page, g)
      const r = await probePartHover(page, { region: WIKI_REGION, grid: g, part: parts[0]!, cameraDir: camDir })
      expect(r.hover.part?.localId, `${p.label} 命中部件身份`).toBe(p.cell.parts[0]!.localId)
      expect(r.hover.part?.displayName, `${p.label} 命中部件显示名`).toBe(parts[0]!.displayName)
      expect(r.tooltip, `${p.label} tooltip 必须含部件显示名 ${parts[0]!.displayName}`).toContain(parts[0]!.displayName)
      expect(r.tooltip!, `${p.label} tooltip 非空`).not.toBe('')
      log.push(`${p.label}(${p.cell.host})→${r.hover.part?.localId}/${JSON.stringify(r.tooltip)}·${r.attempts}试探`)
      await clearWikiHover(page)
    }
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    await page.screenshot({ path: path.join(SHOT_DIR, 'real-export-singlebox-hover.png') })
    console.log(`[P3.1-L2] 单盒区悬停：${log.join(' | ')}`)
  })

  test('AE2 区同格多部件：各部件得各自的 tooltip（命中判定到部件）', async ({ page }, testInfo) => {
    // 同格多部件需要逐个候选试探（真实几何 + 同格盒重叠），耗时显著 ⇒ 仅 desktop 跑
    // （与 P2.5 的 EXPANDED_SIDEBAR_DESKTOP_ONLY 同性质的口径登记：mobile 覆盖 = 解析级 + 单探针）。
    test.skip(
      testInfo.project.name !== 'desktop-chrome',
      'AE2 同格多部件需多轮候选试探（真实几何盒重叠），耗时口径仅 desktop 跑；mobile 覆盖 = 解析级 + 单盒区单探针',
    )
    test.setTimeout(300_000)
    await gotoWikiPreviewWithScene(page, FULL.raw, REAL_EXPORT_FILES.full)

    // 取 AE2 区**部件最多**的格（真实产物：5 部件 = 线缆 + 成形/破坏面板 + 终端 + 伪装板）
    const ae2Cells = cellsOfZone(ORACLE_FULL, 'ae2').filter((c) => c.parts.length >= 2)
    expect(ae2Cells.length, 'AE2 区存在同格多部件格').toBeGreaterThan(0)
    const cell = ae2Cells.reduce((a, b) => (b.parts.length > a.parts.length ? b : a))
    const g = gridIndexOf(cell)
    const parts = partsAtGrid(FULL, g)
    expect(parts.length, 'AE2 格部件数 = oracle').toBe(cell.parts.length)

    // 逐个部件找探针（至少前两个部件；全部部件都试，命中不了即报红 —— 见 probePartHover 的失败语义）
    const camDir = await cameraDirFor(page, g)
    const probes = await probeAnyOfParts(page, { region: WIKI_REGION, grid: g, parts, cameraDir: camDir })
    expect(probes.length, '每个部件都找到可命中探针').toBe(parts.length)

    // ── 核心断言：同格不同部件 → 不同 tooltip，且各自含自己的 displayName ──
    //    注：格内部件顺序由文件决定（oracle 未规定顺序，见 A1 用例的集合比对），
    //    因此这里按**文件顺序**（= 探针构造顺序）对比身份。
    const tips = probes.map((p) => p.tooltip ?? '')
    for (let i = 0; i < probes.length; i++) {
      expect(probes[i]!.hover.part?.localId, `第 ${i} 个部件命中身份`).toBe(parts[i]!.localId)
      expect(tips[i], `第 ${i} 个部件 tooltip 必须含其显示名 ${parts[i]!.displayName}`).toContain(parts[i]!.displayName)
    }
    const uniq = new Set(tips)
    expect(uniq.size, `同格 ${parts.length} 个部件的 tooltip 至少两种（不是同一句话）`).toBeGreaterThan(1)
    // 线缆 vs 终端/面板：两两不同（真实产物里这些部件的显示名互不相同）
    const names = parts.map((p) => p.displayName)
    expect(new Set(names).size, 'AE2 格部件显示名互不相同（同格多部件可区分）').toBe(names.length)

    await clearWikiHover(page)
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    await page.screenshot({ path: path.join(SHOT_DIR, 'real-export-ae2-hover.png') })
    console.log(
      `[P3.1-L2] AE2 格 (z=${g.z},row=${g.row},col=${g.col}) 5 部件悬停：` +
        probes.map((p) => `${p.hover.part?.localId}=${JSON.stringify(p.tooltip)}`).join(' | '),
    )
  })

  test('满方块格：悬停不携带部件、tooltip = 宿主回退（与无部件基线一致）', async ({ page }) => {
    test.setTimeout(240_000)
    await gotoWikiPreviewWithScene(page, FULL.raw, REAL_EXPORT_FILES.full)

    const fullCube = cellsOfZone(ORACLE_FULL, 'full-cube')
    expect(fullCube.length, 'oracle 满方块区格数 > 0').toBeGreaterThan(0)
    const cell = fullCube[0]!
    const g = gridIndexOf(cell)
    // 满方块格内任意命中点都落该格（无部件盒可判定）⇒ 直接注入格内偏上点。
    await clearWikiHover(page)
    const pt = { ...g, lx: 0.5, ly: 0.9, lz: 0.5 }
    await injectHoverAtCellLocal(page, pt)
    const hover = await pollUntil(() => readWikiHover(page), '满方块格悬停落定', 15_000, 40)
    expect(hover, '满方块格悬停有落点').not.toBeNull()
    expect(hover.voxel, '命中该格').not.toBeNull()
    expect(hover.part, `满方块格（${cell.host}）不携带部件命中`).toBeNull()
    const tooltip = await pollUntil(() => readTooltipText(page), '满方块格 tooltip', 15_000, 40)
    expect(tooltip, '满方块 tooltip = 宿主回退（非空）').not.toBeNull()
    console.log(`[P3.1-L2] 满方块格 ${cell.host} → part=null，tooltip=${JSON.stringify(tooltip)}`)
    await clearWikiHover(page)
  })
})

// ===========================================================================
// C. 统计（真实 oracle expectedCounts 精确比对）
// ===========================================================================

test.describe('P3.1 · 真实导出统计：默认视图 = oracle expectedCounts 精确比对', () => {
  test('默认视图行 = oracle expectedCounts（21 条 / 61 件）+ 来源徽标 + 部件行图标键', async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop-chrome',
      '展开态侧栏交互在 mobile 窄布局自动折叠振荡（P2.5 实证登记，实现发现未修）；仅 desktop 跑',
    )
    test.setTimeout(240_000)
    await gotoWikiPreviewWithScene(page, FULL.raw, REAL_EXPORT_FILES.full, { requireMesh: false })
    await waitStatsSidebarReady(page)
    const s = await readStatsSidebarSettled(page)

    // ── 反同义反复锚点：oracle 自身条目数/总件数（硬编码）──
    expect(ORACLE_FULL.expectedCounts.length, 'oracle expectedCounts 条目数 = 硬编码 21').toBe(
      EXPECTED_COUNTS_ENTRIES,
    )
    expect(
      ORACLE_FULL.expectedCounts.reduce((n, e) => n + e.count, 0),
      'oracle expectedCounts 总件数 = 硬编码 61',
    ).toBe(EXPECTED_COUNTS_TOTAL)

    // ── 默认视图 = 部件物品清单，行/计数与 oracle 精确一致 ──
    expect(s.toolbar, '含部件数据 ⇒ 部件模式工具条渲染').toBe(true)
    expect(s.viewButtons.map((b) => [b.id, b.active]), '默认激活 = 部件物品视图').toEqual([
      ['parts', true],
      ['hosts', false],
      ['custom', false],
    ])
    const rowsByKey = new Map(s.rows.map((r) => [r.key!, r]))
    expect(s.rows.length, '统计行数 = oracle 条目数（无多行/少行）').toBe(ORACLE_FULL.expectedCounts.length)
    const mismatch: string[] = []
    for (const e of ORACLE_FULL.expectedCounts) {
      const row = rowsByKey.get(e.typeKey)
      if (!row) {
        mismatch.push(`${e.typeKey} 缺失（oracle ${e.count}）`)
        continue
      }
      if (row.qty !== String(e.count)) mismatch.push(`${e.typeKey} 计数 ${row.qty} ≠ oracle ${e.count}`)
    }
    expect(mismatch, `统计行与 oracle expectedCounts 精确比对差异：\n${mismatch.join('\n')}`).toEqual([])
    // 总数（61 件）——独立于逐行比对的和
    expect(
      s.rows.reduce((n, r) => n + Number(r.qty), 0),
      '统计行件数总和 = 61',
    ).toBe(EXPECTED_COUNTS_TOTAL)

    // ── 名称与图标键：名称取部件显示名（文件自带），图标键 = 物品身份键 ──
    const names = displayNamesByTypeKey(FULL)
    for (const r of s.rows) {
      expect(r.kind, `行 ${r.key} kind=part`).toBe('part')
      const wantNames = names.get(r.key!)
      expect(wantNames, `行 ${r.key} 在导出文件里有对应部件`).toBeTruthy()
      expect([...wantNames!], `行 ${r.key} 显示名唯一`).toHaveLength(1)
      expect(r.name, `行 ${r.key} 名称 = 部件显示名`).toBe([...wantNames!][0])
      // 图标键 = 物品身份键（`registry:damage[#nbt]`），不是宿主方块键（registryId / registryId@meta）
      expect(r.iconKey, `行 ${r.key} 图标键 = 物品身份键`).toBe(r.key)
    }

    // ── 来源徽标（三级配置来源对用户可见）──
    expect(s.pill, '含部件 ⇒ 配置来源徽标常驻').not.toBeNull()
    expect(
      ['document-default', 'builtin', 'document-override', 'viewer-local'],
      `徽标来源取值合法（实际 ${s.pill?.source}）`,
    ).toContain(s.pill!.source)
    expect(s.pill!.text.length, '徽标文本非空（来源对用户可见）').toBeGreaterThan(0)
    const prov = await readProvenance(page, true)
    expect(prov.panel, 'provenance 逐字段面板可展开').not.toBeNull()
    expect(prov.panel!.length, 'provenance 逐字段行非空').toBeGreaterThan(0)

    fs.mkdirSync(SHOT_DIR, { recursive: true })
    await page.locator('.wb-wiki-embed .nei-sidebar').screenshot({ path: path.join(SHOT_DIR, 'real-export-stats.png') })
    console.log(
      `[P3.1-L2] 真实导出统计：${s.rows.length} 行与 oracle 精确一致（共 61 件）；` +
        `徽标=${s.pill!.text}/${s.pill!.source}；provenance 字段 ${prov.panel!.length} 条`,
    )
  })
})

// ===========================================================================
// C2. 文档根字段存活（F1/F2 **已修复**后的正向锁）
// ===========================================================================

test.describe('P3.1 · 文档根字段在真实导出解析链上的存活（F1/F2 修复锁）', () => {
  /**
   * 本用例原为"**已知偏差锁**"（P3.1 首轮）：断言当时的偏差状态（`definition.statsTemplate` 不可得、
   * 徽标 = 内建默认、`partIconTextures` 无消费接线），让偏差被机器记录进
   * `acceptance-report.json#findings`，并在实现被修好时主动变红。
   *
   * **修复后已翻转为正向锁**（本轮，见报告 findings F1/F2 的 `expectedAfterFix`）：
   *  - **F1**：`StructureDataParser` 已把**文档根级** `statsTemplate`/`statsOverride`/`partIconTextures`
   *    透传到 v2 根（与 structure 级的 `cellPartsGrid`/`partLists` 分层，见
   *    `web/src/context/__tests__/structureDataRootFields.test.ts`）⇒ 渲染定义根带文档默认统计层
   *    ⇒ 侧栏来源徽标 = **文档默认**（契约 §9 三级配置第 1 级）；
   *  - **F2**：`EmbedViewport.vue` 已把该根字段传给 `BlockStatsSidebar` 的 `partIconTextures`
   *    prop ⇒ `BlockIconCache#setPartIconTextureSource` 接通嵌入纹理通道 ⇒ 部件行图标槽
   *    渲染出真实图标（不再恒走宿主调色板回退/占位）。
   *
   * 断言口径（正向）：
   *  ① 文件侧文档根字段在位（ground truth）；
   *  ② 运行时**渲染定义根**两字段可得的**值**与文件一致（不是"有个键就算过"）；
   *  ③ 徽标来源 = `document-default`；
   *  ④ **有纹理来源的部件行**（`iconKey` ∈ `partIconTextures` 键集）图标槽必须有 canvas
   *     —— 这是 F2 接线的生产可观测结果（`helpers/parts/statsSidebar.ts#waitStatsRowIcons`）。
   *     `iconKey` 不在纹理表里的行（实测 = FMP 的 `#mat=` 类型键与 `partIconTextures` 的
   *     物品身份键 `#<mat>` 拼写差异）走回退链，**不判红但如实登记**为 finding（见下方 payload）。
   */
  test('F1/F2 修复锁：文件带 statsTemplate/partIconTextures，真实导出链上二者均生效', async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop-chrome',
      '观测文件写入必须是单写者（幂等：运行目录产物字节一致），故只在 desktop 跑',
    )
    test.setTimeout(240_000)

    // ── 文件侧（ground truth）：两个文档根字段都在（P1.7 落盘正确）──
    expect(FULL.statsTemplate, '导出文件根带 statsTemplate（P1.7 落盘）').not.toBeNull()
    expect(FULL.partIconTextures, '导出文件根带 partIconTextures（P1.7 落盘）').not.toBeNull()
    const fileIconKeys = Object.keys(FULL.partIconTextures ?? {})
    expect(fileIconKeys.length, 'partIconTextures 键数 > 0').toBeGreaterThan(0)

    await gotoWikiPreviewWithScene(page, FULL.raw, REAL_EXPORT_FILES.full, { requireMesh: false })
    await waitStatsSidebarReady(page)
    const obs = await readDefinitionRootFields(page, WIKI_REGION)
    const s = await readStatsSidebarSettled(page)

    // ── F1：运行时定义根带着**同一份**文档默认统计层 → 徽标 = 文档默认 ──
    expect(obs.hasStatsTemplate, 'F1：真实导出经 StructureData 解析链后 statsTemplate 可得').toBe(true)
    expect(obs.statsTemplate, 'F1：定义根的 statsTemplate 与文件逐值一致').toEqual(FULL.statsTemplate)
    expect(s.pill, '含部件 ⇒ 配置来源徽标常驻').not.toBeNull()
    expect(
      s.pill!.source,
      `F1：徽标来源 = 文档默认（实际 ${s.pill!.source}/「${s.pill!.text}」；内建默认 ⇒ F1 未接通）`,
    ).toBe('document-default')

    // ── F2：定义根带部件图标纹理表，且**已被侧栏消费**（行图标槽真的出图）──
    expect(obs.hasPartIconTextures, 'F2：真实导出经解析链后 partIconTextures 可得').toBe(true)
    expect(obs.partIconTextureKeys, 'F2：定义根纹理键数 = 文件键数').toBe(fileIconKeys.length)

    const partRows = s.rows.filter((r) => r.kind === 'part')
    expect(partRows.length, '统计侧栏渲染出部件行').toBeGreaterThan(0)
    const coveredRows = partRows.filter((r) => r.iconKey !== null && fileIconKeys.includes(r.iconKey))
    expect(
      coveredRows.length,
      `F2：有嵌入纹理来源的部件行数 > 0（实际 ${coveredRows.length}/${partRows.length}）`,
    ).toBeGreaterThan(0)
    const icons = await waitStatsRowIcons(page, coveredRows.map((r) => r.iconKey!))
    const byIconKey = new Map(icons.map((r) => [r.iconKey, r]))
    const naked = coveredRows.filter((r) => byIconKey.get(r.iconKey!)?.hasCanvas !== true)
    expect(
      naked.map((r) => r.iconKey),
      'F2：有纹理来源的部件行必须全部渲染出图标 canvas（空槽 ⇒ 嵌入纹理通道未接通）',
    ).toEqual([])
    for (const r of coveredRows) {
      const got = byIconKey.get(r.iconKey!)!
      expect(got.canvasWidth, `${r.iconKey} 图标 canvas 宽 > 0`).toBeGreaterThan(0)
      expect(got.canvasHeight, `${r.iconKey} 图标 canvas 高 > 0`).toBeGreaterThan(0)
    }

    // ── 残留差异（如实登记，不判红）：行图标键不在纹理表里的部件行 ──
    // 它们只能走宿主调色板回退/占位。实测 = FMP 三行（行键/图标键 = `...#mat=<材料>`
    // vs `partIconTextures` 键 = 物品身份键 `...#<材料>`，mod 侧 `PartItem.iconKey()` 与
    // web 侧 `partStats` 主条目行键（= `part.typeKey`）在 FMP 上拼写不同）。
    const uncovered = partRows.filter((r) => r.iconKey === null || !fileIconKeys.includes(r.iconKey))
    const uncoveredKeys = uncovered.map((r) => r.iconKey ?? r.key ?? '?')
    const uncoveredFindings = uncoveredKeys.length > 0
      ? [{
          id: 'F2b',
          severity: 'deviation',
          title: '部件行图标键与 partIconTextures 键拼写不一致（FMP `#mat=` 段）',
          observed:
            `行图标键不在 ${REAL_EXPORT_FILES.full} 的 partIconTextures 键集里：${uncoveredKeys.join(', ')}` +
            `（${uncoveredKeys.length}/${partRows.length} 行）⇒ 这些行仍走宿主回退/占位`,
          expectedAfterFix:
            '统一"物品身份键"拼写：web 侧部件行 iconKey 取 partItemKey(items[0])（契约 §5 物品身份键），' +
            '或在导出侧让 typeKey 与 partIconTextures 键同形 —— 本包写范围外（web/src/pure/partStats.ts 未在修复写范围内），只登记',
          codeAnchor:
            'web/src/pure/partStats.ts#partItemContributions（主条目 rawKey = part.typeKey）vs ' +
            'mod PartItem.iconKey()（registry:damage#nbtDiscriminator）',
        }]
      : []

    // ── 观测落盘（供报告 findings 消费；无 timestamps ⇒ 幂等）──
    const payload = {
      schema: 'lightning.parts-l2-observations/1',
      archiveDir: archive.dir,
      archiveSource: archive.source,
      file: {
        statsTemplate: FULL.statsTemplate,
        partIconTextureKeys: fileIconKeys.length,
        statsOverride: (FULL.raw as Record<string, unknown>).statsOverride ?? null,
      },
      definitionRoot: obs,
      statsSidebarPill: s.pill,
      statsRows: s.rows.length,
      /** F2 消费证据：有纹理来源的部件行 → 图标槽 canvas 就位情况（生产 DOM）。 */
      partRowIcons: {
        partRows: partRows.length,
        coveredByPartIconTextures: coveredRows.length,
        renderedCanvas: coveredRows.filter((r) => byIconKey.get(r.iconKey!)?.hasCanvas === true).length,
        uncoveredIconKeys: uncoveredKeys,
      },
      /**
       * F1/F2 **已修复**（本锁已翻转为正向断言）⇒ 不再登记二者为偏差；
       * 仅保留修复过程中实测到的残留差异（F2b，若有）。
       */
      findings: uncoveredFindings,
    }
    const out = process.env.PARTS_L2_OBSERVATIONS_OUT
    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.writeFileSync(out, JSON.stringify(payload, null, 1) + '\n', 'utf8')
      console.log(`[P3.1-L2] 观测落盘：${out}`)
    }
    console.log(
      `[P3.1-L2] F1/F2 修复锁：file.statsTemplate=${JSON.stringify(FULL.statsTemplate)} / ` +
        `file.partIconTextures=${fileIconKeys.length} 键；definition.hasStatsTemplate=${obs.hasStatsTemplate} / ` +
        `definition.partIconTextures=${obs.hasPartIconTextures}；徽标=${s.pill?.text}/${s.pill?.source}；` +
        `图标 canvas ${payload.partRowIcons.renderedCanvas}/${coveredRows.length} 行（纹理表覆盖）；` +
        `无纹理来源 ${uncoveredKeys.length} 行：${uncoveredKeys.join(', ') || '<无>'}`,
    )
  })
})

// ===========================================================================
// D. 退化导出（degraded_all）
// ===========================================================================

test.describe('P3.1 · 退化导出（degraded_all）：档位标记 + 统计行', () => {
  test('degraded_all：全格落档 3 family=inferred，与退化 oracle 哨兵语义一致', async ({ page }) => {
    test.setTimeout(240_000)
    const errs = collectConsoleErrors(page)
    await gotoWikiPreviewWithScene(page, DEGRADED_ALL.raw, REAL_EXPORT_FILES.degradedAll)

    const mesh = await readContentMesh(page, WIKI_REGION)
    expect(mesh.present, '退化导出渲染出内容 mesh').toBe(true)
    expect(mesh.triangles, '退化导出三角形数 > 0').toBeGreaterThan(0)
    const fatal = errs.filter((e) => /DataCloneError|structuredClone|Maximum call stack/i.test(e))
    expect(fatal, `退化导出加载出现克隆级致命错误：\n${fatal.join('\n')}`).toEqual([])

    const cells = await readPartsObservation(page)
    const expected = cellsWithParts(ORACLE_DEGRADED_ALL)
    expect(cells.length, `退化档带部件格数 = 退化 oracle 带部件格数（${expected.length}）`).toBe(expected.length)

    const observedByPos = new Map(cells.map((c) => [`${c.pos.x},${c.pos.y},${c.pos.z}`, c]))
    let sentinelCells = 0
    let exactCells = 0
    let inferredParts = 0
    let fullCubeNone = 0
    for (const oc of ORACLE_DEGRADED_ALL.cells) {
      const g = gridIndexOf(oc)
      const idx = DEGRADED_ALL.cellPartsGrid?.[g.z]?.[g.row]?.[g.col]
      if (oc.expectFullCube) {
        fullCubeNone++
        expect(idx, `退化档满方块格（${oc.host}）必须 -1`).toBe(-1)
        continue
      }
      expect(idx, `退化档非满格（${oc.host}）必须挂部件池`).toBeGreaterThanOrEqual(0)
      const pagePos = gridApiPosOf(oc, ORACLE_DEGRADED_ALL.gridIndex.size)
      const key = `${pagePos.x},${pagePos.y},${pagePos.z}`
      const observed = observedByPos.get(key)
      expect(observed, `退化档解析出格 ${key}（zone=${oc.zone}）`).toBeTruthy()
      const gotParts = observed!.parts!
      expect(gotParts.length, `退化档格 ${key} 必须至少一个部件（档 3 永远有结果）`).toBeGreaterThan(0)

      // 哨兵语义（契约 §11 退化格）：`inferred:*` ⇒ 岛数/盒数/来源/逐岛 localId 是下游实现细节，
      // oracle 用哨兵（部件条数亦不可预测）；但**族/档位/fallback/typeKey/物品件数**必须精确。
      const sentinel = oc.parts.some((p) => p.localId === 'inferred:*')
      const oracleKeys = new Set(oc.parts.map((p) => p.typeKey))
      const oracleItemCounts = new Set(oc.parts.map((p) => p.itemCount))
      if (sentinel) {
        sentinelCells++
        for (const got of gotParts) {
          inferredParts++
          expect(oracleKeys.has(got.typeKey), `退化档 ${key} 部件 typeKey=${got.typeKey} 必须在 oracle 期望集`).toBe(true)
          expect(oracleItemCounts.has(got.itemCounts.reduce((a, b) => a + b, 0)), `退化档 ${key} 物品件数`).toBe(true)
          expect(got.source.tier, `退化档 ${key} 档位必为 3`).toBe(3)
          expect(got.source.family, `退化档 ${key} 族必为 inferred`).toBe('inferred')
          expect(got.source.fallback, `退化档 ${key} fallback=true`).toBe(true)
          expect(got.localId, `退化档 ${key} localId 为 inferred 岛`).toMatch(/^inferred:\d+$/)
        }
      } else {
        // 未变换格（本产物 = 火把格；`countsScope=untransformed-cells-only`）：逐条精确
        exactCells++
        expect(gotParts.length, `退化档未变换格 ${key} 部件数 = oracle`).toBe(oc.parts.length)
        const gotById = new Map(gotParts.map((p) => [p.localId, p]))
        for (const want of oc.parts) {
          const got = gotById.get(want.localId)
          expect(got, `退化档未变换格 ${key} 存在部件 ${want.localId}`).toBeTruthy()
          inferredParts++
          expect(got!.typeKey, `退化档 ${want.localId} typeKey`).toBe(want.typeKey)
          expect(got!.source.tier, `退化档 ${want.localId} 档位`).toBe(want.boxTier)
          expect(got!.source.family, `退化档 ${want.localId} 族`).toBe('inferred')
          expect(got!.source.fallback, `退化档 ${want.localId} fallback`).toBe(true)
          expect(got!.itemCounts.reduce((a, b) => a + b, 0), `退化档 ${want.localId} 物品件数`).toBe(want.itemCount)
          if (want.boxCount >= 0) expect(got!.boxCount, `退化档 ${want.localId} 盒数`).toBe(want.boxCount)
          if (want.boxProvenance !== '*') {
            expect(got!.source.boxProvenance, `退化档 ${want.localId} 盒来源`).toBe(want.boxProvenance)
          }
        }
      }
    }
    expect(sentinelCells, '退化档哨兵格数 > 0（族全关 ⇒ 落几何推断）').toBeGreaterThan(0)
    expect(exactCells, '退化档未变换格数 > 0（火把：全量档即 inferred）').toBeGreaterThan(0)
    expect(inferredParts, '退化档部件总数 > 0（全族关闭后仍永远有结果）').toBeGreaterThan(0)
    console.log(
      `[P3.1-L2] degraded_all：${sentinelCells} 哨兵格 + ${exactCells} 未变换格 / 共 ${inferredParts} 个部件` +
        `全为 tier=3/inferred（满方块格 ${fullCubeNone} 个仍 -1）`,
    )
  })

  test('degraded_all 统计：inferred 族部件行存在，且 countsScope 子集精确（torch 12 件）', async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop-chrome',
      '展开态侧栏交互在 mobile 窄布局自动折叠振荡（P2.5 实证登记）；仅 desktop 跑',
    )
    test.setTimeout(240_000)
    await gotoWikiPreviewWithScene(page, DEGRADED_ALL.raw, REAL_EXPORT_FILES.degradedAll, { requireMesh: false })
    await waitStatsSidebarReady(page)
    const s = await readStatsSidebarSettled(page)

    expect(ORACLE_DEGRADED_ALL.countsScope, '退化 oracle 口径 = untransformed-cells-only').toBe(
      'untransformed-cells-only',
    )
    expect(s.toolbar, '退化导出仍是含部件文档 ⇒ 部件模式工具条渲染').toBe(true)
    expect(s.rows.length, '退化档统计行非空（推断档部件进入清单）').toBeGreaterThan(0)
    for (const r of s.rows) {
      expect(r.kind, `退化档行 ${r.key} 仍是部件行`).toBe('part')
      expect(r.iconKey, `退化档行 ${r.key} 图标键 = 物品身份键`).toBe(r.key)
    }

    // 行集 = 文件里**有物品身份**的类型键（精确集合；itemless 部件走"未计入清单"提示行）
    // 注：必须按**格实例**展开（partLists 是池 + 跨格共享去重，契约 §2.1），
    // 否则 itemless 计数会少算共享池的多格引用（P3.1 实测：池条目 63 ≠ 实例 69）。
    const fileKeys = new Set<string>()
    const itemlessKeys = new Set<string>()
    let itemlessParts = 0
    for (let z = 0; z < (DEGRADED_ALL.cellPartsGrid?.length ?? 0); z++) {
      for (let row = 0; row < (DEGRADED_ALL.cellPartsGrid?.[z]?.length ?? 0); row++) {
        for (let col = 0; col < (DEGRADED_ALL.cellPartsGrid?.[z]?.[row]?.length ?? 0); col++) {
          for (const p of partsAtGrid(DEGRADED_ALL, { z, row, col })) {
            if (p.items.length === 0) {
              itemlessKeys.add(p.typeKey)
              itemlessParts++
            } else fileKeys.add(p.typeKey)
          }
        }
      }
    }
    expect(new Set(s.rows.map((r) => r.key!)), '退化档统计行集 = 文件里有物品身份的类型键集合').toEqual(fileKeys)
    expect(itemlessParts, '退化档存在无物品部件（AE2/FMP 宿主键 items:[] ⇒ 显式"无"）').toBeGreaterThan(0)
    expect(s.itemless, '「N 个无物品部件未计入清单」提示行呈现').not.toBeNull()
    expect(s.itemless!, '提示行数量 = 无物品部件实例数（含跨格共享池展开）').toContain(String(itemlessParts))

    // 子集精确比对（契约 §11：退化轮 expectedCounts 只覆盖未退化格 ⇒ 子集比对）
    expect(ORACLE_DEGRADED_ALL.expectedCounts.length, '退化 oracle 在册条目数 = 1（仅火把）').toBe(1)
    for (const e of ORACLE_DEGRADED_ALL.expectedCounts) {
      const row = s.rows.find((r) => r.key === e.typeKey)
      expect(row, `退化档在册行 ${e.typeKey} 存在`).toBeTruthy()
      expect(row!.qty, `退化档在册行 ${e.typeKey} 计数 = ${e.count}（未变换格精确）`).toBe(String(e.count))
    }
    // 行键必须全部来自退化 oracle 的 inferred 部件（无野键）
    const oracleKeys = new Set(
      cellsWithParts(ORACLE_DEGRADED_ALL).flatMap((c) => c.parts.map((p) => p.typeKey)),
    )
    const stray = s.rows.map((r) => r.key!).filter((k) => !oracleKeys.has(k))
    expect(stray, `退化档统计行必须全部来自退化 oracle 的 inferred 部件：${stray.join(', ')}`).toEqual([])
    console.log(
      `[P3.1-L2] degraded_all 统计：${s.rows.length} 行（全部 inferred 族）；` +
        `在册 torch 行 = ${s.rows.find((r) => r.key === 'minecraft:torch:0')!.qty}；` +
        `${itemlessParts} 个无物品部件未计入（提示行「${s.itemless}」）`,
    )
  })
})
