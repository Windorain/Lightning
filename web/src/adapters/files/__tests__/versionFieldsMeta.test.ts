/**
 * 两条版本事实在 Envelope 里的**位置**判据（web 侧）。
 *
 * 场景文件契约里 `gtnhVersion` 是 **GTNH 整合包版本**、`gtVersion` 是 **GregTech 版本**（两条独立事实，
 * 互不冒充）。它们都是**元数据**：写在 `meta`，而不是 payload 根。
 *
 * 这个文件锁的是本适配器的键集与位置：
 * - `ENVELOPE_META_KEYS`（本模块与 `pure/envelopeMetaKeys.ts` 两份）都必须含这两个键；
 * - 用 `encodeEnvelope` 重新打包时，两者都进 `meta`、并从 payload 根上剔除；
 * - 解包后 `plain` 视图（meta 权威）仍能读到两者，且**不会互相顶替**。
 */
import { describe, expect, it } from 'vitest'

import { ENVELOPE_META_KEYS as ADAPTER_META_KEYS, decodeEnvelope, encodeEnvelope } from '@/adapters/files/envelopeCodec'
import { ENVELOPE_META_KEYS as PURE_META_KEYS } from '@/pure/envelopeMetaKeys'

const PACK_VERSION = '2.8.142'
const GT_VERSION = '5.09.54.194'

function plainDoc(packVersion: string): Record<string, unknown> {
  return {
    id: 's',
    label: 's',
    author: 'tester',
    gtnhVersion: packVersion,
    gtVersion: GT_VERSION,
    description: null,
    frames: [{ index: 0, structure: { geometryPhase: 'baked', cellGrid: [[[0]]], blockPalette: [] } }],
  }
}

describe('版本事实：gtnhVersion（整合包）与 gtVersion（GregTech）都进 meta', () => {
  it('两份 meta 键集都含这两个键（否则一半的文件会把 GT 版本写进 payload 根）', () => {
    for (const keys of [ADAPTER_META_KEYS, PURE_META_KEYS]) {
      expect(keys).toContain('gtnhVersion')
      expect(keys).toContain('gtVersion')
    }
  })

  it('重新打包：两者都进 meta，且 payload 根上不再有它们', () => {
    // 不显式给 meta ⇒ 走「从 plain 里按 meta 键集提升」这条生产口径
    const packed = encodeEnvelope({ plain: plainDoc(PACK_VERSION) })
    expect(packed.ok).toBe(true)
    if (!packed.ok) return

    const back = decodeEnvelope(packed.value)
    expect(back.ok).toBe(true)
    if (!back.ok) return

    expect(back.value.meta.gtnhVersion, '整合包版本必须进 meta').toBe(PACK_VERSION)
    expect(back.value.meta.gtVersion, 'GT 版本必须进 meta').toBe(GT_VERSION)
    expect(back.value.inner.gtVersion, 'payload 根上不得留 gtVersion').toBeUndefined()
    expect(back.value.inner.gtnhVersion, 'payload 根上不得留 gtnhVersion').toBeUndefined()
    expect(back.value.plain.gtnhVersion).toBe(PACK_VERSION)
    expect(back.value.plain.gtVersion).toBe(GT_VERSION)
  })

  it('**负对照**：dreamcraft 缺席的文件里 gtnhVersion 是空串，GT 版本只出现在 gtVersion', () => {
    const packed = encodeEnvelope({ plain: plainDoc('') })
    expect(packed.ok).toBe(true)
    if (!packed.ok) return

    const back = decodeEnvelope(packed.value)
    expect(back.ok).toBe(true)
    if (!back.ok) return

    expect(back.value.meta.gtnhVersion, '整合包版本未知 ⇒ 空串，不得被 GT 版本顶替').toBe('')
    expect(back.value.meta.gtVersion).toBe(GT_VERSION)
    expect(back.value.meta.gtnhVersion).not.toBe(GT_VERSION)
  })
})
