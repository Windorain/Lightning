/**
 * #387 收尾批：`documentLooksPreviewable` 必须按池的**两种契约形态**读（修复 `viewerFromDocument.ts:20`）。
 *
 * ## 缺陷形态
 *
 * 修复前那一行是 `if (!Array.isArray(blobs) || blobs.length === 0) return false` —— 只认数组，
 * 于是帧为主文档的投影产物（`textureBlobs` 是槽位键对象 `{"0":"<b64>",…}`，按
 * `composition/kernelProjection.ts:1406-1408` 产出）在**查看器里被判"不可渲染"**，
 * 明明有贴图也提示不可预览。
 *
 * ## 判据与负对照
 *
 * 正判据走**生产函数本体**（`documentLooksPreviewable`），负对照把修复前那一行写成
 * `oldLooksPreviewable`（逐字：`!Array.isArray(blobs) || blobs.length === 0`），
 * 断言同一输入在两者下**读数不同** —— 若哪天有人把实现改回"只认数组"，本文件当场判红。
 */
import { describe, expect, it } from 'vitest'

import { documentLooksPreviewable } from '@/viewer/viewerFromDocument'

/** `geometryPhase:'baked'` 的终态结构（`isBakedStructureData` 的判定面 = 这一个字段）。 */
const BAKED = { geometryPhase: 'baked', cellGrid: [[[0]]], blockPalette: [{}] }

/** **修复前**的池存在性判定（`viewerFromDocument.ts:21` 那一行的逐字副本）。 */
function oldPoolPresent(blobs: unknown): boolean {
  return Array.isArray(blobs) && blobs.length > 0
}

describe('#387 形态：`documentLooksPreviewable` 认两种池形态', () => {
  it('正：槽位键对象形态（帧为主投影）+ baked 终态 ⇒ **可预览**（修复前判不可预览）', () => {
    const doc = { ...BAKED, textureBlobs: { '0': 'AAAA' } }
    expect(documentLooksPreviewable(doc), '对象形态是合法契约形态 ⇒ 不得判不可预览').toBe(true)
  })

  it('正（回归）：数组形态、v2 早退分支、空池/非池值的口径**不变**', () => {
    expect(documentLooksPreviewable({ ...BAKED, textureBlobs: ['AAAA'] }), '数组非空 ⇒ 可预览').toBe(true)
    expect(documentLooksPreviewable({ ...BAKED, textureBlobs: [] }), '空数组 ⇒ 不可预览（真拒绝保留）').toBe(false)
    expect(documentLooksPreviewable({ ...BAKED, textureBlobs: {} }), '空对象 ⇒ 不可预览（真拒绝保留）').toBe(false)
    expect(documentLooksPreviewable(BAKED), '池缺席 ⇒ 不可预览').toBe(false)
    expect(documentLooksPreviewable({ ...BAKED, textureBlobs: { stone: 'AAAA' } }), '非池值（键不是数值下标）⇒ 与修复前同口径不可预览').toBe(false)
    // v2 文档在池判定**之前**早退（与池形态无关），修复不得改变它：
    expect(documentLooksPreviewable({ format_version: '2.0', frames: [] })).toBe(true)
  })

  it('**负对照（能红）**：修复前的 `!Array.isArray(…)` ⇒ 对象形态被判不可预览', () => {
    const objectShape = { ...BAKED, textureBlobs: { '0': 'AAAA' } }
    expect(oldPoolPresent(objectShape.textureBlobs), '旧实现：对象形态 ⇒ false（有贴图却被判不可预览）').toBe(false)
    // 差异**只在对象形态**：数组形态上旧实现是对的（所以"只认数组"才隐蔽）。
    expect(oldPoolPresent(['AAAA']), '旧实现在数组形态上是对的').toBe(true)
    // 同一断言在旧实现下必红：
    expect(documentLooksPreviewable(objectShape)).toBe(true)
    expect(oldPoolPresent(objectShape.textureBlobs)).not.toBe(documentLooksPreviewable(objectShape))
  })
})
