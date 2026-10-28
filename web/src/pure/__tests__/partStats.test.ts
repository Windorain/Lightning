/**
 * 统计引擎单测（pure/partStats）—— 纯物品清单（B-3 决策 C 落地）。
 *
 * 契约：`docs/contracts/format-parts-contract.md`
 *   §2.2（物品索引表：**左栏行键恒等于物品身份键**）、§5（物品身份 = 计数单位 = 可合成物品）、
 *   §9（**已废弃** —— 规则能力与三级配置的移除依据）。
 *
 * 覆盖：行键 = 物品身份键（typeKey / 折叠粒度不再参与）、数量口径 = 物品件数、排序固定
 * （数量降序 + 并列行键字典序）、`items: []` 未计入提示、无部件退化标记、输入不可变。
 * 宿主清单（旧口径）口径锁定在 `render/interaction/__tests__/partStatsAdapter.test.ts`（适配层桥接）
 * 与 `embed/components/__tests__/blockStatsSidebar.legacyHostRows.dom.test.ts`（DOM 回归锁）。
 */
import { describe, it, expect } from 'vitest'
import {
  buildItemStats,
  partItemKey,
  type ItemStatsInput,
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

function input(parts: PartRecord[]): ItemStatsInput {
  return { parts }
}

// ---------------------------------------------------------------------------
// 键工具
// ---------------------------------------------------------------------------

describe('partItemKey：物品身份键', () => {
  it('registry:damage[#nbt]；无 nbtDiscriminator / 空串 ⇒ 不带 `#` 段', () => {
    expect(partItemKey({ registry: 'minecraft:stone_slab', damage: 0, count: 1 })).toBe('minecraft:stone_slab:0')
    expect(partItemKey({ registry: 'fmp:microblock', damage: 1, nbtDiscriminator: 'mat=stone', count: 1 }))
      .toBe('fmp:microblock:1#mat=stone')
    expect(partItemKey({ registry: 'a:item', damage: 16, nbtDiscriminator: '', count: 1 })).toBe('a:item:16')
  })
})

// ---------------------------------------------------------------------------
// 物品清单（决策 C 唯一形态）
// ---------------------------------------------------------------------------

describe('物品清单：行键 = 物品身份键', () => {
  it('同物品身份合并计数；label = 部件 displayName；iconKey = 行键 = 物品身份键', () => {
    const twoSlab = [
      part({ typeKey: 'minecraft:stone_slab:0', displayName: 'Stone Slab', items: [{ registry: 'minecraft:stone_slab', damage: 0, count: 1 }] }),
      part({ typeKey: 'minecraft:stone_slab:0', displayName: 'Stone Slab', items: [{ registry: 'minecraft:stone_slab', damage: 0, count: 1 }] }),
    ]
    const r = buildItemStats(input(twoSlab))
    expect(r.degenerated).toBeUndefined()
    expect(r.itemlessPartCount).toBe(0)
    expect(r.rows).toEqual([
      { key: 'minecraft:stone_slab:0', label: 'Stone Slab', count: 2, iconKey: 'minecraft:stone_slab:0' },
    ])
  })

  it('行键取物品身份键而非 typeKey（无折叠/别名通道：行键直通物品索引表，契约 §9）', () => {
    // 生产侧不变量：typeKey ≡ PartItem 身份（PartsFamilyProviderProbe 断言）；此处刻意造"不同形"
    // 以钉死"行键来源 = 物品身份键"，防回归到旧 typeKey 口径。
    const odd = part({
      typeKey: 'weird:merge:key#granularity',
      displayName: 'X',
      items: [{ registry: 'a:item', damage: 3, count: 1 }],
    })
    expect(buildItemStats(input([odd])).rows).toEqual([
      { key: 'a:item:3', label: 'X', count: 1, iconKey: 'a:item:3' },
    ])
  })

  it('一部件 ≠ 一物品：items 多条目逐条计数，附加条目自成一个物品行（label = 其身份键）', () => {
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
    const byKey = new Map(buildItemStats(input([fmpSlab, busWithCard])).rows.map(row => [row.key, row]))
    expect(byKey.get('fmp:microblock:1#mat=stone')).toEqual({
      key: 'fmp:microblock:1#mat=stone', label: 'Stone Microblock', count: 2, iconKey: 'fmp:microblock:1#mat=stone',
    })
    expect(byKey.get('a:item:220')).toEqual({
      key: 'a:item:220', label: 'ME Storage Bus', count: 1, iconKey: 'a:item:220',
    })
    expect(byKey.get('a:item:420')).toEqual({
      key: 'a:item:420', label: 'a:item:420', count: 2, iconKey: 'a:item:420',
    })
  })

  it('数量口径 = 物品件数（导出侧给定小数原样累计，本引擎不做系数换算）', () => {
    const halves = [
      part({ typeKey: 'fmp:microblock:1#mat=stone', displayName: 'Stone Microblock', items: [{ registry: 'fmp:microblock', damage: 1, nbtDiscriminator: 'mat=stone', count: 0.5 }] }),
      part({ typeKey: 'fmp:microblock:1#mat=stone', displayName: 'Stone Microblock', items: [{ registry: 'fmp:microblock', damage: 1, nbtDiscriminator: 'mat=stone', count: 0.5 }] }),
    ]
    expect(buildItemStats(input(halves)).rows).toEqual([
      { key: 'fmp:microblock:1#mat=stone', label: 'Stone Microblock', count: 1, iconKey: 'fmp:microblock:1#mat=stone' },
    ])
  })

  it('排序固定 = 数量降序，并列按行键字典序（无 sortBy 入口）', () => {
    const parts = [
      part({ typeKey: 'a:item:16', items: [{ registry: 'a:item', damage: 16, count: 3 }] }),
      part({ typeKey: 'a:item:220', items: [{ registry: 'a:item', damage: 220, count: 1 }] }),
      part({ typeKey: 'a:item:80', items: [{ registry: 'a:item', damage: 80, count: 3 }] }),
      part({ typeKey: 'minecraft:fence:0', displayName: 'Fence', items: [{ registry: 'minecraft:fence', damage: 0, count: 9 }] }),
    ]
    expect(buildItemStats(input(parts)).rows.map(r => [r.key, r.count])).toEqual([
      ['minecraft:fence:0', 9],
      ['a:item:16', 3],
      ['a:item:80', 3],
      ['a:item:220', 1],
    ])
  })

  it('items: [] 部件计入 itemlessPartCount，不产生物品行（有部件但全无物品 ⇒ 不退化）', () => {
    const ghost = part({ typeKey: 'x:ghost:0', items: [] })
    const real = part({ typeKey: 'x:real:0', items: [{ registry: 'x:real', damage: 0, count: 1 }] })
    const r = buildItemStats(input([ghost, ghost, real]))
    expect(r.itemlessPartCount).toBe(2)
    expect(r.rows.map(row => row.key)).toEqual(['x:real:0'])
    expect(r.degenerated).toBeUndefined()

    const allGhost = buildItemStats(input([ghost]))
    expect(allGhost.rows).toEqual([])
    expect(allGhost.itemlessPartCount).toBe(1)
    expect(allGhost.degenerated).toBeUndefined()
  })

  it('无规则能力残留：结果只有 rows / itemlessPartCount（无 groups / view / provenance / hostCounts）', () => {
    const r = buildItemStats(input([
      part({ typeKey: 'a:item:16', items: [{ registry: 'a:item', damage: 16, count: 1 }] }),
    ]))
    expect(Object.keys(r).sort()).toEqual(['itemlessPartCount', 'rows'])
    expect(Object.keys(r.rows[0]!).sort()).toEqual(['count', 'iconKey', 'key', 'label'])
  })
})

// ---------------------------------------------------------------------------
// 无部件退化（旧文件 = 今天行为；宿主清单由调用方旧路径生成）
// ---------------------------------------------------------------------------

describe('无部件退化', () => {
  it('parts 为空 ⇒ 空行集 + degenerated: parts-to-hosts（宿主清单不走引擎）', () => {
    const r = buildItemStats(input([]))
    expect(r.degenerated).toBe('parts-to-hosts')
    expect(r.rows).toEqual([])
    expect(r.itemlessPartCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 纯函数契约
// ---------------------------------------------------------------------------

describe('纯函数契约：不修改入参', () => {
  it('入参 parts 与 items 计数不被引擎改写', () => {
    const item = { registry: 'a:item', damage: 16, count: 2 }
    const p = part({ typeKey: 'a:item:16', items: [item] })
    const parts = [p, p]
    const before = JSON.stringify(parts)
    buildItemStats(input(parts))
    expect(JSON.stringify(parts)).toBe(before)
  })
})
