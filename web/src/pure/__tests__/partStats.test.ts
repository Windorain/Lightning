/**
 * P2.3 统计引擎单测（pure/partStats）。
 *
 * 契约：`docs/contracts/format-parts-contract.md` §5（计数单位 = 可合成物品、typeKey = 合并键）、
 * §9（三级配置，**已废弃**——兼容口径 = 读取后静默忽略）；计划 §4 P2.3 硬约束。规则/存储拍板见 pure/partStats.ts 文件头（留白 #6）。
 * fixture 数值断言在 render/interaction/__tests__/partStatsAdapter.test.ts（需要适配层桥接）。
 */
import { describe, it, expect } from 'vitest'
import {
  buildStatsView,
  builtinStatsConfig,
  foldKeyGranularity,
  partItemKey,
  resolveStatsConfig,
  type PartStatsInput,
  type ResolvedStatsConfig,
} from '@/pure/partStats'
import type { PartRecord, PartSource } from '@/pure/partTypes'

// ---------------------------------------------------------------------------
// 构造辅助
// ---------------------------------------------------------------------------

const TIER1: PartSource = { family: 'ae2', fallback: false, boxProvenance: 'both', tier: 1 }

function part(partial: Partial<PartRecord> & Pick<PartRecord, 'typeKey' | 'items'>): PartRecord {
  return {
    localId: 'ae2:UNKNOWN',
    displayName: partial.typeKey,
    tooltip: [],
    boxes: [{ min: [0, 0, 0], max: [1, 1, 1], kind: 'visual' }],
    source: TIER1,
    ...partial,
  }
}

function input(parts: PartRecord[], hostCounts: Record<string, number> = {}): PartStatsInput {
  return { parts, hostCounts: new Map(Object.entries(hostCounts)) }
}

function cfg(view: ResolvedStatsConfig['view'], rules: ResolvedStatsConfig['rules'] = {}): ResolvedStatsConfig {
  return { view, rules }
}

function allRows(result: ReturnType<typeof buildStatsView>) {
  return result.groups.flatMap(g => g.rows)
}

// ---------------------------------------------------------------------------
// 键工具
// ---------------------------------------------------------------------------

describe('partItemKey / foldKeyGranularity', () => {
  it('物品身份键：registry:damage[#nbt]', () => {
    expect(partItemKey({ registry: 'minecraft:stone_slab', damage: 0, count: 1 })).toBe('minecraft:stone_slab:0')
    expect(partItemKey({ registry: 'fmp:microblock', damage: 1, nbtDiscriminator: 'mat=stone', count: 1 }))
      .toBe('fmp:microblock:1#mat=stone')
  })

  it('粒度折叠：full 原样；damage 去 #nbt；registry 再去 :damage（registry 内含冒号）', () => {
    const fmpKey = 'fmp:microblock:1#mat=stone'
    expect(foldKeyGranularity(fmpKey, 'full')).toBe(fmpKey)
    expect(foldKeyGranularity(fmpKey, 'damage')).toBe('fmp:microblock:1')
    expect(foldKeyGranularity(fmpKey, 'registry')).toBe('fmp:microblock')
    const ae2Key = 'appliedenergistics2:item.ItemMultiPart:16'
    expect(foldKeyGranularity(ae2Key, 'registry')).toBe('appliedenergistics2:item.ItemMultiPart')
  })
})

// ---------------------------------------------------------------------------
// 默认部件视图（语义钉死：按 typeKey 分组计数；仅 ignore/sortBy/showHostRows 生效）
// ---------------------------------------------------------------------------

describe('部件物品清单视图（默认）', () => {
  const twoSlab = [
    part({ typeKey: 'minecraft:stone_slab:0', displayName: 'Stone Slab', items: [{ registry: 'minecraft:stone_slab', damage: 0, count: 1 }] }),
    part({ typeKey: 'minecraft:stone_slab:0', displayName: 'Stone Slab', items: [{ registry: 'minecraft:stone_slab', damage: 0, count: 1 }] }),
  ]

  it('同 typeKey 合并计数；label = 游戏内 displayName；iconKey = 物品身份键', () => {
    const r = buildStatsView(input(twoSlab), cfg('parts'))
    expect(r.degenerated).toBeUndefined()
    expect(allRows(r)).toEqual([
      { key: 'minecraft:stone_slab:0', kind: 'part', label: 'Stone Slab', count: 2, iconKey: 'minecraft:stone_slab:0' },
    ])
  })

  it('一格多物算 N 件：多部件格逐条累加', () => {
    const cell = [
      part({ localId: 'ae2:UNKNOWN', typeKey: 'a:item:16', items: [{ registry: 'a:item', damage: 16, count: 1 }] }),
      part({ localId: 'ae2:NORTH', typeKey: 'a:item:80', items: [{ registry: 'a:item', damage: 80, count: 1 }] }),
      part({ localId: 'ae2:UP', typeKey: 'a:item:220', items: [{ registry: 'a:item', damage: 220, count: 1 }] }),
    ]
    const r = buildStatsView(input(cell), cfg('parts'))
    // 等数并列按 key 字典序（'16' < '220' < '80'）
    expect(allRows(r).map(row => [row.key, row.count])).toEqual([
      ['a:item:16', 1], ['a:item:220', 1], ['a:item:80', 1],
    ])
  })

  it('一部件 ≠ 一物品：items 多条目逐条计数（FMP size>1 拆多件 / AE2 升级卡附加条目）', () => {
    const fmpSlab = part({
      typeKey: 'fmp:microblock:1#mat=stone',
      displayName: 'Stone Microblock',
      items: [{ registry: 'fmp:microblock', damage: 1, nbtDiscriminator: 'mat=stone', count: 2 }], // size=4 slab 掉 2 件
    })
    const busWithCard = part({
      typeKey: 'a:item:220',
      displayName: 'ME Storage Bus',
      items: [
        { registry: 'a:item', damage: 220, count: 1 },
        { registry: 'a:item', damage: 420, count: 2 }, // 附加：升级卡 ×2，独立行键
      ],
    })
    const r = buildStatsView(input([fmpSlab, busWithCard]), cfg('parts'))
    const byKey = new Map(allRows(r).map(row => [row.key, row]))
    expect(byKey.get('fmp:microblock:1#mat=stone')?.count).toBe(2)
    expect(byKey.get('a:item:220')?.count).toBe(1)
    expect(byKey.get('a:item:420')?.count).toBe(2) // 附加条目独立成行
  })

  it('items: [] 部件计入 itemlessPartCount，不产生物品行', () => {
    const ghost = part({ typeKey: 'x:ghost:0', items: [] })
    const real = part({ typeKey: 'x:real:0', items: [{ registry: 'x:real', damage: 0, count: 1 }] })
    const r = buildStatsView(input([ghost, ghost, real]), cfg('parts'))
    expect(r.itemlessPartCount).toBe(2)
    expect(allRows(r)).toHaveLength(1)
  })

  it('默认视图不受合并规则影响（granularity/aliases/scale/groups 仅自定义视图）；ignore/sortBy 生效', () => {
    const parts16 = [
      part({ typeKey: 'a:item:16', items: [{ registry: 'a:item', damage: 16, count: 1 }] }),
      part({ typeKey: 'a:item:80', items: [{ registry: 'a:item', damage: 80, count: 1 }] }),
    ]
    const r = buildStatsView(input(parts16), cfg('parts', {
      keyGranularity: 'registry',
      aliases: { 'a:item:16': 'a:item:80' },
      scale: { 'a:item:16': 99 },
      groups: [{ title: 'g', match: ['a:item:*'] }],
      ignore: ['a:item:80'],
      sortBy: 'key',
    }))
    expect(allRows(r)).toEqual([
      { key: 'a:item:16', kind: 'part', label: 'a:item:16', count: 1, iconKey: 'a:item:16' },
    ])
  })

  it('showHostRows：末尾追加宿主清单组（默认标题 宿主方块，可覆盖）', () => {
    const r = buildStatsView(
      input(twoSlab, { 'minecraft:stone': 5 }),
      cfg('parts', { showHostRows: true }),
    )
    expect(r.groups).toHaveLength(2)
    expect(r.groups[1]!.title).toBe('宿主方块')
    expect(r.groups[1]!.rows).toEqual([
      { key: 'minecraft:stone', kind: 'host', label: 'minecraft:stone', count: 5, iconKey: 'minecraft:stone' },
    ])
  })
})

// ---------------------------------------------------------------------------
// 宿主视图（旧口径：数值 = hostCounts 原样；仅 sortBy 生效）
// ---------------------------------------------------------------------------

describe('宿主清单视图（旧口径）', () => {
  it('数值与 countBlocksById 结果一致；默认 key 字典序（与旧 buildBlockStatsEntries 一致）', () => {
    const hosts = { 'minecraft:stone': 3, 'minecraft:fence': 1, 'minecraft:stone_slab@8': 2 }
    const r = buildStatsView(input([], hosts), cfg('hosts'))
    expect(r.view).toBe('hosts')
    expect(r.degenerated).toBeUndefined()
    expect(allRows(r).map(row => [row.key, row.count])).toEqual([
      ['minecraft:fence', 1],
      ['minecraft:stone', 3],
      ['minecraft:stone_slab@8', 2],
    ])
  })

  it('规则不改写宿主数值（ignore/scale/aliases 不适用；sortBy 适用）', () => {
    const hosts = { 'a:x': 2, 'b:y': 9 }
    const r = buildStatsView(input([], hosts), cfg('hosts', {
      ignore: ['a:x'], scale: { 'a:x': 100 }, aliases: { 'a:x': 'b:y' }, sortBy: 'count-desc',
    }))
    expect(allRows(r).map(row => [row.key, row.count])).toEqual([['b:y', 9], ['a:x', 2]])
  })
})

// ---------------------------------------------------------------------------
// 无部件退化语义（硬约束：无部件旧文件 = 今天行为）
// ---------------------------------------------------------------------------

describe('无部件退化', () => {
  it('parts 为空 ⇒ parts 视图退化为宿主清单，带 degenerated 标记，行集 = hosts 视图', () => {
    const hosts = { 'minecraft:stone': 4 }
    const deg = buildStatsView(input([], hosts), cfg('parts'))
    const host = buildStatsView(input([], hosts), cfg('hosts'))
    expect(deg.degenerated).toBe('parts-to-hosts')
    expect(deg.view).toBe('parts')
    expect(deg.groups).toEqual(host.groups)
  })

  it('custom 视图同样退化', () => {
    const r = buildStatsView(input([], { 'a:b': 1 }), cfg('custom', { showHostRows: false }))
    expect(r.degenerated).toBe('parts-to-hosts')
    expect(allRows(r)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 自定义分组视图（规则全量生效）
// ---------------------------------------------------------------------------

describe('自定义分组视图', () => {
  const cables = [
    part({ typeKey: 'a:item:16', displayName: 'ME Glass Cable - Fluix', items: [{ registry: 'a:item', damage: 16, count: 3 }] }),
    part({ typeKey: 'a:item:17', displayName: 'ME Glass Cable - White', items: [{ registry: 'a:item', damage: 17, count: 2 }] }),
    part({ typeKey: 'a:item:80', displayName: 'ME Toggle Bus', items: [{ registry: 'a:item', damage: 80, count: 1 }] }),
    part({ typeKey: 'minecraft:fence:0', displayName: 'Fence', items: [{ registry: 'minecraft:fence', damage: 0, count: 4 }] }),
  ]

  it('keyGranularity=registry：线缆颜色（damage 变体）坍缩合并', () => {
    const r = buildStatsView(input(cables), cfg('custom', { keyGranularity: 'registry', sortBy: 'key' }))
    const byKey = new Map(allRows(r).map(row => [row.key, row]))
    expect(byKey.get('a:item')?.count).toBe(6) // 3 + 2 + 1
    expect(byKey.get('minecraft:fence')?.count).toBe(4)
  })

  it('keyGranularity=damage：FMP 材料串坍缩，damage 保留', () => {
    const fmp = [
      part({ typeKey: 'fmp:microblock:1#mat=stone', items: [{ registry: 'fmp:microblock', damage: 1, nbtDiscriminator: 'mat=stone', count: 1 }] }),
      part({ typeKey: 'fmp:microblock:1#mat=wood', items: [{ registry: 'fmp:microblock', damage: 1, nbtDiscriminator: 'mat=wood', count: 1 }] }),
    ]
    const r = buildStatsView(input(fmp), cfg('custom', { keyGranularity: 'damage' }))
    expect(allRows(r)).toHaveLength(1)
    expect(allRows(r)[0]!.key).toBe('fmp:microblock:1')
    expect(allRows(r)[0]!.count).toBe(2)
  })

  it('aliases：跨键别名合并（作用于粒度折叠之后）', () => {
    const r = buildStatsView(input(cables), cfg('custom', {
      aliases: { 'a:item:16': 'a:item:17' }, sortBy: 'key',
    }))
    const byKey = new Map(allRows(r).map(row => [row.key, row]))
    expect(byKey.get('a:item:17')?.count).toBe(5) // 3 + 2
    expect(byKey.has('a:item:16')).toBe(false)
  })

  it('scale：系数换算（允许小数）；原始键优先于合并后键', () => {
    const r = buildStatsView(input(cables), cfg('custom', {
      keyGranularity: 'registry',
      scale: { 'a:item:16': 0.5, 'minecraft:fence': 2 },
    }))
    const byKey = new Map(allRows(r).map(row => [row.key, row]))
    expect(byKey.get('a:item')?.count).toBe(3 * 0.5 + 2 + 1) // 16 号条目按原始键 ×0.5
    expect(byKey.get('minecraft:fence')?.count).toBe(8)
  })

  it('ignore：精确与 `prefix*` 通配，原始键/合并后键任一命中即丢弃', () => {
    const r = buildStatsView(input(cables), cfg('custom', { ignore: ['a:item:80', 'minecraft:*'] }))
    expect(allRows(r).map(row => row.key).sort()).toEqual(['a:item:16', 'a:item:17'])
  })

  it('groups：显式分组按声明顺序，组内排序，未匹配进"其他"（showOthers=false 则丢弃）', () => {
    const rules = {
      groups: [
        { title: '线缆', match: ['a:item:16', 'a:item:17'] },
        { title: '总线', match: ['a:item:80'] },
      ],
      sortBy: 'count-desc' as const,
    }
    const r = buildStatsView(input(cables), cfg('custom', rules))
    expect(r.groups.map(g => g.title)).toEqual(['线缆', '总线', '其他'])
    expect(r.groups[0]!.rows.map(row => row.key)).toEqual(['a:item:16', 'a:item:17']) // 3 > 2
    expect(r.groups[2]!.rows.map(row => row.key)).toEqual(['minecraft:fence:0'])

    const noOthers = buildStatsView(input(cables), cfg('custom', { ...rules, showOthers: false }))
    expect(noOthers.groups.map(g => g.title)).toEqual(['线缆', '总线'])

    const titled = buildStatsView(input(cables), cfg('custom', { ...rules, othersTitle: '杂项' }))
    expect(titled.groups[2]!.title).toBe('杂项')
  })

  it('groups 声明中空组不输出', () => {
    const r = buildStatsView(input(cables), cfg('custom', {
      groups: [{ title: '不存在', match: ['zzz:*'] }, { title: '栅栏', match: ['minecraft:*'] }],
    }))
    expect(r.groups.map(g => g.title)).toEqual(['栅栏', '其他'])
  })

  it('showHostRows + groups：宿主组独立于自定义分组追加在末尾', () => {
    const r = buildStatsView(
      input(cables, { 'minecraft:stone': 7 }),
      cfg('custom', { groups: [{ title: '线缆', match: ['a:item:*'] }], showHostRows: true, hostGroupTitle: '方块' }),
    )
    expect(r.groups.map(g => g.title)).toEqual(['线缆', '其他', '方块'])
    expect(r.groups[2]!.rows[0]).toMatchObject({ kind: 'host', count: 7 })
  })
})

// ---------------------------------------------------------------------------
// 三级配置解析（互不乱序 + 来源元信息）
// ---------------------------------------------------------------------------

describe('resolveStatsConfig 三级配置', () => {
  it('内建默认：部件物品清单视图', () => {
    const { config, provenance } = resolveStatsConfig({})
    expect(config).toEqual(builtinStatsConfig())
    expect(config.view).toBe('parts')
    expect(provenance.view).toBe('builtin')
  })

  it('优先级：查看者本地 > 文档覆盖 > 文档默认 > 内建（字段级，互不乱序）', () => {
    const { config, provenance } = resolveStatsConfig({
      documentDefault: { view: 'hosts', rules: { sortBy: 'key', ignore: ['a:*'] } },
      documentOverride: { view: 'custom', rules: { showOthers: false } },
      viewerLocal: { rules: { sortBy: 'label' } },
    })
    expect(config.view).toBe('custom') // 文档覆盖压过文档默认；本地未发言
    expect(config.rules.sortBy).toBe('label') // 本地压过文档默认
    expect(config.rules.ignore).toEqual(['a:*']) // 文档默认保留（更高层未覆盖此键）
    expect(config.rules.showOthers).toBe(false) // 文档覆盖
    expect(provenance.view).toBe('document-override')
    expect(provenance.rules.sortBy).toBe('viewer-local')
    expect(provenance.rules.ignore).toBe('document-default')
    expect(provenance.rules.showOthers).toBe('document-override')
  })

  it('规则键整体覆盖（不深合并）：高层 groups 替换低层 groups', () => {
    const { config } = resolveStatsConfig({
      documentDefault: { rules: { groups: [{ title: 'A', match: ['a:*'] }] } },
      viewerLocal: { rules: { groups: [{ title: 'B', match: ['b:*'] }] } },
    })
    expect(config.rules.groups).toEqual([{ title: 'B', match: ['b:*'] }])
  })
})
