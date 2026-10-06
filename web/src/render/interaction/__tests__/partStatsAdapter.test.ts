/**
 * 统计适配层 + fixture 断言（B-3：纯物品清单，决策 C 落地）。
 *
 * 契约：`docs/contracts/format-parts-contract.md`
 *   （§2 文件表达、§2.2 物品索引表、§9 已废弃）。
 *
 * fixture（契约 §14）：
 *  - parts-singlebox-mix.v2.json：下半 slab×2 + 上半 slab（同物品身份合并 ⇒ 3）+ 栅栏（1）+ 石头（宿主对照）
 *  - parts-ae2-multibox.v2.json：一格三部件三种物品身份（各计 1）+ 石头
 *  - minimal-v2.json：无部件旧文件（退化语义：调用方走宿主清单旧路径）
 * 硬约束：无部件旧文件 = 今天行为（宿主计数仍由 `countBlocksById` 原样提供，逐项一致）；
 * 决策 C：规则能力 / 三级配置（statsTemplate / statsOverride / localStorage）通道**整套移除**。
 */
import { describe, it, expect } from 'vitest'
import * as partStatsModule from '@/pure/partStats'
import * as adapterModule from '@/render/interaction/partStatsAdapter'
import type { StructureDefinition } from '@/render/schema/types'
import { countBlocksById } from '@/render/interaction/blockStats'
import {
  buildItemStatsForDefinition,
  buildItemStatsInput,
  collectPartsForStats,
} from '@/render/interaction/partStatsAdapter'

import singleboxFixture from '../../../../e2e/fixtures/parts-singlebox-mix.v2.json'
import ae2Fixture from '../../../../e2e/fixtures/parts-ae2-multibox.v2.json'
import minimalV2 from '../../../../e2e/fixtures/minimal-v2.json'

type Doc = { frames: Array<{ structure: unknown }>; statsTemplate?: unknown }

function defOf(doc: unknown): StructureDefinition {
  return (doc as Doc).frames[0]!.structure as StructureDefinition
}

// ---------------------------------------------------------------------------
// 决策 C 移除锁：能力清单（导出面 + 已删除文件）
// ---------------------------------------------------------------------------

describe('决策 C 移除锁：规则能力与三级配置通道整套移除', () => {
  it('引擎只导出 buildItemStats / partItemKey（无 StatsRules / resolveStatsConfig / 视图与 provenance 类型）', () => {
    expect(Object.keys(partStatsModule).sort()).toEqual(['buildItemStats', 'partItemKey'])
  })

  it('适配层只导出收集/输入/一行式（无 statsConfigFromV2Template / statsOverrideFromDocumentRoot / parse / serialize）', () => {
    expect(Object.keys(adapterModule).sort()).toEqual([
      'buildItemStatsForDefinition', 'buildItemStatsInput', 'collectPartsForStats',
    ])
  })

  it('查看者本地层 IO 壳 statsConfigStorage 已从源码树移除（localStorage 不再读写）', () => {
    // 源码树清单（Vite glob；不引 @types/node —— 见 web/src/context/__tests__/multiblockFixtureIo.mjs 的
    // 同名约定：TS 测试里直接 import node 内建会让 `npm run typecheck` 新增报错）。
    const sources = Object.keys(import.meta.glob('/src/render/interaction/*.ts'))
    expect(sources).not.toContain('/src/render/interaction/statsConfigStorage.ts')
    // 正对照：同目录其它模块在列（保证上面的断言不是空集上的假绿）
    expect(sources).toContain('/src/render/interaction/partStatsAdapter.ts')
    expect(sources).toContain('/src/render/interaction/blockStats.ts')
  })
})

// ---------------------------------------------------------------------------
// fixture 断言：物品清单（数值正确）
// ---------------------------------------------------------------------------

describe('fixture：物品清单', () => {
  it('单盒混存：stone_slab:0 计 3（下半×2 + 上半×1 合并）、fence:0 计 1；石头宿主不出现', () => {
    const def = defOf(singleboxFixture)
    const r = buildItemStatsForDefinition(def, 'all')
    expect(r.degenerated).toBeUndefined()
    expect(r.itemlessPartCount).toBe(0)
    expect(r.rows).toEqual([
      { key: 'minecraft:stone_slab:0', label: 'Stone Slab', count: 3, iconKey: 'minecraft:stone_slab:0' },
      { key: 'minecraft:fence:0', label: 'Fence', count: 1, iconKey: 'minecraft:fence:0' },
    ])
    expect(r.rows.some(row => row.key === 'minecraft:stone')).toBe(false) // 满方块宿主不进物品清单
  })

  it('AE2 多部件格：三种物品身份各计 1，并列按行键字典序', () => {
    const def = defOf(ae2Fixture)
    const r = buildItemStatsForDefinition(def, 'all')
    expect(r.rows).toEqual([
      { key: 'appliedenergistics2:item.ItemMultiPart:16', label: 'ME Glass Cable - Fluix', count: 1, iconKey: 'appliedenergistics2:item.ItemMultiPart:16' },
      { key: 'appliedenergistics2:item.ItemMultiPart:220', label: 'ME Storage Bus', count: 1, iconKey: 'appliedenergistics2:item.ItemMultiPart:220' },
      { key: 'appliedenergistics2:item.ItemMultiPart:80', label: 'ME Toggle Bus', count: 1, iconKey: 'appliedenergistics2:item.ItemMultiPart:80' },
    ])
  })

  it('无部件行混入：engine 输出行键全部 = 物品身份键（无宿主键形态）', () => {
    const r = buildItemStatsForDefinition(defOf(singleboxFixture), 'all')
    for (const row of r.rows) {
      expect(row.key).toBe(row.iconKey)
      expect(row.key).toMatch(/^[^@]+:\d+(#.+)?$/) // registry:damage[#nbt]，无宿主 `@meta` 形态
    }
  })
})

// ---------------------------------------------------------------------------
// 硬约束：无部件旧文件 = 今天行为（宿主计数旧口径原样保留）
// ---------------------------------------------------------------------------

describe('无部件旧文件：退化语义 + 宿主计数旧口径', () => {
  it('minimal-v2：引擎退化（空行集 + 标记）；宿主计数 = countBlocksById 原样（旧路径数据源不变）', () => {
    const def = defOf(minimalV2)
    const deg = buildItemStatsForDefinition(def, 'all')
    expect(deg.degenerated).toBe('parts-to-hosts')
    expect(deg.rows).toEqual([])
    expect(deg.itemlessPartCount).toBe(0)

    // 旧口径仍由 blockStats 提供（侧栏旧路径读的就是它）——逐项不变
    expect([...countBlocksById(def, 'all')]).toEqual([['minecraft:gold_ore', 8]])
  })

  it('当前过滤层无部件 ⇒ 同样退化（与 countBlocksById 同层语义）', () => {
    const def = defOf(singleboxFixture) // cellGrid 单 row（sizeRow=1 ⇒ row 0 = worldY 0）
    expect(buildItemStatsForDefinition(def, { worldY: 1 }).degenerated).toBe('parts-to-hosts')
    expect(countBlocksById(def, { worldY: 1 }).size).toBe(0)
  })

  it('collectPartsForStats：无 cellPartsGrid/partLists ⇒ 空数组', () => {
    expect(collectPartsForStats(defOf(minimalV2), 'all')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 兼容兜底：旧文档根字段（statsTemplate / statsOverride）静默忽略
// ---------------------------------------------------------------------------

describe('兼容兜底：旧文档根字段不进引擎输入', () => {
  it('携带 statsTemplate(mode=custom) / statsOverride(view=hosts) 的旧文档 ⇒ 输入只有 parts，输出与无配置时逐项相同', () => {
    const base = defOf(singleboxFixture)
    const withLegacyConfig = {
      ...base,
      statsTemplate: { mode: 'custom', groups: [{ label: '板材', entries: [{ partTypeKey: 'minecraft:stone_slab:0' }] }] },
      statsOverride: { view: 'hosts', rules: { showHostRows: true } },
    } as unknown as StructureDefinition

    expect(Object.keys(buildItemStatsInput(withLegacyConfig, 'all'))).toEqual(['parts'])
    expect(buildItemStatsForDefinition(withLegacyConfig, 'all'))
      .toEqual(buildItemStatsForDefinition(base, 'all'))
  })

  it('旧文档根字段不改变无部件文件的退化判定', () => {
    const bare = defOf(minimalV2)
    const withLegacyConfig = {
      ...bare,
      statsTemplate: { mode: 'custom', groups: [] },
      statsOverride: { view: 'parts' },
    } as unknown as StructureDefinition
    expect(buildItemStatsForDefinition(withLegacyConfig, 'all').degenerated).toBe('parts-to-hosts')
    expect(buildItemStatsForDefinition(withLegacyConfig, 'all').rows).toEqual([])
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
    expect(buildItemStatsInput(def, { worldY: 1 }).parts).toHaveLength(0)
    expect(countBlocksById(def, { worldY: 1 }).size).toBe(0)
  })
})
