/**
 * R2-1a 第 2 件 —— **语义判断移植到适配器出口**（无论 `normalizeMultiblockDeclaration` 最终删还是接）。
 *
 * ## 为什么判据必须留在生产链上
 *
 * 「调色板保序」与「逐层冻结」此前只在 `domain/multiblockDocument#normalizeMultiblockDeclaration`
 * 上有判据 —— 而那个函数**今天没有任何消费者**（生产者清单见 #388 评论）。判据挂在没人调用的
 * 函数上，等于把语义寄存在一个死点上。本文件把它移到**真正产出承载的地方**：
 *
 *   真实 fixture → `parseMultiblockDeclaration` → `multiblockDeclarationOf` → 断言出口
 *
 * ## 三件断言
 *
 * ① **保序等长**：出口调色板逐位等于**输入**的顺序（`[0]` 恒为 air），长度相等；
 * ② **逐层冻结**：出口结构里每一个可达的非原始值都 `Object.isFrozen`（`sizeSteps`/`cellGrid`
 *    三个深度层、调色板条目、各清单及其元素…）—— 冻结是 API 承诺，不是实现细节；
 * ③ **摘要稳定**：同一份声明两次**独立**装配（各自重新解析）⇒ `multiblockDeclDigest` 相同。
 *
 * ## 负对照（区分力）
 *
 * 把**输入**的一个合法置换（交换下标 1↔2，`[0]` 仍 air）喂进去：出口必须跟随**输入顺序**；
 * 而"会给调色板排序的实现"（`domain/blockGeometry#normalizePalette`）一旦被接进出出口，
 * ①的判据立刻为假 —— 本条断言**显式**跑一次该情形，证明判据有区分力而不是恒绿。
 */
import { describe, it, expect } from 'vitest'

import {
  multiblockDeclarationOf,
  paletteEntryOf,
  type ParsedMultiblockDocument,
} from '@/adapters/files/multiblockDeclaration'
import { blockPaletteEntryKey, normalizePalette, type BlockPaletteEntry } from '@/domain/blockGeometry'
import { multiblockDeclDigest } from '@/domain/multiblockDocument'
import { parseMultiblockDeclaration } from '@/context/parsers/multiblockDocument'

import tierOnlyFixture from '@/context/__tests__/fixtures/multiblock-tier-only.json'

function innerOf(env: { payload: string }): Record<string, unknown> {
  const bin = atob(env.payload)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return JSON.parse(new TextDecoder('utf-8').decode(bytes)) as Record<string, unknown>
}

/** 每次调用都重新解析 —— 「独立装配」而不是复用同一个已解析对象。 */
function parsedFixture(): ParsedMultiblockDocument {
  return parseMultiblockDeclaration(innerOf(tierOnlyFixture as unknown as { payload: string }))
}

function orderOf(entries: readonly BlockPaletteEntry[]): readonly string[] {
  return entries.map((e) => blockPaletteEntryKey(e))
}

/**
 * **他人所有的子树**（不在"本适配器构造的层"里，故不进冻结判据）。
 *
 * 实测（本判据首跑即擒获，如实登记而非放宽阈值）：
 *
 *  - `geometry`：`BlockGeometryAsset`（`domain/blockGeometry#blockGeometryAsset`，`:444`
 *    `Object.freeze({ id, encoding, quads: Object.freeze([...quads]), mesh })`）——**数组**冻结、
 *    但数组里的**逐个 `Quad` 对象未冻结**（它们由 `decodeBlockGeometry` 产出，只有数组被冻；
 *    见 `:207/210/261`）。同一条路径 `composition/kernelAssembly#unionPaletteOf` 用的是**同一个**
 *    构造器 ⇒ 这是**跨模块的既有事实**，不是本适配器的缺口，且"是否冻结每个四边形"是
 *    `domain/blockGeometry` 的策略（逐四方块冻结有真实成本），不属本批。
 *  - `nbt`：外部 NBT 载荷，**原样透传**（本适配器不解释其内部结构）。
 *
 * 判据只对**本适配器构造的层**（声明骨架、各清单、`sizeSteps`/`cellGrid` 三个深度层、
 * 调色板条目本体与 `tooltip`）要求深层冻结 —— 那才是"出口 API 承诺"的范围。
 */
function isForeignSubtreeKey(key: string): boolean {
  return key === 'geometry' || key === 'nbt'
}

/** 出口结构里**本适配器构造**的所有可达非原始值（去重，按遍历序）。 */
function reachableOwnObjects(root: unknown): readonly object[] {
  const seen = new Set<object>()
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const v = stack.pop()
    if (v === null || typeof v !== 'object') continue
    if (seen.has(v as object)) continue
    seen.add(v as object)
    if (Array.isArray(v)) {
      stack.push(...v)
      continue
    }
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (isForeignSubtreeKey(k)) continue
      stack.push(child)
    }
  }
  return [...seen]
}

describe('R2 · 适配器出口：保序 / 逐层冻结 / 摘要稳定（生产链）', () => {
  it('① 保序等长：出口调色板逐位跟随**输入**顺序，长度相等，`[0]` 恒为 air', () => {
    const parsed = parsedFixture()
    const { declaration } = multiblockDeclarationOf(parsed)

    expect(orderOf(declaration.blockPalette)).toEqual(orderOf(parsed.blockPalette.map((raw) => paletteKeyOfRaw(raw))))
    expect(declaration.blockPalette).toHaveLength(parsed.blockPalette.length)
    expect(declaration.blockPalette[0]!.registryId).toBe('air')
  })

  it('② 逐层冻结：出口结构里每个可达非原始值都 `Object.isFrozen`', () => {
    const { declaration } = multiblockDeclarationOf(parsedFixture())
    const unfrozen: string[] = []

    // 具名层（父代理点名的两处：`sizeSteps` 与 `cellGrid`）——先单独点名，便于失败时定位。
    expect(Object.isFrozen(declaration), 'declaration 本体').toBe(true)
    expect(Object.isFrozen(declaration.backbone), 'backbone').toBe(true)
    expect(Object.isFrozen(declaration.backbone.sizeSteps), 'backbone.sizeSteps 数组').toBe(true)
    for (const [i, step] of declaration.backbone.sizeSteps.entries()) {
      expect(Object.isFrozen(step), `sizeSteps[${i}]`).toBe(true)
      expect(Object.isFrozen(step.cellGrid), `sizeSteps[${i}].cellGrid 数组`).toBe(true)
      for (const [z, zz] of step.cellGrid.entries()) {
        expect(Object.isFrozen(zz), `sizeSteps[${i}].cellGrid[${z}]`).toBe(true)
        for (const [y, yy] of zz.entries()) {
          expect(Object.isFrozen(yy), `sizeSteps[${i}].cellGrid[${z}][${y}]`).toBe(true)
        }
      }
    }
    expect(Object.isFrozen(declaration.blockPalette), 'blockPalette 数组').toBe(true)
    for (const [i, e] of declaration.blockPalette.entries()) {
      expect(Object.isFrozen(e), `blockPalette[${i}]`).toBe(true)
    }

    // 全量遍历：任何漏冻的层都会落到这里（而不是靠上面点名的那几处"看起来齐全"）。
    for (const o of reachableOwnObjects(declaration)) {
      if (!Object.isFrozen(o)) unfrozen.push(JSON.stringify(o).slice(0, 80))
    }
    expect(unfrozen, '出口结构不得有未冻结的非原始值').toEqual([])
  })

  it('③ 摘要稳定：两次独立装配同一份声明 ⇒ `multiblockDeclDigest` 相同', () => {
    const a = multiblockDeclarationOf(parsedFixture()).declaration
    const b = multiblockDeclarationOf(parsedFixture()).declaration
    expect(a).not.toBe(b) // 两个不同对象（否则"稳定"可能只是同一实例的自我比较）
    expect(multiblockDeclDigest(a)).toBe(multiblockDeclDigest(b))
  })

  it('负对照：输入的合法置换上，出口跟随输入顺序；而"排序实现"接进来会被判据抓住', () => {
    const parsed = parsedFixture()
    const input = parsed.blockPalette
    const permutedPalette = [input[0]!, input[2]!, input[1]!, ...input.slice(3)]
    expect(permutedPalette.length).toBeGreaterThanOrEqual(3)

    const permutedParsed: ParsedMultiblockDocument = { ...parsed, blockPalette: permutedPalette }
    const out = multiblockDeclarationOf(permutedParsed).declaration

    // 出口跟随输入顺序（不排序、不重排）。
    expect(orderOf(out.blockPalette)).toEqual(
      orderOf(permutedPalette.map((raw) => paletteKeyOfRaw(raw))),
    )
    // 前置：置换确实改变了顺序（否则本负对照恒绿、判据没有区分力）。
    const permutedKeys = orderOf(permutedPalette.map((raw) => paletteKeyOfRaw(raw)))
    expect(permutedKeys).not.toEqual(orderOf(input.map((raw) => paletteKeyOfRaw(raw))))

    // 区分力：若出口被接上"排序实现"，①的判据立刻为假。
    const sortedExit = normalizePalette(out.blockPalette)
    expect(orderOf(sortedExit), '排序实现必须被保序判据判红').not.toEqual(permutedKeys)
  })
})

/**
 * 判据与**适配器自己的转换**（`adapters/files/multiblockDeclaration#paletteEntryOf`）同一口径，
 * 否则比较的是"我另写的一份映射"。
 */
const paletteKeyOfRaw = (raw: unknown): BlockPaletteEntry => paletteEntryOf(raw)
