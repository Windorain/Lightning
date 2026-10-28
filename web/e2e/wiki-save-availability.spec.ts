/**
 * **浏览器棘轮：Wiki 保存不可用时的可见原因**（wiki-profile 服务，真实菜单）。
 *
 * ## 缺陷形态
 *
 * Wiki 内嵌外壳的文件菜单里，"保存到 Wiki"在 `poll` 为 false 时（当前文档**不是**从
 * Wiki 载入的结构数据 / 没有可审计的变更）**照样可以点**，点了只写一条 `log.info`。
 * 用户既不知道"为什么不可用"，也不知道"下一步该做什么"（SPEC §10.7 禁止的
 * "静默成功/静默失败"形态）。
 *
 * ## 本 spec 证什么（全部在**真实** wiki-profile 服务上，不替身菜单）
 *
 * | 用例 | 判据 |
 * |---|---|
 * | A 本地文档 | 打开真实的「文件」菜单 ⇒ "保存到 Wiki" **native disabled** 且原因**指向**
 *   "另存为 Wiki 结构"；"另存为 Wiki 结构"**可用**（正对照）；点击/直接派发 click
 *   **不发**任何远端请求、**不打开**任何模态、不产生下载 |
 * | B 直接入口 | 直接 `invoke`（= Ctrl+S 的同一条 `registry.invoke`）⇒ 底栏出现**成句拒绝**，
 *   原因与菜单 title **同一句**，且仍然没有保存请求 |
 * | C Wiki 载入且干净 | 同一菜单项灰显、原因是"没有可审计的变更"（与 A 的下一步不同）；
 *   一次真实编辑后同项**变可用**（证明灰显有区分力） |
 *
 * ## 纪律
 *
 * - **不做真实 Wiki 写**：整个 spec 只读；远端由 `helpers/wiki/wikiSandbox` 扮演并**记录**
 *   请求 —— 判据因此可以断言"一个 edit 请求都没有"。
 * - **入口是真的**：装载走 `OPERATOR_OPEN_SCENE`（与拖放同一生产路径）/ `OPERATOR_DOCUMENT_LOAD`；
 *   菜单是 `menuBarPanel.layout` 渲染出来的那一份；观测面是真实 DOM + `window.__vm__` 公开读面。
 * - 端到端跑在 **wiki-profile** 服务（主槽 +1，见 `playwright.config.ts` 的第二个 webServer）。
 *
 * ## 与 Ctrl+S 的关系（边界已修复）
 *
 * 本 spec 首版落地时，`keymap/index.ts` 声明了 `Ctrl+S → OPERATOR_WIKI_SAVE_CONFIRM`，
 * 但键盘输入面没有接这行表（P7 的 `WORKBENCH_APP_HOTKEYS` 只含 undo/redo），
 * 于是 Ctrl+S 是"按了没反应"的既存缺口。**Ctrl+S 已接到同一条算子入口**
 * （`workbench/inputHotkeys` 的 Wiki 能力 guard + 键位声明派生），本 spec 的用例 B
 * 因此同时断言**真实按键**与直接 `invoke` 给出同一句原因；
 * 完整按键矩阵（普通工作台/文本/IME）见 `e2e/wiki-ctrl-s.spec.ts`。
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'

import { injectSceneDocumentOk, waitForViewportMounted } from './helpers/multiblock/harness'
import { fixturePath, firstAnnotatedCell, innerDocOf, selectCell, TOOLTIP_FIELD, writeField, readFixtureText } from './helpers/saveReopen'
import { gotoWikiWorkbench, installWikiSandbox } from './helpers/wiki/wikiSandbox'

/** 文件菜单按钮（`UIMenu.vue` 的 `.ux-menu-btn`，与既有 helper 同一选择器）。 */
const FILE_MENU = '.wb-menubar .ux-menu-btn'
/** 菜单项按**算子 id** 定位（比文案稳：文案会随语言变）。 */
const SAVE_TO_WIKI = '.ux-menu-item[data-op-id="OPERATOR_WIKI_SAVE_CONFIRM"]'
const SAVE_AS = '.ux-menu-item[data-op-id="OPERATOR_WIKI_SAVE_AS"]'
/** 底栏的拒绝渠道（机器可读槽）。 */
const REJECTION_SLOT = '.sb-root [data-live-origin="rejection"]'
const MODAL_PRIMARY = '.wiki-modal__primary'

const WIKI_BASE = 'W16-E2E-SaveAvailability'
const WIKI_INDEX_TITLE = `Data:Structures/${WIKI_BASE}.json`

/** 打开真实的「文件」下拉菜单（真实点击，不派发假事件）。 */
async function openFileMenu(page: Page): Promise<void> {
  await page.locator(FILE_MENU, { hasText: '文件' }).first().click()
  await expect(page.locator('.ux-menu-dropdown')).toBeVisible({ timeout: 10_000 })
}

/** 当前保存绑定与 Wiki 模态的一次性快照（生产读面）。 */
async function saveFacts(page: Page): Promise<{ sourceId: string; modal: string; loaded: boolean }> {
  return (await page.evaluate(() => {
    const vm = (window as any).__vm__
    return {
      sourceId: String(vm.getDocumentBinding().value.sourceId),
      modal: String(vm.wm.chrome.wikiUi?.modal?.value ?? ''),
      loaded: Boolean(vm.hasLoadedDocument()),
    }
  })) as { sourceId: string; modal: string; loaded: boolean }
}

/** wiki-profile 装载：走生产算子 `OPERATOR_DOCUMENT_LOAD`（sourceId=wiki-data）。 */
async function loadWikiFixture(page: Page): Promise<void> {
  await page.evaluate(
    async (title) => {
      await (window as any).__vm__.getOperators().exec('OPERATOR_DOCUMENT_LOAD', { sourceId: 'wiki-data', title })
    },
    WIKI_BASE,
  )
  await waitForViewportMounted(page)
}

test.describe('Wiki 保存不可用：菜单可见原因 + 不静默执行', () => {
  test('A 本地文档：「保存到 Wiki」灰显且原因指向「另存为 Wiki 结构」，点击不发保存请求', async ({ page }) => {
    test.setTimeout(420_000)
    test.skip(test.info().project.name !== 'desktop-chrome', '菜单/底栏判据固定在 desktop-chrome')

    const wiki = await installWikiSandbox(page, {
      indexTitle: WIKI_INDEX_TITLE,
      indexContent: readFixtureText(),
    })
    await gotoWikiWorkbench(page)

    // ── 本地文档：生产入口（`OPERATOR_OPEN_SCENE`，与拖放同一条路径）──
    await injectSceneDocumentOk(page, JSON.parse(readFixtureText()), 'w16-local.json')
    await waitForViewportMounted(page)

    const before = await saveFacts(page)
    expect(before.loaded, '前提：本地文档必须真的装载了（否则菜单项的 poll 无从判定）').toBe(true)
    expect(before.sourceId, '前提：本地文档**不是** wiki-data 绑定（本用例要的就是这条分支）').not.toBe('wiki-data')

    let downloads = 0
    page.on('download', () => { downloads += 1 })
    const requestsBefore = wiki.requests()

    await openFileMenu(page)

    // ── ① 保存项：native disabled + 原因指向"另存为"（title/aria/data 同源）──
    const save = page.locator(SAVE_TO_WIKI)
    await expect(save, '本地文档上"保存到 Wiki"必须在菜单里**可见**（不许悄悄消失）').toHaveCount(1)
    await expect(save, 'poll=false ⇒ native disabled（不是"能点然后没反应"）').toBeDisabled()
    expect(await save.getAttribute('aria-disabled'), 'aria-disabled 必须与 native disabled 一致').toBe('true')
    const reason = (await save.getAttribute('data-unavailable-reason')) ?? ''
    expect(reason, '原因必须说清为什么（当前文档不是从 Wiki 载入的结构数据）').toContain('Wiki')
    expect(reason, '原因必须给出下一步：另存为 Wiki 结构').toContain('另存为 Wiki 结构')
    expect((await save.getAttribute('title')) ?? '', 'title 必须带同一句原因（悬停可见）').toContain(reason)

    // ── ② 正对照：同菜单的"另存为 Wiki 结构"**可用**（否则"灰掉"可能只是把整条路废了）──
    const saveAs = page.locator(SAVE_AS)
    await expect(saveAs, '另存为在本地文档上必须可用（它就是原因里指的下一步）').toBeEnabled()
    expect(await saveAs.getAttribute('data-unavailable-reason'), '可用项不得带不可用原因').toBeNull()

    // ── ③ 点击/派发 click 都不执行（不打开模态、不发远端请求、不下载）──
    await save.dispatchEvent('click')
    await page.waitForTimeout(500)
    expect((await saveFacts(page)).modal, '点击不可用项不得打开保存确认模态').toBe('')
    expect(await page.locator(MODAL_PRIMARY).count(), '不得出现任何模态主按钮').toBe(0)
    expect(wiki.requests(), '点击不可用项不得发出任何远端请求').toBe(requestsBefore)
    expect(wiki.edits.length, '不得产生 edit（不写 Wiki）').toBe(0)
    expect(downloads, '不得产生浏览器下载（本地文档也不该被这条命令接手）').toBe(0)
  })

  test('B 直接入口（Ctrl+S 同一条 invoke）：底栏成句拒绝，原因与菜单同句，仍不写 Wiki', async ({ page }) => {
    test.setTimeout(420_000)
    test.skip(test.info().project.name !== 'desktop-chrome', '菜单/底栏判据固定在 desktop-chrome')

    const wiki = await installWikiSandbox(page, {
      indexTitle: WIKI_INDEX_TITLE,
      indexContent: readFixtureText(),
    })
    await gotoWikiWorkbench(page)
    await injectSceneDocumentOk(page, JSON.parse(readFixtureText()), 'w16-local-invoke.json')
    await waitForViewportMounted(page)

    // 菜单里的原因（同一句话的另一端）
    await openFileMenu(page)
    const menuReason = (await page.locator(SAVE_TO_WIKI).getAttribute('data-unavailable-reason')) ?? ''
    expect(menuReason.length, '前提：菜单必须给出原因（否则下面的"同句"无从比对）').toBeGreaterThan(0)
    await page.keyboard.press('Escape')
    await page.locator(FILE_MENU, { hasText: '文件' }).first().click() // 关掉菜单
    await page.waitForTimeout(200)

    // 先清掉底栏的旧拒绝，保证下面看到的**只可能**是本次操作造成的
    await page.evaluate(() => { (window as any).__vm__.log.clearRejectionStatus() })

    // ── 真按键 Ctrl+S（绑定声明在 `keymap/index.ts`：opId = OPERATOR_WIKI_SAVE_CONFIRM）──
    const beforeKey = await page.evaluate(() => (window as any).__vm__.log.entries.value.length)
    const requestsBefore = wiki.requests()
    await page.keyboard.press('Control+s')
    await page.waitForTimeout(800)
    // Ctrl+S 接入之后：这条真实按键必须走同一条算子入口（不再是首版记录的"零调用"缺口）。
    const afterKey = await page.evaluate((n: number) => (window as any).__vm__.log.entries.value.slice(n).map((e: any) => e.message), beforeKey)
    console.log('[W16] ctrlS log entries=' + JSON.stringify(afterKey))
    // 真实按键现在必须走同一条算子入口 ⇒ 底栏出现与菜单同句的原因。
    await expect
      .poll(async () => ((await page.locator(REJECTION_SLOT).count()) === 0 ? '' : (await page.locator(REJECTION_SLOT).first().innerText()).replace(/\s+/g, ' ').trim()), {
        message: '真实 Ctrl+S 必须给出可见拒绝（接线后不再是"按了没反应"）',
        timeout: 20_000,
      })
      .toContain(menuReason)
    expect(await page.locator(MODAL_PRIMARY).count(), '真实 Ctrl+S 在不可用文档上不得打开模态').toBe(0)
    expect(wiki.requests(), '按 Ctrl+S 也**不得**发出远端请求（按键无效 ≠ 偷偷保存）').toBe(requestsBefore)
    expect(wiki.edits.length, '按 Ctrl+S 不得产生 edit（不写 Wiki）').toBe(0)
    await page.evaluate(() => { (window as any).__vm__.log.clearRejectionStatus() })

    // 同一条算子的直接 invoke（Ctrl+S 经的就是它）—— 再证一次结果与模态
    const invoked = await page.evaluate(() => {
      const vm = (window as any).__vm__
      const result = vm.getOperators().invoke('OPERATOR_WIKI_SAVE_CONFIRM')
      return { result: String(result), modal: String(vm.wm.chrome.wikiUi?.modal?.value ?? '') }
    })
    expect(invoked.result, '不可用的 invoke 不得报 FINISHED').not.toBe('FINISHED')
    expect(invoked.modal, '不得打开保存确认模态').toBe('')

    await expect
      .poll(async () => ((await page.locator(REJECTION_SLOT).count()) === 0 ? '' : (await page.locator(REJECTION_SLOT).first().innerText()).replace(/\s+/g, ' ').trim()), {
        message: '直接入口的拒绝必须写底栏（否则用户只看到"按了没反应"）',
        timeout: 20_000,
      })
      .toContain('被拒')
    const live = (await page.locator(REJECTION_SLOT).first().innerText()).replace(/\s+/g, ' ').trim()
    expect(live, '底栏原因必须与菜单 title/aria 的原因同一句').toContain(menuReason)
    expect(live, '底栏不得把错误码原样贴给用户').not.toContain('UnsupportedOperation')
    expect(wiki.requests(), '拒绝路径不得发出远端请求').toBe(requestsBefore)
    expect(wiki.edits.length, '拒绝路径不得产生 edit（不写 Wiki）').toBe(0)
  })

  test('C Wiki 载入且干净：灰显原因是"没有可审计的变更"；一次真实编辑后同项变可用', async ({ page }) => {
    test.setTimeout(420_000)
    test.skip(test.info().project.name !== 'desktop-chrome', '菜单/底栏判据固定在 desktop-chrome')

    const doc = innerDocOf(fixturePath())
    const target = firstAnnotatedCell(doc)
    await installWikiSandbox(page, {
      indexTitle: WIKI_INDEX_TITLE,
      indexContent: readFixtureText(),
    })
    await gotoWikiWorkbench(page)
    await loadWikiFixture(page)
    await selectCell(page, target.kernel, target.fileIdx)

    expect((await saveFacts(page)).sourceId, '前提：Wiki 装载必须把绑定设成 wiki-data').toBe('wiki-data')

    // ── ① 干净：灰显 + "没有可审计的变更" ──
    await openFileMenu(page)
    const save = page.locator(SAVE_TO_WIKI)
    await expect(save, '刚装载（基线 = 当前产物）⇒ 保存项必须不可用').toBeDisabled()
    const cleanReason = (await save.getAttribute('data-unavailable-reason')) ?? ''
    expect(cleanReason, '原因必须说清"没有可审计的变更"').toContain('没有可审计的变更')
    expect(cleanReason, '两类不可用的下一步不同：这条不得指向"另存为"').not.toContain('另存为')

    // 关菜单（再点一次菜单按钮）
    await page.locator(FILE_MENU, { hasText: '文件' }).first().click()
    await page.waitForTimeout(200)

    // ── ② 真实编辑 ⇒ 重开菜单后同项**可用**（灰显有区分力）──
    await writeField(page, TOOLTIP_FIELD, 'W16 可保存的编辑')
    await openFileMenu(page)
    await expect(page.locator(SAVE_TO_WIKI), '有可审计变更 ⇒ 保存项必须可点').toBeEnabled()
    expect(await page.locator(SAVE_TO_WIKI).getAttribute('data-unavailable-reason')).toBeNull()
  })
})
