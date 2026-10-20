/**
 * fixtures.mjs —— 离线夹具（测试专用，零依赖）
 * ============================================================================
 *
 * 判型测试不能靠网络，也不能靠真实 Wiki 的当前状态：真实数据一改，判据就跟着漂。
 * 这里用代码现场造贴图与导出件，覆盖三个必须分得开的形态：
 *
 *   placeholder16()  #87 正对照：16x16 黑/洋红棋盘（4 色以内，各占一半）
 *   goodTexture()    负对照：16x16 渐变（颜色数远超 4）
 *   strip(width)     #9 正/负对照：H=32 的横向多面带，宽度可调
 *
 * PNG 由 png.mjs 的 encodePng 写出（filter=0），与真实导出件的差异只在压缩率，
 * 像素与 IHDR 完全同构，足够验证解码与判型。
 */

import { gzipSync } from 'node:zlib'

import { encodePng } from './png.mjs'

const MAGENTA = [255, 0, 255, 255]
const BLACK = [0, 0, 0, 255]

function canvas(width, height, paint) {
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = paint(x, y)
      const offset = (y * width + x) * 4
      pixels[offset] = color[0]
      pixels[offset + 1] = color[1]
      pixels[offset + 2] = color[2]
      pixels[offset + 3] = color[3] == null ? 255 : color[3]
    }
  }
  return { width, height, pixels }
}

/** #87 正对照：16x16 黑/洋红棋盘，2 色，洋红 50%、纯黑 50%。 */
export function placeholder16() {
  return canvas(16, 16, (x, y) => ((x < 8) === (y < 8) ? MAGENTA : BLACK))
}

/** 负对照：16x16 渐变，256 色，不满足颜色数 <= 4。 */
export function goodTexture() {
  return canvas(16, 16, (x, y) => [x * 16, y * 16, 128, 255])
}

/** #9 候选：H=32、W=32*faces 的横向多面带（每列一个面，颜色互不相同）。 */
export function strip(faces = 12) {
  return canvas(faces * 32, 32, (x) => {
    const face = Math.floor(x / 32)
    return [(face * 19) % 256, (face * 37) % 256, (face * 53) % 256, 255]
  })
}

export function pngBase64(image) {
  return encodePng(image).toString('base64')
}

export function makeBlock(registryId, materialIndexes, meta = 0) {
  return {
    registryId,
    meta,
    renderMode: 'BakedQuads',
    geometry: {
      encoding: 'bakedQuadsJsonV1',
      quads: materialIndexes.map((materialIndex) => ({ materialIndex })),
    },
  }
}

/** 一层一格的小 grid；indices 里每个元素对应一个格子（-1 = 空气）。 */
export function gridWith(indices) {
  // cellGrid 是 [层][行][列] = 调色板索引；这里造 1 层 1 行 N 列。
  return [[indices.slice()]]
}

export function makeMaterial(locator, textureBlobIndex, extra = {}) {
  return {
    locator,
    kind: 'static16',
    atlas: 'blocks',
    linear: true,
    useMipmaps: true,
    textureBlobIndex,
    blend: 'opaque',
    ...extra,
  }
}

export function makeDocument({ blobs, materials, blocks, grid, frames }) {
  const doc = {
    textureBlobs: blobs,
    materialPalette: materials,
    ...(frames ? { frames } : {}),
  }
  if (!frames) {
    doc.blockPalette = blocks
    doc.cellGrid = grid
  }
  return doc
}

/** 把 Plain 文档装进导出件的 Envelope（gzip+base64）。 */
export function makeEnvelope(doc, meta = {}) {
  return JSON.stringify({
    documentFormat: 'Envelope',
    payloadEncoding: 'gzip+base64',
    meta: { id: 'test', documentFormat: 'Plain', ...meta },
    payload: gzipSync(Buffer.from(JSON.stringify(doc), 'utf8')).toString('base64'),
  })
}

export function makeMultipart({ base, docs, meta = {} }) {
  const full = Buffer.from(JSON.stringify(docs[0]), 'utf8')
  const payloadParts = []
  const chunkSize = Math.ceil(full.length / docs.length)
  const payload = gzipSync(full).toString('base64')
  const slice = Math.ceil(payload.length / docs.length)
  for (let i = 0; i < docs.length; i++) payloadParts.push(payload.slice(i * slice, (i + 1) * slice))
  const index = {
    documentFormat: 'Envelope/multipart',
    partCount: docs.length,
    base,
    payloadEncoding: 'gzip+base64',
    meta: { id: 'test', documentFormat: 'Plain', ...meta },
  }
  const parts = payloadParts.map((payloadText, i) => ({
    documentFormat: 'Envelope/part',
    part: i + 1,
    partCount: docs.length,
    base,
    payload: payloadText,
  }))
  return { index, parts }
}
