// @vitest-environment node
/**
 * **编码层判据（M5-4）**：`encodeGifFrames(frames, delaysCs)` 的字节级契约。
 *
 * 这一层是纯字节的（输入是 RGBA 数组、输出是 GIF89a 字节），因此**能**在 vitest 里真判：
 * 帧数、逐帧 delay、逻辑屏尺寸、每帧是否换了局部色表 —— 而不是只断言"调过编码器"。
 *
 * 真入口（浏览器 + 离屏渲染 + 真实下载）由 `e2e/export-scene-gif.spec.ts` 把守。
 */
import { describe, expect, it } from 'vitest'
import { encodeGifFrames, type RgbaFrame } from '@/workbench/animatedGifEncoder'

interface ParsedGif {
  readonly header: string
  readonly width: number
  readonly height: number
  /** 每个 image descriptor 前若带 Graphics Control Extension，则记它的 delay（厘秒）。 */
  readonly delaysCs: readonly number[]
  readonly imageCount: number
  readonly hasLocalPalette: readonly boolean[]
}

/** 测试侧 GIF 解析（**不** import 生产编码器：判据必须能看到原始字节）。 */
function parseGif(bytes: Uint8Array): ParsedGif {
  const ascii = (from: number, len: number): string =>
    String.fromCharCode(...bytes.subarray(from, from + len))
  const header = ascii(0, 6)
  const width = bytes[6]! | (bytes[7]! << 8)
  const height = bytes[8]! | (bytes[9]! << 8)
  const packed = bytes[10]!
  let p = 13
  if ((packed & 0x80) !== 0) p += 3 * (1 << ((packed & 0x07) + 1))

  const delaysCs: number[] = []
  const hasLocalPalette: boolean[] = []
  let imageCount = 0
  let pendingDelay: number | null = null

  while (p < bytes.length) {
    const b = bytes[p]!
    if (b === 0x3b) break // trailer
    if (b === 0x21) {
      const label = bytes[p + 1]!
      p += 2
      if (label === 0xf9) {
        // Graphics Control Extension: size | flags | delay LE u16 | transparent idx | 0
        const delay = bytes[p + 2]! | (bytes[p + 3]! << 8)
        pendingDelay = delay
      }
      // 跳过所有子块
      while (bytes[p] !== 0) p += bytes[p]! + 1
      p += 1
      continue
    }
    if (b === 0x2c) {
      imageCount += 1
      const localPacked = bytes[p + 9]!
      hasLocalPalette.push((localPacked & 0x80) !== 0)
      delaysCs.push(pendingDelay ?? 0)
      pendingDelay = null
      p += 10
      if ((localPacked & 0x80) !== 0) p += 3 * (1 << ((localPacked & 0x07) + 1))
      p += 1 // LZW min code size
      while (bytes[p] !== 0) p += bytes[p]! + 1
      p += 1
      continue
    }
    throw new Error(`parseGif: 未知块 0x${b.toString(16)} @${p}`)
  }

  return { header, width, height, delaysCs, imageCount, hasLocalPalette }
}

/** 纯色帧（全不透明）。 */
function solid(width: number, height: number, rgb: readonly [number, number, number]): RgbaFrame {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0]
    data[i * 4 + 1] = rgb[1]
    data[i * 4 + 2] = rgb[2]
    data[i * 4 + 3] = 255
  }
  return { data, width, height }
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

describe('encodeGifFrames · 字节结构', () => {
  it('两帧 [5,10] ⇒ GIF89a、2 个 image descriptor、逐帧 delay 就是入参', async () => {
    const frames = [solid(4, 4, [255, 0, 0]), solid(4, 4, [0, 0, 255])]
    const blob = await encodeGifFrames(frames, [5, 10], { palette: 'frame' })
    expect(blob.type).toBe('image/gif')
    const bytes = await bytesOf(blob)
    const gif = parseGif(bytes)
    expect(gif.header).toBe('GIF89a')
    expect(gif.width).toBe(4)
    expect(gif.height).toBe(4)
    expect(gif.imageCount).toBe(2)
    expect(gif.delaysCs).toEqual([5, 10])
    // 'frame' 模式：每帧自带局部色表（否则第二帧会用第一帧的颜色）。
    expect(gif.hasLocalPalette).toEqual([true, true])
  })

  it('全局调色板模式（材质卡旧观感）：不写局部色表，但逐帧 delay 仍然各自生效', async () => {
    const frames = [solid(4, 4, [255, 0, 0]), solid(4, 4, [0, 0, 255])]
    const gif = parseGif(await bytesOf(await encodeGifFrames(frames, [3, 7], { palette: 'global' })))
    expect(gif.hasLocalPalette).toEqual([false, false])
    expect(gif.delaysCs).toEqual([3, 7])
  })

  it('flipY 只翻一次：翻转后的首行等于原帧的末行', async () => {
    // 4×2 帧：上两行红、下两行蓝。flipY ⇒ 上两行变蓝。
    const width = 2
    const height = 4
    const data = new Uint8Array(width * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        const blueRow = y >= 2
        data[i] = blueRow ? 0 : 255
        data[i + 1] = 0
        data[i + 2] = blueRow ? 255 : 0
        data[i + 3] = 255
      }
    }
    const flipped = await encodeGifFrames([{ data, width, height }], [5], { palette: 'frame', flipY: true })
    const direct = await encodeGifFrames([{ data, width, height }], [5], { palette: 'frame' })
    const a = await bytesOf(flipped)
    const b = await bytesOf(direct)
    // 翻与不翻必须是**不同**的字节（翻转真的发生了），且两者都仍是合法 GIF。
    expect(parseGif(a).imageCount).toBe(1)
    expect(parseGif(b).imageCount).toBe(1)
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false)
  })
})

describe('encodeGifFrames · 调用方 bug 必须显式拒绝', () => {
  it('时延数与帧数不一致 ⇒ throw', async () => {
    const frames = [solid(2, 2, [1, 2, 3]), solid(2, 2, [4, 5, 6])]
    await expect(encodeGifFrames(frames, [5])).rejects.toThrow()
    await expect(encodeGifFrames(frames, [5, 5, 5])).rejects.toThrow()
  })

  it('时延为 0 / 负数 / 小数 ⇒ throw（GIF 的时延是整数厘秒，夹取会静默改时长）', async () => {
    const frames = [solid(2, 2, [1, 2, 3])]
    for (const bad of [0, -1, 1.5]) {
      await expect(encodeGifFrames(frames, [bad]), `时延 ${bad} 必须被拒绝`).rejects.toThrow()
    }
  })

  it('空帧表 ⇒ throw（不产出 0 帧假 GIF）', async () => {
    await expect(encodeGifFrames([], [])).rejects.toThrow()
  })
})
