/**
 * **测试侧 GIF 字节解析**：只读**下载到的原始字节**，不 import 生产编码器。
 *
 * ## 为什么判据必须自己解析字节
 *
 * 若判据调用生产编码器/生产计划去"读回"自己的产物，它证明的是"实现与自身一致"
 * —— 一条恒真判据。这里逐块走 GIF89a 结构（逻辑屏 / 扩展 / image descriptor /
 * LZW 子块），把**帧数**与**逐帧 delay** 从字节里读出来，再与 UI 声明对账。
 *
 * 覆盖的块：
 *  - Logical Screen Descriptor（宽高 + 全局色表标志）；
 *  - `0x21 0xF9` Graphics Control Extension（delay 是 LE u16，单位 1/100 s）；
 *  - `0x21 0xFE/0xFF`/其它扩展（按子块跳过）；
 *  - `0x2C` Image Descriptor（局部色表 + LZW 最小码长 + 数据子块）；
 *  - `0x3B` Trailer。
 */

export interface ParsedGif {
  readonly header: string
  readonly width: number
  readonly height: number
  /** 每个 image descriptor 的 Graphics Control Extension delay（厘秒）；缺 GCE 记 0。 */
  readonly delaysCs: readonly number[]
  readonly imageCount: number
  /** 每帧是否带局部色表（`palette:'frame'` 的产物全 true）。 */
  readonly hasLocalPalette: readonly boolean[]
}

function skipSubBlocks(bytes: Uint8Array, start: number): number {
  let p = start
  while (p < bytes.length) {
    const len = bytes[p]!
    if (len === 0) return p + 1
    p += len + 1
  }
  throw new Error('parseGif: 子块链未以 0 终止（文件被截断？）')
}

export function parseGif(bytes: Uint8Array): ParsedGif {
  if (bytes.length < 13) throw new Error(`parseGif: 字节太少（${bytes.length}）`)
  const header = String.fromCharCode(...bytes.subarray(0, 6))
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
    if (b === 0x3b) break
    if (b === 0x21) {
      const label = bytes[p + 1]!
      p += 2
      if (label === 0xf9) {
        // size(1) | flags(1) | delay LE u16 | transparentIdx(1) | terminator(1)
        pendingDelay = bytes[p + 2]! | (bytes[p + 3]! << 8)
      }
      p = skipSubBlocks(bytes, p)
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
      p += 1 // LZW minimum code size
      p = skipSubBlocks(bytes, p)
      continue
    }
    throw new Error(`parseGif: 未识别的块 0x${b.toString(16)} @${p}`)
  }

  return { header, width, height, delaysCs, imageCount, hasLocalPalette }
}
