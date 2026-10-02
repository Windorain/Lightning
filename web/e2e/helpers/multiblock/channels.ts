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
  /** 装配结果尺寸 `w×h×d`（装配失败为空串）。 */
  dims: string | null
  tier: number | null
  tierMin: number | null
  tierMax: number | null
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
        dims: null,
        tier: null,
        tierMin: null,
        tierMax: null,
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
        dims: panel.getAttribute('data-mb-dims'),
        tier: num(panel.getAttribute('data-mb-tier')),
        tierMin: num(panel.getAttribute('data-mb-tier-min')),
        tierMax: num(panel.getAttribute('data-mb-tier-max')),
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
