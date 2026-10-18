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
import { encodeGifBytes } from '@/adapters/export/gifEncoder'

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
  // 编码核心**只有一份**：`adapters/export/gifEncoder#encodeGifBytes`（M6-2）。
  // 本函数是旧入口的**薄委派**（返回 `Blob` 是旧调用方要的形态），随旧链一起删除（M6-3）。
  const bytes = encodeGifBytes(
    frames.map((f) => ({
      pixels: f.data instanceof Uint8Array
        ? f.data
        : new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength),
      width: f.width,
      height: f.height,
    })),
    delaysCs,
    { palette: options?.palette ?? 'global', flipY: options?.flipY === true, loopCount: options?.loop ?? 0 },
  )
  if (!bytes.ok) {
    // 旧签名**抛**（旧调用方按异常处理）；把结构化失败翻译回异常，语义保持不变。
    const params = bytes.error.params
    throw new Error(String(params.reason) + (params.detail === undefined ? '' : ': ' + String(params.detail)))
  }
  return new Blob([bytes.value as unknown as BlobPart], { type: 'image/gif' })
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
