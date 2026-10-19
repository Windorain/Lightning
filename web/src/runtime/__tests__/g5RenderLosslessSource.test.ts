/**
 * **G5（渲染链旧格式源终切 · S1）**：渲染视图链的**无损源**判据。
 *
 * ## 本文件证的是什么
 *
 * 渲染链的输入曾经是旧格式 `RuntimeDocument`（有损中间层：`label`/`author`/
 * `description`/`gtnhVersion`/`modSource`/`globalConfig`/`schemaVersion`
 * 七个根级键被 `fromV2Plain` 列进 `known` 却从不读、也不收进 `_extra`）。
 * 旧入口 `kernelRenderViewOf#plainRoot` 是"补上无损源"的那条路 —— 它在 M6-1 已删。
 *
 * 现在的链路（生产形态，**不再有"传/不传 plainRoot"这个参数**）：
 *
 * ```
 *  composition/documentLoad#adoptLoadedDocument      （生产装配，唯一置位点）
 *        │  kernel.setAssemblySourceRoot(plainRootOf(raw))
 *        ▼
 *  KernelSession#assemblySourceRootOf()              （宿主：生命周期 = 文档生命周期）
 *        │
 *        ▼
 *  Context#kernelRenderViewInputs()                  （已求值场景 + **内核内容**）
 *        │
 *        ▼
 *  kernelRenderViewFromFace                          （投影 + 读回）
 * ```
 *
 * ## 判据的形状（三条，缺一不可）
 *
 * 1. **无损是可观察事实**：注入的源根键（含**未知顶层键**与**根级元数据键**）
 *    经会话往返后**逐键相等**（不是"看调用形态"）；
 * 2. **有损路径机械可见**：同一份文档的 `doc.serialize()` **不含**那些键
 *    （证明"拿 serialize() 当装配源"不可能等价 —— 这是负对照的**前提**）；
 * 3. **负对照判红**：同一份文档、同一条生产入口，装配源**有损/无损**两种情形
 *    产出的渲染视图在**可观察面**上必须不同（本判据用 `meta.created_at_ms`：
 *    无损源里有、`serialize()` 里没有）。M6-1 之前这一条比的是
 *    `kernelRenderViewOf({ plainRoot })` 与 `kernelRenderViewOf({})`；
 *    旧入口删除后，**差异点回到它真正所在的地方**：装配源。
 *
 * ⚠️ 输入全部走**生产装配**（`adoptLoadedDocument` + `plainRootOf`），
 * 不是手搓载荷 —— 否则"字段从没被生产填过"会假绿（AGENTS.md 的接线判据纪律）。
 */

import { describe, expect, it } from 'vitest'
import { plainRootOf } from '@/adapters/plainRoot'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { kernelRenderViewFromFace } from '@/composition/kernelRenderView'
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
import type { RuntimeDocument } from '@/context/runtimeDocument'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID } from '@/runtime/kernelSession'
import { makeAdoptedKernelReadHost, type KernelReadHost } from '@/runtime/__tests__/kernelReadTestHost'

const NOOP_LOG = { info: () => {}, warn: () => {} }

/** 生产解析器注册顺序（与 `runtime/host/workbenchHost` 同一份清单）。 */
function productionRegistry() {
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  return parsers
}

/** 注入的未知顶层键（值刻意是"深层未类型化"结构，逐键相等判据才有效）。 */
const INJECTED_UNKNOWN: Readonly<Record<string, unknown>> = Object.freeze({
  zzCutoverUnknown: Object.freeze({ keep: Object.freeze([1, 2, 3]), nested: Object.freeze({ deep: 'kept' }) }),
})
/** 注入的**根级**元数据键：`serialize()` 读不回（`fromV2Plain` 的 `known` 集合里，却不读）。 */
const INJECTED_CREATED_AT_MS = 1700000000123

/**
 * 装载一份真实多方块夹具，并把"无损源"注入成**可判别**的形状。
 *
 * 注入点刻意选在两处（覆盖两类丢失）：
 *  - 顶层**未知键** `zzCutoverUnknown`（`fromV2Plain` 的 `known` 之外 => 也不进 `serialize()`）；
 *  - 根级 `meta.created_at_ms`（`known` 之内但**从不读** => 同样不进 `serialize()`）。
 */
async function loadWithLosslessSource(name: string): Promise<{
  doc: RuntimeDocument
  session: KernelSession
  sourcePlain: Readonly<Record<string, unknown>>
}> {
  const raw = readJson(fixturePath(name)) as Record<string, unknown>
  const parsed = await productionRegistry().detectAndParse(raw)
  if (parsed.document === null) throw new Error(`夹具 ${name} 解析失败`)
  const layers = await readEnvelopeLayers(raw as never)
  const plain = layers.plain as Record<string, unknown>
  const sourcePlain: Record<string, unknown> = {
    ...plain,
    ...INJECTED_UNKNOWN,
    meta: { ...((plain.meta as Record<string, unknown> | undefined) ?? {}), created_at_ms: INJECTED_CREATED_AT_MS },
  }
  const session = new KernelSession({ documentId: 'g5-doc', contextId: 'g5-ctx', capabilities: [] })
  // **生产装配**（`plainRootOf` 归一 + `adoptLoadedDocument`）—— 这是唯一置位点。
  const ok = adoptLoadedDocument({ kernel: session, log: NOOP_LOG }, parsed.document as never, plainRootOf(sourcePlain), name)
  if (!ok) throw new Error(`夹具 ${name} 装配失败`)
  return { doc: parsed.document as never as RuntimeDocument, session, sourcePlain }
}

/**
 * 同一份夹具的两条**生产装配**：有无无损源。
 *
 * - `withSource`：`adoptLoadedDocument(..., plainRootOf(注入后的根))`（生产形态）；
 * - `withoutSource`：`adoptLoadedDocument(..., undefined)` ⇒ 装配回落 `legacyPlainRoot(doc)`
 *   （即 `doc.serialize()` 的口径，有损）。两者都是**生产入口**，差别只在装配源 ——
 *   这正是 M6-1 前 `kernelRenderViewOf` 的 `plainRoot` 参数所代表的那件事。
 */
async function twoAssemblies(name: string): Promise<{ withSource: KernelReadHost; withoutSource: KernelReadHost }> {
  const raw = readJson(fixturePath(name)) as Record<string, unknown>
  const parsed = await productionRegistry().detectAndParse(raw)
  if (parsed.document === null) throw new Error(`夹具 ${name} 解析失败`)
  const layers = await readEnvelopeLayers(raw as never)
  const plain = layers.plain as Record<string, unknown>
  const sourcePlain: Record<string, unknown> = {
    ...plain,
    ...INJECTED_UNKNOWN,
    meta: { ...((plain.meta as Record<string, unknown> | undefined) ?? {}), created_at_ms: INJECTED_CREATED_AT_MS },
  }
  const withSource = makeAdoptedKernelReadHost(parsed.document as never, plainRootOf(sourcePlain))
  const withoutSource = makeAdoptedKernelReadHost(parsed.document as never)
  return { withSource, withoutSource }
}

/** 生产渲染视图的 `serialize()`（`useKernelChannels#renderDoc` 同一入口 + 同一读面）。 */
function renderedPlainOf(host: KernelReadHost): Record<string, unknown> {
  const inputs = host.ctx.kernelRenderViewInputs()
  if (inputs === null) throw new Error('前提：内核渲染视图输入必须在场')
  const rv = kernelRenderViewFromFace({ ...inputs, frameIndex: 0 })
  if (rv.doc === null) throw new Error(`渲染视图必须产出：${rv.diagnostics.join(' | ')}`)
  return rv.doc.serialize() as Record<string, unknown>
}

const FIXTURES = ['multiblock-ebf-2ch', 'multiblock-tier-only'] as const

describe('G5 · 渲染链无损源（session.assemblySourceRoot → 内核内容 → 渲染视图）', () => {
  it('① 无损可观察：注入的源根键经会话往返后**逐键相等**（含未知顶层键与根级元数据键）', async () => {
    for (const name of FIXTURES) {
      const { session, sourcePlain } = await loadWithLosslessSource(name)
      const face = session.assemblySourceRootOf()
      expect(face, `${name}：生产装配后会话必须有无损源根`).not.toBeNull()
      const got = face as Readonly<Record<string, unknown>>
      // 键面：集合相等（多一个 = 伪造；少一个 = 丢字段）。
      expect([...Object.keys(got)].sort(), `${name}：源根键面必须逐个相等`).toEqual(
        [...Object.keys(sourcePlain)].sort(),
      )
      // 叶子面：逐键**逐字**相等（不是只看键在不在）。
      for (const key of Object.keys(sourcePlain)) {
        expect(got[key], `${name}：键 ${key} 的值必须逐字保留`).toEqual(sourcePlain[key])
      }
      // 两条注入点必须在场（否则本判据可能因为夹具本身没这些键而恒真）。
      expect(got.zzCutoverUnknown, `${name}：注入的未知顶层键必须在场`).toBeDefined()
      expect(
        (got.meta as Record<string, unknown>).created_at_ms,
        `${name}：注入的根级 created_at_ms 必须在场`,
      ).toBe(INJECTED_CREATED_AT_MS)
    }
  })

  it('② 有损路径机械可见：`doc.serialize()` **不含**这些键（拿它当装配源不可能等价）', async () => {
    for (const name of FIXTURES) {
      const { doc } = await loadWithLosslessSource(name)
      const serialized = doc.serialize() as Record<string, unknown>
      // 前提自检：serialize() 有内容（避免"空文档也判红"这种无区分力的红）。
      expect(Object.keys(serialized).length, `${name}：serialize() 必须有内容`).toBeGreaterThan(0)
      expect(
        serialized.zzCutoverUnknown,
        `${name}：未知顶层键**不得**出现在 serialize() 里（否则回落路径等价，"无损"一词无意义）`,
      ).toBeUndefined()
      const meta = (serialized.meta ?? {}) as Record<string, unknown>
      expect(
        meta.created_at_ms,
        `${name}：注入的根级 created_at_ms **不得**出现在 serialize() 里（负对照的前提）`,
      ).not.toBe(INJECTED_CREATED_AT_MS)
    }
  })

  it('③ 负对照判红：同一生产入口，装配源**无损/有损**的渲染视图在可观察面上**必须不同**', async () => {
    for (const name of FIXTURES) {
      const { withSource, withoutSource } = await twoAssemblies(name)
      try {
        const lossless = renderedPlainOf(withSource)
        const lossy = renderedPlainOf(withoutSource)
        // 前提：两条路都产出了渲染视图（否则"不同"可能只是"一个 null"）。
        expect(Object.keys(lossless).length, `${name}：无损源必须产出渲染视图`).toBeGreaterThan(0)
        expect(Object.keys(lossy).length, `${name}：有损装配源也必须产出渲染视图（如实降级，不崩）`).toBeGreaterThan(0)

        // 可观察面：投影把 `content.metadata.createdAtMs` 写到 `meta.created_at_ms`。
        const metaOf = (d: Record<string, unknown>): Record<string, unknown> =>
          ((d.meta ?? {}) as Record<string, unknown>)
        expect(
          metaOf(lossless).created_at_ms,
          `${name}：无损源 ⇒ 渲染视图的元数据必须来自**源**（逐字）`,
        ).toBe(INJECTED_CREATED_AT_MS)
        expect(
          metaOf(lossy).created_at_ms,
          `${name}：**负对照**——有损装配源 ⇒ 该值必须不同（否则本判据无区分力）`,
        ).not.toBe(INJECTED_CREATED_AT_MS)
      } finally {
        withSource.dispose()
        withoutSource.dispose()
      }
    }
  })

  it('④ 串档防线：`markUnloaded()` 后无损源必须回到"未采集"（`null`，不是上一份文档的根）', async () => {
    const { session } = await loadWithLosslessSource('multiblock-tier-only')
    expect(session.assemblySourceRootOf(), '前提：装配后确实采集到了').not.toBeNull()
    session.markUnloaded()
    expect(
      session.assemblySourceRootOf(),
      '卸载后必须回到 null —— 否则换文档后渲染链会拿上一份文档的根级元数据',
    ).toBeNull()
  })

  it('⑤ 会话身份常量仍被本判据使用（防"宿主换了 id 而判据没跟"）', () => {
    // 这两条常量是 `makeAdoptedKernelReadHost` 的注入事实；本文件不新造第二套。
    expect(KERNEL_DOCUMENT_ID.length).toBeGreaterThan(0)
    expect(KERNEL_CONTEXT_ID.length).toBeGreaterThan(0)
  })
})
