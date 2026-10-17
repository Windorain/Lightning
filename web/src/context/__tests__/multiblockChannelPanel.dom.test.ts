// @vitest-environment jsdom
/**
 * T2.4 / T2.5 验收 —— 「通道」面板与视口下方栏 tab 的 **DOM 行为**（jsdom + 真实组件，无替身）。
 *
 * 覆盖：
 *  - 通道 tab 只在多方块文档时出现；帧控制 / 分层预览 tab 与之互不干扰；
 *  - 面板条数 = 文件声明条数、标签 = 呈现名、范围 0..取值域上界、0 显示 `Not set`；
 *  - 运行态切换项来自文件声明；
 *  - 拖动滑杆 → 事件载荷正确（两端视口把同一事件转成 `setChannelValue`）；
 *  - 面板里**没有** Layer 滑杆（分层预览 tab 已有，不重复造）。
 *
 * 无框架依赖：`createApp(...).mount(el)` + 原生 DOM 断言（仓库未装 @vue/test-utils）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App } from 'vue'
import MultiblockChannelPanel from '@/shared/viewport/MultiblockChannelPanel.vue'
import ViewportFrameLayerDock from '@/shared/viewport/ViewportFrameLayerDock.vue'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import {
  assembleForSelection,
  buildChannelPanelModel,
  initialMultiblockSelection,
  type MultiblockChannelPanelModel,
} from '@/shared/viewport/multiblockChannelUi'

import ebfFixture from './fixtures/multiblock-ebf-2ch.json'
import tierOnlyFixture from './fixtures/multiblock-tier-only.json'
import minimalV2 from '../../../e2e/fixtures/minimal-v2.json'

const mounted: App[] = []
const hosts: HTMLElement[] = []

function mount(component: unknown, props: Record<string, unknown>): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(component as never, props)
  app.mount(el)
  mounted.push(app)
  hosts.push(el)
  return el
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount()
  for (const el of hosts.splice(0)) el.remove()
})

function productionRegistry() {
  const registry = createParserRegistry()
  registry.register(V2PlainParser)
  registry.register(createEnvelopeParser(registry))
  registry.register(WorldParser)
  registry.register(StructureDataParser)
  return registry
}

async function parse(raw: unknown): Promise<RuntimeDocument> {
  const res = await productionRegistry().detectAndParse(raw)
  if (!res.document) throw new Error(`fixture 解析失败：${res.error}`)
  return res.document
}

/** 文档 + 取值 → 面板模型（与两端视口 `useMultiblockChannels` 走的是同一条纯逻辑）。 */
function panelModelFor(
  doc: RuntimeDocument,
  patch: Partial<{ totalTier: number; values: Record<string, number>; runstate: string }> = {},
): MultiblockChannelPanelModel {
  const base = initialMultiblockSelection(doc.multiblock!.decl)
  const state = { ...base, ...patch, values: patch.values ?? base.values }
  return buildChannelPanelModel(doc, state, assembleForSelection(doc, state))!
}

const dockBaseProps = {
  activeTab: 'channels',
  'onUpdate:activeTab': () => {},
  // M5-1：多方块文档没有时间轴帧（帧控制 tab 只属于帧为主文档）
  hasWorldMultiFrame: false,
  worldFrameIndex: 0,
  worldFrameCount: 0,
  framesPlaybackIsPlaying: false,
  meshBusy: false,
  gridHeight: 5,
  layerWorldY: -1,
  layerPreviewLabel: 'ALL',
}

describe('T2.4 「通道」面板 DOM（真实组件）', () => {
  it('EBF：Tier 滑杆 + 每通道一条滑杆 + 运行态切换 + Not set 文本', async () => {
    const doc = await parse(ebfFixture)
    const el = mount(MultiblockChannelPanel, { model: panelModelFor(doc) })

    const panel = el.querySelector<HTMLElement>('[data-mb-panel="channels"]')!
    expect(panel).toBeTruthy()
    expect(panel.getAttribute('data-mb-display-name')).toBe('Electric Blast Furnace')
    expect(panel.getAttribute('data-mb-variant')).toBe('height:0|coil:0|glass:0|tt:2|runstate:idle')
    expect(panel.getAttribute('data-mb-dims')).toBe('3×2×3')

    const tier = el.querySelector<HTMLInputElement>('input[data-mb-tier]')!
    expect(tier.getAttribute('type')).toBe('range')
    expect(tier.min).toBe('1')
    expect(tier.max).toBe('14')
    expect(tier.step).toBe('1')
    expect(tier.value).toBe('2')
    expect(el.querySelector('[data-mb-tier-value]')!.textContent!.trim()).toBe('2')
    // 抽样值以 datalist 形式暴露（Tier 滑杆吸附目标，非业务逻辑）
    expect(panel.getAttribute('data-mb-tier-samples')).toBe('1,2,14')

    const channels = [...el.querySelectorAll<HTMLInputElement>('input[data-mb-channel]')]
    expect(channels.map((c) => c.getAttribute('data-mb-channel'))).toEqual(['height', 'coil', 'glass'])
    expect(channels.map((c) => c.min)).toEqual(['0', '0', '0'])
    expect(channels.map((c) => c.max)).toEqual(['5', '3', '2'])
    expect(channels.map((c) => c.getAttribute('data-mb-channel-kind'))).toEqual(['size', 'replace', 'replace'])
    expect(channels.map((c) => c.getAttribute('data-mb-channel-name'))).toEqual(['Height', 'Coil', 'Glass'])
    // 声明值 0 = 未设置
    for (const key of ['height', 'coil', 'glass']) {
      expect(el.querySelector(`[data-mb-channel-value="${key}"]`)!.textContent!.trim()).toBe('Not set')
    }
    expect(el.querySelector('[data-mb-channel-label="coil"]')!.textContent!.trim()).toBe('Coil')

    const runstates = [...el.querySelectorAll<HTMLOptionElement>('option[data-mb-runstate-id]')]
    expect(runstates.map((o) => o.getAttribute('data-mb-runstate-id'))).toEqual(['idle', 'active'])
    expect(runstates.map((o) => o.textContent!.trim())).toEqual(['Idle', 'Running'])
    expect(el.querySelector<HTMLSelectElement>('select[data-mb-runstate-select]')!.value).toBe('idle')

    // 提示列表（文件软约束）存在且只作提示
    expect(el.querySelectorAll('[data-mb-notices] [data-mb-notice]').length).toBeGreaterThan(0)
    // 不重复造 Layer 滑杆
    expect(el.querySelector('.wm-layer-bar')).toBeNull()
  })

  it('tier-only：只有 Tier 滑杆 + 1 条通道滑杆（无具名通道的形态）', async () => {
    const doc = await parse(tierOnlyFixture)
    const el = mount(MultiblockChannelPanel, { model: panelModelFor(doc) })
    const channels = [...el.querySelectorAll<HTMLInputElement>('input[data-mb-channel]')]
    expect(channels.map((c) => c.getAttribute('data-mb-channel'))).toEqual(['structTier'])
    expect(channels[0]!.max).toBe('3')
    expect(el.querySelector<HTMLInputElement>('input[data-mb-tier]')!.max).toBe('3')
    expect(el.querySelectorAll('option[data-mb-runstate-id]').length).toBe(1)
  })

  it('拖动滑杆 → 事件载荷正确（Tier / 通道 / 运行态）', async () => {
    const doc = await parse(ebfFixture)
    const onTier = vi.fn()
    const onValue = vi.fn()
    const onRunstate = vi.fn()
    const el = mount(MultiblockChannelPanel, {
      model: panelModelFor(doc),
      'onUpdate:tier': onTier,
      'onUpdate:value': onValue,
      'onUpdate:runstate': onRunstate,
    })

    const coil = el.querySelector<HTMLInputElement>('input[data-mb-channel="coil"]')!
    coil.value = '3'
    coil.dispatchEvent(new Event('input', { bubbles: true }))
    expect(onValue).toHaveBeenCalledWith({ key: 'coil', value: 3 })

    const tier = el.querySelector<HTMLInputElement>('input[data-mb-tier]')!
    tier.value = '14'
    tier.dispatchEvent(new Event('input', { bubbles: true }))
    expect(onTier).toHaveBeenCalledWith(14)

    const select = el.querySelector<HTMLSelectElement>('select[data-mb-runstate-select]')!
    select.value = 'active'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onRunstate).toHaveBeenCalledWith('active')
  })
})

describe('T2.5 下方栏 tab（真实组件）', () => {
  it('多方块文档：出现「通道」tab 并渲染面板；**不出现帧控制 tab**（场景不参与播放）', async () => {
    const doc = await parse(ebfFixture)
    const onUpdate = vi.fn()
    const el = mount(ViewportFrameLayerDock, {
      ...dockBaseProps,
      channelPanel: panelModelFor(doc),
      'onUpdate:activeTab': onUpdate,
    })

    // M5-1：多方块文档没有时间轴帧（场景清单 ≠ 时间轴）⇒ 帧控制 tab 不属于它。
    const tabs = [...el.querySelectorAll<HTMLElement>('.vp-dock__tab')]
    expect(tabs.map((t) => t.getAttribute('data-dock-tab'))).toEqual(['channels', 'layer'])
    expect(el.querySelector('[data-dock-panel="channels"]')).toBeTruthy()
    expect(el.querySelector('[data-mb-status]')).toBeTruthy()
    expect(el.querySelector('.vp-dock__tab--active')!.getAttribute('data-dock-tab')).toBe('channels')
    // 状态行：帧那一项缺席（没有帧轴），层与通道项按既有顺序
    const stats = [...el.querySelectorAll<HTMLElement>('.vp-dock__stat')]
    expect(stats[0]!.textContent, '无帧轴 ⇒ 状态行首项是「层」').toContain('层')
    expect(stats[1]!.getAttribute('data-mb-status')).not.toBeNull()
    expect(el.textContent, '多方块文档不得出现「帧」状态读数').not.toContain('帧 ')
  })

  it('帧为主文档：通道 tab 不出现，帧控制/分层预览照旧', async () => {
    const doc = await parse(minimalV2)
    expect(doc.isMultiblock).toBe(false)
    const el = mount(ViewportFrameLayerDock, {
      ...dockBaseProps,
      // 帧为主文档才是时间轴的拥有者 ⇒ 多帧时有帧控制 tab。
      hasWorldMultiFrame: true,
      worldFrameCount: 2,
      activeTab: 'frame',
      channelPanel: null,
    })
    const tabs = [...el.querySelectorAll<HTMLElement>('.vp-dock__tab')]
    expect(tabs.map((t) => t.getAttribute('data-dock-tab'))).toEqual(['frame', 'layer'])
    expect(el.querySelector('[data-dock-panel="channels"]')).toBeNull()
    expect(el.querySelector('.vp-dock__tab--active')!.getAttribute('data-dock-tab')).toBe('frame')
  })

  it('面板值文本随模型刷新（0 → Not set；非 0 → 数字）', async () => {
    const doc = await parse(ebfFixture)
    const el = mount(MultiblockChannelPanel, {
      model: panelModelFor(doc, { totalTier: 14, values: { height: 5, coil: 3, glass: 0 }, runstate: 'active' }),
    })
    expect(el.querySelector('[data-mb-channel-value="height"]')!.textContent!.trim()).toBe('5')
    expect(el.querySelector('[data-mb-channel-value="coil"]')!.textContent!.trim()).toBe('3')
    expect(el.querySelector('[data-mb-channel-value="glass"]')!.textContent!.trim()).toBe('Not set')
    expect(el.querySelector<HTMLInputElement>('input[data-mb-tier]')!.value).toBe('14')
    expect(el.querySelector('[data-mb-tier-value]')!.textContent!.trim()).toBe('14')
    expect(el.querySelector<HTMLSelectElement>('select[data-mb-runstate-select]')!.value).toBe('active')
    expect(el.querySelector('[data-mb-panel="channels"]')!.getAttribute('data-mb-runstate')).toBe('active')
  })
})
