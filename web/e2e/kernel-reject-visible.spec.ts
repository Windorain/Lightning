/**
 * M4-3 · **编辑被拒必须可见**（字段级 + 底栏成句原因；SPEC §309 与 §7.2/§8）。
 *
 * ## 缺陷形态（S0 域 2）
 *
 * 内核早就会**具名拒绝**（identity-not-in-palette / outsideDeclaredGrid / …），但用户看不到：
 *  - 面板的 `.ux-field-problem` 只接"无草稿控件"的提交回执，而**方块标识是文本控件**，
 *    走输入端口提交 ⇒ 拒绝只进 inputSession 的 trace（容量 256、无 UI 消费者）；
 *  - moveTranslate 的 `if(applied)` 没有 else ⇒ 越界拖动表现为"拖了没动"，连"为什么"都没有。
 *
 * ## 本 spec 证什么（两条真入口 + 各自的负对照）
 *
 * | 用例 | 正对照（拒绝可见） | 负对照（不得恒亮） |
 * |---|---|---|
 * | R1 字段级 | 方块标识写一个调色板里没有的值 ⇒ 该字段出现 rejected 提示，底栏出现**成句**原因，字段值回落原值，内容未变 | 随后一次**合法**的逐格说明写入 ⇒ 无提示、无拒绝文案，内容真的变了 |
 * | R2 移动 | 生产移动算子提交一次**越界**移动 ⇒ 底栏出现「移动被拒」成句原因，选择集不变、内容未变 | 一次**合法**的小幅移动 ⇒ 内容变了且底栏没有「移动被拒」 |
 *
 * ## 观测面（零替身）
 *
 * - 字段与提示：真实 DOM（[data-property]、.ux-field-problem、data-input-display）；
 * - 底栏：StatusBar 的 [data-live-origin="rejection"]（M4-3 新增的机器可读渠道）；
 * - 内容/选择：window.__vm__ 的公开读面（plainForSave() / getSelection()），与 kernel-move-persist 同一口径；
 * - 移动走**生产算子链**：`g` → 真实 pointer 拖拽 → submitContentEditSettlement。
 */

import { expect, test, type Page } from '@playwright/test'
import {
  gotoWorkbench,
  injectSceneDocumentOk,
  VIEWPORT_CANVAS,
  waitForViewportMounted,
} from './helpers/multiblock/harness'
import {
  fieldOf,
  fixturePath,
  innerDocOf,
  firstAnnotatedCell,
  kernelAnnotations,
  readJson,
  selectCell,
} from './helpers/saveReopen'

const FIXTURE = 'structuredata-exported-envelope.json'
/** 字段级拒绝提示（PropertyField.vue）。 */
const PROBLEM = '.ux-field-problem'
/** 底栏的**拒绝**渠道（区别于纹理五态的 origin='texture'）。 */
const REJECTION_SLOT = '.sb-root [data-live-origin="rejection"]'
/** 方块标识字段（文本控件 → 走输入端口 → 正是 S0 域 2 的断链处）。 */
const ID_FIELD = 'lightning.block.id'
const TOOLTIP_FIELD = 'lightning.block.tooltip'

/** 归一：空白与换行（铁律 6：文本判据不得依赖换行口径）。 */
function norm(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim()
}

/** 内核逐格内容（世界坐标口径；与 kernel-move-persist 同一实现口径）。 */
async function cellsByWorld(page: Page): Promise<Record<string, string>> {
  return (await page.evaluate(() => {
    const p = (window as any).__vm__.plainForSave().plain
    const grid = p.cellGrid as number[][][]
    const palette = (p.blockPalette ?? []) as { registryId?: string; meta?: number }[]
    const h = grid[0]?.length ?? 0
    const out: Record<string, string> = {}
    for (let z = 0; z < grid.length; z++) {
      for (let row = 0; row < grid[z]!.length; row++) {
        for (let col = 0; col < grid[z]![row]!.length; col++) {
          const slot = Number(grid[z]![row]![col])
          if (slot === 0) continue
          const entry = palette[slot]
          const key = col + ',' + (h - 1 - row) + ',' + z
          out[key] = entry ? String(entry.registryId) + ':' + String(entry.meta ?? 0) : 'slot:' + String(slot)
        }
      }
    }
    return out
  })) as Record<string, string>
}

/** 选择集（世界坐标，方块项）。 */
async function selectedPositions(page: Page): Promise<string[]> {
  return (await page.evaluate(() => {
    const sel = (window as any).__vm__.getSelection()
    return [...sel.items.value]
      .filter((e: any) => e.kind === 'block')
      .map((e: any) => e.ref.pos.x + ',' + e.ref.pos.y + ',' + e.ref.pos.z)
  })) as string[]
}

/** 底栏的拒绝文案（无则空串）。 */
async function rejectionText(page: Page): Promise<string> {
  if ((await page.locator(REJECTION_SLOT).count()) === 0) return ''
  return norm(await page.locator(REJECTION_SLOT).first().innerText())
}

/** 某字段的提示元素（文本 + 机器可读的 problem 类别）。 */
async function fieldProblem(page: Page, property: string): Promise<{ text: string; kind: string | null } | null> {
  const el = page.locator('[data-property="' + property + '"] ' + PROBLEM)
  if ((await el.count()) === 0) return null
  return { text: norm(await el.first().innerText()), kind: await el.first().getAttribute('data-problem') }
}

/** 生产入口：打开工作台 + 装载真实信封 + 等视口挂载。 */
async function openWorkbench(page: Page): Promise<void> {
  await gotoWorkbench(page)
  await injectSceneDocumentOk(page, readJson(fixturePath()), FIXTURE)
  await waitForViewportMounted(page)
  await expect(page.locator(VIEWPORT_CANVAS).first()).toBeVisible()
}

test.describe('M4-3 编辑被拒可见（字段级 + 底栏成句原因）', () => {
  test('R1 方块标识拒写：字段级 rejected + 底栏成句原因 + 值回落 + 内容未变；合法逐格说明编辑无拒绝', async ({
    page,
  }) => {
    test.setTimeout(300_000)
    test.skip(test.info().project.name !== 'desktop-chrome', '右栏字段与底栏判据固定在 desktop-chrome')

    const doc = innerDocOf(fixturePath())
    const target = firstAnnotatedCell(doc)

    await openWorkbench(page)
    await selectCell(page, target.kernel, target.fileIdx)

    // 前提：字段真的渲染了（否则下面的断言会空转）
    await expect(page.locator('[data-property="' + ID_FIELD + '"]'), '前提：方块标识字段必须已渲染').toHaveCount(1)
    const before = await fieldOf(page, ID_FIELD)
    expect(before, '前提：字段读面可用').not.toBeNull()
    const originalDisplay = before!.display
    expect(originalDisplay.length, '前提：该格必须有方块标识（否则"回落原值"无从判定）').toBeGreaterThan(0)
    const cellsBefore = await cellsByWorld(page)
    expect(Object.keys(cellsBefore).length, '前提：样本必须有非空格').toBeGreaterThan(10)
    // 逐格说明是**另一张表**（cellContent，不在 cellGrid 里）⇒ 负对照要比这一份。
    const tipsBefore = (await kernelAnnotations(page)).cells

    // ── ① 写一个**调色板里没有**的标识（真实键入 + Enter，走输入端口 → 唯一写路由） ──
    const input = page.locator('[data-property="' + ID_FIELD + '"] input')
    await input.click()
    await input.fill('minecraft:not-in-this-palette:0')
    await page.keyboard.press('Enter')

    // ── ② 字段级可见：.ux-field-problem 出现且类别是 rejected ──
    await expect
      .poll(async () => (await fieldProblem(page, ID_FIELD))?.kind ?? null, {
        message: 'M4-3：文本控件的写入拒绝必须到达字段级提示（S0 域 2 ① 的断链处）',
        timeout: 20_000,
      })
      .toBe('rejected')
    const problem = (await fieldProblem(page, ID_FIELD))!
    expect(problem.text, '字段级提示必须是**成句原因**，不是裸错误码').toContain('调色板')
    expect(problem.text, '不得把错误码原样贴给用户').not.toContain('identity-not-in-palette')

    // ── ③ 底栏成句原因（渠道标为 rejection，与纹理五态分开） ──
    await expect
      .poll(async () => await rejectionText(page), {
        message: 'M4-3：被拒必须写底栏实时状态（否则用户只看到"输入了没反应"）',
        timeout: 20_000,
      })
      .toContain('方块标识写入被拒')
    expect(await rejectionText(page), '底栏原因必须说清**为什么**（调色板歧义/缺失）').toContain('调色板')

    // ── ④ 值回落 + 内容未变（拒绝的语义是"内容没变"，不得表现为成功） ──
    await expect
      .poll(async () => (await fieldOf(page, ID_FIELD))?.display ?? '', {
        message: 'M4-3：被拒后字段必须回落到文档里的原值（否则界面显示一个文档里不存在的值）',
        timeout: 10_000,
      })
      .toBe(originalDisplay)
    expect(
      await page.locator('[data-property="' + ID_FIELD + '"] input').inputValue(),
      '输入框也必须回落（不留"已被拒的草稿"）',
    ).toBe(originalDisplay)
    expect(JSON.stringify(await cellsByWorld(page)), '被拒的写入不得改变任何一格').toBe(JSON.stringify(cellsBefore))
    expect(JSON.stringify((await kernelAnnotations(page)).cells), '被拒的写入也不得改逐格说明').toBe(
      JSON.stringify(tipsBefore),
    )

    // ── ⑤ 负对照：一次**合法**的逐格说明写入 ⇒ 无提示、无拒绝文案、内容真的变了 ──
    const tooltip = page.locator('[data-property="' + TOOLTIP_FIELD + '"] input')
    await tooltip.click()
    await tooltip.fill('m4-3-legal-edit')
    await page.keyboard.press('Enter')
    await expect
      .poll(async () => (await fieldOf(page, TOOLTIP_FIELD))?.display ?? '', {
        message: '负对照前提：合法写入必须真的进文档（否则"无拒绝"可能是两边都没发生）',
        timeout: 15_000,
      })
      .toBe('m4-3-legal-edit')
    expect(await fieldProblem(page, TOOLTIP_FIELD), '合法写入不得留下提示').toBeNull()
    // 字段级回执是**按字段**的"上一次尝试"记录（设计简报 R2：成功提交或新草稿清**该字段**的记录），
    // 故另一字段成功不会清掉方块标识这一条。它必须仍然只是个**记录**：内容未被它改动。
    // （"同一字段成功即清"这条路径由 runtime/fieldRejections 的单测把守 —— 本夹具上
    //  任何标识写入都会被判调色板歧义，见 S0 域 2 ①，故 e2e 造不出成功写入。）
    expect(await fieldProblem(page, ID_FIELD), '字段级回执是按字段的记录，另一字段成功不覆盖它').not.toBeNull()
    await expect
      .poll(async () => await rejectionText(page), {
        message: 'M4-3：写成功必须让底栏离开拒绝文案（否则那条原因会被误读成当前事实）',
        timeout: 15_000,
      })
      .toBe('')
    const tipsAfter = (await kernelAnnotations(page)).cells
    const targetKey = target.kernel.join(',')
    expect(tipsAfter[targetKey], '负对照：合法写入必须真的改了**该格**的逐格说明').toBe('m4-3-legal-edit')
    expect(JSON.stringify(tipsAfter), '负对照：内容必须与拒绝前不同（否则"没有拒绝"可能是两边都没发生）').not.toBe(
      JSON.stringify(tipsBefore),
    )
    expect(JSON.stringify(await cellsByWorld(page)), '逐格说明写入不得改动方块内容').toBe(JSON.stringify(cellsBefore))
  })

  test('R2 越界移动：底栏成句原因 + 选择集不变 + 内容未变；合法小幅移动无拒绝文案', async ({ page }) => {
    test.setTimeout(300_000)
    test.skip(test.info().project.name !== 'desktop-chrome', '移动拖拽判据固定在 desktop-chrome')

    const doc = innerDocOf(fixturePath())
    const target = firstAnnotatedCell(doc)

    await openWorkbench(page)
    await selectCell(page, target.kernel, target.fileIdx)
    const cellsBefore = await cellsByWorld(page)
    const selectionBefore = await selectedPositions(page)
    expect(selectionBefore.length, '前提：必须先选中一格').toBe(1)

    // 拖动起点：画布上**未被覆盖层遮挡**的点（与 kernel-move-persist 同一手法）
    const probes = await page.evaluate(() => {
      const el = (window as any).__vm__.viewports.get('r-viewport').domElement.value as HTMLElement
      const r = el.getBoundingClientRect()
      const raw = [
        { x: r.x + r.width / 2, y: r.y + 10 },
        { x: r.x + 10, y: r.y + r.height / 2 },
        { x: r.x + 10, y: r.bottom - 10 },
        { x: r.right - 10, y: r.bottom - 10 },
      ]
      return raw.filter((p) => document.elementFromPoint(p.x, p.y) === el)
    })
    expect(probes.length, '前提：画布上必须有未被覆盖层遮挡的点').toBeGreaterThan(0)

    /** 一次真实拖拽（g 进入移动工具 → pointer 拖动 → 释放）。 */
    async function drag(p: { x: number; y: number }, dx: number): Promise<void> {
      await page.keyboard.press('g')
      await page.waitForTimeout(500)
      await page.mouse.move(p.x, p.y)
      await page.mouse.down()
      await page.mouse.move(p.x + dx, p.y, { steps: 10 })
      await page.mouse.up()
      await page.waitForTimeout(1200)
    }

    // ── ① 越界拖拽：位移按屏幕像素给，但网格只有 w×h×d ⇒ 必然越界 ──
    //
    // 像素→格的换算依赖机位与缩放，故不硬编码"多少像素 = 一格"：这里逐步放大位移，
    // 直到内核以 outsideDeclaredGrid **具名拒绝**为止，并在每一步核对"内容未变"。
    const tried: string[] = []
    let rejected = false
    for (const p of probes) {
      for (const dx of [600, 1200, 2400, 4000]) {
        await drag(p, dx)
        const text = await rejectionText(page)
        const cellsNow = await cellsByWorld(page)
        if (text.indexOf('移动被拒') >= 0) {
          tried.push('(' + p.x.toFixed(0) + ',' + p.y.toFixed(0) + ') dx=' + dx + ' → ' + text)
          rejected = true
          break
        }
        if (JSON.stringify(cellsNow) !== JSON.stringify(cellsBefore)) {
          // 这次真的移动了（没越界）⇒ 撤销回原状再换更大的位移（撤销也走生产入口）。
          tried.push('(' + p.x.toFixed(0) + ',' + p.y.toFixed(0) + ') dx=' + dx + ' → 已移动，撤销后重试')
          await page.keyboard.press('Escape')
          await page.waitForTimeout(200)
          await page.keyboard.press('Control+z')
          await page.waitForTimeout(900)
        } else {
          tried.push('(' + p.x.toFixed(0) + ',' + p.y.toFixed(0) + ') dx=' + dx + ' → 无变化且无文案')
        }
      }
      if (rejected) break
    }
    expect(rejected, 'M4-3：越界移动必须给出成句原因（不得"拖了没反应"）。已试：\n' + tried.join('\n')).toBe(true)

    // ── ② 拒绝的三个后果：原因说清、选择集不变、内容未变 ──
    const text = await rejectionText(page)
    expect(text, '底栏原因必须点名"移动被拒"').toContain('移动被拒')
    expect(text, '底栏原因必须说清**为什么**（超出声明网格）').toContain('超出声明网格')
    expect(await selectedPositions(page), '被拒的移动不得平移选择集（内容没变，选择也不能变）').toEqual(selectionBefore)
    expect(JSON.stringify(await cellsByWorld(page)), '被拒的移动不得改变任何一格').toBe(JSON.stringify(cellsBefore))

    // ── ③ 负对照：一次**合法**的小幅移动 ⇒ 内容真的变了，且没有「移动被拒」 ──
    let moved = false
    for (const p of probes) {
      for (const dx of [60, -60, 40]) {
        await drag(p, dx)
        if (JSON.stringify(await cellsByWorld(page)) !== JSON.stringify(cellsBefore)) {
          moved = true
          break
        }
        await page.keyboard.press('Escape')
        await page.waitForTimeout(200)
      }
      if (moved) break
    }
    expect(moved, '负对照前提：小幅拖动必须真的改内容（否则"没有拒绝文案"可能两边都没发生）').toBe(true)
    expect(await rejectionText(page), '合法移动不得出现「移动被拒」文案').not.toContain('移动被拒')
  })
})
