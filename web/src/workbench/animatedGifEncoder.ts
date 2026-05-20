/**
 * Encode an animated texture strip (vertical stack of square frames) as an animated GIF.
 * Uses omggif for the low-level GIF89a encoding.
 */
import { GifWriter } from 'omggif'

export interface EncodeAnimatedGifResult {
  blob: Blob
  frameCount: number
  frameSize: number
}

/**
 * Load an Image from a data URL.
 */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load texture image'))
    img.src = dataUrl
  })
}

/**
 * Extract square frames from a vertical strip texture.
 * Returns an array of ImageData, one per frame.
 */
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

/**
 * Build a global color palette from all frames' pixel data.
 * Returns palette as flat [r,g,b, r,g,b, ...] array.
 * Length is always a power of 2 (min 2, max 256).
 * If unique colors exceed 256, quantizes to the top 256 by frequency.
 */
function buildPalette(frames: ImageData[]): number[] {
  const freq = new Map<string, number>()

  for (const frame of frames) {
    const d = frame.data
    for (let i = 0; i < d.length; i += 4) {
      const key = `${d[i]},${d[i + 1]},${d[i + 2]}`
      freq.set(key, (freq.get(key) ?? 0) + 1)
    }
  }

  // Sort by frequency descending, take top 256
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1])
  const top = sorted.slice(0, 256)
  const colors: number[] = []
  const colorMap = new Map<string, number>()

  for (const [key] of top) {
    colorMap.set(key, colors.length / 3)
    const [r, g, b] = key.split(',').map(Number)
    colors.push(r!, g!, b!)
  }

  // If we have fewer than 256 colors, pad to nearest power of 2
  let size = 2
  const numColors = colors.length / 3
  while (size < numColors) size *= 2
  while (colors.length / 3 < size) {
    colors.push(0, 0, 0)
  }

  return colors
}

/**
 * Convert frame ImageData to indexed pixel array using the given palette.
 */
function frameToIndices(frame: ImageData, palette: number[]): Uint8Array {
  const numColors = palette.length / 3
  const colorToIndex = new Map<string, number>()
  for (let i = 0; i < numColors; i++) {
    const r = palette[i * 3]!
    const g = palette[i * 3 + 1]!
    const b = palette[i * 3 + 2]!
    colorToIndex.set(`${r},${g},${b}`, i)
  }

  const pixels = new Uint8Array(frame.width * frame.height)
  const d = frame.data
  for (let i = 0; i < pixels.length; i++) {
    const off = i * 4
    const key = `${d[off]},${d[off + 1]},${d[off + 2]}`
    pixels[i] = colorToIndex.get(key) ?? 0
  }
  return pixels
}

/**
 * Encode an animated texture strip data URL as a GIF blob.
 *
 * @param dataUrl - The PNG data URL of the vertical strip texture
 * @param delayCs - Frame delay in centiseconds (default: derived from animation spec, ~5cs)
 */
export async function encodeAnimatedGif(
  dataUrl: string,
  delayCs: number = 5,
): Promise<EncodeAnimatedGifResult> {
  const { frames, frameSize } = await extractFrames(dataUrl)
  const palette = buildPalette(frames)

  // GIF buffer: generous estimate — header (13) + palette (768) + frames
  const bufSize = 1024 + frames.length * (frameSize * frameSize + 256)
  const buf = new Uint8Array(bufSize)

  const writer = new GifWriter(buf, frameSize, frameSize, { loop: 0, palette })

  for (const frame of frames) {
    const indices = frameToIndices(frame, palette)
    writer.addFrame(0, 0, frameSize, frameSize, indices, { delay: delayCs })
  }

  // Trim to actual length
  const end = writer.end()
  const blob = new Blob([buf.subarray(0, end)], { type: 'image/gif' })

  return { blob, frameCount: frames.length, frameSize }
}
