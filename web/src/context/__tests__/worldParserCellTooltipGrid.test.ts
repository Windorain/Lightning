/**
 * #82（web 半）修复锁：WorldParser 根级搬运 `cellTooltipGrid`。
 *
 * 缺陷：World/帧为主文档（frames + 根级成对 idioms）经 `WorldParser` 进 web 时只搬
 * `tooltipPalette`、丢 `cellTooltipGrid` ⇒ 逐格说明整层消失，再保存/导出时也不会回来
 * （serialize 只在字段为真时写出）。对照：`StructureDataParser` 经 `STRUCTURE_ROOT_FIELDS`
 * 两个字段都搬；mod 侧 `SceneEnvelopeBuilder` 非 frames 分支两个都搬（frames 分支属 PR-2）。
 *
 * 钉死：①World 根级两字段都存活到 RuntimeDocument 并随 serialize round-trip；
 * ②无该字段的 World 旧文档序列化不凭空产出（copyIfPresent 字节干净）。
 */
import { describe, it, expect } from 'vitest'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'

type Json = Record<string, unknown>

function productionRegistry() {
  const registry = createParserRegistry()
  registry.register(V2PlainParser)
  registry.register(createEnvelopeParser(registry))
  registry.register(WorldParser)
  registry.register(StructureDataParser)
  return registry
}

const BAKED_STRUCTURE: Json = {
  geometryPhase: 'baked',
  cellGrid: [[[0]]],
  blockPalette: [{
    registryId: 'minecraft:stone',
    meta: 0,
    renderMode: 'BakedQuads',
    geometry: { encoding: 'bakedQuadsJsonV1', quads: [] },
    occludesAdjacentFaces: true,
  }],
}

function worldDoc(extra: Json): Json {
  return {
    id: 'world-tooltip',
    label: 'world-tooltip',
    frames: [{ index: 0, structure: BAKED_STRUCTURE }],
    ...extra,
  }
}

describe('#82 WorldParser：根级 cellTooltipGrid 搬运', () => {
  it('World 根级 tooltipPalette + cellTooltipGrid 都存活到 RuntimeDocument 并 round-trip', async () => {
    const raw = worldDoc({
      tooltipPalette: ['流体存储总线'],
      cellTooltipGrid: [[[0]]],
    })
    const result = await productionRegistry().detectAndParse(raw)
    expect(result.parser?.formatName).toBe('World')
    const doc = result.document!
    expect(doc.tooltipPalette).toEqual(['流体存储总线'])
    expect(doc.cellTooltipGrid).toEqual([[[0]]])

    // 保存/导出路径 = serialize()：两个字段都要回来（修复前 cellTooltipGrid 一去不回）
    const out = doc.serialize()
    expect(out.tooltipPalette).toEqual(['流体存储总线'])
    expect(out.cellTooltipGrid).toEqual([[[0]]])

    // 再解析（刷新/重新载入）仍然读得到
    const again = (await productionRegistry().detectAndParse(out)).document!
    expect(again.tooltipPalette).toEqual(['流体存储总线'])
    expect(again.cellTooltipGrid).toEqual([[[0]]])
  })

  it('负对照：无 cellTooltipGrid 的 World 旧文档，序列化不凭空产出该字段', async () => {
    const raw = worldDoc({ tooltipPalette: ['x'] })
    const doc = (await productionRegistry().detectAndParse(raw)).document!
    expect(doc.cellTooltipGrid).toBeUndefined()
    const out = doc.serialize()
    expect('cellTooltipGrid' in out).toBe(false)
  })
})
