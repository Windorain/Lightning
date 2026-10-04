/**
 * B-2（#35）物品索引表 —— **文档根级字段挂载**与**无部件字节一致**回归。
 *
 * 契约：Gitea Wiki《部件数据契约》§2（文件表达）、§2.2（itemIndex）、§9（统计层）；
 * Issue #35「完成定义」：`itemIndex` 是**文档根级**字段（与 structure 级
 * `cellPartsGrid`/`partLists` 不同层级），真实导出（StructureData / World）必须让它活到
 * **渲染定义根**（B-4 悬停说明 / B-5 点选归属读的同一对象）。
 *
 * 两件事被钉死：
 *  1. **挂载**：`itemIndex`（含 `blockPalette[].hostItem`）经「解析 → serialize() →
 *     `loadStructureData`」逐值存活；V2Plain 链经 `_extra` 兜底 round-trip；
 *  2. **字节一致（硬约束）**：无部件文件的解析→序列化输出与源文件**逐字节相同**，
 *     且根不出现 `itemIndex`/`hostItem`（不产出占位）。
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import { loadStructureData } from '@/render/data/bundleResolve'
import { buildItemHitIndex, HOST_ITEM_FIELD, ITEM_INDEX_FIELD } from '@/pure/itemIndex'

import singleboxFixture from '../../../e2e/fixtures/parts-singlebox-mix.v2.json'
import ae2Fixture from '../../../e2e/fixtures/parts-ae2-multibox.v2.json'
import minimalV2 from '../../../e2e/fixtures/minimal-v2.json'
import structureDataEnvelope from '../../../e2e/fixtures/structuredata-exported-envelope.json'
import noPartsBaseline from '../../../e2e/fixtures/b2-item-index-baseline-no-parts.json'

type Json = Record<string, unknown>

/**
 * 无部件字节一致基线（B-2 改动前的解析→序列化管线指纹；见 fixture 内 howToRegenerate）。
 * 断言方式：对 `JSON.stringify(document.serialize())` 取 sha256 + UTF-8 字节数——任何"动了无部件
 * 文档字节"的改动都会红，且无需把 2.5 MB 输出入库。
 */
const BASELINE = noPartsBaseline.entries as Record<string, { sha256: string; bytes: number }>

function fingerprint(text: string): { sha256: string; bytes: number } {
  const buf = Buffer.from(text, 'utf8')
  return { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length }
}

function expectByteIdenticalToBaseline(key: string, text: string): void {
  const expected = BASELINE[key]
  expect(expected, `基线缺 ${key} 条目`).toBeTruthy()
  expect(fingerprint(text)).toEqual(expected)
}

/** 与 `workbenchHost.ts` / `embedHost.ts` 的注册顺序一致。 */
function productionRegistry() {
  const registry = createParserRegistry()
  registry.register(V2PlainParser)
  registry.register(createEnvelopeParser(registry))
  registry.register(WorldParser)
  registry.register(StructureDataParser)
  return registry
}

/** 真实 fixture 的 baked structure（含部件字段；用于派生"裸 StructureData 文档"）。 */
const FIXTURE_STRUCTURE = ((singleboxFixture as unknown as Json).frames as Json[])[0]!
  .structure as Json

/**
 * mod 侧 `ItemIndexIntegrator` 落盘形态（逐字段对齐）：层① 部件命中 + 层② 宿主命中 +
 * 显式 `none`（附加物品条目本轮不做独立说明与对应）。
 */
const ITEM_INDEX = {
  'minecraft:stone_slab:0': {
    display: 'Stone Slab',
    tooltip: ['Stone Slab'],
    source: 'part',
    attribution: [
      { source: 'part', frame: 0, grid: [0, 1, 0], localId: 'generic:0' },
      { source: 'host', frame: 0, grid: [0, 1, 0] },
    ],
  },
  'appliedenergistics2:item.ItemMultiPart:1': {
    display: 'appliedenergistics2:item.ItemMultiPart:1',
    tooltip: ['appliedenergistics2:item.ItemMultiPart:1'],
    source: 'none',
    attribution: [],
  },
}

/** 带 `hostItem` 的 blockPalette（层② 落盘：`Item.getItemFromBlock` + damage） */
function paletteWithHostItem(structure: Json): Json[] {
  const palette = structure.blockPalette as Json[]
  return palette.map((entry, i) => {
    if (i === 0) return entry // index 0 = air，无物品形态
    return {
      ...entry,
      [HOST_ITEM_FIELD]: { registry: `test.block${i}`, damage: (entry.meta as number) ?? 0 },
    }
  })
}

function bareBaked(extra: Json): Json {
  return {
    geometryPhase: 'baked',
    id: 'item-index',
    label: 'item-index',
    cellGrid: FIXTURE_STRUCTURE.cellGrid,
    blockPalette: paletteWithHostItem(FIXTURE_STRUCTURE),
    cellPartsGrid: FIXTURE_STRUCTURE.cellPartsGrid,
    partLists: FIXTURE_STRUCTURE.partLists,
    ...extra,
  }
}

/** JSON 全路径集合（对象键 + 数组下标）——递归断言"未凭空产出字段"，不受内联字符串干扰 */
function collectPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return []
  const out: string[] = []
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const p = `${prefix}[${i}]`
      out.push(p, ...collectPaths(value[i], p))
    }
    return out
  }
  for (const [k, v] of Object.entries(value as Json)) {
    const p = prefix ? `${prefix}.${k}` : k
    out.push(p, ...collectPaths(v, p))
  }
  return out
}

/** B-2 新增字段（文档根 `itemIndex` / 调色板条目 `hostItem`）的精确路径命中 */
function blockedNewFieldPaths(value: unknown): string[] {
  return collectPaths(value).filter(p => /(^|[.[])(itemIndex|hostItem)([.[]|$)/.test(p))
}

describe('B-2 itemIndex：StructureData 解析链挂载（渲染定义根）', () => {
  it('itemIndex + blockPalette[].hostItem 存活到渲染定义根（侧栏/视口读的同一对象）', async () => {
    const raw = bareBaked({ [ITEM_INDEX_FIELD]: ITEM_INDEX })
    const result = await productionRegistry().detectAndParse(raw)
    expect(result.parser?.formatName).toBe('StructureData')
    const doc = result.document!
    expect(doc).not.toBeNull()
    // 部件数据本身不受影响（回归：透传不等于改写）
    expect(doc.partsAt(0, { x: 0, y: 0, z: 0 })).toHaveLength(1)

    const plain = doc.serialize()
    expect(plain[ITEM_INDEX_FIELD]).toEqual(ITEM_INDEX)

    // 渲染定义入口（DRW：`resolveRenderBundle` → `loadStructureData`）——逐值原样
    const def = loadStructureData(plain) as unknown as Json
    expect(def[ITEM_INDEX_FIELD]).toEqual(ITEM_INDEX)
    // blockPalette 条目的宿主级物品身份（层②）随调色板 round-trip（编辑路径透传未知字段）
    const palette = def.blockPalette as Json[]
    expect(palette[1]![HOST_ITEM_FIELD]).toEqual({ registry: 'test.block1', damage: palette[1]!.meta })

    // 消费入口：一次性建立的反查索引（B-4/B-5 共用）
    const hits = buildItemHitIndex(def)
    expect(hits.size).toBe(2)
    expect(hits.get('minecraft:stone_slab:0')!.hits.map(h => h.source)).toEqual(['part', 'host'])
    expect(hits.get('appliedenergistics2:item.ItemMultiPart:1')!.unresolved).toBe(true)
  })

  it('二次序列化幂等：itemIndex 原样保留（不随编辑派生字段被丢弃）', async () => {
    const raw = bareBaked({ [ITEM_INDEX_FIELD]: ITEM_INDEX })
    const doc = (await productionRegistry().detectAndParse(raw)).document!
    const again = (await productionRegistry().detectAndParse(doc.serialize())).document!
    expect(again.serialize()[ITEM_INDEX_FIELD]).toEqual(ITEM_INDEX)
  })

  it('World 文档：根级 itemIndex 透传（跨帧共享一份，帧内 structure 不带）', async () => {
    const rawSt = ((ae2Fixture as unknown as Json).frames as Json[])[0]!.structure as Json
    const world: Json = {
      id: 'w',
      frames: [
        { index: 0, structure: rawSt },
        { index: 1, structure: rawSt },
      ],
      [ITEM_INDEX_FIELD]: ITEM_INDEX,
    }
    const result = await productionRegistry().detectAndParse(world)
    expect(result.parser?.formatName).toBe('World')
    const out = result.document!.serialize()
    expect(out[ITEM_INDEX_FIELD]).toEqual(ITEM_INDEX)
    const def = loadStructureData(out) as unknown as Json
    expect(def[ITEM_INDEX_FIELD]).toEqual(ITEM_INDEX)
    // 帧内 structure 不重复该字段（根级共享）
    const frames = out.frames as Json[]
    expect((frames[0]!.structure as Json)[ITEM_INDEX_FIELD]).toBeUndefined()
  })

  it('V2Plain 链：itemIndex 经 _extra 兜底 round-trip（非假设）', async () => {
    const raw: Json = { ...(singleboxFixture as unknown as Json), [ITEM_INDEX_FIELD]: ITEM_INDEX }
    const result = await productionRegistry().detectAndParse(raw)
    expect(result.parser?.formatName).toBe('V2Plain')
    const out = result.document!.serialize()
    expect(out[ITEM_INDEX_FIELD]).toEqual(ITEM_INDEX)
    expect((loadStructureData(out) as unknown as Json)[ITEM_INDEX_FIELD]).toEqual(ITEM_INDEX)
  })
})

describe('B-2 字节干净（硬约束：无部件导出产物与基线字节一致）', () => {
  it('minimal-v2.json（V2Plain，无部件）：序列化输出与基线指纹逐字节一致', async () => {
    const result = await productionRegistry().detectAndParse(minimalV2)
    const out = result.document!.serialize()
    const text = JSON.stringify(out)
    expectByteIdenticalToBaseline('minimal-v2', text)
    expect(text).not.toContain(ITEM_INDEX_FIELD)
    expect(text).not.toContain(HOST_ITEM_FIELD)
    expect(blockedNewFieldPaths(out)).toEqual([])
    // 帧内 structure 不产出部件字段（无部件 ⇒ 无 cellPartsGrid/partLists/itemIndex）
    const frames = out.frames as Json[]
    for (const key of ['cellPartsGrid', 'partLists', ITEM_INDEX_FIELD]) {
      expect(key in (frames[0]!.structure as Json)).toBe(false)
    }
  })

  it('structuredata-exported-envelope.json（Envelope，无部件）：序列化输出与基线指纹逐字节一致', async () => {
    const result = await productionRegistry().detectAndParse(structureDataEnvelope)
    expect(result.error, result.error).toBeUndefined()
    const out = result.document!.serialize()
    const text = JSON.stringify(out)
    expectByteIdenticalToBaseline('structuredata-exported-envelope', text)
    expect(text).not.toContain(ITEM_INDEX_FIELD)
    expect(text).not.toContain(HOST_ITEM_FIELD)
    expect(text).not.toContain('cellPartsGrid')
    expect(blockedNewFieldPaths(out)).toEqual([])
  })

  it('无部件结构不得凭空产出 hostItem（层② 仅当文档含部件数据时落盘）', async () => {
    const raw: Json = {
      geometryPhase: 'baked',
      id: 'no-parts',
      cellGrid: FIXTURE_STRUCTURE.cellGrid,
      blockPalette: FIXTURE_STRUCTURE.blockPalette, // 源调色板无 hostItem
    }
    const out = (await productionRegistry().detectAndParse(raw)).document!.serialize()
    const text = JSON.stringify(out)
    expect(text).not.toContain(ITEM_INDEX_FIELD)
    expect(text).not.toContain(HOST_ITEM_FIELD)
    expect(text).not.toContain('cellPartsGrid')
  })
})
