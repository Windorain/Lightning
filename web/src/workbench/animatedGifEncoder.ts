/**
 * Encode an animated texture strip (vertical stack of square frames) as an animated GIF.
 * Uses omggif for the low-level GIF89a encoding.
 *
 * Supports transparency: if any frame has pixels with alpha < 128, index 0 in the
 * global palette is reserved as the transparent colour and flagged accordingly.
 */
import { GifWriter } from 'omggif'

export interface EncodeAnimatedGifResult {
  blob: Blob
  frameCount: number
  frameSize: number
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

/** Sentinel colour placed at index 0 when the GIF has transparency. */
const TRANSPARENT_SENTINEL = 0

interface PaletteResult {
  /** Packed 24-bit colours, length = power of 2 (min 2, max 256). */
  colors: number[]
  /** Index of the transparent colour, or null if no transparency. */
  transparentIdx: number | null
}

/**
 * Build a global palette from opaque pixels only.
 * If transparent pixels exist, index 0 is reserved for them.
 * Unique opaque colours capped at 255 (indexes 1..255), leaving index 0 free.
 */
function buildPalette(frames: ImageData[]): PaletteResult {
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

  // Sort by frequency descending; take top 255 if transparent (reserve slot 0), else 256
  const maxOpaque = hasTransparent ? 255 : 256
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1])
  const top = sorted.slice(0, maxOpaque)
  const palette: number[] = []

  if (hasTransparent) {
    palette.push(TRANSPARENT_SENTINEL) // index 0 = transparent
  }
  for (const [color] of top) {
    palette.push(color)
  }

  // Pad to power of 2
  let size = 2
  while (size < palette.length) size *= 2
  while (palette.length < size) {
    palette.push(0)
  }

  return { colors: palette, transparentIdx: hasTransparent ? 0 : null }
}

/**
 * Convert frame ImageData to indexed pixels.  Transparent pixels (alpha < 128)
 * map to `transparentIdx`; opaque pixels are looked up in the palette.
 */
function frameToIndices(
  frame: ImageData,
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

export async function encodeAnimatedGif(
  dataUrl: string,
  delayCs: number = 5,
): Promise<EncodeAnimatedGifResult> {
  const { frames, frameSize } = await extractFrames(dataUrl)
  const { colors: palette, transparentIdx } = buildPalette(frames)

  const bufSize = 1024 + frames.length * (frameSize * frameSize + 256)
  const buf = new Uint8Array(bufSize)

  const writer = new GifWriter(buf, frameSize, frameSize, { loop: 0, palette })

  const frameOpts: { delay: number; transparent?: number } = { delay: delayCs }
  if (transparentIdx !== null) {
    frameOpts.transparent = transparentIdx
  }

  for (const frame of frames) {
    const indices = frameToIndices(frame, palette, transparentIdx)
    writer.addFrame(0, 0, frameSize, frameSize, indices, frameOpts)
  }

  const end = writer.end()
  const blob = new Blob([buf.subarray(0, end)], { type: 'image/gif' })

  return { blob, frameCount: frames.length, frameSize }
}
