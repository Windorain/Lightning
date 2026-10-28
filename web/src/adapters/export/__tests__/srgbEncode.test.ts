/**
 * **修复环判据**：线性读回 → sRGB 编码（`adapters/export/srgbEncode`）。
 *
 * ## 为什么这条判据必须存在
 *
 * 它是色彩回归的**唯一**算法落点：three 渲染到 render target 时输出恒为线性，
 * 而 PNG/GIF 是 sRGB 编码 ⇒ 少了这一跳，产物整体偏暗约 2×（实测 -60% 亮度）。
 * 行为面由 `e2e/export-color-parity.spec.ts` 把守（导出 vs 视口）；本文件钉**值与边界**。
 *
 * | 判据 | 断言 |
 * |---|---|
 * | 传递函数 | 与 sRGB 标准公式逐点一致（端点/分段点/中调） |
 * | 往返 | `srgbToLinear(linearToSrgb(x)) ≈ x`（表不是凭空写的） |
 * | 单调 | 表严格不减（不会把亮部压成暗部） |
 * | **只动 RGB** | alpha 逐字节不变（覆盖度不是颜色） |
 * | **噪声地板可分辨** | 中调（0..255 全域）的最大相邻跳变 ≥ 1（表不是恒等） |
 * | 负对照 | **恒等映射**（= 修复前的行为）在同一判定下必须判红 |
 */
import { describe, expect, it } from 'vitest'
import {
  encodeLinearRgbaToSrgb,
  linearByteToSrgbByte,
  linearToSrgb,
  srgbEncodeTable,
  srgbToLinear,
} from '@/adapters/export/srgbEncode'

describe('srgbEncode · 传递函数', () => {
  it('与 sRGB 标准公式逐点一致（端点 + 分段点 + 中调）', () => {
    expect(linearToSrgb(0)).toBe(0)
    expect(linearToSrgb(1)).toBeCloseTo(1, 12)
    // 分段点两侧连续（0.0031308 是标准断点）
    expect(linearToSrgb(0.0031308)).toBeCloseTo(0.04045, 4)
    // 已知点：线性 0.5 → sRGB 0.7354
    expect(linearToSrgb(0.5)).toBeCloseTo(0.7354, 4)
    // 线性 0.5647（= sRGB 198 的解码值）→ 回到 198/255
    expect(linearToSrgb(0.5647) * 255).toBeCloseTo(198, 0)
  })

  it('往返：srgbToLinear(linearToSrgb(x)) ≈ x（表不是凭空写的）', () => {
    for (const x of [0, 0.001, 0.01, 0.05, 0.2, 0.5, 0.8, 0.99, 1]) {
      expect(srgbToLinear(linearToSrgb(x))).toBeCloseTo(x, 6)
    }
  })

  it('表**严格不减**（不会把亮部压成暗部）', () => {
    const table = srgbEncodeTable()
    expect(table.length).toBe(256)
    for (let i = 1; i < 256; i += 1) {
      expect(table[i]!, `表在下标 ${i} 回退（${table[i - 1]} → ${table[i]}）`).toBeGreaterThanOrEqual(table[i - 1]!)
    }
    expect(table[0]).toBe(0)
    expect(table[255]).toBe(255)
  })

  it('**不是恒等映射**：中调必须有实质抬升（否则这条修复等于没做）', () => {
    // 实测三通道：线性 144/24/13 → sRGB 196/86/64（贴图源色 198/86/64）
    expect(linearByteToSrgbByte(144)).toBeGreaterThanOrEqual(194)
    expect(linearByteToSrgbByte(144)).toBeLessThanOrEqual(198)
    expect(linearByteToSrgbByte(24)).toBeGreaterThanOrEqual(84)
    expect(linearByteToSrgbByte(24)).toBeLessThanOrEqual(88)
    expect(linearByteToSrgbByte(13)).toBeGreaterThanOrEqual(62)
    expect(linearByteToSrgbByte(13)).toBeLessThanOrEqual(66)
    const table = srgbEncodeTable()
    let changed = 0
    for (let i = 1; i < 255; i += 1) if (table[i] !== i) changed += 1
    expect(changed, '绝大多数非端点值都必须被改动').toBeGreaterThan(200)
  })
})

describe('srgbEncode · 缓冲编码', () => {
  it('只动 RGB：alpha 逐字节不变（覆盖度不是颜色）', () => {
    const px = new Uint8Array([144, 24, 13, 255, 144, 24, 13, 0, 144, 24, 13, 128])
    encodeLinearRgbaToSrgb(px)
    expect([px[3], px[7], px[11]], 'alpha 必须逐字节保持').toEqual([255, 0, 128])
    expect(px[0]).toBe(linearByteToSrgbByte(144))
    expect(px[1]).toBe(linearByteToSrgbByte(24))
    expect(px[2]).toBe(linearByteToSrgbByte(13))
    // 反空洞真：RGB 确实被改了（否则上一条的"alpha 不变"是空转）
    expect(px[0], 'RGB 必须被抬升').toBeGreaterThan(144)
  })

  it('就地改写并返回同一缓冲（调用方紧接着交给编码器）', () => {
    const px = new Uint8Array([10, 20, 30, 255])
    const out = encodeLinearRgbaToSrgb(px)
    expect(out).toBe(px)
    expect([...out]).toEqual([linearByteToSrgbByte(10), linearByteToSrgbByte(20), linearByteToSrgbByte(30), 255])
  })

  it('长度不是 4 的倍数 ⇒ 显式抛（不静默跳过）', () => {
    expect(() => encodeLinearRgbaToSrgb(new Uint8Array(7))).toThrow()
    expect(() => encodeLinearRgbaToSrgb(new Uint8Array(0))).not.toThrow()
  })

  it('**负对照**：恒等映射（= 修复前的行为）会被同一判定抓红', () => {
    // 逐字复刻修复前的读回：线性值原样进编码器。
    const identity = (v: number): number => v
    const before = [144, 24, 13]
    const after = before.map(linearByteToSrgbByte)
    // 判定式：编码后的主色必须回到贴图源色（198/86/64）附近。
    const target = [198, 86, 64]
    const err = (xs: readonly number[]): number => Math.max(...xs.map((x, i) => Math.abs(x - target[i]!)))
    expect(err(after), '修复后的误差必须在容差内').toBeLessThanOrEqual(6)
    expect(err(before.map(identity)), '修复前（恒等）的误差必须远超容差').toBeGreaterThan(50)
  })
})
