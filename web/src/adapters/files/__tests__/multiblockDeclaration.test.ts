/**
 * G1/G2 —— **多方块声明承载的接线判据**（`adapters/files/multiblockDeclaration`）。
 *
 * ## 为什么判据的输入必须来自生产解析
 *
 * AGENTS.md「新承载字段的判据必须至少有一条走生产装配」：纯函数判据喂**手工载荷**
 * 会恒绿 —— 它证明的是"函数能处理这种形状"，不是"生产装配真的填了该字段"
 * （本项目已有 `gridInputOf` 漏传 `cellPalette`、`gridPayload` 漏填尺寸列两连）。
 * 故这里第 1 条的输入是：**仓库内的真实 fixture** → 生产解析器
 * （`context/parsers/multiblockDocument#parseMultiblockDeclaration`）→ 本适配器
 * → 生产内容构造器（`domain/content#documentContent`）→ 生产身份判据
 * （`domain/document#createDocument` 的 `version.contentVersion`）。
 *
 * ## 负对照（区分力）
 *
 * 第 2 条删掉承载：把真实声明的 `multiblock` 换成显式空值 ⇒ 摘要必须**回落**到
 * 空内容的摘要。与真实值相同即判红 —— 那意味着该字段其实没进内容身份。
 */
import { describe, it, expect } from 'vitest'

import {
  airLikePaletteEntry,
  multiblockDeclarationOf,
  paletteEntryOf,
} from '@/adapters/files/multiblockDeclaration'
import { EMPTY_MULTIBLOCK_DECLARATION } from '@/domain/multiblockDocument'
import { EMPTY_CONTENT, documentContent, type DocumentContent } from '@/domain/content'
import { createDocument } from '@/domain/document'
import { parseMultiblockDeclaration } from '@/context/parsers/multiblockDocument'

import tierOnlyFixture from '@/context/__tests__/fixtures/multiblock-tier-only.json'

type Json = Record<string, unknown>

/** 信封内层 body（base64(json)；与 `context/__tests__/multiblockParser.test.ts#innerOf` 同一口径）。 */
function innerOf(env: { payload: string }): Json {
  const bin = atob(env.payload)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return JSON.parse(new TextDecoder('utf-8').decode(bytes)) as Json
}

/** 真实 fixture 的**已解析**声明（生产解析器产出，不是手工载荷）。 */
const parsedFixture = parseMultiblockDeclaration(innerOf(tierOnlyFixture as unknown as { payload: string }))

/**
 * 一条内容路径的文档内容身份。
 *
 * `Version.contentVersion` 在类型上是可选的，但 `createDocument` **必须**给出它 —— 否则
 * "内容身份"这条判据本身无对象。故这里不写 `?? 0`（那会把"版本维丢了"静默变成一个
 * 合法摘要），而是让前置条件**显式**失败。
 */
function contentVersionOf(content: DocumentContent): number {
  const contentVersion = createDocument('g1-probe', { content }).version.contentVersion
  if (contentVersion === undefined) {
    throw new Error('createDocument 必须给出 contentVersion（否则内容身份判据无对象）')
  }
  return contentVersion
}

describe('G1/G2 · 已解析声明 → 内核承载 → 内容身份（生产路径）', () => {
  it('真实 fixture：解析器 → 适配器 → `documentContent` 逐字段承载，且进内容身份', () => {
    const { declaration } = multiblockDeclarationOf(parsedFixture)

    // 契约 §2.3：真实多方块文档恒 1 个节点，且 id/displayName 非空（故"空 ⟺ 无"是结构事实）。
    expect(declaration.multiblockCount).toBe(1)
    expect(declaration.id).toBe(parsedFixture.decl.id)
    expect(declaration.displayName).toBe(parsedFixture.decl.displayName)

    // 声明半逐条搬运（`decl` 摊平；`raw` 一律不承载）。
    expect(declaration.channels.map((c) => c.key)).toEqual(parsedFixture.decl.channels.map((c) => c.key))
    expect(declaration.runstates.map((r) => r.id)).toEqual(parsedFixture.decl.runstates.map((r) => r.id))
    expect(declaration.variants.length).toBe(parsedFixture.decl.variants.length)
    expect(declaration.rules.map((r) => r.id)).toEqual(parsedFixture.decl.rules.map((r) => r.id))
    expect(declaration.backbone.sizeSteps.length).toBe(parsedFixture.decl.backbone.sizeSteps.length)
    for (const [i, step] of declaration.backbone.sizeSteps.entries()) {
      expect(step.cellGrid, `sizeStep[${i}].cellGrid 是下标网格，必须逐格原样搬运`).toEqual(
        parsedFixture.decl.backbone.sizeSteps[i]!.cellGrid,
      )
    }
    expect(declaration.scenes.length).toBe(parsedFixture.frames.length)
    expect(declaration.couplings.map((c) => c.id)).toEqual(parsedFixture.decl.couplings.map((c) => c.id))
    expect(declaration.notes).toHaveLength(parsedFixture.decl.notes.length)
    expect(declaration.opsLegend).toEqual(parsedFixture.decl.opsLegend)
    expect(declaration.schemaVersion).toBe(parsedFixture.schemaVersion ?? null)
    expect(declaration.viewerSemantics).toEqual({
      frameIsVariant: parsedFixture.decl.viewerSemantics.frameIsVariant,
      playback: parsedFixture.decl.viewerSemantics.playback,
      layerPreview: parsedFixture.decl.viewerSemantics.layerPreview,
      runstateCoverage: {
        kind: parsedFixture.decl.viewerSemantics.runstateCoverage.kind,
        geometryDelta: parsedFixture.decl.viewerSemantics.runstateCoverage.geometryDelta,
        tesr: parsedFixture.decl.viewerSemantics.runstateCoverage.tesr,
      },
    })

    // **顺序即身份**：并集调色板逐位对齐声明顺序（不排序、不去重）。
    expect(declaration.blockPalette).toHaveLength(parsedFixture.blockPalette.length)
    expect(declaration.blockPalette[0]!.registryId).toBe('air')

    // 迁移阻塞点的那一段：帧 + 声明现在都在内核内容里。
    const content = documentContent({ multiblock: declaration })
    expect(content.multiblock.scenes.length).toBe(parsedFixture.frames.length)

    // 进内容身份：真实声明 ≠ 无声明。
    expect(contentVersionOf(content)).not.toBe(contentVersionOf(documentContent()))
  })

  it('**负对照**：删掉承载（换成显式空值）⇒ 摘要必须回落到空内容的摘要', () => {
    const carried = contentVersionOf(documentContent({ multiblock: multiblockDeclarationOf(parsedFixture).declaration }))
    const dropped = contentVersionOf(documentContent({ multiblock: EMPTY_MULTIBLOCK_DECLARATION }))
    const empty = contentVersionOf(EMPTY_CONTENT)
    expect(carried, '前提：承载后摘要必须与空不同（否则本负对照无区分力）').not.toBe(empty)
    expect(carried).not.toBe(dropped)
    expect(dropped, '删掉承载即回落：证明该字段真的进内容身份').toBe(empty)
  })

  it('**内容身份确定**：显式空的同一语义在三条构造路径上得到**同一个** digest', () => {
    // 路径 ①：`EMPTY_CONTENT` 常量字面量
    // 路径 ②：`documentContent()` 无参缺省
    // 路径 ③：`documentContent({ multiblock: EMPTY_MULTIBLOCK_DECLARATION })` 显式传空
    // 三者若不同，就是"同一语义两种摘要" —— 会让文档凭空变脏、并让求值键抖动。
    const a = contentVersionOf(EMPTY_CONTENT)
    const b = contentVersionOf(documentContent())
    const c = contentVersionOf(documentContent({ multiblock: EMPTY_MULTIBLOCK_DECLARATION }))
    expect(b, '`documentContent()` 缺省必须等于 `EMPTY_CONTENT`').toBe(a)
    expect(c, '显式传空必须等于缺省（禁 `undefined` 冒充「无」）').toBe(a)
    // 同一份真实声明**两次独立装配**也必须同摘要（装配不得引入非确定量，如 Map 迭代序）。
    const d1 = contentVersionOf(documentContent({ multiblock: multiblockDeclarationOf(parsedFixture).declaration }))
    const d2 = contentVersionOf(documentContent({ multiblock: multiblockDeclarationOf(parsedFixture).declaration }))
    expect(d2).toBe(d1)
    expect(d1).not.toBe(a)
  })

  it('未承载的字段**报诊断**，不静默丢（§12）', () => {
    const inner = innerOf(tierOnlyFixture as unknown as { payload: string })
    const frames = (inner.frames as Json[]).map((f, i) =>
      i === 0 ? { ...f, cellGrid: [[[0]]] } : f,
    )
    const withGaps = parseMultiblockDeclaration({
      documentShape: 'multiblock',
      ...inner,
      frames,
      notAKeyWeCarry: { anything: true },
    } as Json)

    const codes = multiblockDeclarationOf(withGaps).diagnostics.map((d) => d.code)
    expect(codes).toContain('FrameCellGridNotCarried')
    expect(codes).toContain('UnknownBodyKeyNotCarried')
    expect(codes.length, '解析器节点恒带 raw ⇒ 未承载诊断必然出现').toBeGreaterThan(0)
  })
})

describe('adapters/files/multiblockDeclaration · 调色板条目的边界口径', () => {
  it('非对象条目 → air 形（**不**静默跳过，否则下标全部错位）', () => {
    expect(paletteEntryOf(null).registryId).toBe('air')
    expect(paletteEntryOf(42).registryId).toBe('air')
    expect(paletteEntryOf(undefined)).toEqual(airLikePaletteEntry())
  })

  it('缺省字段按 `unionPaletteOf` 口径落地；thumbnailPNG → thumbnail；tooltip 只留字符串', () => {
    const e = paletteEntryOf({ registryId: 'minecraft:stone', thumbnailPNG: 'AAA', tooltip: ['a', 7, 'b'] })
    expect(e.registryId).toBe('minecraft:stone')
    expect(e.meta).toBe(0)
    expect(e.renderMode).toBe('BakedModel')
    expect(e.thumbnail).toBe('AAA')
    expect(e.tooltip).toEqual(['a', 'b'])
  })

  it('**顺序不排序**：乱序输入的输出顺序逐位等于输入顺序（下标即身份）', () => {
    const input = [{ registryId: 'b' }, { registryId: 'a' }, { registryId: 'b' }]
    expect(input.map((x) => paletteEntryOf(x).registryId)).toEqual(['b', 'a', 'b'])
  })
})
