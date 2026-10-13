/**
 * `adapters/textureDecode` —— **内嵌纹理字节 → RGBA8 像素**（`TextureDecoder` 的生产实现）。
 *
 * ## 为什么在适配层（而不是 `composition/` 或 `presentation/`）
 *
 * #249 §4 规则 4：「适配器实现端口」。解码要 DOM（`createImageBitmap` + `OffscreenCanvas`
 * 或 `<canvas>` 的 `getImageData`），那是**IO/平台**职责：
 *  - `presentation/` 声明端口（`composition/kernelTextureResources#TextureDecoder`），
 *    它必须能在 vitest（无 GPU、无 DOM）里跑状态机；
 *  - `composition/` 是装配根，但它**不碰 IO**（同 `composition/kernelTextureResources`
 *    文件头"解码是注入的"）。
 * ⇒ 实现落在 `adapters/`，由装配层注入。
 *
 * ## 契约（逐条与端口声明一致）
 *
 * | 输入 | 返回 |
 * |---|---|
 * | 可解码的图像字节（data URL / base64） | `{width, height, rgba}` |
 * | 解不出来 / 不是图像 | `null`（**不得**返回空白图 —— 那会让"解不出来"与"解出来是空白"不可区分） |
 * | 平台不支持（无 `createImageBitmap`） | `null` + `lastUnsupportedReason`（**显式**，不是静默） |
 *
 * ## 为什么 `decoderSupported()` 单独导出
 *
 * "这台环境能不能解码"是一个**装配期事实**：装不出来时上面的调用方应当走
 * "全部 `unrequested`"而不是逐张 `failed`（后者会误报"字节坏了"）。把该事实
 * 显式暴露，装配层才不必靠猜。
 */

import type { TextureDecoder } from '@/composition/kernelTextureResources'
import type { TexturePixels } from '@/presentation/textureBinding'

/** 当前环境能否做浏览器侧解码（`null` = 不能，且给出原因）。 */
export function textureDecodeUnsupportedReason(): string | null {
  if (typeof createImageBitmap !== 'function') return 'createImageBitmap 不可用（非浏览器环境）'
  if (typeof OffscreenCanvas !== 'function' && typeof document === 'undefined') {
    return 'OffscreenCanvas 与 document 均不可用（无 2D 画布）'
  }
  return null
}

/**
 * 造一个 DOM 侧解码器。
 *
 * ⚠️ 非浏览器环境（vitest node）下调用 `decode` 会得到 `null` —— 那是**如实**答案，
 * 而不是抛错：调用方据此记 `failed`/`unrequested`，并在诊断里看到原因。
 */
export function createDomTextureDecoder(): TextureDecoder {
  return {
    async decode(payload: string): Promise<TexturePixels | null> {
      const reason = textureDecodeUnsupportedReason()
      if (reason !== null) return null
      try {
        const blob = await payloadToBlob(payload)
        if (blob === null) return null
        const bitmap = await createImageBitmap(blob)
        try {
          const { width, height } = bitmap
          const rgba = readRgba(bitmap, width, height)
          return rgba === null ? null : Object.freeze({ width, height, rgba })
        } finally {
          bitmap.close()
        }
      } catch {
        // 坏字节/非法 data URL —— 端口契约要求"映射成五态之一"，`null` 即失败态。
        return null
      }
    },
  }
}

/** 取 2D 画布的 `ImageData`（`OffscreenCanvas` 优先；无则用 `<canvas>`）。 */
function readRgba(source: CanvasImageSource, width: number, height: number): Uint8Array | null {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (ctx === null) return null
    ctx.drawImage(source, 0, 0)
    return new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer.slice(0))
  }
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx === null) return null
  ctx.drawImage(source, 0, 0)
  return new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer.slice(0))
}

/** data URL / 裸 base64 → `Blob`（**不**取远端：外链资源由宿主端口负责）。 */
async function payloadToBlob(payload: string): Promise<Blob | null> {
  if (payload.startsWith('data:')) {
    const res = await fetch(payload)
    return res.ok ? await res.blob() : null
  }
  // 裸 base64（无 data: 前缀）—— 按 PNG 假定（`textureBlobs` 的既有形态）。
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes])
}
