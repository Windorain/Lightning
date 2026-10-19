/**
 * `adapters/export/gifEncoder` —— **GIF89a 字节核心**（M6-2 从 `workbench/animatedGifEncoder` 抽出）。
 *
 * ## 为什么抽到这里
 *
 * 1. **契约**：编码端口的契约是 `Promise<Result<Uint8Array>>`（`application/exportPlan`），
 *    而旧实现返回 `Blob` —— 端口的返回值不该由 DOM 类型定义；
 * 2. **依赖方向**：旧模块在 `workbench/`（旧层），`adapters/export` **不得**反向依赖它
 *    （`tests/architecture/export-purity.test.ts` 的同族纪律）；
 * 3. **单一实现**：帧 → 调色板 → 索引 → GifWriter 的循环只有一份，组合端口的 GIF part 调它；
 *    旧路径的 `encodeGifFrames` 退化为薄委派，随旧链一起退役（M6-3）。
 *
 * ## 时延是**入参**，不是本模块算出来的
 *
 * 逐帧时延由 `domain/materials#delayCsOf`（ms→厘秒的唯一换算点）给出；本模块只负责
 * 把它写进 Graphics Control Extension。**没有**第二个"按帧率自算"的地方。
 *
 * ## 纯度
 *
 * 无 DOM、无 Three、不读时钟：像素进、字节出。取消是**活视图**入参（帧循环之间检查）。
 */

import { GifWriter } from 'omggif'
import { err, ok, unsupportedOperation, type Result } from '@/domain/errors'

/** 已解码的一帧（RGBA，行序由 {@link GifEncodeOptions.flipY} 声明）。 */
export interface GifFrame {
  readonly pixels: Uint8Array
  readonly width: number
  readonly height: number
}

export interface GifEncodeOptions {
  /** `'global'` = 全片共用一张 ≤256 色调色板（旧观感）；`'frame'` = 每帧局部调色板（渲染帧用）。 */
  readonly palette: 'frame' | 'global'
  /** 输入行序是 WebGL 读回（原点左下）时为 true（与 pngEncoder 的 flipY 同口径）—— **只翻一次**。 */
  readonly flipY: boolean
  /** 循环次数（`0` = 无限）。 */
  readonly loopCount: number
  /** 取消信号（活视图；在帧循环之间检查 ⇒ 取消即**零字节**）。 */
  readonly signal?: { readonly cancelled: boolean }
}

const ALPHA_THRESHOLD = 128

function packColor(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b
}

interface PaletteResult {
  /** Packed 24-bit colours, length = power of 2 (min 2, max 256). */
  colors: number[]
  /** Index of the transparent colour, or null if no transparency. */
  transparentIdx: number | null
}

/**
 * Build a palette from opaque pixels only.
 * If transparent pixels exist, index 0 is reserved for them.
 * Unique opaque colours capped at 255 (indexes 1..255), leaving index 0 free.
 */
function buildPalette(frames: readonly GifFrame[]): PaletteResult {
  const freq = new Map<number, number>()
  let hasTransparent = false

  for (const frame of frames) {
    const d = frame.pixels
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3]! < ALPHA_THRESHOLD) {
        hasTransparent = true
        continue
      }
      const packed = packColor(d[i]!, d[i + 1]!, d[i + 2]!)
      freq.set(packed, (freq.get(packed) ?? 0) + 1)
    }
  }

  const maxOpaque = hasTransparent ? 255 : 256
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1])
  const top = sorted.slice(0, maxOpaque)
  const palette: number[] = []

  if (hasTransparent) palette.push(0) // index 0 = transparent

  for (const [color] of top) palette.push(color)

  // Pad to power of 2
  let size = 2
  while (size < palette.length) size *= 2
  while (palette.length < size) palette.push(0)

  return { colors: palette, transparentIdx: hasTransparent ? 0 : null }
}

function frameToIndices(frame: GifFrame, palette: number[], transparentIdx: number | null): Uint8Array {
  const colorToIndex = new Map<number, number>()
  for (let i = 0; i < palette.length; i++) {
    colorToIndex.set(palette[i]!, i)
  }

  const pixels = new Uint8Array(frame.width * frame.height)
  const d = frame.pixels
  for (let i = 0; i < pixels.length; i++) {
    const off = i * 4
    if (d[off + 3]! < ALPHA_THRESHOLD && transparentIdx !== null) {
      pixels[i] = transparentIdx
    } else {
      const packed = packColor(d[off]!, d[off + 1]!, d[off + 2]!)
      pixels[i] = colorToIndex.get(packed) ?? (transparentIdx ?? 0)
    }
  }
  return pixels
}

/** 垂直翻转（把 WebGL 的左下原点行序变成 GIF 的上左原点）。**只翻一次**。 */
function flipRows(frame: GifFrame): GifFrame {
  const { width, height } = frame
  const stride = width * 4
  const out = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * stride
    out.set(frame.pixels.subarray(src, src + stride), y * stride)
  }
  return { pixels: out, width, height }
}

function fail(reason: string, detail: Record<string, string | number> = {}): Result<Uint8Array> {
  return err(unsupportedOperation({ reason, ...detail }))
}

/**
 * 把已解码的 RGBA 帧编码成 GIF89a **字节**。
 *
 * 失败一律是 `Result` 的失败侧（结构化），**不抛**：调用方（组合端口）据此产出
 * `ExportEncodeFailed` 诊断，而不是"某天某个 await 抛了"。
 * 帧数/时延数不一致、帧尺寸不一致、缓冲不足都**显式失败**（不补齐、不截断）。
 */
export function encodeGifBytes(
  frames: readonly GifFrame[],
  delayCs: readonly number[],
  options: GifEncodeOptions,
): Result<Uint8Array> {
  if (frames.length === 0) return fail('gifNoFrames')
  if (delayCs.length !== frames.length) {
    return fail('gifDelayCountMismatch', { frames: frames.length, delays: delayCs.length })
  }
  for (let i = 0; i < delayCs.length; i++) {
    const d = delayCs[i]!
    if (!Number.isInteger(d) || d < 1) return fail('gifDelayInvalid', { index: i, delayCs: d })
  }
  if (!Number.isInteger(options.loopCount) || options.loopCount < 0) {
    return fail('gifLoopCountInvalid', { loopCount: options.loopCount })
  }

  const width = frames[0]!.width
  const height = frames[0]!.height
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return fail('gifFrameSizeInvalid', { width, height })
  }
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!
    if (f.width !== width || f.height !== height) {
      return fail('gifFrameSizeMismatch', { index: i, width: f.width, height: f.height, expectedWidth: width, expectedHeight: height })
    }
    if (f.pixels.length !== width * height * 4) {
      return fail('gifPixelBufferSizeMismatch', { index: i, expected: width * height * 4, actual: f.pixels.length })
    }
    // 取消是**活视图**：长循环里每一帧都重读（取消 ⇒ 零字节，不产出半个 GIF）。
    if (options.signal?.cancelled === true) return fail('encoderCancelled', { framesEncoded: i })
  }

  const prepared = options.flipY ? frames.map(flipRows) : frames
  // 全局色表只在 'global' 模式写；'frame' 模式没有全局表（每帧自带局部表）。
  const global = options.palette === 'global' ? buildPalette(prepared) : null
  const bufSize = 1024 + prepared.length * (width * height + 1024)
  const buf = new Uint8Array(bufSize)
  const writer = new GifWriter(buf, width, height, global
    ? { loop: options.loopCount, palette: global.colors }
    : { loop: options.loopCount })

  for (let i = 0; i < prepared.length; i++) {
    if (options.signal?.cancelled === true) return fail('encoderCancelled', { framesEncoded: i })
    const frame = prepared[i]!
    const local = global ?? buildPalette([frame])
    const frameOpts: { delay: number; palette?: number[]; transparent?: number } = { delay: delayCs[i]! }
    if (global === null) frameOpts.palette = local.colors
    if (local.transparentIdx !== null) frameOpts.transparent = local.transparentIdx
    try {
      writer.addFrame(0, 0, width, height, frameToIndices(frame, local.colors, local.transparentIdx), frameOpts)
    } catch (e) {
      // 缓冲不足/内部不变量失败 ⇒ 端口边界翻译成结构化失败（不产出半个 GIF）。
      return fail('gifEncodeFailed', { detail: String(e), frameIndex: i })
    }
  }

  const end = writer.end()
  if (end <= 0 || end > bufSize) {
    return fail('gifEncodeBufferTooSmall', { end, bufSize })
  }
  return ok(buf.slice(0, end))
}
