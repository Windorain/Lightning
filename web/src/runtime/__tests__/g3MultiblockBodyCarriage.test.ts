/**
 * R2-G3 ② —— **装载携带 body**：装配产物 → 内核会话 → `Context#kernelMultiblockBody()`。
 *
 * ## 本判据证明的那条链（每一步都是生产件）
 *
 * ```text
 * 真实夹具 → 生产解析器注册表 detectAndParse
 *          → assembleKernelDocument（装配产物多一个承运出口 multiblockBody）
 *          → adoptLoadedDocument（装载，唯一置位点）→ KernelSession 保管
 *          → Context#kernelMultiblockBody()（具名读面）
 * ```
 *
 * ## 为什么必须走生产（AGENTS.md #301 D3 ⑦）
 *
 * 纯函数判据喂"已带字段"的手工载荷会**恒绿**：它只证明"函数装得下这个值"。
 * 本条要证的是"**生产装载链真的把那件事物带到了消费方能取到的地方**"——
 * 故输入全部来自真实夹具与生产装配，且**不许**在判据里手工造 carrier。
 *
 * ## 判据与负对照
 *
 * | # | 正判据 | 区分力 |
 * |---|---|---|
 * | ① | 会话里的承运**非空**、**等于适配器输出**、**不是**解析侧原物、键面恰为承运两键 | 与 `doc.multiblock` 比引用；键面断言把 `raw`/`decl` 这类旧形状挡在外面 |
 * | ② | 装配产物内 `multiblockBody.declaration` 与 `content.multiblock` **同一对象** | 两次转换会造出"相等但不同物" ⇒ `toBe` 判红 |
 * | ③ | 不变式：`multiblockBody !== null` ⇔ `multiblock !== null` | 帧为主夹具（`parts-singlebox-mix`）⇒ 两个都 `null`（**不造空承运**） |
 * | ④ | `Context#kernelMultiblockBody()`（消费方真正的入口）与装配产物**同物** | 读面缺席 ⇒ `null` ⇒ 判红 |
 * | ⑤ | 卸载后**读不到**（`markUnloaded` 清空） | 串档负对照：不换文档也能证明它随文档生命周期 |
 *
 * 另有**注入式负对照**（不提交，只作为"判据能红"的证据在交付评论里登记）：
 * 把 `documentLoad` 的 `kernel.setMultiblockBody(...)` 那一行去掉 ⇒ ① 与 ④ 判红。
 */
import { describe, expect, it } from 'vitest'

import { plainRootOf } from '@/adapters/plainRoot'
import { multiblockBodyContentOf } from '@/adapters/multiblockDeclaration'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { assembleKernelDocument, type AssembledDocument } from '@/composition/kernelAssembly'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import { fixturePath, readJson } from '@/context/__tests__/multiblockFixtureIo.mjs'
import { readEnvelopeLayers } from '@/render/data/compactSceneDocument'
import { KernelSession } from '@/runtime/kernelSession'
import { makeAdoptedKernelReadHost } from '@/runtime/__tests__/kernelReadTestHost'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import singleboxFixture from '../../../e2e/fixtures/parts-singlebox-mix.v2.json'

const NOOP_LOG = { info: () => {}, warn: () => {} }

/** 多方块为主的真实夹具（与 `kernelAssembly.test.ts` / 适配器判据同一清单）。 */
const FIXTURES = ['multiblock-tier-only', 'multiblock-ebf-2ch', 'multiblock-lsc-overlap'] as const

/** 生产解析器注册顺序（与 `runtime/host/workbenchHost` 同一份清单）。 */
function productionRegistry() {
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  return parsers
}

/**
 * 走**生产装载**装载一份真实多方块夹具。
 *
 * `assembleKernelDocument` 在这里被**独立**再调一次（`adoptLoadedDocument` 只回布尔），
 * 用途是读装配产物本身 —— 与 `g5`/`g6` 的既有手法同口径。
 */
async function loadProduction(name: string): Promise<{
  name: string
  session: KernelSession
  plainRoot: Readonly<Record<string, unknown>>
  doc: RuntimeDocument
  assembled: AssembledDocument
}> {
  const raw = readJson(fixturePath(name)) as Record<string, unknown>
  const parsed = await productionRegistry().detectAndParse(raw)
  if (parsed.document === null) throw new Error(`夹具 ${name} 生产解析失败：${parsed.error}`)
  const layers = await readEnvelopeLayers(raw as never)
  const plainRoot = plainRootOf(layers.plain as Record<string, unknown>) as Readonly<Record<string, unknown>>
  const session = new KernelSession({
    documentId: `g3-carriage-${name}`,
    contextId: 'g3-carriage-ctx',
    capabilities: [],
  })
  const adopted = adoptLoadedDocument({ kernel: session, log: NOOP_LOG }, parsed.document as never, plainRoot, name)
  if (!adopted) throw new Error(`夹具 ${name} 生产装配失败`)

  const assembled = assembleKernelDocument({ doc: parsed.document as never, plainRoot })
  if (!assembled.ok) throw new Error(`夹具 ${name} 装配核心失败`)
  return { name, session, plainRoot, doc: parsed.document as never as RuntimeDocument, assembled: assembled.value }
}

describe('R2-G3 · 装载携带 body（装配产物 → 会话 → Context 读面，全生产链）', () => {
  it('① 会话里的承运非空、等于适配器输出、不是解析侧原物、键面恰为承运两键', async () => {
    for (const name of FIXTURES) {
      const { session, doc } = await loadProduction(name)
      const carried = session.multiblockBodyOf()
      expect(carried, `${name}：生产装载后会话必须有承运`).not.toBeNull()
      if (carried === null) throw new Error('unreachable')

      // 期望**独立**从适配器算出（不是读装配产物自己报的值）。
      const expected = multiblockBodyContentOf(doc.multiblock)
      expect(carried, `${name}：承运必须等于适配器对同一解析结果的输出`).toEqual(expected)

      // 键面：承运只有这两键 —— `raw`/`decl` 这类旧形状**不在**（G3 的"不许反演"）。
      expect(Object.keys(carried as unknown as Record<string, unknown>).sort(), `${name}：承运键面`).toEqual([
        'declaration',
        'frameGridEvidence',
      ])
      // 与解析侧原物**不同物**：承运不是"把旧载体换个地方放"。
      expect(carried, `${name}：承运不得是解析侧原物`).not.toBe(doc.multiblock as unknown as object)
      expect(
        carried.declaration as unknown as Record<string, unknown>,
        `${name}：内核承载的声明不得带 raw`,
      ).not.toHaveProperty('raw')
      // 声明本身是内核承载（有骨架阶/调色板/帧声明），不是空的占位。
      expect(carried.declaration.id, `${name}：载体必须是真实声明`).not.toBe('')
      expect(carried.declaration.frames.length, `${name}：帧声明必须随承运在场`).toBeGreaterThan(0)
    }
  })

  it('② 装配产物内：承运的声明与内容权威的声明**同一对象**（一次转换，不是两次）', async () => {
    for (const name of FIXTURES) {
      const { assembled } = await loadProduction(name)
      expect(assembled.multiblockBody, `${name}：装配产物必须带承运`).not.toBeNull()
      // `toBe` 是关键：若两处各自调一次适配器，值会"相等但不同物" ⇒ 判红。
      expect(assembled.multiblockBody!.declaration, `${name}：承运 ↔ 内容权威必须同物`).toBe(
        assembled.content.multiblock,
      )
    }
  })

  it('③ 不变式 `multiblockBody !== null ⇔ multiblock !== null`；帧为主载体**不造空承运**', async () => {
    for (const name of FIXTURES) {
      const { assembled } = await loadProduction(name)
      expect(
        assembled.multiblockBody !== null,
        `${name}：多方块文档必须两个出口同时在场`,
      ).toBe(assembled.multiblock !== null)
      expect(assembled.multiblock, `${name}：夹具前提是多方块文档`).not.toBeNull()
    }

    // **负对照**：帧为主的真实夹具 —— 旧载体有 `frames`/`isMultiblock === false`，
    // 内核侧不得为它造一份"空承运"（那会让消费方的 `body !== null` 判据恒真）。
    const raw = singleboxFixture as Record<string, unknown>
    const parsed = await productionRegistry().detectAndParse(raw)
    expect(parsed.document, '前提：帧为主夹具必须能被生产解析器读入').not.toBeNull()
    const session = new KernelSession({ documentId: 'g3-carriage-parts', contextId: 'g3-carriage-ctx', capabilities: [] })
    const adopted = adoptLoadedDocument({ kernel: session, log: NOOP_LOG }, parsed.document as never, plainRootOf(raw), 'parts')
    expect(adopted, '前提：帧为主夹具必须能被生产装配').toBe(true)

    const assembled = assembleKernelDocument({ doc: parsed.document as never, plainRoot: plainRootOf(raw) })
    expect(assembled.ok, '前提：帧为主夹具必须装配成功').toBe(true)
    if (!assembled.ok) throw new Error('unreachable')
    expect(assembled.value.multiblock, '帧为主文档不得有投影面').toBeNull()
    expect(assembled.value.multiblockBody, '帧为主文档不得有承运（不造空承运）').toBeNull()
    expect(session.multiblockBodyOf(), '帧为主文档的会话读面必须是 null').toBeNull()
    // 反证式前提：这份夹具确实**不是**多方块（否则上面的 null 断言无区分力）。
    expect((parsed.document as unknown as { isMultiblock?: boolean }).isMultiblock).toBe(false)
    // 且它确实**有**帧声明（证明"帧为主"不是靠空文档蒙对的）。
    expect(assembled.value.frameObjects.length, '前提：帧为主夹具必须有帧网格').toBeGreaterThan(0)
  })

  it('④ 消费方入口 `Context#kernelMultiblockBody()` 与装配产物同物（读面真的接上了）', async () => {
    for (const name of FIXTURES) {
      const { doc, plainRoot } = await loadProduction(name)
      const host = makeAdoptedKernelReadHost(doc, plainRoot)
      const viaContext = host.ctx.kernelMultiblockBody()
      expect(viaContext, `${name}：Context 读面必须给到承运`).not.toBeNull()
      expect(viaContext, `${name}：读面必须与适配器输出等值`).toEqual(multiblockBodyContentOf(doc.multiblock))
      // 与会话里的**同一份**（读面是保管处的视图，不是第二份拷贝）。
      expect(viaContext, `${name}：读面与会话保管的是同一份`).toBe(host.session!.multiblockBodyOf())
    }
  })

  it('⑤ 串档负对照：`markUnloaded()` 后读面必须回到 `null`', async () => {
    const { session } = await loadProduction('multiblock-tier-only')
    expect(session.multiblockBodyOf(), '前提：装载后在场（否则下面的 null 无区分力）').not.toBeNull()
    session.markUnloaded()
    expect(session.multiblockBodyOf(), '卸载后不得留着上一份文档的承运（串档）').toBeNull()
  })
})
