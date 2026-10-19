/**
 * M8-4 · 恢复副本**存储表示编解码**的判据（adapters/recoveryStore）。
 *
 * 三件事必须成立，否则 S5/S6 会以"看起来对"的方式失败：
 * 1. 往返无损（内容不变；压缩只改存储表示）；
 * 2. 压缩是**确定性**的（同一 JSON 两次编码逐字相同）——
 *    保留策略的"内容未变不重复写"依赖它；
 * 3. 非本编码的值**原样**返回（注入的损坏副本必须仍由 validate 判坏，
 *    不得被"解不开"吞成另一类沉默）。
 */
import { describe, expect, it } from 'vitest'

import {
  RECOVERY_VALUE_PREFIX,
  decodeRecoveryValue,
  encodeRecoveryValue,
} from '@/adapters/recoveryStore'

const JSON_TEXT = JSON.stringify({
  artifact: 'recovery-copy',
  schemaVersion: 1,
  scene: { id: 's', objects: { a: { type: 'block', dataId: 'd' } }, data: {}, collections: {}, order: ['a'] },
  animation: { tracks: [], publishedDefaults: {} },
  content: { metadata: { name: '夹具' }, frameAxis: { frames: [] }, resources: [] },
  writtenAt: 1,
})

describe('M8-4 恢复副本存储表示（压缩 + base64）', () => {
  it('往返无损：解码得到的 JSON 与原文逐字相同', () => {
    expect(decodeRecoveryValue(encodeRecoveryValue(JSON_TEXT))).toBe(JSON_TEXT)
  })

  it('编码带前缀且确定（同一输入两次编码逐字相同）', () => {
    const a = encodeRecoveryValue(JSON_TEXT)
    const b = encodeRecoveryValue(JSON_TEXT)
    expect(a.startsWith(RECOVERY_VALUE_PREFIX)).toBe(true)
    expect(a).toBe(b)
    // 压缩**真的**发生（否则配额问题根本没解决）：恢复副本载荷是重复度很高的
    // 场景数据（真实夹具 11 208 046 字符 → 979 532 字符）。这里用重复样本证同一性质
    // ——小对象不值得压（base64 有 4/3 膨胀），故不能用 JSON_TEXT 断言。
    const bulky = JSON.stringify({
      scene: { order: Array.from({ length: 400 }, (_, i) => ({ id: 'obj-' + (i % 7), type: 'block', dataId: 'data-' + (i % 7) })) },
    })
    expect(encodeRecoveryValue(bulky).length).toBeLessThan(bulky.length)
  })

  it('非本编码原样返回：注入的损坏副本仍交给 validate 判坏', () => {
    expect(decodeRecoveryValue('{"not":"json"')).toBe('{"not":"json"')
    expect(decodeRecoveryValue('garbage@@@')).toBe('garbage@@@')
  })

  it('前缀在但解不开 ⇒ 原样返回（不静默变成空串）', () => {
    const broken = RECOVERY_VALUE_PREFIX + 'not-base64!!'
    expect(decodeRecoveryValue(broken)).toBe(broken)
  })
})
