/**
 * B-2 物品索引表 —— `pure/itemIndex` 解析与反查索引单测。
 *
 * 契约：`docs/contracts/format-parts-contract.md` §9（`itemIndex` 字段命名/序列化/归属表达）。
 * 覆盖：索引表解析（宽容）、source 派生、显式"无对应"（`none`）、说明行兜底、反查索引
 * （物品键 → 命中单元 = 部件 / 格）、去重与权威度排序、`blockPalette[].hostItem` 键工具。
 *
 * 测试数据形状 = mod 侧 `ItemIndexIntegrator` 的落盘形态（逐字段对齐，非假设）。
 */
import { describe, it, expect } from 'vitest'
import {
  ITEM_INDEX_FIELD,
  HOST_ITEM_FIELD,
  buildItemHitIndex,
  buildItemHitIndexFromIndex,
  hostItemKey,
  parseItemIndex,
  resolveItemHit,
  type ItemIndex,
} from '@/pure/itemIndex'

// ---------------------------------------------------------------------------
// 落盘形状样本（= ItemIndexIntegrator 输出）
// ---------------------------------------------------------------------------

/** 层①+② 命中：slab 部件格（part 权威度高于 host，两条都落盘） */
const SLAB_ENTRY = {
  display: 'Stone Slab',
  tooltip: ['Stone Slab'],
  source: 'part',
  attribution: [
    { source: 'part', frame: 0, grid: [0, 1, 0], localId: 'generic:0' },
    { source: 'part', frame: 0, grid: [0, 1, 2], localId: 'generic:0' },
    { source: 'host', frame: 0, grid: [0, 1, 0] },
  ],
}

/** 显式"无对应"：附加物品条目（`items[i>0]`）暂不做独立说明与对应 */
const NONE_ENTRY = {
  display: 'appliedenergistics2:item.ItemMultiPart:1',
  tooltip: ['appliedenergistics2:item.ItemMultiPart:1'],
  source: 'none',
  attribution: [],
}

const FIXTURE_INDEX = {
  'minecraft:stone_slab:0': SLAB_ENTRY,
  'appliedenergistics2:item.ItemMultiPart:1': NONE_ENTRY,
}

describe('parseItemIndex：宽容解析与兜底', () => {
  it('完整条目逐字段存活，source 与 attribution 首条同源', () => {
    const index = parseItemIndex(FIXTURE_INDEX)
    expect(Object.keys(index).sort()).toEqual([
      'appliedenergistics2:item.ItemMultiPart:1',
      'minecraft:stone_slab:0',
    ])
    const slab = index['minecraft:stone_slab:0']!
    expect(slab.display).toBe('Stone Slab')
    expect(slab.tooltip).toEqual(['Stone Slab'])
    expect(slab.source).toBe('part')
    expect(slab.attribution).toHaveLength(3)
    expect(slab.attribution[0]).toEqual({
      source: 'part', frame: 0, grid: [0, 1, 0], localId: 'generic:0',
    })
    // 无 localId 的宿主级命中不产出该键（不是 null/undefined 占位）
    expect('localId' in slab.attribution[2]!).toBe(false)
  })

  it('无对应是显式状态：attribution 空 + source none（不是缺数据）', () => {
    const index = parseItemIndex(FIXTURE_INDEX)
    const none = index['appliedenergistics2:item.ItemMultiPart:1']!
    expect(none.attribution).toEqual([])
    expect(none.source).toBe('none')
    // 键存在 ⇒ 与"键不在表里"可区分
    const hits = buildItemHitIndexFromIndex(index)
    expect(hits.get('appliedenergistics2:item.ItemMultiPart:1')!.unresolved).toBe(true)
    expect(hits.has('minecraft:torch:0')).toBe(false)
  })

  it('说明行兜底：tooltip 空/缺 ⇒ 至少 display 一行；display 缺 ⇒ 键本身', () => {
    const index = parseItemIndex({
      'a:b:0': { tooltip: [], attribution: [] },
      'a:c:0': { display: 'C', tooltip: ['只留一行'], attribution: [] },
      'a:d:0': { display: '', tooltip: ['x'], attribution: [] },
      'a:e:0': { display: 'E', tooltip: ['E', 7, null, 'E line 2'], attribution: [] },
    })
    expect(index['a:b:0']!.display).toBe('a:b:0')
    expect(index['a:b:0']!.tooltip).toEqual(['a:b:0'])
    expect(index['a:c:0']!.tooltip).toEqual(['只留一行'])
    expect(index['a:d:0']!.display).toBe('a:d:0')
    // 非字符串行被丢弃（宽容），字符串行保序
    expect(index['a:e:0']!.tooltip).toEqual(['E', 'E line 2'])
  })

  it('shape 不合的输入不抛：非对象 ⇒ 空表；坏条目/坏归属被丢弃（不猜）', () => {
    expect(parseItemIndex(null)).toEqual({})
    expect(parseItemIndex(undefined)).toEqual({})
    expect(parseItemIndex('itemIndex')).toEqual({})
    expect(parseItemIndex([1, 2])).toEqual({})
    const index = parseItemIndex({
      'a:ok:0': { display: 'OK', tooltip: ['OK'], attribution: [] },
      'a:notobject:0': 'nope',
      'a:badattr:0': {
        display: 'Bad',
        tooltip: ['Bad'],
        attribution: [
          { source: 'part', frame: 0, grid: [0, 1, 0], localId: 'generic:0' },
          { source: 'guess', frame: 0, grid: [0, 1, 0] },            // 来源不在枚举内
          { source: 'host', frame: 0, grid: [0, 1] },                // 格下标非三元
          { source: 'host', frame: 0, grid: [0, 1, 'x'] },           // 格下标非数字
          { source: 'host', frame: 'nope', grid: [1, 1, 1] },        // 帧非数字（宽容为 0）
          null,
        ],
      },
      'a:attrNotArray:0': { display: 'X', tooltip: ['X'], attribution: 'nope' },
    })
    expect(Object.keys(index).sort()).toEqual(['a:attrNotArray:0', 'a:badattr:0', 'a:ok:0'])
    const bad = index['a:badattr:0']!
    expect(bad.attribution).toHaveLength(2)
    expect(bad.attribution.map(h => h.source)).toEqual(['part', 'host'])
    expect(bad.attribution[1]!.frame).toBe(0)
    expect(bad.attribution[1]!.grid).toEqual([1, 1, 1])
    // attribution 不是数组 ⇒ 空数组（显式无对应，而不是"未知"）
    expect(index['a:attrNotArray:0']!.source).toBe('none')
  })

  it('file 里的 source 是派生标记：以 attribution 为权威重算', () => {
    const index = parseItemIndex({
      // 文件写 none 但有归属 ⇒ 以归属为准（part）
      'a:x:0': { display: 'X', tooltip: ['X'], source: 'none', attribution: [{ source: 'part', frame: 0, grid: [0, 0, 0], localId: 'p' }] },
      // 文件写 part 但无归属 ⇒ 以空归属为准（none）
      'a:y:0': { display: 'Y', tooltip: ['Y'], source: 'part', attribution: [] },
    })
    expect(index['a:x:0']!.source).toBe('part')
    expect(index['a:y:0']!.source).toBe('none')
  })
})

describe('buildItemHitIndex：物品键 → 命中单元（部件 / 格）', () => {
  it('命中单元按权威度排序（part 先于 host），同来源保文件序', () => {
    const hits = buildItemHitIndex({ itemIndex: FIXTURE_INDEX })
    const slab = hits.get('minecraft:stone_slab:0')!
    expect(slab.unresolved).toBe(false)
    expect(slab.hits.map(h => `${h.source}@${h.grid.join(',')}`)).toEqual([
      'part@0,1,0',
      'part@0,1,2',
      'host@0,1,0',
    ])
    expect(slab.display).toBe('Stone Slab')
    expect(slab.tooltip).toEqual(['Stone Slab'])
  })

  it('乱序输入被稳定排序；完全相同的归属去重（跨帧不重复）', () => {
    const shuffled: ItemIndex = {
      'a:z:0': {
        display: 'Z',
        tooltip: ['Z'],
        source: 'host',
        attribution: [
          { source: 'host', frame: 0, grid: [0, 0, 0] },
          { source: 'part', frame: 0, grid: [0, 0, 0], localId: 'p' },
          { source: 'part', frame: 0, grid: [0, 0, 0], localId: 'p' },
          { source: 'family', frame: 0, grid: [0, 0, 0] },
          { source: 'host', frame: 0, grid: [0, 0, 0] },
        ],
      },
    }
    const hits = buildItemHitIndexFromIndex(shuffled)
    expect(hits.get('a:z:0')!.hits.map(h => h.source)).toEqual(['part', 'host', 'family'])
    expect(hits.get('a:z:0')!.hits).toHaveLength(3)
  })

  it('多帧：归属按帧定位，不同帧的同格命中各自保留', () => {
    const multi = {
      'a:m:0': {
        display: 'M',
        tooltip: ['M'],
        source: 'part',
        attribution: [
          { source: 'part', frame: 0, grid: [0, 0, 0], localId: 'generic:0' },
          { source: 'part', frame: 3, grid: [0, 0, 0], localId: 'generic:0' },
        ],
      },
    }
    const hits = buildItemHitIndexFromIndex(parseItemIndex(multi))
    expect(hits.get('a:m:0')!.hits.map(h => h.frame)).toEqual([0, 3])
  })

  it('旧文件（无 itemIndex）⇒ 空表，零差异；缺省字段不凭空生成键', () => {
    expect(buildItemHitIndex(null).size).toBe(0)
    expect(buildItemHitIndex({}).size).toBe(0)
    expect(buildItemHitIndex({ itemIndex: undefined }).size).toBe(0)
  })

  it('extraKeys：左栏行键缺失时补显式无对应条目（与"无条目"可区分）', () => {
    const hits = buildItemHitIndex(
      { itemIndex: { 'a:known:0': { display: 'K', tooltip: ['K'], attribution: [{ source: 'part', frame: 0, grid: [0, 0, 0], localId: 'p' }] } } },
      ['a:known:0', 'a:unknown:0'],
    )
    expect([...hits.keys()].sort()).toEqual(['a:known:0', 'a:unknown:0'])
    const unknown = hits.get('a:unknown:0')!
    expect(unknown.unresolved).toBe(true)
    expect(unknown.source).toBe('none')
    expect(unknown.tooltip).toEqual(['a:unknown:0'])
    expect(resolveItemHit(hits, 'a:missing:0')).toBeNull()
    expect(resolveItemHit(hits, 'a:unknown:0')).toBe(unknown)
  })

  it('解析与建表两条入口结果一致（同源）', () => {
    const a = buildItemHitIndex({ itemIndex: FIXTURE_INDEX })
    const b = buildItemHitIndexFromIndex(parseItemIndex(FIXTURE_INDEX))
    expect([...a.entries()]).toEqual([...b.entries()])
  })
})

describe('hostItem 键工具与字段名常量', () => {
  it('宿主级物品身份键 = registry:damage（无 #nbt 段）', () => {
    expect(hostItemKey({ registry: 'minecraft:torch', damage: 0 })).toBe('minecraft:torch:0')
    expect(hostItemKey({ registry: 'appliedenergistics2:tile.BlockCableBus', damage: 0 }))
      .toBe('appliedenergistics2:tile.BlockCableBus:0')
    expect(hostItemKey(null)).toBeNull()
    expect(hostItemKey(undefined)).toBeNull()
    expect(hostItemKey({ registry: '', damage: 0 })).toBeNull()
  })

  it('字段名与契约 §9 一致（文档根 itemIndex / blockPalette 条目 hostItem）', () => {
    expect(ITEM_INDEX_FIELD).toBe('itemIndex')
    expect(HOST_ITEM_FIELD).toBe('hostItem')
  })
})
