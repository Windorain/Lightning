/**
 * `adapters/export/pngEncoder` —— **纯 PNG 编码**。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | 经**画布**编码：`canvas.toBlob(…, 'image/png')` | `workbench/textureAtlasRaster.ts`、`workbench/coplanarTextureComposite.ts` | 逐字节构造 PNG（`pako` zlib + 本模块 CRC32）：**纯函数**，无 DOM/canvas |
 * | 经 `renderer.domElement.toDataURL('image/png')` 取产物 | `workbench/exportIsometricImage.ts:172` | 离屏目标 `readRenderTargetPixels` → 本模块编码（见 `adapters/export/offscreenRenderPort`） |
 *
 * ## 为什么**不**用 `canvas.toBlob`（关键取舍）
 *
 * 用画布编码会让"编码"这一段只能在**浏览器**里验：vitest 面（本仓无真 GL/canvas）
 * 就只能断言"有没有调用过 toBlob"—— 判据退化成**结构指纹**，
 * "产物是不是一张合法 PNG"「像素有没有真写进去」全都无从判起。
 * 而发布准入明文要求不支持的导出**明确报告**、不产出伪完整文件；
 * 一个无法判定的编码段正是"伪完整文件"最容易藏身之处。
 *
 * 纯实现让字节面**可在 vitest 里真判红**（magic / IHDR / 逐块 CRC32 / IEND /
 * `inflate(IDAT)` 逐字节往返），且浏览器与 Node 走**同一份**实现 ——
 * 不存在"两套编码口径"。
 *
 * ## 零新依赖
 *
 * `pako` 已是本仓依赖（`envelopeCodec` 在用）。CRC32 按 PNG/zlib 标准
 * （多项式 `0xEDB88320`）在本模块自实现（约 15 行）—— 因为 `pako` **不导出**
 * `crc32`（实测：其导出为 `Deflate/deflate/deflateRaw/gzip/Inflate/inflate/inflateRaw/ungzip/constants`）。
 * 不为此引入新包（`package.json` 属硬边界）。
 *
 * ## 行序：一处**必须**处理的真实坑
 *
 * WebGL 的 `readRenderTargetPixels` 产出**自下而上**（原点在左下），
 * 而 PNG 的扫描行是**自上而下**。不翻转 ⇒ 产物**上下颠倒**，
 * 而那**不会报错**（是一张合法 PNG，只是倒的）—— 属静默错误。
 * 故翻转由 {@link encodePngFromRgba} 的 `flipY` 参数显式决定（默认 `true`），
 * 判据据它逐行核对。
 */

import pako from 'pako'

/** PNG 魔数（8 字节）。判据 E3 的锚点。 */
export const PNG_MAGIC: readonly number[] = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** PNG 每像素 8 位、色彩类型 6（真彩 + Alpha）—— 与 `RenderedFrame.pixels` 的 RGBA 口径一致。 */
export const PNG_COLOR_TYPE_RGBA = 6

/** CRC32 查表（zlib/PNG 标准多项式 `0xEDB88320`；模块级构造一次）。 */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) === 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** PNG/zlib 口径的 CRC32（`0xffffffff` 起止，逐字节查表）。 */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)) >>> 0
  }
  return (c ^ 0xffffffff) >>> 0
}

/** 大端 32 位（PNG 全文件都是网络字节序）。 */
function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}

/**
 * 构造一个 PNG 块：`长度 | 类型 | 数据 | CRC(类型+数据)`。
 *
 * CRC 覆盖**类型与数据**、**不含长度** —— 这是 PNG 规范里最常写错的一处
 * （写成"含长度"会让所有阅读器判块损坏）。判据 E3 逐块核 CRC，故写错必红。
 */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([...type].map((c) => c.charCodeAt(0)))
  const body = new Uint8Array(typeBytes.length + data.length)
  body.set(typeBytes, 0)
  body.set(data, typeBytes.length)

  const out = new Uint8Array(4 + body.length + 4)
  out.set(u32(data.length), 0)
  out.set(body, 4)
  out.set(u32(crc32(body)), 4 + body.length)
  return out
}

/**
 * RGBA 像素 → PNG 字节。
 *
 * @param rgba 逐像素 RGBA（行主序；与 `RenderedFrame.pixels` 同口径）。
 * @param width  宽（像素）
 * @param height 高（像素）
 * @param flipY 是否做**行序翻转**（默认 `true`：WebGL 原点在左下、PNG 在左上）。
 *              显式参数而非隐式约定 —— 调用方据数据来源决定，判据据它逐行核对。
 *
 * 尺寸与缓冲长度**不一致即抛**：那不是"可以夹取"的情形，而是上游算错了
 * （夹取会让产物尺寸与 `request.render` 悄悄不符 ⇒ 假成功）。
 */
export function encodePngFromRgba(
  rgba: Uint8Array,
  width: number,
  height: number,
  flipY = true,
): Uint8Array {
  if (!Number.isInteger(width) || width <= 0) throw new Error(`pngEncoder: 宽必须是正整数，实得 ${width}`)
  if (!Number.isInteger(height) || height <= 0) throw new Error(`pngEncoder: 高必须是正整数，实得 ${height}`)
  const expected = width * height * 4
  if (rgba.length !== expected) {
    throw new Error(`pngEncoder: 像素缓冲长度必须是 ${expected}（${width}×${height}×4），实得 ${rgba.length}`)
  }

  const stride = width * 4
  // 每个扫描行前置一个 filter 字节（0 = None）：PNG 的每行**都**要以 filter 开头，
  // 漏掉它会让阅读器把第 0 个像素的第一个分量当 filter 用（整图错位）。
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const srcRow = flipY ? height - 1 - y : y
    raw[y * (stride + 1)] = 0
    raw.set(rgba.subarray(srcRow * stride, srcRow * stride + stride), y * (stride + 1) + 1)
  }

  const ihdr = new Uint8Array(13)
  ihdr.set(u32(width), 0)
  ihdr.set(u32(height), 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = PNG_COLOR_TYPE_RGBA // 色彩类型
  ihdr[10] = 0 // 压缩方法（仅 0 合法）
  ihdr[11] = 0 // 过滤方法（仅 0 合法）
  ihdr[12] = 0 // 非隔行

  // `pako.deflate` 产出 **zlib** 流（`78 9c` 头 + adler32 尾）—— 正是 PNG IDAT 要的。
  // 用 `deflate` 而非 `deflateRaw`：后者无 zlib 包装，产物非法（阅读器判损坏）。
  const idat = pako.deflate(raw)

  const parts = [
    new Uint8Array(PNG_MAGIC),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
