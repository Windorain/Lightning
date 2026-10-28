// @vitest-environment jsdom
/**
 * **生产菜单**服从算子 poll：灰显 + 原因 + 点击不 invoke（DOM 判据）。
 *
 * ## 为什么这条判据必须喂"生产 layout"
 *
 * 菜单项不是手拼的：本文件调用 `menuBarPanel.layout(ctx)`（**生产**面板声明）拿到
 * `UILayout`，再交给**生产**渲染器 `ReadonlyLayout` → `UIMenu.vue`。
 * 于是判据覆盖的是"用户在文件菜单里看到的那一份 items"，包括 `menuBar` 的
 * wiki 分支（`wiki.upload` 能力 + `mwReady`）—— 手拼一份 items 就证明不了这一点。
 *
 * 同理，算子来自**生产注册表**（`registerWorkbenchOperators`），不是替身。
 *
 * ## 钉的四件事
 *
 * 1. **不可用 ⇒ native disabled + 原因**（title/aria/data 三处同源），且**点击不 invoke**；
 * 2. **可用 ⇒ 不灰**（正对照：否则"灰掉"可能只是把整个菜单废掉了）；
 * 3. **求值次数**：只在"打开菜单 / items 变化"时每项求值**一次**；反复重渲染不追加；
 * 4. **无旁路**：即使有人绕过 native `disabled` 直接派发 click 事件，也**不** invoke
 *    （组件内的守卫；registry 侧还有一次 poll 作为最终防线，见 `operatorAvailability.test`）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, shallowRef, type App } from 'vue'
import ReadonlyLayout from '@/workbench/ux/ReadonlyLayout.vue'
import { menuBarPanel } from '@/workbench/ux/panels/menuBar'
import { provideContext } from '@/runtime/context'
import { WikiSaveConfirmOperator, WikiSaveAsOperator } from '@/operators/builtin/wikiOperators'
import { operatorAvailability } from '@/operators/availability'
import { LOG_LEVEL } from '@/logging/LogCenter'
import type { UILayout, UIMenu } from '@/workbench/ux/types/layout'
import type { Context } from '@/runtime/context'
import { makeAvailabilityHost, PLAIN_FIXTURE, type AvailabilityHost, type AvailabilityScenario } from '@/operators/__tests__/availabilityTestHost'

/** 生产菜单栏布局里的**文件菜单**（按本实例语言取标签，不硬编码"文件"）。 */
function fileMenuOf(ctx: Context, layout: UILayout): UIMenu {
  if (layout.kind !== 'row') throw new Error('菜单栏布局应为 row')
  const label = ctx.getShellSettings().t('file')
  const menu = layout.items.find((item) => item.kind === 'menu' && item.label === label)
  if (menu === undefined || menu.kind !== 'menu') throw new Error('生产布局里没有文件菜单（标签：' + label + '）')
  return menu
}

interface Mounted {
  readonly app: App
  readonly el: HTMLElement
  /** 关/开菜单（真实点击菜单按钮）。 */
  toggle(): Promise<void>
  /** 让 `items` 变化（布局重算 ⇒ 新的 items 引用，与生产 relayout 同形）。 */
  refreshLayout(): Promise<void>
  /** 只触发一次重渲染（items 引用**不变**）—— 用来证明"渲染循环里没有求值"。 */
  rerender(): Promise<void>
}

const apps: App[] = []
const hosts: HTMLElement[] = []

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
  for (const el of hosts.splice(0)) el.remove()
})

function mountMenu(ctx: Context): Mounted {
  const layout = shallowRef<UILayout>(menuBarPanel.layout(ctx))
  const tick = ref(0)
  const Root = defineComponent({
    setup() {
      provideContext(ctx)
      return () => h('div', [
        h(ReadonlyLayout, { layout: layout.value }),
        // 与菜单无关的响应式依赖：改它只触发**重渲染**，不改变任何 props 引用。
        h('span', { 'data-tick': String(tick.value) }, ''),
      ])
    },
  })
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(Root)
  app.mount(el)
  apps.push(app)
  hosts.push(el)
  const menuButton = el.querySelector<HTMLButtonElement>('.ux-menu-btn')!
  return {
    app,
    el,
    async toggle() {
      menuButton.click()
      await nextTick()
    },
    async refreshLayout() {
      layout.value = menuBarPanel.layout(ctx)
      await nextTick()
    },
    async rerender() {
      tick.value += 1
      await nextTick()
    },
  }
}

/** 文件菜单里某个算子项（生产布局里的 id）。 */
function itemOf(host: Mounted, opId: string): HTMLButtonElement {
  const el = host.el.querySelector<HTMLButtonElement>(`.ux-menu-item[data-op-id="${opId}"]`)
  if (el === null) throw new Error('菜单项不在场：' + opId)
  return el
}

/** 给指定算子装上**计数**（委托给生产 poll/pollReason，不替换判定）。 */
function countPolls(host: AvailabilityHost, opId: string): { poll: number; reason: number } {
  const counter = { poll: 0, reason: 0 }
  const op = host.registry.find(opId)
  if (op === undefined) throw new Error('前提：算子必须在生产注册表里：' + opId)
  const origPoll = op.poll
  const origReason = op.pollReason
  if (origPoll === undefined) throw new Error('前提：该算子必须有 poll')
  host.registry.register({
    ...op,
    poll: (ctx) => {
      counter.poll += 1
      return origPoll(ctx)
    },
    ...(origReason === undefined
      ? {}
      : {
          pollReason: (ctx) => {
            counter.reason += 1
            return origReason(ctx)
          },
        }),
  })
  return counter
}

/** 直接读共享结算的结论（生产函数；用于"前提"断言）。 */
function operatorAvailabilityProbe(host: AvailabilityHost, opId: string): boolean {
  const op = host.registry.find(opId)
  if (op === undefined) throw new Error('前提：算子必须在册：' + opId)
  return operatorAvailability(host.ctx, op).enabled
}

/** 让指定算子的 `poll` **抛错**（委托形态：只把异常的来源钉住，不改其它逻辑）。 */
function makePollThrow(host: AvailabilityHost, opId: string): void {
  const op = host.registry.find(opId)
  if (op === undefined || op.poll === undefined) throw new Error('前提：算子必须在册且有 poll：' + opId)
  host.registry.register({
    ...op,
    poll() {
      throw new Error('probe: poll 故意抛错')
    },
  })
}

/** 统计经 `ctx.getOperators().invoke` 的调用次数（门面包装；不改执行路径）。 */
function countInvokes(ctx: Context): { value: number } {
  const counter = { value: 0 }
  const registries = (ctx.main as unknown as { registries: Record<string, unknown> }).registries
  const facade = registries.operatorsFacade as {
    invoke: (...args: unknown[]) => unknown
  }
  registries.operatorsFacade = {
    ...(registries.operatorsFacade as Record<string, unknown>),
    invoke: (...args: unknown[]) => {
      counter.value += 1
      return facade.invoke(...args)
    },
  }
  return counter
}

async function mountWith(scenario: AvailabilityScenario): Promise<{ host: AvailabilityHost; ui: Mounted }> {
  // DOM 判据用纯 plain 夹具：`pako` 的信封解包在 jsdom 下不可用（见 host 的说明），
  // 而本判据与信封编码无关。
  const host = await makeAvailabilityHost(scenario, { fixture: PLAIN_FIXTURE })
  return { host, ui: mountMenu(host.ctx) }
}

describe('生产文件菜单：算子 poll=false 时灰显 + 原因 + 不可点', () => {
  it('非 Wiki 载入文档：保存项 disabled、原因指向"另存为 Wiki 结构"、点击/派发 click 都不 invoke', async () => {
    const { host, ui } = await mountWith('local-file')
    try {
      // ── 前提：items 来自生产布局，且 wiki 三项确实在文件菜单里 ──
      const fileMenu = fileMenuOf(host.ctx, menuBarPanel.layout(host.ctx))
      const ids = fileMenu.items.filter((i) => i.kind === 'operator').map((i) => (i.kind === 'operator' ? i.id : ''))
      expect(ids, '前提：生产文件菜单必须包含 Wiki 三项（否则下面的断言无处落地）').toEqual(
        expect.arrayContaining([WikiSaveConfirmOperator.id, WikiSaveAsOperator.id]),
      )

      const polls = countPolls(host, WikiSaveConfirmOperator.id)
      const invokes = countInvokes(host.ctx)

      // ── 未打开：**不**求值（菜单关着没有理由付这份开销） ──
      expect(polls.poll, '菜单关着时不得求值 poll').toBe(0)

      await ui.toggle()

      // ── ① 打开 ⇒ 每项求值一次 ──
      expect(polls.poll, '打开菜单 ⇒ 对每项求值恰好一次').toBe(1)
      expect(polls.reason, 'poll=false ⇒ 求值一次 pollReason（给出可行动原因）').toBe(1)

      // ── ② native disabled + 原因三处同源 ──
      const saveItem = itemOf(ui, WikiSaveConfirmOperator.id)
      expect(saveItem.disabled, 'poll=false ⇒ 菜单项必须 native disabled（不是"能点然后没反应"）').toBe(true)
      expect(saveItem.getAttribute('aria-disabled'), 'aria 必须与 native disabled 一致').toBe('true')
      const reason = saveItem.getAttribute('data-unavailable-reason') ?? ''
      expect(reason, '原因必须说清为什么（不是 Wiki 载入的结构数据）').toContain('Wiki')
      expect(reason, '原因必须给出下一步：另存为 Wiki 结构').toContain('另存为 Wiki 结构')
      expect(saveItem.getAttribute('title') ?? '', 'title 必须带同一句原因（悬停可见）').toContain(reason)
      expect(saveItem.getAttribute('aria-label') ?? '', '可访问名也要带同一句原因（tooltip 对读屏不可靠）').toContain(reason)

      // ── ③ 点击不 invoke（两种都试：原生 click + 直接派发事件） ──
      saveItem.click()
      saveItem.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await nextTick()
      expect(invokes.value, '点击不可用项**不得** invoke（"点了没反应"之外也不许偷偷执行）').toBe(0)
      expect(host.wikiUi.modal.value, '不得打开保存确认模态').toBeNull()

      // ── ④ 反复重渲染**不**追加求值（渲染循环里没有 poll） ──
      await ui.rerender()
      await ui.rerender()
      await ui.rerender()
      expect(polls.poll, '重渲染不得重新求值（poll 可能有 plainForSave 差集开销）').toBe(1)

      // ── ⑤ items 变化（生产 relayout 的形态）⇒ 重算一次 ──
      await ui.refreshLayout()
      expect(polls.poll, '菜单开着且 items 换了 ⇒ 重算一次（不靠渲染次数）').toBe(2)
      expect(itemOf(ui, WikiSaveConfirmOperator.id).disabled, '换 items 后结论不变（仍是不可用）').toBe(true)
    } finally {
      host.dispose()
    }
  })

  it('关闭再打开 ⇒ 重新求值一次（缓存不跨次打开复用）', async () => {
    const { host, ui } = await mountWith('local-file')
    try {
      const polls = countPolls(host, WikiSaveConfirmOperator.id)
      await ui.toggle()
      expect(polls.poll).toBe(1)
      await ui.toggle()
      expect(polls.poll, '关闭菜单不求值').toBe(1)
      await ui.toggle()
      expect(polls.poll, '重新打开 ⇒ 按当前事实重新求值一次').toBe(2)
    } finally {
      host.dispose()
    }
  })
})

describe('生产文件菜单：可用项**不**灰（正对照）', () => {
  it('Wiki 载入且有可审计变更 ⇒ 保存项 enabled、无"不可用"原因', async () => {
    const { host, ui } = await mountWith('wiki-dirty')
    try {
      const polls = countPolls(host, WikiSaveConfirmOperator.id)
      await ui.toggle()
      expect(polls.poll, '可用项的 poll 也必须被求值（否则"可用"可能是没算）').toBe(1)
      const saveItem = itemOf(ui, WikiSaveConfirmOperator.id)
      expect(saveItem.disabled, '有变更 ⇒ 保存项必须可点（否则灰显没有区分力）').toBe(false)
      expect(saveItem.getAttribute('aria-disabled'), '可用项不得带 aria-disabled').toBeNull()
      expect(saveItem.getAttribute('data-unavailable-reason'), '可用项不得带不可用原因').toBeNull()
      expect(saveItem.getAttribute('title') ?? '', '可用项的 title 不得声称不可用').not.toContain('不可用')
    } finally {
      host.dispose()
    }
  })

  it('Wiki 载入但无变更 ⇒ 保存项灰显且原因是"没有可审计的变更"（不是"另存为"）', async () => {
    const { host, ui } = await mountWith('wiki-clean')
    try {
      await ui.toggle()
      const saveItem = itemOf(ui, WikiSaveConfirmOperator.id)
      expect(saveItem.disabled).toBe(true)
      const reason = saveItem.getAttribute('data-unavailable-reason') ?? ''
      expect(reason, '原因必须是"没有可审计的变更"').toContain('没有可审计的变更')
      expect(reason, '两类不可用的下一步不同：这条不得指向"另存为"').not.toContain('另存为')
    } finally {
      host.dispose()
    }
  })
})

describe('生产文件菜单：单项 poll 抛错不得拖垮整份菜单（逐项异常隔离）', () => {
  it('坏项 disabled + 通用原因 + error 日志；其它项照常；点击仍不 invoke', async () => {
    const { host, ui } = await mountWith('wiki-dirty')
    try {
      // 前提：这个场景下保存项本来是**可用**的（否则下面"变成不可用"没有区分力）
      const before = operatorAvailabilityProbe(host, WikiSaveConfirmOperator.id)
      expect(before, '前提：未注入异常时保存项应可用').toBe(true)

      makePollThrow(host, WikiSaveConfirmOperator.id)
      const invokes = countInvokes(host.ctx)

      await ui.toggle()

      // ① 菜单**照样打开**（一个坏项不得让整份菜单崩掉）
      expect(ui.el.querySelectorAll('.ux-menu-item').length, '菜单必须仍然渲染出全部菜单项').toBeGreaterThan(5)

      // ② 坏项：disabled + **通用**原因（不编造业务原因）
      const bad = itemOf(ui, WikiSaveConfirmOperator.id)
      expect(bad.disabled, '结算抛错的项必须 disabled（不得表现为可用）').toBe(true)
      const reason = bad.getAttribute('data-unavailable-reason') ?? ''
      expect(reason, '通用原因：只说"前提不满足"，不编造具体业务原因').toContain('前提')
      expect(reason, '不得把"另存为"这下一步贴到一个结算失败的项上').not.toContain('另存为')
      expect(reason, '不得把异常文本当原因贴给用户').not.toContain('probe')

      // ③ 其它项不受影响：一个永远可用的生产项仍可用
      const other = itemOf(ui, 'OPERATOR_OPEN_SCENE')
      expect(other.disabled, '其它项必须照常结算（坏项不得污染邻居）').toBe(false)
      expect(other.getAttribute('data-unavailable-reason'), '其它项不得被写上不可用原因').toBeNull()

      // ④ 点击坏项不 invoke
      bad.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await nextTick()
      expect(invokes.value, '点击结算失败的项不得 invoke').toBe(0)
      expect(host.wikiUi.modal.value, '不得打开保存确认模态').toBeNull()

      // ⑤ 异常被记录（可见/可诊断），且**一次求值一条**
      const errors = host.log.entries.value.filter((e) => e.level === LOG_LEVEL.ERROR && e.message.includes('availability failed'))
      expect(errors.length, '抛错必须留下一条 error 日志（不许静默）').toBe(1)
      expect((errors[0]!.detail as { opId?: string }).opId, '日志必须点名是哪个算子').toBe(WikiSaveConfirmOperator.id)

      // ⑥ 关→开：每次求值各记一条（不随重渲染繁殖）
      await ui.toggle()
      await ui.rerender()
      expect(
        host.log.entries.value.filter((e) => e.message.includes('availability failed')).length,
        '关着的时候（含重渲染）不得再记',
      ).toBe(1)
      await ui.toggle()
      expect(
        host.log.entries.value.filter((e) => e.message.includes('availability failed')).length,
        '重新打开 ⇒ 重新求值 ⇒ 再记一条（每条对应一次求值）',
      ).toBe(2)
    } finally {
      host.dispose()
    }
  })
})

describe('菜单文案本地化（en 不混中文）', () => {
  it('en 实例：不可用项的 title 全英文（词与原因句都随语言）', async () => {
    // ⚠️ 语言必须在**布局求值之前**设好：菜单标签由 `menuBarPanel.layout(ctx)` 按本实例语言生成。
    const host = await makeAvailabilityHost('local-file', { fixture: PLAIN_FIXTURE })
    try {
      host.settings.setLang('en')
      const ui = mountMenu(host.ctx)
      await ui.toggle()

      const save = itemOf(ui, WikiSaveConfirmOperator.id)
      expect(save.disabled, '前提：该场景下保存项不可用（否则没有 title 可判）').toBe(true)
      const title = save.getAttribute('title') ?? ''
      expect(title, '英文实例必须用英文"不可用"（i18n 键 operatorUnavailable）').toContain('unavailable')
      expect(title, '不得残留硬编码中文（词）').not.toContain('不可用')
      expect(title, '原因句也必须随语言（rejectionText 按 lang 成句）').toContain('use "Save as new structure')
      expect(title, '整条 title 里不得出现任何中日韩字符').not.toMatch(/[\u4e00-\u9fff]/)
      expect(save.getAttribute('aria-label'), 'aria-label 与 title 同源').toBe(title)
    } finally {
      host.dispose()
    }
  })
})