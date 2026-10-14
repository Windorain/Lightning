/**
 * R2-1a —— **`normalizeMultiblockDeclaration` 的下标陷阱**判据（R2 裁决 #388 7501 第 2 项）。
 *
 * ## 被测事实
 *
 * `blockPalette` 在本承载里是**下标空间**，不是呈现清单：`backbone.sizeSteps[].cellGrid`
 * 逐格存的是调色板下标（契约 §4.4；§5 装配伪码 `ASSERT 每个下标 ∈ [0, blockPalette.length)`；
 * §6「air 恒下标 0」）。旧实现走 `domain/blockGeometry#normalizePalette`（去重 + 排序），
 * 会把每一格指向另一个方块。
 *
 * ## 判据输入来自**生产装配**（AGENTS.md「新承载字段的判据必须至少有一条走生产装配」）
 *
 * 仓库真实 fixture → 生产解析器 `parseMultiblockDeclaration` → 生产适配器
 * `multiblockDeclarationOf` → 被测函数。不是手工拼的载荷。
 *
 * ## 诚实边界：真实夹具**单独不能**区分新旧实现
 *
 * 实测（`assert` 见第 1 条）：该夹具的并集调色板**已排序且无重复条目**
 * ⇒ `normalizePalette` 对它是空操作 ⇒ 只用它做判据会**恒绿**（旧实现也过）。
 * 故区分力由第 3 条负对照提供：取**同一份生产调色板的一个合法置换**
 * （交换下标 1↔2，`[0]` 仍是 air —— 契约 §4.5.2 `indexAliases` 的存在证明
 * "编号顺序在编码器之间会变"），断言旧行为违反不变量、新行为满足。
 */
import { describe, it, expect } from 'vitest'

import {
  multiblockDeclDigest,
  normalizeMultiblockDeclaration,
  type MultiblockDeclaration,
} from '@/domain/multiblockDocument'
import { blockPaletteEntryKey, normalizePalette } from '@/domain/blockGeometry'
import { multiblockDeclarationOf } from '@/adapters/files/multiblockDeclaration'
import { parseMultiblockDeclaration } from '@/context/parsers/multiblockDocument'

import tierOnlyFixture from '@/context/__tests__/fixtures/multiblock-tier-only.json'

/** 信封内层 body（base64(json)；与 `context/__tests__/multiblockParser.test.ts#innerOf` 同口径）。 */
function innerOf(env: { payload: string }): Record<string, unknown> {
  const bin = atob(env.payload)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return JSON.parse(new TextDecoder('utf-8').decode(bytes)) as Record<string, unknown>
}

/** 生产链产出的一份真实承载（解析器 → 适配器），不是手工载荷。 */
const productionDecl: MultiblockDeclaration = multiblockDeclarationOf(
  parseMultiblockDeclaration(innerOf(tierOnlyFixture as unknown as { payload: string })),
).declaration

/** 逐位内容签名（下标空间的身份：位置 + 内容都必须一致）。 */
function signatureOf(entries: MultiblockDeclaration['blockPalette']): readonly string[] {
  return entries.map((e) => blockPaletteEntryKey(e))
}

/** 「调色板逐位同内容且等长」——"不重排"的机械形式。 */
function preservesIndices(
  before: MultiblockDeclaration['blockPalette'],
  after: MultiblockDeclaration['blockPalette'],
): boolean {
  return before.length === after.length && signatureOf(before).every((k, i) => k === signatureOf(after)[i])
}

/** 逐格网格下标 → 该格指向的调色板条目签名（"每一格是否指向同一个方块"的可判形式）。 */
function gridTargetsOf(decl: MultiblockDeclaration): readonly string[] {
  const sig = signatureOf(decl.blockPalette)
  const out: string[] = []
  for (const step of decl.backbone.sizeSteps) {
    for (const zz of step.cellGrid) {
      for (const yy of zz) {
        for (const x of yy) out.push(sig[x] ?? `OUT_OF_RANGE(${x})`)
      }
    }
  }
  return out
}

describe('R2 · normalizeMultiblockDeclaration 不得重排下标空间（生产链）', () => {
  it('真实夹具的并集调色板**已排序且无重复** ⇒ 该夹具单独不能区分新旧实现（如实登记）', () => {
    const sig = signatureOf(productionDecl.blockPalette)
    expect(sig.length, '夹具调色板必须有足够条目供负对照置换').toBeGreaterThanOrEqual(3)
    expect([...sig].sort((a, b) => a.localeCompare(b))).toEqual(sig)
    expect(new Set(sig).size).toBe(sig.length)
    // 契约 §6「air 恒下标 0」：置换负对照必须保住这一条才叫"合法编号"。
    expect(productionDecl.blockPalette[0]!.registryId).toBe('air')
  })

  it('生产链：规范化后调色板**逐位同内容**、长度相等，网格每格仍指向同一方块，摘要不变', () => {
    const normalized = normalizeMultiblockDeclaration(productionDecl)

    expect(preservesIndices(productionDecl.blockPalette, normalized.blockPalette)).toBe(true)
    expect(normalized.blockPalette).toHaveLength(productionDecl.blockPalette.length)

    // 每一格指向的条目签名不变（长度相等 + 逐位同内容 ⇒ 下标语义未变）。
    expect(gridTargetsOf(normalized)).toEqual(gridTargetsOf(productionDecl))
    expect(gridTargetsOf(productionDecl).some((s) => s.startsWith('OUT_OF_RANGE'))).toBe(false)

    // 内容身份：规范化**不得**改变声明摘要（它是幂等的）。
    expect(multiblockDeclDigest(normalized)).toBe(multiblockDeclDigest(productionDecl))
  })

  it('负对照：同一份生产调色板的**合法置换**上，旧行为（`normalizePalette`）违反不变量、新行为满足', () => {
    const original = productionDecl.blockPalette
    // 合法置换：交换下标 1↔2（`[0]` 仍是 air —— 契约 §6）。
    const permuted = Object.freeze([
      original[0]!,
      original[2]!,
      original[1]!,
      ...original.slice(3),
    ])
    const permutedDecl: MultiblockDeclaration = { ...productionDecl, blockPalette: permuted }

    // 前置：置换确实改变了顺序（否则负对照恒绿、判据没有区分力）。
    expect(signatureOf(permuted)).not.toEqual(signatureOf(original))

    // ① 旧行为判红：`normalizePalette` 排序 ⇒ 位置被重排 ⇒ 下标空间被改写。
    const legacy = normalizePalette(permuted)
    expect(preservesIndices(permuted, legacy), '旧行为必须被本判据判红（区分力）').toBe(false)
    // 且它连**内容身份**都改了（同一声明两种摘要）。
    expect(multiblockDeclDigest({ ...permutedDecl, blockPalette: legacy })).not.toBe(multiblockDeclDigest(permutedDecl))

    // ② 新行为判绿：保序等长 ⇒ 置换保持不变、摘要不变。
    const fixed = normalizeMultiblockDeclaration(permutedDecl)
    expect(preservesIndices(permuted, fixed.blockPalette)).toBe(true)
    expect(multiblockDeclDigest(fixed)).toBe(multiblockDeclDigest(permutedDecl))
  })
})
