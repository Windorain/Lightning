// @vitest-environment jsdom
/**
 * P2.4 统计栏 UI（BlockStatsSidebar）—— 部件模式 + 三级配置入口的 **DOM 行为**（jsdom + 真实组件，无替身）。
 *
 * 覆盖（计划 §4 P2.4 自检 + 硬约束）：
 *  - 默认视图 = 部件物品清单：行 = 部件物品名与计数（slab 合并 3、fence 1；满方块宿主不进清单）；
 *  - 图标键 = 部件物品身份键（`registry:damage`，硬约束：图标与名称取部件物品）；
 *  - 切宿主视图 = 旧行集（countBlocksById 口径，tooltipMap 友好名保留）；
 *  - provenance 呈现：来源徽标 + 逐字段来源面板（"默认值来自文档"对用户可见）；
 *  - 视图切换写查看者本地层（localStorage）；与下层相同则不落覆盖；一键清除本机修改；
 *  - 文档覆盖（statsOverride）只读生效：custom 分组视图 + 来源 = 文档覆盖；
 *  - 无部件旧文件（minimal-v2）：不显示视图切换/配置入口，旧路径 DOM 与行为不变；
 *  - `items: []` 无物品部件提示行。
 *
 * 无框架依赖：`createApp(...).mount(el)` + 原生 DOM 断言（仓库未装 @vue/test-utils）。
 * BlockIconCache 以真实实例构造（jsdom 无 WebGL ⇒ 烘焙确定性失败落占位，行 DOM 不依赖图标产出）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import BlockStatsSidebar from '@/embed/components/BlockStatsSidebar.vue'
import { BlockIconCache } from '@/render/interaction/blockIconCache'
import { buildBlockStatsEntries } from '@/render/interaction/blockStats'
import { viewerLocalStatsStorageKey } from '@/render/interaction/statsConfigStorage'
import { blockRegistryKeyForPalette } from '@/render/data/blockRegistryResolve'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import type { StructureDefinition } from '@/render/schema/types'
import type { PartRecord } from '@/pure/partTypes'

import singleboxFixture from '../../../../e2e/fixtures/parts-singlebox-mix.v2.json'
import ae2Fixture from '../../../../e2e/fixtures/parts-ae2-multibox.v2.json'
import minimalV2 from '../../../../e2e/fixtures/minimal-v2.json'

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
 * 模拟运行时形态：`RuntimeDocument.serialize()` 把文档根字段（statsTemplate/statsOverride/id…）
 * 与首帧 structure 展开到同一对象，`toStructureDefinition` 浅拷贝挂载 —— 侧栏即从此对象读全部输入。
 */
function runtimeDefOf(fixture: unknown): StructureDefinition {
  const root = fixture as Record<string, unknown>
  const frames = root.frames as Array<{ structure: unknown }>
  const { frames: _f, annotations: _a, labels: _l, ...rest } = root
  return { ...rest, ...(frames[0]!.structure as Record<string, unknown>) } as unknown as StructureDefinition
}

/** tooltipMap：与生产一致（blockPalette 键 → tooltip 行），宿主行友好名数据源 */
function tooltipMapOf(def: StructureDefinition): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const e of def.blockPalette) {
    if (e.tooltip && e.tooltip.length > 0) {
      map.set(blockRegistryKeyForPalette(e.registryId, e.meta), e.tooltip)
    }
  }
  return map
}

const mounted: App[] = []
const hosts: HTMLElement[] = []

function mountSidebar(def: StructureDefinition, extraProps: Record<string, unknown> = {}): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(BlockStatsSidebar as never, {
    entries: buildBlockStatsEntries(def, 'all'),
    cache: new BlockIconCache(stubLibrary, undefined, def),
    tooltipMap: tooltipMapOf(def),
    // definition 不传：走 cache.getStructure() 回退 —— 即生产 EmbedViewport 现状接线
    ...extraProps,
  } as Record<string, unknown>)
  app.mount(el)
  mounted.push(app)
  hosts.push(el)
  return el
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

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount()
  for (const el of hosts.splice(0)) el.remove()
  localStorage.clear()
})

describe('P2.4 统计栏：默认视图 = 部件物品清单', () => {
  it('单盒混存 fixture：slab 合并计 3、fence 计 1；行名 = 游戏内显示名；图标键 = 物品身份键', () => {
    const el = mountSidebar(runtimeDefOf(singleboxFixture))

    // 视图切换出现，默认激活"部件物品"
    const tabs = [...el.querySelectorAll<HTMLElement>('[data-stats-view-btn]')]
    expect(tabs.map((t) => t.getAttribute('data-stats-view-btn'))).toEqual(['parts', 'hosts', 'custom'])
    expect(el.querySelector('.nei-stats-view-btn--active')!.getAttribute('data-stats-view-btn')).toBe('parts')

    // 行集：部件物品名与计数（满方块宿主 minecraft:stone 不进清单）
    expect(rowKeys(el)).toEqual(['minecraft:stone_slab:0', 'minecraft:fence:0'])
    const slab = rowByKey(el, 'minecraft:stone_slab:0')
    expect(slab.getAttribute('data-stats-row-kind')).toBe('part')
    expect(slab.getAttribute('data-stats-icon-key')).toBe('minecraft:stone_slab:0') // 物品身份键（硬约束）
    expect(slab.querySelector('.nei-slot-name')!.textContent).toBe('Stone Slab') // 游戏内显示名（硬约束）
    expect(slab.querySelector('.nei-slot-qty')!.textContent).toBe('3') // 下半×2 + 上半×1 合并
    const fence = rowByKey(el, 'minecraft:fence:0')
    expect(fence.querySelector('.nei-slot-name')!.textContent).toBe('Fence')
    expect(fence.querySelector('.nei-slot-qty')!.textContent).toBe('1')
    expect(el.querySelector('.nei-sidebar-head .nei-sidebar-count')!.textContent).toBe('2')

    // provenance 徽标常驻：fixture statsTemplate mode=auto ⇒ 视图默认值来自文档
    const pill = el.querySelector<HTMLElement>('[data-stats-source]')!
    expect(pill.getAttribute('data-stats-source')).toBe('document-default')
    expect(pill.textContent).toBe('文档默认')
  })

  it('AE2 多部件格 fixture：三种 typeKey 各计 1，行名 = 游戏内显示名', () => {
    const el = mountSidebar(runtimeDefOf(ae2Fixture))
    expect(rowKeys(el)).toEqual([
      'appliedenergistics2:item.ItemMultiPart:16',
      'appliedenergistics2:item.ItemMultiPart:220',
      'appliedenergistics2:item.ItemMultiPart:80',
    ])
    const names = [...el.querySelectorAll<HTMLElement>('[data-stats-row-kind="part"] .nei-slot-name')].map(
      (n) => n.textContent,
    )
    expect(names).toEqual(['ME Glass Cable - Fluix', 'ME Storage Bus', 'ME Toggle Bus'])
    for (const key of rowKeys(el)) {
      expect(rowByKey(el, key).querySelector('.nei-slot-qty')!.textContent).toBe('1')
    }
  })
})

describe('P2.4 统计栏：视图切换 + 查看者本地层', () => {
  it('切宿主视图 = 旧行集（旧口径数值 + tooltipMap 友好名）；写 localStorage；徽标变"本机修改"', async () => {
    const el = mountSidebar(runtimeDefOf(singleboxFixture))

    el.querySelector<HTMLElement>('[data-stats-view-btn="hosts"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()

    // 旧行集：countBlocksById 口径（slab meta0×2 / slab meta8×1 / stone×1 / fence×1）
    expect(rowKeys(el)).toEqual([
      'minecraft:fence',
      'minecraft:stone',
      'minecraft:stone_slab',
      'minecraft:stone_slab@8',
    ])
    const qty = (k: string) => rowByKey(el, k).querySelector('.nei-slot-qty')!.textContent
    expect([qty('minecraft:fence'), qty('minecraft:stone'), qty('minecraft:stone_slab'), qty('minecraft:stone_slab@8')])
      .toEqual(['1', '1', '2', '1'])
    for (const k of rowKeys(el)) expect(rowByKey(el, k).getAttribute('data-stats-row-kind')).toBe('host')
    // 宿主行沿用 tooltipMap 友好名
    expect(rowByKey(el, 'minecraft:stone').querySelector('.nei-slot-name')!.textContent).toBe('Stone')

    // 查看者本地层已写 localStorage；徽标 = 本机修改
    expect(localStorage.getItem(viewerLocalStatsStorageKey('parts-singlebox-mix'))).toContain('"view":"hosts"')
    const pill = el.querySelector<HTMLElement>('[data-stats-source]')!
    expect(pill.getAttribute('data-stats-source')).toBe('viewer-local')
    expect(pill.textContent).toBe('本机修改')

    // 切回"部件物品"（= 下层合成结果）⇒ 不落本地覆盖，provenance 回到文档默认
    el.querySelector<HTMLElement>('[data-stats-view-btn="parts"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(rowKeys(el)).toEqual(['minecraft:stone_slab:0', 'minecraft:fence:0'])
    expect(el.querySelector('[data-stats-source]')!.getAttribute('data-stats-source')).toBe('document-default')
    expect(localStorage.getItem(viewerLocalStatsStorageKey('parts-singlebox-mix'))).toBeNull()
  })

  it('provenance 面板：逐字段来源可见；"清除本机修改"回到文档级配置', async () => {
    const el = mountSidebar(runtimeDefOf(singleboxFixture))

    // 展开面板：视图字段来源 = 文档默认
    el.querySelector<HTMLElement>('.nei-stats-prov-pill')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    const viewRow = el.querySelector<HTMLElement>('[data-stats-prov-field="view"]')!
    expect(viewRow.getAttribute('data-stats-prov-source')).toBe('document-default')
    expect(viewRow.textContent).toContain('文档默认')
    expect(el.querySelector('[data-stats-reset-local]')).toBeNull() // 无本机修改时不给清除

    // 本机切视图后面板出现"清除本机修改"；点击后回到文档默认
    el.querySelector<HTMLElement>('[data-stats-view-btn="hosts"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(el.querySelector('[data-stats-prov-field="view"]')!.getAttribute('data-stats-prov-source')).toBe('viewer-local')
    el.querySelector<HTMLElement>('[data-stats-reset-local]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(el.querySelector('[data-stats-source]')!.getAttribute('data-stats-source')).toBe('document-default')
    expect(localStorage.getItem(viewerLocalStatsStorageKey('parts-singlebox-mix'))).toBeNull()
    expect(rowKeys(el)).toEqual(['minecraft:stone_slab:0', 'minecraft:fence:0'])
  })
})

describe('P2.4 统计栏：文档覆盖（statsOverride）只读生效', () => {
  it('statsOverride 自定义分组视图：分组渲染 + provenance = 文档覆盖', async () => {
    const def = {
      ...runtimeDefOf(singleboxFixture),
      statsOverride: {
        view: 'custom',
        rules: { groups: [{ title: '板材', match: ['minecraft:stone_slab:*'] }] },
      },
    } as unknown as StructureDefinition
    const el = mountSidebar(def, { definition: def })

    // 激活自定义视图；分组标题 + 组内行
    expect(el.querySelector('.nei-stats-view-btn--active')!.getAttribute('data-stats-view-btn')).toBe('custom')
    expect([...el.querySelectorAll<HTMLElement>('[data-stats-group-title]')].map((g) => g.textContent))
      .toEqual(['板材', '其他'])
    expect(rowKeys(el)).toEqual(['minecraft:stone_slab:0', 'minecraft:fence:0'])

    // provenance：视图与 groups 规则均来自文档覆盖（只读呈现，不写回）
    const pill = el.querySelector<HTMLElement>('[data-stats-source]')!
    expect(pill.getAttribute('data-stats-source')).toBe('document-override')
    pill.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(el.querySelector('[data-stats-prov-field="view"]')!.getAttribute('data-stats-prov-source')).toBe('document-override')
    expect(el.querySelector('[data-stats-prov-field="groups"]')!.getAttribute('data-stats-prov-source')).toBe('document-override')
  })
})

describe('P2.4 统计栏：无部件旧文件退化（硬约束：行为与今天一致）', () => {
  it('minimal-v2：不显示视图切换/配置入口；旧路径行 DOM 与点选行为不变', () => {
    const onSelect = vi.fn()
    const el = mountSidebar(runtimeDefOf(minimalV2), { onSelectBlock: onSelect })

    // 无视图切换、无来源徽标、无 provenance 面板、无部件行属性（拍板：旧文件 DOM 零新增）
    expect(el.querySelector('[data-stats-view-btn]')).toBeNull()
    expect(el.querySelector('[data-stats-source]')).toBeNull()
    expect(el.querySelector('[data-stats-provenance]')).toBeNull()
    expect(el.querySelector('[data-stats-row-key]')).toBeNull()
    expect(el.querySelector('.nei-stats-toolbar')).toBeNull()

    // 旧路径：一行 gold_ore ×8，tooltipMap 友好名
    const rows = [...el.querySelectorAll<HTMLElement>('.nei-slot-row')]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.querySelector('.nei-slot-name')!.textContent).toBe('Gold Ore')
    expect(rows[0]!.querySelector('.nei-slot-qty')!.textContent).toBe('8')
    expect(el.querySelector('.nei-sidebar-head .nei-sidebar-count')!.textContent).toBe('1')

    // 旧交互：点选事件照旧携带 blockId
    rows[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onSelect).toHaveBeenCalledWith('minecraft:gold_ore')
  })
})

describe('P2.4 统计栏：无物品部件提示', () => {
  it('items: [] 部件不进物品行，以提示行呈现计数', () => {
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

    const el = mountSidebar(def, { definition: def })
    expect(rowKeys(el)).toEqual(['minecraft:fence:0']) // 无物品部件不产生物品行
    expect(el.querySelector('[data-stats-itemless]')!.textContent).toContain('1 个无物品部件')
  })
})
