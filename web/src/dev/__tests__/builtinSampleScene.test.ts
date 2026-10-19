/**
 * M5-5 · 内置多方块样例是**产品资产**，不是被搬进仓库的测试夹具。
 *
 * ## 这条判据防什么
 *
 * 用户要能在「设置 → 内置示例」里一步打开一份多方块文档（G8：手测入口不可达）。
 * 样例的来源是测试夹具 `multiblock-ebf-2ch.json`（T0.5 合成样品，被三套判据钉得最死），
 * 但**产品资产不能带测试专用字段**：`fixtureSynthetic` / `fixtureFile` / `payloadNote`
 * 这类键会告诉读者"这是夹具"，也可能让生产解析走进不该走的分支。
 *
 * ⇒ 判据三条：
 *  1. **信封形态是生产形态**（`gzip+base64`，与真实 /sde 产物同一读取路径）；
 *  2. **没有夹具专用字段**（`meta` 逐键核对）；
 *  3. **走生产解析器**读得回，且声明与面板契约一致（3 条通道 / Tier 1..14 / 双运行态）。
 *
 * 样例本体由 `scripts/multiblock-fixtures/make-builtin-sample.mjs` 再生成（勿手改）。
 */
import { describe, expect, it } from 'vitest'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import { displayNameOfScene, listDevSceneIds } from '@/dev/devScenes'
import {
  channelSliderSpecs,
  initialMultiblockSelection,
  tierSampleValues,
} from '@/shared/viewport/multiblockChannelUi'
import { textureAnimationOf } from '@/domain/textureAnimation'

import sample from '../../../data/scenes/builtin-multiblock-ebf.json'
import animatedSample from '../../../data/scenes/builtin-animated-texture.json'

/** 与宿主同一份注册顺序（生产解析入口）。 */
function productionRegistry() {
  const registry = createParserRegistry()
  registry.register(V2PlainParser)
  registry.register(createEnvelopeParser(registry))
  registry.register(WorldParser)
  registry.register(StructureDataParser)
  return registry
}

describe('内置样例：产品资产形态（不是夹具）', () => {
  const envelope = sample as unknown as Record<string, unknown>
  const meta = envelope.meta as Record<string, unknown>

  it('信封是生产形态 `gzip+base64`，且不携带夹具专用字段', () => {
    expect(envelope.documentFormat).toBe('Envelope')
    expect(envelope.payloadEncoding, '生产载荷形态（真实 /sde 产物同一条读取路径）').toBe('gzip+base64')
    // 夹具专用键：一个都不许出现在产品资产里。
    for (const key of ['payloadNote', 'fixtureSynthetic', 'fixtureFile', 'modSource']) {
      expect(key in envelope, `信封根不得含夹具字段 ${key}`).toBe(false)
      expect(key in meta, `meta 不得含夹具字段 ${key}`).toBe(false)
    }
    expect(meta.documentShape, '多方块形态判据（先于 V2Plain 判别）').toBe('multiblock')
    expect(meta.label, '产品语汇的文档名').toBe('示例·电力高炉（多方块）')
  })

  it('场景目录可枚举，且列表呈现名是产品语汇（不是文件名 id）', () => {
    expect(listDevSceneIds()).toContain('builtin-multiblock-ebf')
    expect(displayNameOfScene('builtin-multiblock-ebf')).toBe('示例·电力高炉（多方块）')
    // 未登记的 id 回落 id 本身（不猜、不吞）
    expect(displayNameOfScene('export')).toBe('export')
  })

  it('生产解析器读得回，声明与面板契约一致（3 条通道 / Tier 1..14 / 双运行态）', async () => {
    const parsed = await productionRegistry().detectAndParse(envelope)
    expect(parsed.error).toBeUndefined()
    const doc = parsed.document!
    expect(doc.isMultiblock, '样例必须被判为多方块文档').toBe(true)
    expect(doc.frameCount, '场景（变体配置）条数 = 夹具的 432').toBe(432)

    const decl = doc.multiblock!.decl
    expect(decl.displayName).toBe('Electric Blast Furnace')
    const specs = channelSliderSpecs(decl)
    expect(specs.map((s) => s.key)).toEqual(['height', 'coil', 'glass'])
    expect(specs.map((s) => s.name)).toEqual(['Height', 'Coil', 'Glass'])
    expect(specs.map((s) => s.hi)).toEqual([5, 3, 2])
    expect([decl.totalTierDomain.min, decl.totalTierDomain.max]).toEqual([1, 14])
    expect(tierSampleValues(decl)).toEqual([1, 2, 14])
    expect(decl.runstates.map((r) => r.id)).toEqual(['idle', 'active'])

    const initial = initialMultiblockSelection(decl)
    expect(initial).toEqual({ totalTier: 2, values: { height: 0, coil: 0, glass: 0 }, runstate: 'idle' })
  })
})
describe('内置样例：动态贴图（示例·动态贴图）', () => {
  const envelope = animatedSample as unknown as Record<string, unknown>
  const meta = envelope.meta as Record<string, unknown>

  it('信封是生产形态，且不含夹具字段', () => {
    expect(envelope.documentFormat).toBe('Envelope')
    expect(envelope.payloadEncoding).toBe('gzip+base64')
    for (const key of ['payloadNote', 'fixtureSynthetic', 'fixtureFile', 'modSource']) {
      expect(key in envelope, `信封根不得含夹具字段 ${key}`).toBe(false)
      expect(key in meta, `meta 不得含夹具字段 ${key}`).toBe(false)
    }
    expect(meta.name).toBe('示例·动态贴图')
    expect(displayNameOfScene('builtin-animated-texture')).toBe('示例·动态贴图')
  })

  it('多帧 + 动画材质：播放按钮可见（world 帧 3）、材质声明 4 帧竖条', async () => {
    const parsed = await productionRegistry().detectAndParse(envelope)
    expect(parsed.error).toBeUndefined()
    const doc = parsed.document!
    expect(doc.isMultiblock, '动态贴图样例是帧为主文档').toBe(false)

    // 世界帧轴：3 帧 × 200ms —— 单帧文档没有帧控制 tab（用户无法"播放着看"）。
    expect(doc.frameCount).toBe(3)
    for (const f of doc.frames) expect(f.durationMs, '帧时长是文档声明（不是缺省 1ms）').toBe(200)

    // 材质：animated + 4 帧声明；竖条 16×64 = 4 格。
    const material = (doc.materialPalette as Array<Record<string, unknown>>)[0]!
    expect(material.kind).toBe('animated')
    expect(material.animation).toEqual({
      defaultFrametimeTicks: 2,
      frameSequence: [
        { index: 0 },
        { index: 1, timeTicks: 3 },
        { index: 2, timeTicks: 1 },
        { index: 3, timeTicks: 2 },
      ],
    })

    const base64 = (doc.textureBlobs as Record<string, string>)['0']!
    const png = Buffer.from(base64, 'base64')
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    expect([width, height], '竖条：宽 = 格边长、高 = 4 格').toEqual([16, 64])
    expect(height % width).toBe(0)

    // 生产派生：声明 → 可采样序列（同一函数，M5-3 的唯一派生点）。
    const binding = textureAnimationOf({
      id: 'material:0',
      resource: { assetId: 'material:0', contentVersion: 'sha:test', url: 'inline:0' },
      kind: 'animated',
      animation: material.animation as never,
      width,
      height,
    })
    expect(binding, '必须派生出发可采样序列（否则样例不会动）').not.toBeNull()
    expect(binding!.stripFrameCount).toBe(4)
    expect(binding!.sequence.frames.map((f) => f.index)).toEqual([0, 1, 2, 3])
    // 2/3/1/2 tick = 0.10/0.15/0.05/0.10 s ⇒ 一个循环 0.40 s（GIF 计划与视口采样同源）。
    const seconds = binding!.sequence.frames.map((f) => f.duration.num / f.duration.den)
    expect(seconds.map((s) => Number(s.toFixed(3)))).toEqual([0.1, 0.15, 0.05, 0.1])
  })
})
