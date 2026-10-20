/**
 * `domain/textureAlphaClass` 判据：**RGBA8 像素 → 三态 alpha 类别**。
 *
 * ## 为什么这条判据值钱
 *
 * 它决定"这张贴图能不能被当成二值 alpha 处理"—— 判错的方向不对称：
 * 把 `partial` 误判成 `binary` 会让材质走 cutout（alphaTest 0.5）⇒ **真半透明的像素被
 * 裁掉**、画面静默丢内容；反过来只是少一次优化（维持画家路径）。
 *
 * 故六组输入逐个钉住（全 255 / 只有 0 与 255 / 含 128 / 边界 1 与 254 / 空输入 /
 * 非 4 倍长度），并用**负对照**证明"三态真的互异"不是恒真。
 */
import { describe, expect, it } from 'vitest'
import { TEXTURE_ALPHA_CLASSES, textureAlphaClassOf, type Rgba8Pixels } from '@/domain/textureAlphaClass'

/** 由 alpha 列表造一张 1×N 的图（RGB 恒 0：本判据只读 alpha 通道）。 */
function pixelsOfAlpha(alphas: readonly number[]): Rgba8Pixels {
  const rgba = new Uint8Array(alphas.length * 4)
  alphas.forEach((a, i) => {
    rgba[i * 4 + 3] = a
  })
  return { width: alphas.length, height: 1, rgba }
}

describe('textureAlphaClassOf：alpha 三态', () => {
  it('全 255 ⇒ opaque（没有任何可裁掉的像素）', () => {
    expect(textureAlphaClassOf(pixelsOfAlpha([255, 255, 255, 255]))).toBe('opaque')
  })

  it('只有 0 与 255 且含 0 ⇒ binary（二值 alpha）', () => {
    expect(textureAlphaClassOf(pixelsOfAlpha([0, 255, 0, 255]))).toBe('binary')
    // 全 0 也是二值：这是 LP 接缝那两张"空图"的形态（α=0 ⇒ alphaTest 丢弃 ⇒ 不写深度）。
    expect(textureAlphaClassOf(pixelsOfAlpha([0, 0, 0]))).toBe('binary')
  })

  it('只有 0 与 255 但**没有** 0 ⇒ opaque（不是 binary：没有可裁像素）', () => {
    expect(textureAlphaClassOf(pixelsOfAlpha([255]))).toBe('opaque')
  })

  it('含 128 ⇒ partial（真半透明，绝不能降级成 cutout）', () => {
    expect(textureAlphaClassOf(pixelsOfAlpha([255, 128, 0, 255]))).toBe('partial')
  })

  it('边界：1 与 254 都是 partial（只有 0/255 才是二值）', () => {
    expect(textureAlphaClassOf(pixelsOfAlpha([255, 1]))).toBe('partial')
    expect(textureAlphaClassOf(pixelsOfAlpha([254, 255]))).toBe('partial')
  })

  it('RGB 通道不参与判定（只读 alpha）', () => {
    const rgba = new Uint8Array([12, 34, 56, 255, 78, 90, 123, 0])
    expect(textureAlphaClassOf({ width: 2, height: 1, rgba })).toBe('binary')
  })

  it('空输入 / 非法长度 ⇒ 保守 partial（不拿"读不懂"的数据改变画面）', () => {
    // 空图像：没有像素 ⇒ 不能下 opaque/binary 的结论。
    expect(textureAlphaClassOf({ width: 0, height: 0, rgba: new Uint8Array(0) })).toBe('partial')
    // 长度不是 width*height*4：读下去必然越界/错位。
    expect(textureAlphaClassOf({ width: 2, height: 2, rgba: new Uint8Array([255, 255, 255]) })).toBe('partial')
    // 多出来的字节同罪（不是"宽松接受"）。
    expect(
      textureAlphaClassOf({ width: 1, height: 1, rgba: new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255]) }),
    ).toBe('partial')
    // 非整数尺寸
    expect(textureAlphaClassOf({ width: 1.5, height: 1, rgba: new Uint8Array(4) })).toBe('partial')
    // null/undefined（还没解码）
    expect(textureAlphaClassOf(null)).toBe('partial')
    expect(textureAlphaClassOf(undefined)).toBe('partial')
  })

  it('**负对照**：三种类别互异（否则"partial 保留"那条是空洞真）', () => {
    const all = [
      textureAlphaClassOf(pixelsOfAlpha([255, 255])),
      textureAlphaClassOf(pixelsOfAlpha([0, 255])),
      textureAlphaClassOf(pixelsOfAlpha([255, 77])),
    ]
    expect(new Set(all).size, '三张不同形态的贴图必须落在三种不同类别上').toBe(3)
    expect(new Set(all)).toEqual(new Set(TEXTURE_ALPHA_CLASSES))
  })
})
