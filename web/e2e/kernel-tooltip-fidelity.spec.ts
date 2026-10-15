/**
 * M1 P3 · **两条定向数据保真判据**（P2 报告 §8 表 #3/#4）——本样本恰好**掩盖**它们。
 *
 * | # | 事实 | 本文件怎么判 |
 * |---|---|---|
 * | #3 | `tooltipPoolOf` 曾用**说明格包围盒**推 `height`，而装配侧（`kernelAssembly#tooltipContentOf`）用**声明的 `sizeRow`** 反解行号 ⇒ 只在"最高一行有说明"时相等 | P3F-2 造一份"注解**不**铺满最高行"的副本（程序化改造样本副本，落 `temp/`），验"保存 → 刷新 → 重开"后**逐格注解文本与所在格不变** |
 * | #4 | 保存投影的 `cellTooltipGrid` 列宽/深度按包围盒得出（本样本 16 vs `cellGrid` 声明 19） | P3F-1 记录真实样本的形状差异**并断言注解一格不丢、一格不移**；P3F-2 记录改造件的形状 |
 *
 * ## 两条路径都要判（同一产品的两条真实"保存 → 重开"）
 *
 * | 路径 | 保存 | 重开 |
 * |---|---|---|
 * | M1 的路径 | `File 菜单 → 保存工程` | `File 菜单 → 打开工程` |
 * | 另一条真实路径 | `File 菜单 → 保存到文件`（plain/信封） | `File 菜单 → 打开场景` |
 *
 * 判据用**内核世界坐标读面**（`ctx.kernelGrid(0).tooltipAt`，不做行翻转）：
 * 行翻转只存在于**文件形态**里，故它的错位恰好表现为"世界坐标搬了行"——
 * 这正是要抓的数据移动。
 *
 * ## 实测（本批，修复前 → 修复后）
 *
 * 改造件（清掉 `row 0` 的 1 处注解 ⇒ 注解覆盖 world y ∈ {0..4}，声明高 6）：
 *
 * ```
 * 修前：保存到文件产物 cellGrid 7x6x19 而 cellTooltipGrid 7x5x16
 *       → 重开后 17 个注解全部上移一行（y ∈ {1..5}，差异 28 条）
 * 修后：产物 cellTooltipGrid 7x6x19（= 声明）→ 重开后 17 个注解逐格不变（差异 0 条）
 * ```
 */

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { gotoWorkbench, waitForEvaluateReady, waitForViewportMounted } from './helpers/multiblock/harness'
import {
  annotatedCells,
  fixturePath,
  innerDocOf,
  isDirty,
  kernelAnnotations,
  openViaFileMenu,
  caseDir,
  readJson,
  saveViaFileMenu,
  structureSnapshot,
  withoutTopRowAnnotations,
  writeEnvelopeLike,
  type AnnotatedCell,
  type InnerDoc,
} from './helpers/saveReopen'

/** 注解期望集（世界坐标 → 文本）。 */
function expectedMap(cells: readonly AnnotatedCell[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of cells) out[`${c.kernel[0]},${c.kernel[1]},${c.kernel[2]}`] = c.expected
  return out
}

/** 双侧差异的可读清单（缺格 / 多格 / 文本不同）。 */
function diffOf(expected: Record<string, string>, got: Record<string, string>): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(expected)) if (got[k] !== v) out.push(`${k}: 期望「${v}」实得「${got[k] ?? '<缺>'}」`)
  for (const [k, v] of Object.entries(got)) if (!(k in expected)) out.push(`${k}: 期望 <无> 实得「${v}」`)
  return out
}

/** **文件形态**的产物：它的世界 y 由它**自己的 `cellGrid` 声明高**反解（消费者口径）。 */
function plainArtifactAnnotations(file: string): {
  shape: { grid: [number, number, number]; tooltip: [number, number, number] }
  cells: Record<string, string>
} {
  const plain = readJson(file)
  const grid = plain.cellGrid as number[][][]
  const tips = plain.cellTooltipGrid as number[][][] | undefined
  const palette = (plain.tooltipPalette ?? []) as string[]
  const shape = {
    grid: [grid.length, grid[0]!.length, grid[0]![0]!.length] as [number, number, number],
    tooltip: [tips?.length ?? 0, tips?.[0]?.length ?? 0, tips?.[0]?.[0]?.length ?? 0] as [number, number, number],
  }
  const cells: Record<string, string> = {}
  const height = shape.grid[1]
  for (let z = 0; z < (tips?.length ?? 0); z++) {
    for (let row = 0; row < tips![z]!.length; row++) {
      for (let col = 0; col < tips![z]![row]!.length; col++) {
        const idx = tips![z]![row]![col]!
        if (idx < 0) continue
        const text = palette[idx]
        if (typeof text === 'string' && text.length > 0) cells[`${col},${height - 1 - row},${z}`] = text
      }
    }
  }
  return { shape, cells }
}

async function loadFreshAndOpen(page: Page, file: string): Promise<void> {
  await gotoWorkbench(page)
  await page.waitForFunction(() => typeof (window as any).__p7_input__?.counters === 'function', undefined, { timeout: 30_000 })
  await openViaFileMenu(page, '打开场景', file)
  await waitForViewportMounted(page)
}

test.describe('M1 P3 定向数据保真：逐格说明的形状权威与注解所在格', () => {
  test('P3F-1 真实样本（#4）：保存投影的形状差异被记录，且注解**一格不丢、一格不移**', async ({ page }) => {
    test.setTimeout(300_000)
    const out = caseDir('p3f-1', test.info().project.name)
    const inputCopy = path.join(out, 'p3f1-input-copy.json')
    fs.copyFileSync(fixturePath(), inputCopy)
    const doc = innerDocOf(inputCopy)
    const cells = annotatedCells(doc)
    expect(cells.length, '前提：真实样本必须有逐格注解（否则本用例空转）').toBeGreaterThan(0)

    await loadFreshAndOpen(page, inputCopy)

    // ① 机器读面（内核世界坐标）：逐格与文件原件一致
    const ann = await kernelAnnotations(page)
    expect(diffOf(expectedMap(cells), ann.cells), '内核世界坐标读面上的逐格注解必须与文件原件逐格相同').toEqual([])

    // ② 保存投影（`plainForSave().plain`）的形状：#4 的机械读数
    const snap = await structureSnapshot(page)
    console.log(
      `[P3F-1] 形状：cellGrid=${snap.gridShape.join('x')} cellTooltipGrid=${snap.tooltipShape.join('x')}` +
        `（修前 cellTooltipGrid 的宽/深按说明格包围盒得出：本样本实测 16 宽 vs 声明 19）`,
    )
    expect(snap.tooltipShape, '说明网格必须与方块网格**同形**（#4：修前按包围盒缩水）').toEqual(snap.gridShape)
    // 注解的包围盒确实是"缩水"的（证明这条判据不是恒真：声明比包围盒大）
    const maxCol = Math.max(...cells.map((c) => c.fileIdx[2]))
    expect(maxCol + 1, '前提：本样本的注解确实**没铺满**最右列（否则 #4 无从观测）').toBeLessThan(snap.gridShape[2]!)
    await page.screenshot({ path: path.join(out, 'p3f1-real-sample.png') })
  })

  test('P3F-2 定向 #3：注解**不**铺满最高行的文档 —— 两条保存/重开路径重开后逐格注解不变', async ({ page }) => {
    test.setTimeout(420_000)
    const out = caseDir('p3f-2', test.info().project.name)
    // ── 造改造件：清掉最高行（row 0）的全部注解（程序化改造样本**副本**）──
    const craftedPath = path.join(out, 'p3f2-notoprow-envelope.json')
    const base = innerDocOf(fixturePath())
    const crafted = withoutTopRowAnnotations(base)
    expect(crafted.cleared, '前提：最高行必须**有**注解可清（否则改造无效、#3 未被触发）').toBeGreaterThan(0)
    writeEnvelopeLike(fixturePath(), crafted.doc as InnerDoc, craftedPath)
    const cells = annotatedCells(crafted.doc as InnerDoc)
    const expected = expectedMap(cells)
    const expectRows = [...new Set(cells.map((c) => c.kernel[1]))].sort((a, b) => a - b)
    expect(expectRows[expectRows.length - 1], '前提：改造后最高世界行（y=5）必须**没有**注解（#3 的触发条件）').toBeLessThan(
      (crafted.doc as InnerDoc).cellGrid[0]!.length - 1,
    )

    // ── (a) 装载改造件：装配侧按**声明 sizeRow** 反解 ⇒ 世界格必须与文件语义一致 ──
    await loadFreshAndOpen(page, craftedPath)
    const a = await kernelAnnotations(page)
    expect(diffOf(expected, a.cells), '(a) 装载后内核读面必须与文件语义逐格一致').toEqual([])
    expect(a.dims, '(a) 网格声明形状必须保留').toEqual([7, 6, 19])

    // ── (b) M1 的路径：保存工程 → 刷新 → 打开工程 ──
    const projPath = path.join(out, 'p3f2-saved-project.json')
    const proj = await saveViaFileMenu(page, '保存工程', projPath)
    await page.reload()
    await waitForEvaluateReady(page)
    await openViaFileMenu(page, '打开工程', projPath)
    await waitForViewportMounted(page)
    const b = await kernelAnnotations(page)
    expect(diffOf(expected, b.cells), '(b) **保存工程 → 重开**后逐格注解必须不变（所在格也不得变）').toEqual([])
    expect(await isDirty(page), '(b) 重开工程后必须干净').toBe(false)

    // ── (c) 另一条真实路径：保存到文件（plain）→ 刷新 → 打开场景 ──
    await page.reload()
    await waitForEvaluateReady(page)
    await openViaFileMenu(page, '打开场景', craftedPath)
    await waitForViewportMounted(page)
    const plainPath = path.join(out, 'p3f2-saved-plain.json')
    const plain = await saveViaFileMenu(page, '保存到文件', plainPath)
    const artifact = plainArtifactAnnotations(plainPath)
    console.log(
      `[P3F-2] plain 产物（${plain.bytes} B）形状：cellGrid=${artifact.shape.grid.join('x')} cellTooltipGrid=${artifact.shape.tooltip.join('x')}` +
        `（修前：7x5x16 —— 说明格包围盒生效，声明被丢）`,
    )
    expect(artifact.shape.tooltip, '(c) plain 产物的说明网格必须与 cellGrid 声明**同形**（#3/#4 的修法落点）').toEqual(
      artifact.shape.grid,
    )
    expect(diffOf(expected, artifact.cells), '(c) plain **产物文件**按消费者口径解出的逐格注解必须与输入一致').toEqual([])

    await page.reload()
    await waitForEvaluateReady(page)
    await openViaFileMenu(page, '打开场景', plainPath)
    await waitForViewportMounted(page)
    const c = await kernelAnnotations(page)
    expect(diffOf(expected, c.cells), '(c) **保存到文件 → 重开**后逐格注解必须不变（修前整体上移一行）').toEqual([])
    expect(c.dims, '(c) 重开后网格声明形状必须保留').toEqual([7, 6, 19])
    expect(Object.keys(c.cells).length, '(c) 注解格数不得丢').toBe(Object.keys(expected).length)
    await page.screenshot({ path: path.join(out, 'p3f2-crafted-after-reopen.png') })
  })
})
