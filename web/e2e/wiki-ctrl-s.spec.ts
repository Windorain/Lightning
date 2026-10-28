/**
 * **Wiki 内嵌工作台的物理 Ctrl+S** —— 真实浏览器按键矩阵。
 *
 * ## 本 spec 要证的一条链
 *
 * `keymap/index.ts` 的键位声明 → `WORKBENCH_APP_HOTKEYS` 的 Wiki 追加项（能力 guard）
 * → 输入会话的 `local.wikiSaveConfirm` → **菜单同一条** `OPERATOR_WIKI_SAVE_CONFIRM`。
 *
 * 全程用 `page.keyboard.press('Control+s')`（真实浏览器事件），不直接 invoke 冒充按键；
 * 计数用生产 `LogCenter` 里带 `detail.opId` 的日志，且**只覆盖本矩阵实际走的两条路径**
 * （poll 拒绝 / FINISHED）；不用测试侧包一层就算数。Wiki 远端全部由
 * `helpers/wiki/wikiSandbox` 扮演：
 * 判据可以断言"一条 edit 都没有"，因此"打开了确认"与"真的写了"被严格分开。
 *
 * ## 矩阵
 *
 * | # | 场景 | 按键后的**期望** |
 * |---|---|---|
 * | A | 普通工作台（workbench profile） | 不是 Wiki 绑定：不弹模态、不写拒绝、不调用保存算子；preventDefault=false |
 * | B | Wiki profile + 本地文档（不可用） | 底栏出现同句原因（与菜单 title 同一句），零写零模态，算子恰调用一次 |
 * | C | Wiki profile + Wiki 载入（干净） | 底栏"没有可审计的变更"，零写零模态，恰一次 |
 * | D | Wiki profile + Wiki 载入 + 真实编辑 | 打开**既有**保存确认模态，**不点确认**，零 edit 请求，恰一次（与 C **同一用例**内顺序执行，省一次 Wiki 装载） |
 * | E | Wiki profile + 文本输入真实焦点 | 走 `text` 层：不调用保存、不弹模态、preventDefault=false |
 * | F | Wiki profile + IME 组合期（真实 composition 事件） | 走 `text` 层且 reason=`ime-composing`：不调用保存、preventDefault=false |
 * | G | **真实宿主页正路径** | boot body / 编辑 commitAndBlur / 菜单关闭 / dirty 的 Ctrl+S 都命中同一 operator 且一次；模态文本不二次保存 |
 * | H | **真实宿主页负路径 + 恢复** | 宿主 input/blur/宿主非输入交互后的 body ⇒ unhandled/defaultPrevented=false/op0；再点工作台恢复 owned 后能处理 |
 * | I | **真实宿主页** + app 外 input（干净 + dirty） | 宿主 input 在 Wiki clean/dirty 均不归；dirty 也不弹确认；defaultPrevented=false |
 *
 * ## 计数口径（只声称实际路径）
 *
 * 本矩阵只经过 `OperatorRegistry#invoke` 的两条路径：
 *  - poll 拒绝 ⇒ `refuseUnavailableOperator` 写一条带 `detail.opId` 的 warn；
 *  - 可用并 FINISHED ⇒ `logOperatorResult` 写一条带 `detail.opId` 的 operator 日志。
 * 一次按键若让该计数 +1，说明恰好走到一次算子入口；若 +2，说明同一事件被解释成两次。
 * 这里**不**宣称 invoke 的"所有终局"都恰一条（其它分支不在本矩阵判据内）。
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'

import { gotoWorkbench, injectSceneDocumentOk, waitForViewportMounted } from './helpers/multiblock/harness'
import { fixturePath, firstAnnotatedCell, innerDocOf, selectCell, TOOLTIP_FIELD, writeField, readFixtureText } from './helpers/saveReopen'
import { gotoWikiWorkbench, installWikiSandbox } from './helpers/wiki/wikiSandbox'

const FILE_MENU = '.wb-menubar .ux-menu-btn'
const SAVE_TO_WIKI = '.ux-menu-item[data-op-id="OPERATOR_WIKI_SAVE_CONFIRM"]'
const REJECTION_SLOT = '.sb-root [data-live-origin="rejection"]'
const MODAL = '.wiki-modal'
const MODAL_PRIMARY = '.wiki-modal__primary'
const MODAL_CANCEL = '.wiki-modal__actions button'
const MODAL_TEXTAREA = '.wiki-modal__textarea'
const HOST_APP = '#wsr-workbench-app'
const HOST_OUTSIDE_INPUT = 'w442-host-outside-input'
const HOST_OUTSIDE_BUTTON = 'w442-host-outside-button'

const OP_ID = 'OPERATOR_WIKI_SAVE_CONFIRM'
const LOCAL_COMMAND = 'local.wikiSaveConfirm'
const WIKI_BASE = 'W442-CtrlS'
const WIKI_INDEX_TITLE = `Data:Structures/${WIKI_BASE}.json`

/** 等生产输入装配真正挂好（`__p7_input__` 在 `assembleWorkbenchInput` 末尾才写）。 */
async function waitForInputAssembly(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as any).__p7_input__?.trace === 'function',
    undefined,
    { timeout: 30_000 },
  )
}

/**
 * 等视口纹理链**落定**再按键。
 *
 * 为什么不是产品缺陷：底栏的实时状态槽由纹理五态与拒绝**共享**（同一时刻只显示当前
 * 事实）。装载后 62 个资源仍在解码时按 Ctrl+S，拒绝会先出现、随后被"纹理进度"覆盖 ——
 * 那是"装载还没结束"的正常时序，不是"按键无效"。真人也只会在画面就绪后按键。
 * 判据因此把"装载完成"作为前置，而不是把竞态写进期望。
 */
async function waitForTexturesSettled(page: Page): Promise<void> {
  await expect
    .poll(async () => await page.locator('.sb-root').getAttribute('data-texture-state'), {
      message: '前置：真实纹理链必须落定（否则底栏实时状态仍会被装载进度覆盖）',
      timeout: 90_000,
    })
    .toMatch(/^(ready|missing|failed)$/)
}

/** 打开**真实 Wiki 宿主页**（`index-wiki-workbench.html`，挂载点 `#wsr-workbench-app`）。 */
async function gotoWikiHostPage(page: Page): Promise<void> {
  await gotoWikiWorkbench(page, '/index-wiki-workbench.html')
  await waitForInputAssembly(page)
  await expect(page.locator(HOST_APP), '真实宿主页必须用宿主挂载点').toBeVisible({ timeout: 90_000 })
  expect(await page.locator('#app').count(), '真实宿主页不是独立 Vite 页（不得回落到 #app）').toBe(0)
}

/**
 * 在宿主页 body 上放一个**真实 input**（app 子树之外）并聚焦。
 *
 * 这不是"在独立 Vite 页手工放 input"：页面是真实 `index-wiki-workbench.html`，
 * 工作台挂载在 `#wsr-workbench-app`；这里模拟的是宿主页自己的搜索框/正文输入
 * —— 它**不属于**工作台，键盘归属必须按 DOM 判定。
 */
async function focusHostOutsideInput(page: Page): Promise<void> {
  await page.evaluate((id) => {
    let input = document.getElementById(id) as HTMLInputElement | null
    if (input === null) {
      input = document.createElement('input')
      input.id = id
      input.type = 'text'
      input.style.cssText = 'position:fixed;left:0;bottom:0;z-index:2147483647'
      document.body.appendChild(input)
    }
    input.focus()
  }, HOST_OUTSIDE_INPUT)
  await expect
    .poll(async () => await page.evaluate(() => document.activeElement?.id ?? ''), {
      message: '宿主 input 必须真的拿到浏览器焦点',
    })
    .toBe(HOST_OUTSIDE_INPUT)
  expect(
    await page.evaluate((payload: { app: string; id: string }) => {
      const app = document.querySelector(payload.app)
      const input = document.getElementById(payload.id)
      return input !== null && app !== null && !app.contains(input)
    }, { app: HOST_APP, id: HOST_OUTSIDE_INPUT }),
    '前提：该 input 必须在工作台 app 子树**之外**',
  ).toBe(true)
  expect(
    await page.evaluate(() => (window as any).__p7_input__?.textFocus()?.controlId ?? null),
    '宿主 input 不得被登记成工作台文本焦点',
  ).toBeNull()
}

/** 宿主页上的**非输入**控件（app 外 button）；用于"宿主先交互后 body 不归工作台"。 */
async function clickHostOutsideButton(page: Page): Promise<void> {
  await page.evaluate((id) => {
    let button = document.getElementById(id) as HTMLButtonElement | null
    if (button === null) {
      button = document.createElement('button')
      button.id = id
      button.type = 'button'
      button.textContent = 'host action'
      button.style.cssText = 'position:fixed;left:200px;bottom:0;z-index:2147483647'
      document.body.appendChild(button)
    }
  }, HOST_OUTSIDE_BUTTON)
  await page.locator(`#${HOST_OUTSIDE_BUTTON}`).click()
  expect(
    await page.evaluate((payload: { app: string; id: string }) => {
      const app = document.querySelector(payload.app)
      const button = document.getElementById(payload.id)
      return button !== null && app !== null && !app.contains(button)
    }, { app: HOST_APP, id: HOST_OUTSIDE_BUTTON }),
    '前提：宿主按钮必须在工作台 app 子树之外',
  ).toBe(true)
}

/** 把焦点退到 body（不改变最近所有权：focusout 不参与所有权）。 */
async function blurToBody(page: Page): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null
    active?.blur?.()
  })
  await expect
    .poll(async () => await page.evaluate(() => document.activeElement?.tagName ?? ''), {
      message: '前置：焦点必须真的回到 body',
    })
    .toBe('BODY')
}

async function openFileMenu(page: Page): Promise<void> {
  await page.locator(FILE_MENU, { hasText: '文件' }).first().click()
  await expect(page.locator('.ux-menu-dropdown')).toBeVisible({ timeout: 10_000 })
}

async function closeFileMenu(page: Page): Promise<void> {
  const dropdown = page.locator('.ux-menu-dropdown')
  if ((await dropdown.count()) === 0) return
  await page.locator(FILE_MENU, { hasText: '文件' }).first().click()
  await expect(dropdown).toHaveCount(0, { timeout: 5_000 })
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

/**
 * **算子入口的生产计数口径**：`LogCenter` 里带 `detail.opId` 的条目。
 *
 * 为什么不数诊断面的 `command.received`：当前 `OperatorRegistry#invoke` **不**发射它
 * （只有 `exec` 发射），用它计数会把"按键走了 invoke"误判成 0。本矩阵实际覆盖的
 * 两条 invoke 路径各写一条带 `detail.opId` 的日志：
 *  - 可用并 FINISHED ⇒ `logOperatorResult`（`Operator: <label> → FINISHED`）；
 *  - poll 拒绝 ⇒ `refuseUnavailableOperator`（`refused: <label>`）。
 * **不**把这条注释扩成"invoke 所有终局都恰一条"（能力拒绝等分支不在本判据内）。
 *
 * 水位用日志条数（本页只有几十条，远低于有界上限 2000）；切片后按 opId 过滤，
 * 既不看文案，也不依赖错误码。
 */
async function operatorLogMark(page: Page): Promise<number> {
  return (await page.evaluate(() => (window as any).__vm__.log.entries.value.length)) as number
}

/** 自水位以来，该算子入口写出的日志条数（本矩阵只覆盖 poll 拒绝/FINISHED 两条路径）。 */
async function operatorLogCountSince(page: Page, mark: number): Promise<number> {
  return (await page.evaluate(
    (payload: { mark: number; id: string }) => {
      const entries = (window as any).__vm__.log.entries.value as Array<{ detail?: { opId?: string } }>
      return entries
        .slice(payload.mark)
        .filter((e) => e.detail !== null && typeof e.detail === 'object' && e.detail.opId === payload.id).length
    },
    { mark, id: OP_ID },
  )) as number
}

interface TraceEntry {
  source: string
  kind: string
  level: string | null
  commandId: string | null
  reason: string
  dispatched?: boolean
}

async function trace(page: Page): Promise<TraceEntry[]> {
  return (await page.evaluate(() => (window as any).__p7_input__.trace())) as TraceEntry[]
}

/**
 * 最小、只读的浏览器事实探针：真实事件到达 document 后，`defaultPrevented` 是什么。
 *
 * 生产输入绑定是 document 的 **capture** 监听；本探针在它之后注册（同一元素、同为
 * capture），因此读到的是生产 `preventDefault` 之后的结论 —— 正是"handled 才阻止、
 * 未 handled 不抢键"这条政策在平台上的可观测形态。它不参与路由，不替按键。
 */
async function armCtrlSDefaultProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any
    w.__ctrlSDefaultPrevented = null
    const probe = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() !== 's' || !(e.ctrlKey || e.metaKey)) return
      w.__ctrlSDefaultPrevented = e.defaultPrevented
      document.removeEventListener('keydown', probe, true)
    }
    document.addEventListener('keydown', probe, true)
  })
}

async function ctrlSDefaultPrevented(page: Page): Promise<boolean | null> {
  return (await page.evaluate(() => (window as any).__ctrlSDefaultPrevented)) as boolean | null
}

/** 一次真实按键；返回本次新增的轨迹（按按键前的长度切）。 */
async function pressCtrlS(page: Page): Promise<TraceEntry[]> {
  const before = (await trace(page)).length
  await armCtrlSDefaultProbe(page)
  await page.keyboard.press('Control+s')
  await page.waitForTimeout(600)
  return (await trace(page)).slice(before)
}

function lastKeydown(entries: readonly TraceEntry[]): TraceEntry | undefined {
  return [...entries].reverse().find((e) => e.source === 'key' && e.kind === 'keydown')
}

async function rejectionText(page: Page): Promise<string | null> {
  if ((await page.locator(REJECTION_SLOT).count()) === 0) return null
  return (await page.locator(REJECTION_SLOT).first().innerText()).replace(/\s+/g, ' ').trim()
}

async function waitForRejection(page: Page): Promise<string> {
  await expect
    .poll(async () => (await rejectionText(page)) ?? '', {
      message: '不可用入口必须在底栏给出成句原因（不能"按了没反应"）',
      timeout: 20_000,
    })
    .toContain('被拒')
  return (await rejectionText(page)) ?? ''
}

test.describe('Wiki 内嵌 Ctrl+S 真实按键', () => {
  test('A 普通工作台：Ctrl+S 不被 Wiki 绑定接管（既有行为不变）', async ({ page }) => {
    test.setTimeout(180_000)
    test.skip(test.info().project.name !== 'desktop-chrome', '按键矩阵固定在 desktop-chrome')

    await gotoWorkbench(page)
    await page.waitForFunction(() => typeof (window as any).__p7_input__?.counters === 'function', undefined, {
      timeout: 30_000,
    })

    const logMark = await operatorLogMark(page)
    // 默认动作会不会真的下载取决于浏览器环境；本判据只要求"不是产品拦下的"，
    // 监听仅用于取消下载、不在仓库树留文件。
    page.on('download', (d) => {
      void d.cancel().catch(() => {})
    })

    const entries = await pressCtrlS(page)
    const key = lastKeydown(entries)

    expect(key, '必须留下一条 keydown 路由轨迹').toBeTruthy()
    expect(key!.level, '普通工作台没有 Wiki 保存绑定 ⇒ 未注册键（none）').toBe('none')
    expect(key!.commandId, '不得产生任何命令意图（尤其不得是 local.wikiSaveConfirm）').toBeNull()
    expect(key!.reason).toBe('unhandled')
    expect(await ctrlSDefaultPrevented(page), '未 handled ⇒ 不抢浏览器默认行为').toBe(false)

    expect(await operatorLogCountSince(page, logMark), '普通工作台不得调用 Wiki 保存算子').toBe(0)
    expect(await page.locator(MODAL).count(), '不得弹 Wiki 保存确认').toBe(0)
    expect(await page.locator(REJECTION_SLOT).count(), '不得出现 Wiki 不可用拒绝').toBe(0)
  })

  test('Wiki profile + 本地文档：真实 Ctrl+S 给同一句原因，零写零模态，恰一次', async ({ page }) => {
    test.setTimeout(420_000)
    test.skip(test.info().project.name !== 'desktop-chrome', '按键矩阵固定在 desktop-chrome')

    const wiki = await installWikiSandbox(page, {
      indexTitle: WIKI_INDEX_TITLE,
      indexContent: readFixtureText(),
    })
    await gotoWikiWorkbench(page)
    await waitForInputAssembly(page)
    await injectSceneDocumentOk(page, JSON.parse(readFixtureText()), 'w442-local.json')
    await waitForViewportMounted(page)
    await waitForTexturesSettled(page)

    // 菜单里的原因 —— 与 Ctrl+S 的底栏拒绝必须同一句（可见性判据）。
    await openFileMenu(page)
    const menuReason = (await page.locator(SAVE_TO_WIKI).getAttribute('data-unavailable-reason')) ?? ''
    expect(menuReason.length, '前提：本地文档上菜单必须给出原因').toBeGreaterThan(0)
    await closeFileMenu(page)

    await page.evaluate(() => (window as any).__vm__.log.clearRejectionStatus())
    let downloads = 0
    page.on('download', (d) => {
      downloads += 1
      void d.cancel().catch(() => {})
    })
    const requestsBefore = wiki.requests()
    const logMark = await operatorLogMark(page)

    const entries = await pressCtrlS(page)
    const live = await waitForRejection(page)

    expect(live, '底栏原因必须与菜单 title/aria 的原因同一句').toContain(menuReason)
    expect(live, '底栏不得把错误码原样贴给用户').not.toContain('UnsupportedOperation')
    expect(await page.locator(REJECTION_SLOT).count(), '一次按键只允许一条可见拒绝').toBe(1)
    expect(await page.locator(MODAL).count(), '不可用路径不得打开保存确认').toBe(0)
    expect(await page.locator(MODAL_PRIMARY).count(), '不得出现任何模态主按钮').toBe(0)
    expect(await operatorLogCountSince(page, logMark), '一次按键只允许调用一次保存算子').toBe(1)

    const key = lastKeydown(entries)
    expect(key!.level, 'Wiki profile 的 Ctrl+S 必须命中 app 层').toBe('app')
    expect(key!.commandId).toBe(LOCAL_COMMAND)
    expect(key!.dispatched, '意图必须真的交给分发').toBe(true)
    expect(await ctrlSDefaultPrevented(page), 'handled ⇒ 阻止浏览器默认保存').toBe(true)
    expect(entries.filter((e) => e.source === 'command' && e.commandId === LOCAL_COMMAND).length, '同一次按键只分发一次').toBe(1)

    expect(wiki.requests(), '拒绝路径不得发出远端请求').toBe(requestsBefore)
    expect(wiki.edits.length, '拒绝路径不得产生 edit（不写 Wiki）').toBe(0)
    expect(downloads, '产品已接手该组合键时不得退化成浏览器下载').toBe(0)
  })

  test('C Wiki profile + 干净 Wiki 文档：Ctrl+S 拒绝且零写；编辑后同一按键打开既有确认（不确认）', async ({ page }) => {
    test.setTimeout(420_000)
    test.skip(test.info().project.name !== 'desktop-chrome', '按键矩阵固定在 desktop-chrome')

    const doc = innerDocOf(fixturePath())
    const target = firstAnnotatedCell(doc)
    const wiki = await installWikiSandbox(page, {
      indexTitle: WIKI_INDEX_TITLE,
      indexContent: readFixtureText(),
    })
    await gotoWikiWorkbench(page)
    await waitForInputAssembly(page)
    await loadWikiFixture(page)
    await selectCell(page, target.kernel, target.fileIdx)
    await waitForTexturesSettled(page)

    // ── ① 干净：真有按键，也真的说"没有可审计的变更" ──
    await page.evaluate(() => (window as any).__vm__.log.clearRejectionStatus())
    const cleanMark = await operatorLogMark(page)
    const cleanEntries = await pressCtrlS(page)
    const cleanLive = await waitForRejection(page)
    expect(cleanLive, '干净 Wiki 文档的下一步与"另存为"不同').toContain('没有可审计的变更')
    expect(cleanLive).not.toContain('另存为')
    expect(await operatorLogCountSince(page, cleanMark), '一次按键恰一次').toBe(1)
    expect(await page.locator(MODAL).count(), '干净文档不得打开保存确认').toBe(0)
    expect(wiki.edits.length, '干净文档不得写 Wiki').toBe(0)
    const cleanKey = lastKeydown(cleanEntries)
    expect(cleanKey!.commandId).toBe(LOCAL_COMMAND)
    expect(await ctrlSDefaultPrevented(page)).toBe(true)

    // ── ② 真实编辑 ⇒ 同一按键打开**既有**保存确认模态 ──
    await page.evaluate(() => (window as any).__vm__.log.clearRejectionStatus())
    await writeField(page, TOOLTIP_FIELD, 'W442 可保存的编辑')
    await expect(page.locator('.sb-unsaved'), '真实编辑后必须出现「未保存」').toHaveCount(1, { timeout: 20_000 })

    const requestsBefore = wiki.requests()
    const dirtyMark = await operatorLogMark(page)
    let downloads = 0
    page.on('download', (d) => {
      downloads += 1
      void d.cancel().catch(() => {})
    })

    const dirtyEntries = await pressCtrlS(page)
    const confirm = page.locator(MODAL_PRIMARY, { hasText: '确认保存' })
    await expect(confirm, '有可审计变更 ⇒ Ctrl+S 必须打开既有保存确认').toBeVisible({ timeout: 20_000 })

    expect(await operatorLogCountSince(page, dirtyMark), '一次按键只调用一次保存算子').toBe(1)
    expect(await page.evaluate(() => String((window as any).__vm__.wm.chrome.wikiUi?.modal?.value ?? '')), '模态状态必须是 save-confirm').toBe('save-confirm')
    expect(wiki.edits.length, '打开确认 ≠ 确认：不得写 Wiki').toBe(0)
    expect(wiki.requests(), '打开确认不得发出远端写请求').toBe(requestsBefore)
    expect(downloads, '保存确认不是浏览器下载').toBe(0)
    expect(await ctrlSDefaultPrevented(page)).toBe(true)

    const dirtyKey = lastKeydown(dirtyEntries)
    expect(dirtyKey!.level).toBe('app')
    expect(dirtyKey!.commandId).toBe(LOCAL_COMMAND)

    // ── ③ 模态文本框（可能被 teleport 到 body）：Ctrl+S 仍归模态，不二次保存 ──
    await page.locator(MODAL_TEXTAREA).click()
    const modalMark = await operatorLogMark(page)
    const modalEntries = await pressCtrlS(page)
    const modalKey = lastKeydown(modalEntries)
    expect(modalKey, '模态文本焦点下必须留下轨迹（归属仍是工作台）').toBeTruthy()
    expect(modalKey!.level, '事件在已登记模态根内 ⇒ 仍由工作台路由').toBe('modal')
    expect(modalKey!.commandId, '模态文本框里的 Ctrl+S 不得再开一次保存').toBeNull()
    expect(modalKey!.reason).toBe('modal-interior-native-editing')
    expect(await ctrlSDefaultPrevented(page), '模态原生文本保留默认行为').toBe(false)
    expect(await operatorLogCountSince(page, modalMark), '不得第二次调用保存算子').toBe(0)
    expect(await page.locator(MODAL).count(), '确认模态必须仍然只有一个').toBe(1)

    // **不实际确认**：只取消，随后仍不得有 edit。
    await page.locator(MODAL_CANCEL, { hasText: '取消' }).click()
    await expect(page.locator(MODAL)).toHaveCount(0)
    await page.waitForTimeout(500)
    expect(wiki.edits.length, '取消后仍然零写').toBe(0)
  })

  test('E Wiki profile + 文本输入真实焦点：Ctrl+S 走 text 层，不调用保存', async ({ page }) => {
    test.setTimeout(420_000)
    test.skip(test.info().project.name !== 'desktop-chrome', '按键矩阵固定在 desktop-chrome')

    const doc = innerDocOf(fixturePath())
    const target = firstAnnotatedCell(doc)
    await installWikiSandbox(page, {
      indexTitle: WIKI_INDEX_TITLE,
      indexContent: readFixtureText(),
    })
    await gotoWikiWorkbench(page)
    await waitForInputAssembly(page)
    await loadWikiFixture(page)
    await selectCell(page, target.kernel, target.fileIdx)
    await waitForTexturesSettled(page)

    const selector = `[data-property="${TOOLTIP_FIELD}"] input`
    await page.locator(selector).first().click()
    await expect
      .poll(async () => (await page.evaluate(() => (window as any).__p7_input__?.textFocus()?.controlId ?? null)) as string | null, {
        message: '真实点击后必须登记文本焦点（路由的判据来源）',
      })
      .not.toBeNull()

    const logMark = await operatorLogMark(page)
    const entries = await pressCtrlS(page)
    const key = lastKeydown(entries)

    expect(key, '必须留下 keydown 轨迹').toBeTruthy()
    expect(key!.level, '文本输入优先于应用快捷键').toBe('text')
    expect(key!.commandId, '文本输入里的 Ctrl+S 不得产生保存意图').toBeNull()
    expect(key!.reason).toBe('text-native-editing')
    expect(await ctrlSDefaultPrevented(page), '文本输入保留原生行为（不抢键）').toBe(false)
    expect(await operatorLogCountSince(page, logMark), '不得调用保存算子').toBe(0)
    expect(await page.locator(MODAL).count(), '不得弹保存确认').toBe(0)
    expect(await page.locator(REJECTION_SLOT).count(), '不得出现保存拒绝').toBe(0)
  })

  test('F Wiki profile + IME 组合期：真实 composition + Ctrl+S 不触发场景保存', async ({ page }) => {
    test.setTimeout(420_000)
    test.skip(test.info().project.name !== 'desktop-chrome', '按键矩阵固定在 desktop-chrome')

    const doc = innerDocOf(fixturePath())
    const target = firstAnnotatedCell(doc)
    await installWikiSandbox(page, {
      indexTitle: WIKI_INDEX_TITLE,
      indexContent: readFixtureText(),
    })
    await gotoWikiWorkbench(page)
    await waitForInputAssembly(page)
    await loadWikiFixture(page)
    await selectCell(page, target.kernel, target.fileIdx)
    await waitForTexturesSettled(page)

    const selector = `[data-property="${TOOLTIP_FIELD}"] input`
    await page.locator(selector).first().evaluate((el) => {
      const input = el as HTMLInputElement
      input.focus()
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
      input.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'baocun' }))
    })
    await expect
      .poll(async () => Boolean(await page.evaluate(() => (window as any).__p7_input__?.textFocus()?.composing)), {
        message: '生产 handler 必须把 compositionstart 记成显式组合态',
      })
      .toBe(true)

    const countersBefore = await page.evaluate(() => (window as any).__p7_input__.counters())
    const logMark = await operatorLogMark(page)
    const entries = await pressCtrlS(page)
    const key = lastKeydown(entries)

    expect(key!.level, '组合期仍属文本层').toBe('text')
    expect(key!.commandId, '组合期任何键都不得产生场景保存').toBeNull()
    expect(key!.reason).toBe('ime-composing')
    expect(await ctrlSDefaultPrevented(page), '组合期保留输入法原生行为').toBe(false)
    expect(await operatorLogCountSince(page, logMark), '不得调用保存算子').toBe(0)
    expect(await page.locator(MODAL).count()).toBe(0)
    expect(await page.locator(REJECTION_SLOT).count()).toBe(0)

    const countersAfter = await page.evaluate(() => (window as any).__p7_input__.counters())
    expect(
      countersAfter.imeSuppressedShortcuts,
      '组合期的 Ctrl+S 必须计入"被文本层拦下"（负对照：若忽略 composing 就会触发保存）',
    ).toBeGreaterThan(countersBefore.imeSuppressedShortcuts)

    // 收尾组合态（不写文档：组合事件只推进草稿状态）。
    await page.locator(selector).first().evaluate((el) => {
      const input = el as HTMLInputElement
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '保存' }))
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  })

  test('G 真实宿主页正路径：boot body / 编辑 blur / 菜单关闭 / dirty 均命中同一 operator', async ({ page }) => {
    test.setTimeout(420_000)
    test.skip(test.info().project.name !== 'desktop-chrome', '按键矩阵固定在 desktop-chrome')

    const doc = innerDocOf(fixturePath())
    const target = firstAnnotatedCell(doc)
    const wiki = await installWikiSandbox(page, {
      indexTitle: WIKI_INDEX_TITLE,
      indexContent: readFixtureText(),
    })
    await gotoWikiHostPage(page)
    await loadWikiFixture(page)
    await selectCell(page, target.kernel, target.fileIdx)
    await waitForTexturesSettled(page)

    // ── ① boot：activeElement=body，默认所有权归工作台（干净 ⇒ 可见原因）──
    expect(await page.evaluate(() => document.activeElement?.tagName ?? ''), '真实宿主页 boot 默认焦点必须在 body').toBe('BODY')
    const bootMark = await operatorLogMark(page)
    const bootEntries = await pressCtrlS(page)
    const bootLive = await waitForRejection(page)
    expect(bootLive, 'boot body 的 Ctrl+S 必须真的走到保存算子（干净 ⇒ 没有可审计变更）').toContain('没有可审计的变更')
    expect(await operatorLogCountSince(page, bootMark), 'boot body 一次按键恰一次算子').toBe(1)
    expect(await ctrlSDefaultPrevented(page), 'boot body 归工作台 ⇒ preventDefault').toBe(true)
    const bootKey = lastKeydown(bootEntries)
    expect(bootKey!.level).toBe('app')
    expect(bootKey!.commandId).toBe(LOCAL_COMMAND)
    expect(await page.locator(MODAL).count(), '干净文档不得弹确认').toBe(0)

    // ── ② 真实编辑：writeField 内部 commitAndBlur ⇒ activeElement=body，所有权仍工作台 ──
    await page.evaluate(() => (window as any).__vm__.log.clearRejectionStatus())
    await writeField(page, TOOLTIP_FIELD, 'W442 宿主正路径 dirty')
    await expect(page.locator('.sb-unsaved'), '真实编辑后 Wiki 远端必须落后').toHaveCount(1, { timeout: 20_000 })
    expect(await page.evaluate(() => document.activeElement?.tagName ?? ''), 'commitAndBlur 后焦点必须回到 body').toBe('BODY')

    const requestsBefore = wiki.requests()
    const dirtyMark = await operatorLogMark(page)
    const dirtyEntries = await pressCtrlS(page)
    const confirm = page.locator(MODAL_PRIMARY, { hasText: '确认保存' })
    await expect(confirm, '编辑 blur 到 body 后 Ctrl+S 必须仍打开既有确认').toBeVisible({ timeout: 20_000 })
    expect(await operatorLogCountSince(page, dirtyMark), 'dirty 一次按键恰一次算子').toBe(1)
    expect(wiki.edits.length, '只开确认不写 Wiki').toBe(0)
    expect(wiki.requests(), '只开确认不发远端请求').toBe(requestsBefore)
    expect(await ctrlSDefaultPrevented(page)).toBe(true)
    expect(lastKeydown(dirtyEntries)!.commandId).toBe(LOCAL_COMMAND)

    // ── ③ 模态文本：Ctrl+S 归模态原生输入，不二次保存 ──
    await page.locator(MODAL_TEXTAREA).click()
    const modalMark = await operatorLogMark(page)
    const modalEntries = await pressCtrlS(page)
    const modalKey = lastKeydown(modalEntries)
    expect(modalKey!.level).toBe('modal')
    expect(modalKey!.commandId).toBeNull()
    expect(modalKey!.reason).toBe('modal-interior-native-editing')
    expect(await operatorLogCountSince(page, modalMark), '模态文本不得二次保存').toBe(0)
    expect(await ctrlSDefaultPrevented(page), '模态原生文本保留默认行为').toBe(false)
    expect(await page.locator(MODAL).count(), '确认模态仍只有一个').toBe(1)
    await page.locator(MODAL_CANCEL, { hasText: '取消' }).click()
    await expect(page.locator(MODAL)).toHaveCount(0)

    // ── ④ 菜单关闭：pointerdown 在工作台内，移除菜单后 body 仍归工作台 ──
    await openFileMenu(page)
    await closeFileMenu(page)
    await blurToBody(page)
    const menuMark = await operatorLogMark(page)
    const menuEntries = await pressCtrlS(page)
    await expect(confirm, '菜单关闭 blur 到 body 后 Ctrl+S 必须仍打开既有确认').toBeVisible({ timeout: 20_000 })
    expect(await operatorLogCountSince(page, menuMark), '菜单关闭后一次按键恰一次算子').toBe(1)
    expect(await ctrlSDefaultPrevented(page)).toBe(true)
    expect(lastKeydown(menuEntries)!.commandId).toBe(LOCAL_COMMAND)
    expect(wiki.edits.length, '菜单关闭路径仍不得写 Wiki').toBe(0)
    await page.locator(MODAL_CANCEL, { hasText: '取消' }).click()
    await expect(page.locator(MODAL)).toHaveCount(0)
  })

  test('H 真实宿主页负路径：宿主 input/blur/宿主非输入后 body 不归；点工作台恢复', async ({ page }) => {
    test.setTimeout(420_000)
    test.skip(test.info().project.name !== 'desktop-chrome', '按键矩阵固定在 desktop-chrome')

    const doc = innerDocOf(fixturePath())
    const target = firstAnnotatedCell(doc)
    const wiki = await installWikiSandbox(page, {
      indexTitle: WIKI_INDEX_TITLE,
      indexContent: readFixtureText(),
    })
    await gotoWikiHostPage(page)
    await loadWikiFixture(page)
    await selectCell(page, target.kernel, target.fileIdx)
    await waitForTexturesSettled(page)

    page.on('download', (d) => {
      void d.cancel().catch(() => {})
    })
    const requestsBefore = wiki.requests()

    // ── ① 宿主 input 真实焦点：宿主所有权 ──
    await focusHostOutsideInput(page)
    const inputMark = await operatorLogMark(page)
    const inputEntries = await pressCtrlS(page)
    expect(inputEntries.filter((e) => e.source === 'key' && e.kind === 'keydown'), '宿主 input 上的按键不得进入输入会话').toEqual([])
    expect(await ctrlSDefaultPrevented(page), '宿主 input ⇒ 不抢浏览器默认行为').toBe(false)
    expect(await operatorLogCountSince(page, inputMark), '宿主 input 不得调用保存算子').toBe(0)
    expect(await page.locator(MODAL).count()).toBe(0)
    expect(await page.locator(REJECTION_SLOT).count()).toBe(0)

    // ── ② 宿主 input blur 到 body：所有权保持 host（focusout 不改状态）──
    await blurToBody(page)
    const blurMark = await operatorLogMark(page)
    const blurEntries = await pressCtrlS(page)
    expect(blurEntries.filter((e) => e.source === 'key' && e.kind === 'keydown'), '宿主 input blur 到 body 后仍不得进入输入会话').toEqual([])
    expect(await ctrlSDefaultPrevented(page)).toBe(false)
    expect(await operatorLogCountSince(page, blurMark), '宿主 blur 后不得调用保存算子').toBe(0)
    expect(await page.locator(MODAL).count()).toBe(0)
    expect(await page.locator(REJECTION_SLOT).count()).toBe(0)

    // ── ③ 宿主非输入交互（button）后 blur 到 body：仍是宿主所有权 ──
    await clickHostOutsideButton(page)
    await blurToBody(page)
    const hostActionMark = await operatorLogMark(page)
    const hostActionEntries = await pressCtrlS(page)
    expect(hostActionEntries.filter((e) => e.source === 'key' && e.kind === 'keydown'), '宿主非输入交互后的 body 不得进入输入会话').toEqual([])
    expect(await ctrlSDefaultPrevented(page)).toBe(false)
    expect(await operatorLogCountSince(page, hostActionMark), '宿主非输入交互后不得调用保存算子').toBe(0)
    expect(await page.locator(MODAL).count()).toBe(0)
    expect(await page.locator(REJECTION_SLOT).count()).toBe(0)

    // ── ④ 点工作台 ⇒ 所有权恢复；blur 到 body 后 Ctrl+S 仍归工作台 ──
    // 用 app 根顶部空白区（不是 canvas：canvas 可能被视口覆盖层挡住，click 会等可点性）。
    await page.locator(HOST_APP).click({ position: { x: 600, y: 10 } })
    await blurToBody(page)
    const restoredMark = await operatorLogMark(page)
    const restoredEntries = await pressCtrlS(page)
    const restoredLive = await waitForRejection(page)
    expect(restoredLive, '恢复工作台所有权后必须命中同一条保存入口（干净 ⇒ 可见原因）').toContain('没有可审计的变更')
    expect(await operatorLogCountSince(page, restoredMark), '恢复后一次按键恰一次算子').toBe(1)
    expect(await ctrlSDefaultPrevented(page), '恢复后 body 归工作台 ⇒ preventDefault').toBe(true)
    expect(lastKeydown(restoredEntries)!.commandId).toBe(LOCAL_COMMAND)
    expect(await page.locator(MODAL).count()).toBe(0)
    expect(wiki.requests(), '恢复路径的干净拒绝不得发远端请求').toBe(requestsBefore)
    expect(wiki.edits.length).toBe(0)
  })

  test('I 真实宿主页 + app 外 input（Wiki 干净 + dirty）：dirty 也不弹保存确认', async ({ page }) => {
    test.setTimeout(420_000)
    test.skip(test.info().project.name !== 'desktop-chrome', '按键矩阵固定在 desktop-chrome')

    const doc = innerDocOf(fixturePath())
    const target = firstAnnotatedCell(doc)
    const wiki = await installWikiSandbox(page, {
      indexTitle: WIKI_INDEX_TITLE,
      indexContent: readFixtureText(),
    })
    await gotoWikiHostPage(page)
    await loadWikiFixture(page)
    await selectCell(page, target.kernel, target.fileIdx)
    await waitForTexturesSettled(page)

    // ── ① 干净 Wiki 文档 + app 外 input ──
    await focusHostOutsideInput(page)
    const cleanMark = await operatorLogMark(page)
    const cleanEntries = await pressCtrlS(page)
    expect(cleanEntries.filter((e) => e.source === 'key' && e.kind === 'keydown'), '宿主 input 不得进入输入会话').toEqual([])
    expect(await ctrlSDefaultPrevented(page)).toBe(false)
    expect(await operatorLogCountSince(page, cleanMark), '宿主 input 不得调用保存算子').toBe(0)
    expect(await page.locator(MODAL).count()).toBe(0)
    expect(await page.locator(REJECTION_SLOT).count(), '干净文档也不得在宿主 input 上写拒绝').toBe(0)

    // ── ② 真实编辑 ⇒ Wiki dirty（poll=true，证明不是"没内容可存"）──
    await writeField(page, TOOLTIP_FIELD, 'W442 宿主越界 dirty')
    await expect(page.locator('.sb-unsaved'), '真实编辑后 Wiki 远端必须落后').toHaveCount(1, { timeout: 20_000 })
    expect(
      await page.evaluate(() => Boolean((window as any).__vm__.getOperators().find('OPERATOR_WIKI_SAVE_CONFIRM')?.poll((window as any).__vm__))),
      '前提：dirty 时保存门必须真的可用（否则本用例没测到"会弹确认"的路径）',
    ).toBe(true)

    const requestsBefore = wiki.requests()
    await focusHostOutsideInput(page)
    const dirtyMark = await operatorLogMark(page)
    page.on('download', (d) => {
      void d.cancel().catch(() => {})
    })
    const dirtyEntries = await pressCtrlS(page)

    expect(dirtyEntries.filter((e) => e.source === 'key' && e.kind === 'keydown'), 'dirty 时宿主 input 仍不得进入输入会话').toEqual([])
    expect(await ctrlSDefaultPrevented(page), 'dirty 也不得被工作台 preventDefault').toBe(false)
    expect(await operatorLogCountSince(page, dirtyMark), 'dirty 时宿主 input 不得调用保存算子').toBe(0)
    expect(await page.locator(MODAL).count(), 'dirty 时宿主 input 不得弹保存确认').toBe(0)
    expect(await page.locator(REJECTION_SLOT).count(), 'dirty 时宿主 input 不得写拒绝').toBe(0)
    expect(wiki.requests(), 'dirty 时宿主 input 不得发远端请求').toBe(requestsBefore)
    expect(wiki.edits.length, 'dirty 时宿主 input 不得写 Wiki').toBe(0)
  })
})
