/**
 * **面板 B 块的数据面**：捕获明细只读、逐字段搬运、**不进 digest**。
 *
 * 本文件判三件事（每条都对着设计 §10.4 的一句）：
 *  1. 只收 `map` 在场的绑定（无贴图材质不是"缺资源"）；
 *  2. 采样五字段与序列（帧数 + 逐帧毫秒）**逐字段**搬运，不做二次解释；
 *  3. 明细不出现在清单的 canonical/digest 里 —— 塞进 `ExportAssetNeed` 会改契约。
 */
import { describe, expect, it } from 'vitest'
import { assetManifestCanonicalText, assetManifestDigest, captureFactsOfBindings } from '@/application/exportPlan'
import type { ExportAssetNeed } from '@/domain/captureSpec'
import type { TextureBinding } from '@/presentation/textureBinding'

function binding(overrides: Partial<TextureBinding> = {}): TextureBinding {
  const base: TextureBinding = {
    materialId: 'material:0',
    materialVersion: 'mat-v1',
    map: { id: 'material:0', version: 'tex-v1' },
    sampling: { filter: 'nearest', wrap: 'clamp', flipY: false, mipmaps: false, anisotropy: 0 },
    missingRequired: false,
  }
  return Object.freeze({ ...base, ...overrides })
}

describe('面板 B 块：ExportCaptureFacts 只读明细', () => {
  it('逐字段搬运材质/纹理身份、采样与序列（毫秒来自有理秒，不自算帧数）', () => {
    const facts = captureFactsOfBindings([
      binding({
        animation: {
          stripFrameCount: 2,
          sequence: {
            id: 'material:0',
            resource: { assetId: 'material:0', contentVersion: 'tex-v1', url: '' },
            frames: [
              { index: 0, duration: { num: 1, den: 20 } },
              { index: 1, duration: { num: 2, den: 20 } },
            ],
            loop: 'loop',
          },
        },
        sampling: { filter: 'linear', wrap: 'repeat', flipY: true, mipmaps: true, anisotropy: 4 },
      }),
    ])
    expect(facts.textures).toEqual([
      {
        materialId: 'material:0',
        materialVersion: 'mat-v1',
        textureId: 'material:0',
        textureVersion: 'tex-v1',
        sampling: { filter: 'linear', wrap: 'repeat', flipY: true, mipmaps: true, anisotropy: 4 },
        sequence: { frameCount: 2, durationsMs: [50, 100] },
      },
    ])
  })

  it('静态贴图 ⇒ sequence 为 null（缺席就是缺席，不写 0 帧）', () => {
    const facts = captureFactsOfBindings([binding()])
    expect(facts.textures[0]!.sequence).toBeNull()
  })

  it('无贴图绑定被**跳过**（不是"缺一张图"，也不是空行）', () => {
    const facts = captureFactsOfBindings([
      binding({ map: undefined, materialId: 'material:1' }),
      binding({ materialId: 'material:2', map: { id: 'material:2', version: 'tex-v2' } }),
    ])
    expect(facts.textures.map((t) => t.materialId)).toEqual(['material:2'])
  })

  it('**digest 边界**：明细里出现采样/序列，但清单 canonical/digest 仍只由四个字段决定', () => {
    const assets: readonly ExportAssetNeed[] = Object.freeze([
      { assetId: 'material:0', contentVersion: 'tex-v1', required: true, locator: '' },
    ])
    const before = { canonical: assetManifestCanonicalText(assets), digest: assetManifestDigest(assets) }
    const facts = captureFactsOfBindings([
      binding({
        sampling: { filter: 'linear', wrap: 'repeat', flipY: true, mipmaps: true, anisotropy: 8 },
        animation: {
          stripFrameCount: 4,
          sequence: {
            id: 'material:0',
            resource: { assetId: 'material:0', contentVersion: 'tex-v1', url: '' },
            frames: [{ index: 0, duration: { num: 1, den: 20 } }],
            loop: 'loop',
          },
        },
      }),
    ])
    // 明细确实带了新事实……
    expect(facts.textures[0]!.sampling.anisotropy).toBe(8)
    expect(facts.textures[0]!.sequence!.frameCount).toBe(1)
    // ……而清单口径一字不变（B 块不参与身份）。
    expect(assetManifestCanonicalText(assets)).toBe(before.canonical)
    expect(assetManifestDigest(assets)).toBe(before.digest)
    expect(before.canonical).not.toContain('anisotropy')
    expect(before.canonical).not.toContain('frames')
  })
})
