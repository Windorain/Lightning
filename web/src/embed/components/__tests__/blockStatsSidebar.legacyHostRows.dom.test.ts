// @vitest-environment jsdom
/**
 * B-3 旧文件回归锁定（硬约束，issue #36 完成定义第 5 条）。
 *
 * 口径：**无部件数据的旧文件** ⇒ 左栏 = 宿主清单（数据源 = `buildBlockStatsEntries` /
 * `countBlocksById` 旧口径），其行集合 / 行键 / 文案 / 数量 / 折叠形态 / 交互（悬停 tooltip +
 * 点选）在「移除视图切换 UI + 移除统计规则能力（决策 C）」前后**逐项一致**；
 * 且统计栏**不渲染任何部件模式 UI**（无 `data-stats-row-key` / 工具条 / 视图按钮 /
 * 来源徽标 / provenance 面板 / 分组标题 / 未计入提示）—— 这就是"旧文件 DOM 零新增"。
 *
 * 契约：`docs/contracts/format-parts-contract.md`
 * （§2.2 物品索引表、§9 已废弃 = 规则能力与三级配置的废止依据）。
 *
 * 本文件是**回归锁**，不是新功能测试：它在实现改动**之前**写成并在旧实现上跑绿，
 * 改动之后必须继续绿（PR 回归断言表逐行对应）。断言值全部硬编码 —— 不从被测实现或
 * fixture 反读期望（篡改实现即红）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App } from 'vue'
import BlockStatsSidebar from '@/embed/components/BlockStatsSidebar.vue'
import { BlockIconCache } from '@/render/interaction/blockIconCache'
import { buildBlockStatsEntries } from '@/render/interaction/blockStats'
import { blockRegistryKeyForPalette } from '@/render/data/blockRegistryResolve'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import type { StructureDefinition } from '@/render/schema/types'

import singleboxFixture from '../../../../e2e/fixtures/parts-singlebox-mix.v2.json'
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

/** 模拟运行时形态（同生产）：文档根字段 + 首帧 structure 展开到同一对象 */
function runtimeDefOf(fixture: unknown): StructureDefinition {
  const root = fixture as Record<string, unknown>
  const frames = root.frames as Array<{ structure: unknown }>
  const { frames: _f, annotations: _a, labels: _l, ...rest } = root
  return { ...rest, ...(frames[0]!.structure as Record<string, unknown>) } as unknown as StructureDefinition
}

/**
 * 旧文件形态：显式剥掉部件字段（`cellPartsGrid` / `partLists`）——
 * 即"本轮之前导出的、无部件数据的文档"（契约 §2：无部件字段 = 行为与今天完全一致）。
 * 只改本函数返回的新对象，不动 fixture 模块本体。
 */
function legacyDefOf(fixture: unknown): StructureDefinition {
  const def = runtimeDefOf(fixture) as unknown as Record<string, unknown>
  delete def.cellPartsGrid
  delete def.partLists
  return def as unknown as StructureDefinition
}

/** tooltipMap：与生产一致（palette 键 → tooltip 行），宿主行友好名数据源 */
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

interface RowSnapshot {
  id: string | null
  name: string
  sub: string
  qty: string
  title: string | null
}

/** 旧路径行的逐项快照（键/文案/数量/折叠 title）；`id = null` 证明行上无 data 属性 */
function snapshotLegacyRows(el: HTMLElement): RowSnapshot[] {
  return [...el.querySelectorAll<HTMLElement>('.nei-slot-row')].map((r) => ({
    id: r.getAttribute('data-stats-row-key'),
    name: (r.querySelector('.nei-slot-name')?.textContent ?? '').trim(),
    sub: (r.querySelector('.nei-slot-id')?.textContent ?? '').trim(),
    qty: (r.querySelector('.nei-slot-qty')?.textContent ?? '').trim(),
    title: r.getAttribute('title'),
  }))
}

/** 部件模式 UI 的"必须不存在"清单（旧文件 DOM 零新增的直接证据） */
function expectNoPartsModeUi(el: HTMLElement): void {
  expect(el.querySelector('[data-stats-row-key]')).toBeNull()
  expect(el.querySelector('[data-stats-icon-key]')).toBeNull()
  expect(el.querySelector('.nei-stats-toolbar')).toBeNull()
  expect(el.querySelector('[data-stats-view-btn]')).toBeNull()
  expect(el.querySelector('[data-stats-source]')).toBeNull()
  expect(el.querySelector('.nei-stats-prov-pill')).toBeNull()
  expect(el.querySelector('[data-stats-provenance]')).toBeNull()
  expect(el.querySelector('[data-stats-prov-field]')).toBeNull()
  expect(el.querySelector('[data-stats-reset-local]')).toBeNull()
  expect(el.querySelector('[data-stats-group-title]')).toBeNull()
  expect(el.querySelector('[data-stats-itemless]')).toBeNull()
  // B-5 新增的部件模式数据位/UI 同样不得出现在旧路径（两条路径互不串台）
  expect(el.querySelector('[data-stats-selected]')).toBeNull()
  expect(el.querySelector('[data-stats-unresolved]')).toBeNull()
  expect(el.querySelector('[data-stats-unresolved-dot]')).toBeNull()
  expect(el.querySelector('[data-stats-anchor]')).toBeNull()
  expect(el.querySelector('[data-stats-selection-notice]')).toBeNull()
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

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount()
  for (const el of hosts.splice(0)) el.remove()
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// 1. 真实旧文件 fixture（minimal-v2，无部件字段）：逐项锁定
// ---------------------------------------------------------------------------

describe('旧文件回归锁：minimal-v2（真实旧文件 fixture）', () => {
  it('行集合/键/文案/数量/头计数逐项一致，且无任何部件模式 UI', () => {
    const el = mountSidebar(legacyDefOf(minimalV2))

    expectNoPartsModeUi(el)
    expect(el.querySelector('.nei-sidebar-empty')).toBeNull()

    // 一行 gold_ore ×8：行键无 data 属性（旧路径 DOM 零新增）、文案取 tooltipMap 友好名
    expect(snapshotLegacyRows(el)).toEqual([
      { id: null, name: 'Gold Ore', sub: 'gold_ore', qty: '8', title: null },
    ])
    expect(el.querySelector('.nei-sidebar-head .nei-sidebar-count')!.textContent).toBe('1')
  })

  it('折叠形态逐项一致：行带 --collapsed、title = 友好名、无名称/数量列，脚注计数照旧', () => {
    const el = mountSidebar(legacyDefOf(minimalV2), { collapsed: true })

    expectNoPartsModeUi(el)
    const rows = [...el.querySelectorAll<HTMLElement>('.nei-slot-row')]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.classList.contains('nei-slot-row--collapsed')).toBe(true)
    expect(rows[0]!.getAttribute('title')).toBe('Gold Ore')
    expect(rows[0]!.querySelector('.nei-slot-info')).toBeNull()
    expect(el.querySelector('.nei-sidebar-foot .nei-sidebar-count')!.textContent).toBe('1')
  })

  it('交互逐项一致：悬停 tooltip 携带 blockId、离开清空、点选携带 blockId', () => {
    const onHover = vi.fn()
    const onSelect = vi.fn()
    const el = mountSidebar(legacyDefOf(minimalV2), {
      onTooltipHover: onHover,
      onSelectBlock: onSelect,
    })
    const row = el.querySelector<HTMLElement>('.nei-slot-row')!

    row.dispatchEvent(new MouseEvent('pointerenter', { bubbles: true, clientX: 11, clientY: 22 }))
    expect(onHover).toHaveBeenLastCalledWith({
      blockId: 'minecraft:gold_ore', clientX: 11, clientY: 22, source: 'sidebar',
    })
    onHover.mockClear()

    row.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 33, clientY: 44 }))
    expect(onHover).toHaveBeenLastCalledWith({
      blockId: 'minecraft:gold_ore', clientX: 33, clientY: 44, source: 'sidebar',
    })
    onHover.mockClear()

    row.dispatchEvent(new MouseEvent('pointerleave', { bubbles: true }))
    expect(onHover).toHaveBeenLastCalledWith(null)
    onHover.mockClear()

    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('minecraft:gold_ore')
  })

  it('B-5 的清空交互**不侵入**旧路径：Esc / 点左栏空白都不发 clear-selection', () => {
    const onClear = vi.fn()
    const el = mountSidebar(legacyDefOf(minimalV2), { onClearSelection: onClear })

    el.querySelector('.nei-sidebar-grid')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(onClear, '旧文件宿主清单路径无多选语义 ⇒ 不清空（逐项不变）').not.toHaveBeenCalled()
  })

  it('B-5 的选中态数据位不落到旧路径行上（仍是单值 selectedBlockId 语义）', () => {
    const el = mountSidebar(legacyDefOf(singleboxFixture), { selectedBlockId: 'minecraft:fence' })
    expectNoPartsModeUi(el)
    const rows = [...el.querySelectorAll<HTMLElement>('.nei-slot-row')]
    expect(rows.filter((r) => r.classList.contains('nei-slot-row--selected'))).toHaveLength(1)
    expect(rows[0]!.classList.contains('nei-slot-row--selected')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. 多行 + meta 变体（剥掉部件字段的单盒 fixture）：行集合/顺序/键/文案/数量锁定
// ---------------------------------------------------------------------------

describe('旧文件回归锁：多行宿主清单（含 meta 变体）', () => {
  const EXPECTED = [
    { id: null, name: 'Fence', sub: 'fence', qty: '1', title: null },
    { id: null, name: 'Stone', sub: 'stone', qty: '1', title: null },
    { id: null, name: 'Stone Slab', sub: 'stone_slab', qty: '2', title: null },
    { id: null, name: 'Stone Slab', sub: 'stone_slab:8', qty: '1', title: null },
  ]

  it('行集 = countBlocksById 旧口径：键字典序、count>0、meta 变体独立成行（`@8` → `:8`）', () => {
    const el = mountSidebar(legacyDefOf(singleboxFixture))

    expectNoPartsModeUi(el)
    expect(el.querySelector('.nei-sidebar-empty')).toBeNull()
    expect(snapshotLegacyRows(el)).toEqual(EXPECTED)
    expect(el.querySelector('.nei-sidebar-head .nei-sidebar-count')!.textContent).toBe('4')
  })

  it('行数 = entries 长度：满方块与 meta 变体都按旧口径出现（无部件行混入）', () => {
    const def = legacyDefOf(singleboxFixture)
    const el = mountSidebar(def)
    expect(el.querySelectorAll('.nei-slot-row')).toHaveLength(buildBlockStatsEntries(def, 'all').length)
    expect(buildBlockStatsEntries(def, 'all').map((r) => r.blockId)).toEqual([
      'minecraft:fence', 'minecraft:stone', 'minecraft:stone_slab', 'minecraft:stone_slab@8',
    ])
  })
})

// ---------------------------------------------------------------------------
// 3. 兼容兜底：残留/不可用配置不空栏、不报错、不被读写
// ---------------------------------------------------------------------------

describe('兼容兜底：残留本机配置（lightning:stats:v1:*）不空栏不报错', () => {
  it('残留旧本机配置（view=hosts）⇒ 旧文件仍出宿主清单；localStorage 内容一字未改、无新增', () => {
    const key = `${STATS_LOCAL_PREFIX}e2e-minimal`
    const residual = JSON.stringify({ schema: 1, config: { view: 'hosts' } })
    localStorage.setItem(key, residual)

    const el = mountSidebar(legacyDefOf(minimalV2))

    expect(snapshotLegacyRows(el)).toEqual([
      { id: null, name: 'Gold Ore', sub: 'gold_ore', qty: '8', title: null },
    ])
    expect(el.querySelector('.nei-sidebar-empty')).toBeNull()
    // 不再读写：残留值原样留存、不新增任何 lightning:stats:v1:* 键
    expect(localStorage.getItem(key)).toBe(residual)
    expect(statsLocalKeys()).toEqual([key])
  })

  it('残留损坏本机配置（非 JSON / schema 不符 / 不可用视图）⇒ 不抛错、不空栏', () => {
    localStorage.setItem(`${STATS_LOCAL_PREFIX}e2e-minimal`, '{oops')
    localStorage.setItem(`${STATS_LOCAL_PREFIX}parts-singlebox-mix`, JSON.stringify({
      schema: 999, config: { view: 'custom', rules: { showHostRows: true } },
    }))

    let el: HTMLElement | null = null
    expect(() => { el = mountSidebar(legacyDefOf(singleboxFixture)) }).not.toThrow()

    expect(snapshotLegacyRows(el!)).toHaveLength(4)
    expect(el!.querySelector('.nei-sidebar-empty')).toBeNull()
    expectNoPartsModeUi(el!)
    expect(statsLocalKeys()).toEqual([
      `${STATS_LOCAL_PREFIX}e2e-minimal`, `${STATS_LOCAL_PREFIX}parts-singlebox-mix`,
    ])
  })
})

describe('兼容兜底：残留文档配置（statsTemplate / statsOverride）静默忽略', () => {
  it('旧文档携带 statsTemplate(mode=custom + groups) 与 statsOverride(view=hosts) ⇒ 旧文件行集不变、无分组/无宿主行翻转', () => {
    const def = {
      ...legacyDefOf(singleboxFixture),
      statsTemplate: {
        mode: 'custom',
        showOthers: true,
        groups: [{ label: '板材', entries: [{ partTypeKey: 'minecraft:stone_slab:0' }] }],
      },
      statsOverride: { view: 'hosts', rules: { showHostRows: true, sortBy: 'label' } },
    } as unknown as StructureDefinition

    const el = mountSidebar(def, { definition: def })

    expectNoPartsModeUi(el)
    expect(snapshotLegacyRows(el)).toEqual([
      { id: null, name: 'Fence', sub: 'fence', qty: '1', title: null },
      { id: null, name: 'Stone', sub: 'stone', qty: '1', title: null },
      { id: null, name: 'Stone Slab', sub: 'stone_slab', qty: '2', title: null },
      { id: null, name: 'Stone Slab', sub: 'stone_slab:8', qty: '1', title: null },
    ])
    expect(el.querySelector('.nei-sidebar-head .nei-sidebar-count')!.textContent).toBe('4')
  })
})
