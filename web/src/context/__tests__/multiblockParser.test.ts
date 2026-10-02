/**
 * T2.1 / T2.3 — 多方块为主文档：形态判别、解析、RuntimeDocument 承载、round-trip、既有 parser 回归。
 *
 * 契约：`docs/plan/format-multiblock-doc.md`
 * fixture：`./fixtures/multiblock-{ebf-2ch,tier-only,lsc-overlap}.json`（内容勿改）
 */
import { describe, it, expect } from 'vitest'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  MultiblockParser,
  SHAPE_FIRST_PARSERS,
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import {
  MULTIBLOCK_DOCUMENT_SHAPE,
  MultiblockParseError,
  isMultiblockDocument,
  isMultiblockShapeDocument,
  parseMultiblockDeclaration,
  readDocumentShape,
  multiblockVariantKey,
} from '@/context/parsers/multiblockDocument'
import { RuntimeDocument } from '@/context/runtimeDocument'
import { assembleSelection } from '@/context/multiblock'
import type { MultiblockInnerDocument } from '@/context/multiblock'
import {
  decodeEnvelopePayload,
  isEnvelopeDocument,
  readEnvelopeLayers,
} from '@/render/data/compactSceneDocument'

import ebfFixture from './fixtures/multiblock-ebf-2ch.json'
import tierOnlyFixture from './fixtures/multiblock-tier-only.json'
import lscOverlapFixture from './fixtures/multiblock-lsc-overlap.json'
import minimalV2 from '../../../e2e/fixtures/minimal-v2.json'
import structureDataEnvelope from '../../../e2e/fixtures/structuredata-exported-envelope.json'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 与 `workbenchHost.ts` / `embedHost.ts` 的注册顺序一致（Multiblock 由 createParserRegistry 预置在表头）。 */
function productionRegistry() {
  const registry = createParserRegistry()
  registry.register(V2PlainParser)
  registry.register(createEnvelopeParser(registry))
  registry.register(WorldParser)
  registry.register(StructureDataParser)
  return registry
}

type Json = Record<string, unknown>

/** base64 → UTF-8 文本（Node/browser 同源，不依赖 Buffer 类型） */
function base64ToText(b64: string): string {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder('utf-8').decode(bytes)
}

function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin)
}

/** 信封内层 body（契约 JSON 形态：multiblock + blockPalette + frames）。 */
function innerOf(env: { payload: string }): Json {
  return JSON.parse(base64ToText(env.payload)) as Json
}

/** 生产形态：base64(gzip(json))（与 fixture 的 base64(json) 共用同一读取路径）。 */
async function gzipBase64(text: string): Promise<string> {
  const cs = new CompressionStream('gzip')
  const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(cs)
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin)
}

const FIXTURES = [
  {
    name: 'ebf-2ch',
    raw: ebfFixture as unknown as Json,
    displayName: 'Electric Blast Furnace',
    channels: 3,
    runstates: 2,
    rules: 12,
    steps: 5,
    variants: 432,
    frames: 432,
    palette: 9,
    tierSample: [1, 2, 14],
    couplingMode: 'none',
    couplings: 0,
    hasScopeOverlap: false,
  },
  {
    name: 'tier-only',
    raw: tierOnlyFixture as unknown as Json,
    displayName: 'Tier Column',
    channels: 1,
    runstates: 1,
    rules: 9,
    steps: 3,
    variants: 12,
    frames: 12,
    palette: 6,
    tierSample: [1, 2, 3],
    couplingMode: 'none',
    couplings: 0,
    hasScopeOverlap: false,
  },
  {
    name: 'lsc-overlap',
    raw: lscOverlapFixture as unknown as Json,
    displayName: 'Lapotronic Super Capacitor',
    channels: 3,
    runstates: 1,
    rules: 9,
    steps: 5,
    variants: 108,
    frames: 108,
    palette: 6,
    tierSample: [3, 14],
    couplingMode: 'clamp',
    couplings: 1,
    hasScopeOverlap: true,
  },
] as const

// ---------------------------------------------------------------------------
// 1. 形态判别（互斥）
// ---------------------------------------------------------------------------

describe('T2.1 文档形态判别（documentShape，与「帧为主」互斥）', () => {
  it('三份 fixture 都被 Multiblock parser 接走，且都满足契约 §2.2 的完整判别式', async () => {
    const registry = productionRegistry()
    for (const fx of FIXTURES) {
      const result = await registry.detectAndParse(fx.raw)
      expect(result.error, `${fx.name}: ${result.error}`).toBeUndefined()
      expect(result.parser?.formatName, fx.name).toBe('Multiblock')
      const doc = result.document!
      expect(doc).not.toBeNull()
      expect(doc.isMultiblock).toBe(true)
      expect(doc.multiblock!.decl.displayName).toBe(fx.displayName)
      expect(doc.multiblock!.decl.raw).toEqual(innerOf(fx.raw as { payload: string }).multiblock)
      // §2.2 完整判别式（形态键 + multiblock 节 + count===1 + 无根级 cellGrid）
      expect(isMultiblockShapeDocument(fx.raw)).toBe(true)
      expect(readDocumentShape(fx.raw)).toBe(MULTIBLOCK_DOCUMENT_SHAPE)
      // 合并 meta 后（Plain 形态）完整判别式成立；内层 body 本体的三条结构性断言也成立
      const layers = await readEnvelopeLayers(fx.raw as unknown as { payload: string; meta: Json })
      expect(isMultiblockDocument(layers.plain), fx.name).toBe(true)
      expect(typeof layers.inner.multiblock, fx.name).toBe('object')
      expect(layers.inner.multiblockCount, fx.name).toBe(1)
      expect('cellGrid' in layers.inner, fx.name).toBe(false)
    }
  })

  it('判别互斥：帧为主文档不被多方块判别器接走，仍走既有 parser 并构造 Grid', async () => {
    const registry = productionRegistry()
    for (const raw of [minimalV2, { format_version: '2.0', id: 'x', meta: {}, frames: [] }]) {
      expect(MultiblockParser.detect(raw)).toBe(false)
    }
    const result = await registry.detectAndParse(minimalV2)
    expect(result.parser?.formatName).toBe('V2Plain')
    const doc = result.document!
    expect(doc.isMultiblock).toBe(false)
    expect(doc.multiblock).toBeNull()
    expect(doc.multiblockSource).toBeNull()
    expect(doc.frames[0]!.multiblock).toBeNull()
    expect(doc.frames[0]!.grid).not.toBeNull()
  })

  it('注册顺序：Multiblock 在表头（先于按 format_version/frames 泛匹配的 V2Plain）', async () => {
    expect(SHAPE_FIRST_PARSERS).toEqual([MultiblockParser])
    // 形态判别必须**行为上**优先：裸体多方块文档同时满足 V2Plain 的判别条件
    const bare = { ...innerOf(tierOnlyFixture), documentShape: MULTIBLOCK_DOCUMENT_SHAPE, format_version: '2.0' }
    expect(V2PlainParser.detect(bare)).toBe(true)
    expect(MultiblockParser.detect(bare)).toBe(true)
    const result = await productionRegistry().detectAndParse(bare)
    expect(result.parser?.formatName).toBe('Multiblock')
    expect(result.document!.isMultiblock).toBe(true)
  })

  it('裸体形态（无信封）与信封形态（meta 携带形态）都判为多方法文档', async () => {
    const bare = { ...innerOf(tierOnlyFixture), documentShape: MULTIBLOCK_DOCUMENT_SHAPE }
    const byBare = await productionRegistry().detectAndParse(bare)
    expect(byBare.parser?.formatName).toBe('Multiblock')
    expect(byBare.document!.multiblock!.decl.displayName).toBe('Tier Column')
    // 裸体形态：内层 body 即根对象
    expect(byBare.document!.multiblockSource).toEqual(bare)

    const envelope = tierOnlyFixture as unknown as Json
    expect(isEnvelopeDocument(envelope)).toBe(true)
    const byEnvelope = await productionRegistry().detectAndParse(envelope)
    expect(byEnvelope.parser?.formatName).toBe('Multiblock')
    expect(byEnvelope.document!.multiblockSource).toEqual(innerOf(envelope as { payload: string }))
  })

  it('生产载荷形态 base64(gzip(json)) 与 fixture 形态 base64(json) 同一读取路径', async () => {
    const inner = innerOf(tierOnlyFixture)
    const payload = await gzipBase64(JSON.stringify(inner))
    const envelope = {
      documentFormat: 'Envelope',
      payloadEncoding: 'gzip+base64',
      meta: { id: 'prod:multiblock', documentShape: MULTIBLOCK_DOCUMENT_SHAPE },
      payload,
    }
    expect(isEnvelopeDocument(envelope)).toBe(true)
    const layers = await readEnvelopeLayers(envelope)
    expect(layers.inner).toEqual(inner)
    expect(layers.plain.documentShape).toBe(MULTIBLOCK_DOCUMENT_SHAPE)

    const result = await productionRegistry().detectAndParse(envelope)
    expect(result.error, result.error).toBeUndefined()
    expect(result.parser?.formatName).toBe('Multiblock')
    expect(result.document!.multiblock!.decl.variants).toHaveLength(12)
    expect(result.document!.multiblockSource).toEqual(inner)
  })

  it('fixture 专用编码的常量与分派：base64(json) 直接解析，未知编码显式报错', async () => {
    const decoded = await decodeEnvelopePayload(tierOnlyFixture as unknown as { payload: string; meta: Json })
    expect(decoded.multiblockCount).toBe(1)
    await expect(
      decodeEnvelopePayload({ payloadEncoding: 'rot13', payload: 'e30=', meta: {} }),
    ).rejects.toThrow(/不支持的 payloadEncoding/)
  })
})

// ---------------------------------------------------------------------------
// 2. 显式报错（不静默退化）
// ---------------------------------------------------------------------------

describe('T2.1 解析失败显式报错（带原因，不静默退化为别的格式）', () => {
  const base = () => JSON.parse(JSON.stringify(innerOf(tierOnlyFixture))) as Json

  async function expectMultiblockError(raw: Json, pattern: RegExp): Promise<void> {
    const result = await productionRegistry().detectAndParse(raw)
    // 关键：仍被判为 Multiblock（而非退化成 V2Plain/World/StructureData），且显式给出原因
    expect(result.document).toBeNull()
    expect(result.parser?.formatName).toBe('Multiblock')
    expect(result.error).toMatch(/^Multiblock 解析错误/)
    expect(result.error).toMatch(pattern)
  }

  it('documentShape=multiblock 但 multiblockCount ≠ 1 → 报错', async () => {
    const bad = { ...base(), documentShape: MULTIBLOCK_DOCUMENT_SHAPE, multiblockCount: 2 }
    await expectMultiblockError(bad, /multiblockCount 必须为 1/)
  })

  it('documentShape=multiblock 但缺 multiblock 节 → 报错', async () => {
    const bad = base()
    delete bad.multiblock
    await expectMultiblockError({ ...bad, documentShape: MULTIBLOCK_DOCUMENT_SHAPE }, /multiblock 对象/)
  })

  it('documentShape=multiblock 但带根级 cellGrid → 报错（§2.3）', async () => {
    const bad = { ...base(), documentShape: MULTIBLOCK_DOCUMENT_SHAPE, cellGrid: [[[0]]] }
    await expectMultiblockError(bad, /不得带根级 cellGrid/)
  })

  it('frame 携带内联 ops → 报错（§5.3：组合展开形态判硬失败）', async () => {
    const bad = base()
    ;(bad.frames as Json[])[0]!.ops = [{ kind: 'setCell' }]
    await expectMultiblockError({ ...bad, documentShape: MULTIBLOCK_DOCUMENT_SHAPE }, /内联 ops/)
  })

  it('frame.variant 悬空 / stepIndex 越界 / 规则 id 未声明 → 各自报错', async () => {
    const missingVariant = base()
    ;(missingVariant.frames as Json[])[0]!.variant = 'structTier:0|tt:1|runstate:nope'
    await expectMultiblockError(
      { ...missingVariant, documentShape: MULTIBLOCK_DOCUMENT_SHAPE },
      /未在 multiblock\.variants 中声明/,
    )

    const badStep = base()
    ;(badStep.frames as Json[])[0]!.stepIndex = 99
    await expectMultiblockError({ ...badStep, documentShape: MULTIBLOCK_DOCUMENT_SHAPE }, /stepIndex=99 越界/)

    const badRule = base()
    ;(badRule.frames as Json[])[0]!.rules = ['not.a.rule']
    await expectMultiblockError({ ...badRule, documentShape: MULTIBLOCK_DOCUMENT_SHAPE }, /引用了未声明规则/)
  })

  it('indexTable 短于通道取值域长度（档 0 = Not set）→ 报错', async () => {
    const bad = base()
    const rules = (bad.multiblock as Json).rules as Json[]
    rules[0] = { id: 'r', phase: 'replace', kind: 'setCell', x: 0, y: 0, z: 0, channel: 'structTier', indexTable: [1, 2] }
    ;(bad.frames as Json[])[0]!.rules = ['r']
    await expectMultiblockError({ ...bad, documentShape: MULTIBLOCK_DOCUMENT_SHAPE }, /indexTable 长度 2 </)
  })

  it('框架声明缺字段（无 channels / 无 runstates / kind 非法）→ 报错', async () => {
    const noChannels = base()
    delete (noChannels.multiblock as Json).channels
    await expectMultiblockError({ ...noChannels, documentShape: MULTIBLOCK_DOCUMENT_SHAPE }, /multiblock\.channels 必须是数组/)

    const noRunstates = base()
    ;(noRunstates.multiblock as Json).runstates = []
    await expectMultiblockError(
      { ...noRunstates, documentShape: MULTIBLOCK_DOCUMENT_SHAPE },
      /runstates 不得为空/,
    )

    const badKind = base()
    ;((badKind.multiblock as Json).backbone as Json).kind = 'sizeGrid'
    await expectMultiblockError({ ...badKind, documentShape: MULTIBLOCK_DOCUMENT_SHAPE }, /backbone\.kind 必须为 "sizeSteps"/)
  })

  it('直接调用 parseMultiblockDeclaration 也抛 MultiblockParseError（带 reason）', () => {
    expect(() => parseMultiblockDeclaration({ documentShape: MULTIBLOCK_DOCUMENT_SHAPE, multiblockCount: 2 }))
      .toThrow(MultiblockParseError)
    try {
      parseMultiblockDeclaration({ documentShape: MULTIBLOCK_DOCUMENT_SHAPE, multiblockCount: 2, multiblock: {} })
    } catch (e) {
      expect((e as MultiblockParseError).reason).toMatch(/multiblockCount 必须为 1/)
    }
  })

  it('缺 documentShape 的文档（即使带 multiblock 节）仍走既有 parser，行为不变（§2.3 第三行）', async () => {
    const stray = { format_version: '2.0', id: 'stray', meta: {}, frames: [], multiblock: { id: 'x' } }
    const result = await productionRegistry().detectAndParse(stray)
    expect(result.parser?.formatName).toBe('V2Plain')
    expect(result.document!.multiblock).toBeNull()
    expect(MultiblockParser.detect(stray)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. RuntimeDocument 承载（T2.2 / T2.4 消费面）
// ---------------------------------------------------------------------------

describe('T2.3 RuntimeDocument 承载多方块声明', () => {
  it('各 fixture 的关键声明逐项落到 RuntimeDocument（帧为主字段不被改写）', async () => {
    for (const fx of FIXTURES) {
      const doc = (await productionRegistry().detectAndParse(fx.raw)).document!
      const decl = doc.multiblock!.decl
      expect(decl.channels, fx.name).toHaveLength(fx.channels)
      expect(decl.runstates, fx.name).toHaveLength(fx.runstates)
      expect(decl.rules, fx.name).toHaveLength(fx.rules)
      expect(decl.backbone.sizeSteps, fx.name).toHaveLength(fx.steps)
      expect(decl.variants, fx.name).toHaveLength(fx.variants)
      expect(doc.multiblockFrames, fx.name).toHaveLength(fx.frames)
      expect(doc.multiblockChannels).toBe(decl.channels)
      expect(doc.multiblockVariants).toBe(decl.variants)
      expect(doc.multiblockRules).toBe(decl.rules)
      expect(doc.multiblockRunstates).toBe(decl.runstates)
      expect(doc.multiblock!.blockPalette, fx.name).toHaveLength(fx.palette)
      expect(decl.tierSample, fx.name).toEqual(fx.tierSample)
      expect(decl.couplingMode, fx.name).toBe(fx.couplingMode)
      expect(decl.couplings, fx.name).toHaveLength(fx.couplings)
      expect(decl.hasScopeOverlap, fx.name).toBe(fx.hasScopeOverlap)
      expect(decl.viewerSemantics.runstateCoverage.tesr, fx.name).toBe('not-covered')
      expect(decl.viewerSemantics.frameIsVariant, fx.name).toBe(true)
      expect(decl.paletteSource, fx.name).toBe('union-all-variants')
      expect(decl.geometryEncoding, fx.name).toBe('bakedQuadsJsonV1')
      // fixture 是契约干净样本：不应有声明瑕疵
      expect(doc.multiblock!.warnings, `${fx.name}: ${doc.multiblock!.warnings.join(' | ')}`).toEqual([])
    }
  })

  it('通道：双键 enum/id、kind、呈现名、取值域含 0 = "Not set"、size 型 min/max', async () => {
    const doc = (await productionRegistry().detectAndParse(ebfFixture)).document!
    const byKey = doc.multiblock!.decl.channelByKey

    const height = byKey.get('height')!
    expect(height.enumName).toBe('STRUCTURE_HEIGHT')
    expect(height.id).toBe('height')
    expect(height.kind).toBe('size')
    expect(height.name).toBe('Height')
    expect(height.min).toBe(1)
    expect(height.max).toBe(5)
    expect(height.axis).toBe('y')
    expect(height.domain).toEqual({ lo: 0, hi: 5 })

    const coil = byKey.get('coil')!
    expect(coil.enumName).toBe('HEATING_COIL')
    expect(coil.kind).toBe('replace')
    expect(coil.name).toBe('Coil')
    // 取值域恒含 0（"Not set"），max 缺省时回落总 Tier 域上界
    expect(coil.domain).toEqual({ lo: 0, hi: 3 })
    expect(coil.slider).toBe(true)

    for (const fx of FIXTURES) {
      const d = (await productionRegistry().detectAndParse(fx.raw)).document!
      for (const ch of d.multiblockChannels) {
        expect(ch.domain.lo, `${fx.name}/${ch.key}`).toBe(0)
        expect(ch.domain.hi).toBeGreaterThanOrEqual(0)
        expect(ch.enumName === null || typeof ch.enumName === 'string').toBe(true)
      }
    }
  })

  it('总 Tier 域与运行态呈现名（T2.4 滑杆/切换的数据源）', async () => {
    const ebf = (await productionRegistry().detectAndParse(ebfFixture)).document!
    expect(ebf.multiblock!.decl.totalTierDomain).toEqual({ min: 1, max: 14, default: 2, source: 'probed' })
    expect(ebf.multiblockRunstates.map(r => [r.id, r.name])).toEqual([['idle', 'Idle'], ['active', 'Running']])
    expect(ebf.multiblockRunstates[1]!.materialSwap).toBe(true)

    const tierOnly = (await productionRegistry().detectAndParse(tierOnlyFixture)).document!
    // 仅总 Tier：骨架通道就是总通道（sizeChannel = "totalTier"，不是具名通道）
    expect(tierOnly.multiblock!.decl.backbone.sizeChannel).toBe('totalTier')
    expect(tierOnly.multiblockRunstates.map(r => r.id)).toEqual(['idle'])
  })

  it('变体映射：variantByKey 命中全部声明键，且键与契约派生规则一致（552 个键全查）', async () => {
    let checked = 0
    for (const fx of FIXTURES) {
      const doc = (await productionRegistry().detectAndParse(fx.raw)).document!
      const decl = doc.multiblock!.decl
      for (const v of decl.variants) {
        expect(decl.variantByKey.get(v.key)).toBe(v)
        expect(multiblockVariantKey(decl, v.values, v.runstate, v.totalTier), fx.name).toBe(v.key)
        checked++
      }
    }
    expect(checked).toBe(432 + 12 + 108)
  })

  it('Frame = 唯一变体原语：帧只承载变体声明，grid 延迟到装配（解析期不建 Grid）', async () => {
    const doc = (await productionRegistry().detectAndParse(ebfFixture)).document!
    const decl = doc.multiblock!.decl
    for (const frame of doc.frames) {
      // 解析阶段不建 Grid
      expect(frame.grid).toBeNull()
      const fd = frame.multiblock!
      expect(fd).not.toBeNull()
      // 帧 → 变体 → 骨架阶 → 规则表（全部可查表到达）
      expect(decl.variantByKey.has(fd.variant)).toBe(true)
      expect(decl.backbone.sizeSteps[fd.stepIndex]).toBeDefined()
      for (const ref of fd.rules) {
        expect(decl.ruleById.has(ref.id), `${ref.id}`).toBe(true)
      }
    }
    expect(doc.frames).toHaveLength(432)
    expect(doc.multiblockFrames[0]!.variant).toBe(doc.frames[0]!.multiblock!.variant)
  })

  it('规则表按引用复用：帧内无规则体，规则只存一份（含 indexRole/indexAliases/guard 的类型化）', async () => {
    const doc = (await productionRegistry().detectAndParse(lscOverlapFixture)).document!
    const decl = doc.multiblock!.decl
    for (const frame of doc.multiblockFrames) {
      expect('ops' in frame.raw).toBe(false)
    }
    const glassPlate = decl.ruleById.get('glass.plate')!
    expect(glassPlate.kind).toBe('setCell')
    expect(glassPlate.channel).toBe('glass')
    expect(glassPlate.indexTable).toEqual([0, 4, 5])
    expect(glassPlate.guard!.clauses[0]!.channel).toBe('glass')
    expect(glassPlate.guard!.clauses[0]!.not).toBe(true)
    expect(glassPlate.guard!.clauses[0]!.value).toBe(0)
    const capPlate = decl.ruleById.get('cap.plate')!
    expect(capPlate.kind).toBe('fill')
    expect(capPlate.sel!.z).toEqual([0, 1])
    // 耦合/软约束/viewerSemantics 类型化承载
    expect(decl.couplings[0]!.a).toBe('capacitor')
    expect(decl.couplings[0]!.b).toBe('glass')
    expect(decl.couplings[0]!.requires).toBe('ge')
    expect(decl.notes.length).toBeGreaterThan(0)
    expect(decl.viewerSemantics.runstateCoverage.kind).toBe('none')
    // 骨架阶梯：每阶 cellGrid 形状与声明一致
    for (const step of decl.backbone.sizeSteps) {
      expect(step.cellGrid).toHaveLength(step.d)
      expect(step.cellGrid[0]).toHaveLength(step.hh)
      expect(step.cellGrid[0]![0]).toHaveLength(step.w)
    }
  })

  it('hatch 型通道不生成滑杆；声明瑕疵只进 warnings（不阻断）', () => {
    const inner = JSON.parse(JSON.stringify(innerOf(tierOnlyFixture))) as Json
    const mb = inner.multiblock as Json
    ;(mb.channels as Json[]).push({
      enum: 'GT_HATCHES',
      id: 'gt_hatch',
      key: 'gt_hatch',
      name: 'Hatch',
      kind: 'hatch',
      domain: {},
    })
    // 声明瑕疵：legend 未在 opsLegend 登记
    ;(mb.rules as Json[])[0]!.legend = 'no.such.legend'
    const declaration = parseMultiblockDeclaration(inner)
    const hatch = declaration.decl.channelByKey.get('gt_hatch')!
    expect(hatch.kind).toBe('hatch')
    expect(hatch.slider).toBe(false)
    expect(hatch.domain).toEqual({ lo: 0, hi: 3 })
    expect(declaration.decl.channels.filter(c => c.slider).map(c => c.key)).toEqual(['structTier'])
    expect(declaration.warnings.join(' | ')).toMatch(/no\.such\.legend 未在 multiblock\.opsLegend 中登记/)
  })

  it('装配输入接口：multiblockSource 即契约内层 JSON 对象（含 multiblock/blockPalette/frames，无根级 cellGrid）', async () => {
    for (const fx of FIXTURES) {
      const doc = (await productionRegistry().detectAndParse(fx.raw)).document!
      const source = doc.multiblockSource!
      const inner = innerOf(fx.raw as { payload: string })
      expect(source, fx.name).toEqual(inner)
      expect(source.multiblock).toEqual(inner.multiblock)
      expect(source.blockPalette).toEqual(inner.blockPalette)
      expect((source.frames as unknown[]).length).toBe(fx.frames)
      expect('cellGrid' in source, fx.name).toBe(false)
      expect(isMultiblockDocument({ ...source, documentShape: MULTIBLOCK_DOCUMENT_SHAPE })).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 4. round-trip
// ---------------------------------------------------------------------------

describe('T2.3 序列化 round-trip（帧为主不回归 / 多方块新增覆盖）', () => {
  it('多方块文档：serialize → fromV2Plain → 关键字段一致，且二次序列化幂等', async () => {
    for (const fx of FIXTURES) {
      const doc = (await productionRegistry().detectAndParse(fx.raw)).document!
      const inner = innerOf(fx.raw as { payload: string })
      const out = doc.serialize()

      // 形态自描述 + 契约节点原样保留（_extra 兜底）
      expect(out.documentShape, fx.name).toBe(MULTIBLOCK_DOCUMENT_SHAPE)
      expect(out.multiblock, fx.name).toEqual(inner.multiblock)
      expect(out.multiblockCount, fx.name).toBe(1)
      expect(out.blockPalette, fx.name).toEqual(inner.blockPalette)
      expect('cellGrid' in out, fx.name).toBe(false)
      expect(out.meta, fx.name).toEqual(doc.meta)

      // 帧：variant / runstate / stepIndex / rules 全部保留（帧仍是唯一变体原语）
      const outFrames = out.frames as Json[]
      const inFrames = inner.frames as Json[]
      expect(outFrames, fx.name).toHaveLength(inFrames.length)
      expect(outFrames[0]!.variant).toBe(inFrames[0]!.variant)
      expect(outFrames[0]!.stepIndex).toBe(inFrames[0]!.stepIndex)
      expect(outFrames[0]!.runstate).toBe(inFrames[0]!.runstate)
      expect(outFrames[0]!.rules).toEqual(inFrames[0]!.rules)
      expect(outFrames).toEqual(inFrames)

      // 反序列化回来：声明一致
      const again = RuntimeDocument.fromV2Plain(out)!
      expect(again.isMultiblock, fx.name).toBe(true)
      expect(again.multiblock!.decl.raw, fx.name).toEqual(doc.multiblock!.decl.raw)
      expect(again.multiblockChannels.map(c => c.key), fx.name).toEqual(doc.multiblockChannels.map(c => c.key))
      expect(again.multiblockVariants.map(v => v.key), fx.name).toEqual(doc.multiblockVariants.map(v => v.key))
      expect(again.multiblockRules.map(r => r.id), fx.name).toEqual(doc.multiblockRules.map(r => r.id))
      expect(again.multiblockFrames.map(f => f.variant), fx.name).toEqual(doc.multiblockFrames.map(f => f.variant))
      expect(again.multiblockFrames.map(f => f.stepIndex), fx.name).toEqual(doc.multiblockFrames.map(f => f.stepIndex))
      expect(again.frames.every(f => f.grid === null), fx.name).toBe(true)
      expect(again.serialize(), fx.name).toEqual(out)

      // 再走一次完整解析入口（形态判别仍成立）
      const reparsed = await productionRegistry().detectAndParse(again.serialize())
      expect(reparsed.parser?.formatName, fx.name).toBe('Multiblock')
      expect(reparsed.document!.multiblock!.decl.displayName, fx.name).toBe(fx.displayName)
    }
  })

  it('多方块文档：帧内可选参考 cellGrid 与未知顶层/信封 meta 键都不丢（_extra 兜底机制保持）', async () => {
    const inner = innerOf(tierOnlyFixture)
    ;(inner.frames as Json[])[0]!.cellGrid = [[[1]]]
    ;(inner.frames as Json[])[0]!.futureField = { a: 1 }
    inner.futureTopLevel = [1, 2, 3]
    const extended = {
      ...(tierOnlyFixture as unknown as Json),
      meta: { ...((tierOnlyFixture as unknown as Json).meta as Json), customMeta: 'keep-me' },
    }
    // 用扩展后的内层 body 重新装信封（fixture 内容不落盘，只在内存里改）
    const patched = { ...extended, payload: textToBase64(JSON.stringify(inner)) }
    const doc = (await productionRegistry().detectAndParse(patched)).document!
    expect(doc.multiblockFrames[0]!.cellGrid).toEqual([[[1]]])
    const out = doc.serialize()
    expect(out.futureTopLevel).toEqual([1, 2, 3])
    // 既有信封语义：meta 键平铺到 Plain 根（`_extra` 兜底），故 round-trip 后仍在
    expect(out.customMeta).toBe('keep-me')
    expect(out.documentShape).toBe(MULTIBLOCK_DOCUMENT_SHAPE)
    expect((out.frames as Json[])[0]!.futureField).toEqual({ a: 1 })
    expect((out.frames as Json[])[0]!.cellGrid).toEqual([[[1]]])
    const again = RuntimeDocument.fromV2Plain(out)!
    expect(again.multiblockFrames[0]!.cellGrid).toEqual([[[1]]])
    expect(again.multiblockFrames[0]!.raw.futureField).toEqual({ a: 1 })
    expect(again.serialize().customMeta).toBe('keep-me')
  })

  it('帧为主文档 round-trip 未回归（既有 `_extra` 与首帧 structure 展开行为不变）', async () => {
    const raw = JSON.parse(JSON.stringify(minimalV2)) as Json
    raw.unknownTopLevel = { keep: true }
    const doc = (await productionRegistry().detectAndParse(raw)).document!
    expect(doc.multiblock).toBeNull()
    const out = doc.serialize()
    expect(out.documentShape).toBeUndefined()
    expect(out.multiblock).toBeUndefined()
    expect(out.cellGrid).toBeDefined()
    expect(out.blockPalette).toBeDefined()
    expect(out.unknownTopLevel).toEqual({ keep: true })
    const again = RuntimeDocument.fromV2Plain(out)!
    expect(again.frames[0]!.grid).not.toBeNull()
    expect(again.frames[0]!.multiblock).toBeNull()
    expect(again.serialize()).toEqual(out)
  })
})

// ---------------------------------------------------------------------------
// 5. 既有四类 parser 回归
// ---------------------------------------------------------------------------
describe('T2.1 既有四类 parser 行为不变', () => {
  it('V2Plain：e2e minimal-v2.json 仍由 V2Plain 解析并构造 Grid', async () => {
    const result = await productionRegistry().detectAndParse(minimalV2)
    expect(result.parser?.formatName).toBe('V2Plain')
    const doc = result.document!
    expect(doc.frames[0]!.grid).not.toBeNull()
    expect(doc.frames[0]!.multiblock).toBeNull()
    expect(doc.multiblock).toBeNull()
  })

  it('Envelope：既有 gzip+base64 信封（structuredata-exported-envelope.json）仍走 Envelope 解析路径', async () => {
    expect(isEnvelopeDocument(structureDataEnvelope)).toBe(true)
    const result = await productionRegistry().detectAndParse(structureDataEnvelope)
    expect(result.error, result.error).toBeUndefined()
    expect(result.parser?.formatName).toBe('Envelope')
    const doc = result.document!
    expect(doc).not.toBeNull()
    expect(doc.multiblock).toBeNull()
    expect(MultiblockParser.detect(structureDataEnvelope)).toBe(false)
    // 与解析前的内层 body 一致（信封读取路径未改语义）
    const layers = await readEnvelopeLayers(structureDataEnvelope as unknown as { payload: string; meta: Json })
    expect(layers.inner).toBeTruthy()
    expect(layers.plain).toBeTruthy()
  })

  it('World 与 StructureData 仍各自命中（不被形态判别器干扰）', async () => {
    const world = {
      id: 'w1',
      label: 'W',
      frames: [{ index: 0, structure: { geometryPhase: 'baked', cellGrid: [[[1]]], blockPalette: [{ registryId: 'air', meta: 0 }] } }],
    }
    const worldResult = await productionRegistry().detectAndParse(world)
    expect(worldResult.parser?.formatName).toBe('World')
    expect(worldResult.document!.multiblock).toBeNull()

    const structureData = {
      geometryPhase: 'baked',
      id: 'sd1',
      label: 'SD',
      cellGrid: [[[1]]],
      blockPalette: [{ registryId: 'air', meta: 0 }],
    }
    const sdResult = await productionRegistry().detectAndParse(structureData)
    expect(sdResult.parser?.formatName).toBe('StructureData')
    expect(sdResult.document!.multiblock).toBeNull()
  })

  it('注册表：既有四类 detect 一行未改（各自判别条件保持）', () => {
    expect(V2PlainParser.detect({ format_version: '2.0', frames: [] })).toBe(true)
    expect(V2PlainParser.detect({ format_version: '2.1', frames: [] })).toBe(false)
    expect(WorldParser.detect({ id: 'x', frames: [] })).toBe(true)
    expect(WorldParser.detect({ id: 'x', frames: [], format_version: '2.0' })).toBe(false)
    expect(StructureDataParser.detect({ geometryPhase: 'baked', blockPalette: [], cellGrid: [] })).toBe(true)
    expect(StructureDataParser.detect({ geometryPhase: 'baked', blockPalette: [] })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 6. 与 T2.2 装配器的冻结接缝（只消费其输入形态，不改装配器）
// ---------------------------------------------------------------------------

describe('T2.3 → T2.2 接缝：RuntimeDocument 直接给出装配输入（契约内层 JSON）', () => {
  it('multiblockSource 无需再解信封即可装配；尺寸随总 Tier / 尺寸型通道变化', async () => {
    const doc = (await productionRegistry().detectAndParse(ebfFixture)).document!
    // JSON 边界上的唯一适配：Record<string, unknown> → 装配器的契约类型
    const inner = doc.multiblockSource as unknown as MultiblockInnerDocument

    const small = assembleSelection(inner, {
      totalTier: 1,
      values: { height: 0, coil: 0, glass: 0 },
      runstate: 'idle',
    })
    const big = assembleSelection(inner, {
      totalTier: 14,
      values: { height: 5, coil: 3, glass: 2 },
      runstate: 'active',
    })
    expect(small.grid.height).toBe(1)
    expect(big.grid.height).toBe(5)
    expect(big.grid.width).toBe(3)
    expect(big.grid.depth).toBe(3)

    // 全部已声明变体（Frame = 唯一变体原语）都能由该输入装配
    for (const v of doc.multiblockVariants) {
      const assembled = assembleSelection(inner, {
        totalTier: v.totalTier,
        values: v.values,
        runstate: v.runstate,
      })
      expect(assembled.grid.width, v.key).toBeGreaterThan(0)
      expect(assembled.grid.height, v.key).toBeGreaterThan(0)
    }
  })
})
