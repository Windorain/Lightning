/**
 * M5-5 打回 · **模态内部是普通 DOM**（真实指针 / 真实键盘 / 真实焦点）。
 *
 * ## 缺陷（用户手测暴露，探针定位）
 *
 * 设置抽屉打开后 select **点不开**：输入层把"阻断背景"实现为对**所有**未捕获
 * 指针事件 preventDefault，不区分"点在模态背景"与"点在模态自己 DOM 里"。
 * 按钮靠 click 侥幸可用；原生 select / 文本框 / checkbox 吃 pointerdown 的默认行为
 * （焦点、下拉）⇒ 全部失效且**无任何报错**。同族缺陷在 WikiModalsHost（保存摘要
 * textarea、picker 搜索框）与 keydown 面上（模态内按键被 preventDefault ⇒ 一个字也打不进去）。
 *
 * ## 本 spec 证什么（每条**能红**）
 *
 * | # | 判据 | 修复前的失败形态 |
 * |---|---|---|
 * | 1 | 真鼠标点抽屉里的 select ⇒ document.activeElement 是它 | 焦点恒停在模态外的「设置」按钮 |
 * | 2 | 该 select 用键盘 ArrowDown 改值；再选「示例·电力高炉」⇒ 加载生效 | 键盘事件被吞 / 选不中 |
 * | 3 | 抽屉里文本框（SDE apiBase）可焦点、**可键入**（断言字符真的进了 value） | 焦点不进 / 字符不进 |
 * | 4 | wiki 保存模态的 textarea 可焦点、可键入 | 同上 |
 * | 5 | **负对照**：真实指针点在模态**根之外** ⇒ 仍被吞（modal-blocks-pointer + defaultPrevented） | 若改成"一律放行"本条判红 |
 * | 6 | 关闭抽屉后同坐标点击恢复路由（阻断是**作用域内**的，不是全局关掉） | —— |
 *
 * 判据 5 用**产品端口** openModalScope({ root }) 登记一个测试自己的小根元素
 * （全屏遮罩的抽屉本身没有"根之外"的可点区域），因此走的仍是生产判定路径。
 */
import { expect, test, type Page } from '@playwright/test'
import { gotoWorkbench, VIEWPORT_CANVAS, waitForDocLoaded } from './helpers/multiblock'

interface PointerProbe {
  readonly defaultPrevented: boolean
  readonly target: string
  readonly x: number
  readonly y: number
}

/** 最近一次 pointerdown 是否被 preventDefault（window 冒泡阶段读数：document 之后）。 */
async function installPointerProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any
    w.__pointerProbe__ = []
    window.addEventListener(
      'pointerdown',
      (e) => {
        w.__pointerProbe__.push({
          defaultPrevented: e.defaultPrevented,
          target: (e.target as HTMLElement)?.className ?? '',
          x: e.clientX,
          y: e.clientY,
        })
      },
      { passive: true },
    )
  })
}

async function lastPointerProbe(page: Page): Promise<PointerProbe> {
  return await page.evaluate(() => {
    const list = (window as any).__pointerProbe__ as PointerProbe[]
    return list[list.length - 1]!
  })
}

/** 最近一条指针路由记录的 reason（公开诊断面 inputPort.trace）。 */
async function lastPointerReason(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const trace = (window as any).__vm__.wm.inputPort.trace as Array<{ source: string; reason: string }>
    for (let i = trace.length - 1; i >= 0; i--) {
      if (trace[i]!.source === 'pointer') return trace[i]!.reason
    }
    return ''
  })
}

async function activeTag(page: Page): Promise<string> {
  return await page.evaluate(() => (document.activeElement as HTMLElement | null)?.tagName ?? '')
}

async function openSettingsDrawer(page: Page): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.locator('.drawer-panel')).toBeVisible()
}
test.describe('M5-5 打回 · 模态内部可交互（抽屉 / wiki 模态 / 背景负对照）', () => {
  test('抽屉：真实鼠标点 select ⇒ 获得焦点；选中值生效；文本框可键入', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', '真实指针与原生下拉固定在 desktop-chrome')
    test.setTimeout(120_000)
    await gotoWorkbench(page)
    await installPointerProbe(page)
    await openSettingsDrawer(page)

    // ── 内置示例模式（select 所在面板）────────────────────────────────────
    await page.locator('.drawer-panel').getByRole('button', { name: '内置示例', exact: true }).click()
    const select = page.locator('.drawer-panel select.dash-select')
    await expect(select).toBeVisible()

    // ① 真鼠标点击 ⇒ 原生 select 获得焦点（修复前恒为模态外的「设置」按钮）
    await select.click()
    expect(await activeTag(page), '原生 select 必须获得焦点（否则下拉永远打不开）').toBe('SELECT')
    expect((await lastPointerProbe(page)).defaultPrevented, '模态内部的 pointerdown 不得被 preventDefault').toBe(false)
    expect(await lastPointerReason(page)).toBe('modal-interior-passthrough')

    // ② 选中值生效（键盘路径由下面的文本框键入独立证明：两者都吃 pointerdown/keydown 默认行为）
    await select.selectOption('builtin-multiblock-ebf')
    await expect(select).toHaveValue('builtin-multiblock-ebf')
    await page.locator('.drawer-panel').getByRole('button', { name: '加载到工作台' }).click()
    await waitForDocLoaded(page)
    expect(await page.evaluate(() => (window as any).__vm__.hasLoadedDocument()), '选中的内置样例必须真的被加载').toBe(true)
    await page.locator('.drawer-panel').getByRole('button', { name: '关闭' }).click()
    await expect(page.locator('.drawer-panel')).toBeHidden()

    // ⑥ 关闭后：同坐标点击恢复路由（阻断是作用域内的）
    const box = (await page.locator(VIEWPORT_CANVAS).boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    expect(await lastPointerReason(page), '抽屉关闭后指针必须恢复为正常区域路由').toMatch(/^pointer-(down|up)$/)
    expect((await lastPointerProbe(page)).defaultPrevented, '无模态时普通鼠标 down 不该被吞').toBe(false)

    // ③ 抽屉里的文本框可焦点、可键入（SDE 远程面板）
    await openSettingsDrawer(page)
    await page.locator('.drawer-panel').getByRole('button', { name: 'SDE 远程', exact: true }).click()
    const apiBase = page.locator('.drawer-panel input[type="text"]').first()
    await expect(apiBase).toBeVisible()
    await apiBase.click()
    expect(await activeTag(page)).toBe('INPUT')
    const textBefore = await apiBase.inputValue()
    await page.keyboard.type('abc')
    await page.waitForTimeout(50)
    expect(await apiBase.inputValue(), '模态内的按键必须真的插入字符（keydown 不得被 preventDefault）').toBe(textBefore + 'abc')

    // ④ 同面板的密码框（路径相同，单独确认一次：它不被上面的 type=text 选择器覆盖）
    const token = page.locator('.drawer-panel input[type="password"]').first()
    await token.click()
    expect(await activeTag(page)).toBe('INPUT')
    await page.keyboard.type('tok')
    await page.waitForTimeout(50)
    expect(await token.inputValue(), '密码框同样必须收到字符').toBe('tok')
  })
  test('wiki 保存模态：textarea 可焦点、可键入（同族缺陷的第二个落点）', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', '真实指针与焦点固定在 desktop-chrome')
    test.setTimeout(120_000)
    await gotoWorkbench(page)
    await installPointerProbe(page)

    // 打开 wiki 保存模态（wikiUi 是公开 chrome 状态面；直接置状态以隔离 wiki 后端可用性，
    // 判定路径与真人操作完全相同）。
    await page.evaluate(() => {
      const ui = (window as any).__vm__.wm.chrome.wikiUi
      ui.saveConfirm.value = { defaultSummary: '', planPartCount: 0, planMode: 'single' }
      ui.modal.value = 'save-confirm'
    })
    const textarea = page.locator('.wiki-modal textarea.wiki-modal__textarea').first()
    await expect(textarea).toBeVisible()

    await textarea.click()
    expect(await activeTag(page), 'wiki 模态里的 textarea 必须获得焦点').toBe('TEXTAREA')
    expect((await lastPointerProbe(page)).defaultPrevented, '模态内部 pointerdown 不得被吞').toBe(false)

    await page.keyboard.type('m5-notes')
    await page.waitForTimeout(50)
    expect(await textarea.inputValue(), 'textarea 必须真的接收到字符').toBe('m5-notes')

    // 关闭（产品动作：取消按钮 —— 同时证明按钮路径没被这次修复碰坏）
    await page.locator('.wiki-modal').getByRole('button', { name: '取消' }).click()
    await expect(page.locator('.wiki-modal')).toHaveCount(0)
  })

  test('负对照：真实指针点在模态根**之外**仍被吞（模态语义不回潮）', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', '真实指针固定在 desktop-chrome')
    test.setTimeout(120_000)
    await gotoWorkbench(page)
    await installPointerProbe(page)

    // 用**产品端口**登记一个根元素只有 120×60 的模态（全屏遮罩的抽屉没有"根之外"可点区域）。
    await page.evaluate(() => {
      const ctx = (window as any).__vm__
      const el = document.createElement('div')
      el.id = 'probe-modal-root'
      el.style.cssText = 'position:fixed;left:10px;top:10px;width:120px;height:60px;background:#123;z-index:60000'
      document.body.appendChild(el)
      const unbind = ctx.wm.requireInputPort().openModalScope({
        scopeId: 'probe-modal',
        blocksBackground: true,
        root: () => el,
      })
      ;(window as any).__probeUnbind__ = () => {
        unbind()
        el.remove()
      }
    })

    // 根内部：放行（换了根元素也成立 ⇒ 判定看的是"命中哪个根"，不是硬编码抽屉）
    await page.mouse.click(40, 30)
    expect(await lastPointerReason(page), '探针模态内部的点击也必须是内部判定').toBe('modal-interior-passthrough')
    expect((await lastPointerProbe(page)).defaultPrevented).toBe(false)

    // 根之外（工作区中央，远离 10..130 / 10..70 的探针根）：仍被吞
    await page.mouse.click(600, 420)
    expect((await lastPointerProbe(page)).defaultPrevented, '模态根之外的 pointerdown 必须仍被 preventDefault（阻断背景的正当语义）').toBe(true)
    expect(await lastPointerReason(page)).toBe('modal-blocks-pointer')

    await page.evaluate(() => (window as any).__probeUnbind__())
  })

  test('**回归负对照**：撤掉根元素（模拟修复前）⇒ 同一个 select 立刻拿不到焦点', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', '真实指针固定在 desktop-chrome')
    test.setTimeout(120_000)
    await gotoWorkbench(page)
    await installPointerProbe(page)
    await openSettingsDrawer(page)
    await page.locator('.drawer-panel').getByRole('button', { name: '内置示例', exact: true }).click()

    // 修复前语义：模态**没有根元素** ⇒ 所有未捕获指针事件都按背景吞。
    // 用公开端口的方法级替身表达（不改源码、不碰生产分支），证明上一条判据真的由这一维承载。
    await page.evaluate(() => {
      const port = (window as any).__vm__.wm.requireInputPort()
      port.modalRootElementOf = () => null
    })

    const select = page.locator('.drawer-panel select.dash-select')
    await select.click()
    expect(await activeTag(page), '没有根元素 ⇒ 焦点不得落到 select（这正是修复前的形态）').not.toBe('SELECT')
    expect((await lastPointerProbe(page)).defaultPrevented, '没有根元素 ⇒ pointerdown 被吞').toBe(true)
  })
})
