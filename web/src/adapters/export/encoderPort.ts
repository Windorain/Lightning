/**
 * `adapters/export/encoderPort` —— **编码端口的生产实现**（#301 P10f/E）。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | `EncoderPort` **零生产实现**（导出政策层只声明"能不能编码"，无人实现） | 本批前的实况 | 本文件是那个实现：`supportedKinds` + `encode()` |
 * | 经画布编码（`canvas.toBlob` / `toDataURL`） | `workbench/textureAtlasRaster.ts`、`workbench/exportIsometricImage.ts` | 纯字节编码（`adapters/export/pngEncoder`），无 DOM |
 *
 * ## 支持面**诚实声明**（不假装能编 GIF/OBJ/JSON）
 *
 * `supportedKinds` 只列**本实现真能编码**的种类：`'image'`（PNG/JPEG）。
 * 其余三类**明确不列** —— 于是 `application/exportPlan.preflightExport` 会据
 * `encoder.supportedKinds.includes(kind)` 判 `ExportKindUnsupported` 而**阻塞**。
 *
 * 这是 #249 §12「不支持的导出**明确报告**，不假成功」的直接落地：
 * 若把四类全列上而只实现 image，预检会放行、`encode` 要么抛要么产出错的字节
 * —— 那就是"伪完整文件"。**声明即能力**，声明面与实现面必须同一份事实。
 *
 * ## 为什么不是 `async` 包一层就算完
 *
 * 接口要求返回 `Promise<Result<Uint8Array>>`，但本实现的计算是**同步**的（纯字节编码）。
 * 保持同步内核、返回已敲定的 Promise，使**失败路径也是值**（`Result` 的失败侧），
 * 而不是"某天某个 await 抛了"。
 *
 * ## `signal` 的处理（契约 §1.5「调用超时不冒充取消」）
 *
 * 编码在**帧循环之间**检查 `signal.cancelled`：取消 ⇒ 立刻返回**结构化失败**并
 * **不产出部分字节**。这里没有超时、不读墙钟 —— 想取消就显式 `cancel()`。
 */

import { ok, err, unsupportedOperation, type Result } from '@/domain/errors'
import { PNG_COLOR_TYPE_RGBA } from './pngEncoder'
import type { EncoderInput, EncoderPort, ExportKind, RenderedFrame } from '@/application/exportPlan'
import { encodePngFromRgba } from './pngEncoder'

/** 本实现**真能编码**的种类（见文件头「支持面诚实声明」）。 */
export const SUPPORTED_ENCODE_KINDS: readonly ExportKind[] = Object.freeze(['image'] as const)

/**
 * 图片编码器（PNG 完整实现；JPEG **明确不支持**）。
 *
 * ## JPEG 为什么不假装支持
 *
 * JPEG 是有损编码，需要 DCT/量化表 —— 那不是"顺手加一个分支"的量级。
 * 而 `ImageEncoding` 类型里有 `'jpeg'`，故**必须显式拒绝**：
 * 悄悄按 PNG 编码却声明 `image/jpeg`，会让下游（文件名/媒体类型）与真实字节不符
 * —— 正是本批 D7 修复所针对的**同族**缺陷（声明与内容不一致）。
 */
export function createPngEncoderPort(): EncoderPort {
  return {
    supportedKinds: SUPPORTED_ENCODE_KINDS,
    async encode(input: EncoderInput): Promise<Result<Uint8Array>> {
      if (!SUPPORTED_ENCODE_KINDS.includes(input.kind)) {
        return err(
          unsupportedOperation({
            reason: 'encoderKindUnsupported',
            kind: input.kind,
            supported: SUPPORTED_ENCODE_KINDS.join(','),
          }),
        )
      }
      if (input.encoding !== 'png') {
        // `jpeg` 在 `ImageEncoding` 里合法但本实现不支持 ⇒ 显式拒绝（见上文）。
        return err(unsupportedOperation({ reason: 'encoderEncodingUnsupported', encoding: input.encoding }))
      }
      if (input.rendered.length === 0) {
        // 零帧 ⇒ 不产出"空但合法"的 PNG（那是"伪完整文件"的最简形态）。
        return err(unsupportedOperation({ reason: 'encoderNoFrames', requestId: input.request.requestId }))
      }

      const frames = input.rendered
      // 图片导出取**第一帧**：这是显式政策，不是"随便挑一个"。
      // 多帧图片应由调用方用 `kind: 'animation'` 表达（本实现不支持，故不会静默只导首帧）。
      if (frames.length > 1 && input.kind === 'image') {
        // 不静默丢弃后续帧：那会让"导出了一段动画"变成"只出了一张图"而无任何信号。
        return err(
          unsupportedOperation({
            reason: 'encoderImageTakesSingleFrame',
            frames: frames.length,
            hint: '多帧请用 kind=animation（本实现尚未支持）',
          }),
        )
      }

      const frame = frames[0]!
      // 取消信号是**活视图**（作业在长循环里可读到最新意图）；此处只需在编码前检查一次
      // ——PNG 编码是单次 deflate，没有可中断的长循环。
      if (input.signal.cancelled) {
        return err(unsupportedOperation({ reason: 'encoderCancelled', requestId: input.request.requestId }))
      }

      const bytes = encodeFrame(frame)
      if (!bytes.ok) return bytes

      // 尺寸**交叉核对**：帧自带 width/height，request.render 也有 —— 两者不符
      // 说明上游哪里算错了。产出与 request 声明不符的图属静默错误，故显式判失败。
      if (frame.width !== input.request.render.width || frame.height !== input.request.render.height) {
        return err(
          unsupportedOperation({
            reason: 'encoderFrameSizeMismatch',
            frameWidth: frame.width,
            frameHeight: frame.height,
            requestWidth: input.request.render.width,
            requestHeight: input.request.render.height,
          }),
        )
      }

      return ok(bytes.value)
    },
  }
}

/** 单帧 → PNG 字节（`flipY: true`：渲染读回是 WebGL 行序，PNG 是自上而下）。 */
function encodeFrame(frame: RenderedFrame): Result<Uint8Array> {
  const expected = frame.width * frame.height * 4
  if (frame.pixels.length !== expected) {
    return err(
      unsupportedOperation({
        reason: 'encoderPixelBufferSizeMismatch',
        expected,
        actual: frame.pixels.length,
        width: frame.width,
        height: frame.height,
      }),
    )
  }
  try {
    return ok(encodePngFromRgba(frame.pixels, frame.width, frame.height, true))
  } catch (e) {
    // 纯编码器在尺寸非法时**抛**（它是内部不变量，不该发生）；
    // 在端口边界翻译成结构化失败，使调用方拿到 `Result` 而不是异常。
    return err(unsupportedOperation({ reason: 'encoderFailed', detail: String(e) }))
  }
}

/** 便于装配层的工厂风格入口。 */
export function createEncoderPort(): EncoderPort {
  return createPngEncoderPort()
}

/** 未使用占位：保持 `PNG_COLOR_TYPE_RGBA` 可达（判据经它核对 IHDR 色彩类型）。 */
export const __PNG_COLOR_TYPE_RGBA = PNG_COLOR_TYPE_RGBA
