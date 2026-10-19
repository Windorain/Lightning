/**
 * `adapters/textureDecode` 的**共享画布**复用判据：同尺寸的下一张纹理不得继承上一张的像素。
 *
 * ## 为什么这条必须存在（2026-10-19 验收实测）
 *
 * `readRgba` 为省一次分配而复用模块级的 `OffscreenCanvas`（#399）。但 `drawImage` 是
 * **source-over 合成**：只要下一张**同尺寸**（不触发 resize ⇒ 不清空），新图的透明像素就会
 * 原样透出上一张的颜色，alpha 也被顶成上一张的值。
 *
 * 在真入口上的表现：导出件的玻璃贴图中心本来是 `(0,0,0,0)`，Web 解出来却成了
 * **前一张羊毛纹理**的颜色、alpha 255 ⇒ 玻璃永远画不透明（E2E `glass-transparent` 记 blocked）。
 *
 * ## 这个替身为什么不是"测替身"
 *
 * 被测的是**画布语义**：`drawImage` 的 source-over 合成是 2D 画布的公开约定，本文件按该约定
 * 实现位图缓冲（`clearRect` / `drawImage` / `getImageData` 三个原语 + resize 清空）。
 * 修复前本文件必红（见用例注释里的实际读数），修复后必绿 —— 判别力来自"画布会不会残留"，
 * 不来自任何源码文本断言。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDomTextureDecoder } from '@/adapters/textureDecode'

/** 一个可预期的"位图"：解码器只读 width/height，画布替身读 pixels。 */
interface FakeBitmap {
  readonly width: number
  readonly height: number
  readonly pixels: Uint8Array
  close: () => void
}

/** 整幅 RGBA 缓冲 + 三个画布原语（source-over 按规范的非预乘口径实现）。 */
class FakeCanvas {
  private buffer: Uint8Array
  private w: number
  private h: number

  constructor(w: number, h: number) {
    this.w = w
    this.h = h
    this.buffer = new Uint8Array(w * h * 4)
  }

  get width(): number {
    return this.w
  }

  /** resize 会清空内容（真画布语义；正是"同尺寸不清空"才暴露缺陷）。 */
  set width(v: number) {
    this.w = v
    this.buffer = new Uint8Array(this.w * this.h * 4)
  }

  get height(): number {
    return this.h
  }

  set height(v: number) {
    this.h = v
    this.buffer = new Uint8Array(this.w * this.h * 4)
  }

  getContext(kind: string): unknown {
    return kind === '2d' ? this.ctx() : null
  }

  /** 每次取都新建一个闭包（真画布每次 getContext 返回同一个对象，但状态在这里只有 buffer）。 */
  private ctx(): unknown {
    const canvas = this
    return {
      clearRect(x: number, y: number, w: number, h: number): void {
        for (let yy = y; yy < y + h; yy++) {
          for (let xx = x; xx < x + w; xx++) {
            const i = (yy * canvas.w + xx) * 4
            canvas.buffer[i] = 0
            canvas.buffer[i + 1] = 0
            canvas.buffer[i + 2] = 0
            canvas.buffer[i + 3] = 0
          }
        }
      },
      drawImage(src: FakeBitmap): void {
        for (let i = 0; i < canvas.buffer.length; i += 4) {
          const sa = (src.pixels[i + 3] ?? 0) / 255
          const da = (canvas.buffer[i + 3] ?? 0) / 255
          const oa = sa + da * (1 - sa)
          if (oa === 0) {
            canvas.buffer[i] = 0
            canvas.buffer[i + 1] = 0
            canvas.buffer[i + 2] = 0
            canvas.buffer[i + 3] = 0
            continue
          }
          for (let c = 0; c < 3; c++) {
            const sc = src.pixels[i + c] ?? 0
            const dc = canvas.buffer[i + c] ?? 0
            canvas.buffer[i + c] = Math.round((sc * sa + dc * da * (1 - sa)) / oa)
          }
          canvas.buffer[i + 3] = Math.round(oa * 255)
        }
      },
      getImageData(x: number, y: number, w: number, h: number): { data: Uint8Array } {
        void x
        void y
        void w
        void h
        return { data: new Uint8Array(canvas.buffer) }
      },
    }
  }
}

function solid(w: number, h: number, rgba: readonly [number, number, number, number]): FakeBitmap {
  const pixels = new Uint8Array(w * h * 4)
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = rgba[0]
    pixels[i + 1] = rgba[1]
    pixels[i + 2] = rgba[2]
    pixels[i + 3] = rgba[3]
  }
  return { width: w, height: h, pixels, close: () => undefined }
}

/** 四边不透明、内部全透明（玻璃贴图的形态：中心 alpha=0）。 */
function frameWithHole(w: number, h: number): FakeBitmap {
  const pixels = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const border = x === 0 || y === 0 || x === w - 1 || y === h - 1
      pixels[i] = border ? 254 : 0
      pixels[i + 1] = border ? 254 : 0
      pixels[i + 2] = border ? 254 : 0
      pixels[i + 3] = border ? 255 : 0
    }
  }
  return { width: w, height: h, pixels, close: () => undefined }
}

/** 中心半透明（alpha=128）：用来区分"清空"与"把 alpha 抹成 0"。 */
function centerHalfAlpha(w: number, h: number): FakeBitmap {
  const bmp = solid(w, h, [10, 20, 30, 255])
  const pixels = new Uint8Array(bmp.pixels)
  const cx = Math.floor(w / 2)
  const cy = Math.floor(h / 2)
  const i = (cy * w + cx) * 4
  pixels[i + 3] = 128
  return { width: w, height: h, pixels, close: () => undefined }
}

/** 让下一次 `createImageBitmap` 交出给定位图。 */
function stubPlatform(bitmaps: readonly FakeBitmap[]): void {
  const queue = [...bitmaps]
  vi.stubGlobal('OffscreenCanvas', FakeCanvas)
  vi.stubGlobal('createImageBitmap', async () => {
    const next = queue.shift()
    if (next === undefined) throw new Error('createImageBitmap 多调用了一次')
    return next
  })
}

const CENTER_ALPHA = (8 * 16 + 8) * 4 + 3

describe('adapters/textureDecode · 共享画布不得跨纹理残留', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('同尺寸的第二张纹理：中心透明必须解成 alpha=0（修复前=255 且带上一张的颜色）', async () => {
    stubPlatform([solid(16, 16, [200, 30, 30, 255]), frameWithHole(16, 16)])
    const decode = createDomTextureDecoder()

    const first = await decode.decode('AAAA')
    const second = await decode.decode('AAAA')
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    if (second === null) return

    // 修复前实测：alpha=255、RGB=(200,30,30)（上一张的红），玻璃因此永远"不透明"。
    expect(second.rgba[CENTER_ALPHA]).toBe(0)
    expect([...second.rgba.slice(CENTER_ALPHA - 3, CENTER_ALPHA)]).toEqual([0, 0, 0])
    // 边框仍是有内容的（不是把整张清零了）。
    expect(second.rgba[3]).toBe(255)
    expect(second.rgba[0]).toBe(254)
  })

  it('半透明中心不被"清空"误伤（alpha=128 原样保留，不与上一张合成）', async () => {
    stubPlatform([solid(16, 16, [200, 30, 30, 255]), centerHalfAlpha(16, 16)])
    const decode = createDomTextureDecoder()
    await decode.decode('AAAA')
    const second = await decode.decode('AAAA')
    expect(second).not.toBeNull()
    if (second === null) return
    expect(second.rgba[CENTER_ALPHA]).toBe(128)
    expect([...second.rgba.slice(CENTER_ALPHA - 3, CENTER_ALPHA)]).toEqual([10, 20, 30])
  })

  it('换尺寸（触发 resize）时行为不变：中心仍为 0', async () => {
    stubPlatform([solid(32, 32, [200, 30, 30, 255]), frameWithHole(16, 16)])
    const decode = createDomTextureDecoder()
    await decode.decode('AAAA')
    const second = await decode.decode('AAAA')
    expect(second).not.toBeNull()
    if (second === null) return
    expect(second.rgba.length).toBe(16 * 16 * 4)
    expect(second.rgba[CENTER_ALPHA]).toBe(0)
  })
})
