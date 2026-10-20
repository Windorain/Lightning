/**
 * png.mjs —— 最小 PNG 解码器（零依赖，只用 node:zlib）
 * ============================================================================
 *
 * 为什么自己写：审计脚本的输入是导出件里的 textureBlobs（base64 的 PNG 字节），
 * 而本仓 scripts/ 口径是「零新增依赖」（不引 sharp / pngjs）。PNG 的像素数据本来就
 * 只是 zlib 流，所以这里做的是够用的最小实现，而不是通用图片库：
 *
 *   - 只接受非隔行（interlace=0）的 PNG —— 导出件的贴图都由导出器写成非隔行；
 *     未来若出现隔行贴图，明确抛错（进「未判型」/缺口，而不是猜像素）。
 *   - 支持 colorType 0/2/3/4/6，bitDepth 1/2/4/8/16；统一展开成 8 位 RGB。
 *   - 丢弃 alpha，与 #87 参考实现 PIL 的 .convert("RGB") 口径一致
 *     （判据只谈洋红/纯黑的 RGB 占比，alpha 不参与）。
 *   - 不校验 CRC：审计只读，校验和不影响判型；省下的时间用在整站扫描上。
 *
 * 判型只关心三个量：尺寸、不同颜色数、洋红/纯黑像素占比。像素数组按 RGB
 * 三连存放，颜色数用 (r<<16|g<<8|b) 打包去重。
 */

import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
const ALLOWED_DEPTHS = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
}

export class PngError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'PngError'
    this.code = code || 'PNG-UNSUPPORTED'
  }
}

/**
 * 解码 PNG 为 8 位 RGB 像素。
 * @param {Buffer|Uint8Array} input PNG 字节
 * @returns {{width:number,height:number,bitDepth:number,colorType:number,data:Uint8Array}}
 */
export function decodePng(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new PngError('不是 PNG（签名不符）', 'PNG-SIGNATURE')
  }

  let offset = 8
  let ihdr = null
  let plte = null
  const idat = []
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('latin1', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buf.length) throw new PngError('PNG 块被截断：' + type, 'PNG-TRUNCATED')
    const data = buf.subarray(dataStart, dataEnd)
    offset = dataEnd + 4
    if (type === 'IHDR') ihdr = parseIhdr(data)
    else if (type === 'PLTE') plte = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
  }

  if (!ihdr) throw new PngError('缺少 IHDR', 'PNG-NO-IHDR')
  if (!idat.length) throw new PngError('缺少 IDAT', 'PNG-NO-IDAT')
  if (ihdr.interlace !== 0) throw new PngError('不支持隔行 PNG', 'PNG-INTERLACED')

  const channels = CHANNELS[ihdr.colorType]
  if (!channels) throw new PngError('未知 colorType=' + ihdr.colorType, 'PNG-COLOR-TYPE')
  if (ihdr.colorType === 3 && !plte) throw new PngError('调色板 PNG 缺少 PLTE', 'PNG-NO-PLTE')

  const inflated = inflateSync(Buffer.concat(idat))
  const rows = unfilter(inflated, ihdr, channels)
  const data = expandToRgb(rows, ihdr, channels, plte)

  return {
    width: ihdr.width,
    height: ihdr.height,
    bitDepth: ihdr.bitDepth,
    colorType: ihdr.colorType,
    data,
  }
}

function parseIhdr(data) {
  if (data.length !== 13) throw new PngError('IHDR 长度异常', 'PNG-IHDR')
  const width = data.readUInt32BE(0)
  const height = data.readUInt32BE(4)
  const bitDepth = data[8]
  const colorType = data[9]
  const compression = data[10]
  const filter = data[11]
  const interlace = data[12]
  if (!width || !height) throw new PngError('PNG 尺寸为 0', 'PNG-SIZE')
  if (compression !== 0) throw new PngError('不支持的压缩方式', 'PNG-COMPRESSION')
  if (filter !== 0) throw new PngError('不支持的过滤方式', 'PNG-FILTER')
  if (!ALLOWED_DEPTHS[colorType] || !ALLOWED_DEPTHS[colorType].includes(bitDepth)) {
    throw new PngError('不支持的 colorType/bitDepth 组合：' + colorType + '/' + bitDepth, 'PNG-DEPTH')
  }
  return { width, height, bitDepth, colorType, compression, filter, interlace }
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function unfilter(inflated, ihdr, channels) {
  const { width, height, bitDepth } = ihdr
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8))
  const stride = Math.ceil((width * channels * bitDepth) / 8)
  const expected = height * (stride + 1)
  if (inflated.length < expected) {
    throw new PngError('像素数据不足：' + inflated.length + ' < ' + expected, 'PNG-PIXELS')
  }

  const out = Buffer.alloc(height * stride)
  let prev = Buffer.alloc(stride)
  let src = 0
  for (let y = 0; y < height; y++) {
    const filter = inflated[src++]
    const rowStart = y * stride
    const row = out.subarray(rowStart, rowStart + stride)
    inflated.copy(row, 0, src, src + stride)
    src += stride

    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? row[x - bpp] : 0
      const up = prev[x]
      const upLeft = x >= bpp ? prev[x - bpp] : 0
      switch (filter) {
        case 0:
          break
        case 1:
          row[x] = (row[x] + left) & 0xff
          break
        case 2:
          row[x] = (row[x] + up) & 0xff
          break
        case 3:
          row[x] = (row[x] + ((left + up) >> 1)) & 0xff
          break
        case 4:
          row[x] = (row[x] + paeth(left, up, upLeft)) & 0xff
          break
        default:
          throw new PngError('未知行过滤类型 ' + filter, 'PNG-FILTER-TYPE')
      }
    }
    prev = row
  }
  return out
}

function sampleBits(row, index, bitDepth) {
  if (bitDepth === 8) return row[index]
  if (bitDepth === 16) return row[index * 2] // 取高字节
  const bitPos = index * bitDepth
  const byte = row[bitPos >> 3]
  const shift = 8 - bitDepth - (bitPos & 7)
  const mask = (1 << bitDepth) - 1
  return (byte >> shift) & mask
}

function expandToRgb(rows, ihdr, channels, plte) {
  const { width, height, bitDepth, colorType } = ihdr
  const out = new Uint8Array(width * height * 3)
  const stride = Math.ceil((width * channels * bitDepth) / 8)
  const maxSample = (1 << Math.min(bitDepth, 8)) - 1

  for (let y = 0; y < height; y++) {
    const row = rows.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3
      if (colorType === 2 || colorType === 6) {
        out[o] = sampleBits(row, x * channels, bitDepth)
        out[o + 1] = sampleBits(row, x * channels + 1, bitDepth)
        out[o + 2] = sampleBits(row, x * channels + 2, bitDepth)
      } else if (colorType === 0 || colorType === 4) {
        let v = sampleBits(row, x * channels, bitDepth)
        if (bitDepth < 8) v = Math.round((v * 255) / maxSample)
        out[o] = out[o + 1] = out[o + 2] = v
      } else {
        const index = sampleBits(row, x, bitDepth)
        out[o] = plte[index * 3] || 0
        out[o + 1] = plte[index * 3 + 1] || 0
        out[o + 2] = plte[index * 3 + 2] || 0
      }
    }
  }
  return out
}

/**
 * 计算 #87/#9 判据需要的贴图统计。
 *
 * 洋红/纯黑的口径与 #87 参考实现逐条一致（容差也照抄）：
 *   洋红：|r-255| < 24 且 g < 24 且 |b-255| < 24
 *   纯黑：max(r,g,b) < 24
 *
 * @returns {{width:number,height:number,bytes:number,uniqueColors:number,magentaRatio:number,blackRatio:number,topColors:Array}}
 */
export function pngStats(pngBytes) {
  const image = decodePng(pngBytes)
  const { width, height, data } = image
  const total = width * height
  const seen = new Set()
  let magenta = 0
  let black = 0
  for (let i = 0; i < total; i++) {
    const r = data[i * 3]
    const g = data[i * 3 + 1]
    const b = data[i * 3 + 2]
    seen.add((r << 16) | (g << 8) | b)
    if (Math.abs(r - 255) < 24 && g < 24 && Math.abs(b - 255) < 24) magenta++
    if (Math.max(r, g, b) < 24) black++
  }
  return {
    width,
    height,
    bitDepth: image.bitDepth,
    colorType: image.colorType,
    bytes: pngBytes.length,
    uniqueColors: seen.size,
    magentaRatio: magenta / total,
    blackRatio: black / total,
  }
}

/** 供测试与夹具使用：把 RGBA 像素写成最小 PNG（filter=0，非隔行）。 */
export function encodePng({ width, height, pixels, colorType = 6 }) {
  const channels = CHANNELS[colorType]
  const rowBytes = width * channels
  const raw = Buffer.alloc(height * (rowBytes + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4
      const dst = y * (rowBytes + 1) + 1 + x * channels
      raw[dst] = pixels[src]
      raw[dst + 1] = pixels[src + 1]
      raw[dst + 2] = pixels[src + 2]
      if (channels === 4) raw[dst + 3] = pixels[src + 3]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = colorType
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, data, Buffer.alloc(4)])
}
