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
      // 耗时登记（#399 步骤 6）：单张解码的墙钟，供 `performance.getEntriesByName('texture-decode:image')`
      // 读取（白模期四段拆分的"解码"一段）。**不改行为**：测量本身失败不影响返回值。
      const t0 = perfNow()
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
      } finally {
        perfSince('texture-decode:image', t0)
      }
    },
  }
}

/** 性能测量是否可用（非浏览器/受限环境 ⇒ 全部跳过，不做兼容分支之外的猜测）。 */
const PERF_ON = typeof performance !== 'undefined' && typeof performance.measure === 'function'

function perfNow(): number {
  return PERF_ON ? performance.now() : 0
}

/** 记一条耗时（同名多条由浏览器分别保留；缓冲上限只影响可回读的条数，不影响行为）。 */
function perfSince(name: string, start: number): void {
  if (!PERF_ON) return
  try {
    performance.measure(name, { start, end: performance.now() })
  } catch {
    // 测量是旁路：失败不得让"能解码"变成"解不出来"。
  }
}

/**
 * 模块级复用的 2D 画布（#399 缺陷 A / B2）。
 *
 * ## 旧实现的两笔白费
 *
 * 每张纹理都 `new OffscreenCanvas(w, h)` + `getContext('2d')`（一次 GPU/软件位图分配），
 * 然后 `getImageData(...).data.buffer.slice(0)` —— `getImageData` **本身已是新分配的拷贝**，
 * `.buffer.slice(0)` 是**第二份**整幅 RGBA 拷贝。57 张串行时这两笔都被放大 57 倍。
 *
 * ## 复用为什么安全
 *
 * - 画布只是"位图 → RGBA"的中转：`drawImage` 后立刻 `getImageData`，两次调用之间**没有
 *   await** ⇒ 单线程下不可能穿插另一张的绘制（并发解码也只在 `await` 处交错）。
 * - 返回的 `Uint8Array` 由 `new Uint8Array(ImageData.data)` **新分配**，不与该画布共享
 *   内存 ⇒ 复用不会让已交付的像素在下一张解码时被改写（这条是 B2 的正确性判据）。
 *
 * ## ⚠️ 复用**必须**先清空画布：`drawImage` 是 **source-over 合成**，不是覆盖写
 *
 * 上一条"我们每次都重绘，故无残留"是错的（2026-10-19 验收实测推翻）：**同尺寸**的下一张
 * 纹理**不触发 resize**（`if (canvas.width !== width)` 不成立），画布既不 resize 也不清空，
 * 于是 `drawImage` 按 source-over 合成到上一张的残留像素上 —— 新图的**透明像素**原样透出
 * 上一张的颜色，且 alpha 变成上一张的 255。
 *
 * 现象（E2E 标定场景，导出件 `textureBlobs` 里玻璃中心确实是 `(0,0,0,0)`）：
 * 「玻璃」材质解出来的像素中心是**上一张羊毛纹理**的颜色、alpha 255 ⇒ 该贴图永远"不透明"，
 * 任何 cutout/translucent 判据都失效；而**残留色取决于解码顺序**，所以同一份文档两次渲染
 * 玻璃中心可以一次偏蓝一次偏红（实测：串行解码时玻璃跟随前一张红羊毛）。
 *
 * 修法：每次绘制前 `clearRect`（比"强制 resize"便宜，且保留复用）。
 * 回归判据：`src/adapters/__tests__/textureDecodeSharedCanvas.test.ts`
 * （同尺寸两张、第二张中心透明 ⇒ 中心 alpha 必须为 0）。
 */
let sharedCanvas2d: OffscreenCanvas | null = null

/**
 * 把画布内容清空后绘制 `source`，读回整幅 RGBA。
 *
 * `clearRect` 不可省：复用同一张画布时，source-over 会把新图的透明区域留给上一张的像素
 * （见 {@link sharedCanvas2d} 的警告段）。
 */
function clearDrawRead(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  source: CanvasImageSource,
  width: number,
  height: number,
): Uint8Array {
  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(source, 0, 0)
  // `new Uint8Array(ImageData.data)` 即一份独立拷贝（去掉旧写法的第二份 `.buffer.slice(0)`）。
  return new Uint8Array(ctx.getImageData(0, 0, width, height).data)
}

/** 取 2D 画布的 `ImageData`（`OffscreenCanvas` 优先；无则用 `<canvas>`）。 */
function readRgba(source: CanvasImageSource, width: number, height: number): Uint8Array | null {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = sharedCanvas2d ?? (sharedCanvas2d = new OffscreenCanvas(width, height))
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null
    if (ctx === null) return null
    return clearDrawRead(ctx, source, width, height)
  }
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx === null) return null
  return clearDrawRead(ctx, source, width, height)
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
