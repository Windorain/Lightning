/**
 * `gtVersion` 在**真实解析/装配路径**上的落位判据。
 *
 * 场景文件契约把版本拆成两条事实：`gtnhVersion`（**GTNH 整合包版本**）与 `gtVersion`（**GregTech 版本**），
 * 两者不得互相顶替。本文件回答的是装配层的问题：一份**新产物**在根上有 `gtVersion` 时，
 *
 * 1. 装配层**不再把它误报**成 `unknownRootField`（否则每份新文件都多一条假诊断）；
 * 2. 它的值**没有丢**：不列入 `RuntimeDocument.fromV2Plain` 的 `known` 集合 ⇒ 走 `_extra` 原样透传，
 *    `serialize()` 里仍读得到（这正是"列了却不读 ⇒ 静默丢失"的反面）；
 * 3. 诊断机制本身仍然有效：同一批里塞一个真·未知键，必须照旧判 `unknownRootField`（负对照，
 *    证明第 1 条不是"诊断整体失效"换来的）。
 *
 * 输入是**真实多方块夹具信封**，只往 `meta` 里注入两条版本字段（新产物形态）；解析、解包、装配全部走生产代码。
 */
import { describe, expect, it } from 'vitest'

import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { createParserRegistry } from '@/context/parserRegistry'
import { RuntimeDocument } from '@/context/runtimeDocument'
import { unwrap } from '@/domain/errors'
import { readEnvelopeLayers } from '@/render/data/compactSceneDocument'
import { fixturePath, readJson } from '@/context/__tests__/multiblockFixtureIo.mjs'

const PACK_VERSION = '2.8.142'
const GT_VERSION = '5.09.54.194'

/** 真实夹具信封 + 两条版本字段（= 新产物的 meta 形态）。 */
async function envelopeWithVersions(extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const envelope = readJson(fixturePath('multiblock-tier-only')) as Record<string, unknown>
  const meta = { ...((envelope.meta as Record<string, unknown>) ?? {}) }
  meta.gtnhVersion = PACK_VERSION
  meta.gtVersion = GT_VERSION
  for (const [k, v] of Object.entries(extra)) meta[k] = v
  ;(envelope as Record<string, unknown>).meta = meta
  return envelope
}

describe('gtVersion：真实解析路径上不丢、不误报', () => {
  it('生产解包把两条版本字段摊平到 plain 根，且 `_extra` 原样带回 serialize()', async () => {
    const envelope = await envelopeWithVersions()
    const layers = await readEnvelopeLayers(envelope as never)
    expect(layers.plain.gtnhVersion, '整合包版本应被解包器摊平到 plain 根').toBe(PACK_VERSION)
    expect(layers.plain.gtVersion, 'GT 版本应被解包器摊平到 plain 根').toBe(GT_VERSION)

    const parsed = await createParserRegistry().detectAndParse(envelope)
    expect(parsed.document, '真实夹具应仍能被生产解析器解析').not.toBeNull()
    const doc = parsed.document as RuntimeDocument
    // 关键：`gtVersion` 不在 fromV2Plain 的 `known` 集合里 ⇒ 进 `_extra` ⇒ `serialize()` 能读回（不静默丢）
    const serialized = doc.serialize()
    expect(serialized.gtVersion, 'gtVersion 必须经 _extra 原样透传（不得静默丢弃）').toBe(GT_VERSION)
    // 对照：`gtnhVersion` 是 `known` 键 ⇒ 不进 `_extra`（既有有损口径），它的值由装配层从 plain 根读出
    expect(
      serialized.gtnhVersion,
      '对照：known 键不在 _extra 里（这是既有有损口径，值的来源是装配层的 plain 根读取）',
    ).toBeUndefined()

    const assembled = unwrap(assembleKernelDocument({ doc, plainRoot: layers.plain }))
    expect(assembled.content.metadata.gtnhVersion, '整合包版本由装配层从 plain 根读进元数据').toBe(PACK_VERSION)
  })

  it('装配不再把 gtVersion 报成 unknownRootField（真·未知键仍照旧判红）', async () => {
    const envelope = await envelopeWithVersions({ gtVersionTypo: 'oops' })
    const layers = await readEnvelopeLayers(envelope as never)
    const parsed = await createParserRegistry().detectAndParse(envelope)
    const assembled = unwrap(assembleKernelDocument({ doc: parsed.document as RuntimeDocument, plainRoot: layers.plain }))

    const paths = assembled.diagnostics.filter((d) => d.code === 'unknownRootField').map((d) => d.path)
    expect(paths, 'gtVersion 是已认识的键 ⇒ 不得再报 unknownRootField').not.toContain('$.gtVersion')
    expect(paths, 'gtnhVersion 同样不得被报未知').not.toContain('$.gtnhVersion')
    // 负对照：诊断机制仍然有效（否则上一条是空转）
    expect(paths, '真·未知键必须照旧进诊断（证明上面那条不是"诊断整体失效"）').toContain('$.gtVersionTypo')
    expect(
      Object.prototype.hasOwnProperty.call(assembled.unknownFields, 'gtVersionTypo'),
      '真·未知键必须进保真记录',
    ).toBe(true)
    expect(
      Object.prototype.hasOwnProperty.call(assembled.unknownFields, 'gtVersion'),
      'gtVersion 不得进"未知字段"保真记录（它已被装配层认识）',
    ).toBe(false)
  })
})
