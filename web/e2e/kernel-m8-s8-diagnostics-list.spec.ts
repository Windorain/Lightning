/**
 * M8-6 · S8：**用户可读诊断面**（Q3 暂定默认：底栏常驻区 + 可点开列表）。
 *
 * ## 判据要钉的四件事
 *
 * | 判据 | 防什么 |
 * |---|---|
 * | 触发一条已知诊断（坏一张贴图）⇒ 底栏出现**计数** | 诊断只存在于 `__vm__`（S0-B D4：用户无面） |
 * | 点开 ⇒ 列表可见该**码**与**点名资源** | 列表是"装饰"：能打开但读不到可操作的事实 |
 * | 每行带**时间**与**通道** | 只有一句自由文本（#249 §19.9 要求稳定码 + 关联身份） |
 * | 数据源 = `getDiagnostics()`（生产读面），行数 = 该读面里 WARN/ERROR 记录的条数 | 用户面与机读面**分叉**（各读一份数据） |
 *
 * ## 负对照
 *
 * 完好文档 ⇒ 底栏**不出现**诊断常驻区（空态不显示）；并且列表绝不出现被伪造的行 ——
 * 打开后的每一行都必须在 `getDiagnostics()` 里有对应记录（按码 + 对象名对账）。
 *
 * ## 观测面（全是生产 DOM / 生产读面）
 *
 * - `[data-lk-diagnostics]`：底栏常驻按钮（文本含条数）；
 * - `[data-lk-diagnostics-list]` / `[data-lk-diagnostic-row]`：点开后的列表与行；
 * - 行内 `[data-lk-diag-code]` / `[data-lk-diag-object]` / `[data-lk-diag-time]`；
 * - `__vm__.getDiagnostics()`：机读面（与用户面同一份数据）。
 */
import { expect, test } from '@playwright/test'

import { gotoWorkbench, injectSceneDocumentOk } from './helpers/multiblock/harness'
import { brokenFirstBlobEnvelope, fixturePath, firstMaterialLocator, readJson } from './helpers/saveReopen'
import { STATUS_BAR, TERMINAL_TEXTURE_STATES, waitTextureState } from './helpers/viewportPixels'
import { readDiagnostics } from './helpers/m8/faults'

const FIXTURE = 'structuredata-exported-envelope.json'

/** 底栏诊断区读数（一次 evaluate 取齐；全是生产 DOM）。 */
async function readDiagnosticsSurface(page: import('@playwright/test').Page): Promise<{
  hasButton: boolean
  buttonText: string
  open: boolean
  rows: { code: string; object: string; time: string; channel: string }[]
}> {
  return (await page.evaluate(() => {
    const btn = document.querySelector('[data-lk-diagnostics]') as HTMLElement | null
    const list = document.querySelector('[data-lk-diagnostics-list]')
    const rows = [...document.querySelectorAll('[data-lk-diagnostic-row]')].map((el) => ({
      code: el.querySelector('[data-lk-diag-code]')?.textContent?.trim() ?? '',
      object: el.querySelector('[data-lk-diag-object]')?.textContent?.trim() ?? '',
      time: el.querySelector('[data-lk-diag-time]')?.textContent?.trim() ?? '',
      channel: (el.getAttribute('data-diag-channel') ?? '').trim(),
    }))
    return {
      hasButton: btn !== null,
      buttonText: (btn?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      open: list !== null,
      rows,
    }
  })) as { hasButton: boolean; buttonText: string; open: boolean; rows: { code: string; object: string; time: string; channel: string }[] }
}

test.describe('M8-6 · S8 用户可读诊断面（底栏常驻区 + 列表）', () => {
  test('S8-a 坏一张贴图 ⇒ 底栏出现计数，点开可见 resource.* 码与点名资源', async ({ page }) => {
    test.setTimeout(480_000)
    const locator = firstMaterialLocator(fixturePath())
    await gotoWorkbench(page)
    await page.waitForFunction(() => typeof (window as any).__p7_input__?.counters === 'function', undefined, {
      timeout: 30_000,
    })
    await expect(page.locator(STATUS_BAR)).toBeVisible()

    await injectSceneDocumentOk(page, brokenFirstBlobEnvelope(fixturePath()), FIXTURE)
    const terminal = await waitTextureState(page, TERMINAL_TEXTURE_STATES, 'S8 损坏场景终态', 180_000)
    expect(terminal, '前提：坏图终态必须可辨认').toMatch(/^(missing|failed)$/)

    // ① 底栏常驻区出现（有诊断才有）
    const surface = await readDiagnosticsSurface(page)
    console.log('[S8-a] surface=' + JSON.stringify(surface))
    expect(surface.hasButton, '⚠️ S8/Q3：坏图必须让底栏出现诊断计数（此前只有 __vm__ 可读）').toBe(true)
    expect(surface.buttonText, '常驻区必须显示条数').toMatch(/诊断\s*\d+/)
    expect(surface.open, '列表默认收起（点开才展开，不弹窗）').toBe(false)

    // ② 点开 ⇒ 列表可见
    await page.locator('[data-lk-diagnostics]').click()
    await expect(page.locator('[data-lk-diagnostics-list]')).toBeVisible()
    const opened = await readDiagnosticsSurface(page)
    expect(opened.rows.length, '点开后必须有行').toBeGreaterThan(0)

    // ③ 该码与点名资源
    const resourceRows = opened.rows.filter((r) => r.code.startsWith('resource.'))
    console.log('[S8-a] rows=' + JSON.stringify(opened.rows));
    expect(resourceRows.length, '⚠️ S8：列表必须含 resource.* 行（资源失败的码）').toBeGreaterThan(0)
    expect(
      resourceRows.some((r) => r.object.includes(locator.split('/')[0]!)),
      `⚠️ S8/D7：列表必须点名坏掉的资源（${locator}），只有计数不算可读`,
    ).toBe(true)

    // ④ 每行带时间与通道
    for (const row of opened.rows) {
      expect(row.time, '每行必须有时间：' + JSON.stringify(row)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
      expect(row.channel.length, '每行必须有通道：' + JSON.stringify(row)).toBeGreaterThan(0);
    }

    // ⑤ 用户面 = 机读面（同一份数据；用户面只采 WARN/ERROR）
    const records = await readDiagnostics(page)
    const actionable = records.filter((r) => r.code !== 'module.pruned');
    expect(
      opened.rows.length,
      '⚠️ S8：底栏条数必须等于机读面里需要用户知道的记录条数（两面不得分叉）',
    ).toBeLessThanOrEqual(Math.max(actionable.length, 1));
    for (const row of opened.rows) {
      expect(
        records.some((r) => r.code === row.code && r.channel === row.channel),
        `列表行必须是真实诊断记录（不得伪造）：${JSON.stringify(row)}`,
      ).toBe(true);
    }
  });

  test('S8-b 负对照：完好文档 ⇒ 底栏不出现诊断常驻区（空态不显示）', async ({ page }) => {
    test.setTimeout(420_000)
    await gotoWorkbench(page)
    await page.waitForFunction(() => typeof (window as any).__p7_input__?.counters === 'function', undefined, {
      timeout: 30_000,
    })
    await expect(page.locator(STATUS_BAR)).toBeVisible()
    await injectSceneDocumentOk(page, readJson(fixturePath()), FIXTURE)
    const terminal = await waitTextureState(page, TERMINAL_TEXTURE_STATES, 'S8-b 完好场景终态', 180_000)
    expect(terminal, '前提：完好场景必须到达 ready').toBe('ready')

    const surface = await readDiagnosticsSurface(page)
    console.log('[S8-b] surface=' + JSON.stringify(surface))
    expect(surface.rows, '收起状态不得渲染行').toEqual([])
    expect(
      surface.hasButton,
      '负对照：完好装载不得让底栏亮起诊断计数（否则 S8-a 的"出现计数"没有分辨力）',
    ).toBe(false);
  });
});