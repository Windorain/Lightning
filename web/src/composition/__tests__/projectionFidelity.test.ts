/**
 * **投影保真与**往返幂等**判据。
 *
 * ## 本文件证什么
 *
 * 授权修的两项缺口（多方块全声明帧产出 + tooltip 池进投影），以及实现过程中
 * 实测抓出的**三处迭代增长**缺陷。后者比前者严重得多 —— 前者的后果是"少东西"，
 * 后者的后果是**保存两次就坏掉**。
 *
 * ## 为什么判据必须是"迭代幂等"而不是"单轮往返"
 *
 * 单轮往返能通过的实现仍可能在**第二轮**膨胀或失败。本文件的核心判据是：
 *
 * ```
 * 原始 → 装配 → 投影 → 再装配 → 再投影 → …（4 轮）⇒ 字节数必须收敛
 * ```
 *
 * 这条判据当场抓出三处"元素级 `raw` 泄漏"（分别在 `variants`/`channels`/`notes`/
 * `rules[].guard.clauses[]`）。它们单轮看起来只是"多一点字节"，第二轮就嵌套一层，
 * 第 N 轮膨胀 N 层 —— 实测 `multiblock-ebf-2ch` 从 143208 B 涨到 **512552 B**
 * 且第 2 轮装配直接失败。
 */

import { describe, expect, it } from 'vitest'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { projectKernelDocument, projectToRuntimeDocument, type KernelDeclarationProjection } from '@/composition/kernelProjection'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { plainRootOf } from '@/adapters/plainRoot'
import { fixturePath, readJson } from '@/context/__tests__/multiblockFixtureIo.mjs'
import { TOOLTIP_GRID_NONE } from '@/render/schema/types'
import { realFixtureText, withRealFixture } from '../../../e2e/real-fixture-vitest'

/** 与宿主同序的生产解析器注册。 */
function productionParsers() {
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  return parsers
}

/** 装配产物的 `multiblock` → 投影入参（生产调用点同形）。 */
function declarationOf(assembled: ReturnType<typeof unwrapAssembled>): KernelDeclarationProjection | null {
  const mb = assembled.multiblock
  if (mb === null) return null
  return {
    id: mb.id,
    displayName: mb.displayName,
    declaration: mb.projection.declaration,
    declRaw: mb.declRaw,
    blockPalette: mb.projection.blockPalette,
    assets: mb.projection.assets,
    scenes: mb.projection.scenes,
    schemaVersion: mb.projection.schemaVersion,
    multiblockCount: mb.projection.multiblockCount,
  }
}

type Assembled = Extract<ReturnType<typeof assembleKernelDocument>, { ok: true }>['value']
function unwrapAssembled(r: ReturnType<typeof assembleKernelDocument>): Assembled {
  if (!r.ok) throw new Error(`装配失败：${r.error.code}`)
  return r.value
}

/** 读一份夹具（多方块走 fixturePath；真实信封走**仓外** `realFixtureText` 惰性解析）。 */
function loadRaw(name: string): Record<string, unknown> {
  if (name === 'envelope') {
    return JSON.parse(realFixtureText('structureDataExportedEnvelope')) as Record<string, unknown>
  }
  return readJson(fixturePath(name)) as Record<string, unknown>
}

/** 一轮：装配 → 投影（保存形态）→ 返回新的 plain。 */
async function oneRound(
  raw: unknown,
  plainRoot: Readonly<Record<string, unknown>> | undefined,
): Promise<{ bytes: number; plain: Record<string, unknown>; frames: number; tooltipPalette: unknown[] | undefined }> {
  const parsed = await productionParsers().detectAndParse(raw)
  expect(parsed.document, '每轮的输入都必须能被生产解析器读回').not.toBeNull()
  const assembled = unwrapAssembled(assembleKernelDocument({ doc: parsed.document!, plainRoot }))
  const { doc } = projectToRuntimeDocument({
    scene: assembled.scene,
    content: assembled.content,
    frameObjects: assembled.frameObjects,
    multiblockDeclaration: declarationOf(assembled),
    fidelityFields: assembled.unknownFields,
  })
  const plain = doc.serialize() as Record<string, unknown>
  return {
    bytes: JSON.stringify(plain).length,
    plain,
    frames: Array.isArray(plain.frames) ? plain.frames.length : 0,
    tooltipPalette: plain.tooltipPalette as unknown[] | undefined,
  }
}

const FIXTURES = ['multiblock-tier-only', 'multiblock-ebf-2ch', 'multiblock-lsc-overlap', 'envelope'] as const

/**
 * 逐夹具注册：**仓内**多方块真夹具（tier / ebf / lsc）始终运行；
 * `envelope` 是**仓外**真实信封，缺件时只有该条目显式 skip（不整文件 exclude）。
 */
function fixtureIt(name: string, title: string, fn: () => void | Promise<void>): void {
  if (name === 'envelope') withRealFixture('structureDataExportedEnvelope', title, fn)
  else it(title, fn)
}

describe('D1 补充 · 往返**幂等**（抓出三处迭代增长缺陷）', () => {
  for (const name of FIXTURES) {
    fixtureIt(name, `${name}：4 轮往返后字节数必须**收敛**（不膨胀、不失败）`, async () => {
      const raw0 = loadRaw(name)
      let plain = plainRootOf(raw0)
      let cur: unknown = raw0
      const sizes: number[] = []
      for (let i = 0; i < 4; i++) {
        const r = await oneRound(cur, plain)
        sizes.push(r.bytes)
        cur = r.plain
        plain = plainRootOf(r.plain)
      }
      // 收敛判据：第 2 轮起**逐轮相同**（第 1 轮可以把"源里未声明的缺省"补齐一次）。
      const tail = sizes.slice(1)
      expect(new Set(tail).size, `${name} 第 2 轮起必须稳定，实测：${sizes.join(' -> ')}`).toBe(1)
      console.log(`[D1+] ${name}: ${sizes.join(' -> ')} 收敛=${tail[0]}`)
    })
  }
})

describe('D1 补充 · 多方块产出**全部**声明帧（修掉 432 → 1 的丢失）', () => {
  for (const name of ['multiblock-tier-only', 'multiblock-ebf-2ch', 'multiblock-lsc-overlap'] as const) {
    it(`${name}：帧数 = 声明帧数，且每帧**不带** structure（与文件同形）`, async () => {
      const raw = loadRaw(name)
      const parsed = await productionParsers().detectAndParse(raw)
      const doc = parsed.document!
      const assembled = unwrapAssembled(assembleKernelDocument({ doc, plainRoot: plainRootOf(raw) }))
      const declFrames = assembled.multiblock!.projection.scenes.length
      const projected = projectKernelDocument({
        scene: assembled.scene,
        content: assembled.content,
        frameObjects: assembled.frameObjects,
        multiblockDeclaration: declarationOf(assembled),
      })
      const frames = projected.plain.frames as Record<string, unknown>[]
      expect(frames.length, `${name} 必须产出**全部**声明帧（旧的丢失语义是 1）`).toBe(declFrames)
      expect(frames.length, `${name} 应有真实的多帧（否则判据是常数比较）`).toBeGreaterThan(1)
      // 与文件同形：多方块的声明帧**不带** structure（网格是装配产物）
      for (const f of frames) {
        expect(f.structure, `${name} 的声明帧不得带 structure（那会让声明帧伪装成渲染帧）`).toBeUndefined()
      }
      // 每帧都带变体存储原语（契约 §5.3）
      for (const f of frames) {
        expect(typeof f.variant, `${name} 的帧必须带 variant`).toBe('string')
        expect(typeof f.runstate, `${name} 的帧必须带 runstate`).toBe('string')
        expect(Array.isArray(f.rules), `${name} 的帧必须带 rules`).toBe(true)
      }
    })
  }

  withRealFixture(
    'structureDataExportedEnvelope',
    '帧为主文档：帧数 = 网格对象数，且**每帧带** structure（两种形态语义不同）',
    async () => {
    const raw = loadRaw('envelope')
    const parsed = await productionParsers().detectAndParse(raw)
    const assembled = unwrapAssembled(assembleKernelDocument({ doc: parsed.document!, plainRoot: plainRootOf(raw) }))
    expect(assembled.multiblock, '真实信封是帧为主形态').toBeNull()
    const projected = projectKernelDocument({ scene: assembled.scene, content: assembled.content, frameObjects: assembled.frameObjects })
    const frames = projected.plain.frames as Record<string, unknown>[]
    expect(frames.length, '帧为主的帧数 = 网格对象数').toBe(assembled.frameObjects.length)
    expect(frames[0]!.structure, '帧为主必须每帧带 structure').toBeDefined()
    },
  )
})

describe('D1 补充 · tooltip 池进投影（修掉"切换后 tooltip 全丢"）', () => {
  withRealFixture(
    'structureDataExportedEnvelope',
    '真实信封：tooltipPalette 与 cellTooltipGrid 必须写出，且**逐格文本**与源相同',
    async () => {
    const raw = loadRaw('envelope')
    const parsed = await productionParsers().detectAndParse(raw)
    const assembled = unwrapAssembled(assembleKernelDocument({ doc: parsed.document!, plainRoot: plainRootOf(raw) }))
    const projected = projectKernelDocument({ scene: assembled.scene, content: assembled.content, frameObjects: assembled.frameObjects })
    const palette = projected.plain.tooltipPalette as string[] | undefined
    const grid = projected.plain.cellTooltipGrid as number[][][] | undefined
    expect(palette, 'tooltip 池必须写出（旧的投影完全不写这两项）').toBeDefined()
    expect(grid, '逐格说明网格必须写出').toBeDefined()
    expect(palette!.length, '池必须非空').toBeGreaterThan(0)

    // **无损判据**：逐格文本与源相同（池可以更紧凑 —— 同文案共享下标）。
    const src = plainRootOf(raw)!
    const srcPalette = src.tooltipPalette as string[]
    const srcGrid = src.cellTooltipGrid as number[][][]
    let compared = 0
    const rows = Math.max(srcGrid.length, grid!.length)
    for (let z = 0; z < rows; z++) {
      const cols = Math.max(srcGrid[z]?.[0]?.length ?? 0, grid![z]?.[0]?.length ?? 0)
      const height = Math.max(srcGrid[z]?.length ?? 0, grid![z]?.length ?? 0)
      for (let row = 0; row < height; row++) {
        for (let col = 0; col < cols; col++) {
          const si = srcGrid[z]?.[row]?.[col] ?? TOOLTIP_GRID_NONE
          const gi = grid![z]?.[row]?.[col] ?? TOOLTIP_GRID_NONE
          const st = si === TOOLTIP_GRID_NONE ? null : (srcPalette[si] ?? null)
          const gt = gi === TOOLTIP_GRID_NONE ? null : (palette![gi] ?? null)
          expect(gt, `[${z}][${row}][${col}] 的说明文本必须与源相同`).toBe(st)
          compared += 1
        }
      }
    }
    expect(compared, '必须真的比较过格（否则判据是空洞真）').toBeGreaterThan(100)
    // 反空洞真：源里确有带说明的格
    const srcNonEmpty = srcGrid.flat(3).filter((v) => v !== TOOLTIP_GRID_NONE).length
    expect(srcNonEmpty, '源必须有带说明的格').toBeGreaterThan(0)
    console.log(`[D1+] envelope tooltip: 池 源 ${srcPalette.length} → 投影 ${palette!.length}，逐格比较 ${compared} 格`)
    },
  )

  it('**负对照**：内核里没有逐格说明的文档 ⇒ 投影**不得**写这两项', async () => {
    // 用一份**确实没有** `cellTooltipGrid` 的夹具（多方块夹具都没有），
    // 而不是"从源里删掉" —— 后者会连解析器一起破坏（实测 `InvalidValue`），
    // 那测的是"解析失败"而不是"无说明时不写池"。
    const raw = loadRaw('multiblock-tier-only')
    const src = plainRootOf(raw)!
    expect(src.cellTooltipGrid, '前提：该夹具确实没有逐格说明').toBeUndefined()
    const parsed = await productionParsers().detectAndParse(raw)
    const assembled = unwrapAssembled(assembleKernelDocument({ doc: parsed.document!, plainRoot: src }))
    const projected = projectKernelDocument({
      scene: assembled.scene,
      content: assembled.content,
      frameObjects: assembled.frameObjects,
      multiblockDeclaration: declarationOf(assembled),
    })
    expect(projected.plain.tooltipPalette, '无说明 ⇒ 不得写出池（缺席 ≠ 空池）').toBeUndefined()
    expect(projected.plain.cellTooltipGrid, '无说明 ⇒ 不得写出网格').toBeUndefined()
  })
})
