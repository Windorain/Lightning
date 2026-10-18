/**
 * Encode animated GIF89a with omggif.
 *
 * ## ⚠️ M6-2：编码核心**已抽到** `adapters/export/gifEncoder.ts`
 *
 * M6-2 把"帧 → 调色板 → 索引 → GifWriter"的循环抽成 `encodeGifBytes`（返回 `Result<Uint8Array>`），
 * 由 `adapters/export/gifEncoderPort.ts` 的动画端口调用。**这里是旧入口的暂留**：
 * 本文件仍在服役（材质卡 GIF 与场景 GIF 的旧链），随 seam `isometric-export-legacy-bake`
 * 一起删除（M6-3）。⇒ **不得**在此新增任何编码逻辑 —— 改就改 `adapters/export/gifEncoder`。
 *
 * ## 两个入口，一套编码核心（M5-4）
 *
 * | 入口 | 输入 | 调色板 |
 * |---|---|---|
 * | {@link encodeAnimatedGif} | **贴图竖条** data URL（材质卡「导出 GIF」） | 全局（全片共用一张，保持旧观感） |
 * | {@link encodeGifFrames} | 已解码的 RGBA 帧（场景 GIF：离屏逐帧渲染） | 每帧局部 |
 *
 * 两条路径共用同一份"帧 → 索引 → GifWriter"的实现，故"透明阈值/索引 0 保留/循环数"
 * 不会各自解释一遍。
 *
 * ## 逐帧时延是**入参**，不是本模块算出来的
 *
 * 旧实现只有一个 `delayCs` 标量，调用方（`operators/builtin/materialOperators`）
 * 用 `defaultFrametimeTicks * 5` **自算** —— 那既忽略了 `frameSequence[].timeTicks`，
 * 也让"GIF 的时长"与"画面实际播放的时长"成为两份可以分叉的事实。
 * 现在时延数组由 `domain/materials#planSequenceLoop` 的**同一份**计划给出，
 * 本模块只负责把它写进 Graphics Control Extension。
 *
 * ## 缓冲大小
 *
 * `'frame'` 调色板下每帧还要写 ≤768B 的局部色表，故按 `w*h + 1024` 预留；
 * 沿用旧式的 `w*h + 256` 会让 omggif 在局部色表上**越界写**（静默截断）。
 */
import { GifWriter } from 'omggif'

export interface EncodeAnimatedGifResult {
  blob: Blob
  frameCount: number
  frameSize: number
}

/** 已解码的一帧（RGBA，行序按 {@link EncodeGifOptions.flipY} 声明）。 */
export interface RgbaFrame {
  readonly data: Uint8ClampedArray | Uint8Array
  readonly width: number
  readonly height: number
}

export interface EncodeGifOptions {
  /** `'global'` = 全片共用一张 ≤256 色调色板（旧行为）；`'frame'` = 每帧局部调色板（渲染帧用）。 */
  readonly palette?: 'global' | 'frame'
  /** 输入行序是 WebGL 读回（原点左下）时为 true（与 `adapters/export/encoderPort` 的 pngEncoder 同口径）。 */
  readonly flipY?: boolean
  /** 循环次数（`0` = 无限循环，与旧实现一致）。 */
  readonly loop?: number
}

const ALPHA_THRESHOLD = 128

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load texture image'))
    img.src = dataUrl
  })
}

/**
 * 读竖条的帧数与单帧边长（**不切帧**）。
 *
 * 材质路径要先知道 `frameCount` 才能算逐帧时延（`resolveAnimationTimeline` 需要它），
 * 而切帧本身（canvas）比读尺寸贵得多 —— 故把"先问尺寸"独立成一个入口。
 */
export async function probeAnimatedStrip(dataUrl: string): Promise<{ frameCount: number; frameSize: number }> {
  const img = await loadImage(dataUrl)
  const frameSize = img.width
  const frameCount = Math.floor(img.height / frameSize)
  if (frameCount <= 1 || !Number.isFinite(frameCount)) {
    throw new Error(`Not an animated strip: ${img.width}x${img.height}`)
  }
  return { frameCount, frameSize }
}

async function extractFrames(dataUrl: string): Promise<{ frames: ImageData[]; frameSize: number }> {
  const img = await loadImage(dataUrl)
  const frameSize = img.width
  const frameCount = Math.floor(img.height / frameSize)
  if (frameCount <= 1 || !Number.isFinite(frameCount)) {
    throw new Error(`Not an animated strip: ${img.width}x${img.height}`)
  }

  const canvas = document.createElement('canvas')
  canvas.width = frameSize
  canvas.height = frameSize
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingEnabled = false

  const frames: ImageData[] = []
  for (let i = 0; i < frameCount; i++) {
    ctx.clearRect(0, 0, frameSize, frameSize)
    ctx.drawImage(img, 0, i * frameSize, frameSize, frameSize, 0, 0, frameSize, frameSize)
    frames.push(ctx.getImageData(0, 0, frameSize, frameSize))
  }
  return { frames, frameSize }
}

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
function buildPalette(frames: readonly RgbaFrame[]): PaletteResult {
  const freq = new Map<number, number>()
  let hasTransparent = false

  for (const frame of frames) {
    const d = frame.data
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

function frameToIndices(
  frame: RgbaFrame,
  palette: number[],
  transparentIdx: number | null,
): Uint8Array {
  const colorToIndex = new Map<number, number>()
  for (let i = 0; i < palette.length; i++) {
    colorToIndex.set(palette[i]!, i)
  }

  const pixels = new Uint8Array(frame.width * frame.height)
  const d = frame.data
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
function flipRows(frame: RgbaFrame): RgbaFrame {
  const { width, height } = frame
  const stride = width * 4
  const out = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * stride
    out.set(frame.data.subarray(src, src + stride), y * stride)
  }
  return { data: out, width, height }
}

function validateDelays(frames: readonly RgbaFrame[], delaysCs: readonly number[]): void {
  if (delaysCs.length !== frames.length) {
    throw new Error(`GIF 帧数与逐帧时延数不一致：${frames.length} 帧 vs ${delaysCs.length} 个时延`)
  }
  for (const d of delaysCs) {
    if (!Number.isInteger(d) || d < 1) {
      throw new Error(`GIF 逐帧时延必须是 >= 1 的整数厘秒，实得 ${String(d)}`)
    }
  }
}

/**
 * 把已解码的 RGBA 帧编码成 GIF89a。
 *
 * 帧数必须 == 时延数（调用方 bug ⇒ **抛**，不静默补齐/截断：那会让"帧数与时长"
 * 各自错一半却看起来成功）。
 */
export async function encodeGifFrames(
  frames: readonly RgbaFrame[],
  delaysCs: readonly number[],
  options?: EncodeGifOptions,
): Promise<Blob> {
  if (frames.length === 0) throw new Error('encodeGifFrames: 至少需要 1 帧')
  validateDelays(frames, delaysCs)

  const width = frames[0]!.width
  const height = frames[0]!.height
  for (const f of frames) {
    if (f.width !== width || f.height !== height) {
      throw new Error(`encodeGifFrames: 帧尺寸不一致 ${f.width}x${f.height} vs ${width}x${height}`)
    }
  }

  const prepared = options?.flipY === true ? frames.map(flipRows) : frames
  const mode = options?.palette ?? 'global'
  const loop = options?.loop ?? 0

  // 全局色表只在 'global' 模式写；'frame' 模式没有全局表（每帧自带局部表）。
  const global = mode === 'global' ? buildPalette(prepared) : null
  const bufSize = 1024 + prepared.length * (width * height + 1024)
  const buf = new Uint8Array(bufSize)
  const writer = new GifWriter(buf, width, height, global
    ? { loop, palette: global.colors }
    : { loop })

  for (let i = 0; i < prepared.length; i++) {
    const frame = prepared[i]!
    const local = global ?? buildPalette([frame])
    const frameOpts: { delay: number; palette?: number[]; transparent?: number } = { delay: delaysCs[i]! }
    if (global === null) frameOpts.palette = local.colors
    if (local.transparentIdx !== null) frameOpts.transparent = local.transparentIdx
    writer.addFrame(0, 0, width, height, frameToIndices(frame, local.colors, local.transparentIdx), frameOpts)
  }

  const end = writer.end()
  if (end <= 0 || end > bufSize) {
    throw new Error(`encodeGifFrames: 编码缓冲不足（end=${end} > ${bufSize}）`)
  }
  return new Blob([buf.subarray(0, end)], { type: 'image/gif' })
}

/**
 * 贴图竖条 → GIF（材质卡入口；**保持旧观感**：全局调色板）。
 *
 * @param delaysCs 逐帧停留（厘秒）：来自 `domain/materials#planSequenceLoop`，不再自算 tick。
 */
export async function encodeAnimatedGif(
  dataUrl: string,
  delaysCs: readonly number[] = [5],
): Promise<EncodeAnimatedGifResult> {
  const { frames, frameSize } = await extractFrames(dataUrl)
  const rgba: RgbaFrame[] = frames.map((f) => ({ data: f.data, width: f.width, height: f.height }))
  const blob = await encodeGifFrames(rgba, delaysCs, { palette: 'global' })
  return { blob, frameCount: frames.length, frameSize }
}
