/**
 * M8-5 · **D3：装载失败不换掉当前有效文档**（SPEC §9:299 / §10.7:309；S0-B D3）
 *
 * ## 判据要钉的语义
 *
 * 一次**失败的打开**（输入解析不出文档）只允许影响"这次输入"的结算：
 * 当前有效文档、画面、选择必须原样保留，且用户看到成句的后果说明。
 * 旧形态是 `setDocument(null)` + 清 `embedInitialView` + 重置全部机位 +
 * 绑定置 empty/null ⇒ 正在编辑的内容（含未保存修改）与选择一起消失，
 * 且没有回退路径（`workbench/document/pipeline.ts:86-99`、
 * `operators/builtin/docLifecycleOperators.ts:189-194`）。
 *
 * ## 判据面（全部生产读面）
 *
 * | 读数 | 来源 |
 * |---|---|
 * | 当前是否有文档 | `__vm__.hasLoadedDocument()` |
 * | 内容是否**逐字节**未变 | `__vm__.plainForSave().plain` 的 sha256（页面内算） |
 * | 选择是否保留 | `__vm__.getSelection().items/active` |
 * | 画面是否还在 | `.vc-viewport` 计数 + 呈现会话挂载批次数 |
 * | 用户看到什么 | `ctx.log.recent(ERROR)` 的最后一条（人读面） |
 *
 * ## 反假绿（本文件自带负对照）
 *
 * 第二条用例把**同一份坏输入**送进一份**空**工作台 ⇒ 必须 `hasLoadedDocument()===false`：
 * 它证明"坏输入真的解析不出文档"（否则第一条的"文档还在"可能是空转 —— 输入其实没坏）。
 */

import { expect, test } from '@playwright/test'

import { gotoWorkbench, injectSceneDocumentOk, waitForViewportMounted } from './helpers/multiblock'
import { TOOLTIP_FIELD, fixturePath, readJson } from './helpers/saveReopen'
import { readDiagnostics, readViewportFacts, selectFirstAnnotatedCell } from './helpers/m8/faults'
import { LOG_LEVEL_ERROR } from './helpers/m8/levels'

const FIXTURE = 'structuredata-exported-envelope.json'

/**
 * 一份**能解析成 JSON**但解析不出文档的输入（走生产算子 OPERATOR_OPEN_SCENE 的失败分支）。
 *
 * 为什么不用"坏 JSON 文本"：那条路径会在 `JSON.parse` 抛错（算子直接 throw，
 * 不进失败分支），判据会测到另一件事（异常传播），与 D3 的"装载失败"不是同一条路径。
 */
const UNPARSEABLE_DOC = { format: 'not-a-lightning-document', payload: null, formatVersion: 999 }

/** 注入一份**允许失败**的文档（不套 `injectSceneDocumentOk` 的"必须加载成功"断言）。 */
async function injectAllowingFailure(page: import('@playwright/test').Page, json: unknown): Promise<boolean> {
  return (await page.evaluate(async (text: string) => {
    const vm = (window as any).__vm__
    const file = new File([text], 'm8-d3-unparseable.json', { type: 'application/json' })
    try {
      await vm.getOperators().exec('OPERATOR_OPEN_SCENE', { file })
    } catch {
      // 生产算子在"JSON 解析失败"时会抛；本输入不应走到那里（见 UNPARSEABLE_DOC 的说明）。
      return false
    }
    return Boolean(vm.hasLoadedDocument())
  }, JSON.stringify(json))) as boolean
}

/** 内容摘要（页面内算 sha256；不把整份产物搬回 Node）。 */
async function contentDigest(page: import('@playwright/test').Page): Promise<string> {
  return (await page.evaluate(async () => {
    const vm = (window as any).__vm__
    const text = JSON.stringify(vm.plainForSave().plain)
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    return [...new Uint8Array(d)].map((v) => v.toString(16).padStart(2, '0')).join('')
  })) as string
}

/** 最后一条 error 级日志的文案（人读面；`ctx.log.recent` 是生产读面）。 */
async function lastErrorText(page: import('@playwright/test').Page): Promise<string> {
  return (await page.evaluate((mask: number) => {
    const vm = (window as any).__vm__
    const rows = vm?.log?.recent?.(mask, 5) ?? []
    const last = rows.at(-1) ?? null
    return last === null ? '' : String(last.message)
  }, LOG_LEVEL_ERROR)) as string
}

/**
 * 用**生产 UI 字段**改一格逐格说明（与 `kernel-viewport-host-lifetime` H1 同一条写路径：
 * 右栏 Tooltip 输入框 → Tab 提交 → blur）。
 *
 * 为什么不用 `exec('OPERATOR_TOOLTIP_EDIT')`：本用例要证的是"用户编辑过 ⇒ 失败打开不丢"，
 * 而用户走的就是这个字段（#301 P10f D0 的草稿提交）。用字段还能顺带证明"编辑真的生效"。
 */
async function editTooltipViaField(
  page: import('@playwright/test').Page,
  next: string,
  cellIndex: { fileIdx: readonly [number, number, number]; expected: string },
): Promise<void> {
  const loc = page.locator('[data-property="' + TOOLTIP_FIELD + '"] input')
  await expect(loc, '前提：选中带注解的格后右栏必须有 Tooltip 字段').toBeVisible({ timeout: 15_000 })
  await loc.click()
  await loc.fill(next)
  await loc.press('Tab')
  await page.waitForTimeout(500)
  await page.evaluate(() => {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
  })
  // 编辑**真的生效**（内核回读）——否则"内容还在"可能只是"从来没改过"
  await expect
    .poll(
      async () =>
        await page.evaluate((idx: readonly [number, number, number]) => {
          const p = (window as any).__vm__.plainForSave().plain
          const [z, row, col] = idx
          const slot = p.cellTooltipGrid?.[z]?.[row]?.[col]
          return slot === undefined || slot < 0 ? null : (p.tooltipPalette?.[slot] ?? null)
        }, cellIndex.fileIdx),
      { timeout: 15_000 },
    )
    .toBe(next)
}

test.describe('M8-5 · D3 装载失败保留当前有效文档', () => {
  test('D3-a 打开一份解析不出文档的输入 ⇒ 旧文档/内容/选择/画面全在，且成句提示', async ({ page }) => {
    test.setTimeout(420_000)
    await gotoWorkbench(page)
    await expect(page.locator('.sb-root')).toBeVisible()
    await injectSceneDocumentOk(page, readJson(fixturePath()), FIXTURE)
    // 视口宿主在 `loadStatus==='ok' && structureDefinition` 时挂载（异步落地）——
    // 这是"画面在"这条断言的前提，必须先等到它。
    await waitForViewportMounted(page)

    // ── 前提：把被测状态挪离默认值（有内容改动、有选择、画面在）──
    const cell = await selectFirstAnnotatedCell(page)
    const fileIdx = await page.evaluate((p: readonly [number, number, number]) => {
      const plain = (window as any).__vm__.plainForSave().plain
      const height = plain.cellGrid[0].length
      return [p[2], height - 1 - p[1], p[0]] as [number, number, number]
    }, cell.pos)
    await editTooltipViaField(page, 'M8-5 D3 探针', { fileIdx, expected: cell.text })

    // 画面批次是异步落地的（帧时钟驱动编译）⇒ 等它到非零（前提设置，不是观测）。
    await expect
      .poll(async () => (await readViewportFacts(page)).presenter.mountedBatches ?? 0, {
        timeout: 60_000,
        intervals: [200, 400, 800],
      })
      .toBeGreaterThan(0)
    const before = await readViewportFacts(page)
    expect(before.selection.items.length, '前提：必须已经有选择（否则"选择还在"无区分力）').toBeGreaterThan(0)
    expect(before.presenter.mountedBatches ?? 0, '前提：必须已经有画面批次').toBeGreaterThan(0)
    expect(before.dom.viewportCount, '前提：编辑之后视口必须仍在（#397 的既有判据）').toBeGreaterThan(0)
    const digestBefore = await contentDigest(page)

    // ── 注入一份**解析不出文档**的输入（生产算子，允许失败）──
    //
    // 打开算子对"有未保存修改"会先问一句（`confirmDirty`，生产行为；`gotoWorkbench`
    // 已挂"接受"的 dialog 处理器）。若它停在确认处没继续，第 ⑤ 条（成句提示）会红
    // —— 那条就是"本用例没有空转"的守卫。
    const loadedAfter = await injectAllowingFailure(page, UNPARSEABLE_DOC)
    await page.waitForTimeout(800)
    const after = await readViewportFacts(page)
    const digestAfter = await contentDigest(page)
    const errorText = await lastErrorText(page)
    console.log(
      '[D3-a] loadedAfter=' + loadedAfter + ' digestSame=' + (digestBefore === digestAfter) +
        ' selectionBefore=' + before.selection.items.length + ' selectionAfter=' + after.selection.items.length +
        ' mountedBefore=' + before.dom.viewportCount + ' mountedAfter=' + after.dom.viewportCount +
        ' batchesBefore=' + String(before.presenter.mountedBatches) + ' batchesAfter=' + String(after.presenter.mountedBatches) +
        ' error=' + JSON.stringify(errorText),
    )

    // ① 文档仍在（旧形态：false）
    expect(loadedAfter, '⚠️ D3：装载失败**不得**把当前文档换成 null').toBe(true)
    // ② 内容逐字节未变（含刚才那次编辑）
    expect(digestAfter, '⚠️ D3：装载失败不得改动当前有效内容').toBe(digestBefore)
    // ③ 选择仍在
    expect(after.selection.items, '⚠️ D3：装载失败不得清掉选择').toEqual(before.selection.items)
    // ④ 画面仍在（视口与批次都没有被拿掉）
    expect(after.dom.viewportCount, '⚠️ D3：装载失败不得让视口消失').toBeGreaterThan(0)
    expect(after.presenter.mountedBatches ?? 0, '⚠️ D3：画面批次必须仍在').toBeGreaterThan(0)
    // ⑤ 用户看到成句后果说明（§10.7:309）
    expect(errorText, '⚠️ D3：失败必须成句说明实际后果（当前场景保持不变）').toContain('当前场景保持不变')
  })

  test('D3-b 负对照：同一份坏输入送进**空**工作台 ⇒ 确实不产生文档（证明输入真的坏、上一条不是空转）', async ({ page }) => {
    test.setTimeout(300_000)
    await gotoWorkbench(page)
    await expect(page.locator('.sb-root')).toBeVisible()
    const loaded = await injectAllowingFailure(page, UNPARSEABLE_DOC)
    await page.waitForTimeout(500)
    const diagnostics = await readDiagnostics(page)
    console.log('[D3-b] loaded=' + loaded + ' codes=' + JSON.stringify([...new Set(diagnostics.map((d) => d.code))]))
    expect(loaded, '负对照：这份输入确实解析不出文档（否则 D3-a 的"文档还在"没有区分力）').toBe(false)
  })
})
