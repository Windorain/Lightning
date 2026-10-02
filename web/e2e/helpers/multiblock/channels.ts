/**
 * T2.6 无头渲染断言管线 —— **第二阶段（通道滑杆遍历）接口预留**。
 *
 * 第一阶段不驱动这些滑杆（T2.4/T2.5 并行开发中，通道 UI 断言属第二阶段）。
 * 本模块把「第二阶段要用的接缝」固化下来：选择器常量 + 观测/驱动薄封装。
 *
 * 选择器由 T2.4 作者在 `web/src/shared/viewport/MultiblockChannelPanel.vue` 文件头
 * **显式声明为 T2.6 无头断言用的稳定观测选择器**（不是本模块自行猜测的 DOM）：
 *
 * | 选择器 | 含义 |
 * |--------|------|
 * | `[data-mb-panel="channels"]` | 面板根（带 `data-mb-variant` / `-dims` / `-tier` / `-tier-min` / `-tier-max` / `-runstate`） |
 * | `[data-dock-tab="channels"]` | Dock 上的「通道」tab 按钮 |
 * | `input[data-mb-tier]` | Tier 滑杆（`min`/`max`/`step` 来自声明） |
 * | `input[data-mb-channel="<key>"]` | 通道滑杆（`0..domain.hi`；`0` = `Not set`） |
 * | `[data-mb-tier-value]` / `[data-mb-channel-value="<key>"]` | 数值文本（`0` → `Not set`） |
 * | `select[data-mb-runstate-select]` | 运行态切换（`option[data-mb-runstate-id]`） |
 * | `[data-mb-notices] [data-mb-notice]` | 只提示不拒绝的提示列表（软约束 / 回落 / 夹取） |
 *
 * 事件语义：Tier 滑杆与通道滑杆只监听 `@input`；运行态 `select` 监听 `@change`。
 * `setSliderValue()` 同时派发 `input`+`change`，因此两条路径都覆盖。
 */

import { expect, type Page } from '@playwright/test'
import { setSliderValue } from './harness'

/** 通道面板根。 */
export const CHANNEL_PANEL = '[data-mb-panel="channels"]'
/** Dock 上的「通道」tab 按钮（`data-dock-tab` 属性，T2.4 提供）。 */
export const CHANNEL_TAB = '[data-dock-tab="channels"]'
/** Tier 滑杆。 */
export const TIER_SLIDER = 'input[data-mb-tier]'
/** Tier 数值文本。 */
export const TIER_VALUE = '[data-mb-tier-value]'
/** 运行态下拉。 */
export const RUNSTATE_SELECT = 'select[data-mb-runstate-select]'
/** 提示列表项。 */
export const CHANNEL_NOTICE = '[data-mb-notices] [data-mb-notice]'

/** 某一通道的滑杆选择器。 */
export function channelSlider(key: string): string {
  return `input[data-mb-channel="${key}"]`
}

/** 某一通道的数值文本选择器。 */
export function channelValueText(key: string): string {
  return `[data-mb-channel-value="${key}"]`
}

export interface ChannelSliderObservation {
  key: string
  /** 呈现名（来自文件声明的 `channels[].name`）。 */
  name: string
  kind: string
  /** 滑杆 `min`（恒 0 = `Not set` 可及）。 */
  sliderMin: number
  /** 滑杆 `max`（= 声明取值域上界）。 */
  sliderMax: number
  /** 有效取值下界（声明 `min`）。 */
  effMin: number
  /** 有效取值上界（声明 `max`）。 */
  effMax: number
  /** 当前取值。 */
  value: number
  /** 当前数值文本（`0` → `Not set`）。 */
  valueText: string
}

export interface ChannelPanelObservation {
  present: boolean
  displayName: string | null
  /** 当前取值派生的变体键（装配器的输出观测点）。 */
  variantKey: string | null
  /**
   * 当前取值是否命中**已声明组合**（契约 §5.2 推论 1：UI 的滑杆取值域 + Tier 吸附
   * 使所有可达组合都是已声明的）。`null` = 属性缺失。
   */
  declaredVariant: boolean | null
  /** 装配结果尺寸 `w×h×d`（装配失败为空串）。 */
  dims: string | null
  tier: number | null
  tierMin: number | null
  tierMax: number | null
  /** Tier 滑杆的 `list="mb-tier-samples"` 对应的已声明抽样清单（`data-mb-tier-samples`，逗号分隔）。 */
  tierSamples: number[] | null
  tierValueText: string | null
  runstate: string | null
  runstateOptions: Array<{ id: string; name: string }>
  channels: ChannelSliderObservation[]
  notices: string[]
}

/**
 * 读回通道面板的公开 DOM 观测（面板不存在时 `present: false`）。
 *
 * 这些属性由生产组件直接渲染自 `MultiblockChannelPanelModel`
 * （内容完全来自文件声明），因此可用作「UI 忠实反映文件声明」的机器判据。
 */
export async function readChannelPanel(page: Page): Promise<ChannelPanelObservation> {
  return await page.evaluate(
    ({ panelSel, tierValueSel }) => {
      const empty: ChannelPanelObservation = {
        present: false,
        displayName: null,
        variantKey: null,
        declaredVariant: null,
        dims: null,
        tier: null,
        tierMin: null,
        tierMax: null,
        tierSamples: null,
        tierValueText: null,
        runstate: null,
        runstateOptions: [],
        channels: [],
        notices: [],
      }
      const panel = document.querySelector(panelSel) as HTMLElement | null
      if (!panel) return empty
      const num = (v: string | null): number | null => (v === null ? null : Number(v))
      const inputs = [...panel.querySelectorAll('input[data-mb-channel]')] as HTMLInputElement[]
      const channels = inputs.map((el) => {
        const key = el.getAttribute('data-mb-channel')!
        const text = panel.querySelector(`[data-mb-channel-value="${key}"]`)
        return {
          key,
          name: el.getAttribute('data-mb-channel-name') ?? '',
          kind: el.getAttribute('data-mb-channel-kind') ?? '',
          sliderMin: Number(el.min),
          sliderMax: Number(el.max),
          effMin: Number(el.getAttribute('data-mb-channel-eff-min')),
          effMax: Number(el.getAttribute('data-mb-channel-eff-max')),
          value: Number(el.value),
          valueText: (text?.textContent ?? '').trim(),
        }
      })
      const select = panel.querySelector('select[data-mb-runstate-select]') as HTMLSelectElement | null
      const options = select
        ? ([...select.querySelectorAll('option[data-mb-runstate-id]')] as HTMLOptionElement[]).map((o) => ({
            id: o.getAttribute('data-mb-runstate-id')!,
            name: (o.textContent ?? '').trim(),
          }))
        : []
      const noticeEls = [...panel.querySelectorAll('[data-mb-notices] [data-mb-notice]')]
      return {
        present: true,
        displayName: panel.getAttribute('data-mb-display-name'),
        variantKey: panel.getAttribute('data-mb-variant'),
        declaredVariant: (() => {
          const raw = panel.getAttribute('data-mb-declared')
          return raw === null ? null : raw === 'true'
        })(),
        dims: panel.getAttribute('data-mb-dims'),
        tier: num(panel.getAttribute('data-mb-tier')),
        tierMin: num(panel.getAttribute('data-mb-tier-min')),
        tierMax: num(panel.getAttribute('data-mb-tier-max')),
        tierSamples: (() => {
          const raw = panel.getAttribute('data-mb-tier-samples')
          if (raw === null) return null
          return raw
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .map((s) => Number(s))
        })(),
        tierValueText: (panel.querySelector(tierValueSel)?.textContent ?? '').trim() || null,
        runstate: panel.getAttribute('data-mb-runstate'),
        runstateOptions: options,
        channels,
        notices: noticeEls.map((e) => (e.textContent ?? '').trim()),
      } satisfies ChannelPanelObservation
    },
    { panelSel: CHANNEL_PANEL, tierValueSel: TIER_VALUE },
  )
}

/** 切到「通道」tab 并等面板挂载（第二阶段遍历前的固定起手）。 */
export async function openChannelTab(page: Page): Promise<void> {
  await expect(page.locator(CHANNEL_TAB)).toBeVisible()
  await page.locator(CHANNEL_TAB).click()
  await expect(page.locator(CHANNEL_PANEL)).toBeAttached()
}

/**
 * 切到「通道」tab 并等到面板的**装配观测**就绪（`data-mb-dims` 非空）。
 *
 * 为什么需要这一等：`data-mb-dims` 来自装配结论（`buildChannelPanelModel`），
 * 而面板的出现只要求 `decl !== null`。文档刚注入时装配可能还没跑完，
 * 此时 `data-mb-dims` 为空串——若在那一刻断言尺寸，会得到假红。
 */
export async function openChannelTabReady(page: Page, timeout = 30_000): Promise<void> {
  await openChannelTab(page)
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel)
      return !!el && (el.getAttribute('data-mb-dims') ?? '') !== ''
    },
    CHANNEL_PANEL,
    { timeout },
  )
}

/** 驱动总 Tier 滑杆（DOM 事件注入；面板的 Tier 吸附在 `useMultiblockChannels` 内）。 */
export async function setTier(page: Page, tier: number): Promise<void> {
  await setSliderValue(page, TIER_SLIDER, tier)
}

/** 驱动某一通道的滑杆（`0` = `Not set`）。 */
export async function setChannelValue(page: Page, key: string, value: number): Promise<void> {
  await setSliderValue(page, channelSlider(key), value)
}

/** 切换运行态（真实 `change` 事件，与真人选择一致）。 */
export async function setRunstate(page: Page, id: string): Promise<void> {
  const select = page.locator(RUNSTATE_SELECT)
  await expect(select).toBeAttached()
  await select.evaluate((el, v) => {
    const s = el as HTMLSelectElement
    s.value = v
    s.dispatchEvent(new Event('change', { bubbles: true }))
  }, id)
}

/** 一个组合的驱动载荷（`undefined` 字段 = 不驱动该控件，用于渐进拖动）。 */
export interface PanelDrivePayload {
  tier?: number
  /** `channelKey → 声明值`（只驱动给出的 key）。 */
  values?: Record<string, number>
  runstate?: string
}

/**
 * **批量**驱动通道面板：一次性把 Tier / 若干通道 / 运行态推到目标取值。
 *
 * 与逐个调用 `setTier`/`setChannelValue`/`setRunstate` **事件语义完全一致**
 * （同样只设 `value` 再派发 `input`（滑杆）或 `change`（下拉），由 Vue 监听器消费），
 * 区别只是把 N 次 CDP 往返压成 1 次 —— 552 组合遍历的性能关键（实测逐个驱动
 * ≈530 ms/组合，批量后 ≈50~80 ms/组合，见 README 耗时表）。
 *
 * 施加顺序（与生产者一致，避免"先写通道再写 Tier"导致通道域短暂不一致）：
 * Tier → 各通道 → 运行态。
 */
export async function drivePanel(page: Page, payload: PanelDrivePayload): Promise<void> {
  await expect(page.locator(TIER_SLIDER)).toBeAttached()
  await expect(page.locator(TIER_SLIDER)).toBeEnabled()
  await page.evaluate(
    ({ panelSel, tierSel, runstateSel, payload }) => {
      const panel = document.querySelector(panelSel)
      if (!panel) throw new Error('T2.6: 通道面板未挂载')
      const fire = (el: HTMLInputElement | HTMLSelectElement, kind: 'input' | 'change'): void => {
        el.dispatchEvent(new Event(kind, { bubbles: true }))
      }
      if (payload.tier !== undefined) {
        const el = panel.querySelector(tierSel) as HTMLInputElement | null
        if (!el) throw new Error('T2.6: Tier 滑杆未找到')
        el.value = String(payload.tier)
        fire(el, 'input')
        fire(el, 'change')
        // ⚠️ 写回模型值（可用 `data-mb-tier` 观测）：
        // Tier 滑杆**吸附**已声明抽样，且 `setTier` 在"吸附后与当前值相同"时直接返回。
        // 此时 Vue 不会重渲染，DOM 里就留着我们刚写进去的原始输入值 —— 下一次派发事件时
        // 处理函数会把那个**陈旧输入**当成新的用户输入（实测表现为"请求 2 却被吸附到 14"）。
        // 真人拖动滑杆走的是原生 value 变化路径，这里补一次同步，保证每次驱动都从
        // "面板当前真实取值"出发。
        const model = Number(panel.getAttribute('data-mb-tier'))
        if (Number.isFinite(model)) el.value = String(model)
      }
      for (const [key, value] of Object.entries(payload.values ?? {})) {
        const el = panel.querySelector(`input[data-mb-channel="${key}"]`) as HTMLInputElement | null
        if (!el) throw new Error(`T2.6: 通道滑杆未找到: ${key}`)
        el.value = String(value)
        fire(el, 'input')
        fire(el, 'change')
        // 同 Tier：写回模型当前值（`data-mb-channel-value` 文本 → 数字），避免"陈旧 DOM 输入"
        // 在 Vue 未重渲染（本次取值与模型相同）时污染下一次驱动。
        const text = panel.querySelector(`[data-mb-channel-value="${key}"]`)?.textContent?.trim() ?? ''
        el.value = text === '' || text === 'Not set' ? '0' : text
      }
      if (payload.runstate !== undefined) {
        const el = panel.querySelector(runstateSel) as HTMLSelectElement | null
        if (!el) throw new Error('T2.6: 运行态下拉未找到')
        el.value = payload.runstate
        fire(el, 'change')
      }
    },
    { panelSel: CHANNEL_PANEL, tierSel: TIER_SLIDER, runstateSel: RUNSTATE_SELECT, payload },
  )
}
