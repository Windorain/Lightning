/**
 * P2.3 统计适配层 + fixture 断言。
 *
 * fixture（契约 §14）：
 *  - parts-singlebox-mix.v2.json：下半 slab×2 + 上半 slab（同 typeKey 合并 ⇒ 3）+ 栅栏（1）+ 石头（宿主对照）
 *  - parts-ae2-multibox.v2.json：一格三部件三种 typeKey（各计 1）+ 石头
 *  - minimal-v2.json：无部件旧文件（退化语义：默认视图 = 宿主清单）
 * 硬约束：切宿主视图 = 旧 `countBlocksById` 结果一致；三级配置分层与 statsTemplate 解析。
 */
import { describe, it, expect } from 'vitest'
import { resolveStatsConfig, builtinStatsConfig } from '@/pure/partStats'
import type { StructureDefinition } from '@/render/schema/types'
import { countBlocksById } from '@/render/interaction/blockStats'
import {
  buildPartStatsInput,
  buildStatsViewForDefinition,
  collectPartsForStats,
  parseStatsConfigLayer,
  serializeStatsConfigLayer,
  statsConfigFromV2Template,
  statsOverrideFromDocumentRoot,
} from '@/render/interaction/partStatsAdapter'
import {
  loadViewerLocalStatsConfig,
  saveViewerLocalStatsConfig,
  viewerLocalStatsStorageKey,
} from '@/render/interaction/statsConfigStorage'

import singleboxFixture from '../../../../e2e/fixtures/parts-singlebox-mix.v2.json'
import ae2Fixture from '../../../../e2e/fixtures/parts-ae2-multibox.v2.json'
import minimalV2 from '../../../../e2e/fixtures/minimal-v2.json'

type Doc = { frames: Array<{ structure: unknown }>; statsTemplate?: unknown }

function defOf(doc: unknown): StructureDefinition {
  return (doc as Doc).frames[0]!.structure as StructureDefinition
}

function allRows(result: ReturnType<typeof buildStatsViewForDefinition>) {
  return result.groups.flatMap(g => g.rows)
}

// ---------------------------------------------------------------------------
// fixture 断言：默认视图 = 部件物品清单（数值正确）
// ---------------------------------------------------------------------------

describe('fixture：默认视图 = 部件物品清单', () => {
  it('单盒混存：stone_slab:0 计 3（下半×2 + 上半×1 合并）、fence:0 计 1；石头宿主不出现', () => {
    const def = defOf(singleboxFixture)
    const r = buildStatsViewForDefinition(def, 'all', builtinStatsConfig())
    expect(r.view).toBe('parts')
    expect(r.degenerated).toBeUndefined()
    expect(r.itemlessPartCount).toBe(0)
    const byKey = new Map(allRows(r).map(row => [row.key, row]))
    expect(byKey.size).toBe(2)
    expect(byKey.get('minecraft:stone_slab:0')).toMatchObject({ kind: 'part', label: 'Stone Slab', count: 3 })
    expect(byKey.get('minecraft:fence:0')).toMatchObject({ kind: 'part', label: 'Fence', count: 1 })
    expect(byKey.has('minecraft:stone')).toBe(false) // 满方块宿主不进部件物品清单
  })

  it('AE2 多部件格：三种 typeKey 各计 1', () => {
    const def = defOf(ae2Fixture)
    const r = buildStatsViewForDefinition(def, 'all', builtinStatsConfig())
    const byKey = new Map(allRows(r).map(row => [row.key, row]))
    expect(byKey.size).toBe(3)
    for (const [key, label] of [
      ['appliedenergistics2:item.ItemMultiPart:16', 'ME Glass Cable - Fluix'],
      ['appliedenergistics2:item.ItemMultiPart:80', 'ME Toggle Bus'],
      ['appliedenergistics2:item.ItemMultiPart:220', 'ME Storage Bus'],
    ] as const) {
      expect(byKey.get(key)).toMatchObject({ kind: 'part', label, count: 1 })
    }
  })
})

// ---------------------------------------------------------------------------
// fixture 断言：宿主视图 = 旧 countBlocksById 结果（硬约束）
// ---------------------------------------------------------------------------

describe('fixture：宿主视图 = 旧口径一致', () => {
  it.each([
    ['parts-singlebox-mix', singleboxFixture],
    ['parts-ae2-multibox', ae2Fixture],
  ] as const)('%s：hosts 视图行集 = countBlocksById', (_name, fixture) => {
    const def = defOf(fixture)
    const r = buildStatsViewForDefinition(def, 'all', { view: 'hosts', rules: {} })
    const legacy = countBlocksById(def, 'all')
    const got = new Map(allRows(r).map(row => [row.key, row.count]))
    expect(got).toEqual(new Map([...legacy].filter(([, c]) => c > 0)))
  })

  it('单盒混存宿主数值锚定：slab meta0×2、slab meta8×1、stone×1、fence×1', () => {
    const def = defOf(singleboxFixture)
    const legacy = countBlocksById(def, 'all')
    expect(legacy.get('minecraft:stone_slab')).toBe(2)
    expect(legacy.get('minecraft:stone_slab@8')).toBe(1)
    expect(legacy.get('minecraft:stone')).toBe(1)
    expect(legacy.get('minecraft:fence')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 无部件旧文件：默认视图退化 = 今天行为（硬约束）
// ---------------------------------------------------------------------------

describe('无部件旧文件退化语义', () => {
  it('minimal-v2：parts 视图退化为宿主清单（行集与 hosts 视图一致，带标记）', () => {
    const def = defOf(minimalV2)
    const deg = buildStatsViewForDefinition(def, 'all', builtinStatsConfig())
    const host = buildStatsViewForDefinition(def, 'all', { view: 'hosts', rules: {} })
    expect(deg.degenerated).toBe('parts-to-hosts')
    expect(deg.groups).toEqual(host.groups)
    expect(allRows(deg)).toEqual([
      { key: 'minecraft:gold_ore', kind: 'host', label: 'minecraft:gold_ore', count: 8, iconKey: 'minecraft:gold_ore' },
    ])
  })

  it('collectPartsForStats：无 cellPartsGrid/partLists ⇒ 空数组', () => {
    expect(collectPartsForStats(defOf(minimalV2), 'all')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 分层预览：部件收集与宿主计数同一层语义
// ---------------------------------------------------------------------------

describe('分层预览过滤', () => {
  it('layerPreview 命中的 Y 层才收部件（与 effectiveVoxelState 同语义）', () => {
    const def = defOf(singleboxFixture) // cellGrid 单 row（sizeRow=1 ⇒ row 0 = worldY 0）
    expect(collectPartsForStats(def, { worldY: 0 })).toHaveLength(4) // 2 slab + 1 slab + 1 fence
    expect(collectPartsForStats(def, { worldY: 1 })).toHaveLength(0)
    const inp = buildPartStatsInput(def, { worldY: 1 })
    expect(inp.parts).toHaveLength(0)
    expect(inp.hostCounts.size).toBe(0) // 与 countBlocksById 同语义（切片外视为空气）
  })
})

// ---------------------------------------------------------------------------
// 文档默认层：statsTemplate → StatsConfigLayer（camelCase 权威 / snake 回退）
// ---------------------------------------------------------------------------

describe('statsConfigFromV2Template（文档默认层）', () => {
  it("mode 'auto' ⇒ 部件物品清单视图", () => {
    expect(statsConfigFromV2Template({ mode: 'auto' })).toEqual({ view: 'parts' })
  })

  it("mode 'custom' ⇒ 自定义分组视图；条目键 partTypeKey 优先于 block_state_id；showOthers camelCase 权威", () => {
    const layer = statsConfigFromV2Template({
      mode: 'custom',
      showOthers: false,
      groups: [{
        label: '线缆',
        entries: [
          { block_state_id: '', partTypeKey: 'appliedenergistics2:item.ItemMultiPart:16' },
          { block_state_id: 'minecraft:stone' },
        ],
      }],
    })
    expect(layer).toEqual({
      view: 'custom',
      rules: {
        showOthers: false,
        groups: [{ title: '线缆', match: ['appliedenergistics2:item.ItemMultiPart:16', 'minecraft:stone'] }],
      },
    })
  })

  it('snake_case（show_others / part_type_key）仅作旧数据读取回退，camelCase 优先', () => {
    const legacy = statsConfigFromV2Template({
      mode: 'custom',
      show_others: false,
      groups: [{ label: 'g', entries: [{ block_state_id: '', part_type_key: 'a:b:1' } as never] }],
    })
    expect(legacy!.rules!.showOthers).toBe(false)
    expect(legacy!.rules!.groups![0]!.match).toEqual(['a:b:1'])

    const both = statsConfigFromV2Template({
      mode: 'custom', showOthers: true, show_others: false, groups: [],
    } as never)
    expect(both!.rules!.showOthers).toBe(true) // camelCase 落盘权威
  })

  it('null/undefined ⇒ null（该层不发言）', () => {
    expect(statsConfigFromV2Template(null)).toBeNull()
    expect(statsConfigFromV2Template(undefined)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 文档覆盖（statsOverride 根字段）+ 查看者本地（localStorage）
// ---------------------------------------------------------------------------

describe('文档覆盖层（statsOverride）', () => {
  it('从文档根读取并宽松校验；损坏数据静默丢弃', () => {
    expect(statsOverrideFromDocumentRoot({
      statsOverride: { view: 'custom', rules: { ignore: ['a:*'], sortBy: 'nonsense', scale: { 'a:b': 'x' } } },
    })).toEqual({ view: 'custom', rules: { ignore: ['a:*'] } })
    expect(statsOverrideFromDocumentRoot({ statsOverride: 'garbage' })).toBeNull()
    expect(statsOverrideFromDocumentRoot({})).toBeNull()
    expect(statsOverrideFromDocumentRoot(null)).toBeNull()
  })

  it('parse/serialize 往返一致', () => {
    const layer = {
      view: 'custom' as const,
      rules: { ignore: ['a:*'], scale: { 'a:b': 0.5 }, keyGranularity: 'registry' as const, showHostRows: true },
    }
    expect(parseStatsConfigLayer(serializeStatsConfigLayer(layer))).toEqual(layer)
  })
})

describe('查看者本地层（localStorage）', () => {
  it('node 环境无 localStorage ⇒ 读 null、写不抛', () => {
    expect(loadViewerLocalStatsConfig('doc-x')).toBeNull()
    expect(() => saveViewerLocalStatsConfig('doc-x', { view: 'hosts' })).not.toThrow()
  })

  it('有 localStorage 时：写读往返 + null 清除；损坏数据读 null', () => {
    const store = new Map<string, string>()
    const fake = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    } as Storage
    const g = globalThis as { localStorage?: Storage }
    g.localStorage = fake
    try {
      saveViewerLocalStatsConfig('doc-1', { view: 'hosts', rules: { sortBy: 'label' } })
      expect(loadViewerLocalStatsConfig('doc-1')).toEqual({ view: 'hosts', rules: { sortBy: 'label' } })
      // schema 不符 ⇒ null
      store.set(viewerLocalStatsStorageKey('doc-2'), JSON.stringify({ schema: 999, config: { view: 'hosts' } }))
      expect(loadViewerLocalStatsConfig('doc-2')).toBeNull()
      // 损坏 JSON ⇒ null
      store.set(viewerLocalStatsStorageKey('doc-3'), '{oops')
      expect(loadViewerLocalStatsConfig('doc-3')).toBeNull()
      // null 清除
      saveViewerLocalStatsConfig('doc-1', null)
      expect(loadViewerLocalStatsConfig('doc-1')).toBeNull()
    } finally {
      delete g.localStorage
    }
  })
})

// ---------------------------------------------------------------------------
// 三级配置端到端：文档默认 → 文档覆盖 → 查看者本地（互不乱序 + 来源可见）
// ---------------------------------------------------------------------------

describe('三级配置端到端（fixture 文档默认 + 覆盖 + 本地）', () => {
  it('fixture 文档默认 = auto(部件视图)；覆盖与本地按优先级接管，provenance 逐字段可见', () => {
    const docDefault = statsConfigFromV2Template(
      (singleboxFixture as unknown as { statsTemplate?: Parameters<typeof statsConfigFromV2Template>[0] }).statsTemplate,
    )
    expect(docDefault).toEqual({ view: 'parts' })

    const { config, provenance } = resolveStatsConfig({
      documentDefault: docDefault,
      documentOverride: { view: 'custom', rules: { groups: [{ title: '板材', match: ['minecraft:stone_slab:*'] }] } },
      viewerLocal: { rules: { sortBy: 'key' } },
    })
    expect(config.view).toBe('custom')
    expect(provenance.view).toBe('document-override')
    expect(provenance.rules.groups).toBe('document-override')
    expect(provenance.rules.sortBy).toBe('viewer-local')

    // 端到端：fixture 上跑合成后的配置 —— 板材组 3 件，其余进"其他"
    const r = buildStatsViewForDefinition(defOf(singleboxFixture), 'all', config)
    expect(r.groups.map(g => g.title)).toEqual(['板材', '其他'])
    expect(r.groups[0]!.rows).toEqual([
      { key: 'minecraft:stone_slab:0', kind: 'part', label: 'Stone Slab', count: 3, iconKey: 'minecraft:stone_slab:0' },
    ])
    expect(r.groups[1]!.rows.map(row => row.key)).toEqual(['minecraft:fence:0'])
  })
})
