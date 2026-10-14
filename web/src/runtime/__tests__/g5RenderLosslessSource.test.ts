/**
 * **G5（渲染链旧格式源终切 · S1）**：渲染视图链的**无损源**判据。
 *
 * ## 本文件证的是什么
 *
 * `composition/kernelRenderView#kernelRenderViewOf` 的 `plainRoot` 入参此前在生产
 * 路径上**从不传** ⇒ 回落 `doc.serialize()`。而 `RuntimeDocument` 是**有损**中间层
 * （`label`/`author`/`description`/`gtnhVersion`/`modSource`/`globalConfig`/`schemaVersion`
 * 七个根级键被 `fromV2Plain` 列进 `known` 却从不读、也不收进 `_extra`）。
 *
 * 现在的链路（本批 S1 落点）：
 *
 * ```
 *  composition/documentLoad#adoptLoadedDocument      （生产装配，唯一置位点）
 *        │  kernel.setAssemblySourceRoot(plainRootOf(raw))
 *        ▼
 *  KernelSession#assemblySourceRootOf()              （宿主：生命周期 = 文档生命周期）
 *        │
 *        ▼
 *  Context#kernelSourceRoot()                        （具名读面）
 *        │
 *        ▼
 *  shared/viewport/useKernelChannels → kernelRenderViewOf({ plainRoot })
 * ```
 *
 * ## 判据的形状（三条，缺一不可）
 *
 * 1. **无损是可观察事实**：注入的源根键（含**未知顶层键**与**根级元数据键**）
 *    经会话往返后**逐键相等**（不是"看调用形态"）；
 * 2. **有损路径机械可见**：同一份文档的 `doc.serialize()` **不含**那些键
 *    （证明"回落 `serialize()`"不可能等价 —— 这是负对照的**前提**）；
 * 3. **负对照判红**：同一份装配产物，`kernelRenderViewOf` **传**与**不传**
 *    `plainRoot` 产出的渲染视图在**可观察面**上必须不同（本判据用
 *    `meta.created_at_ms`：无损源里有、`serialize()` 里没有）。
 *
 * ⚠️ 输入全部走**生产装配**（`adoptLoadedDocument` + `plainRootOf`），
 * 不是手搓载荷 —— 否则"字段从没被生产填过"会假绿（AGENTS.md 的接线判据纪律）。
 */

import { describe, expect, it } from 'vitest'
import { plainRootOf } from '@/adapters/plainRoot'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { kernelRenderViewOf } from '@/composition/kernelRenderView'
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
import type { MultiblockSelectionState } from '@/shared/viewport/multiblockChannelUi'

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

const FIXTURES = ['multiblock-ebf-2ch', 'multiblock-tier-only'] as const

describe('G5 · 渲染链无损源（kernelSourceRoot → kernelRenderViewOf#plainRoot）', () => {
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

  it('② 有损路径机械可见：`doc.serialize()` **不含**这些键（回落 serialize() 不可能等价）', async () => {
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

  it('③ 负对照判红：同一装配产物，传/不传 `plainRoot` 的渲染视图在可观察面上**必须不同**', async () => {
    for (const name of FIXTURES) {
      const { doc, session, sourcePlain } = await loadWithLosslessSource(name)
      const selection: MultiblockSelectionState = { totalTier: 1, values: {}, runstate: '' }
      const withRoot = kernelRenderViewOf({
        doc,
        selection,
        frameIndex: 0,
        plainRoot: session.assemblySourceRootOf() ?? undefined,
      })
      const withoutRoot = kernelRenderViewOf({ doc, selection, frameIndex: 0 })
      // 前提：两条路都产出了渲染视图（否则"不同"可能只是"一个 null"）。
      expect(withRoot.doc, `${name}：传无损源必须产出渲染视图`).not.toBeNull()
      expect(withoutRoot.doc, `${name}：不传也必须产出渲染视图（如实降级，不崩）`).not.toBeNull()
      // 可观察面：投影把 `content.metadata.createdAtMs` 写到 `meta.created_at_ms`。
      const metaOf = (d: unknown): Record<string, unknown> =>
        ((d as { meta: Record<string, unknown> }).meta ?? {}) as Record<string, unknown>
      expect(
        metaOf(withRoot.doc).created_at_ms,
        `${name}：传无损源 ⇒ 渲染视图的元数据必须来自**源**（逐字）`,
      ).toBe(INJECTED_CREATED_AT_MS)
      expect(
        metaOf(withoutRoot.doc).created_at_ms,
        `${name}：**负对照**——不传无损源 ⇒ 该值必须不同（否则本判据无区分力）`,
      ).not.toBe(INJECTED_CREATED_AT_MS)
      // 而且"无损"这件事在渲染视图上还要与**源**一致（不是只与另一个内部值一致）。
      expect(sourcePlain.meta, `${name}：前提——源根确有 meta`).toBeDefined()
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
})
