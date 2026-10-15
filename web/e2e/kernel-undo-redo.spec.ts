/**
 * M1 P2 · **编辑与文档内撤销/重做**的真实入口回归（生产工作台 + 生产命令路径）。
 *
 * ## 为什么必须有一条走生产入口的判据（本批修的就是"接线从没接上"）
 *
 * 这条路径此前**零 e2e 覆盖**（`e2e/` 没有一条走真实入口的撤销/重做用例），
 * 而它整条是坏的。本文件逐条钉住本批实测出的四个缺陷：
 *
 * | 缺陷（M1 P2 运行期实测） | 表现 | 本文件怎么判红 |
 * |---|---|---|
 * | `inputSession.handleKey` 只在 `startsModal` 时才 `dispatch` | Ctrl+Z / Ctrl+Shift+Z / `g` **静默无效** | 断言内容真的回退 + 轨迹里 `edit.undo` 的 `dispatched === true` 且有 `source:'command'` 结算记录 |
 * | `workbench-rna` 读逐格说明漏行翻转 | 面板显示**镜像行**那一格的值（选中带注解的格却是空） | 期望值从**夹具原件**按文件索引算出，断言字段逐字等于它 |
 * | 结算后仍以留存草稿优先 | 撤销后 `data-input-display` 已回退而输入框不更新 | 同时断言输入框 `value` **与** `data-input-display` |
 * | 重聚焦控件沿用旧 `text`（结算后未对齐） | 编辑后再点回同一字段并失焦 ⇒ **用旧值提交**，把刚写的新值悄悄改回去 | P2-2 断言"一次撤销只退一步、两次撤销回到基线"（幽灵事务会让步数错位） |
 *
 * ## 入口与观测面（零替身）
 *
 * - 装载：`injectSceneDocumentOk` → 生产 `OPERATOR_OPEN_SCENE` + `File`（与拖放同一入口）；
 * - 选择：生产选择 API（`ctx.getSelection().select`，与 `operators/builtin/selectOperator`
 *   同一条路径）。**不用像素扫掠**：选择本身是 P1 的验收面，这里要固定的是
 *   "改哪一格"，用坐标选择才能在 mobile/desktop 两个 project 上都拿到同一格；
 * - 编辑：右栏生成式 Inspector 的 `input`（`data-property` 定位）→ `input` →
 *   `draft.commit` → 唯一写路由；
 * - 撤销/重做：**真实按键** `Control+z` / `Control+Shift+z`（唯一入口，见 `inputHotkeys`）；
 * - 移动/取消：**真实拖动**（`g` 激活移动工具后 drag）。
 *
 * ## 期望值来源
 *
 * 一份**真实游戏内导出**的信封（`structuredata-exported-envelope.json`，来源
 * `StructureDataExporter scan`）：面板显示的坐标是内核世界坐标 `(x, y, z)`，
 * 而文件的 `cellTooltipGrid` 是 `[z][row][col]` 且 `row 0 = 顶部`
 * ⇒ `row = sizeRow - 1 - y`。本文件用**同一条**换算从夹具取期望文本，
 * 所以"读面漏翻转"会让断言读到另一格的文本而判红（而不是恒绿）。
 */

import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { gotoWorkbench, injectSceneDocumentOk, VIEWPORT_CANVAS, waitForViewportMounted } from './helpers/multiblock/harness'

const FIXTURE = 'structuredata-exported-envelope.json'
const TOOLTIP_FIELD = 'lightning.block.tooltip'

interface P7TraceEntry {
  token: number
  source: string
  kind: string
  level: string | null
  receiver: string | null
  commandId: string | null
  reason: string
  startedModal: boolean
  /** `runtime/inputSession` 记录：该事件的意图**是否真的交给了分发**。 */
  dispatched?: boolean
}

interface UndoState {
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
}

declare global {
  interface Window {
    __p7_input__?: {
      counters(): Record<string, number>
      trace(): P7TraceEntry[]
      textFocus(): { controlId: string | null; composing: boolean } | null
    }
    __vm__?: any
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 夹具：真实信封 → 内层文档（逐格说明的**期望值来源**）
// ─────────────────────────────────────────────────────────────────────────────

interface InnerDoc {
  cellGrid: number[][][]
  cellTooltipGrid: number[][][]
  tooltipPalette: string[]
}

/** 解开信封（`gzip+base64`）拿到内层文档；非信封则原样当文档。 */
function innerDocOf(fixturePath: string): InnerDoc {
  const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Record<string, unknown>
  let doc = raw
  if (typeof raw.payload === 'string') {
    const bytes = zlib.gunzipSync(Buffer.from(raw.payload, 'base64'))
    doc = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
  }
  const grid = doc.cellGrid as number[][][] | undefined
  const tips = doc.cellTooltipGrid as number[][][] | undefined
  const palette = doc.tooltipPalette as string[] | undefined
  if (!Array.isArray(grid) || !Array.isArray(tips) || !Array.isArray(palette)) {
    throw new Error(`夹具缺少逐格说明三项（cellGrid/cellTooltipGrid/tooltipPalette）：${fixturePath}`)
  }
  return { cellGrid: grid, cellTooltipGrid: tips, tooltipPalette: palette }
}

/** 夹具里第一个**自带注解**的格：文件索引 `[z][row][col]` → 内核世界坐标 + 期望文本。 */
function firstAnnotatedCell(doc: InnerDoc): {
  kernel: [number, number, number]
  fileIdx: [number, number, number]
  expected: string
} {
  const sizeRow = doc.cellGrid[0]!.length
  for (let z = 0; z < doc.cellTooltipGrid.length; z++) {
    const slice = doc.cellTooltipGrid[z]!
    for (let row = 0; row < slice.length; row++) {
      const line = slice[row]!
      for (let col = 0; col < line.length; col++) {
        const idx = line[col]!
        if (idx < 0) continue
        const text = doc.tooltipPalette[idx]
        if (typeof text !== 'string' || text.length === 0) continue
        return { kernel: [col, sizeRow - 1 - row, z], fileIdx: [z, row, col], expected: text }
      }
    }
  }
  throw new Error('夹具里没有任何逐格注解 —— 本用例无法建立判据（不是"断言失败"）')
}

// ─────────────────────────────────────────────────────────────────────────────
// 观测与操作
// ─────────────────────────────────────────────────────────────────────────────

/** 右栏字段（生成式 Inspector）：值 + 权威显示值（`data-input-display`）。 */
async function fieldOf(page: Page, property: string): Promise<{ value: string; display: string } | null> {
  return await page.evaluate((prop) => {
    const el = document.querySelector(`[data-property="${prop}"] input`) as HTMLInputElement | null
    if (el === null) return null
    return { value: el.value, display: el.dataset.inputDisplay ?? '' }
  }, property)
}

/** 面板显示的选中坐标（内核世界坐标）。 */
async function selectedPos(page: Page): Promise<[number, number, number] | null> {
  const text = await page.evaluate(
    () => document.querySelector('[data-property="lightning.block.pos"] .ux-field-readonly')?.textContent?.trim() ?? null,
  )
  if (text === null) return null
  const parts = text.split(',').map((s) => Number(s.trim()))
  if (parts.length !== 3 || !parts.every((n) => Number.isFinite(n))) return null
  return [parts[0]!, parts[1]!, parts[2]!]
}

async function undoState(page: Page): Promise<UndoState> {
  return (await page.evaluate(() => window.__vm__.kernelUndoState())) as UndoState
}

/** 方块格签名（只取非空气下标；用来判"格被移动了 / 被还原了"）。 */
async function cellSignature(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const g = window.__vm__.plainForSave().plain.cellGrid as number[][][]
    const out: string[] = []
    for (let a = 0; a < g.length; a++) for (let b = 0; b < g[a].length; b++) for (let c = 0; c < g[a][b].length; c++) {
      const v = Number(g[a][b][c])
      if (v !== 0) out.push(`${a},${b},${c}=${v}`)
    }
    return out.join('|')
  })
}

/** 交草稿并**脱开文本控件**：焦点在文本控件里时 Ctrl+Z 走 `draft.undo`（A25 明文），不属于本判据。 */
async function commitAndBlur(page: Page, loc: Locator): Promise<void> {
  await loc.press('Tab')
  await page.waitForTimeout(500)
  await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    el?.blur?.()
  })
  await page.waitForTimeout(700)
  const focus = await page.evaluate(() => window.__p7_input__!.textFocus()?.controlId ?? null)
  expect(focus, 'Ctrl+Z 之前必须没有活动文本控件（否则撤销作用于草稿，不是文档历史）').toBeNull()
}

async function writeField(page: Page, property: string, value: string): Promise<void> {
  const loc = page.locator(`[data-property="${property}"] input`)
  await loc.click()
  await loc.fill(value)
  await commitAndBlur(page, loc)
}

async function pressUndo(page: Page): Promise<P7TraceEntry[]> {
  const n = await page.evaluate(() => window.__p7_input__!.trace().length)
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(1200)
  return await page.evaluate((k) => window.__p7_input__!.trace().slice(k), n)
}

async function pressRedo(page: Page): Promise<P7TraceEntry[]> {
  const n = await page.evaluate(() => window.__p7_input__!.trace().length)
  await page.keyboard.press('Control+Shift+z')
  await page.waitForTimeout(1200)
  return await page.evaluate((k) => window.__p7_input__!.trace().slice(k), n)
}

/**
 * 打开工作台、装载**真实信封**、用生产选择 API 选中夹具里第一个自带注解的格。
 *
 * `select()` 就是产品自己的选择入口（`operators/builtin/selectOperator` 亦经它），
 * 与"点画布拾取"落到同一份选中集；本用例不测拾取（那是 P1 的面），
 * 而要固定"改哪一格" ⇒ 用坐标选，才能在 mobile/desktop 上拿到同一格。
 */
async function gotoWithAnnotatedCellSelected(
  page: Page,
): Promise<{ expected: string; kernel: [number, number, number]; sizeRow: number }> {
  const fixturePath = path.join(import.meta.dirname, 'fixtures', FIXTURE)
  const json = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Record<string, unknown>
  const doc = innerDocOf(fixturePath)
  const target = firstAnnotatedCell(doc)

  await gotoWorkbench(page)
  await page.waitForFunction(() => typeof window.__p7_input__?.counters === 'function', undefined, { timeout: 30_000 })
  await injectSceneDocumentOk(page, json, FIXTURE)
  await waitForViewportMounted(page)

  // 生产选择入口：按内核世界坐标选中该格（方块身份取自同一格的调色板下标）。
  await page.evaluate((cell: { x: number; y: number; z: number; fileIdx: [number, number, number] }) => {
    const vm = window.__vm__
    const p = vm.plainForSave().plain
    const [fz, frow, fcol] = cell.fileIdx
    const entry = p.blockPalette[Number(p.cellGrid[fz]?.[frow]?.[fcol] ?? 0)]
    vm.getSelection().select({ pos: { x: cell.x, y: cell.y, z: cell.z }, block_state_id: String(entry?.registryId ?? '') })
  }, { x: target.kernel[0], y: target.kernel[1], z: target.kernel[2], fileIdx: target.fileIdx })

  await expect
    .poll(async () => await selectedPos(page), { message: '生产选择 API 必须让右栏显示坐标（否则面板无目标）' })
    .not.toBeNull()
  expect(await selectedPos(page), '选中的必须正是夹具里那一格').toEqual(target.kernel)
  return { expected: target.expected, kernel: target.kernel, sizeRow: doc.cellGrid[0]!.length }
}

/** 断言一次撤销/重做**真的走到了分发**（本批缺陷的直接判据）。 */
function expectDispatchedToCommand(trace: P7TraceEntry[], commandId: 'edit.undo' | 'edit.redo', keys: string): void {
  const keyEntry = trace.find((e) => e.source === 'key' && e.kind === 'keydown' && e.commandId === commandId)
  expect(keyEntry, `Ctrl+${keys} 必须产出一条 ${commandId} 意图（路由层）`).toBeTruthy()
  expect(keyEntry!.level, `${commandId} 属于应用层快捷键`).toBe('app')
  expect(
    keyEntry!.dispatched,
    `⚠️ ${commandId} 的意图必须**真的交给分发**：本批缺陷正是"意图产出后被丢弃"（轨迹只有 commandId、没有 command 记录）`,
  ).toBe(true)
  const commandEntry = trace.find((e) => e.source === 'command' && e.commandId === commandId)
  expect(commandEntry, `${commandId} 必须有 source: "command" 的分发结果记录`).toBeTruthy()
  expect(commandEntry!.reason, '分发必须结算（不是"接下了但永不结算"）').toContain('dispatched:')
}

// ─────────────────────────────────────────────────────────────────────────────
// 用例
// ─────────────────────────────────────────────────────────────────────────────

test.describe('M1 P2 编辑与撤销/重做：真实工作台入口', () => {
  test('P2-1 改既有注解 → Ctrl+Z 回旧值 → Ctrl+Shift+Z 重现（含"意图真的到达分发"）', async ({ page }) => {
    test.setTimeout(180_000)
    const cell = await gotoWithAnnotatedCellSelected(page)

    const before = await fieldOf(page, TOOLTIP_FIELD)
    expect(before, '选中方块后右栏必须有 Tooltip 字段').not.toBeNull()
    // 读面判据：期望值来自**夹具原件**（面板坐标 → 文件 [z][row][col]）。
    // 漏行翻转时这里会读到**镜像行**那一格的文本（或空串）⇒ 判红。
    expect(before!.value, `面板坐标 ${cell.kernel.join(',')} 对应的格必须有夹具里的注解文本`).toBe(cell.expected)
    expect(before!.display, '权威显示值（data-input-display）必须与输入框一致').toBe(cell.expected)
    expect((await undoState(page)).canUndo, '装载后不应有可撤销的编辑').toBe(false)

    const NEW = 'P2-1 注解（e2e）'
    await writeField(page, TOOLTIP_FIELD, NEW)
    expect((await fieldOf(page, TOOLTIP_FIELD))!.value, '提交后输入框必须显示新值').toBe(NEW)
    const s1 = await undoState(page)
    expect(s1.canUndo, '编辑必须进内核撤销栈（canUndo）').toBe(true)
    expect(s1.undoLabel, '撤销项必须指向被改的那一格（不是"某个匿名事务"）').toContain('cell tooltip @')

    // ── 撤销 ──
    const undoTrace = await pressUndo(page)
    expectDispatchedToCommand(undoTrace, 'edit.undo', 'z')
    const afterUndo = await fieldOf(page, TOOLTIP_FIELD)
    expect(afterUndo!.value, '撤销后输入框必须回到**旧值**（本批两处缺陷都会让这里停在 NEW）').toBe(cell.expected)
    expect(afterUndo!.display, '撤销后权威显示值也必须回到旧值（"画面与状态一致"）').toBe(cell.expected)
    const s2 = await undoState(page)
    expect(s2.canUndo, '撤销到装载基线后栈应空').toBe(false)
    expect(s2.canRedo, '撤销后必须可重做').toBe(true)

    // ── 重做 ──
    const redoTrace = await pressRedo(page)
    expectDispatchedToCommand(redoTrace, 'edit.redo', 'Shift+z')
    const afterRedo = await fieldOf(page, TOOLTIP_FIELD)
    expect(afterRedo!.value, '重做后必须重现新值').toBe(NEW)
    expect(afterRedo!.display, '重做后权威显示值必须重现新值').toBe(NEW)
    expect((await undoState(page)).canRedo, '重做到栈顶后 redo 栈应空').toBe(false)

    await page.screenshot({ path: 'e2e/screenshots/p2/p2-1-undo-redo.png' })
  })

  test('P2-2 两步编辑逐步撤销/重做：无多撤少撤；栈空不回落旧栈', async ({ page }) => {
    test.setTimeout(180_000)
    const cell = await gotoWithAnnotatedCellSelected(page)

    const A = 'P2-2-A'
    const B = 'P2-2-B'
    await writeField(page, TOOLTIP_FIELD, A)
    await writeField(page, TOOLTIP_FIELD, B)
    expect(
      (await fieldOf(page, TOOLTIP_FIELD))!.value,
      '最后一次编辑必须留在文档里（不得被上一次留下的残留草稿改回去）',
    ).toBe(B)

    // ① 一次撤销必须回到 A（不是回到基线 —— 那就说明一次编辑记了多条历史）
    await pressUndo(page)
    expect((await fieldOf(page, TOOLTIP_FIELD))!.value, '一次撤销只应退一步（不得留下"幽灵事务"）').toBe(A)
    // ② 再一次撤销回到夹具原文
    await pressUndo(page)
    expect((await fieldOf(page, TOOLTIP_FIELD))!.value, '第二次撤销回到装载基线').toBe(cell.expected)

    // ③ 栈空后再撤销：语义是"内核已生效、不回落旧栈"（`submitKernelUndoRedo` 明文）
    const emptyBefore = await undoState(page)
    const trace3 = await pressUndo(page)
    expectDispatchedToCommand(trace3, 'edit.undo', 'z')
    expect(await undoState(page), '栈空时按 Ctrl+Z 不得改变栈状态（不得回落旧栈）').toEqual(emptyBefore)
    expect((await fieldOf(page, TOOLTIP_FIELD))!.value, '栈空时按 Ctrl+Z 不得改内容').toBe(cell.expected)

    // ④ 逐步重做：A → B
    await pressRedo(page)
    expect((await fieldOf(page, TOOLTIP_FIELD))!.value, '重做第一步回到 A').toBe(A)
    await pressRedo(page)
    expect((await fieldOf(page, TOOLTIP_FIELD))!.value, '重做第二步回到 B').toBe(B)
    await page.screenshot({ path: 'e2e/screenshots/p2/p2-2-stepwise.png' })
  })

  test('P2-3 `g` 可达：Area 快捷键真的经 dispatch 激活移动工具', async ({ page }) => {
    test.setTimeout(180_000)
    await gotoWithAnnotatedCellSelected(page)

    // `g` 是 **Area 快捷键**（`local.g`）：修复前它与 Ctrl+Z 同族，**整条都不分发**
    await page.keyboard.press('g')
    await page.waitForTimeout(1200)
    const tool = await page.evaluate(() => window.__vm__.getToolRegistry().activeTool.value?.id ?? null)
    expect(tool, '`g` 必须真的激活移动工具（Area 快捷键也要经 dispatch）').toBe('move')
    await expect(
      page.locator('.pt-tab', { hasText: '变换' }).first(),
      '移动工具下必须出现「变换」面板（其 poll 以 activeTool === "move" 为条件）',
    ).toBeVisible()
    await page.screenshot({ path: 'e2e/screenshots/p2/p2-3-g-tool.png' })
  })

  test('P2-4 拖动移动进撤销栈；拖动中取消不留痕', async ({ page }) => {
    test.setTimeout(240_000)
    // 本判据固定在桌面 project：移动依赖"空白处 pointerdown → 自由移动"，而
    // mobile 模拟（`devices['Pixel 5']`，hasTouch/isMobile）下同样的 mouse 拖动
    // **未触发任何移动**（P2 报告登记为"未定位"项，不是本用例的结论）。
    // 「`g` 可达」已由 P2-3 在两个 project 上覆盖。
    test.skip(
      test.info().project.name !== 'desktop-chrome',
      '移动拖动判据固定在 desktop-chrome（mobile 模拟下未触发，另登记为未定位项）',
    )
    await gotoWithAnnotatedCellSelected(page)
    const baselineCells = await cellSignature(page)
    await page.keyboard.press('g')
    await page.waitForTimeout(1000)

    // ── 拖动移动：真实 pointerdown/move/up（空白处 = 自由移动）──
    const canvas = page.locator(VIEWPORT_CANVAS).first()
    const box = (await canvas.boundingBox())!
    const candidate = [
      { x: box.x + 12, y: box.y + box.height - 12 },
      { x: box.x + 12, y: box.y + 12 },
      { x: box.x + box.width - 12, y: box.y + 12 },
      { x: box.x + 12, y: box.y + box.height / 2 },
    ]
    let moved = false
    for (const p of candidate) {
      await page.mouse.move(p.x, p.y)
      await page.mouse.down()
      await page.mouse.move(p.x + 90, p.y, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(2000)
      const st = await undoState(page)
      if (typeof st.undoLabel === 'string' && st.undoLabel.startsWith('move cells')) {
        moved = true
        break
      }
    }
    expect(moved, '移动必须作为**一条**内核事务进撤销栈（撤销项以 `move cells` 开头）').toBe(true)
    expect(await cellSignature(page), '移动后格分布必须变化').not.toBe(baselineCells)

    // 撤销移动 ⇒ 格分布还原
    await pressUndo(page)
    expect(await cellSignature(page), '撤销移动必须把格分布还原（无多撤/少撤）').toBe(baselineCells)

    // ── 取消不留痕：拖动**中**按 Escape（Escape 必须真的取消，否则 110px 拖动会留下修改）──
    const beforeCancel = await undoState(page)
    const cellsBeforeCancel = await cellSignature(page)
    await page.keyboard.press('g')
    await page.waitForTimeout(700)
    const p0 = candidate[0]!
    await page.mouse.move(p0.x, p0.y)
    await page.mouse.down()
    await page.mouse.move(p0.x + 110, p0.y, { steps: 8 })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
    await page.mouse.up()
    await page.waitForTimeout(1800)
    expect(await undoState(page), '取消（Escape）不得多出一条可撤销的修改').toEqual(beforeCancel)
    expect(await cellSignature(page), '取消必须保持取消前的内容（不留痕）').toBe(cellsBeforeCancel)
    await page.screenshot({ path: 'e2e/screenshots/p2/p2-4-move-cancel.png' })
  })
})
