// @vitest-environment jsdom
/**
 * B-3 统计栏 DOM 行为（jsdom + 真实组件，无替身）：**左栏纯物品展示**。
 *
 * 契约：http://127.0.0.1:3300/Lightning/lightning/wiki/%E9%83%A8%E4%BB%B6%E6%95%B0%E6%8D%AE%E5%A5%91%E7%BA%A6
 *   （§2.2 物品索引表、§9 已废弃）。
 *
 * 覆盖：
 *  - **移除锁**：无视图切换 UI（无 `部件物品/宿主/自定义` 标签、无工具条、无配置来源徽标、
 *    无 provenance 面板、无分组标题）；
 *  - 物品行：行 = 物品身份键、名称 = 游戏内显示名、数量 = 物品件数、固定数量降序；
 *  - `items: []` 无物品部件提示行保留；
 *  - **兼容兜底**：残留本机配置（`lightning:stats:v1:*`，含损坏/schema 不符/不可用视图）与残留
 *    文档配置（`statsTemplate` / `statsOverride`）⇒ 静默忽略：不空栏、不报错、不读写本机键；
 *  - **图标通道不变**：`partIconTextures` prop → `setPartIconTextureSource` →
 *    `ensurePartIcons(物品身份键)`；部件模式**不**走宿主 `ensure`（无宿主行）；
 *  - **事件通道**：物品行照发 `tooltip-hover`（payload = 物品身份键）；**点选走 B-5 的
 *    `select-item`**（payload = 行键 + 当前可见顺序 + 修饰键，语义由 `pure/itemSelection.ts`
 *    在上层裁决），旧文件宿主行的 `select-block` 通道不受影响；
 *  - **B-5 选中态**：`--selected` / `data-stats-selected` 由**集合** `selectedItemKeys` 决定，
 *    旧路径单值 `selectedBlockId` 不泄漏到物品行；无对应方块的行带行内标记
 *    （`data-stats-unresolved` + 色点）；锚点行带 `data-stats-anchor`；选择提示行
 *    （`[data-stats-selection-notice]`）按 `selectionNotice` prop 呈现。
 *
 * 无框架依赖：`createApp(...).mount(el)` + 原生 DOM 断言（仓库未装 @vue/test-utils）。
 * BlockIconCache 以真实实例构造（jsdom 无 WebGL ⇒ 烘焙确定性失败落占位，行 DOM 不依赖图标产出）；
 * 对它的 `vi.spyOn` 只做**调用观测**（对象仍是生产实例，无替身）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import BlockStatsSidebar from '@/embed/components/BlockStatsSidebar.vue'
import { BlockIconCache } from '@/render/interaction/blockIconCache'
import { buildBlockStatsEntries } from '@/render/interaction/blockStats'
import { blockRegistryKeyForPalette } from '@/render/data/blockRegistryResolve'
import { buildItemHitIndexFromIndex, type ItemIndex } from '@/pure/itemIndex'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import type { StructureDefinition } from '@/render/schema/types'
import type { PartRecord } from '@/pure/partTypes'

import singleboxFixture from '../../../../e2e/fixtures/parts-singlebox-mix.v2.json'
import ae2Fixture from '../../../../e2e/fixtures/parts-ae2-multibox.v2.json'

// jsdom 无 ResizeObserver（组件挂载路径用到）：环境垫片，非业务替身
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

/** 图标缓存的材质库在烘焙失败路径上不可达（jsdom 无 WebGL）；仅满足构造签名 */
const stubLibrary = { tick() {}, isDisposed: () => false } as unknown as MaterialLibraryApi

/**
 * 模拟运行时形态：`RuntimeDocument.serialize()` 把文档根字段（partIconTextures / statsTemplate /
 * statsOverride / id…）与首帧 structure 展开到同一对象，`toStructureDefinition` 浅拷贝挂载 ——
 * 侧栏即从此对象读全部输入。
 */
function runtimeDefOf(fixture: unknown): StructureDefinition {
  const root = fixture as Record<string, unknown>
  const frames = root.frames as Array<{ structure: unknown }>
  const { frames: _f, annotations: _a, labels: _l, ...rest } = root
  return { ...rest, ...(frames[0]!.structure as Record<string, unknown>) } as unknown as StructureDefinition
}

/** tooltipMap：与生产一致（palette 键 → tooltip 行）；部件模式的物品行不使用它（仅旧路径用） */
function tooltipMapOf(def: StructureDefinition): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const e of def.blockPalette) {
    if (e.tooltip && e.tooltip.length > 0) {
      map.set(blockRegistryKeyForPalette(e.registryId, e.meta), e.tooltip)
    }
  }
  return map
}

const apps: App[] = []
const hosts: HTMLElement[] = []

interface Mounted {
  el: HTMLElement
  app: App
  cache: BlockIconCache
}

function mountSidebar(def: StructureDefinition, extraProps: Record<string, unknown> = {}): Mounted {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const cache = new BlockIconCache(stubLibrary, undefined, def)
  const app = createApp(BlockStatsSidebar as never, {
    entries: buildBlockStatsEntries(def, 'all'),
    cache,
    tooltipMap: tooltipMapOf(def),
    // definition 不传：走 cache.getStructure() 回退 —— 即生产 EmbedViewport 现状接线
    ...extraProps,
  } as Record<string, unknown>)
  app.mount(el)
  apps.push(app)
  hosts.push(el)
  return { el, app, cache }
}

function rowKeys(el: HTMLElement): string[] {
  return [...el.querySelectorAll<HTMLElement>('[data-stats-row-key]')].map(
    (r) => r.getAttribute('data-stats-row-key')!,
  )
}

function rowByKey(el: HTMLElement, key: string): HTMLElement {
  // 键只含 registry/damage 字符（字母数字 : . _ - @ #），属性选择器内无需转义
  return el.querySelector<HTMLElement>(`[data-stats-row-key="${key}"]`)!
}

function qtys(el: HTMLElement): string[] {
  return [...el.querySelectorAll<HTMLElement>('[data-stats-row-key] .nei-slot-qty')].map(
    (q) => q.textContent!,
  )
}

const STATS_LOCAL_PREFIX = 'lightning:stats:v1:'

function statsLocalKeys(): string[] {
  const out: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!
    if (k.startsWith(STATS_LOCAL_PREFIX)) out.push(k)
  }
  return out.sort()
}

/** 视图切换 UI / 配置入口的"必须不存在"清单（决策 C 移除锁的 DOM 面） */
function expectNoViewSwitchUi(el: HTMLElement): void {
  expect(el.querySelector('.nei-stats-toolbar')).toBeNull()
  expect(el.querySelector('[data-stats-view-btn]')).toBeNull()
  expect(el.querySelector('[role="tablist"]')).toBeNull()
  expect(el.querySelector('[role="tab"]')).toBeNull()
  expect(el.querySelector('.nei-stats-views')).toBeNull()
  expect(el.querySelector('[data-stats-source]')).toBeNull()
  expect(el.querySelector('.nei-stats-prov-pill')).toBeNull()
  expect(el.querySelector('[data-stats-provenance]')).toBeNull()
  expect(el.querySelector('.nei-stats-prov')).toBeNull()
  expect(el.querySelector('[data-stats-prov-field]')).toBeNull()
  expect(el.querySelector('[data-stats-reset-local]')).toBeNull()
  expect(el.querySelector('[data-stats-group-title]')).toBeNull()
  // 行不再有 kind（只存在物品行一种）
  expect(el.querySelector('[data-stats-row-kind]')).toBeNull()
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
  for (const el of hosts.splice(0)) el.remove()
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// 决策 C 移除锁（DOM 面）
// ---------------------------------------------------------------------------

describe('B-3 移除锁：无视图切换 UI、无配置入口', () => {
  it('部件文件：工具栏/视图按钮/来源徽标/provenance 面板/分组标题全部不存在', () => {
    const { el } = mountSidebar(runtimeDefOf(singleboxFixture))
    expectNoViewSwitchUi(el)
    expect(el.querySelectorAll('.nei-slot-row')).toHaveLength(2) // 有行 ⇒ 不是"没渲染所以查不到"
  })

  it('残留 statsOverride(view=custom + groups) ⇒ 不出现自定义视图按钮、不出现分组标题', () => {
    const def = {
      ...runtimeDefOf(singleboxFixture),
      statsOverride: {
        view: 'custom',
        rules: { groups: [{ title: '板材', match: ['minecraft:stone_slab:*'] }], showHostRows: true },
      },
    } as unknown as StructureDefinition
    const { el } = mountSidebar(def, { definition: def })
    expectNoViewSwitchUi(el)
    expect(rowKeys(el)).toEqual(['minecraft:stone_slab:0', 'minecraft:fence:0'])
  })
})

// ---------------------------------------------------------------------------
// 物品行（形态 + 数量口径 + 固定排序）
// ---------------------------------------------------------------------------

describe('B-3 物品行：行集/名称/数量/图标键', () => {
  it('单盒混存 fixture：slab 合并计 3、fence 计 1；行名 = 游戏内显示名；图标键 = 物品身份键', () => {
    const { el } = mountSidebar(runtimeDefOf(singleboxFixture))

    // 行集：物品身份键，数量降序（3 → 1）；满方块宿主 minecraft:stone 不进清单
    expect(rowKeys(el)).toEqual(['minecraft:stone_slab:0', 'minecraft:fence:0'])
    expect(qtys(el)).toEqual(['3', '1'])

    const slab = rowByKey(el, 'minecraft:stone_slab:0')
    expect(slab.getAttribute('data-stats-icon-key')).toBe('minecraft:stone_slab:0') // 物品身份键（硬约束）
    expect(slab.querySelector('.nei-slot-name')!.textContent).toBe('Stone Slab') // 游戏内显示名（硬约束）
    expect(slab.querySelector('.nei-slot-id')!.textContent).toBe('stone_slab:0')
    expect(slab.querySelector('.nei-slot-qty')!.textContent).toBe('3') // 下半×2 + 上半×1 合并

    const fence = rowByKey(el, 'minecraft:fence:0')
    expect(fence.querySelector('.nei-slot-name')!.textContent).toBe('Fence')
    expect(fence.querySelector('.nei-slot-qty')!.textContent).toBe('1')
    expect(el.querySelector('.nei-sidebar-head .nei-sidebar-count')!.textContent).toBe('2')
  })

  it('AE2 多部件格 fixture：三种物品身份各计 1，并列按行键字典序；行名 = 游戏内显示名', () => {
    const { el } = mountSidebar(runtimeDefOf(ae2Fixture))
    expect(rowKeys(el)).toEqual([
      'appliedenergistics2:item.ItemMultiPart:16',
      'appliedenergistics2:item.ItemMultiPart:220',
      'appliedenergistics2:item.ItemMultiPart:80',
    ])
    expect(qtys(el)).toEqual(['1', '1', '1'])
    const names = [...el.querySelectorAll<HTMLElement>('[data-stats-row-key] .nei-slot-name')].map(
      (n) => n.textContent,
    )
    expect(names).toEqual(['ME Glass Cable - Fluix', 'ME Storage Bus', 'ME Toggle Bus'])
  })

  it('折叠形态：行带 --collapsed、title = 物品显示名、无名称/数量列，脚注计数照旧', () => {
    const { el } = mountSidebar(runtimeDefOf(singleboxFixture), { collapsed: true })
    expectNoViewSwitchUi(el)
    const rows = [...el.querySelectorAll<HTMLElement>('.nei-slot-row')]
    expect(rows).toHaveLength(2)
    expect(rows[0]!.classList.contains('nei-slot-row--collapsed')).toBe(true)
    expect(rows[0]!.getAttribute('title')).toBe('Stone Slab')
    expect(rows[0]!.querySelector('.nei-slot-info')).toBeNull()
    expect(el.querySelector('.nei-sidebar-foot .nei-sidebar-count')!.textContent).toBe('2')
  })

  it('数量口径 = 物品件数：非整数原样呈现（至多两位）、整数不带小数', () => {
    const box = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number], kind: 'visual' as const }
    const source = { family: 'fmp' as const, fallback: false, boxProvenance: 'both' as const, tier: 1 }
    const half = (n: number): PartRecord => ({
      localId: 'fmp:0', typeKey: 'fmp:microblock:1#mat=stone', displayName: 'Stone Microblock',
      tooltip: [], boxes: [box], source,
      items: [{ registry: 'fmp:microblock', damage: 1, nbtDiscriminator: 'mat=stone', count: n }],
    })
    const def = {
      geometryPhase: 'baked', id: 'fractional',
      blockPalette: [
        { registryId: 'air', meta: 0, renderMode: 'BakedQuads', geometry: { encoding: 'bakedQuadsJsonV1', quads: [] }, occludesAdjacentFaces: false, tooltip: [] },
        { registryId: 'fmp:microblock', meta: 1, renderMode: 'BakedQuads', geometry: { encoding: 'bakedQuadsJsonV1', quads: [] }, occludesAdjacentFaces: false, tooltip: [] },
      ],
      materialPalette: [],
      cellGrid: [[[1]]],
      cellPartsGrid: [[[0]]],
      partLists: [[half(0.25), half(0.25)]],
    } as unknown as StructureDefinition

    const { el } = mountSidebar(def, { definition: def })
    expect(rowKeys(el)).toEqual(['fmp:microblock:1#mat=stone'])
    expect(qtys(el)).toEqual(['0.5'])
  })
})

// ---------------------------------------------------------------------------
// items: [] 未计入提示
// ---------------------------------------------------------------------------

describe('B-3 无物品部件提示', () => {
  it('items: [] 部件不进物品行，以提示行呈现计数（提示保留）', () => {
    const box = { min: [0.375, 0, 0.375] as [number, number, number], max: [0.625, 1, 0.625] as [number, number, number], kind: 'visual' as const }
    const source = { family: 'generic' as const, fallback: true, boxProvenance: 'both' as const, tier: 2 }
    const itemless: PartRecord = {
      localId: 'generic:0', typeKey: 'minecraft:torch:0', displayName: 'Torch',
      tooltip: [], boxes: [box], items: [], source,
    }
    const normal: PartRecord = {
      localId: 'generic:0', typeKey: 'minecraft:fence:0', displayName: 'Fence',
      tooltip: [], boxes: [box], items: [{ registry: 'minecraft:fence', damage: 0, count: 1 }], source,
    }
    const paletteEntry = (registryId: string) => ({
      registryId, meta: 0, renderMode: 'BakedQuads' as const,
      geometry: { encoding: 'bakedQuadsJsonV1' as const, quads: [] },
      occludesAdjacentFaces: false, tooltip: [],
    })
    const def = {
      geometryPhase: 'baked', id: 'itemless-test',
      blockPalette: [paletteEntry('air'), paletteEntry('minecraft:stone')],
      materialPalette: [],
      cellGrid: [[[1, 1]]],
      cellPartsGrid: [[[0, 1]]],
      partLists: [[itemless], [normal]],
    } as unknown as StructureDefinition

    const { el } = mountSidebar(def, { definition: def })
    expect(rowKeys(el)).toEqual(['minecraft:fence:0']) // 无物品部件不产生物品行
    expect(el.querySelector('[data-stats-itemless]')!.textContent).toContain('1 个无物品部件')
    expectNoViewSwitchUi(el)
  })
})

// ---------------------------------------------------------------------------
// 兼容兜底：残留/不可用配置不空栏、不报错、不被读写
// ---------------------------------------------------------------------------

describe('B-3 兼容兜底：残留配置静默忽略', () => {
  it('残留本机配置（不可用视图 view=hosts / 损坏 JSON / schema 不符）⇒ 物品行不变、不空栏、localStorage 一字未改', () => {
    const good = `${STATS_LOCAL_PREFIX}parts-singlebox-mix`
    const residual = JSON.stringify({ schema: 1, config: { view: 'hosts', rules: { showHostRows: true } } })
    localStorage.setItem(good, residual)
    localStorage.setItem(`${STATS_LOCAL_PREFIX}e2e-minimal`, '{oops')
    localStorage.setItem(`${STATS_LOCAL_PREFIX}other-doc`, JSON.stringify({ schema: 999, config: { view: 'custom' } }))

    let el: HTMLElement | null = null
    expect(() => { el = mountSidebar(runtimeDefOf(singleboxFixture)).el }).not.toThrow()

    expect(rowKeys(el!)).toEqual(['minecraft:stone_slab:0', 'minecraft:fence:0']) // 不因残留配置切换/清空
    expect(el!.querySelector('.nei-sidebar-empty')).toBeNull() // 不空栏
    expectNoViewSwitchUi(el!)
    // 不再读写：三个残留键原样留存、无新增
    expect(localStorage.getItem(good)).toBe(residual)
    expect(statsLocalKeys()).toEqual([
      `${STATS_LOCAL_PREFIX}e2e-minimal`, `${STATS_LOCAL_PREFIX}other-doc`, good,
    ])
  })

  it('残留文档配置（statsTemplate mode=custom + statsOverride view=hosts/showHostRows）⇒ 物品行不变、无宿主行', async () => {
    const def = {
      ...runtimeDefOf(singleboxFixture),
      statsTemplate: {
        mode: 'custom',
        showOthers: true,
        groups: [{ label: '板材', entries: [{ partTypeKey: 'minecraft:stone_slab:0' }] }],
      },
      statsOverride: { view: 'hosts', rules: { showHostRows: true, hostGroupTitle: '方块' } },
    } as unknown as StructureDefinition
    const { el } = mountSidebar(def, { definition: def })
    await nextTick()

    expectNoViewSwitchUi(el)
    expect(rowKeys(el)).toEqual(['minecraft:stone_slab:0', 'minecraft:fence:0']) // 仍是物品清单
    expect(rowKeys(el)).not.toContain('minecraft:stone') // showHostRows 不产生宿主行
    expect(rowKeys(el)).not.toContain('minecraft:stone_slab') // 也不出现宿主口径的 slab 键
    expect([...el.querySelectorAll('.nei-slot-row')]).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 图标通道（partIconTextures 两级回退）不变
// ---------------------------------------------------------------------------

describe('B-3 图标通道不变', () => {
  it('partIconTextures prop ⇒ setPartIconTextureSource(解析器)；行图标键全部走 ensurePartIcons，且不走宿主 ensure', async () => {
    const textures = { 'minecraft:stone_slab:0': 'iVBORw0KGgoAAAANSUhEUg==' }
    const def = runtimeDefOf(singleboxFixture)
    const cache = new BlockIconCache(stubLibrary, undefined, def)
    const setSource = vi.spyOn(cache, 'setPartIconTextureSource')
    const ensurePartIcons = vi.spyOn(cache, 'ensurePartIcons')
    const ensureHosts = vi.spyOn(cache, 'ensure')

    const el = document.createElement('div')
    document.body.appendChild(el)
    const app = createApp(BlockStatsSidebar as never, {
      entries: buildBlockStatsEntries(def, 'all'),
      cache,
      partIconTextures: textures,
    } as Record<string, unknown>)
    app.mount(el)
    apps.push(app)
    hosts.push(el)
    await nextTick()

    // 通道 1：纹理源以物品身份键解析器注入（prop → 缓存）
    expect(setSource).toHaveBeenCalled()
    const resolver = setSource.mock.calls.at(-1)![0] as (k: string) => string | null
    expect(typeof resolver).toBe('function')
    expect(resolver('minecraft:stone_slab:0')).toBe(textures['minecraft:stone_slab:0'])
    expect(resolver('minecraft:fence:0')).toBeNull() // 未覆盖键 ⇒ null（回退链接管）

    // 通道 2 的入口：全部物品身份键登记（两级回退在 BlockIconCache 内，本组件不复制回退逻辑）
    expect(ensurePartIcons).toHaveBeenCalledWith(['minecraft:stone_slab:0', 'minecraft:fence:0'])
    expect(ensureHosts).not.toHaveBeenCalled() // 无宿主行 ⇒ 不触发宿主图标通道
  })

  it('卸载时撤下纹理源（setPartIconTextureSource(null)）', () => {
    const def = runtimeDefOf(singleboxFixture)
    const cache = new BlockIconCache(stubLibrary, undefined, def)
    const setSource = vi.spyOn(cache, 'setPartIconTextureSource')
    const { app } = mountSidebar(def, { partIconTextures: { 'minecraft:fence:0': 'x' }, cache })
    setSource.mockClear()
    app.unmount()
    expect(setSource).toHaveBeenCalledWith(null)
    apps.pop() // 已手动卸载：避免 afterEach 重复卸载
  })
})

// ---------------------------------------------------------------------------
// B-5：物品行点选（事件通道 + 集合选中态 + 无对应标记 + 清空）
// ---------------------------------------------------------------------------

/** 硬编码反查索引：slab 有对应（part 命中）、fence 显式"没有对应方块" */
const B5_ITEM_INDEX: ItemIndex = {
  'minecraft:stone_slab:0': {
    display: 'Stone Slab', tooltip: ['Stone Slab'], source: 'part',
    attribution: [{ source: 'part', frame: 0, grid: [0, 0, 0], localId: 'generic:0' }],
  },
  'minecraft:fence:0': {
    display: 'Fence', tooltip: ['Fence'], source: 'none', attribution: [],
  },
}
const B5_INDEX = buildItemHitIndexFromIndex(B5_ITEM_INDEX)
/** 可见顺序（= 数量降序：slab 3 → fence 1） */
const B5_ORDER = ['minecraft:stone_slab:0', 'minecraft:fence:0']

function mountSinglebox(extra: Record<string, unknown> = {}): HTMLElement {
  return mountSidebar(runtimeDefOf(singleboxFixture), extra).el
}

describe('B-5 物品行点选：事件通道（payload = 事实，语义在上层）', () => {
  it('悬停仍发 tooltip-hover（物品身份键）；点选改发 select-item（行键 + 可见顺序 + 修饰键）', () => {
    const onHover = vi.fn()
    const onSelectItem = vi.fn()
    const onSelectBlock = vi.fn()
    const el = mountSinglebox({
      onTooltipHover: onHover,
      onSelectItem,
      onSelectBlock,
      itemIndex: B5_INDEX,
    })

    const slab = rowByKey(el, 'minecraft:stone_slab:0')
    slab.dispatchEvent(new MouseEvent('pointerenter', { bubbles: true, clientX: 3, clientY: 4 }))
    expect(onHover).toHaveBeenLastCalledWith({
      blockId: 'minecraft:stone_slab:0', clientX: 3, clientY: 4, source: 'sidebar',
    })
    slab.dispatchEvent(new MouseEvent('pointerleave', { bubbles: true }))
    expect(onHover).toHaveBeenLastCalledWith(null)

    // 单击：无修饰键
    slab.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onSelectItem).toHaveBeenLastCalledWith({
      key: 'minecraft:stone_slab:0', order: B5_ORDER, ctrl: false, shift: false,
    })
    // 物品行**不再**走旧路径的 select-block 通道
    expect(onSelectBlock).not.toHaveBeenCalled()
  })

  it('Ctrl / Meta / Shift 如实上报（Cmd 归并为 ctrl）', () => {
    const onSelectItem = vi.fn()
    const el = mountSinglebox({ onSelectItem, itemIndex: B5_INDEX })
    const fence = rowByKey(el, 'minecraft:fence:0')

    fence.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    expect(onSelectItem).toHaveBeenLastCalledWith({
      key: 'minecraft:fence:0', order: B5_ORDER, ctrl: true, shift: false,
    })
    fence.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    expect(onSelectItem).toHaveBeenLastCalledWith({
      key: 'minecraft:fence:0', order: B5_ORDER, ctrl: false, shift: true,
    })
    fence.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true, shiftKey: true }))
    expect(onSelectItem).toHaveBeenLastCalledWith({
      key: 'minecraft:fence:0', order: B5_ORDER, ctrl: true, shift: true,
    })
  })
})

describe('B-5 物品行选中态：集合语义（selectedItemKeys，而非旧单值 selectedBlockId）', () => {
  it('selectedItemKeys 决定 --selected / data-stats-selected（多行同时选中）', () => {
    const el = mountSinglebox({
      itemIndex: B5_INDEX,
      selectedItemKeys: new Set(['minecraft:stone_slab:0', 'minecraft:fence:0']),
    })
    const slab = rowByKey(el, 'minecraft:stone_slab:0')
    const fence = rowByKey(el, 'minecraft:fence:0')
    expect(slab.classList.contains('nei-slot-row--selected')).toBe(true)
    expect(fence.classList.contains('nei-slot-row--selected')).toBe(true)
    expect(slab.getAttribute('data-stats-selected')).toBe('true')
    expect(fence.getAttribute('data-stats-selected')).toBe('true')
  })

  it('只有子集被选中时，未选中行不带选中态', () => {
    const el = mountSinglebox({
      itemIndex: B5_INDEX,
      selectedItemKeys: new Set(['minecraft:fence:0']),
    })
    expect(rowByKey(el, 'minecraft:fence:0').getAttribute('data-stats-selected')).toBe('true')
    expect(rowByKey(el, 'minecraft:stone_slab:0').getAttribute('data-stats-selected')).toBe('false')
    expect(el.querySelectorAll('.nei-slot-row--selected')).toHaveLength(1)
  })

  it('旧路径单值 selectedBlockId **不**泄漏到物品行（两条路径数据位互不串台）', () => {
    const el = mountSinglebox({
      itemIndex: B5_INDEX,
      selectedBlockId: 'minecraft:stone_slab:0',
    })
    expect(el.querySelector('.nei-slot-row--selected')).toBeNull()
    expect(rowByKey(el, 'minecraft:stone_slab:0').getAttribute('data-stats-selected')).toBe('false')
  })

  it('锚点行带 data-stats-anchor 与 --anchor（Shift 区间的可视落点）', () => {
    const el = mountSinglebox({
      itemIndex: B5_INDEX,
      selectedItemKeys: new Set(['minecraft:stone_slab:0']),
      selectionAnchor: 'minecraft:stone_slab:0',
    })
    const slab = rowByKey(el, 'minecraft:stone_slab:0')
    expect(slab.getAttribute('data-stats-anchor')).toBe('true')
    expect(slab.classList.contains('nei-slot-row--anchor')).toBe(true)
    expect(rowByKey(el, 'minecraft:fence:0').getAttribute('data-stats-anchor')).toBe('false')
  })
})

describe('B-5 无对应方块：行内可辨认标记（混选时逐项可辨认）', () => {
  it('无对应的行带 data-stats-unresolved + 行内色点（title 语义"没有对应方块"）', () => {
    const el = mountSinglebox({ itemIndex: B5_INDEX })
    const fence = rowByKey(el, 'minecraft:fence:0')
    const slab = rowByKey(el, 'minecraft:stone_slab:0')

    expect(fence.getAttribute('data-stats-unresolved')).toBe('true')
    expect(fence.classList.contains('nei-slot-row--unresolved')).toBe(true)
    const dot = fence.querySelector<HTMLElement>('[data-stats-unresolved-dot]')
    expect(dot, '无对应项必须有行内标记').not.toBeNull()
    expect(dot!.getAttribute('title')).toBe('没有对应方块')

    expect(slab.getAttribute('data-stats-unresolved')).toBe('false')
    expect(slab.querySelector('[data-stats-unresolved-dot]')).toBeNull()
  })

  it('索引缺省（旧部件文件无 itemIndex）⇒ 全部行按"没有对应方块"标记（不得让用户误判为渲染故障）', () => {
    const el = mountSinglebox()
    expect(rowKeys(el)).toEqual(B5_ORDER)
    for (const key of B5_ORDER) {
      expect(rowByKey(el, key).getAttribute('data-stats-unresolved')).toBe('true')
    }
  })

  it('混选（一个有色点、一个没有）⇒ 逐项可辨认，且提示行说明"没有对应方块"', () => {
    const el = mountSinglebox({
      itemIndex: B5_INDEX,
      selectedItemKeys: new Set(B5_ORDER),
      selectionNotice: '1 项没有对应方块（已选中，不高亮）',
    })
    expect(rowByKey(el, 'minecraft:fence:0').getAttribute('data-stats-unresolved')).toBe('true')
    expect(rowByKey(el, 'minecraft:stone_slab:0').getAttribute('data-stats-unresolved')).toBe('false')
    const notice = el.querySelector<HTMLElement>('[data-stats-selection-notice]')!
    expect(notice.textContent).toContain('没有对应方块')
  })

  it('选择提示行按 selectionNotice prop 呈现；缺省 ⇒ 不渲染（DOM 零新增）', () => {
    const withNotice = mountSinglebox({ itemIndex: B5_INDEX, selectionNotice: '命中 812 处，仅高亮前 500 处' })
    expect(withNotice.querySelector('[data-stats-selection-notice]')!.textContent)
      .toBe('命中 812 处，仅高亮前 500 处')
    const without = mountSinglebox({ itemIndex: B5_INDEX })
    expect(without.querySelector('[data-stats-selection-notice]')).toBeNull()
  })
})

describe('B-5 清空选择：Esc 与点左栏空白', () => {
  it('点左栏空白 ⇒ clear-selection；点行本身 ⇒ 不发 clear-selection', () => {
    const onClear = vi.fn()
    const el = mountSinglebox({ itemIndex: B5_INDEX, onClearSelection: onClear })

    rowByKey(el, 'minecraft:stone_slab:0').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onClear, '点行不算空白').not.toHaveBeenCalled()

    el.querySelector('.nei-sidebar-grid')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('Esc ⇒ clear-selection（document 级监听）', () => {
    const onClear = vi.fn()
    mountSinglebox({ itemIndex: B5_INDEX, onClearSelection: onClear })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(onClear).toHaveBeenCalledTimes(1)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    expect(onClear, '其它键不触发').toHaveBeenCalledTimes(1)
  })

  it('拖拽手势（pointerdown → 位移后的 click）不算"点空白"，不清空选择', () => {
    const onClear = vi.fn()
    const el = mountSinglebox({ itemIndex: B5_INDEX, onClearSelection: onClear })
    const grid = el.querySelector('.nei-sidebar-grid')!

    grid.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 100 }))
    grid.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 200 }))
    grid.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 10, clientY: 200 }))
    grid.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 200 }))
    expect(onClear, '位移 > 4px ⇒ 视为拖拽（滚动/下拉回弹的收尾 click）').not.toHaveBeenCalled()

    // 对照：同一位置按下 + 无位移的原地 click 仍是"点空白"
    grid.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 200 }))
    grid.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 200 }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('卸载后不再监听 Esc（不留悬挂监听）', () => {
    const onClear = vi.fn()
    const { el, app } = mountSidebar(runtimeDefOf(singleboxFixture), {
      itemIndex: B5_INDEX, onClearSelection: onClear,
    })
    expect(el.querySelectorAll('.nei-slot-row')).toHaveLength(2)
    app.unmount()
    apps.pop() // 已手动卸载：避免 afterEach 重复卸载
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(onClear).not.toHaveBeenCalled()
  })
})
