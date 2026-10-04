/**
 * F1（P3.1 验收擒获）—— **文档根级字段**在 StructureData 解析链上的存活。
 *
 * 背景（契约 §2 文件表达 / §9 已废弃）：
 *  - `statsTemplate`（旧文档默认统计层）、`statsOverride`（旧文档覆盖层）、
 *    `partIconTextures`（部件物品图标纹理，P1.7 落盘）都是**文档根级**字段，
 *    与 structure 级的 `cellPartsGrid`/`partLists` **不同层级**；
 *  - 真实导出是 `geometryPhase=baked` 的 StructureData（无 `format_version`/`frames`），
 *    走 `StructureDataParser`；该解析器此前不透传上述三键 ⇒ 渲染定义根缺文档默认统计层
 *    （侧栏来源徽标落"内建默认"）且部件行图标无嵌入纹理源（P3.1 findings F1/F2）；
 *  - **B-3（决策 C）后**：`statsTemplate`/`statsOverride` 的**语义已作废**（统计栏不再有
 *    三级配置、无来源徽标）——本文件对它们只保留"**透传不丢、不凭空生成**"这一条：
 *    这正是契约 §9 的兼容口径「旧文档携带 statsTemplate/statsOverride ⇒ 读取后静默忽略」
 *    （读得到、留得住、不影响展示）。语义消费端由 `BlockStatsSidebar` 的
 *    `blockStatsSidebar.parts.dom.test.ts` / `blockStatsSidebar.legacyHostRows.dom.test.ts`
 *    以 DOM 断言钉死（残留配置不空栏不报错）。
 *
 * 本测试钉死两件事：
 *  1. **透传**：三键经「解析 → serialize() → `loadStructureData`（渲染定义入口）」
 *     完整存活到**渲染定义根**（= `EmbedViewport` 读取 `definition.partIconTextures` 的同一对象）；
 *  2. **旧文件零差异**：无这三键的旧 baked 文档，序列化根不出现这三键（不产出占位）。
 *
 * 顺带**核验（非假设）** V2Plain 链路：三键随 `RuntimeDocument._extra` 兜底 round-trip。
 */
import { describe, it, expect } from 'vitest'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import { loadStructureData } from '@/render/data/bundleResolve'

import singleboxFixture from '../../../e2e/fixtures/parts-singlebox-mix.v2.json'

type Json = Record<string, unknown>

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

/** P1.7 落盘形态：旧文档默认统计层（契约 §9 已废弃；本文件只钉"透传不丢"）。 */
const STATS_TEMPLATE = { mode: 'auto', groups: [], showOthers: true }
/** 旧文档覆盖层（契约 §9 已废弃；同上）。 */
const STATS_OVERRIDE = { view: 'parts' }
/** 部件物品图标键 → base64 PNG（键 = 物品身份键 `registry:damage[#nbt]`）。 */
const PART_ICON_TEXTURES = {
  'minecraft:stone_slab:0': 'iVBORw0KGgoAAAANSUhEUg==',
  'appliedenergistics2:item.ItemMultiPart:16': 'iVBORw0KGgoAAAANSUhEUg==',
}

/** 裸 StructureData（`geometryPhase=baked`，无 format_version/frames）= 真实导出形态。 */
function bareBaked(extra: Json): Json {
  return {
    geometryPhase: 'baked',
    id: 'root-fields',
    label: 'root-fields',
    cellGrid: FIXTURE_STRUCTURE.cellGrid,
    blockPalette: FIXTURE_STRUCTURE.blockPalette,
    cellPartsGrid: FIXTURE_STRUCTURE.cellPartsGrid,
    partLists: FIXTURE_STRUCTURE.partLists,
    ...extra,
  }
}

describe('F1 文档根级字段：StructureData 解析链透传', () => {
  it('statsTemplate/statsOverride/partIconTextures 存活到渲染定义根（侧栏/视口读的同一对象）', async () => {
    const raw = bareBaked({
      statsTemplate: STATS_TEMPLATE,
      statsOverride: STATS_OVERRIDE,
      partIconTextures: PART_ICON_TEXTURES,
    })
    const result = await productionRegistry().detectAndParse(raw)
    expect(result.parser?.formatName).toBe('StructureData')
    const doc = result.document!
    expect(doc).not.toBeNull()
    // 部件数据本身不受影响（回归：透传不等于改写）
    expect(doc.partsAt(0, { x: 0, y: 0, z: 0 })).toHaveLength(1)

    const plain = doc.serialize()
    expect(plain.statsTemplate).toEqual(STATS_TEMPLATE)
    expect(plain.statsOverride).toEqual(STATS_OVERRIDE)
    expect(plain.partIconTextures).toEqual(PART_ICON_TEXTURES)

    // 渲染定义入口（DRW：`resolveRenderBundle` → `loadStructureData`）——逐值原样
    const def = loadStructureData(plain) as unknown as Json
    expect(def.statsTemplate).toEqual(STATS_TEMPLATE)
    expect(def.statsOverride).toEqual(STATS_OVERRIDE)
    expect(def.partIconTextures).toEqual(PART_ICON_TEXTURES)
  })

  it('二次序列化幂等：三键原样保留（不随编辑派生字段被丢弃）', async () => {
    const raw = bareBaked({
      statsTemplate: STATS_TEMPLATE,
      partIconTextures: PART_ICON_TEXTURES,
    })
    const doc = (await productionRegistry().detectAndParse(raw)).document!
    const again = (await productionRegistry().detectAndParse(doc.serialize())).document!
    const out = again.serialize()
    expect(out.statsTemplate).toEqual(STATS_TEMPLATE)
    expect(out.partIconTextures).toEqual(PART_ICON_TEXTURES)
  })

  it('旧文件零差异：无这三键的 baked 文档，序列化根不产出它们', async () => {
    const raw = bareBaked({})
    const doc = (await productionRegistry().detectAndParse(raw)).document!
    const out = doc.serialize()
    for (const key of ['statsTemplate', 'statsOverride', 'partIconTextures']) {
      expect(key in out, `旧文件不得凭空产出 ${key}`).toBe(false)
    }
    expect(JSON.stringify(out)).not.toContain('partIconTextures')
    // 渲染定义根同样无这三键（旧路径 = 内建默认 + 纯回退链）
    const def = loadStructureData(out) as unknown as Json
    for (const key of ['statsTemplate', 'statsOverride', 'partIconTextures']) {
      expect(key in def).toBe(false)
    }
  })

  it('缺省单个键 ⇒ 只有该键不出现（逐键独立，不连坐）', async () => {
    const raw = bareBaked({ statsTemplate: STATS_TEMPLATE })
    const out = (await productionRegistry().detectAndParse(raw)).document!.serialize()
    expect(out.statsTemplate).toEqual(STATS_TEMPLATE)
    expect('statsOverride' in out).toBe(false)
    expect('partIconTextures' in out).toBe(false)
  })
})

describe('V2Plain 链路核验：三键经 _extra 兜底 round-trip（非假设）', () => {
  it('V2Plain 文档根三键 → 序列化根 → 渲染定义根逐值一致', async () => {
    const raw: Json = {
      ...(singleboxFixture as unknown as Json),
      statsTemplate: STATS_TEMPLATE,
      statsOverride: STATS_OVERRIDE,
      partIconTextures: PART_ICON_TEXTURES,
    }
    const result = await productionRegistry().detectAndParse(raw)
    expect(result.parser?.formatName).toBe('V2Plain')
    const out = result.document!.serialize()
    expect(out.statsTemplate).toEqual(STATS_TEMPLATE)
    expect(out.statsOverride).toEqual(STATS_OVERRIDE)
    expect(out.partIconTextures).toEqual(PART_ICON_TEXTURES)
    const def = loadStructureData(out) as unknown as Json
    expect(def.statsTemplate).toEqual(STATS_TEMPLATE)
    expect(def.partIconTextures).toEqual(PART_ICON_TEXTURES)
  })

  it('V2Plain 旧文件：三键仍不产出（兜底透传不是凭空生成）', async () => {
    // fixture 自带根级 statsTemplate ⇒ 显式剥掉，模拟"无这三键的旧文件"
    const legacy: Json = { ...(singleboxFixture as unknown as Json) }
    delete legacy.statsTemplate
    const out = (await productionRegistry().detectAndParse(legacy)).document!.serialize()
    for (const key of ['statsTemplate', 'statsOverride', 'partIconTextures']) {
      expect(key in out).toBe(false)
    }
  })
})
