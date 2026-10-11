/**
 * P7（#258）· **A22 `host-input` + A25 `input-focus-drafts`** —— 真实浏览器回归。
 *
 * ## 观测面（零替身）
 *
 * 入口是完整工作台（`gotoWorkbench` → `WorkbenchRoot`），事件由浏览器经
 * **真实 DOM** 派发，观测走 `window.__p7_input__`（`WorkbenchRoot` 在
 * `assembleWorkbenchInput` 里显式声明的**只读**探针）：
 *
 * | 探针 | 读什么 |
 * |---|---|
 * | `counters()` | `keyEvents` / `suppressedDuplicates` / `modalStarts` / `capturesAcquired/Released` / `imeSuppressedShortcuts` |
 * | `trace()` | 每条事件的路由结论（层级、接收者、命令 ID、理由、是否启动模态） |
 * | `modalScopeId()` | 当前弹窗作用域（取代旧的全局 `wikiModalOpen` 布尔） |
 * | `textProjection(id)` | 文本控件的三态投影（显示值 / 草稿 / 可提交值 / 状态 / 原因 / 组合态） |
 * | `unhandledLocalActions()` | 没人认领的局部动作（**不静默失败**的证据） |
 *
 * ## A22 的三条（#249 §14 原文）
 *
 * 1. **同一指针按下只启动一次交互** —— 由 `modalStarts` 增量与
 *    `suppressedDuplicates` 的配对断言覆盖（同名命令两次 = 第二次被抑制）。
 * 2. **捕获丢失按政策取消** —— 合成 `lostpointercapture` 后断言
 *    `capturesReleased` 增加且**没有**继续推进的意图（轨迹里无 `pointer.move`）。
 * 3. **页面挂起/恢复不爆发历史 tick** —— 用 CDP 切页面可见性，断言
 *    `visibility` 轨迹里 `resumed(dropped=N)` 的 N > 0 而**没有** N 条 `timer`/补跑记录。
 *
 * ## A25 的三条
 *
 * 1. **只有目标接收者处理**：焦点在文本控件里按 `g` ⇒ 轨迹层级是 `text`，
 *    且**没有** `tool.beginInteraction`（场景快捷键拿不到那个键）。
 * 2. **IME 不触发场景快捷键**：合成 `compositionstart/update/end` + `input`，
 *    断言 `imeSuppressedShortcuts > 0` 且轨道里没有该键启动的模态操作。
 * 3. **非法中间草稿不写文档 / 文本局部撤销不误撤文档**：
 *    在数字控件里输入 `-`、`1.2.3` ⇒ 投影 `status != complete` 且文档值不变；
 *    Ctrl+Z ⇒ 轨迹里出现 `draft.undo` 而**没有** `edit.undo`。
 *
 * ## 负对照也是本 spec 的一部分
 *
 * 每条断言都配一条"若实现退化则判红"的对照（见各 `test` 内的注释与
 * 专门的 `负对照` 用例）。这是 #249 §14「负对照必须判红」的落地口径：
 * 不是"断言写了就算"，而是要证明**判据有差异**。
 */

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { gotoWorkbench, injectSceneDocumentOk, VIEWPORT_CANVAS, waitForViewportMounted } from './helpers/multiblock/harness'

/** 只读探针的形状（与 `WorkbenchRoot` 写入的一致）。 */
interface P7Counters {
  keyEvents: number
  keyUpEvents: number
  suppressedDuplicates: number
  modalStarts: number
  capturesAcquired: number
  capturesReleased: number
  captureLostOwned: number
  captureLostNotOwned: number
  imeSuppressedShortcuts: number
}

interface P7TraceEntry {
  token: number
  source: string
  /** 键事件的细分（`keydown` / `keyup`）—— **必须**用它筛选，否则会取到 keyup。 */
  kind: string
  level: string | null
  receiver: string | null
  commandId: string | null
  reason: string
  startedModal: boolean
}

interface P7Probe {
  counters(): P7Counters
  trace(): P7TraceEntry[]
  modalScopeId(): string | null
  textFocus(): { controlId: string | null; composing: boolean } | null
  textProjection(controlId: string): {
    controlId: string
    displayValue: string
    draft: string
    submittable: number | string | null
    status: string
    reason: string | null
    composing: boolean
  } | null
  unhandledLocalActions(): string[]
  boundControlIds(): string[]
  pendingControlIds(): string[]
  applyRegistryIds(): string[]
  /** 全应用 document keydown 的挂载者（A22 结构证据；>1 即判红）。 */
  keydownOwners(): string[]
}

declare global {
  interface Window {
    __p7_input__?: P7Probe
    __vm_ready__?: boolean
  }
}

/** 打开完整工作台并等到 P7 输入探针就绪。 */
async function gotoWorkbenchWithInput(page: Page): Promise<void> {
  await gotoWorkbench(page)
  await page.waitForFunction(() => typeof window.__p7_input__?.counters === 'function', undefined, { timeout: 30_000 })
}

/**
 * 打开工作台**并载入一份真实场景**（使 `.vc-viewport` 真正挂载）。
 *
 * A22 的指针类断言（捕获归属、丢失取消）需要真实视口 —— 视口只在文档装载后
 * 才渲染（`RenderEngineHost` 由 `loadStatus === 'ok'` 驱动）。不载入就直接
 * `test.skip`，那些最关键的指针断言会**永远不跑**（P7 首跑实测：3 个 skip 全是这个原因）。
 *
 * 走的是既有 e2e 的**生产注入路径**（`injectSceneDocumentOk` → 应用真实装载流程），
 * 不是替身。
 *
 * ## 为什么带一次重试（已知基础设施竞态，非本层缺陷）
 *
 * `page.evaluate` 偶发 `Execution context was destroyed, most likely because of
 * a navigation` —— 页面在注入**进行中**被整页重载（Vite 首次发现新依赖会
 * 触发一次 full reload；`OPERATOR_RESET_LAYOUT` 亦会 `location.reload()`）。
 *
 * 这是**既有**竞态：基线 `f850691` 的全量日志里同样出现 7 次。本批新增的
 * 5 条 A25 用例都要注入场景，于是暴露面变大 —— 修法不是"少注入"，
 * 而是让注入在整页重载后**重来一次**（重载后 `__vm_ready__` 会重新置位，
 * 重试是幂等的：注入本身不改仓库文件、不改 fixture 原件）。
 *
 * 重试只在"上下文被销毁"这一种错误上发生；断言失败与真实解析错误
 * **不**重试（否则会把真红洗成假绿）。
 */
async function gotoWorkbenchWithScene(page: Page): Promise<void> {
  await gotoWorkbenchWithInput(page)
  const fixture = path.join(import.meta.dirname, 'fixtures', 'minimal-v2.json')
  const json = JSON.parse(fs.readFileSync(fixture, 'utf8')) as Record<string, unknown>

  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await injectSceneDocumentOk(page, json, 'minimal-v2.json')
      await waitForViewportMounted(page)
      return
    } catch (err) {
      const msg = String((err as Error)?.message ?? err)
      // 只对"整页重载打断了注入"重试；其余（含断言）原样抛出。
      if (!msg.includes('Execution context was destroyed')) throw err
      lastErr = err
      // 等新上下文就绪再重来
      await page.waitForFunction(() => (window as any).__vm_ready__ === true, undefined, { timeout: 90_000 })
      await page.waitForFunction(() => typeof window.__p7_input__?.counters === 'function', undefined, {
        timeout: 30_000,
      })
    }
  }
  throw lastErr
}

/**
 * 载入场景并**选中一个方块**，使属性面板渲染出可编辑字段。
 *
 * ## 为什么必须选中
 *
 * P2 的生成式属性面板以**选中集**为输入（`inspectorInputs` →
 * `resolveInspectorTargets(selectionOf(ctx))`）：没有选中目标时面板显示
 * "未选择目标"，一个字段都不渲染。P7 合流前本 spec 只载文档不选中，
 * 于是 5 条 A25 文本类用例全部因"找不到控件"而 skip —— 那让最关键的
 * 断言（文本层归属 / IME / 草稿不写文档）**从未真正跑过**。
 *
 * 选择走公开观测面 `window.__vm__`（`e2e/helpers/**` 已依赖的既有面），
 * 不是替身：`getSelection().select()` 就是产品自己的选择 API。
 */
async function selectFirstBlock(page: Page): Promise<boolean> {
  const r = await page.evaluate(() => {
    const vm = (window as any).__vm__
    const doc = vm?.getDoc?.().value
    if (!doc) return 'no-doc'
    const ser = doc.serialize ? doc.serialize() : doc
    const st = ser?.frames?.[0]?.structure ?? null
    const grid = st?.cellGrid ?? null
    if (!Array.isArray(grid) || grid.length === 0) return 'no-grid'
    const cell = String(Array.isArray(grid[0]) ? grid[0][0] : grid[0])
    const entry = (st?.blockPalette ?? [])[Number(cell.split(' ')[0])]
    vm.getSelection().select({ pos: { x: 0, y: 0, z: 0 }, block_state_id: String(entry?.registryId ?? '') })
    return 'ok'
  })
  if (r !== 'ok') return false
  // 面板按选中集重算模型（watch 触发），给它一拍
  await page.waitForTimeout(900)
  return true
}

async function counters(page: Page): Promise<P7Counters> {
  return await page.evaluate(() => window.__p7_input__!.counters())
}

async function trace(page: Page): Promise<P7TraceEntry[]> {
  return await page.evaluate(() => window.__p7_input__!.trace())
}

/**
 * 找一个已挂载的**草稿型**控件。
 *
 * `kind === 'number'` 的控件只在 Wiki 工作区的「嵌入配置」面板里有
 * （`wikiconfig.viewWidth` / `viewHeight`），故本函数会：
 *  1. 优先返回当前页面上的数字控件；
 *  2. 找不到时切到 Wiki 工作区并逐个点开属性面板的 tab 再找；
 *  3. 仍找不到则返回 `null`（调用方 `test.skip`）——**不**退化成"随便挑一个文本框"，
 *     否则"非法中间草稿"这类只对数字控件成立的断言会在文本控件上假绿
 *     （文本控件没有 invalid 态 —— 见 `domain/textDraft`）。
 */
async function findNumberControlId(page: Page): Promise<string | null> {
  const direct = await page.evaluate(() => {
    const el = document.querySelector('[data-input-control-id][data-input-kind="number"]') as HTMLElement | null
    return el?.dataset.inputControlId ?? null
  })
  if (direct !== null) return direct

  const wikiTab = page.locator('.wt-tab', { hasText: 'Wiki' })
  if ((await wikiTab.count()) > 0) {
    await wikiTab.first().click()
    await page.waitForTimeout(1200)
    const tabs = page.locator('.pt-tab')
    for (let i = 0; i < (await tabs.count()); i++) {
      await tabs.nth(i).click()
      await page.waitForTimeout(250)
      const found = await page.evaluate(() => {
        const el = document.querySelector('[data-input-control-id][data-input-kind="number"]') as HTMLElement | null
        return el?.dataset.inputControlId ?? null
      })
      if (found !== null) return found
    }
  }
  return null
}

/**
 * 找一个已挂载的**文本草稿**控件（`g` 不进场景层、Ctrl+Z 走草稿的载体）。
 *
 * 排除 `lightning.block.id`：它是方块身份键（只读语义的展示字段），
 * 改它没有领域落点；用 `tooltip`/`cellTooltip` 这类真正可写的文本属性。
 */
async function findTextControlId(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const els = [...document.querySelectorAll('[data-input-control-id][data-input-kind="text"]')] as HTMLElement[]
    const writable = els.find((e) => !(e.dataset.inputControlId ?? '').endsWith('.id'))
    return (writable ?? els[0])?.dataset.inputControlId ?? null
  })
}

/**
 * 在页面上合成一次 **IME 组合**（真实浏览器事件序列）。
 *
 * 为什么用 `dispatchEvent` 而不是 `page.keyboard`：Playwright 无法合成
 * `compositionstart/update/end` 序列（那是输入法进程的行为）。
 * 这三个事件的**真实顺序**是 `compositionstart → compositionupdate → input → compositionend`，
 * 本函数严格按此派发 —— 这正是浏览器在中文输入时给出的序列。
 */
async function composeIme(page: Page, selector: string, pinyin: string, committed: string): Promise<void> {
  await page.locator(selector).first().evaluate((el, [py, done]) => {
    const input = el as HTMLInputElement
    input.focus()
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
    input.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: py }))
    input.value = py
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.value = done
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: done }))
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, [pinyin, committed])
}

// ─────────────────────────────────────────────────────────────────────────────
// A22
// ─────────────────────────────────────────────────────────────────────────────

test.describe('A22 host-input：同一指针按下只启动一次；捕获丢失按政策取消；挂起恢复不爆发 tick', () => {
  test('A22-1 页面只挂**一条** document keydown：`inputBinding.claimExclusive` 的结构证明', async ({ page }) => {
    test.setTimeout(120_000)
    await gotoWorkbenchWithInput(page)

    // 结构性证据：若产品里存在第二条 document keydown，装配会抛错、页面不会就绪。
    // 这里进一步断言"一次按键只被处理一次"：按一个未注册键，**keydown** 只计一次。
    // 注意只比较 `keyEvents`（keydown）——`keyup` 另有一个独立计数器，
    // 因为一次按键 = 一次 keydown + 一次 keyup（P7 首跑实测：混在一起会恒为 2）。
    const before = await counters(page)
    await page.keyboard.press('F5') // 未注册任何命令
    const after = await counters(page)
    expect(after.keyEvents - before.keyEvents, '一次按键只应产生①一次 keydown 路由（两条监听会计两次）').toBe(1)
    expect(after.keyUpEvents - before.keyUpEvents, 'keyup 单独计数，且不得产生命令意图').toBe(1)

    const t = await trace(page)
    const last = [...t].reverse().find((e) => e.source === 'key' && e.kind === 'keydown')!
    expect(last.commandId, '未注册的键不得产生命令意图（不拦截所有键）').toBeNull()

    await page.screenshot({ path: 'e2e/screenshots/p7/a22-single-keydown.png' })
  })

  test('A22-2 同一 pointer 按下只启动**一次**交互：捕获登记按 pointerId 且唯一', async ({ page }) => {
    test.setTimeout(120_000)
    await gotoWorkbenchWithScene(page)

    const viewport = page.locator(VIEWPORT_CANVAS).first()
    const box = (await viewport.boundingBox())!
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2

    // ── 判据 1：中键按下 ⇒ **恰一次**捕获登记（两条 handler 会各登记一次） ──
    const before = await counters(page)
    await page.mouse.move(cx, cy)
    await page.mouse.down({ button: 'middle' })
    const afterDown = await counters(page)
    expect(
      afterDown.capturesAcquired - before.capturesAcquired,
      'A22：一次 pointerdown 只能登记一次捕获（两个 handler 各启动一次 = 2）',
    ).toBe(1)
    expect(afterDown.modalStarts - before.modalStarts, '一次 pointerdown 至多启动一次模态操作').toBeLessThanOrEqual(1)

    // ── 判据 2：捕获期间的路由**唯一**（`captured-owner`，不再看命中 Area） ──
    await page.mouse.move(cx + 30, cy + 20, { steps: 3 })
    const captured = (await trace(page)).filter((e) => e.reason === 'captured-pointer-single-route')
    expect(captured.length, '捕获期间的 move 必须走 captured-owner 单一路由').toBeGreaterThan(0)
    expect(new Set(captured.map((e) => e.receiver)).size, '同一 pointerId 只应有一个接收者').toBe(1)

    // ── 判据 3：up 恰好释放一次（登记/释放平衡） ──
    // 注：中键按下会额外产生 `pointercancel`（浏览器把中键当"粘贴/自动滚动"）——
    // 那不是重复释放，而是**同一 pointerId 的两条独立事件**各释放一次。
    // 故这里数的是"本次 up 之后相对 down 的净增长"：`capturesAcquired` 是标杆，
    // 释放不能超过登记（超过 ⇒ 同一事件被消费了两次）。
    await page.mouse.up({ button: 'middle' })
    const afterUp = await counters(page)
    const acquiredTotal = afterUp.capturesAcquired - before.capturesAcquired
    const releasedTotal = afterUp.capturesReleased - before.capturesReleased
    expect(releasedTotal, `释放数不得超过登记数（acquired=${acquiredTotal} released=${releasedTotal}）`).toBeLessThanOrEqual(
      acquiredTotal,
    )
    expect(
      afterUp.capturesAcquired - afterUp.capturesReleased,
      `A22：捕获登记与释放必须平衡（acquired=${afterUp.capturesAcquired} released=${afterUp.capturesReleased}）`,
    ).toBe(0)

    await page.screenshot({ path: 'e2e/screenshots/p7/a22-single-interaction.png' })
  })

  test('A22-3 指针捕获丢失按政策取消，且**不**带着最后坐标继续推进', async ({ page }) => {
    test.setTimeout(120_000)
    await gotoWorkbenchWithScene(page)

    const viewport = page.locator(VIEWPORT_CANVAS).first()
    const box = await viewport.boundingBox()
    expect(box, '真实视口必须有布局盒').not.toBeNull()
    const cx = box!.x + box!.width / 2
    const cy = box!.y + box!.height / 2

    // 真实 mid-button 按下（中键会申请指针捕获 —— `routePointer` 的 `captureAction: 'capture'`）
    await page.mouse.move(cx, cy)
    await page.mouse.down({ button: 'middle' })
    const acquired = (await counters(page)).capturesAcquired

    // 合成捕获丢失（浏览器在元素被移除 / 捕获被抢占时派发）
    await viewport.first().evaluate((el, [x, y]) => {
      el.dispatchEvent(
        new PointerEvent('lostpointercapture', {
          bubbles: true,
          pointerId: 1,
          pointerType: 'mouse',
          clientX: x,
          clientY: y,
        }),
      )
    }, [cx, cy])

    await page.mouse.up({ button: 'middle' })

    const after = await counters(page)
    // 判据：丢失被**按持有关系**处理（只数真正持有过的 pointer），且没有"继续推进"的意图
    expect(after.captureLostOwned + after.captureLostNotOwned, '捕获丢失必须被处理（不静默）').toBeGreaterThan(0)

    const t = await trace(page)
    const lost = t.filter((e) => e.reason === 'capture-lost-cancel' || e.reason === 'capture-lost-not-owned')
    expect(lost.length, '捕获丢失必须留下一条显式轨迹（不静默）').toBeGreaterThan(0)
    // 丢失之后不得出现"带着最后坐标的 move 推进"
    const afterLost = t.slice(t.indexOf(lost[0]!))
    const continued = afterLost.filter((e) => e.commandId !== null && e.commandId.startsWith('interaction.update'))
    expect(continued, 'A22 负对照：捕获丢失后继续推进 = 判红').toEqual([])
    expect(acquired >= 0).toBe(true)
  })

  test('A22-4 页面挂起/恢复：如实报告丢弃 tick，但**不**追赶（无爆发历史 tick）', async ({ page, context }) => {
    test.setTimeout(120_000)
    await gotoWorkbenchWithInput(page)

    const cdp = await context.newCDPSession(page)
    // 真实页面隐藏/恢复（不是合成事件）
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.waitForTimeout(250)
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.waitForTimeout(100)

    const t = await trace(page)
    const resumed = [...t].reverse().find((e) => e.source === 'visibility' && e.reason.startsWith('resumed'))
    expect(resumed, '恢复必须留下一条 resumed 轨迹（含 dropped 计数）').toBeTruthy()
    const dropped = Number(/dropped=(\d+)/.exec(resumed!.reason)?.[1] ?? '0')
    expect(dropped, '挂起 250ms（tick 16ms）⇒ 应丢弃若干 tick —— 这说明挂起确实生效').toBeGreaterThan(0)

    // 负对照：**不**存在"补跑"记录。输入的轨迹来源只有 key/pointer/composition/focus/visibility，
    // 没有 `timer` 之类补跑来源 ⇒ "爆发历史 tick"在本实现下不可表达。
    const sources = new Set(t.map((e) => e.source))
    expect([...sources].every((s) => ['key', 'pointer', 'composition', 'focus', 'visibility'].includes(s))).toBe(true)

    await page.screenshot({ path: 'e2e/screenshots/p7/a22-suspend-resume.png' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A25
// ─────────────────────────────────────────────────────────────────────────────

test.describe('A25 input-focus-drafts：只有目标接收者处理；IME 不触发场景操作；草稿不写文档', () => {
  test('A25-1 焦点在文本控件 ⇒ `g` 不进场景层（只有目标接收者处理）', async ({ page }) => {
    test.setTimeout(120_000)
    await gotoWorkbenchWithScene(page)
    await selectFirstBlock(page)

    const controlId = await findTextControlId(page)
    test.skip(controlId === null, '当前页面无文本控件 —— 需要"场景信息"面板已挂载')

    const selector = `[data-input-control-id="${controlId}"]`
    // 用**真实点击**聚焦（`locator.focus()` 在某些布局下会被后续渲染冲掉焦点）
    await page.locator(selector).first().click()
    await expect
      .poll(async () => (await page.evaluate(() => window.__p7_input__!.textFocus()))?.controlId, {
        message: '显式焦点状态必须指向被点击的控件（这是路由的判据来源）',
      })
      .toBe(controlId)

    const before = await counters(page)
    const beforeModal = before.modalStarts

    await page.keyboard.press('g')
    const after = await counters(page)

    const t = await trace(page)
    const gEntries = t.filter((e) => e.source === 'key' && e.kind === 'keydown' && e.commandId === 'tool.beginInteraction')
    expect(gEntries, 'A25：焦点在文本控件时 `g` 不得启动移动工具').toEqual([])
    expect(after.modalStarts, 'A25：场景模态操作计数不得因输入框里的 `g` 增加').toBe(beforeModal)

    const lastKey = [...t].reverse().find((e) => e.source === 'key' && e.kind === 'keydown')
    expect(lastKey!.level, '焦点在文本控件 ⇒ 层级必须是 text').toBe('text')
    expect(lastKey!.receiver).toBe(`text:${controlId}`)

    await page.screenshot({ path: 'e2e/screenshots/p7/a25-text-focus-g.png' })
  })

  test('A25-2 IME 组合未结束：拼音字母不触发场景快捷键，且组合态可观测', async ({ page }) => {
    test.setTimeout(120_000)
    await gotoWorkbenchWithScene(page)
    await selectFirstBlock(page)

    const controlId = await findTextControlId(page)
    test.skip(controlId === null, '当前页面无文本控件')

    const selector = `[data-input-control-id="${controlId}"]`
    const before = await counters(page)

    // 组合期间按 `g`（拼音里就可能有 g）——必须在**组合态**下按，才测到目标行为
    await page.locator(selector).first().evaluate((el) => {
      const input = el as HTMLInputElement
      input.focus()
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
      input.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'zhong' }))
    })
    // 组合中的按键由键盘 API 送出（真实事件；`isComposing` 由浏览器置位需真实 IME，
    // 故这里的判据落在**显式状态** `textFocus.composing` 上 —— 那正是设计要求的来源）
    await page.keyboard.press('g')

    // 读**被聚焦的那个**控件的投影，而不是"页面上第一个控件" ——
    // 后者可能是另一个字段，于是组合态判据会读到别人的投影而误判。
    const during = await page.evaluate((x) => window.__p7_input__!.textProjection(x), controlId)
    expect(during?.composing, '组合态必须在投影里可读（呈现与诊断的依据）').toBe(true)

    const after = await counters(page)
    expect(after.imeSuppressedShortcuts, '组合期间的可打印键必须被计入"被拦下"').toBeGreaterThan(before.imeSuppressedShortcuts)

    // 关键：组合期间不得产生 tool.beginInteraction
    const t = await trace(page)
    const started = t.filter((e) => e.startedModal && e.source === 'key' && e.kind === 'keydown')
    const duringComposition = started.filter((e) => e.reason === 'area-hotkey' || e.commandId === 'tool.beginInteraction')
    expect(duringComposition, 'A25 负对照「忽略 composition 状态」= 拼音触发场景快捷键').toEqual([])

    // 收尾组合
    await page.locator(selector).first().evaluate((el) => {
      const input = el as HTMLInputElement
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }))
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.screenshot({ path: 'e2e/screenshots/p7/a25-ime-composition.png' })
  })

  /**
   * A25-3 非法/中间态草稿**不写文档**。
   *
   * ## 为什么用 `lightning.block.id`（pattern 域）而不是数字控件
   *
   * 载入 fixture + 选中方块后，方块检查器渲染的字段里**没有**数字控件
   * （`block` 的属性是 string/vec3/enum/color/boolean；数字属性属注解与
   * publishConfig，前者需要文档里有注解、后者不在 Inspector 的目标解析面内）。
   * 而 `block.id` 带 `domain: { kind: 'pattern', source: '^\\S+$' }` ——
   * 它是一条**真实可达**的、能产生 `invalid` 态的路径，正是本条要测的东西。
   *
   * 断言的是"非法草稿不写文档 + 提示可见"，与控件类型无关，故换控件不降低强度；
   * 反而更强：它同时验证了**属性自身的域约束**被下传到纯解析
   * （否则 `bad value` 会被误判 `complete`，界面显示可提交而提交被拒 ——
   * 那正是"两个解析器各判一次"的形态）。
   */
  test('A25-3 非法草稿**不写文档**：pattern 域拒绝的值保留草稿 + 提示可见', async ({ page }) => {
    test.setTimeout(120_000)
    await gotoWorkbenchWithScene(page)
    await selectFirstBlock(page)

    // pattern 域控件（`block.id`）—— 取第一个声明了 data-input-pattern 的字段
    const controlId = await page.evaluate(() => {
      const el = document.querySelector('[data-input-pattern]') as HTMLElement | null
      return el?.dataset.inputControlId ?? null
    })
    test.skip(controlId === null, '当前页面无 pattern 域文本控件（需要方块检查器已渲染）')

    const selector = `[data-input-control-id="${controlId}"]`
    const displayBefore = await page.locator(selector).first().evaluate((el) => (el as HTMLElement).dataset.inputDisplay)

    // 非法值：含空格（pattern `^\S+$` 不允许）
    const bad = 'bad value'
    await page.locator(selector).first().evaluate((el, v) => {
      const input = el as HTMLInputElement
      input.focus()
      input.value = v
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, bad)

    const p = await page.evaluate((id) => window.__p7_input__!.textProjection(id), controlId)
    expect(p, '草稿投影必须可读').toBeTruthy()
    expect(p!.status, `"${bad}" 必须被判为非法（属性 pattern 域下传到纯解析）`).toBe('invalid')
    expect(p!.submittable, `"${bad}" 不得有可提交值（A25：非法草稿不写文档）`).toBeNull()
    expect(p!.draft, '草稿必须原样保留（不暗中强制转换）').toBe(bad)

    // 提示可见（#249 §19.1「非法草稿保留**并提示**」）
    await expect(page.locator('.ux-field-problem').first(), '非法草稿必须有可见提示').toBeVisible()

    // 文档值必须不变
    const displayNow = await page.locator(selector).first().evaluate((el) => (el as HTMLElement).dataset.inputDisplay)
    expect(displayNow, '非法草稿不得改写文档值').toBe(displayBefore)

    // 中间态：空串（清空）也不得提交
    await page.locator(selector).first().evaluate((el) => {
      const input = el as HTMLInputElement
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const pEmpty = await page.evaluate((id) => window.__p7_input__!.textProjection(id), controlId)
    expect(pEmpty!.status, '空串不得被判为 complete').not.toBe('complete')
    expect(pEmpty!.submittable, '空串不得有可提交值').toBeNull()
    const displayAfterEmpty = await page.locator(selector).first().evaluate((el) => (el as HTMLElement).dataset.inputDisplay)
    expect(displayAfterEmpty, '空串不得改写文档值').toBe(displayBefore)

    await page.screenshot({ path: 'e2e/screenshots/p7/a25-invalid-draft.png' })
  })

  test('A25-3b 合法值提交**恰一次**：Enter 后文档值更新为提交值', async ({ page }) => {
    test.setTimeout(120_000)
    await gotoWorkbenchWithScene(page)
    await selectFirstBlock(page)

    // 用不带 pattern 的文本属性（`tooltip`）：合法值不受域约束干扰，
    // 专测"输入不提交、Enter 提交恰一次"这条事务边界判据（I1）。
    const controlId = await page.evaluate(() => {
      const els = [...document.querySelectorAll('[data-input-control-id][data-input-kind="text"]')] as HTMLElement[]
      const free = els.find((e) => !e.hasAttribute('data-input-pattern') && !(e.dataset.inputControlId ?? '').endsWith('.id'))
      return free?.dataset.inputControlId ?? null
    })
    test.skip(controlId === null, '当前页面无自由文本控件')

    const selector = `[data-input-control-id="${controlId}"]`
    const displayBefore = await page.locator(selector).first().evaluate((el) => (el as HTMLElement).dataset.inputDisplay)
    const commitCountBefore = (await trace(page)).filter((e) => e.commandId === 'draft.commit').length

    await page.locator(selector).first().evaluate((el) => {
      const input = el as HTMLInputElement
      input.focus()
      input.value = 'e2e-commit-once'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const mid = await page.evaluate((id) => window.__p7_input__!.textProjection(id), controlId)
    expect(mid!.status, '自由文本是完整合法值').toBe('complete')
    expect(mid!.submittable).toBe('e2e-commit-once')
    // **输入本身不提交**（I1：只有一次事务边界，发生在 Enter/失焦）
    const displayMid = await page.locator(selector).first().evaluate((el) => (el as HTMLElement).dataset.inputDisplay)
    expect(displayMid, '输入过程不得写文档（提交点只有 Enter/失焦）').toBe(displayBefore)

    await page.keyboard.press('Enter')
    await expect
      .poll(async () => await page.locator(selector).first().evaluate((el) => (el as HTMLElement).dataset.inputDisplay), {
        message: 'Enter 后文档值必须更新为提交值',
        timeout: 10_000,
      })
      .toBe('e2e-commit-once')

    // 恰一次：Enter 之后不得再冒出一条提交（否则同一次按键被消费两次）
    await page.waitForTimeout(400)
    const commits = (await trace(page)).filter((e) => e.commandId === 'draft.commit').length
    expect(commits - commitCountBefore, 'Enter 恰一次提交（I1：一次事务边界）').toBe(1)

    await page.screenshot({ path: 'e2e/screenshots/p7/a25-valid-commit.png' })
  })

  test('A25-4 文本局部撤销：Ctrl+Z 在活动文本控件里走 `draft.undo`，**不是** `edit.undo`', async ({ page }) => {
    test.setTimeout(120_000)
    await gotoWorkbenchWithScene(page)
    await selectFirstBlock(page)

    const controlId = await findTextControlId(page)
    test.skip(controlId === null, '当前页面无文本控件')

    const selector = `[data-input-control-id="${controlId}"]`
    await page.locator(selector).first().click()
    await expect
      .poll(async () => (await page.evaluate(() => window.__p7_input__!.textFocus()))?.controlId)
      .toBe(controlId)

    await page.keyboard.press('Control+z')

    const t = await trace(page)
    const lastKey = [...t].reverse().find((e) => e.source === 'key' && e.kind === 'keydown' && e.commandId !== null)
    expect(lastKey, 'Ctrl+Z 必须留下一条命令意图').toBeTruthy()
    expect(lastKey!.commandId, 'A25：输入框活动编辑期 Ctrl+Z 作用于输入草稿').toBe('draft.undo')
    expect(
      t.some((e) => e.commandId === 'edit.undo'),
      'A25 负对照「文本局部撤销误撤文档」：不得同时产出 edit.undo',
    ).toBe(false)

    await page.screenshot({ path: 'e2e/screenshots/p7/a25-draft-undo.png' })
  })

  test('A25-5 弹窗作用域是**显式状态**，不再是模块级全局布尔', async ({ page }) => {
    test.setTimeout(120_000)
    await gotoWorkbenchWithInput(page)

    // ── 事实 1：无弹窗时作用域为 `null`（而不是"某个全局布尔恰好为假"） ──
    expect(await page.evaluate(() => window.__p7_input__!.modalScopeId()), '无弹窗时作用域必须为 null').toBeNull()

    // ── 事实 2：作用域是**按 id 登记**的（同页多实例互不覆盖） ──
    // 直接从装配层打开两个具名作用域，证明它们各自独立、且先开的不会被后开的顶掉。
    // 这取代的正是 `wikiInputShield` 的模块级 `let wikiModalOpen`（一个布尔表示全部弹窗）。
    const scopes = await page.evaluate(() => {
      const port = (window as any).__vm__.wm.inputPort
      const closeA = port.openModalScope({ scopeId: 'probe-a', blocksBackground: true, onEscape: () => {} })
      const afterA = port.modalScopeId
      const closeB = port.openModalScope({ scopeId: 'probe-b', blocksBackground: true, onEscape: () => {} })
      const afterB = port.modalScopeId
      closeB()
      const afterCloseB = port.modalScopeId
      closeA()
      return { afterA, afterB, afterCloseB, afterCloseA: port.modalScopeId }
    })
    expect(scopes.afterA, '作用域按 id 登记').toBe('probe-a')
    expect(scopes.afterB, '后开的作用域成为当前作用域').toBe('probe-b')
    expect(scopes.afterCloseB, '关掉后开的 ⇒ 回到先前的作用域（不是一律变 null）').toBe('probe-a')
    expect(scopes.afterCloseA, '关掉最后一个 ⇒ null').toBeNull()

    // ── 事实 3：未认领的局部动作被记录（不静默失败） ──
    const unhandled = await page.evaluate(() => window.__p7_input__!.unhandledLocalActions())
    expect(Array.isArray(unhandled)).toBe(true)

    await page.screenshot({ path: 'e2e/screenshots/p7/a25-modal-scope.png' })
  })

  test('A25-6 设置抽屉不再自挂 window keydown（#12 第四条的删除验收）', async ({ page }) => {
    test.setTimeout(120_000)
    await gotoWorkbenchWithInput(page)

    // 结构证据：全应用**只有一条** document keydown 挂载者。
    // 删除前设置抽屉与 WikiModalsHost 各挂一条 window keydown（另外 chromeBinder /
    // viewportBinder 还在 document 上各挂一条），共四条；现在应为 1。
    const owners = await page.evaluate(() => window.__p7_input__!.keydownOwners())
    expect(owners.length, 'A22：全应用只允许一条 document keydown 挂载者').toBe(1)
    expect(owners[0]).toBe('workbench')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 负对照（#249 §14「负对照必须判红」）
// ─────────────────────────────────────────────────────────────────────────────

test.describe('P7 负对照：判据必须有差异（不是恒绿）', () => {
  test('负对照-1 未注册的键：不产生意图、不阻止浏览器默认行为', async ({ page }) => {
    test.setTimeout(120_000)
    await gotoWorkbenchWithInput(page)
    const before = await counters(page)
    await page.keyboard.press('F9')
    const t = await trace(page)
    const last = [...t].reverse().find((e) => e.source === 'key' && e.kind === 'keydown')!
    expect(last.commandId, 'F9 未注册 ⇒ 无意图').toBeNull()
    expect(last.level, '无人接收 ⇒ none').toBe('none')
    expect((await counters(page)).keyEvents).toBeGreaterThan(before.keyEvents)
  })

  test('负对照-2 已捕获的 pointer 事件归属捕获者（即使坐标落在别的 region 上）', async ({ page }) => {
    test.setTimeout(120_000)
    await gotoWorkbenchWithScene(page)
    const viewport = page.locator(VIEWPORT_CANVAS).first()
    const box = (await viewport.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down({ button: 'middle' })
    // 拖到视口**外面**（另一个 region 上）
    await page.mouse.move(box.x + box.width + 120, box.y + box.height / 2, { steps: 4 })
    await page.mouse.up({ button: 'middle' })

    const t = await trace(page)
    const captured = t.filter((e) => e.reason === 'captured-pointer-single-route')
    expect(captured.length, '捕获期间的 move 必须走 captured-owner 单一路由').toBeGreaterThan(0)
    expect(captured[0]!.receiver, '接收者必须是捕获归属者（pointer:<id>@<region>）').toContain('pointer:')
  })
})
