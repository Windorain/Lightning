/**
 * 纹理解码与 atlas 栅格化（浏览器适配层；供 OBJ 连通模式与方块模式体素 atlas）。
 */

import {
  frameCountFromImageSize,
  resolveAnimationTimeline,
  type ParsedMcmeta,
} from '@/render/assets/textureStripAnimation'
import type { AtlasPlacement, AtlasTilePlacement } from '@/render/mesh/atlasLayout'
import type { MaterialPaletteEntry } from '@/render/schema/types'

export function base64PngToDataUrl(b64: string): string {
  const t = b64.trim()
  if (t.startsWith('data:')) return t
  return `data:image/png;base64,${t}`
}

function paletteAnimationToParsed(entry: MaterialPaletteEntry): ParsedMcmeta {
  const a = entry.animation
  if (!a) return {}
  const seq = Array.isArray(a.frameSequence)
    ? a.frameSequence.map((f) => ({
        index: typeof f.index === 'number' ? f.index : 0,
        timeTicks:
          typeof f.timeTicks === 'number' && f.timeTicks > 0 ? Math.floor(f.timeTicks) : undefined,
      }))
    : []
  return {
    animation: {
      defaultFrametimeTicks:
        typeof a.defaultFrametimeTicks === 'number' && a.defaultFrametimeTicks > 0
          ? Math.floor(a.defaultFrametimeTicks)
          : 1,
      frameSequence: seq,
      interpolate: a.interpolate === true,
    },
  }
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('纹理图加载失败'))
    img.src = src
  })
}

/** 动画条取首帧后的像素尺寸 */
export async function measureTextureBlobFirstFrame(
  rawBlob: string,
  entry: MaterialPaletteEntry,
): Promise<{ width: number; height: number }> {
  const dataUrl = base64PngToDataUrl(rawBlob)
  const img = await loadImageElement(dataUrl)
  const nw = img.naturalWidth
  const nh = img.naturalHeight
  if (nw <= 0 || nh <= 0) throw new Error('纹理图尺寸无效')
  let sh = nh
  if (entry.kind === 'animated') {
    const frameCount = frameCountFromImageSize(nw, nh)
    if (frameCount > 1) {
      sh = nw
    }
  }
  return { width: nw, height: sh }
}

/** 整张首帧裁切为 PNG Blob（与旧版工作台导出一致） */
export async function textureBlobToFirstFramePngBlob(
  rawBlob: string,
  entry: MaterialPaletteEntry,
): Promise<Blob> {
  const { width, height } = await measureTextureBlobFirstFrame(rawBlob, entry)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 不可用')
  await drawTextureBlobFirstFrameToRect({
    ctx,
    destX: 0,
    destY: 0,
    destW: width,
    destH: height,
    rawBlob,
    entry,
  })
  return await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png')
  })
}

/** 将首帧 PNG 栅格画入 atlas 画布上的矩形（含动画条裁切） */
export async function drawTextureBlobFirstFrameToRect(opts: {
  ctx: CanvasRenderingContext2D
  destX: number
  destY: number
  destW: number
  destH: number
  rawBlob: string
  entry: MaterialPaletteEntry
}): Promise<void> {
  const dataUrl = base64PngToDataUrl(opts.rawBlob)
  const img = await loadImageElement(dataUrl)
  const nw = img.naturalWidth
  const nh = img.naturalHeight
  if (nw <= 0 || nh <= 0) throw new Error('纹理图尺寸无效')

  let sy = 0
  let sh = nh
  if (opts.entry.kind === 'animated') {
    const frameCount = frameCountFromImageSize(nw, nh)
    if (frameCount > 1) {
      const fh = nw
      const parsed = paletteAnimationToParsed(opts.entry)
      const timeline = resolveAnimationTimeline(parsed, frameCount)
      const fi = Math.max(0, Math.min(frameCount - 1, timeline.frames[0]?.index ?? 0))
      sy = fi * fh
      sh = fh
    }
  }

  opts.ctx.drawImage(img, 0, sy, nw, sh, opts.destX, opts.destY, opts.destW, opts.destH)
}

/** 按 {@link AtlasPlacement} 将多张贴图绘制到一张 atlas 并导出 PNG Blob */
export async function rasterizeAtlasToPngBlob(options: {
  atlasWidth: number
  atlasHeight: number
  placements: AtlasPlacement[]
  blobs: string[]
  representativeEntry: (blobIndex: number) => MaterialPaletteEntry | undefined
}): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, options.atlasWidth)
  canvas.height = Math.max(1, options.atlasHeight)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 不可用')
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  for (const p of options.placements) {
    const raw = options.blobs[p.blobIndex]
    if (typeof raw !== 'string') continue
    const rep = options.representativeEntry(p.blobIndex)
    if (!rep) continue
    await drawTextureBlobFirstFrameToRect({
      ctx,
      destX: p.x,
      destY: p.y,
      destW: p.width,
      destH: p.height,
      rawBlob: raw,
      entry: rep,
    })
  }

  return await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png')
  })
}

/** 方块模式体素 atlas：格子顺序与 {@link packTextureGridByTileId} 的 items 一致 */
export type VoxelAtlasTileSource =
  | { kind: 'blob'; blobIndex: number }
  | { kind: 'png'; pngBlob: Blob }

/** 将 blob 首帧与已栅格化的 PNG（如共面叠化结果）画入同一张 atlas */
export async function rasterizeVoxelAtlasToPngBlob(options: {
  atlasWidth: number
  atlasHeight: number
  placements: AtlasTilePlacement[]
  tileSources: VoxelAtlasTileSource[]
  blobs: string[]
  representativeEntry: (blobIndex: number) => MaterialPaletteEntry | undefined
}): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, options.atlasWidth)
  canvas.height = Math.max(1, options.atlasHeight)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 不可用')
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  for (let i = 0; i < options.placements.length; i++) {
    const p = options.placements[i]!
    const src = options.tileSources[i]
    if (!src) continue
    if (src.kind === 'blob') {
      const raw = options.blobs[src.blobIndex]
      if (typeof raw !== 'string') continue
      const rep = options.representativeEntry(src.blobIndex)
      if (!rep) continue
      await drawTextureBlobFirstFrameToRect({
        ctx,
        destX: p.x,
        destY: p.y,
        destW: p.width,
        destH: p.height,
        rawBlob: raw,
        entry: rep,
      })
    } else {
      const bmp = await createImageBitmap(src.pngBlob)
      ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, p.x, p.y, p.width, p.height)
    }
  }

  return await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png')
  })
}
